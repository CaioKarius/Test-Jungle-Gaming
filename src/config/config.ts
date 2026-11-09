import { PendingReferencePolicy } from '../application/ports';

export interface AppConfig {
  port: number;
  database: {
    url: string;
    poolMin: number;
    poolMax: number;
    lockTimeoutMs: number;
  };
  aws: {
    region: string;
    endpoint?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
  };
  sqs: {
    queuePrefix: string;
    waitTimeSeconds: number;
    batchSize: number;
    /** App-level attempt limit before a message is sent to the DLQ. */
    maxReceiveCount: number;
    retryBaseSeconds: number;
    retryMaxSeconds: number;
    visibilityTimeoutSeconds: number;
    shutdownGraceMs: number;
  };
  roles: {
    http: boolean;
    sqsConsumer: boolean;
    outboxPublisher: boolean;
    pendingReferenceWorker: boolean;
  };
  outbox: { pollIntervalMs: number; batchSize: number };
  pendingReference: PendingReferencePolicy & { pollIntervalMs: number; batchSize: number };
}

type Env = Record<string, string | undefined>;

function str(env: Env, key: string, fallback: string): string {
  const v = env[key];
  return v === undefined || v === '' ? fallback : v;
}
function int(env: Env, key: string, fallback: number): number {
  const v = env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`${key} must be an integer, got "${v}"`);
  return n;
}
function bool(env: Env, key: string, fallback: boolean): boolean {
  const v = env[key];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

export function loadConfig(env: Env = process.env): AppConfig {
  const endpoint = env['AWS_ENDPOINT_URL'];
  return {
    port: int(env, 'PORT', 3000),
    database: {
      url: str(env, 'DATABASE_URL', 'postgres://wagering:wagering@localhost:5432/wagering'),
      poolMin: int(env, 'DB_POOL_MIN', 2),
      poolMax: int(env, 'DB_POOL_MAX', 20),
      lockTimeoutMs: int(env, 'DB_LOCK_TIMEOUT_MS', 5000),
    },
    aws: {
      region: str(env, 'AWS_REGION', 'us-east-1'),
      ...(endpoint ? { endpoint } : {}),
      accessKeyId: str(env, 'AWS_ACCESS_KEY_ID', 'test'),
      secretAccessKey: str(env, 'AWS_SECRET_ACCESS_KEY', 'test'),
    },
    sqs: {
      queuePrefix: str(env, 'SQS_QUEUE_PREFIX', ''),
      waitTimeSeconds: int(env, 'SQS_WAIT_TIME_SECONDS', 10),
      batchSize: Math.min(10, int(env, 'SQS_BATCH_SIZE', 10)),
      maxReceiveCount: int(env, 'SQS_MAX_RECEIVE_COUNT', 5),
      retryBaseSeconds: int(env, 'SQS_RETRY_BASE_SECONDS', 2),
      retryMaxSeconds: int(env, 'SQS_RETRY_MAX_SECONDS', 60),
      visibilityTimeoutSeconds: int(env, 'SQS_VISIBILITY_TIMEOUT_SECONDS', 30),
      shutdownGraceMs: int(env, 'SHUTDOWN_GRACE_MS', 20_000),
    },
    roles: {
      http: bool(env, 'ENABLE_HTTP', true),
      sqsConsumer: bool(env, 'ENABLE_SQS_CONSUMER', true),
      outboxPublisher: bool(env, 'ENABLE_OUTBOX_PUBLISHER', true),
      pendingReferenceWorker: bool(env, 'ENABLE_PENDING_REFERENCE_WORKER', true),
    },
    outbox: {
      pollIntervalMs: int(env, 'OUTBOX_POLL_INTERVAL_MS', 500),
      batchSize: int(env, 'OUTBOX_BATCH_SIZE', 50),
    },
    pendingReference: {
      pollIntervalMs: int(env, 'PENDING_REF_POLL_INTERVAL_MS', 1000),
      batchSize: int(env, 'PENDING_REF_BATCH_SIZE', 50),
      baseDelayMs: int(env, 'PENDING_REF_BASE_DELAY_MS', 5_000),
      maxDelayMs: int(env, 'PENDING_REF_MAX_DELAY_MS', 300_000),
      maxAttempts: int(env, 'PENDING_REF_MAX_ATTEMPTS', 10),
      ttlMs: int(env, 'PENDING_REF_TTL_MS', 1_800_000),
    },
  };
}

export interface QueueNames {
  transactions: string;
  transactionsDlq: string;
  events: string;
}

export function queueNames(prefix: string): QueueNames {
  return {
    transactions: `${prefix}wager-transactions.fifo`,
    transactionsDlq: `${prefix}wager-transactions-dlq.fifo`,
    events: `${prefix}wager-events.fifo`,
  };
}
