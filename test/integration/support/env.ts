import { SQSClient, DeleteQueueCommand, GetQueueAttributesCommand, ReceiveMessageCommand, DeleteMessageCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { Migrator } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import { Pool } from 'pg';
import { randomBytes } from 'node:crypto';
import { AppConfig, QueueNames, loadConfig, queueNames } from '../../../src/config/config';
import { mikroOrmOptions } from '../../../src/infrastructure/persistence/mikro-orm.config';
import { QueueUrls, createSqsClient, ensureQueues } from '../../../src/infrastructure/sqs/sqs-client';

export const ADMIN_DATABASE_URL =
  process.env['TEST_DATABASE_ADMIN_URL'] ?? 'postgres://wagering:wagering@localhost:5433/postgres';
export const AWS_ENDPOINT = process.env['TEST_AWS_ENDPOINT'] ?? 'http://localhost:4567';

export interface TestEnv {
  dbName: string;
  databaseUrl: string;
  queuePrefix: string;
  names: QueueNames;
  config: AppConfig;
  /** Env vars to hand to a child process so it points at this isolated environment. */
  childEnv: Record<string, string>;
  sqs: SQSClient;
  queues: QueueUrls;
  pool: Pool;
  cleanup(): Promise<void>;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Polls `fn` until it returns a truthy value (or throws after `timeoutMs`). */
export async function eventually<T>(fn: () => Promise<T | false | undefined | null>, timeoutMs = 30_000, intervalMs = 150): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() > deadline) {
      throw new Error(`condition not met within ${timeoutMs}ms${lastError ? `: ${String(lastError)}` : ''}`);
    }
    await sleep(intervalMs);
  }
}

/** Fast timings so retries/backoffs are observable inside a test. Override per test. */
export function testEnvVars(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    PORT: '0',
    DB_POOL_MAX: '10',
    DB_LOCK_TIMEOUT_MS: '10000',
    AWS_REGION: 'us-east-1',
    AWS_ENDPOINT_URL: AWS_ENDPOINT,
    AWS_ACCESS_KEY_ID: 'test',
    AWS_SECRET_ACCESS_KEY: 'test',
    SQS_WAIT_TIME_SECONDS: '1',
    SQS_VISIBILITY_TIMEOUT_SECONDS: '3',
    SQS_MAX_RECEIVE_COUNT: '3',
    SQS_RETRY_BASE_SECONDS: '1',
    SQS_RETRY_MAX_SECONDS: '2',
    SHUTDOWN_GRACE_MS: '8000',
    OUTBOX_POLL_INTERVAL_MS: '100',
    PENDING_REF_POLL_INTERVAL_MS: '200',
    PENDING_REF_BASE_DELAY_MS: '300',
    PENDING_REF_MAX_DELAY_MS: '1000',
    PENDING_REF_MAX_ATTEMPTS: '6',
    PENDING_REF_TTL_MS: '60000',
    // roles default OFF in tests; each test turns on what it needs.
    ENABLE_HTTP: 'true',
    ENABLE_SQS_CONSUMER: 'false',
    ENABLE_OUTBOX_PUBLISHER: 'false',
    ENABLE_PENDING_REFERENCE_WORKER: 'false',
    ...overrides,
  };
}

/** Creates an isolated database (migrated) + isolated FIFO queues. Call `cleanup()` in afterAll. */
export async function createTestEnv(overrides: Record<string, string> = {}): Promise<TestEnv> {
  const suffix = randomBytes(5).toString('hex');
  const dbName = `wagering_test_${suffix}`;
  const admin = new Pool({ connectionString: ADMIN_DATABASE_URL, max: 1 });
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();

  const databaseUrl = ADMIN_DATABASE_URL.replace(/\/[^/]*$/, `/${dbName}`);
  const queuePrefix = `t${suffix}-`;
  const childEnv = testEnvVars({ DATABASE_URL: databaseUrl, SQS_QUEUE_PREFIX: queuePrefix, ...overrides });
  const config = loadConfig(childEnv);

  const orm = await MikroORM.init(mikroOrmOptions(config.database));
  await new Migrator(orm.em).up();
  await orm.close(true);

  const sqs = createSqsClient(config.aws);
  const names = queueNames(queuePrefix);
  const queues = await ensureQueues(sqs, names, {
    maxReceiveCount: config.sqs.maxReceiveCount,
    visibilityTimeoutSeconds: config.sqs.visibilityTimeoutSeconds,
  });
  const pool = new Pool({ connectionString: databaseUrl, max: 5 });

  return {
    dbName, databaseUrl, queuePrefix, names, config, childEnv, sqs, queues, pool,
    async cleanup() {
      await pool.end().catch(() => undefined);
      for (const url of Object.values(queues)) {
        await sqs.send(new DeleteQueueCommand({ QueueUrl: url })).catch(() => undefined);
      }
      sqs.destroy();
      const adminPool = new Pool({ connectionString: ADMIN_DATABASE_URL, max: 1 });
      await adminPool.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => undefined);
      await adminPool.end();
    },
  };
}

// ---- SQS helpers ------------------------------------------------------------------------

export async function sendWagerMessage(env: TestEnv, data: Record<string, unknown>, opts: { messageId?: string; groupId?: string } = {}): Promise<string> {
  const messageId = opts.messageId ?? `msg-${randomBytes(6).toString('hex')}`;
  await env.sqs.send(
    new SendMessageCommand({
      QueueUrl: env.queues.transactions,
      MessageBody: JSON.stringify({ messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data }),
      MessageGroupId: opts.groupId ?? String(data['walletId'] ?? 'g'),
      // unique per send: we WANT duplicates to reach the consumer (the broker must not hide them)
      MessageDeduplicationId: randomBytes(8).toString('hex'),
    }),
  );
  return messageId;
}

export async function queueDepth(env: TestEnv, queueUrl: string): Promise<number> {
  const out = await env.sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible', 'ApproximateNumberOfMessagesDelayed'],
    }),
  );
  const a = out.Attributes ?? {};
  return Number(a['ApproximateNumberOfMessages'] ?? 0) + Number(a['ApproximateNumberOfMessagesNotVisible'] ?? 0) + Number(a['ApproximateNumberOfMessagesDelayed'] ?? 0);
}

/** Reads (and deletes) everything currently available on a queue. */
export async function drainQueue(env: TestEnv, queueUrl: string, rounds = 5): Promise<Array<{ body: string; attributes: Record<string, string> }>> {
  const out: Array<{ body: string; attributes: Record<string, string> }> = [];
  for (let i = 0; i < rounds; i++) {
    const res = await env.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, VisibilityTimeout: 30,
        MessageAttributeNames: ['All'], MessageSystemAttributeNames: ['All'],
      }),
    );
    const messages = res.Messages ?? [];
    for (const m of messages) {
      out.push({
        body: m.Body ?? '',
        attributes: Object.fromEntries(Object.entries(m.MessageAttributes ?? {}).map(([k, v]) => [k, v.StringValue ?? ''])),
      });
      await env.sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: m.ReceiptHandle }));
    }
    if (messages.length === 0 && i > 0) break;
  }
  return out;
}

// ---- SQL helpers (assertions straight against the database) -----------------------------

export async function sqlOne<T = Record<string, unknown>>(env: TestEnv, text: string, params: unknown[] = []): Promise<T> {
  const res = await env.pool.query(text, params);
  return res.rows[0] as T;
}

/** The invariant every test must end with: wallet.balance == balance rebuilt from the ledger. */
export async function assertAllWalletsConsistent(env: TestEnv): Promise<number> {
  const res = await env.pool.query(`
    SELECT w.id, w.balance::text AS stored,
           COALESCE(SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END), 0)::numeric(19,2)::text AS calculated
      FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
     GROUP BY w.id`);
  const bad = res.rows.filter((r: { stored: string; calculated: string }) => r.stored !== r.calculated);
  if (bad.length > 0) throw new Error(`inconsistent wallets: ${JSON.stringify(bad.slice(0, 5))}`);
  const negative = await env.pool.query(`SELECT id FROM wallets WHERE balance < 0`);
  if (negative.rows.length > 0) throw new Error('negative balance found');
  return res.rows.length;
}
