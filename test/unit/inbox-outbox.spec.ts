import { describe, expect, test } from 'bun:test';
import { InvalidInboxStateError, InvalidOutboxStateError } from '../../src/shared/domain/errors';
import { InboxMessage } from '../../src/messaging/domain/inbox-message';
import { OutboxMessage } from '../../src/messaging/domain/outbox-message';
import { WalletBalanceChanged } from '../../src/messaging/domain/events';
import { Money } from '../../src/shared/domain/money';
import { Wallet } from '../../src/wallet/domain/wallet';

const t0 = new Date('2026-08-01T00:00:00Z');

describe('InboxMessage', () => {
  test('receive → markProcessed once', () => {
    const m = InboxMessage.receive({ messageId: 'm', consumerName: 'c', payloadHash: 'h', receivedAt: t0 });
    expect(m.isProcessed()).toBe(false);
    m.markProcessed(t0);
    expect(m.isProcessed()).toBe(true);
    expect(() => m.markProcessed(t0)).toThrow(InvalidInboxStateError);
  });
});

describe('OutboxMessage', () => {
  const wallet = Wallet.open({ id: 'w', playerId: 'p', initialBalance: Money.from({ amount: '10.00', currency: 'BRL' }), now: t0 });
  const entry = wallet.credit({ entryId: 'e', transactionId: 't', money: Money.from({ amount: '1.00', currency: 'BRL' }), now: t0 });
  const event = WalletBalanceChanged.from(wallet, entry, { eventId: 'ev1', correlationId: 'c', occurredAt: t0 });

  test('enqueue serialises the envelope (type and version live in the event class)', () => {
    const m = OutboxMessage.enqueue(event);
    expect(m.id).toBe('ev1');
    expect(m.eventType).toBe('WalletBalanceChanged');
    expect((m.payload as any).version).toBe(1);
    expect((m.payload as any).data.money).toEqual({ amount: '1.00', currency: 'BRL' });
    expect(m.isPending()).toBe(true);
    expect(m.isDue(t0)).toBe(true);
  });
  test('scheduleRetry increments attempts and backs off exponentially (capped)', () => {
    const m = OutboxMessage.enqueue(event);
    m.scheduleRetry(t0); expect(m.attempts).toBe(1); expect(m.nextAttemptAt!.getTime() - t0.getTime()).toBe(1000);
    m.scheduleRetry(t0); expect(m.nextAttemptAt!.getTime() - t0.getTime()).toBe(2000);
    expect(m.isDue(t0)).toBe(false);
    for (let i = 0; i < 20; i++) m.scheduleRetry(t0);
    expect(m.nextAttemptAt!.getTime() - t0.getTime()).toBe(60_000);
  });
  test('published messages are final', () => {
    const m = OutboxMessage.enqueue(event);
    m.markPublished(t0);
    expect(m.isPending()).toBe(false);
    expect(m.isDue(t0)).toBe(false);
    expect(() => m.markPublished(t0)).toThrow(InvalidOutboxStateError);
    expect(() => m.scheduleRetry(t0)).toThrow(InvalidOutboxStateError);
  });
});
