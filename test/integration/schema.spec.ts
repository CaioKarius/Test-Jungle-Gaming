import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Migrator } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import { mikroOrmOptions } from '../../src/infrastructure/persistence/mikro-orm.config';
import { TestEnv, createTestEnv } from './support/env';

let env: TestEnv;
beforeAll(async () => { env = await createTestEnv(); });
afterAll(async () => { await env.cleanup(); });

const HASH = 'a'.repeat(64);

/** Wallet + OPENING transaction + ledger entry, committed together (what the app does). */
async function seedWallet(balance = '100.00'): Promise<{ walletId: string; txId: string }> {
  const walletId = randomUUID();
  const txId = randomUUID();
  const c = await env.pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at) VALUES ($1,$2,'BRL',$3,1,now(),now())`, [walletId, `p-${walletId}`, balance]);
    await c.query(
      `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status, observed_balance, created_at, processed_at, updated_at)
       VALUES ($1,'internal',$2,$2,$3,$4,$5,'opening','internal','OPENING',$6,'BRL','PROCESSED',$6,now(),now(),now())`,
      [txId, `opening:${walletId}`, HASH, walletId, `p-${walletId}`, balance],
    );
    await c.query(
      `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, balance_before, balance_after, wallet_version, created_at)
       VALUES ($1,$2,$3,'CREDIT',$4,0,$4,1,now())`, [randomUUID(), walletId, txId, balance]);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
  return { walletId, txId };
}

async function insertTx(walletId: string, o: { id?: string; key?: string; ext?: string; kind?: string; status?: string; ref?: string | null; refId?: string | null; amount?: string } = {}) {
  const id = o.id ?? randomUUID();
  const status = o.status ?? 'PROCESSED';
  await env.pool.query(
    `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency,
        reference_external_transaction_id, reference_transaction_id, status, failure_code, observed_balance, next_retry_at, created_at, processed_at, updated_at)
     VALUES ($1,'p',$2,$3,$4,$5,'pl','r','g',$6,$7,'BRL',$8,$9,$10,$11,0,$12,now(),$13,now())`,
    [id, o.ext ?? `x-${id}`, o.key ?? `k-${id}`, HASH, walletId, o.kind ?? 'BET', o.amount ?? '10.00', o.ref ?? null, o.refId ?? null, status,
      status === 'REJECTED' ? 'INSUFFICIENT_FUNDS' : null, status === 'PENDING_REFERENCE' ? new Date() : null, status === 'PROCESSED' ? new Date() : null],
  );
  return id;
}

describe('schema: uniqueness', () => {
  test('one wallet per (player, currency)', async () => {
    const { walletId } = await seedWallet();
    const { rows } = await env.pool.query(`SELECT player_id FROM wallets WHERE id = $1`, [walletId]);
    await expect(
      env.pool.query(`INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at) VALUES ($1,$2,'BRL',0,1,now(),now())`, [randomUUID(), rows[0].player_id]),
    ).rejects.toThrow('wallets_player_currency_uq');
  });

  test('idempotency key and (provider, external id) are unique', async () => {
    const { walletId } = await seedWallet();
    await insertTx(walletId, { key: 'dup-key', ext: 'e1' });
    await expect(insertTx(walletId, { key: 'dup-key', ext: 'e2' })).rejects.toThrow('wager_tx_idempotency_key_uq');
    await expect(insertTx(walletId, { key: 'k3', ext: 'e1' })).rejects.toThrow('wager_tx_provider_external_uq');
  });

  test('a reference can be reverted by only ONE processed reversal', async () => {
    const { walletId } = await seedWallet();
    const bet = await insertTx(walletId, { ext: 'bet' });
    await insertTx(walletId, { kind: 'REFUND', ref: 'bet', refId: bet });
    await expect(insertTx(walletId, { kind: 'ROLLBACK', ref: 'bet', refId: bet })).rejects.toThrow('wager_tx_single_reversal_uq');
    // a REJECTED attempt is fine: it did not revert anything
    await insertTx(walletId, { kind: 'REFUND', ref: 'bet', refId: bet, status: 'REJECTED' });
  });

  test('inbox is unique per (consumer, message)', async () => {
    await env.pool.query(`INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at) VALUES ('c','m1','h',now())`);
    await expect(env.pool.query(`INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at) VALUES ('c','m1','h',now())`)).rejects.toThrow('inbox_messages_pkey');
    await env.pool.query(`INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at) VALUES ('other','m1','h',now())`);
  });

  test('transaction invariants: reversal needs a reference, BET cannot have one, status/failure consistency', async () => {
    const { walletId } = await seedWallet();
    await expect(insertTx(walletId, { kind: 'REFUND', ref: null })).rejects.toThrow('wager_tx_reversal_needs_reference_ck');
    await expect(insertTx(walletId, { kind: 'BET', ref: 'x' })).rejects.toThrow('wager_tx_bet_has_no_reference_ck');
    await expect(env.pool.query(`UPDATE wager_transactions SET failure_code = 'X' WHERE id = (SELECT id FROM wager_transactions LIMIT 1)`)).rejects.toThrow();
  });
});

describe('schema: non-negativity and arithmetic', () => {
  test('balance cannot be negative', async () => {
    const { walletId } = await seedWallet('10.00');
    await expect(env.pool.query(`UPDATE wallets SET balance = -1, version = version + 1 WHERE id = $1`, [walletId])).rejects.toThrow('wallets_balance_non_negative_ck');
  });

  test('ledger entries must balance and stay non-negative', async () => {
    const { walletId, txId } = await seedWallet('10.00');
    const bad = (before: string, after: string, dir = 'DEBIT') =>
      env.pool.query(
        `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, balance_before, balance_after, wallet_version, created_at) VALUES ($1,$2,$3,$4,5,$5,$6,2,now())`,
        [randomUUID(), walletId, txId, dir, before, after]);
    await expect(bad('10.00', '6.00')).rejects.toThrow('ledger_balanced_ck');
    await expect(bad('3.00', '-2.00')).rejects.toThrow();
  });

  test('one ledger entry per (wallet, transaction) and per (wallet, version)', async () => {
    const { walletId, txId } = await seedWallet('10.00');
    await expect(
      env.pool.query(`INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, balance_before, balance_after, wallet_version, created_at) VALUES ($1,$2,$3,'CREDIT',1,10,11,2,now())`, [randomUUID(), walletId, txId]),
    ).rejects.toThrow('ledger_one_entry_per_wallet_tx_uq');
    const other = await insertTx(walletId, { ext: 'o1' });
    await expect(
      env.pool.query(`INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, balance_before, balance_after, wallet_version, created_at) VALUES ($1,$2,$3,'CREDIT',1,10,11,1,now())`, [randomUUID(), walletId, other]),
    ).rejects.toThrow('ledger_wallet_version_uq');
  });
});

describe('schema: immutability', () => {
  test('ledger rows cannot be updated, deleted or truncated', async () => {
    await seedWallet();
    await expect(env.pool.query(`UPDATE wallet_ledger_entries SET amount = 1`)).rejects.toThrow('append-only');
    await expect(env.pool.query(`DELETE FROM wallet_ledger_entries`)).rejects.toThrow('append-only');
    await expect(env.pool.query(`TRUNCATE wallet_ledger_entries`)).rejects.toThrow('append-only');
  });

  test('terminal transactions never change; identity columns are immutable', async () => {
    const { walletId } = await seedWallet();
    const processed = await insertTx(walletId, { status: 'PROCESSED' });
    await expect(env.pool.query(`UPDATE wager_transactions SET status = 'REJECTED', failure_code = 'X', processed_at = NULL WHERE id = $1`, [processed])).rejects.toThrow('terminal');
    await expect(env.pool.query(`DELETE FROM wager_transactions WHERE id = $1`, [processed])).rejects.toThrow('cannot be deleted');
    const pending = await insertTx(walletId, { kind: 'REFUND', ref: 'nope', status: 'PENDING_REFERENCE' });
    await expect(env.pool.query(`UPDATE wager_transactions SET amount = 99 WHERE id = $1`, [pending])).rejects.toThrow('immutable columns');
    await env.pool.query(`UPDATE wager_transactions SET next_retry_at = now() WHERE id = $1`, [pending]); // allowed
  });
});

describe('schema: wallet ↔ ledger agreement (checked at COMMIT)', () => {
  test('changing a balance without a ledger entry cannot commit', async () => {
    const { walletId } = await seedWallet('50.00');
    const c = await env.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`UPDATE wallets SET balance = 40.00, version = version + 1 WHERE id = $1`, [walletId]);
      await expect(c.query('COMMIT')).rejects.toThrow('no matching ledger entry');
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
    const { rows } = await env.pool.query(`SELECT balance::text AS b FROM wallets WHERE id = $1`, [walletId]);
    expect(rows[0].b).toBe('50.00');
  });

  test('balance must equal the ledger balance_after of the same version', async () => {
    const { walletId } = await seedWallet('50.00');
    const betTx = await insertTx(walletId, { ext: 'agree' });
    const c = await env.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, balance_before, balance_after, wallet_version, created_at) VALUES ($1,$2,$3,'DEBIT',10,50,40,2,now())`, [randomUUID(), walletId, betTx]);
      await c.query(`UPDATE wallets SET balance = 35.00, version = 2 WHERE id = $1`, [walletId]); // lies about the balance
      await expect(c.query('COMMIT')).rejects.toThrow('differs from ledger');
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  });

  test('version moves exactly with the balance', async () => {
    const { walletId } = await seedWallet('50.00');
    await expect(env.pool.query(`UPDATE wallets SET version = version + 1 WHERE id = $1`, [walletId])).rejects.toThrow('version changed without a balance change');
    await expect(env.pool.query(`UPDATE wallets SET balance = 49.00, version = version + 5 WHERE id = $1`, [walletId])).rejects.toThrow('exactly one version increment');
  });

  test('a consistent change commits', async () => {
    const { walletId } = await seedWallet('50.00');
    const t = await insertTx(walletId, { ext: 'good' });
    const c = await env.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, balance_before, balance_after, wallet_version, created_at) VALUES ($1,$2,$3,'DEBIT',10,50,40,2,now())`, [randomUUID(), walletId, t]);
      await c.query(`UPDATE wallets SET balance = 40.00, version = 2 WHERE id = $1`, [walletId]);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
  });
});

describe('migrations are versioned and reversible', () => {
  test('down removes everything, up recreates it', async () => {
    const own = await createTestEnv();
    try {
      const orm = await MikroORM.init(mikroOrmOptions(own.config.database));
      const migrator = new Migrator(orm.em);
      await migrator.down({ to: 0 });
      const gone = await own.pool.query(`SELECT to_regclass('public.wallets') AS w, to_regclass('public.wallet_ledger_entries') AS l`);
      expect(gone.rows[0].w).toBeNull();
      expect(gone.rows[0].l).toBeNull();
      await migrator.up();
      const back = await own.pool.query(`SELECT to_regclass('public.wallets') AS w`);
      expect(back.rows[0].w).toBe('wallets');
      await orm.close(true);
    } finally {
      await own.cleanup();
    }
  });
});
