import { Money, MoneyProps } from '../shared/domain/money';
import { UUID_PATTERN } from '../shared/ids';
import { WagerTransaction } from '../wagering/domain/wager-transaction';
import { Wallet } from '../wallet/domain/wallet';
import { WalletLedgerEntry } from '../wallet/domain/wallet-ledger-entry';
import { TransactionNotFoundError, ValidationError, WalletNotFoundError } from './errors';
import { Logger, Metrics, UnitOfWork } from './ports';

export const DEFAULT_LEDGER_LIMIT = 50;
export const MAX_LEDGER_LIMIT = 200;

export interface LedgerPage {
  items: WalletLedgerEntry[];
  nextCursor: string | null;
}

export interface ReconciliationResult {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

export function encodeCursor(seq: string): string {
  return Buffer.from(JSON.stringify({ s: seq }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): string {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { s?: unknown };
    if (typeof parsed.s === 'string' && /^\d{1,19}$/.test(parsed.s)) return parsed.s;
  } catch {
    // fall through
  }
  throw new ValidationError('invalid cursor', [{ field: 'cursor', message: 'is not a valid cursor' }]);
}

/** Read side: wallet, ledger, transactions, reconciliation. */
export class WalletQueries {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
  ) {}

  async getWallet(walletId: string): Promise<Wallet> {
    this.assertUuid(walletId, 'walletId');
    const wallet = await this.uow.run((repos) => repos.wallets.findById(walletId));
    if (!wallet) throw new WalletNotFoundError(walletId);
    return wallet;
  }

  async getLedger(walletId: string, rawCursor: string | undefined, rawLimit: string | undefined): Promise<LedgerPage> {
    this.assertUuid(walletId, 'walletId');
    const limit = this.parseLimit(rawLimit);
    const before = rawCursor ? decodeCursor(rawCursor) : undefined;

    return this.uow.run(async (repos) => {
      if (!(await repos.wallets.findById(walletId))) throw new WalletNotFoundError(walletId);
      // Fetch one extra row to know whether another page exists.
      const rows = await repos.ledger.page(walletId, { before, limit: limit + 1 });
      const pageRows = rows.slice(0, limit);
      const last = pageRows[pageRows.length - 1];
      return {
        items: pageRows.map((row) => row.entry),
        nextCursor: rows.length > limit && last ? encodeCursor(last.seq) : null,
      };
    });
  }

  async getTransactionById(transactionId: string): Promise<WagerTransaction> {
    this.assertUuid(transactionId, 'transactionId');
    const transaction = await this.uow.run((repos) => repos.transactions.findById(transactionId));
    if (!transaction) throw new TransactionNotFoundError(`transaction ${transactionId} not found`);
    return transaction;
  }

  async getTransactionByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction> {
    const transaction = await this.uow.run((repos) =>
      repos.transactions.findByExternalId(providerId, externalTransactionId),
    );
    if (!transaction) {
      throw new TransactionNotFoundError(
        `transaction ${externalTransactionId} of provider ${providerId} not found`,
      );
    }
    return transaction;
  }

  /**
   * Compares the materialised balance with the one rebuilt from the ledger. Divergences are never
   * "fixed": they are logged, counted and flagged in the response.
   */
  async reconcile(walletId: string): Promise<ReconciliationResult> {
    this.assertUuid(walletId, 'walletId');
    const snapshot = await this.uow.run((repos) => repos.ledger.reconciliationSnapshot(walletId));
    if (!snapshot) throw new WalletNotFoundError(walletId);

    const difference: Money = snapshot.storedBalance.subtract(snapshot.calculatedBalance);
    const consistent = difference.isZero();
    if (!consistent) {
      this.metrics.reconciliationDivergence();
      this.logger.error('wallet reconciliation divergence detected', {
        walletId,
        checkedEntries: snapshot.checkedEntries,
        difference: difference.amount,
      });
    }
    return {
      walletId,
      storedBalance: snapshot.storedBalance.toJSON(),
      calculatedBalance: snapshot.calculatedBalance.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: snapshot.checkedEntries,
    };
  }

  private parseLimit(raw: string | undefined): number {
    if (raw === undefined) return DEFAULT_LEDGER_LIMIT;
    if (!/^\d+$/.test(raw)) {
      throw new ValidationError('invalid limit', [{ field: 'limit', message: 'must be a positive integer' }]);
    }
    const limit = Number.parseInt(raw, 10);
    if (limit < 1 || limit > MAX_LEDGER_LIMIT) {
      throw new ValidationError('invalid limit', [
        { field: 'limit', message: `must be between 1 and ${MAX_LEDGER_LIMIT}` },
      ]);
    }
    return limit;
  }

  private assertUuid(value: string, field: string): void {
    if (!UUID_PATTERN.test(value)) {
      throw new ValidationError(`invalid ${field}`, [{ field, message: 'must be a UUID' }]);
    }
  }
}
