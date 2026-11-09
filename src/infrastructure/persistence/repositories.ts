import type { EntityManager } from '@mikro-orm/postgresql';
import {
  DuePendingReference,
  InboxRepository,
  LedgerRepository,
  LedgerRow,
  OutboxRepository,
  OutboxStats,
  ReconciliationSnapshot,
  Repositories,
  WagerTransactionRepository,
  WalletRepository,
} from '../../application/ports';
import { ConcurrentWalletModificationError } from '../../application/errors';
import { InboxMessage } from '../../messaging/domain/inbox-message';
import { OutboxMessage } from '../../messaging/domain/outbox-message';
import { Money } from '../../shared/domain/money';
import { FailureCode } from '../../wagering/domain/failure-code';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../wagering/domain/wager-transaction';
import { LedgerDirection } from '../../wallet/domain/ledger-direction';
import { Wallet } from '../../wallet/domain/wallet';
import { WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry';

// Money columns are always selected `::text`, so node-postgres never turns NUMERIC into a JS number.
// Params use `?` (knex style) — never put a literal `?` in these statements.

type Row = Record<string, unknown>;

const toDate = (v: unknown): Date => (v instanceof Date ? v : new Date(v as string));
const toOptDate = (v: unknown): Date | undefined => (v === null || v === undefined ? undefined : toDate(v));
const toOptString = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : String(v));
const toMoney = (amount: unknown, currency: string): Money =>
  Money.fromStored({ amount: String(amount), currency });
const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

// ---- wallets ----------------------------------------------------------------------------

const WALLET_COLUMNS = `id, player_id, currency, balance::text AS balance, version, created_at, updated_at`;

function toWallet(row: Row): Wallet {
  const currency = String(row['currency']);
  return Wallet.rehydrate({
    id: String(row['id']),
    playerId: String(row['player_id']),
    currency,
    balance: toMoney(row['balance'], currency),
    version: Number(row['version']),
    createdAt: toDate(row['created_at']),
    updatedAt: toDate(row['updated_at']),
  });
}

class SqlWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(wallet: Wallet): Promise<boolean> {
    const rows = await this.em.execute<Row[]>(
      `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
       VALUES (${placeholders(7)})
       ON CONFLICT (player_id, currency) DO NOTHING
       RETURNING id`,
      [wallet.id, wallet.playerId, wallet.currency, wallet.balance.amount, wallet.version, wallet.createdAt, wallet.updatedAt],
    );
    return rows.length === 1;
  }

  async findById(id: string): Promise<Wallet | null> {
    const rows = await this.em.execute<Row[]>(`SELECT ${WALLET_COLUMNS} FROM wallets WHERE id = ?`, [id]);
    return rows[0] ? toWallet(rows[0]) : null;
  }

  async findByIdForUpdate(id: string): Promise<Wallet | null> {
    const rows = await this.em.execute<Row[]>(
      `SELECT ${WALLET_COLUMNS} FROM wallets WHERE id = ? FOR UPDATE`,
      [id],
    );
    return rows[0] ? toWallet(rows[0]) : null;
  }

  async update(wallet: Wallet, expectedVersion: number): Promise<void> {
    const rows = await this.em.execute<Row[]>(
      `UPDATE wallets SET balance = ?, version = ?, updated_at = ?
        WHERE id = ? AND version = ?
        RETURNING id`,
      [wallet.balance.amount, wallet.version, wallet.updatedAt, wallet.id, expectedVersion],
    );
    if (rows.length !== 1) {
      throw new ConcurrentWalletModificationError(
        `wallet ${wallet.id} was modified concurrently (expected version ${expectedVersion})`,
      );
    }
  }
}

// ---- wager transactions -----------------------------------------------------------------

const TX_COLUMNS = `id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
  player_id, round_id, game_id, kind, amount::text AS amount, currency, reference_external_transaction_id,
  reference_transaction_id, status, failure_code, observed_balance::text AS observed_balance,
  reference_attempts, next_retry_at, created_at, processed_at`;

function toTransaction(row: Row): WagerTransaction {
  const currency = String(row['currency']);
  const observed = row['observed_balance'];
  return WagerTransaction.rehydrate({
    id: String(row['id']),
    providerId: String(row['provider_id']),
    externalTransactionId: String(row['external_transaction_id']),
    idempotencyKey: String(row['idempotency_key']),
    payloadHash: String(row['payload_hash']),
    walletId: String(row['wallet_id']),
    playerId: String(row['player_id']),
    roundId: String(row['round_id']),
    gameId: String(row['game_id']),
    kind: String(row['kind']) as WagerTransactionKind,
    money: toMoney(row['amount'], currency),
    referenceExternalTransactionId: toOptString(row['reference_external_transaction_id']),
    createdAt: toDate(row['created_at']),
    status: String(row['status']) as WagerTransactionStatus,
    referenceTransactionId: toOptString(row['reference_transaction_id']),
    failureCode: toOptString(row['failure_code']) as FailureCode | undefined,
    processedAt: toOptDate(row['processed_at']),
    observedBalance: observed === null || observed === undefined ? undefined : toMoney(observed, currency),
    referenceAttempts: Number(row['reference_attempts']),
    nextRetryAt: toOptDate(row['next_retry_at']),
  });
}

class SqlWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(t: WagerTransaction): Promise<boolean> {
    // No conflict target: ANY unique violation (idempotency key OR provider+external id) yields
    // "not inserted" instead of an error that would poison the surrounding SQL transaction.
    const rows = await this.em.execute<Row[]>(
      `INSERT INTO wager_transactions (
         id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
         round_id, game_id, kind, amount, currency, reference_external_transaction_id,
         reference_transaction_id, status, failure_code, observed_balance, reference_attempts,
         next_retry_at, created_at, processed_at, updated_at)
       VALUES (${placeholders(22)})
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        t.id, t.providerId, t.externalTransactionId, t.idempotencyKey, t.payloadHash, t.walletId, t.playerId,
        t.roundId, t.gameId, t.kind, t.money.amount, t.money.currency, t.referenceExternalTransactionId ?? null,
        t.referenceTransactionId ?? null, t.status, t.failureCode ?? null, t.observedBalance?.amount ?? null,
        t.referenceAttempts, t.nextRetryAt ?? null, t.createdAt, t.processedAt ?? null, t.createdAt,
      ],
    );
    return rows.length === 1;
  }

  async update(t: WagerTransaction): Promise<void> {
    const rows = await this.em.execute<Row[]>(
      `UPDATE wager_transactions
          SET reference_transaction_id = ?, status = ?, failure_code = ?, observed_balance = ?,
              reference_attempts = ?, next_retry_at = ?, processed_at = ?, updated_at = now()
        WHERE id = ?
        RETURNING id`,
      [
        t.referenceTransactionId ?? null, t.status, t.failureCode ?? null, t.observedBalance?.amount ?? null,
        t.referenceAttempts, t.nextRetryAt ?? null, t.processedAt ?? null, t.id,
      ],
    );
    if (rows.length !== 1) throw new Error(`wager transaction ${t.id} not found for update`);
  }

  async findById(id: string): Promise<WagerTransaction | null> {
    const rows = await this.em.execute<Row[]>(`SELECT ${TX_COLUMNS} FROM wager_transactions WHERE id = ?`, [id]);
    return rows[0] ? toTransaction(rows[0]) : null;
  }

  async findByIdempotencyKey(key: string): Promise<WagerTransaction | null> {
    const rows = await this.em.execute<Row[]>(
      `SELECT ${TX_COLUMNS} FROM wager_transactions WHERE idempotency_key = ?`,
      [key],
    );
    return rows[0] ? toTransaction(rows[0]) : null;
  }

  async findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null> {
    const rows = await this.em.execute<Row[]>(
      `SELECT ${TX_COLUMNS} FROM wager_transactions WHERE provider_id = ? AND external_transaction_id = ?`,
      [providerId, externalTransactionId],
    );
    return rows[0] ? toTransaction(rows[0]) : null;
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const rows = await this.em.execute<Row[]>(
      `SELECT 1 AS found FROM wager_transactions
        WHERE reference_transaction_id = ? AND status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')
        LIMIT 1`,
      [referenceTransactionId],
    );
    return rows.length > 0;
  }

  async findDuePendingReferences(now: Date, limit: number): Promise<DuePendingReference[]> {
    const rows = await this.em.execute<Row[]>(
      `SELECT id, wallet_id FROM wager_transactions
        WHERE status = 'PENDING_REFERENCE' AND next_retry_at <= ?
        ORDER BY next_retry_at
        LIMIT ?`,
      [now, limit],
    );
    return rows.map((r) => ({ id: String(r['id']), walletId: String(r['wallet_id']) }));
  }

  async wakeDependents(providerId: string, referenceExternalTransactionId: string, now: Date): Promise<number> {
    const rows = await this.em.execute<Row[]>(
      `UPDATE wager_transactions SET next_retry_at = ?, updated_at = ?
        WHERE status = 'PENDING_REFERENCE' AND provider_id = ? AND reference_external_transaction_id = ?
          AND next_retry_at > ?
        RETURNING id`,
      [now, now, providerId, referenceExternalTransactionId, now],
    );
    return rows.length;
  }
}

// ---- ledger -----------------------------------------------------------------------------

class SqlLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(e: WalletLedgerEntry): Promise<void> {
    await this.em.execute<Row[]>(
      `INSERT INTO wallet_ledger_entries
         (id, wallet_id, transaction_id, direction, amount, balance_before, balance_after, wallet_version, created_at)
       VALUES (${placeholders(9)})
       RETURNING id`,
      [
        e.id, e.walletId, e.transactionId, e.direction, e.money.amount, e.balanceBefore.amount,
        e.balanceAfter.amount, e.walletVersion, e.createdAt,
      ],
    );
  }

  async page(walletId: string, params: { before?: string; limit: number }): Promise<LedgerRow[]> {
    const cursor = params.before !== undefined ? 'AND l.seq < ?' : '';
    const args: unknown[] = params.before !== undefined ? [walletId, params.before, params.limit] : [walletId, params.limit];
    const rows = await this.em.execute<Row[]>(
      `SELECT l.seq::text AS seq, l.id, l.wallet_id, l.transaction_id, l.direction,
              l.amount::text AS amount, l.balance_before::text AS balance_before,
              l.balance_after::text AS balance_after, l.wallet_version, l.created_at, w.currency
         FROM wallet_ledger_entries l
         JOIN wallets w ON w.id = l.wallet_id
        WHERE l.wallet_id = ? ${cursor}
        ORDER BY l.seq DESC
        LIMIT ?`,
      args,
    );
    return rows.map((r) => {
      const currency = String(r['currency']);
      return {
        seq: String(r['seq']),
        entry: WalletLedgerEntry.rehydrate({
          id: String(r['id']),
          walletId: String(r['wallet_id']),
          transactionId: String(r['transaction_id']),
          direction: String(r['direction']) as LedgerDirection,
          money: toMoney(r['amount'], currency),
          balanceBefore: toMoney(r['balance_before'], currency),
          balanceAfter: toMoney(r['balance_after'], currency),
          walletVersion: Number(r['wallet_version']),
          createdAt: toDate(r['created_at']),
        }),
      };
    });
  }

  async reconciliationSnapshot(walletId: string): Promise<ReconciliationSnapshot | null> {
    // One statement = one MVCC snapshot: stored balance and ledger sum cannot be read at different moments.
    const rows = await this.em.execute<Row[]>(
      `SELECT w.currency,
              w.balance::text AS stored,
              COALESCE(SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END), 0)::numeric(19,2)::text AS calculated,
              COUNT(l.id)::int AS entries
         FROM wallets w
         LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
        WHERE w.id = ?
        GROUP BY w.id`,
      [walletId],
    );
    const row = rows[0];
    if (!row) return null;
    const currency = String(row['currency']);
    return {
      storedBalance: toMoney(row['stored'], currency),
      calculatedBalance: toMoney(row['calculated'], currency),
      checkedEntries: Number(row['entries']),
    };
  }
}

// ---- inbox / outbox ---------------------------------------------------------------------

class SqlInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async tryReceive(m: InboxMessage): Promise<boolean> {
    // A concurrent twin holding an uncommitted row makes this statement WAIT until that
    // transaction ends: committed ⇒ DO NOTHING (duplicate); rolled back ⇒ we insert.
    const rows = await this.em.execute<Row[]>(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at)
       VALUES (${placeholders(4)})
       ON CONFLICT (consumer_name, message_id) DO NOTHING
       RETURNING message_id`,
      [m.consumerName, m.messageId, m.payloadHash, m.receivedAt],
    );
    return rows.length === 1;
  }

  async markProcessed(m: InboxMessage): Promise<void> {
    await this.em.execute<Row[]>(
      `UPDATE inbox_messages SET processed_at = ? WHERE consumer_name = ? AND message_id = ? RETURNING message_id`,
      [m.processedAt ?? new Date(), m.consumerName, m.messageId],
    );
  }
}

function toOutbox(row: Row): OutboxMessage {
  const payload = typeof row['payload'] === 'string' ? JSON.parse(row['payload']) : row['payload'];
  return OutboxMessage.rehydrate({
    id: String(row['id']),
    aggregateId: String(row['aggregate_id']),
    partitionKey: String(row['partition_key']),
    eventType: String(row['event_type']),
    payload: payload as Record<string, unknown>,
    occurredAt: toDate(row['occurred_at']),
    attempts: Number(row['attempts']),
    nextAttemptAt: toOptDate(row['next_attempt_at']),
    publishedAt: toOptDate(row['published_at']),
  });
}

class SqlOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async add(m: OutboxMessage): Promise<void> {
    await this.em.execute<Row[]>(
      `INSERT INTO outbox_messages
         (id, aggregate_id, partition_key, event_type, payload, occurred_at, attempts, next_attempt_at, published_at)
       VALUES (?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?)
       RETURNING id`,
      [
        m.id, m.aggregateId, m.partitionKey, m.eventType, JSON.stringify(m.payload), m.occurredAt,
        m.attempts, m.nextAttemptAt ?? m.occurredAt, m.publishedAt ?? null,
      ],
    );
  }

  async claimDue(now: Date, limit: number): Promise<OutboxMessage[]> {
    // SKIP LOCKED: concurrent publishers get disjoint batches. The NOT EXISTS keeps per-partition
    // (per-wallet) order: a message never overtakes an earlier one that is backing off.
    const rows = await this.em.execute<Row[]>(
      `SELECT o.id, o.aggregate_id, o.partition_key, o.event_type, o.payload, o.occurred_at,
              o.attempts, o.next_attempt_at, o.published_at
         FROM outbox_messages o
        WHERE o.published_at IS NULL
          AND o.next_attempt_at <= ?
          AND NOT EXISTS (
                SELECT 1 FROM outbox_messages e
                 WHERE e.partition_key = o.partition_key AND e.published_at IS NULL
                   AND e.seq < o.seq AND e.next_attempt_at > ?)
        ORDER BY o.seq
        LIMIT ?
        FOR UPDATE OF o SKIP LOCKED`,
      [now, now, limit],
    );
    return rows.map(toOutbox);
  }

  async save(m: OutboxMessage): Promise<void> {
    await this.em.execute<Row[]>(
      `UPDATE outbox_messages SET attempts = ?, next_attempt_at = ?, published_at = ? WHERE id = ? RETURNING id`,
      [m.attempts, m.nextAttemptAt ?? m.occurredAt, m.publishedAt ?? null, m.id],
    );
  }

  async stats(now: Date): Promise<OutboxStats> {
    const rows = await this.em.execute<Row[]>(
      `SELECT COUNT(*)::int AS pending,
              COALESCE(EXTRACT(EPOCH FROM (?::timestamptz - MIN(occurred_at))), 0)::float8 AS age_seconds
         FROM outbox_messages WHERE published_at IS NULL`,
      [now],
    );
    const row = rows[0] ?? {};
    return {
      pending: Number(row['pending'] ?? 0),
      oldestPendingAgeSeconds: Math.max(0, Number(row['age_seconds'] ?? 0)),
    };
  }
}

export function createRepositories(em: EntityManager): Repositories {
  return {
    wallets: new SqlWalletRepository(em),
    transactions: new SqlWagerTransactionRepository(em),
    ledger: new SqlLedgerRepository(em),
    inbox: new SqlInboxRepository(em),
    outbox: new SqlOutboxRepository(em),
  };
}
