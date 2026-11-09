import { CurrencyMismatchError, InvalidMoneyError } from './errors';

/** Wire / persistence representation. `amount` is always a decimal string with 2 fractional digits. */
export interface MoneyProps {
  amount: string;
  currency: string;
}

const SCALE = 2;
const FACTOR = 100n; // 10 ** SCALE
/** Largest accepted absolute value in minor units (10_000_000_000_000.00). Keeps us far from NUMERIC(19,2) limits. */
const MAX_MINOR = 10n ** 15n;

const UNSIGNED_AMOUNT = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/;
const SIGNED_AMOUNT = /^(-)?(0|[1-9]\d*)(?:\.(\d{1,2}))?$/;
const CURRENCY = /^[A-Z]{3}$/;

/**
 * Immutable monetary value.
 *
 * Internally the amount is a `bigint` count of minor units (cents). There is no `number`,
 * `float` or `double` anywhere in the money path: parsing, arithmetic and formatting are all
 * exact integer operations.
 */
export class Money {
  private constructor(
    private readonly minor: bigint,
    public readonly currency: string,
  ) {}

  /**
   * Parses an *input contract* value: non-negative decimal string with at most 2 fractional
   * digits. Rejects NaN, Infinity, scientific notation, empty strings, signs, spaces and
   * more than 2 decimals. "25" and "25.5" are normalised to "25.00" / "25.50".
   */
  static from(props: MoneyProps): Money {
    return Money.parse(props, false);
  }

  /**
   * Parses a value read back from persistence or produced by reconciliation, where a
   * (corrupt) negative figure must still be representable so it can be reported.
   */
  static fromStored(props: MoneyProps): Money {
    return Money.parse(props, true);
  }

  static zero(currency: string): Money {
    Money.assertCurrency(currency);
    return new Money(0n, currency);
  }

  get amount(): string {
    const negative = this.minor < 0n;
    const abs = negative ? -this.minor : this.minor;
    const integer = abs / FACTOR;
    const fraction = (abs % FACTOR).toString().padStart(SCALE, '0');
    return `${negative ? '-' : ''}${integer.toString()}.${fraction}`;
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor + other.minor, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor - other.minor, this.currency);
  }

  negate(): Money {
    return new Money(-this.minor, this.currency);
  }

  isZero(): boolean {
    return this.minor === 0n;
  }

  isPositive(): boolean {
    return this.minor > 0n;
  }

  isNegative(): boolean {
    return this.minor < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor < other.minor;
  }

  isGreaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor > other.minor;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minor === other.minor;
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(
        `currency mismatch: ${this.currency} vs ${other.currency}`,
      );
    }
  }

  private static assertCurrency(currency: unknown): asserts currency is string {
    if (typeof currency !== 'string' || !CURRENCY.test(currency)) {
      throw new InvalidMoneyError('currency must be a 3-letter uppercase ISO-4217 code');
    }
  }

  private static parse(props: MoneyProps, allowNegative: boolean): Money {
    if (typeof props !== 'object' || props === null) {
      throw new InvalidMoneyError('money must be an object { amount, currency }');
    }
    const { amount, currency } = props as Partial<MoneyProps>;
    Money.assertCurrency(currency);
    if (typeof amount !== 'string') {
      throw new InvalidMoneyError('amount must be a decimal string');
    }

    let negative = false;
    let integer: string;
    let fraction: string | undefined;
    if (allowNegative) {
      const m = SIGNED_AMOUNT.exec(amount);
      if (!m) throw Money.invalidAmount(amount);
      negative = m[1] === '-';
      integer = m[2] as string;
      fraction = m[3];
    } else {
      const m = UNSIGNED_AMOUNT.exec(amount);
      if (!m) throw Money.invalidAmount(amount);
      integer = m[1] as string;
      fraction = m[2];
    }

    const abs = BigInt(integer) * FACTOR + BigInt((fraction ?? '').padEnd(SCALE, '0'));
    if (abs > MAX_MINOR) {
      throw new InvalidMoneyError('amount exceeds the maximum supported value');
    }
    return new Money(negative ? -abs : abs, currency);
  }

  private static invalidAmount(amount: string): InvalidMoneyError {
    const shown = amount.length > 32 ? `${amount.slice(0, 32)}…` : amount;
    return new InvalidMoneyError(
      `invalid amount "${shown}": expected a non-negative decimal string with at most ${SCALE} fractional digits`,
    );
  }
}
