import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from '../../src/shared/domain/errors';
import { Money } from '../../src/shared/domain/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money — parsing', () => {
  test('normalises to a fixed scale of 2', () => {
    expect(brl('25').amount).toBe('25.00');
    expect(brl('25.5').amount).toBe('25.50');
    expect(brl('25.05').amount).toBe('25.05');
    expect(brl('0').amount).toBe('0.00');
  });

  test.each([
    ['empty string', ''],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['scientific notation', '1e3'],
    ['scientific notation (decimal)', '1.5e2'],
    ['three decimals', '1.001'],
    ['negative', '-1.00'],
    ['explicit plus', '+1.00'],
    ['leading zeros', '007.00'],
    ['leading space', ' 1.00'],
    ['trailing dot', '1.'],
    ['comma decimal', '1,00'],
    ['thousands separator', '1,000.00'],
    ['hex', '0x10'],
  ])('rejects %s', (_label, amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  test('rejects non-string amounts (JSON numbers must never become money)', () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: null as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  test('rejects malformed currency and non-objects', () => {
    expect(() => Money.from({ amount: '1.00', currency: 'brl' })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: '1.00', currency: 'BRLL' })).toThrow(InvalidMoneyError);
    expect(() => Money.from(null as unknown as { amount: string; currency: string })).toThrow(InvalidMoneyError);
  });

  test('rejects absurdly large values', () => {
    expect(() => brl('99999999999999999999.00')).toThrow(InvalidMoneyError);
  });

  test('fromStored accepts a negative figure (needed to report corrupt data)', () => {
    expect(Money.fromStored({ amount: '-5.50', currency: 'BRL' }).amount).toBe('-5.50');
  });
});

describe('Money — arithmetic', () => {
  test('is exact where floats are not (0.1 + 0.2)', () => {
    expect(brl('0.10').add(brl('0.20')).amount).toBe('0.30');
    expect(brl('0.10').add(brl('0.20')).equals(brl('0.30'))).toBe(true);
  });

  test('add / subtract / negate return new instances and never mutate', () => {
    const a = brl('10.00');
    const b = brl('2.50');
    expect(a.add(b).amount).toBe('12.50');
    expect(a.subtract(b).amount).toBe('7.50');
    expect(a.negate().amount).toBe('-10.00');
    expect(a.amount).toBe('10.00');
    expect(b.amount).toBe('2.50');
  });

  test('subtract can go below zero (callers guard the invariant)', () => {
    const result = brl('1.00').subtract(brl('2.00'));
    expect(result.amount).toBe('-1.00');
    expect(result.isNegative()).toBe(true);
  });

  test('stays exact beyond Number.MAX_SAFE_INTEGER worth of cents', () => {
    let total = Money.zero('BRL');
    const step = brl('10000000000000.00');
    for (let i = 0; i < 1000; i++) total = total.add(step); // 1e18 cents > 2^53
    expect(total.amount).toBe('10000000000000000.00');
    expect(total.add(brl('0.01')).amount).toBe('10000000000000000.01');
  });

  test('comparisons', () => {
    expect(brl('1.00').isLessThan(brl('2.00'))).toBe(true);
    expect(brl('2.00').isLessThan(brl('2.00'))).toBe(false);
    expect(brl('2.00').isGreaterThan(brl('1.00'))).toBe(true);
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
  });

  test('equals considers currency', () => {
    expect(brl('1.00').equals(Money.from({ amount: '1.00', currency: 'USD' }))).toBe(false);
  });
});

describe('Money — currency conflicts', () => {
  const usd = Money.from({ amount: '1.00', currency: 'USD' });

  test('every binary operation throws a domain error', () => {
    expect(() => brl('1.00').add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isGreaterThan(usd)).toThrow(CurrencyMismatchError);
  });
});

describe('Money — serialisation', () => {
  test('toJSON is a stable { amount, currency } of strings', () => {
    expect(JSON.stringify(brl('25'))).toBe('{"amount":"25.00","currency":"BRL"}');
    expect(brl('25').toString()).toBe('25.00 BRL');
  });
});
