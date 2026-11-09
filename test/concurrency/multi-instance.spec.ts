import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import {
  ChildInstance, allocatePort, createWallet, http, sqsData, submit,
} from '../integration/support/app';
import {
  TestEnv, assertAllWalletsConsistent, createTestEnv, drainQueue, eventually, queueDepth, sendWagerMessage, sleep, sqlOne,
} from '../integration/support/env';

/**
 * REAL multi-process concurrency: 3 independent OS processes (each running HTTP + SQS consumer +
 * outbox publisher + pending-reference worker) share one PostgreSQL and one set of SQS queues.
 */
let env: TestEnv;
let instances: ChildInstance[] = [];
const urls = () => instances.map((i) => i.baseUrl);
const pick = (n: number) => urls()[n % instances.length] as string;

beforeAll(async () => {
  env = await createTestEnv();
  instances = await Promise.all([0, 1, 2].map((n) => new ChildInstance(env, allocatePort() + n * 7).start()));
}, 180_000);

afterAll(async () => {
  await Promise.all(instances.map((i) => i.terminate().catch(() => undefined)));
  await env.cleanup();
});

const wallet = async (player: string, amount = '100.00') => (await createWallet(pick(0), player, amount)).body.id as string;
const balance = async (id: string) => (await http(pick(1), 'GET', `/wallets/${id}`)).body.balance.amount as string;
const ledgerCount = async (id: string, dir: string) =>
  Number((await sqlOne<{ n: string }>(env, `SELECT count(*)::text n FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = $2`, [id, dir])).n);

describe('idempotency under concurrency', () => {
  test('50 identical requests spread over 3 instances → exactly one debit, one transaction', async () => {
    const walletId = await wallet('c-1');
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => submit(pick(i), { externalTransactionId: 'same-tx', playerId: 'c-1', walletId, amount: '25.00' })),
    );
    expect(results.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    expect(results.filter((r) => r.body.idempotentReplay === false)).toHaveLength(1);
    expect(results.every((r) => r.body.balance.amount === '75.00')).toBe(true);
    expect(await balance(walletId)).toBe('75.00');
    expect(await ledgerCount(walletId, 'DEBIT')).toBe(1);
  });

  test('same key with a different payload is 409 and changes nothing', async () => {
    const walletId = await wallet('c-2');
    await submit(pick(0), { externalTransactionId: 'k', playerId: 'c-2', walletId, amount: '10.00' });
    const r = await submit(pick(1), { externalTransactionId: 'k', playerId: 'c-2', walletId, amount: '11.00' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await balance(walletId)).toBe('90.00');
  });
});

describe('contention on one wallet', () => {
  test('mandatory scenario: two concurrent bets of 80.00 on a 100.00 wallet', async () => {
    const walletId = await wallet('c-3');
    const [a, b] = await Promise.all([
      submit(pick(0), { externalTransactionId: 'a', playerId: 'c-3', walletId, amount: '80.00' }),
      submit(pick(1), { externalTransactionId: 'b', playerId: 'c-3', walletId, amount: '80.00' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 422]);
    const rejected = a.status === 422 ? a : b;
    expect(rejected.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', providerAction: 'RESEND_AS_NEW_TRANSACTION' });
    expect(await balance(walletId)).toBe('20.00');
    expect(await ledgerCount(walletId, 'DEBIT')).toBe(1);
    // retrying either is a replay: still one debit
    await submit(pick(2), { externalTransactionId: 'a', playerId: 'c-3', walletId, amount: '80.00' });
    await submit(pick(2), { externalTransactionId: 'b', playerId: 'c-3', walletId, amount: '80.00' });
    expect(await ledgerCount(walletId, 'DEBIT')).toBe(1);
  });

  test('hot wallet: 120 distinct 1.00 bets on 100.00 → exactly 100 processed, 20 rejected, balance 0.00, never negative', async () => {
    const walletId = await wallet('c-4');
    const results = await Promise.all(
      Array.from({ length: 120 }, (_, i) => submit(pick(i), { externalTransactionId: `hot-${i}`, playerId: 'c-4', walletId, amount: '1.00' })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(100);
    expect(results.filter((r) => r.status === 422)).toHaveLength(20);
    expect(await balance(walletId)).toBe('0.00');
    expect(await ledgerCount(walletId, 'DEBIT')).toBe(100);
    const versions = await env.pool.query(`SELECT wallet_version FROM wallet_ledger_entries WHERE wallet_id = $1 ORDER BY wallet_version`, [walletId]);
    expect(versions.rows.map((r) => r.wallet_version)).toEqual(Array.from({ length: 101 }, (_, i) => i + 1)); // gap-free, no duplicates
  });

  test('independent wallets progress in parallel and every one stays consistent', async () => {
    const ids = await Promise.all(Array.from({ length: 30 }, (_, i) => wallet(`par-${i}`, '50.00')));
    await Promise.all(
      ids.flatMap((walletId, w) =>
        Array.from({ length: 5 }, (_, i) => submit(pick(w + i), { externalTransactionId: `par-${w}-${i}`, playerId: `par-${w}`, walletId, amount: '2.00' })),
      ),
    );
    for (const id of ids) expect(await balance(id)).toBe('40.00');
    await assertAllWalletsConsistent(env);
  });
});

describe('HTTP and SQS racing on the same wallet', () => {
  test('30 HTTP bets + 30 SQS bets (each SQS one delivered twice) → 60 debits, balance 40.00', async () => {
    const walletId = await wallet('c-5');
    const http$ = Array.from({ length: 30 }, (_, i) => submit(pick(i), { externalTransactionId: `h-${i}`, playerId: 'c-5', walletId, amount: '1.00' }));
    const sqs$ = Array.from({ length: 30 }, async (_, i) => {
      const data = sqsData({ externalTransactionId: `s-${i}`, playerId: 'c-5', walletId, amount: '1.00' });
      await sendWagerMessage(env, data);
      await sendWagerMessage(env, data); // duplicate delivery of the same operation
    });
    await Promise.all([...http$, ...sqs$]);
    await eventually(async () => (await balance(walletId)) === '40.00', 60_000);
    await eventually(async () => (await queueDepth(env, env.queues.transactions)) === 0, 60_000);
    expect(await ledgerCount(walletId, 'DEBIT')).toBe(60);
    expect(await balance(walletId)).toBe('40.00');
    await assertAllWalletsConsistent(env);
  });
});

describe('out-of-order references', () => {
  test('REFUND and ROLLBACK that arrive before their BET are parked, then applied exactly once', async () => {
    const walletId = await wallet('c-6');
    const refund = await submit(pick(0), { externalTransactionId: 'r1', kind: 'REFUND', playerId: 'c-6', walletId, amount: '10.00', referenceExternalTransactionId: 'bet-late' });
    expect(refund.status).toBe(202);
    expect(refund.body.status).toBe('PENDING_REFERENCE');
    expect(await balance(walletId)).toBe('100.00');

    await submit(pick(1), { externalTransactionId: 'bet-late', playerId: 'c-6', walletId, amount: '10.00' });
    await eventually(async () => (await http(pick(2), 'GET', `/providers/provider-a/wagering/transactions/r1`)).body.status === 'PROCESSED', 30_000);
    expect(await balance(walletId)).toBe('100.00'); // -10 +10
    // a ROLLBACK of the same BET afterwards is rejected: it was already reverted
    const rb = await submit(pick(0), { externalTransactionId: 'rb1', kind: 'ROLLBACK', playerId: 'c-6', walletId, amount: '10.00', referenceExternalTransactionId: 'bet-late' });
    expect(rb.status).toBe(422);
    expect(rb.body.failureCode).toBe('ALREADY_REVERSED');
    expect(await ledgerCount(walletId, 'CREDIT')).toBe(2); // opening + refund
  });

  test('a reference that never arrives is eventually REJECTED with REFERENCE_NOT_FOUND', async () => {
    const walletId = await wallet('c-7');
    await submit(pick(0), { externalTransactionId: 'orphan', kind: 'REFUND', playerId: 'c-7', walletId, amount: '5.00', referenceExternalTransactionId: 'never' });
    await eventually(async () => (await http(pick(0), 'GET', `/providers/provider-a/wagering/transactions/orphan`)).body.failureCode === 'REFERENCE_NOT_FOUND', 60_000);
    expect(await balance(walletId)).toBe('100.00');
  });
});

describe('failures and recovery', () => {
  test('SIGKILL of an instance mid-load: the others finish the job, no duplicate or lost debit', async () => {
    const walletId = await wallet('c-8', '500.00');
    const sends = Array.from({ length: 100 }, async (_, i) => {
      await sendWagerMessage(env, sqsData({ externalTransactionId: `k-${i}`, playerId: 'c-8', walletId, amount: '1.00' }), { groupId: `${walletId}-${i % 10}` });
    });
    await Promise.all(sends);
    await sleep(400);
    await instances[0]!.kill(); // dies without acking / draining
    const calls = Array.from({ length: 50 }, (_, i) => submit(pick(1 + (i % 2)), { externalTransactionId: `kh-${i}`, playerId: 'c-8', walletId, amount: '1.00' }));
    await Promise.all(calls);

    await eventually(async () => (await balance(walletId)) === '350.00', 90_000);
    await eventually(async () => (await queueDepth(env, env.queues.transactions)) === 0, 90_000);
    expect(await ledgerCount(walletId, 'DEBIT')).toBe(150);
    await assertAllWalletsConsistent(env);

    instances[0] = await new ChildInstance(env, allocatePort()).start(); // replacement joins
  }, 180_000);

  test('SIGTERM is graceful: the process drains and exits with code 0', async () => {
    const extra = await new ChildInstance(env, allocatePort()).start();
    const walletId = await wallet('c-9');
    await submit(extra.baseUrl, { externalTransactionId: 'g1', playerId: 'c-9', walletId, amount: '1.00' });
    expect(await extra.terminate()).toBe(0);
  });

  test('outbox: every event of the whole run reached the events queue (3 competing publishers, at-least-once)', async () => {
    await eventually(async () => Number((await sqlOne<{ n: string }>(env, `SELECT count(*)::text n FROM outbox_messages WHERE published_at IS NULL`)).n) === 0, 90_000);
    const rows = await env.pool.query(`SELECT id FROM outbox_messages`);
    const seen = new Set<string>();
    for (let i = 0; i < 400 && seen.size < rows.rows.length; i++) {
      const batch = await drainQueue(env, env.queues.events, 1);
      if (batch.length === 0 && i > 5) break;
      for (const m of batch) seen.add(JSON.parse(m.body).eventId);
    }
    expect(seen.size).toBe(rows.rows.length);
  }, 180_000);

  test('final invariant over the whole run: every wallet equals its ledger and none is negative', async () => {
    expect(await assertAllWalletsConsistent(env)).toBeGreaterThan(40);
    expect(SendMessageCommand).toBeTruthy();
  });
});
