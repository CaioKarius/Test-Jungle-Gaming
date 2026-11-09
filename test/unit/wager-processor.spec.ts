import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/shared/domain/money';
import { FailureCode } from '../../src/wagering/domain/failure-code';
import { ProcessInput, WagerProcessor } from '../../src/wagering/domain/wager-processor';
import { WagerTransaction, WagerTransactionKind as K, WagerTransactionStatus as S } from '../../src/wagering/domain/wager-transaction';
import { Wallet } from '../../src/wallet/domain/wallet';

const brl = (a: string) => Money.from({ amount: a, currency: 'BRL' });
const at = new Date('2026-08-01T00:00:00Z');
const processor = new WagerProcessor();
let n = 0;

function tx(kind: K, o: { amount?: string; ref?: string; ext?: string; wallet?: string; player?: string; round?: string; currency?: string } = {}) {
  n += 1;
  return WagerTransaction.create({
    id: `t${n}`, providerId: 'p', externalTransactionId: o.ext ?? `x${n}`, idempotencyKey: `k${n}`, payloadHash: 'h',
    walletId: o.wallet ?? 'w', playerId: o.player ?? 'pl', roundId: o.round ?? 'r', gameId: 'g', kind,
    money: Money.from({ amount: o.amount ?? '10.00', currency: o.currency ?? 'BRL' }),
    referenceExternalTransactionId: o.ref, createdAt: at,
  });
}
function processed(kind: K, o: Parameters<typeof tx>[1] = {}) {
  const t = tx(kind, o);
  t.observeBalance(brl('0.00'));
  t.markProcessed(undefined, at);
  return t;
}
function run(wallet: Wallet, transaction: WagerTransaction, extra: Partial<ProcessInput> = {}) {
  return processor.process({
    wallet, transaction, reference: null, referenceAlreadyReversed: false, now: at, entryId: 'e1',
    pending: { nextRetryAt: new Date(at.getTime() + 1000), exhausted: false }, ...extra,
  });
}
const wallet = (b = '100.00') => Wallet.open({ id: 'w', playerId: 'pl', initialBalance: brl(b), now: at });

describe('BET / WIN / LOSS', () => {
  test('BET debits with one ledger entry', () => {
    const w = wallet(); const t = tx(K.Bet, { amount: '30.00' });
    const o = run(w, t);
    expect(o.type).toBe('PROCESSED');
    expect(w.balance.amount).toBe('70.00');
    expect(t.status).toBe(S.Processed);
    expect(t.observedBalance?.amount).toBe('70.00');
  });
  test('BET with insufficient funds is REJECTED and moves nothing', () => {
    const w = wallet('10.00'); const t = tx(K.Bet, { amount: '10.01' });
    expect(run(w, t)).toEqual({ type: 'REJECTED', failureCode: FailureCode.InsufficientFunds });
    expect(w.balance.amount).toBe('10.00'); expect(w.version).toBe(1);
  });
  test('WIN credits', () => {
    const w = wallet(); run(w, tx(K.Win, { amount: '5.00' }));
    expect(w.balance.amount).toBe('105.00');
  });
  test('LOSS records the result without ledger entry or balance change', () => {
    const w = wallet(); const o = run(w, tx(K.Loss));
    expect(o).toEqual({ type: 'PROCESSED', ledgerEntry: null });
    expect(w.balance.amount).toBe('100.00'); expect(w.version).toBe(1);
  });
  test('currency / player mismatch are rejected', () => {
    expect(run(wallet(), tx(K.Bet, { currency: 'USD' }))).toEqual({ type: 'REJECTED', failureCode: FailureCode.CurrencyMismatch });
    expect(run(wallet(), tx(K.Bet, { player: 'other' }))).toEqual({ type: 'REJECTED', failureCode: FailureCode.PlayerMismatch });
  });
});

describe('REFUND', () => {
  test('credits when reverting a processed BET', () => {
    const w = wallet(); const bet = processed(K.Bet);
    const o = run(w, tx(K.Refund, { ref: bet.externalTransactionId }), { reference: bet });
    expect(o.type).toBe('PROCESSED'); expect(w.balance.amount).toBe('110.00');
  });
  test('missing reference → PENDING_REFERENCE with retry time', () => {
    const w = wallet(); const t = tx(K.Refund, { ref: 'ghost' });
    expect(run(w, t)).toEqual({ type: 'PENDING_REFERENCE' });
    expect(t.status).toBe(S.PendingReference);
    expect(t.nextRetryAt?.getTime()).toBe(at.getTime() + 1000);
  });
  test('missing reference with exhausted budget → REJECTED REFERENCE_NOT_FOUND', () => {
    const t = tx(K.Refund, { ref: 'ghost' });
    expect(run(wallet(), t, { pending: { nextRetryAt: at, exhausted: true } })).toEqual({ type: 'REJECTED', failureCode: FailureCode.ReferenceNotFound });
  });
  test('only BET can be refunded', () => {
    const win = processed(K.Win);
    expect(run(wallet(), tx(K.Refund, { ref: win.externalTransactionId }), { reference: win })).toEqual({ type: 'REJECTED', failureCode: FailureCode.InvalidReferenceKind });
  });
  test('amount must equal the reference', () => {
    const bet = processed(K.Bet, { amount: '10.00' });
    expect(run(wallet(), tx(K.Refund, { ref: bet.externalTransactionId, amount: '9.00' }), { reference: bet })).toEqual({ type: 'REJECTED', failureCode: FailureCode.ReferenceAmountMismatch });
  });
  test('cannot be reverted twice', () => {
    const bet = processed(K.Bet);
    expect(run(wallet(), tx(K.Refund, { ref: bet.externalTransactionId }), { reference: bet, referenceAlreadyReversed: true })).toEqual({ type: 'REJECTED', failureCode: FailureCode.AlreadyReversed });
  });
  test('reference must share provider/player/wallet/currency/round', () => {
    const bet = processed(K.Bet, { round: 'other-round' });
    expect(run(wallet(), tx(K.Refund, { ref: bet.externalTransactionId }), { reference: bet })).toEqual({ type: 'REJECTED', failureCode: FailureCode.ReferenceContextMismatch });
  });
  test('rejected reference ⇒ REFERENCE_NOT_PROCESSED', () => {
    const bet = tx(K.Bet); bet.observeBalance(brl('0.00')); bet.reject(FailureCode.InsufficientFunds);
    expect(run(wallet(), tx(K.Refund, { ref: bet.externalTransactionId }), { reference: bet })).toEqual({ type: 'REJECTED', failureCode: FailureCode.ReferenceNotProcessed });
  });
});

describe('ROLLBACK', () => {
  test('of a BET credits; of a WIN debits; of a REFUND debits', () => {
    const bet = processed(K.Bet); const win = processed(K.Win); const refund = processed(K.Refund, { ref: 'b' });
    const w1 = wallet(); run(w1, tx(K.Rollback, { ref: bet.externalTransactionId }), { reference: bet });
    expect(w1.balance.amount).toBe('110.00');
    const w2 = wallet(); run(w2, tx(K.Rollback, { ref: win.externalTransactionId }), { reference: win });
    expect(w2.balance.amount).toBe('90.00');
    const w3 = wallet(); run(w3, tx(K.Rollback, { ref: refund.externalTransactionId }), { reference: refund });
    expect(w3.balance.amount).toBe('90.00');
  });
  test('reversal that would go negative is REJECTED with a distinct code', () => {
    const win = processed(K.Win, { amount: '50.00' });
    const w = wallet('10.00');
    expect(run(w, tx(K.Rollback, { ref: win.externalTransactionId, amount: '50.00' }), { reference: win })).toEqual({ type: 'REJECTED', failureCode: FailureCode.ReversalInsufficientFunds });
    expect(w.balance.amount).toBe('10.00');
    expect(FailureCode.ReversalInsufficientFunds).not.toBe(FailureCode.InsufficientFunds);
  });
  test('LOSS cannot be rolled back', () => {
    const loss = processed(K.Loss);
    expect(run(wallet(), tx(K.Rollback, { ref: loss.externalTransactionId }), { reference: loss })).toEqual({ type: 'REJECTED', failureCode: FailureCode.InvalidReferenceKind });
  });
});
