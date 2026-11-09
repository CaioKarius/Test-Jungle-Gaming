import { describe, expect, test } from 'bun:test';
import { InvalidTransactionStateError, InvalidWagerTransactionError } from '../../src/shared/domain/errors';
import { Money } from '../../src/shared/domain/money';
import { FailureCode } from '../../src/wagering/domain/failure-code';
import {
  CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind as K,
  WagerTransactionStatus as S,
} from '../../src/wagering/domain/wager-transaction';
import { LedgerDirection } from '../../src/wallet/domain/ledger-direction';

const props = (o: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps => ({
  id: 't1', providerId: 'p', externalTransactionId: 'x1', idempotencyKey: 'p:x1', payloadHash: 'h',
  walletId: 'w', playerId: 'pl', roundId: 'r', gameId: 'g', kind: K.Bet,
  money: Money.from({ amount: '10.00', currency: 'BRL' }), createdAt: new Date(0), ...o,
});
const now = new Date(1);

describe('WagerTransaction.create', () => {
  test('is born PENDING', () => {
    expect(WagerTransaction.create(props()).status).toBe(S.Pending);
  });
  test('REFUND and ROLLBACK require a reference', () => {
    expect(() => WagerTransaction.create(props({ kind: K.Refund }))).toThrow(InvalidWagerTransactionError);
    expect(() => WagerTransaction.create(props({ kind: K.Rollback }))).toThrow(InvalidWagerTransactionError);
    expect(WagerTransaction.create(props({ kind: K.Refund, referenceExternalTransactionId: 'b' })).requiresReference()).toBe(true);
  });
  test('BET cannot carry a reference; nothing can reference itself', () => {
    expect(() => WagerTransaction.create(props({ referenceExternalTransactionId: 'b' }))).toThrow(InvalidWagerTransactionError);
    expect(() => WagerTransaction.create(props({ kind: K.Win, referenceExternalTransactionId: 'x1' }))).toThrow(InvalidWagerTransactionError);
  });
  test('amount must be positive', () => {
    expect(() => WagerTransaction.create(props({ money: Money.zero('BRL') }))).toThrow(InvalidWagerTransactionError);
  });
  test('LOSS does not affect balance, others do', () => {
    expect(WagerTransaction.create(props({ kind: K.Loss })).affectsBalance()).toBe(false);
    expect(WagerTransaction.create(props()).affectsBalance()).toBe(true);
  });
});

describe('WagerTransaction transitions', () => {
  test('PENDING → PROCESSED records reference and time', () => {
    const t = WagerTransaction.create(props());
    t.markProcessed('ref', now);
    expect(t.status).toBe(S.Processed);
    expect(t.referenceTransactionId).toBe('ref');
    expect(t.processedAt).toBe(now);
    expect(t.isTerminal()).toBe(true);
  });
  test('PENDING → PENDING_REFERENCE → PENDING_REFERENCE counts attempts → REJECTED', () => {
    const t = WagerTransaction.create(props({ kind: K.Refund, referenceExternalTransactionId: 'b' }));
    t.markPendingReference(now);
    expect(t.referenceAttempts).toBe(0);
    t.markPendingReference(now);
    expect(t.referenceAttempts).toBe(1);
    t.reject(FailureCode.ReferenceNotFound);
    expect(t.status).toBe(S.Rejected);
    expect(t.failureCode).toBe(FailureCode.ReferenceNotFound);
  });
  test.each([
    ['processed', (t: WagerTransaction) => t.markProcessed(undefined, now)],
    ['rejected', (t: WagerTransaction) => t.reject(FailureCode.InsufficientFunds)],
    ['failed', (t: WagerTransaction) => t.fail(FailureCode.InfrastructureFailure)],
  ])('terminal state (%s) cannot transition again', (_n, toTerminal) => {
    const t = WagerTransaction.create(props());
    toTerminal(t);
    expect(() => t.markProcessed(undefined, now)).toThrow(InvalidTransactionStateError);
    expect(() => t.reject(FailureCode.InsufficientFunds)).toThrow(InvalidTransactionStateError);
    expect(() => t.fail(FailureCode.InfrastructureFailure)).toThrow(InvalidTransactionStateError);
    expect(() => t.markPendingReference(now)).toThrow(InvalidTransactionStateError);
  });
});

describe('WagerTransaction.matchesPayload / ledgerDirectionFor', () => {
  test('matchesPayload compares the stored hash', () => {
    const t = WagerTransaction.create(props());
    expect(t.matchesPayload('h')).toBe(true);
    expect(t.matchesPayload('other')).toBe(false);
  });
  test('directions', () => {
    const bet = WagerTransaction.create(props());
    const win = WagerTransaction.create(props({ kind: K.Win }));
    const refund = WagerTransaction.create(props({ kind: K.Refund, referenceExternalTransactionId: 'b' }));
    const rb = WagerTransaction.create(props({ kind: K.Rollback, referenceExternalTransactionId: 'b' }));
    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(refund.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(rb.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rb.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(rb.ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
    expect(() => rb.ledgerDirectionFor()).toThrow(InvalidWagerTransactionError);
    expect(() => WagerTransaction.create(props({ kind: K.Loss })).ledgerDirectionFor()).toThrow(InvalidWagerTransactionError);
  });
});
