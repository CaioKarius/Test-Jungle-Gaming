import { describe, expect, test } from 'bun:test';
import { IdempotencyConflictError, ValidationError, WalletNotFoundError, WalletAlreadyExistsError } from '../../src/application/errors';
import { FailureCode } from '../../src/wagering/domain/failure-code';
import { WagerTransactionStatus as S } from '../../src/wagering/domain/wager-transaction';
import { buildUnitHarness, openWallet, submitInput, POLICY, UnitHarness } from '../support/harness';

async function result(h: UnitHarness, walletId: string, o = {}) {
  const r = await h.submit.execute(submitInput(walletId, o));
  if (r.type !== 'RESULT') throw new Error('unexpected');
  return r;
}

/** wallet.balance == balance rebuilt from the ledger — the invariant every scenario must keep. */
async function expectConsistent(h: UnitHarness, walletId: string) {
  const rec = await h.queries.reconcile(walletId);
  expect(rec.consistent).toBe(true);
  return rec;
}

describe('idempotency', () => {
  test('replay returns the original result with idempotentReplay=true and no second debit', async () => {
    const h = buildUnitHarness(); const w = await openWallet(h);
    const first = await result(h, w.id);
    const again = await result(h, w.id);
    expect(first.idempotentReplay).toBe(false);
    expect(again.idempotentReplay).toBe(true);
    expect(again.transaction.id).toBe(first.transaction.id);
    expect(again.transaction.observedBalance?.amount).toBe('75.00');
    expect((await h.queries.getWallet(w.id)).balance.amount).toBe('75.00');
    expect(h.db.ledgerEntries(w.id).filter((e) => e.direction === 'DEBIT')).toHaveLength(1);
    await expectConsistent(h, w.id);
  });

  test('replay reports the balance observed back then, not the current one', async () => {
    const h = buildUnitHarness(); const w = await openWallet(h);
    await result(h, w.id);
    await result(h, w.id, { externalTransactionId: 'tx-2', amount: '10.00' });
    const replay = await result(h, w.id);
    expect(replay.transaction.observedBalance?.amount).toBe('75.00');
  });

  test('same key + different payload is a conflict, not a replay', async () => {
    const h = buildUnitHarness(); const w = await openWallet(h);
    await result(h, w.id);
    await expect(h.submit.execute(submitInput(w.id, { amount: '26.00' }))).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect((await h.queries.getWallet(w.id)).balance.amount).toBe('75.00');
  });

  test('same externalTransactionId under another key is a conflict', async () => {
    const h = buildUnitHarness(); const w = await openWallet(h);
    await result(h, w.id);
    await expect(h.submit.execute(submitInput(w.id, { idempotencyKey: 'another-key' }))).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  test('50 identical requests in parallel → exactly one debit', async () => {
    const h = buildUnitHarness(); const w = await openWallet(h);
    const rs = await Promise.all(Array.from({ length: 50 }, () => result(h, w.id)));
    expect(rs.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(h.db.ledgerEntries(w.id).filter((e) => e.direction === 'DEBIT')).toHaveLength(1);
    expect((await h.queries.getWallet(w.id)).balance.amount).toBe('75.00');
    await expectConsistent(h, w.id);
  });

  test('unknown wallet is not persisted; invalid payload is a ValidationError', async () => {
    const h = buildUnitHarness();
    await expect(h.submit.execute(submitInput('00000000-0000-7000-8000-00000000ffff'))).rejects.toBeInstanceOf(WalletNotFoundError);
    await expect(h.submit.execute({ idempotencyKey: 'k', data: { nope: true }, correlationId: 'c', source: 'http' })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('mandatory scenario: two bets of 80.00 on a 100.00 wallet', () => {
  test('one PROCESSED, one REJECTED, balance 20.00, a single debit entry', async () => {
    const h = buildUnitHarness(); const w = await openWallet(h);
    const [a, b] = await Promise.all([
      result(h, w.id, { externalTransactionId: 'a', amount: '80.00' }),
      result(h, w.id, { externalTransactionId: 'b', amount: '80.00' }),
    ]);
    const statuses = [a.transaction.status, b.transaction.status].sort();
    expect(statuses).toEqual([S.Processed, S.Rejected]);
    const rejected = [a, b].find((r) => r.transaction.status === S.Rejected)!;
    expect(rejected.transaction.failureCode).toBe(FailureCode.InsufficientFunds);
    expect((await h.queries.getWallet(w.id)).balance.amount).toBe('20.00');
    expect(h.db.ledgerEntries(w.id).filter((e) => e.direction === 'DEBIT')).toHaveLength(1);
    // retrying either one duplicates nothing
    await result(h, w.id, { externalTransactionId: 'a', amount: '80.00' });
    await result(h, w.id, { externalTransactionId: 'b', amount: '80.00' });
    expect(h.db.ledgerEntries(w.id).filter((e) => e.direction === 'DEBIT')).toHaveLength(1);
    await expectConsistent(h, w.id);
  });
});

describe('business flows', () => {
  test('BET → WIN → LOSS keeps ledger and balance consistent; LOSS has no entry', async () => {
    const h = buildUnitHarness(); const w = await openWallet(h);
    await result(h, w.id, { externalTransactionId: 'bet', amount: '20.00' });
    await result(h, w.id, { externalTransactionId: 'win', kind: 'WIN', amount: '50.00' });
    const loss = await result(h, w.id, { externalTransactionId: 'loss', kind: 'LOSS', amount: '20.00' });
    expect(loss.transaction.status).toBe(S.Processed);
    expect((await h.queries.getWallet(w.id)).balance.amount).toBe('130.00');
    expect(h.db.ledgerEntries(w.id)).toHaveLength(3); // opening, bet, win
    await expectConsistent(h, w.id);
  });

  test('REFUND reverts a BET once; a second reversal (REFUND or ROLLBACK) is rejected', async () => {
    const h = buildUnitHarness(); const w = await openWallet(h);
    await result(h, w.id, { externalTransactionId: 'bet' });
    const r1 = await result(h, w.id, { externalTransactionId: 'r1', kind: 'REFUND', referenceExternalTransactionId: 'bet' });
    const r2 = await result(h, w.id, { externalTransactionId: 'r2', kind: 'REFUND', referenceExternalTransactionId: 'bet' });
    const rb = await result(h, w.id, { externalTransactionId: 'rb', kind: 'ROLLBACK', referenceExternalTransactionId: 'bet' });
    expect(r1.transaction.status).toBe(S.Processed);
    expect(r2.transaction.failureCode).toBe(FailureCode.AlreadyReversed);
    expect(rb.transaction.failureCode).toBe(FailureCode.AlreadyReversed);
    expect((await h.queries.getWallet(w.id)).balance.amount).toBe('100.00');
    await expectConsistent(h, w.id);
  });

  test('rejections never create ledger entries', async () => {
    const h = buildUnitHarness(); const w = await openWallet(h, '10.00');
    const r = await result(h, w.id, { amount: '11.00' });
    expect(r.transaction.status).toBe(S.Rejected);
    expect(h.db.ledgerEntries(w.id)).toHaveLength(1); // opening only
  });

  test('currency conflict is rejected (model stays multi-currency)', async () => {
    const h = buildUnitHarness(); const w = await openWallet(h);
    const r = await result(h, w.id, { currency: 'USD' });
    expect(r.transaction.failureCode).toBe(FailureCode.CurrencyMismatch);
  });

  test('wallet: duplicate (player, currency) fails; zero opening writes no ledger', async () => {
    const h = buildUnitHarness();
    await openWallet(h, '0.00', 'solo');
    await expect(openWallet(h, '5.00', 'solo')).rejects.toBeInstanceOf(WalletAlreadyExistsError);
    const other = await openWallet(h, '0.00', 'solo2');
    expect(h.db.ledgerEntries(other.id)).toHaveLength(0);
  });
});

describe('out-of-order references', () => {
  test('REFUND before BET parks, then resolves once the BET arrives (woken immediately)', async () => {
    const h = buildUnitHarness(); const w = await openWallet(h);
    const early = await result(h, w.id, { externalTransactionId: 'r', kind: 'REFUND', referenceExternalTransactionId: 'bet' });
    expect(early.transaction.status).toBe(S.PendingReference);
    expect((await h.queries.getWallet(w.id)).balance.amount).toBe('100.00');

    await result(h, w.id, { externalTransactionId: 'bet' });
    expect(await h.pending.execute(10)).toBe(1);
    const final = await h.queries.getTransactionByExternalId('provider-a', 'r');
    expect(final.status).toBe(S.Processed);
    expect((await h.queries.getWallet(w.id)).balance.amount).toBe('100.00'); // -25 +25
    await expectConsistent(h, w.id);
  });

  test('replaying a parked transaction returns PENDING_REFERENCE, no duplicate', async () => {
    const h = buildUnitHarness(); const w = await openWallet(h);
    const o = { externalTransactionId: 'r', kind: 'ROLLBACK', referenceExternalTransactionId: 'bet' };
    await result(h, w.id, o);
    const again = await result(h, w.id, o);
    expect(again.idempotentReplay).toBe(true);
    expect(again.transaction.status).toBe(S.PendingReference);
  });

  test('backoff: not retried before due, rejected as REFERENCE_NOT_FOUND once attempts are exhausted', async () => {
    const h = buildUnitHarness(); const w = await openWallet(h);
    await result(h, w.id, { externalTransactionId: 'r', kind: 'REFUND', referenceExternalTransactionId: 'ghost' });
    expect(await h.pending.execute(10)).toBe(0); // not due yet
    for (let i = 0; i < POLICY.maxAttempts; i++) {
      h.clock.advance(POLICY.maxDelayMs + 1);
      await h.pending.execute(10);
    }
    const final = await h.queries.getTransactionByExternalId('provider-a', 'r');
    expect(final.status).toBe(S.Rejected);
    expect(final.failureCode).toBe(FailureCode.ReferenceNotFound);
    const types = h.db.outboxMessages().map((m) => m.eventType);
    expect(types.filter((t) => t === 'WagerTransactionRejected')).toHaveLength(1);
    expect(types.filter((t) => t === 'WagerTransactionPendingReference')).toHaveLength(1);
  });
});

describe('inbox (SQS deliveries)', () => {
  const inbox = { messageId: 'msg-1', consumerName: 'c', payloadHash: 'h' };
  test('a redelivered message is deduplicated by the inbox', async () => {
    const h = buildUnitHarness(); const w = await openWallet(h);
    const input = { ...submitInput(w.id), source: 'sqs' as const, inbox };
    expect((await h.submit.execute(input)).type).toBe('RESULT');
    expect((await h.submit.execute(input)).type).toBe('DUPLICATE_MESSAGE');
    expect((await h.queries.getWallet(w.id)).balance.amount).toBe('75.00');
  });
  test('a different message with the same idempotency key is a replay, not a second debit', async () => {
    const h = buildUnitHarness(); const w = await openWallet(h);
    await h.submit.execute({ ...submitInput(w.id), source: 'sqs', inbox });
    const r = await h.submit.execute({ ...submitInput(w.id), source: 'sqs', inbox: { ...inbox, messageId: 'msg-2' } });
    expect(r.type === 'RESULT' && r.idempotentReplay).toBe(true);
    expect((await h.queries.getWallet(w.id)).balance.amount).toBe('75.00');
  });
  test('a failing transaction rolls back the inbox row too (so a retry is processed)', async () => {
    const h = buildUnitHarness();
    const bad = { ...submitInput('00000000-0000-7000-8000-00000000ffff'), source: 'sqs' as const, inbox };
    await expect(h.submit.execute(bad)).rejects.toBeInstanceOf(WalletNotFoundError);
    expect(h.db.tables.inbox.size).toBe(0);
  });
});

describe('outbox events', () => {
  test('PROCESSED BET emits Processed + BalanceChanged; LOSS only Processed; REJECTED only Rejected', async () => {
    const h = buildUnitHarness(); const w = await openWallet(h, '10.00');
    const before = h.db.outboxMessages().length; // opening events
    await result(h, w.id, { externalTransactionId: 'bet', amount: '5.00' });
    await result(h, w.id, { externalTransactionId: 'loss', kind: 'LOSS', amount: '5.00' });
    await result(h, w.id, { externalTransactionId: 'big', amount: '500.00' });
    const types = h.db.outboxMessages().map((m) => m.eventType).slice(before);
    expect(types.sort()).toEqual([
      'WagerTransactionProcessed', 'WagerTransactionProcessed', 'WagerTransactionRejected', 'WalletBalanceChanged',
    ]);
  });
  test('payload carries money as plain strings and the event envelope', async () => {
    const h = buildUnitHarness(); const w = await openWallet(h, '10.00');
    const changed = h.db.outboxMessages().find((m) => m.eventType === 'WalletBalanceChanged')!;
    const p = changed.payload as any;
    expect(p.version).toBe(1);
    expect(p.data.balanceAfter).toEqual({ amount: '10.00', currency: 'BRL' });
    expect(typeof p.occurredAt).toBe('string');
    expect(changed.partitionKey).toBe(w.id);
  });
  test('publisher: publishes pending, retries with backoff on broker failure, never loses', async () => {
    const h = buildUnitHarness(); await openWallet(h, '10.00');
    h.setPublishFailing(true);
    expect(await h.publishOutbox.execute(50)).toBe(2);
    expect(h.published).toHaveLength(0);
    expect(await h.publishOutbox.execute(50)).toBe(0); // backing off
    h.clock.advance(5_000); h.setPublishFailing(false);
    expect(await h.publishOutbox.execute(50)).toBe(2);
    expect(h.published).toHaveLength(2);
    expect(await h.publishOutbox.execute(50)).toBe(0);
  });
});

describe('atomicity & reconciliation', () => {
  test('an error after partial writes rolls everything back', async () => {
    const h = buildUnitHarness(); const w = await openWallet(h);
    const before = h.db.outboxMessages().length;
    await expect(
      h.db.unitOfWork.run(async (repos) => {
        const wallet = (await repos.wallets.findByIdForUpdate(w.id))!;
        const v = wallet.version;
        const entry = wallet.debit({ entryId: 'e', transactionId: 't', money: (await repos.wallets.findById(w.id))!.balance, now: new Date() });
        await repos.wallets.update(wallet, v);
        await repos.ledger.insert(entry);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect((await h.queries.getWallet(w.id)).balance.amount).toBe('100.00');
    expect(h.db.outboxMessages().length).toBe(before);
    await expectConsistent(h, w.id);
  });

  test('reconciliation flags (does not fix) divergence', async () => {
    const h = buildUnitHarness(); const w = await openWallet(h);
    const s = h.db.tables.wallets.get(w.id)!;
    h.db.tables.wallets.set(w.id, { ...s, balance: s.balance.add(s.balance) }); // corrupt on purpose
    const rec = await h.queries.reconcile(w.id);
    expect(rec.consistent).toBe(false);
    expect(rec.difference.amount).toBe('100.00');
    expect(rec.checkedEntries).toBe(1);
    expect((await h.queries.getWallet(w.id)).balance.amount).toBe('200.00'); // untouched
  });

  test('ledger pagination: opaque cursor, newest first, no overlap', async () => {
    const h = buildUnitHarness(); const w = await openWallet(h, '1000.00');
    for (let i = 0; i < 5; i++) await result(h, w.id, { externalTransactionId: `b${i}`, amount: '1.00' });
    const p1 = await h.queries.getLedger(w.id, undefined, '4');
    const p2 = await h.queries.getLedger(w.id, p1.nextCursor!, '4');
    expect(p1.items).toHaveLength(4); expect(p2.items).toHaveLength(2); expect(p2.nextCursor).toBeNull();
    const ids = [...p1.items, ...p2.items].map((e) => e.id);
    expect(new Set(ids).size).toBe(6);
    await expect(h.queries.getLedger(w.id, '!!bad', undefined)).rejects.toBeInstanceOf(ValidationError);
  });
});
