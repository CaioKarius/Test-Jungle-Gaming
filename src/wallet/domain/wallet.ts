import { InsufficientFundsError, InvalidWalletError } from '../../shared/domain/errors';
import { CurrencyMismatchError } from '../../shared/domain/errors';
import { Money } from '../../shared/domain/money';
import { LedgerDirection } from './ledger-direction';
import { WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface MovementProps {
  /** Id for the ledger entry this movement produces. */
  entryId: string;
  /** Wager transaction that causes the movement. */
  transactionId: string;
  money: Money;
  now: Date;
}

/**
 * Wallet aggregate root.
 *
 * Every balance change goes through `debit` / `credit`, which return the ledger entry that
 * accounts for it — balance and ledger can never drift apart in memory. `version` starts at 1
 * and only increments when the balance changes.
 *
 * Concurrency is NOT handled here: the aggregate is only ever mutated while the application
 * layer holds the wallet's row lock (see ARCHITECTURE.md), and the schema re-checks the
 * version and the balance/ledger agreement.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: { id: string; playerId: string; initialBalance: Money; now?: Date }): Wallet {
    if (props.playerId.trim().length === 0) {
      throw new InvalidWalletError('playerId is required');
    }
    if (props.initialBalance.isNegative()) {
      throw new InvalidWalletError('initial balance cannot be negative');
    }
    const now = props.now ?? new Date();
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      now,
      now,
    );
  }

  /** Reconstruction from persistence — does not re-validate transitions. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /**
   * Ledger entry for the balance a wallet was opened with. It does not bump the version:
   * "version starts at 1 after creation". Only valid on a freshly opened wallet.
   */
  recordOpening(props: { entryId: string; transactionId: string; now: Date }): WalletLedgerEntry {
    if (this._version !== 1 || !this._balance.isPositive()) {
      throw new InvalidWalletError('opening entry is only valid for a freshly opened wallet with a positive balance');
    }
    return WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction: LedgerDirection.Credit,
      money: this._balance,
      balanceBefore: Money.zero(this.currency),
      balanceAfter: this._balance,
      walletVersion: 1,
      createdAt: props.now,
    });
  }

  /** Throws `InsufficientFundsError` (leaving the wallet untouched) if the balance would go negative. */
  debit(props: MovementProps): WalletLedgerEntry {
    this.assertMovable(props.money);
    if (this._balance.isLessThan(props.money)) {
      throw new InsufficientFundsError(
        `wallet ${this.id} cannot cover a debit of ${props.money.toString()}`,
      );
    }
    return this.apply(LedgerDirection.Debit, props);
  }

  credit(props: MovementProps): WalletLedgerEntry {
    this.assertMovable(props.money);
    return this.apply(LedgerDirection.Credit, props);
  }

  private apply(direction: LedgerDirection, props: MovementProps): WalletLedgerEntry {
    const before = this._balance;
    const after =
      direction === LedgerDirection.Debit ? before.subtract(props.money) : before.add(props.money);
    const nextVersion = this._version + 1;

    // Build (and validate) the entry first: if it throws, the aggregate has not been touched.
    const entry = WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      money: props.money,
      balanceBefore: before,
      balanceAfter: after,
      walletVersion: nextVersion,
      createdAt: props.now,
    });

    this._balance = after;
    this._version = nextVersion;
    this._updatedAt = props.now;
    return entry;
  }

  private assertMovable(money: Money): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new InvalidWalletError('movement amount must be positive');
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(
        `wallet ${this.id} is in ${this.currency}, got ${money.currency}`,
      );
    }
  }
}
