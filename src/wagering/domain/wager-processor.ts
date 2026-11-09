import { InsufficientFundsError, InvalidWagerTransactionError } from '../../shared/domain/errors';
import { LedgerDirection } from '../../wallet/domain/ledger-direction';
import { Wallet } from '../../wallet/domain/wallet';
import { WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry';
import { FailureCode } from './failure-code';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction';

export interface ProcessInput {
  /** The wallet, loaded under its row lock. Mutated in place when money moves. */
  wallet: Wallet;
  /** Mutated in place: ends PROCESSED, REJECTED or PENDING_REFERENCE. */
  transaction: WagerTransaction;
  /** The transaction named by `referenceExternalTransactionId`, if it exists yet. */
  reference: WagerTransaction | null;
  /** True if a PROCESSED REFUND/ROLLBACK already reverts `reference`. */
  referenceAlreadyReversed: boolean;
  now: Date;
  /** Id to give the ledger entry, should one be produced. */
  entryId: string;
  /** Retry policy decided by the caller: when to look again, and whether the budget is spent. */
  pending: { nextRetryAt: Date; exhausted: boolean };
}

export type ProcessOutcome =
  | { type: 'PROCESSED'; ledgerEntry: WalletLedgerEntry | null }
  | { type: 'REJECTED'; failureCode: FailureCode }
  | { type: 'PENDING_REFERENCE' };

/** Reference kinds each operation may point at. */
const ALLOWED_REFERENCE_KINDS: Readonly<Partial<Record<WagerTransactionKind, readonly WagerTransactionKind[]>>> = {
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ],
};

/**
 * Pure domain service applying the business rules (README §7) to a wallet + transaction.
 * No I/O: the caller loads state, calls `process`, and persists whatever changed.
 */
export class WagerProcessor {
  process(input: ProcessInput): ProcessOutcome {
    const { wallet, transaction } = input;

    if (transaction.walletId !== wallet.id) {
      throw new InvalidWagerTransactionError('transaction does not belong to this wallet');
    }
    if (transaction.kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError('OPENING is internal and cannot be processed');
    }
    if (transaction.playerId !== wallet.playerId) {
      return this.reject(input, FailureCode.PlayerMismatch);
    }
    if (transaction.money.currency !== wallet.currency) {
      return this.reject(input, FailureCode.CurrencyMismatch);
    }

    if (transaction.referenceExternalTransactionId !== undefined) {
      const early = this.checkReference(input);
      if (early) return early;
    }
    return this.apply(input);
  }

  private checkReference(input: ProcessInput): ProcessOutcome | null {
    const { transaction: tx, reference } = input;

    if (!reference) {
      return this.waitForReference(input, FailureCode.ReferenceNotFound);
    }

    if (
      reference.providerId !== tx.providerId ||
      reference.playerId !== tx.playerId ||
      reference.walletId !== tx.walletId ||
      reference.money.currency !== tx.money.currency ||
      reference.roundId !== tx.roundId
    ) {
      return this.reject(input, FailureCode.ReferenceContextMismatch);
    }

    const allowed = ALLOWED_REFERENCE_KINDS[tx.kind] ?? [];
    if (!allowed.includes(reference.kind)) {
      return this.reject(input, FailureCode.InvalidReferenceKind);
    }

    if (
      reference.status === WagerTransactionStatus.Pending ||
      reference.status === WagerTransactionStatus.PendingReference
    ) {
      // The reference itself is still waiting on something: wait too.
      return this.waitForReference(input, FailureCode.ReferenceNotProcessed);
    }
    if (reference.status !== WagerTransactionStatus.Processed) {
      return this.reject(input, FailureCode.ReferenceNotProcessed);
    }

    if (tx.isReversal()) {
      if (!tx.money.equals(reference.money)) {
        return this.reject(input, FailureCode.ReferenceAmountMismatch);
      }
      if (input.referenceAlreadyReversed) {
        return this.reject(input, FailureCode.AlreadyReversed);
      }
    }
    return null;
  }

  private apply(input: ProcessInput): ProcessOutcome {
    const { transaction: tx, reference } = input;
    switch (tx.kind) {
      case WagerTransactionKind.Loss:
        return this.processed(input, null);
      case WagerTransactionKind.Bet:
        return this.move(input, LedgerDirection.Debit, FailureCode.InsufficientFunds);
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return this.move(input, LedgerDirection.Credit, FailureCode.InsufficientFunds);
      case WagerTransactionKind.Rollback:
        return this.move(
          input,
          tx.ledgerDirectionFor(reference ?? undefined),
          FailureCode.ReversalInsufficientFunds,
        );
      case WagerTransactionKind.Opening:
        throw new InvalidWagerTransactionError('OPENING cannot be processed');
    }
  }

  private move(
    input: ProcessInput,
    direction: LedgerDirection,
    insufficientFundsCode: FailureCode,
  ): ProcessOutcome {
    const { wallet, transaction: tx, now, entryId } = input;
    const movement = { entryId, transactionId: tx.id, money: tx.money, now };
    try {
      const entry =
        direction === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
      return this.processed(input, entry);
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        return this.reject(input, insufficientFundsCode);
      }
      throw error;
    }
  }

  private processed(input: ProcessInput, ledgerEntry: WalletLedgerEntry | null): ProcessOutcome {
    const { wallet, transaction: tx, reference, now } = input;
    tx.observeBalance(wallet.balance);
    tx.markProcessed(reference?.id, now);
    return { type: 'PROCESSED', ledgerEntry };
  }

  private reject(input: ProcessInput, failureCode: FailureCode): ProcessOutcome {
    const { wallet, transaction: tx } = input;
    tx.observeBalance(wallet.balance);
    tx.reject(failureCode);
    return { type: 'REJECTED', failureCode };
  }

  /** Park the transaction until the reference shows up — or reject it once the retry budget is spent. */
  private waitForReference(input: ProcessInput, exhaustedCode: FailureCode): ProcessOutcome {
    const { wallet, transaction: tx, pending } = input;
    if (pending.exhausted) {
      return this.reject(input, exhaustedCode);
    }
    tx.observeBalance(wallet.balance);
    tx.markPendingReference(pending.nextRetryAt);
    return { type: 'PENDING_REFERENCE' };
  }
}
