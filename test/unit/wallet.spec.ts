import { describe, expect, test } from 'bun:test';
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidWalletError,
} from '../../src/shared/domain/errors';
import { Money } from '../../src/shared/domain/money';
import { LedgerDirection } from '../../src/wallet/domain/ledger-direction';
import { Wallet } from '../../src/wallet/domain/wallet';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const now = new Date('2026-08-01T00:00:00Z');
const open = (amount = '100.00') =>
  Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: brl(amount), now });
const move = (amount: string, n = 1) => ({ entryId: `e${n}`, transactionId: `t${n}`, money: brl(amount), now });

describe('Wallet', () => {
  test('opens with version 1 and the initial balance', () => {
    const w = open('1000.00');
    expect(w.version).toBe(1);
    expect(w.balance.amount).toBe('1000.00');
    expect(w.currency).toBe('BRL');
  });

  test('debit returns the matching ledger entry and bumps the version once', () => {
    const w = open();
    const entry = w.debit(move('30.00'));
    expect(w.balance.amount).toBe('70.00');
    expect(w.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.amount).toBe('100.00');
    expect(entry.balanceAfter.amount).toBe('70.00');
    expect(entry.walletVersion).toBe(2);
    expect(entry.isBalanced()).toBe(true);
  });

  test('credit returns the matching ledger entry', () => {
    const w = open();
    const entry = w.credit(move('5.50'));
    expect(w.balance.amount).toBe('105.50');
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.walletVersion).toBe(2);
  });

  test('never goes negative and leaves the wallet untouched when it refuses', () => {
    const w = open('10.00');
    expect(() => w.debit(move('10.01'))).toThrow(InsufficientFundsError);
    expect(w.balance.amount).toBe('10.00');
    expect(w.version).toBe(1);
  });

  test('can be drained to exactly zero', () => {
    const w = open('10.00');
    w.debit(move('10.00'));
    expect(w.balance.isZero()).toBe(true);
  });

  test('rejects operations in another currency', () => {
    const w = open();
    expect(() => w.credit({ ...move('1.00'), money: Money.from({ amount: '1.00', currency: 'USD' }) })).toThrow(
      CurrencyMismatchError,
    );
  });

  test('rejects non-positive movements', () => {
    const w = open();
    expect(() => w.credit(move('0.00'))).toThrow(InvalidWalletError);
    expect(() => w.debit(move('0.00'))).toThrow(InvalidWalletError);
  });

  test('version increments once per balance change', () => {
    const w = open();
    w.debit(move('1.00', 1));
    w.credit(move('1.00', 2));
    w.debit(move('1.00', 3));
    expect(w.version).toBe(4);
  });

  test('recordOpening credits from zero without bumping the version', () => {
    const w = open('50.00');
    const entry = w.recordOpening({ entryId: 'e0', transactionId: 't0', now });
    expect(entry.balanceBefore.amount).toBe('0.00');
    expect(entry.balanceAfter.amount).toBe('50.00');
    expect(entry.walletVersion).toBe(1);
    expect(w.version).toBe(1);
  });

  test('recordOpening is refused for zero-balance or already-used wallets', () => {
    expect(() => open('0.00').recordOpening({ entryId: 'e', transactionId: 't', now })).toThrow(InvalidWalletError);
    const used = open();
    used.credit(move('1.00'));
    expect(() => used.recordOpening({ entryId: 'e', transactionId: 't', now })).toThrow(InvalidWalletError);
  });

  test('rehydrate does not revalidate and keeps persisted state', () => {
    const w = Wallet.rehydrate({
      id: 'w9', playerId: 'p', currency: 'BRL', balance: brl('7.00'), version: 12, createdAt: now, updatedAt: now,
    });
    expect(w.version).toBe(12);
    expect(w.balance.amount).toBe('7.00');
  });
});
