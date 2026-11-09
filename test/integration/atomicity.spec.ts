import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { INestApplication } from '@nestjs/common';
import { SubmitWagerTransactionUseCase } from '../../src/application/submit-wager-transaction.use-case';
import { CreateWalletUseCase } from '../../src/application/create-wallet.use-case';
import { UnitOfWork } from '../../src/application/ports';
import { createApp } from '../../src/bootstrap';
import { loadConfig } from '../../src/config/config';
import { UNIT_OF_WORK } from '../../src/tokens';
import { TestEnv, assertAllWalletsConsistent, createTestEnv, sqlOne } from './support/env';
import { sqsData, wagerData } from './support/app';

let env: TestEnv;
let app: INestApplication;
let submit: SubmitWagerTransactionUseCase;
let createWallet: CreateWalletUseCase;
let uow: UnitOfWork;

beforeAll(async () => {
  env = await createTestEnv();
  app = await createApp(loadConfig(env.childEnv));
  await app.init();
  submit = app.get(SubmitWagerTransactionUseCase);
  createWallet = app.get(CreateWalletUseCase);
  uow = app.get(UNIT_OF_WORK);
});
afterAll(async () => {
  await app.close();
  await env.cleanup();
});

const count = async (table: string) => Number((await sqlOne<{ n: string }>(env, `SELECT count(*)::text AS n FROM ${table}`)).n);

describe('atomicity: wallet, transaction, ledger, inbox and outbox commit together', () => {
  test('a processed BET leaves coherent rows in every table', async () => {
    const wallet = await createWallet.execute({ playerId: 'atom-1', initialBalance: { amount: '100.00', currency: 'BRL' }, correlationId: 'c' });
    const data = sqsData({ externalTransactionId: 'atom-bet', playerId: 'atom-1', walletId: wallet.id, amount: '30.00' });
    await submit.execute({
      idempotencyKey: data.idempotencyKey, data, correlationId: 'c', source: 'sqs',
      inbox: { messageId: 'atom-msg', consumerName: 'test', payloadHash: 'h' },
    });

    const w = await sqlOne<{ balance: string; version: number }>(env, `SELECT balance::text AS balance, version FROM wallets WHERE id = $1`, [wallet.id]);
    expect(w.balance).toBe('70.00');
    expect(w.version).toBe(2);
    const ledger = await env.pool.query(`SELECT direction, balance_before::text b, balance_after::text a FROM wallet_ledger_entries WHERE wallet_id = $1 ORDER BY seq`, [wallet.id]);
    expect(ledger.rows.map((r) => r.direction)).toEqual(['CREDIT', 'DEBIT']);
    expect(ledger.rows[1]).toMatchObject({ b: '100.00', a: '70.00' });
    const inbox = await sqlOne<{ processed_at: Date | null }>(env, `SELECT processed_at FROM inbox_messages WHERE message_id = 'atom-msg'`);
    expect(inbox.processed_at).not.toBeNull();
    const events = await env.pool.query(`SELECT event_type FROM outbox_messages ORDER BY seq`);
    expect(events.rows.map((r) => r.event_type)).toContain('WalletBalanceChanged');
    await assertAllWalletsConsistent(env);
  });

  test('a failure after partial writes rolls back wallet, ledger and outbox — and the inbox row', async () => {
    const wallet = await createWallet.execute({ playerId: 'atom-2', initialBalance: { amount: '50.00', currency: 'BRL' }, correlationId: 'c' });
    const before = { ledger: await count('wallet_ledger_entries'), outbox: await count('outbox_messages'), inbox: await count('inbox_messages'), tx: await count('wager_transactions') };

    await expect(
      uow.run(async (repos) => {
        await repos.inbox.tryReceive((await import('../../src/messaging/domain/inbox-message')).InboxMessage.receive({ messageId: 'rb-msg', consumerName: 'test', payloadHash: 'h', receivedAt: new Date() }));
        const locked = (await repos.wallets.findByIdForUpdate(wallet.id))!;
        const v = locked.version;
        const entry = locked.debit({ entryId: crypto.randomUUID(), transactionId: crypto.randomUUID(), money: locked.balance, now: new Date() });
        await repos.wallets.update(locked, v);
        // ledger insert violates the FK (unknown transaction) => the whole thing must roll back
        await repos.ledger.insert(entry);
      }),
    ).rejects.toThrow();

    expect(await count('wallet_ledger_entries')).toBe(before.ledger);
    expect(await count('outbox_messages')).toBe(before.outbox);
    expect(await count('inbox_messages')).toBe(before.inbox);
    expect(await count('wager_transactions')).toBe(before.tx);
    const w = await sqlOne<{ balance: string }>(env, `SELECT balance::text AS balance FROM wallets WHERE id = $1`, [wallet.id]);
    expect(w.balance).toBe('50.00');
  });

  test('wallet creation is atomic: wallet + OPENING transaction + CREDIT entry + events', async () => {
    const wallet = await createWallet.execute({ playerId: 'atom-3', initialBalance: { amount: '1000.00', currency: 'BRL' }, correlationId: 'c' });
    const opening = await sqlOne<{ kind: string; status: string }>(env, `SELECT kind, status FROM wager_transactions WHERE wallet_id = $1`, [wallet.id]);
    expect(opening).toMatchObject({ kind: 'OPENING', status: 'PROCESSED' });
    const entry = await sqlOne<{ direction: string; wallet_version: number }>(env, `SELECT direction, wallet_version FROM wallet_ledger_entries WHERE wallet_id = $1`, [wallet.id]);
    expect(entry).toMatchObject({ direction: 'CREDIT', wallet_version: 1 });
    expect(wallet.version).toBe(1);
  });

  test('a rejected transaction is persisted for audit without ledger entry or balance change', async () => {
    const wallet = await createWallet.execute({ playerId: 'atom-4', initialBalance: { amount: '10.00', currency: 'BRL' }, correlationId: 'c' });
    const data = sqsData({ externalTransactionId: 'too-big', playerId: 'atom-4', walletId: wallet.id, amount: '99.00' });
    const r = await submit.execute({ idempotencyKey: data.idempotencyKey, data, correlationId: 'c', source: 'http' });
    expect(r.type === 'RESULT' && r.transaction.status).toBe('REJECTED');
    const entries = await count('wallet_ledger_entries WHERE wallet_id = \'' + wallet.id + '\'');
    expect(entries).toBe(1); // opening only
    const row = await sqlOne<{ status: string; failure_code: string }>(env, `SELECT status, failure_code FROM wager_transactions WHERE external_transaction_id = 'too-big'`);
    expect(row).toMatchObject({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' });
  });

  test('payload sanity: wagerData is plain JSON (no floats, money as strings)', () => {
    expect(JSON.stringify(wagerData({ externalTransactionId: 'x', playerId: 'p', walletId: 'w' }))).toContain('"amount":"1.00"');
  });
});
