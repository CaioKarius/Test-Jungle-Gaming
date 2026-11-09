import { LoggerService } from '@nestjs/common';
import { LogFields, Logger } from '../../application/ports';
import { currentContext } from './request-context';

type Level = 'debug' | 'info' | 'warn' | 'error';

/** Keys that could carry financial payloads / secrets: dropped from every log line. */
const REDACTED_KEYS = new Set([
  'money', 'amount', 'balance', 'balances', 'initialbalance', 'payload', 'body', 'data',
  'authorization', 'password', 'token', 'secret',
]);

function sanitize(fields: LogFields | undefined): LogFields {
  if (!fields) return {};
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (REDACTED_KEYS.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

/** Structured JSON logs (one object per line) enriched with the ambient correlation context. */
export class JsonLogger implements Logger, LoggerService {
  constructor(
    private readonly service = 'wagering',
    private readonly write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
    private readonly minLevel: Level = (process.env['LOG_LEVEL'] as Level | undefined) ?? 'info',
  ) {}

  private static readonly order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

  private emit(level: Level, message: string, fields?: LogFields): void {
    if (JsonLogger.order[level] < JsonLogger.order[this.minLevel]) return;
    const ctx = currentContext();
    this.write(
      JSON.stringify({
        level,
        time: new Date().toISOString(),
        service: this.service,
        msg: message,
        correlationId: ctx.correlationId,
        messageId: ctx.messageId,
        transactionId: ctx.transactionId,
        walletId: ctx.walletId,
        providerId: ctx.providerId,
        ...sanitize(fields),
      }),
    );
  }

  debug(message: string, fields?: LogFields): void { this.emit('debug', message, fields); }
  info(message: string, fields?: LogFields): void { this.emit('info', message, fields); }
  warn(message: string, fields?: LogFields): void { this.emit('warn', message, fields); }
  error(message: string, fields?: LogFields): void { this.emit('error', message, fields); }

  // ---- Nest LoggerService (framework logs) ----
  log(message: unknown, ...optional: unknown[]): void { this.emit('info', String(message), { context: optional[0] as string }); }
  verbose(message: unknown): void { this.emit('debug', String(message)); }
  fatal(message: unknown): void { this.emit('error', String(message)); }
}
