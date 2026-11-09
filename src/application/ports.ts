import { InboxMessage } from '../messaging/domain/inbox-message';
import { OutboxMessage } from '../messaging/domain/outbox-message';
import { Money } from '../shared/domain/money';
import { WagerTransaction } from '../wagering/domain/wager-transaction';
import { Wallet } from '../wallet/domain/wallet';
import { WalletLedgerEntry } from '../wallet/domain/wallet-ledger-entry';

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}

// ---- repositories (all bound to ONE SQL transaction by the UnitOfWork) -----------------

export interface WalletRepository {
  /** False if the (playerId, currency) pair already has a wallet. */
  insert(wallet: Wallet): Promise<boolean>;
  findById(id: string): Promise<Wallet | null>;
  /** `SELECT … FOR UPDATE`: the per-wallet lock. Serialises all writers of one wallet. */
  findByIdForUpdate(id: string): Promise<Wallet | null>;
  /** Optimistic guard on top of the lock; throws ConcurrentWalletModificationError on mismatch. */
  update(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface DuePendingReference {
  id: string;
  walletId: string;
}

export interface WagerTransactionRepository {
  /** False if idempotency key or (providerId, externalTransactionId) already exists. */
  insert(transaction: WagerTransaction): Promise<boolean>;
  update(transaction: WagerTransaction): Promise<void>;
  findById(id: string): Promise<WagerTransaction | null>;
  findByIdempotencyKey(key: string): Promise<WagerTransaction | null>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;
  /** Is there a PROCESSED REFUND/ROLLBACK reverting this transaction? */
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  findDuePendingReferences(now: Date, limit: number): Promise<DuePendingReference[]>;
  /** Makes PENDING_REFERENCE transactions waiting on this external id due right now. */
  wakeDependents(providerId: string, referenceExternalTransactionId: string, now: Date): Promise<number>;
}

export interface LedgerRow {
  seq: string;
  entry: WalletLedgerEntry;
}

export interface ReconciliationSnapshot {
  storedBalance: Money;
  calculatedBalance: Money;
  checkedEntries: number;
}

export interface LedgerRepository {
  insert(entry: WalletLedgerEntry): Promise<void>;
  /** Newest first. `before` is the `seq` of the last row of the previous page. */
  page(walletId: string, params: { before?: string; limit: number }): Promise<LedgerRow[]>;
  /** One statement ⇒ one snapshot: stored balance and ledger sum are read consistently. */
  reconciliationSnapshot(walletId: string): Promise<ReconciliationSnapshot | null>;
}

export interface InboxRepository {
  /** Inserts the dedup record. False ⇒ this (consumer, message) was already received and committed. */
  tryReceive(message: InboxMessage): Promise<boolean>;
  markProcessed(message: InboxMessage): Promise<void>;
}

export interface OutboxStats {
  pending: number;
  oldestPendingAgeSeconds: number;
}

export interface OutboxRepository {
  add(message: OutboxMessage): Promise<void>;
  /** `FOR UPDATE SKIP LOCKED`: concurrent publishers get disjoint batches. */
  claimDue(now: Date, limit: number): Promise<OutboxMessage[]>;
  save(message: OutboxMessage): Promise<void>;
  stats(now: Date): Promise<OutboxStats>;
}

export interface Repositories {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

/** One SQL transaction. Commits when `work` resolves, rolls back when it throws. */
export interface UnitOfWork {
  run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T>;
}

// ---- messaging --------------------------------------------------------------------------

/** Publishes an outbox message to the broker. Must throw on failure. */
export interface EventPublisher {
  publish(message: OutboxMessage): Promise<void>;
}

// ---- observability ----------------------------------------------------------------------

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export interface Metrics {
  transactionProcessed(status: string, kind: string): void;
  duplicateDetected(source: 'idempotency' | 'inbox'): void;
  retry(component: string): void;
  dlqMessage(reason: string): void;
  lockConflict(reason: string): void;
  walletLockWait(seconds: number): void;
  processingDuration(source: string, seconds: number): void;
  outboxPublished(count: number): void;
  outboxStats(stats: OutboxStats): void;
  reconciliationDivergence(): void;
  sqsMessage(outcome: string): void;
}

export const noopMetrics: Metrics = {
  transactionProcessed() {},
  duplicateDetected() {},
  retry() {},
  dlqMessage() {},
  lockConflict() {},
  walletLockWait() {},
  processingDuration() {},
  outboxPublished() {},
  outboxStats() {},
  reconciliationDivergence() {},
  sqsMessage() {},
};

export const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export interface PendingReferencePolicy {
  baseDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number;
  ttlMs: number;
}

export function referenceRetryDelayMs(policy: PendingReferencePolicy, attempt: number): number {
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attempt));
}
