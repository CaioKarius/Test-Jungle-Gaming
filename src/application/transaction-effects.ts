import { EventContext } from '../messaging/domain/integration-event';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../messaging/domain/events';
import { OutboxMessage } from '../messaging/domain/outbox-message';
import { ProcessOutcome } from '../wagering/domain/wager-processor';
import { WagerTransaction } from '../wagering/domain/wager-transaction';
import { Wallet } from '../wallet/domain/wallet';
import { IdGenerator, Repositories } from './ports';

export interface PersistEffectsInput {
  wallet: Wallet;
  /** Wallet version before the processor ran: the optimistic-lock guard for the UPDATE. */
  versionBefore: number;
  transaction: WagerTransaction;
  outcome: ProcessOutcome;
  /** True when the transaction row was just inserted (vs. a PENDING_REFERENCE retry). */
  isNew: boolean;
  now: Date;
  correlationId: string;
  causationId?: string;
}

/**
 * Persists everything a processing outcome implies, inside the caller's SQL transaction:
 * wallet balance, ledger entry, integration events (outbox), and wake-ups of dependents.
 * Shared by the submit use case and the PENDING_REFERENCE worker so both behave identically.
 *
 * The transaction row itself is written by the caller (INSERT vs UPDATE differ) *before* this
 * runs, because ledger entries reference it.
 */
export class TransactionEffects {
  constructor(private readonly ids: IdGenerator) {}

  async persist(repos: Repositories, input: PersistEffectsInput): Promise<void> {
    const { wallet, transaction, outcome, now } = input;
    const eventContext = (): EventContext => ({
      eventId: this.ids.next(),
      correlationId: input.correlationId,
      ...(input.causationId !== undefined ? { causationId: input.causationId } : {}),
      occurredAt: now,
    });

    switch (outcome.type) {
      case 'PROCESSED': {
        if (outcome.ledgerEntry) {
          await repos.wallets.update(wallet, input.versionBefore);
          await repos.ledger.insert(outcome.ledgerEntry);
        }
        await repos.outbox.add(OutboxMessage.enqueue(WagerTransactionProcessed.from(transaction, eventContext())));
        if (outcome.ledgerEntry) {
          await repos.outbox.add(
            OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, outcome.ledgerEntry, eventContext())),
          );
        }
        // Anything parked waiting for this transaction can be retried right away.
        await repos.transactions.wakeDependents(transaction.providerId, transaction.externalTransactionId, now);
        return;
      }
      case 'REJECTED': {
        await repos.outbox.add(OutboxMessage.enqueue(WagerTransactionRejected.from(transaction, eventContext())));
        return;
      }
      case 'PENDING_REFERENCE': {
        if (input.isNew) {
          await repos.outbox.add(
            OutboxMessage.enqueue(WagerTransactionPendingReference.from(transaction, eventContext())),
          );
        }
        return;
      }
    }
  }
}
