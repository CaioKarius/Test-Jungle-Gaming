import { describe, expect, test } from 'bun:test';
import { InvalidLedgerEntryError } from '../../src/shared/domain/errors';
import { Money } from '../../src/shared/domain/money';
import { LedgerDirection } from '../../src/wallet/domain/ledger-direction';
import { WalletLedgerEntry } from '../../src/wallet/domain/wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const base = {
  id: 'e1', walletId: 'w1', transactionId: 't1', walletVersion: 2, createdAt: new Date(0),
};

describe('WalletLedgerEntry', () => {
  test('create accepts a balanced credit and debit', () => {
    expect(
      WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Credit, money: brl('5.00'), balanceBefore: brl('10.00'), balanceAfter: brl('15.00') }).isBalanced(),
    ).toBe(true);
    expect(
      WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Debit, money: brl('5.00'), balanceBefore: brl('10.00'), balanceAfter: brl('5.00') }).isBalanced(),
    ).toBe(true);
  });

  test('create rejects unbalanced arithmetic', () => {
    expect(() =>
      WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Debit, money: brl('5.00'), balanceBefore: brl('10.00'), balanceAfter: brl('6.00') }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('create rejects non-positive amounts and negative balances', () => {
    expect(() =>
      WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Credit, money: brl('0.00'), balanceBefore: brl('1.00'), balanceAfter: brl('1.00') }),
    ).toThrow(InvalidLedgerEntryError);
    expect(() =>
      WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Debit, money: brl('5.00'), balanceBefore: brl('1.00'), balanceAfter: Money.fromStored({ amount: '-4.00', currency: 'BRL' }) }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('create rejects mixed currencies', () => {
    expect(() =>
      WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Credit, money: Money.from({ amount: '1.00', currency: 'USD' }), balanceBefore: brl('1.00'), balanceAfter: brl('2.00') }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('is structurally immutable', () => {
    const entry = WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Credit, money: brl('5.00'), balanceBefore: brl('10.00'), balanceAfter: brl('15.00') });
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { direction: string }).direction = 'DEBIT';
    }).toThrow();
  });
});
