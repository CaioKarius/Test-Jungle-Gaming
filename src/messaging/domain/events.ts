import { MoneyProps } from '../../shared/domain/money';
import { LedgerDirection } from '../../wallet/domain/ledger-direction';
import { Wallet } from '../../wallet/domain/wallet';
import { WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry';
import { WagerTransaction } from '../../wagering/domain/wager-transaction';
import { EventContext, IntegrationEvent } from './integration-event';

interface WagerTransactionEventData {
  transactionId: string;
  walletId: string;
  playerId: string;
  providerId: string;
  externalTransactionId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  /** Wallet balance observed when the outcome was decided. */
  balance: MoneyProps;
}

function transactionData(tx: WagerTransaction): WagerTransactionEventData {
  return {
    transactionId: tx.id,
    walletId: tx.walletId,
    playerId: tx.playerId,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    // Always set by WagerProcessor before any outcome is emitted.
    balance: (tx.observedBalance ?? tx.money).toJSON(),
  };
}

// ---- WagerTransactionProcessed ---------------------------------------------------------

export type WagerTransactionProcessedData = WagerTransactionEventData;

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed({ ...ctx, aggregateId: tx.id, data: transactionData(tx) });
  }

  override partitionKey(): string {
    return this.data.walletId;
  }
}

// ---- WagerTransactionRejected ----------------------------------------------------------

export interface WagerTransactionRejectedData extends WagerTransactionEventData {
  failureCode: string;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: tx.id,
      data: { ...transactionData(tx), failureCode: tx.failureCode ?? 'UNKNOWN' },
    });
  }

  override partitionKey(): string {
    return this.data.walletId;
  }
}

// ---- WagerTransactionPendingReference --------------------------------------------------

export interface WagerTransactionPendingReferenceData extends WagerTransactionEventData {
  referenceExternalTransactionId: string;
  nextRetryAt: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({
      ...ctx,
      aggregateId: tx.id,
      data: {
        ...transactionData(tx),
        referenceExternalTransactionId: tx.referenceExternalTransactionId ?? '',
        nextRetryAt: (tx.nextRetryAt ?? ctx.occurredAt).toISOString(),
      },
    });
  }

  override partitionKey(): string {
    return this.data.walletId;
  }
}

// ---- WalletBalanceChanged --------------------------------------------------------------

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

/** Emitted ONLY when the balance actually changes (never for LOSS or rejections). */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged({
      ...ctx,
      aggregateId: wallet.id,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: entry.walletVersion,
      },
    });
  }

  override partitionKey(): string {
    return this.data.walletId;
  }
}
