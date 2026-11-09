import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PublishOutboxUseCase } from '../../src/application/publish-outbox.use-case';
import { UnitOfWork, noopLogger, noopMetrics } from '../../src/application/ports';
import { SubmitWagerTransactionUseCase } from '../../src/application/submit-wager-transaction.use-case';
import { CreateWalletUseCase } from '../../src/application/create-wallet.use-case';
import { SqsEventPublisher } from '../../src/infrastructure/sqs/sqs-event-publisher';
import { UNIT_OF_WORK } from '../../src/tokens';
import { TestEnv, createTestEnv, drainQueue, eventually, queueDepth, sqlOne } from './support/env';
import { sqsData, startInProcess } from './support/app';

let env: TestEnv;
beforeAll(async () => { env = await createTestEnv(); });
afterAll(async () => { await env.cleanup(); });

const pending = async () => Number((await sqlOne<{ n: string }>(env, `SELECT count(*)::text n FROM outbox_messages WHERE published_at IS NULL`)).n);
const total = async () => Number((await sqlOne<{ n: string }>(env, `SELECT count(*)::text n FROM outbox_messages`)).n);

async function produceEvents(inst: Awaited<ReturnType<typeof startInProcess>>, player: string, bets: number) {
  const create = inst.app.get(CreateWalletUseCase);
  const submit = inst.app.get(SubmitWagerTransactionUseCase);
  const wallet = await create.execute({ playerId: player, initialBalance: { amount: '1000.00', currency: 'BRL' }, correlationId: 'c' });
  for (let i = 0; i < bets; i++) {
    const data = sqsData({ externalTransactionId: `${player}-${i}`, playerId: player, walletId: wallet.id });
    await submit.execute({ idempotencyKey: data.idempotencyKey, data, correlationId: 'c', source: 'http' });
  }
  return wallet.id;
}

describe('transactional outbox', () => {
  test('events are published only after commit, with a stable envelope and the FIFO ordering key', async () => {
    const inst = await startInProcess(env, { publisher: true });
    try {
      const walletId = await produceEvents(inst, 'ob-1', 2);
      await eventually(async () => (await pending()) === 0);
      const messages = await drainQueue(env, env.queues.events);
      const parsed = messages.map((m) => JSON.parse(m.body));
      const types = parsed.map((e) => e.eventType);
      expect(types).toContain('WagerTransactionProcessed');
      expect(types).toContain('WalletBalanceChanged');
      for (const e of parsed) {
        expect(typeof e.eventId).toBe('string');
        expect(e.version).toBe(1);
        expect(typeof e.occurredAt).toBe('string');
      }
      const changed = parsed.filter((e) => e.eventType === 'WalletBalanceChanged' && e.data.walletId === walletId);
      expect(changed.map((e) => e.data.walletVersion).sort()).toEqual([1, 2, 3]);
      expect(typeof changed[0].data.balanceAfter.amount).toBe('string');
    } finally {
      await inst.close();
    }
  });

  test('commit, then the process dies before publishing: nothing was sent, and ANOTHER instance publishes everything', async () => {
    const writer = await startInProcess(env, {}); // no publisher role: "dies" right after commit
    await produceEvents(writer, 'ob-2', 5);
    const written = await pending();
    expect(written).toBeGreaterThan(0);
    await writer.close();
    expect(await queueDepth(env, env.queues.events)).toBe(0);

    // Two publisher instances race for the same backlog.
    const a = await startInProcess(env, { publisher: true });
    const b = await startInProcess(env, { publisher: true });
    try {
      await eventually(async () => (await pending()) === 0);
      const messages = await drainQueue(env, env.queues.events, 8);
      const ids = messages.map((m) => JSON.parse(m.body).eventId as string);
      const rows = await env.pool.query(`SELECT id FROM outbox_messages`);
      // at-least-once: every outbox row reached the broker (duplicates would be fine; none lost)
      expect(new Set(ids).size).toBe(rows.rows.length);
      expect(ids.length).toBeGreaterThanOrEqual(rows.rows.length);
    } finally {
      await a.close();
      await b.close();
    }
  });

  test('SKIP LOCKED: concurrent publishers claim disjoint batches', async () => {
    const inst = await startInProcess(env, {});
    try {
      await produceEvents(inst, 'ob-3', 10);
      const uow = inst.app.get(UNIT_OF_WORK) as UnitOfWork;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let claimedByFirst: string[] = [];
      let claimedBySecond: string[] = [];

      const first = uow.run(async (repos) => {
        claimedByFirst = (await repos.outbox.claimDue(new Date(Date.now() + 1000), 5)).map((m) => m.id);
        await gate; // keep the row locks while the second publisher claims
      });
      await eventually(async () => claimedByFirst.length > 0);
      await uow.run(async (repos) => {
        claimedBySecond = (await repos.outbox.claimDue(new Date(Date.now() + 1000), 5)).map((m) => m.id);
      });
      release();
      await first;

      expect(claimedByFirst).toHaveLength(5);
      expect(claimedBySecond.length).toBeGreaterThan(0);
      expect(claimedBySecond.filter((id) => claimedByFirst.includes(id))).toHaveLength(0);
    } finally {
      await inst.close();
    }
  });

  test('broker failures are retried with backoff and nothing is dropped', async () => {
    const inst = await startInProcess(env, {});
    try {
      await produceEvents(inst, 'ob-4', 1);
      const uow = inst.app.get(UNIT_OF_WORK) as UnitOfWork;
      const real = new SqsEventPublisher(env.sqs, env.names.events);
      let failing = true;
      const useCase = new PublishOutboxUseCase(
        uow,
        { publish: async (m) => { if (failing) throw new Error('broker down'); await real.publish(m); } },
        { now: () => new Date() }, noopMetrics, noopLogger,
      );
      const before = await pending();
      await useCase.execute(100);
      expect(await pending()).toBe(before); // nothing lost, still pending
      const attempts = await sqlOne<{ max: number }>(env, `SELECT max(attempts) AS max FROM outbox_messages WHERE published_at IS NULL`);
      expect(attempts.max).toBeGreaterThanOrEqual(1);
      failing = false;
      await eventually(async () => { await useCase.execute(100); return (await pending()) === 0; }, 15_000, 500);
      expect(await total()).toBeGreaterThan(0);
    } finally {
      await inst.close();
    }
  });
});
