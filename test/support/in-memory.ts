import { InboxMessage, InboxMessageState } from '../../src/messaging/domain/inbox-message';
import { OutboxMessage, OutboxMessageState } from '../../src/messaging/domain/outbox-message';
import {
  Clock,
  DuePendingReference,
  IdGenerator,
  LedgerRow,
  OutboxStats,
  ReconciliationSnapshot,
  Repositories,
  UnitOfWork,
} from '../../src/application/ports';
import { ConcurrentWalletModificationError } from '../../src/application/errors';
import { Money } from '../../src/shared/domain/money';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionState,
  WagerTransactionStatus,
} from '../../src/wagering/domain/wager-transaction';
import { LedgerDirection } from '../../src/wallet/domain/ledger-direction';
import { Wallet, WalletState } from '../../src/wallet/domain/wallet';
import { LedgerEntryState, WalletLedgerEntry } from '../../src/wallet/domain/wallet-ledger-entry';

export class FakeClock implements Clock {
  constructor(private current = new Date('2026-08-01T12:00:00.000Z')) {}
  now(): Date {
    return new Date(this.current.getTime());
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

/** Valid-UUID sequential ids so they pass `walletId` validation. */
export class SequentialIds implements IdGenerator {
  private n = 0;
  next(): string {
    this.n += 1;
    return `00000000-0000-7000-8000-${this.n.toString().padStart(12, '0')}`;
  }
}

interface Tables {
  wallets: Map<string, WalletState>;
  transactions: Map<string, WagerTransactionState>;
  ledger: LedgerRow[];
  ledgerStates: Map<string, LedgerEntryState>;
  inbox: Map<string, InboxMessageState>;
  outbox: Map<string, OutboxMessageState>;
}

function walletState(w: Wallet): WalletState {
  return {
    id: w.id,
    playerId: w.playerId,
    currency: w.currency,
    balance: w.balance,
    version: w.version,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  };
}

function transactionState(t: WagerTransaction): WagerTransactionState {
  return {
    id: t.id,
    providerId: t.providerId,
    externalTransactionId: t.externalTransactionId,
    idempotencyKey: t.idempotencyKey,
    payloadHash: t.payloadHash,
    walletId: t.walletId,
    playerId: t.playerId,
    roundId: t.roundId,
    gameId: t.gameId,
    kind: t.kind,
    money: t.money,
    referenceExternalTransactionId: t.referenceExternalTransactionId,
    createdAt: t.createdAt,
    status: t.status,
    referenceTransactionId: t.referenceTransactionId,
    failureCode: t.failureCode,
    processedAt: t.processedAt,
    observedBalance: t.observedBalance,
    referenceAttempts: t.referenceAttempts,
    nextRetryAt: t.nextRetryAt,
  };
}

/**
 * In-memory stand-in for the repositories, ONLY for unit tests of application logic.
 * It emulates what matters to the logic: unique constraints, rollback on error, and
 * serialised transactions (a coarse stand-in for the per-wallet row lock).
 * Concurrency/atomicity guarantees of the real system are tested against PostgreSQL.
 */
export class InMemoryDatabase {
  tables: Tables = {
    wallets: new Map(),
    transactions: new Map(),
    ledger: [],
    ledgerStates: new Map(),
    inbox: new Map(),
    outbox: new Map(),
  };
  private seq = 0;
  private tail: Promise<unknown> = Promise.resolve();

  readonly unitOfWork: UnitOfWork = {
    run: <T>(work: (r: Repositories) => Promise<T>): Promise<T> => {
      const result = this.tail.then(async () => {
        const snapshot: Tables = {
          wallets: new Map(this.tables.wallets),
          transactions: new Map(this.tables.transactions),
          ledger: [...this.tables.ledger],
          ledgerStates: new Map(this.tables.ledgerStates),
          inbox: new Map(this.tables.inbox),
          outbox: new Map(this.tables.outbox),
        };
        try {
          return await work(this.repositories());
        } catch (error) {
          this.tables = snapshot; // rollback
          throw error;
        }
      });
      this.tail = result.catch(() => undefined);
      return result;
    },
  };

  outboxMessages(): OutboxMessage[] {
    return [...this.tables.outbox.values()].map((s) => OutboxMessage.rehydrate(s));
  }

  ledgerEntries(walletId: string): WalletLedgerEntry[] {
    return this.tables.ledger.filter((r) => r.entry.walletId === walletId).map((r) => r.entry);
  }

  seedWallet(wallet: Wallet): void {
    this.tables.wallets.set(wallet.id, walletState(wallet));
  }

  private repositories(): Repositories {
    const t = (): Tables => this.tables;
    return {
      wallets: {
        insert: async (wallet) => {
          for (const w of t().wallets.values()) {
            if (w.playerId === wallet.playerId && w.currency === wallet.currency) return false;
          }
          t().wallets.set(wallet.id, walletState(wallet));
          return true;
        },
        findById: async (id) => {
          const s = t().wallets.get(id);
          return s ? Wallet.rehydrate(s) : null;
        },
        findByIdForUpdate: async (id) => {
          const s = t().wallets.get(id);
          return s ? Wallet.rehydrate(s) : null;
        },
        update: async (wallet, expectedVersion) => {
          const current = t().wallets.get(wallet.id);
          if (!current || current.version !== expectedVersion) {
            throw new ConcurrentWalletModificationError(`wallet ${wallet.id} version mismatch`);
          }
          t().wallets.set(wallet.id, walletState(wallet));
        },
      },
      transactions: {
        insert: async (tx) => {
          for (const s of t().transactions.values()) {
            if (
              s.idempotencyKey === tx.idempotencyKey ||
              (s.providerId === tx.providerId && s.externalTransactionId === tx.externalTransactionId)
            ) {
              return false;
            }
          }
          t().transactions.set(tx.id, transactionState(tx));
          return true;
        },
        update: async (tx) => {
          t().transactions.set(tx.id, transactionState(tx));
        },
        findById: async (id) => {
          const s = t().transactions.get(id);
          return s ? WagerTransaction.rehydrate(s) : null;
        },
        findByIdempotencyKey: async (key) => {
          for (const s of t().transactions.values()) {
            if (s.idempotencyKey === key) return WagerTransaction.rehydrate(s);
          }
          return null;
        },
        findByExternalId: async (providerId, externalId) => {
          for (const s of t().transactions.values()) {
            if (s.providerId === providerId && s.externalTransactionId === externalId) {
              return WagerTransaction.rehydrate(s);
            }
          }
          return null;
        },
        hasProcessedReversal: async (referenceId) => {
          for (const s of t().transactions.values()) {
            if (
              s.referenceTransactionId === referenceId &&
              s.status === WagerTransactionStatus.Processed &&
              (s.kind === WagerTransactionKind.Refund || s.kind === WagerTransactionKind.Rollback)
            ) {
              return true;
            }
          }
          return false;
        },
        findDuePendingReferences: async (now, limit): Promise<DuePendingReference[]> =>
          [...t().transactions.values()]
            .filter(
              (s) =>
                s.status === WagerTransactionStatus.PendingReference &&
                s.nextRetryAt !== undefined &&
                s.nextRetryAt.getTime() <= now.getTime(),
            )
            .slice(0, limit)
            .map((s) => ({ id: s.id, walletId: s.walletId })),
        wakeDependents: async (providerId, referenceExternalId, now) => {
          let n = 0;
          for (const [id, s] of t().transactions) {
            if (
              s.status === WagerTransactionStatus.PendingReference &&
              s.providerId === providerId &&
              s.referenceExternalTransactionId === referenceExternalId
            ) {
              t().transactions.set(id, { ...s, nextRetryAt: now });
              n += 1;
            }
          }
          return n;
        },
      },
      ledger: {
        insert: async (entry) => {
          for (const r of t().ledger) {
            if (r.entry.walletId === entry.walletId && r.entry.transactionId === entry.transactionId) {
              throw new Error('unique violation: one ledger entry per (wallet, transaction)');
            }
            if (r.entry.walletId === entry.walletId && r.entry.walletVersion === entry.walletVersion) {
              throw new Error('unique violation: (wallet, wallet_version)');
            }
          }
          this.seq += 1;
          t().ledger.push({ seq: String(this.seq), entry });
        },
        page: async (walletId, { before, limit }) =>
          t()
            .ledger.filter((r) => r.entry.walletId === walletId && (before === undefined || BigInt(r.seq) < BigInt(before)))
            .sort((a, b) => Number(BigInt(b.seq) - BigInt(a.seq)))
            .slice(0, limit),
        reconciliationSnapshot: async (walletId): Promise<ReconciliationSnapshot | null> => {
          const w = t().wallets.get(walletId);
          if (!w) return null;
          let calculated = Money.zero(w.currency);
          let count = 0;
          for (const r of t().ledger) {
            if (r.entry.walletId !== walletId) continue;
            count += 1;
            calculated =
              r.entry.direction === LedgerDirection.Credit
                ? calculated.add(r.entry.money)
                : calculated.subtract(r.entry.money);
          }
          return { storedBalance: w.balance, calculatedBalance: calculated, checkedEntries: count };
        },
      },
      inbox: {
        tryReceive: async (m) => {
          const key = `${m.consumerName}|${m.messageId}`;
          if (t().inbox.has(key)) return false;
          t().inbox.set(key, {
            messageId: m.messageId,
            consumerName: m.consumerName,
            payloadHash: m.payloadHash,
            receivedAt: m.receivedAt,
          });
          return true;
        },
        markProcessed: async (m) => {
          const key = `${m.consumerName}|${m.messageId}`;
          const s = t().inbox.get(key);
          if (s) t().inbox.set(key, { ...s, processedAt: m.processedAt });
        },
      },
      outbox: {
        add: async (m) => {
          t().outbox.set(m.id, {
            id: m.id,
            aggregateId: m.aggregateId,
            partitionKey: m.partitionKey,
            eventType: m.eventType,
            payload: m.payload,
            occurredAt: m.occurredAt,
            attempts: m.attempts,
            nextAttemptAt: m.nextAttemptAt,
            publishedAt: m.publishedAt,
          });
        },
        // Same rule as the SQL: a message is not claimable while an EARLIER unpublished message of the
        // same partition is backing off (otherwise it would overtake it).
        claimDue: async (now, limit) => {
          const all = [...t().outbox.values()];
          return all
            .filter((s) => {
              const m = OutboxMessage.rehydrate(s);
              if (!m.isDue(now)) return false;
              const idx = all.indexOf(s);
              return !all.slice(0, idx).some(
                (e) =>
                  e.partitionKey === s.partitionKey &&
                  e.publishedAt === undefined &&
                  e.nextAttemptAt !== undefined &&
                  e.nextAttemptAt.getTime() > now.getTime(),
              );
            })
            .map((s) => OutboxMessage.rehydrate(s))
            .slice(0, limit);
        },
        save: async (m) => {
          const s = t().outbox.get(m.id);
          if (s) t().outbox.set(m.id, { ...s, attempts: m.attempts, nextAttemptAt: m.nextAttemptAt, publishedAt: m.publishedAt });
        },
        stats: async (now): Promise<OutboxStats> => {
          const pending = [...t().outbox.values()].filter((s) => s.publishedAt === undefined);
          const oldest = pending.reduce<number>((acc, s) => Math.min(acc, s.occurredAt.getTime()), Number.POSITIVE_INFINITY);
          return {
            pending: pending.length,
            oldestPendingAgeSeconds: pending.length === 0 ? 0 : (now.getTime() - oldest) / 1000,
          };
        },
      },
    };
  }
}

export { InboxMessage };
