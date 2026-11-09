import { AsyncLocalStorage } from 'node:async_hooks';

export interface LogContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

export function runWithContext<T>(context: LogContext, fn: () => T): T {
  return storage.run({ ...context }, fn);
}

export function currentContext(): LogContext {
  return storage.getStore() ?? {};
}

export function currentCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}
