import { InboxMessage } from '../messaging/domain/inbox-message';
import { WagerProcessor } from '../wagering/domain/wager-processor';
import { WagerTransaction } from '../wagering/domain/wager-transaction';
import { IdempotencyConflictError, WalletNotFoundError } from './errors';
import { computePayloadHash } from './payload-hash';
import {
  Clock,
  IdGenerator,
  Logger,
  Metrics,
  PendingReferencePolicy,
  Repositories,
  UnitOfWork,
  referenceRetryDelayMs,
} from './ports';
import { TransactionEffects } from './transaction-effects';
import { ValidatedSubmission, validateSubmission } from './validation';

export interface SubmitWagerTransactionInput {
  /** `Idempotency-Key` header (HTTP) or `data.idempotencyKey` (SQS). */
  idempotencyKey: unknown;
  /** Untrusted business payload; validated here, once, for both entry points. */
  data: unknown;
  correlationId: string;
  causationId?: string;
  source: 'http' | 'sqs';
  /** Present for SQS deliveries: dedup record written in the same SQL transaction. */
  inbox?: { messageId: string; consumerName: string; payloadHash: string };
}

export type SubmitWagerTransactionResult =
  | { type: 'RESULT'; transaction: WagerTransaction; idempotentReplay: boolean }
  /** The inbox already holds this message: its effects were committed by an earlier delivery. */
  | { type: 'DUPLICATE_MESSAGE' };

/**
 * The single entry point for wager transactions — HTTP and the SQS consumer both call it.
 *
 * Everything below happens in ONE SQL transaction:
 *   inbox row → idempotency check → wallet row lock → business rules → transaction row →
 *   wallet update → ledger entry → outbox events.
 * Either all of it commits or none of it does; events only reach the broker after commit
 * (a separate publisher drains the outbox).
 */
export class SubmitWagerTransactionUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly processor: WagerProcessor,
    private readonly effects: TransactionEffects,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
    private readonly pendingPolicy: PendingReferencePolicy,
  ) {}

  async execute(input: SubmitWagerTransactionInput): Promise<SubmitWagerTransactionResult> {
    const startedAt = performance.now();
    const submission = validateSubmission(input.idempotencyKey, input.data);
    const payloadHash = computePayloadHash(submission);

    const result = await this.uow.run((repos) => this.runInTransaction(repos, input, submission, payloadHash));

    this.metrics.processingDuration(input.source, (performance.now() - startedAt) / 1000);
    if (result.type === 'RESULT') {
      if (result.idempotentReplay) {
        this.metrics.duplicateDetected('idempotency');
      } else {
        this.metrics.transactionProcessed(result.transaction.status, result.transaction.kind);
      }
      this.logger.info('wager transaction handled', {
        transactionId: result.transaction.id,
        walletId: result.transaction.walletId,
        providerId: result.transaction.providerId,
        status: result.transaction.status,
        failureCode: result.transaction.failureCode,
        idempotentReplay: result.idempotentReplay,
        source: input.source,
      });
    }
    return result;
  }

  private async runInTransaction(
    repos: Repositories,
    input: SubmitWagerTransactionInput,
    submission: ValidatedSubmission,
    payloadHash: string,
  ): Promise<SubmitWagerTransactionResult> {
    const now = this.clock.now();

    // 1. Inbox: dedup of the *message*. The row commits (or rolls back) with the effects, so a
    //    visible inbox row always means "this message's effects are committed".
    let inbox: InboxMessage | undefined;
    if (input.inbox) {
      inbox = InboxMessage.receive({ ...input.inbox, receivedAt: now });
      const fresh = await repos.inbox.tryReceive(inbox);
      if (!fresh) {
        this.metrics.duplicateDetected('inbox');
        return { type: 'DUPLICATE_MESSAGE' };
      }
    }

    // 2. Idempotency fast path (no lock): committed duplicates are answered without touching the wallet.
    const known = await repos.transactions.findByIdempotencyKey(submission.idempotencyKey);
    if (known) {
      return this.finishInbox(repos, inbox, now, this.replay(known, payloadHash));
    }

    // 3. Per-wallet lock. From here on, this wallet has exactly one writer.
    const lockStartedAt = performance.now();
    const wallet = await repos.wallets.findByIdForUpdate(submission.walletId);
    this.metrics.walletLockWait((performance.now() - lockStartedAt) / 1000);
    if (!wallet) throw new WalletNotFoundError(submission.walletId);

    // 4. Re-check under the lock: a twin may have committed while we waited for it.
    const knownUnderLock = await repos.transactions.findByIdempotencyKey(submission.idempotencyKey);
    if (knownUnderLock) {
      return this.finishInbox(repos, inbox, now, this.replay(knownUnderLock, payloadHash));
    }
    const sameExternalId = await repos.transactions.findByExternalId(
      submission.providerId,
      submission.externalTransactionId,
    );
    if (sameExternalId) {
      throw new IdempotencyConflictError(
        `externalTransactionId ${submission.externalTransactionId} was already submitted under a different Idempotency-Key`,
      );
    }

    // 5. Business rules (pure).
    const transaction = WagerTransaction.create({
      id: this.ids.next(),
      providerId: submission.providerId,
      externalTransactionId: submission.externalTransactionId,
      idempotencyKey: submission.idempotencyKey,
      payloadHash,
      walletId: submission.walletId,
      playerId: submission.playerId,
      roundId: submission.roundId,
      gameId: submission.gameId,
      kind: submission.kind,
      money: submission.money,
      referenceExternalTransactionId: submission.referenceExternalTransactionId,
      createdAt: now,
    });

    const reference =
      transaction.referenceExternalTransactionId !== undefined
        ? await repos.transactions.findByExternalId(
            transaction.providerId,
            transaction.referenceExternalTransactionId,
          )
        : null;
    const referenceAlreadyReversed =
      reference !== null && transaction.isReversal()
        ? await repos.transactions.hasProcessedReversal(reference.id)
        : false;

    const versionBefore = wallet.version;
    const outcome = this.processor.process({
      wallet,
      transaction,
      reference,
      referenceAlreadyReversed,
      now,
      entryId: this.ids.next(),
      pending: {
        nextRetryAt: new Date(now.getTime() + referenceRetryDelayMs(this.pendingPolicy, 0)),
        exhausted: false,
      },
    });

    // 6. Persist. The unique constraints are the last line of defence for idempotency: if another
    //    transaction (e.g. same key, different wallet) won the race, nothing of ours is written.
    const inserted = await repos.transactions.insert(transaction);
    if (!inserted) {
      const winner = await repos.transactions.findByIdempotencyKey(submission.idempotencyKey);
      if (winner) return this.finishInbox(repos, inbox, now, this.replay(winner, payloadHash));
      throw new IdempotencyConflictError(
        `externalTransactionId ${submission.externalTransactionId} was already submitted under a different Idempotency-Key`,
      );
    }

    await this.effects.persist(repos, {
      wallet,
      versionBefore,
      transaction,
      outcome,
      isNew: true,
      now,
      correlationId: input.correlationId,
      causationId: input.causationId ?? input.inbox?.messageId,
    });

    return this.finishInbox(repos, inbox, now, {
      type: 'RESULT',
      transaction,
      idempotentReplay: false,
    });
  }

  /** Same key: identical payload ⇒ replay of the original result; different payload ⇒ conflict. */
  private replay(known: WagerTransaction, payloadHash: string): SubmitWagerTransactionResult {
    if (!known.matchesPayload(payloadHash)) {
      throw new IdempotencyConflictError(
        `Idempotency-Key ${known.idempotencyKey} was already used with a different payload`,
      );
    }
    return { type: 'RESULT', transaction: known, idempotentReplay: true };
  }

  private async finishInbox(
    repos: Repositories,
    inbox: InboxMessage | undefined,
    now: Date,
    result: SubmitWagerTransactionResult,
  ): Promise<SubmitWagerTransactionResult> {
    if (inbox) {
      inbox.markProcessed(now);
      await repos.inbox.markProcessed(inbox);
    }
    return result;
  }
}
