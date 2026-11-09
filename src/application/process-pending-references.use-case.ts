import { DomainError } from '../shared/domain/errors';
import { FailureCode } from '../wagering/domain/failure-code';
import { WagerProcessor } from '../wagering/domain/wager-processor';
import { WagerTransactionStatus } from '../wagering/domain/wager-transaction';
import {
  Clock,
  DuePendingReference,
  IdGenerator,
  Logger,
  Metrics,
  PendingReferencePolicy,
  UnitOfWork,
  referenceRetryDelayMs,
} from './ports';
import { TransactionEffects } from './transaction-effects';

/**
 * Retries transactions parked in PENDING_REFERENCE (REFUND/ROLLBACK/WIN/LOSS that arrived before
 * the transaction they reference). Runs on every instance; correctness does not depend on it
 * running once: each retry takes the wallet lock and re-reads state, so concurrent workers just
 * serialise and the loser finds the work already done.
 */
export class ProcessPendingReferencesUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly processor: WagerProcessor,
    private readonly effects: TransactionEffects,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
    private readonly policy: PendingReferencePolicy,
  ) {}

  /** Returns how many parked transactions were examined (resolved, rejected or rescheduled). */
  async execute(limit: number): Promise<number> {
    const now = this.clock.now();
    const due = await this.uow.run((repos) => repos.transactions.findDuePendingReferences(now, limit));

    let handled = 0;
    for (const candidate of due) {
      try {
        if (await this.resolve(candidate)) handled += 1;
      } catch (error) {
        if (error instanceof DomainError) {
          // A domain invariant broke on data that should be valid: park it as FAILED for audit.
          this.logger.error('pending reference failed permanently', {
            transactionId: candidate.id,
            walletId: candidate.walletId,
            error: error.message,
          });
          await this.markFailed(candidate, FailureCode.InvariantViolation);
        } else {
          // Transient (DB hiccup…): leave it parked, the next tick retries.
          this.logger.warn('pending reference retry deferred', {
            transactionId: candidate.id,
            walletId: candidate.walletId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    return handled;
  }

  private async resolve(candidate: DuePendingReference): Promise<boolean> {
    const startedAt = performance.now();
    const outcomeType = await this.uow.run(async (repos) => {
      const now = this.clock.now();

      // Same lock order as the submit path (wallet first), so the two can never deadlock.
      const wallet = await repos.wallets.findByIdForUpdate(candidate.walletId);
      if (!wallet) return null;

      const transaction = await repos.transactions.findById(candidate.id);
      if (
        !transaction ||
        transaction.status !== WagerTransactionStatus.PendingReference ||
        transaction.referenceExternalTransactionId === undefined ||
        (transaction.nextRetryAt !== undefined && transaction.nextRetryAt.getTime() > now.getTime())
      ) {
        return null; // someone else already handled it, or it is not due any more
      }

      const reference = await repos.transactions.findByExternalId(
        transaction.providerId,
        transaction.referenceExternalTransactionId,
      );
      const referenceAlreadyReversed =
        reference !== null && transaction.isReversal()
          ? await repos.transactions.hasProcessedReversal(reference.id)
          : false;

      const attempt = transaction.referenceAttempts + 1;
      const exhausted =
        attempt >= this.policy.maxAttempts ||
        now.getTime() - transaction.createdAt.getTime() >= this.policy.ttlMs;

      const versionBefore = wallet.version;
      const outcome = this.processor.process({
        wallet,
        transaction,
        reference,
        referenceAlreadyReversed,
        now,
        entryId: this.ids.next(),
        pending: {
          nextRetryAt: new Date(now.getTime() + referenceRetryDelayMs(this.policy, attempt)),
          exhausted,
        },
      });

      await repos.transactions.update(transaction);
      await this.effects.persist(repos, {
        wallet,
        versionBefore,
        transaction,
        outcome,
        isNew: false,
        now,
        correlationId: transaction.id,
        causationId: transaction.id,
      });

      this.logger.info('pending reference retried', {
        transactionId: transaction.id,
        walletId: transaction.walletId,
        providerId: transaction.providerId,
        outcome: outcome.type,
        attempt,
      });
      if (outcome.type === 'PENDING_REFERENCE') {
        this.metrics.retry('pending_reference');
      } else {
        this.metrics.transactionProcessed(transaction.status, transaction.kind);
      }
      return outcome.type;
    });

    if (outcomeType !== null) {
      this.metrics.processingDuration('worker', (performance.now() - startedAt) / 1000);
    }
    return outcomeType !== null;
  }

  private async markFailed(candidate: DuePendingReference, code: FailureCode): Promise<void> {
    try {
      await this.uow.run(async (repos) => {
        const wallet = await repos.wallets.findByIdForUpdate(candidate.walletId);
        const transaction = await repos.transactions.findById(candidate.id);
        if (!wallet || !transaction || transaction.isTerminal()) return;
        transaction.observeBalance(wallet.balance);
        transaction.fail(code);
        await repos.transactions.update(transaction);
        this.metrics.transactionProcessed(transaction.status, transaction.kind);
      });
    } catch (error) {
      this.logger.error('could not mark transaction as FAILED', {
        transactionId: candidate.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
