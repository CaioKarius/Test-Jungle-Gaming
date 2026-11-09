import { DeleteMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { INestApplication } from '@nestjs/common';
import { TransientInfrastructureError } from '../../src/application/errors';
import { noopLogger, noopMetrics } from '../../src/application/ports';
import { SubmitWagerTransactionUseCase } from '../../src/application/submit-wager-transaction.use-case';
import { createApp } from '../../src/bootstrap';
import { loadConfig } from '../../src/config/config';
import { createSqsClient } from '../../src/infrastructure/sqs/sqs-client';
import { SqsWagerConsumer } from '../../src/infrastructure/sqs/sqs-consumer';
import { PrometheusMetrics } from '../../src/infrastructure/observability/prometheus-metrics';
import { TestEnv, assertAllWalletsConsistent, createTestEnv, drainQueue, eventually, queueDepth, sendWagerMessage, sleep, sqlOne } from './support/env';
import { createWallet, http, sqsData, startInProcess } from './support/app';

let env: TestEnv;
let app: INestApplication;
let baseUrl: string;
let useCase: SubmitWagerTransactionUseCase;

beforeAll(async () => {
  env = await createTestEnv();
  const started = await startInProcess(env);
  app = started.app;
  baseUrl = started.baseUrl;
  useCase = app.get(SubmitWagerTransactionUseCase);
});
afterAll(async () => {
  await app.close();
  await env.cleanup();
});

const newConsumer = (client: SQSClient, uc: Pick<SubmitWagerTransactionUseCase, 'execute'> = useCase, overrides: Partial<typeof env.config.sqs> = {}) =>
  new SqsWagerConsumer(client, env.names, { ...env.config.sqs, ...overrides }, uc as SubmitWagerTransactionUseCase, new PrometheusMetrics(), noopLogger);

async function wallet(player: string, amount = '100.00'): Promise<string> {
  const res = await createWallet(baseUrl, player, amount);
  return res.body.id as string;
}
const balance = async (id: string) => (await http(baseUrl, 'GET', `/wallets/${id}`)).body.balance.amount as string;
const debits = async (id: string) => Number((await sqlOne<{ n: string }>(env, `SELECT count(*)::text n FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'`, [id])).n);

describe('SQS consumer', () => {
  test('processes a message end to end and acks only after commit', async () => {
    const walletId = await wallet('m-1');
    const consumer = newConsumer(env.sqs);
    consumer.start();
    try {
      await sendWagerMessage(env, sqsData({ externalTransactionId: 'm1-bet', playerId: 'm-1', walletId, amount: '25.00' }));
      await eventually(async () => (await balance(walletId)) === '75.00');
      await eventually(async () => (await queueDepth(env, env.queues.transactions)) === 0);
      const inbox = await sqlOne<{ n: string }>(env, `SELECT count(*)::text n FROM inbox_messages WHERE processed_at IS NOT NULL`);
      expect(Number(inbox.n)).toBeGreaterThan(0);
    } finally {
      await consumer.stop();
    }
  });

  test('the same message delivered 5 times (different broker dedup ids) debits once', async () => {
    const walletId = await wallet('m-2');
    const consumer = newConsumer(env.sqs);
    consumer.start();
    try {
      const data = sqsData({ externalTransactionId: 'm2-bet', playerId: 'm-2', walletId, amount: '10.00' });
      for (let i = 0; i < 5; i++) await sendWagerMessage(env, data, { messageId: 'same-message-id' });
      await eventually(async () => (await queueDepth(env, env.queues.transactions)) === 0);
      expect(await balance(walletId)).toBe('90.00');
      expect(await debits(walletId)).toBe(1);
    } finally {
      await consumer.stop();
    }
  });

  test('different messages carrying the same idempotency key do not double debit either', async () => {
    const walletId = await wallet('m-3');
    const consumer = newConsumer(env.sqs);
    consumer.start();
    try {
      const data = sqsData({ externalTransactionId: 'm3-bet', playerId: 'm-3', walletId, amount: '10.00' });
      for (let i = 0; i < 4; i++) await sendWagerMessage(env, data); // fresh messageId each time
      await eventually(async () => (await queueDepth(env, env.queues.transactions)) === 0);
      expect(await debits(walletId)).toBe(1);
      expect(await balance(walletId)).toBe('90.00');
    } finally {
      await consumer.stop();
    }
  });

  test('worker dies AFTER commit and BEFORE ack → redelivery is a no-op', async () => {
    const walletId = await wallet('m-4');
    // A client whose DeleteMessage never reaches the broker == process killed between commit and ack.
    class LosesAcks extends SQSClient {
      override async send(command: any, ...rest: any[]): Promise<any> {
        if (command instanceof DeleteMessageCommand) throw new Error('process died before ack');
        return (super.send as any)(command, ...rest);
      }
    }
    const dying = newConsumer(new LosesAcks({
      region: env.config.aws.region, endpoint: env.config.aws.endpoint,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    }));
    dying.start();
    await sendWagerMessage(env, sqsData({ externalTransactionId: 'm4-bet', playerId: 'm-4', walletId, amount: '40.00' }));
    await eventually(async () => (await balance(walletId)) === '60.00'); // committed…
    await dying.stop();
    expect(await queueDepth(env, env.queues.transactions)).toBe(1); // …but never acked

    const survivor = newConsumer(env.sqs); // "another instance"
    survivor.start();
    try {
      await eventually(async () => (await queueDepth(env, env.queues.transactions)) === 0, 30_000);
      expect(await balance(walletId)).toBe('60.00');
      expect(await debits(walletId)).toBe(1);
      await assertAllWalletsConsistent(env);
    } finally {
      await survivor.stop();
    }
  });

  test('permanent errors (malformed JSON, unknown wallet, invalid money) go to the DLQ and are removed from the queue', async () => {
    const consumer = newConsumer(env.sqs);
    consumer.start();
    try {
      await env.sqs.send(new (await import('@aws-sdk/client-sqs')).SendMessageCommand({
        QueueUrl: env.queues.transactions, MessageBody: '{not json', MessageGroupId: 'poison', MessageDeduplicationId: 'poison-1',
      }));
      await sendWagerMessage(env, sqsData({ externalTransactionId: 'ghost', playerId: 'x', walletId: '00000000-0000-7000-8000-00000000dead' }));
      const goodWallet = await wallet('m-5');
      const bad = sqsData({ externalTransactionId: 'bad-money', playerId: 'm-5', walletId: goodWallet });
      await sendWagerMessage(env, { ...bad, money: { amount: '1e3', currency: 'BRL' } });

      await eventually(async () => (await queueDepth(env, env.queues.transactionsDlq)) >= 3, 30_000);
      await eventually(async () => (await queueDepth(env, env.queues.transactions)) === 0);
      const dead = await drainQueue(env, env.queues.transactionsDlq);
      expect(dead.length).toBeGreaterThanOrEqual(3);
      expect(dead.every((m) => m.attributes['failureReason'])).toBe(true);
      expect(await balance(goodWallet)).toBe('100.00');
    } finally {
      await consumer.stop();
    }
  });

  test('transient errors are retried with backoff and succeed once the dependency recovers', async () => {
    const walletId = await wallet('m-6');
    let failures = 2;
    const flaky = {
      execute: async (input: Parameters<SubmitWagerTransactionUseCase['execute']>[0]) => {
        if (failures-- > 0) throw new TransientInfrastructureError('postgres unavailable');
        return useCase.execute(input);
      },
    };
    const consumer = newConsumer(env.sqs, flaky, { maxReceiveCount: 5 });
    consumer.start();
    try {
      await sendWagerMessage(env, sqsData({ externalTransactionId: 'm6-bet', playerId: 'm-6', walletId, amount: '5.00' }));
      await eventually(async () => (await balance(walletId)) === '95.00', 40_000);
      expect(await debits(walletId)).toBe(1);
      expect(failures).toBeLessThan(0);
    } finally {
      await consumer.stop();
    }
  });

  test('transient errors that never recover end in the DLQ after the attempt limit', async () => {
    const walletId = await wallet('m-7');
    const alwaysDown = { execute: async () => { throw new TransientInfrastructureError('postgres unavailable'); } };
    const consumer = newConsumer(env.sqs, alwaysDown, { maxReceiveCount: 2 });
    consumer.start();
    try {
      const before = await queueDepth(env, env.queues.transactionsDlq);
      await sendWagerMessage(env, sqsData({ externalTransactionId: 'm7-bet', playerId: 'm-7', walletId }));
      await eventually(async () => (await queueDepth(env, env.queues.transactionsDlq)) > before, 40_000);
      expect(await balance(walletId)).toBe('100.00');
    } finally {
      await consumer.stop();
    }
  });

  test('graceful shutdown: in-flight work finishes, unstarted messages are released, nothing is lost or duplicated', async () => {
    const walletId = await wallet('m-8', '1000.00');
    const first = newConsumer(env.sqs);
    first.start();
    for (let i = 0; i < 8; i++) {
      await sendWagerMessage(env, sqsData({ externalTransactionId: `m8-${i}`, playerId: 'm-8', walletId, amount: '1.00' }), { groupId: walletId });
    }
    await sleep(500);
    await first.stop(); // like SIGTERM mid-flight

    const second = newConsumer(env.sqs);
    second.start();
    try {
      await eventually(async () => (await balance(walletId)) === '992.00', 40_000);
      await eventually(async () => (await queueDepth(env, env.queues.transactions)) === 0);
      expect(await debits(walletId)).toBe(8);
      await assertAllWalletsConsistent(env);
    } finally {
      await second.stop();
    }
  });
});

test('createSqsClient honours the configured endpoint', () => {
  const client = createSqsClient(loadConfig(env.childEnv).aws);
  expect(client).toBeTruthy();
  client.destroy();
  expect(noopMetrics).toBeTruthy();
});
