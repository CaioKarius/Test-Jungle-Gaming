import { INestApplication } from '@nestjs/common';
import { createApp } from '../../../src/bootstrap';
import { loadConfig } from '../../../src/config/config';
import { TestEnv, eventually } from './env';

export interface Roles {
  consumer?: boolean;
  publisher?: boolean;
  pending?: boolean;
}

/** In-process instance (HTTP on an ephemeral port). */
export async function startInProcess(env: TestEnv, roles: Roles = {}, extra: Record<string, string> = {}) {
  const config = loadConfig({
    ...env.childEnv,
    ENABLE_SQS_CONSUMER: String(roles.consumer ?? false),
    ENABLE_OUTBOX_PUBLISHER: String(roles.publisher ?? false),
    ENABLE_PENDING_REFERENCE_WORKER: String(roles.pending ?? false),
    ...extra,
  });
  const app: INestApplication = await createApp(config);
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address() as { port: number };
  return { app, baseUrl: `http://127.0.0.1:${address.port}`, close: () => app.close() };
}

/** Child-process instance (real OS process: can be SIGKILLed / SIGTERMed). */
export class ChildInstance {
  readonly logs: string[] = [];
  private proc: ReturnType<typeof Bun.spawn> | undefined;

  constructor(
    private readonly env: TestEnv,
    readonly port: number,
    private readonly roles: Roles & { http?: boolean } = { consumer: true, publisher: true, pending: true },
  ) {}

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<this> {
    this.proc = Bun.spawn(['bun', 'run', 'src/main.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...this.env.childEnv,
        PORT: String(this.port),
        ENABLE_SQS_CONSUMER: String(this.roles.consumer ?? false),
        ENABLE_OUTBOX_PUBLISHER: String(this.roles.publisher ?? false),
        ENABLE_PENDING_REFERENCE_WORKER: String(this.roles.pending ?? false),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    this.collect(this.proc.stdout as ReadableStream<Uint8Array>);
    this.collect(this.proc.stderr as ReadableStream<Uint8Array>);
    await eventually(async () => {
      try {
        const res = await fetch(`${this.baseUrl}/health/ready`);
        return res.status === 200;
      } catch {
        return false;
      }
    }, 60_000, 300).catch((error) => {
      throw new Error(`instance on :${this.port} did not become ready: ${error}\n${this.logs.slice(-15).join('\n')}`);
    });
    return this;
  }

  private collect(stream: ReadableStream<Uint8Array>): void {
    void (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) {
        for (const line of decoder.decode(chunk).split('\n')) if (line) this.logs.push(line);
        if (this.logs.length > 500) this.logs.splice(0, this.logs.length - 500);
      }
    })();
  }

  /** Abrupt death: no shutdown hooks, no ack, no publish. */
  async kill(): Promise<void> {
    this.proc?.kill('SIGKILL');
    await this.proc?.exited;
  }

  /** Graceful stop; resolves with the exit code. */
  async terminate(): Promise<number | null> {
    this.proc?.kill('SIGTERM');
    return (await this.proc?.exited) ?? null;
  }
}

let nextPort = 21000 + Math.floor(Math.random() * 15000);
export const allocatePort = (): number => nextPort++;

// ---- tiny HTTP client -------------------------------------------------------------------

export interface HttpResult<T = any> {
  status: number;
  body: T;
}

export async function http<T = any>(baseUrl: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<HttpResult<T>> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
}

export const createWallet = (baseUrl: string, playerId: string, amount = '100.00') =>
  http(baseUrl, 'POST', '/wallets', { playerId, initialBalance: { amount, currency: 'BRL' } });

export interface WagerBody {
  providerId?: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId?: string;
  kind?: string;
  amount?: string;
  referenceExternalTransactionId?: string;
}

export function wagerData(b: WagerBody) {
  return {
    providerId: b.providerId ?? 'provider-a',
    externalTransactionId: b.externalTransactionId,
    playerId: b.playerId,
    walletId: b.walletId,
    roundId: b.roundId ?? 'round-1',
    gameId: 'fortune-chimp',
    kind: b.kind ?? 'BET',
    money: { amount: b.amount ?? '1.00', currency: 'BRL' },
    ...(b.referenceExternalTransactionId ? { referenceExternalTransactionId: b.referenceExternalTransactionId } : {}),
  };
}

export const submit = (baseUrl: string, b: WagerBody, key?: string) => {
  const data = wagerData(b);
  return http(baseUrl, 'POST', '/wagering/transactions', data, {
    'idempotency-key': key ?? `${data.providerId}:${data.externalTransactionId}`,
  });
};

export const sqsData = (b: WagerBody, key?: string) => {
  const data = wagerData(b);
  return { ...data, idempotencyKey: key ?? `${data.providerId}:${data.externalTransactionId}` };
};
