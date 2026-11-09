import { PROVIDER_ACTION } from '../../wagering/domain/failure-code';
import { WagerTransaction, WagerTransactionStatus } from '../../wagering/domain/wager-transaction';
import { Wallet } from '../../wallet/domain/wallet';
import { WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry';

export function presentWallet(wallet: Wallet) {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
    createdAt: wallet.createdAt.toISOString(),
    updatedAt: wallet.updatedAt.toISOString(),
  };
}

export function presentLedgerEntry(entry: WalletLedgerEntry) {
  return {
    id: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    direction: entry.direction,
    money: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    walletVersion: entry.walletVersion,
    createdAt: entry.createdAt.toISOString(),
  };
}

/** Body of POST /wagering/transactions. */
export function presentSubmitResult(tx: WagerTransaction, idempotentReplay: boolean) {
  return {
    transactionId: tx.id,
    status: tx.status,
    balance: tx.observedBalance?.toJSON() ?? null,
    idempotentReplay,
    ...(tx.failureCode
      ? { failureCode: tx.failureCode, providerAction: PROVIDER_ACTION[tx.failureCode] }
      : {}),
    ...(tx.status === WagerTransactionStatus.PendingReference
      ? { nextRetryAt: tx.nextRetryAt?.toISOString() ?? null }
      : {}),
  };
}

/** HTTP status of the submit endpoint for a given transaction state. */
export function submitStatusCode(tx: WagerTransaction, idempotentReplay: boolean): number {
  switch (tx.status) {
    case WagerTransactionStatus.Processed:
      return idempotentReplay ? 200 : 201;
    case WagerTransactionStatus.PendingReference:
    case WagerTransactionStatus.Pending:
      return 202; // accepted, processing pending
    case WagerTransactionStatus.Rejected:
      return 422; // business rule violation (final)
    case WagerTransactionStatus.Failed:
      return 500; // permanent infrastructure failure (final, auditable)
  }
}

/** Resource representation for GET endpoints. */
export function presentTransaction(tx: WagerTransaction) {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    status: tx.status,
    balance: tx.observedBalance?.toJSON() ?? null,
    referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
    referenceTransactionId: tx.referenceTransactionId ?? null,
    failureCode: tx.failureCode ?? null,
    providerAction: tx.failureCode ? PROVIDER_ACTION[tx.failureCode] : null,
    nextRetryAt: tx.nextRetryAt?.toISOString() ?? null,
    createdAt: tx.createdAt.toISOString(),
    processedAt: tx.processedAt?.toISOString() ?? null,
  };
}
