/** Helpers to classify errors surfaced by MikroORM / node-postgres. */

function chain(error: unknown): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    out.push(current as Record<string, unknown>);
    const e = current as Record<string, unknown>;
    current = e['cause'] ?? e['originalError'] ?? e['previous'];
  }
  return out;
}

/** SQLSTATE (e.g. "40P01") or a Node network code (e.g. "ECONNREFUSED"), if any. */
export function errorCode(error: unknown): string | undefined {
  for (const e of chain(error)) {
    const code = e['code'];
    if (typeof code === 'string' && code.length > 0) return code;
  }
  return undefined;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type ConflictReason = 'deadlock' | 'serialization' | 'lock_timeout';

/** Concurrency conflicts that are safe to retry by re-running the whole transaction. */
export function conflictReason(error: unknown): ConflictReason | undefined {
  switch (errorCode(error)) {
    case '40P01':
      return 'deadlock';
    case '40001':
      return 'serialization';
    case '55P03':
      return 'lock_timeout';
    default:
      return undefined;
  }
}

const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNABORTED']);
const CONNECTION_MESSAGE =
  /connection terminated|timeout exceeded when trying to connect|unable to acquire a connection|connection.*(refused|closed|reset)|database system is (starting up|shutting down)|knex: timeout acquiring a connection/i;

/** PostgreSQL unreachable / restarting / out of connections / statement cancelled: retry later. */
export function isTransientInfrastructure(error: unknown): boolean {
  const code = errorCode(error);
  if (code) {
    if (NETWORK_CODES.has(code)) return true;
    if (code.startsWith('08')) return true; // connection exception
    if (['57P01', '57P02', '57P03', '53300', '57014'].includes(code)) return true;
  }
  return chain(error).some((e) => typeof e['message'] === 'string' && CONNECTION_MESSAGE.test(e['message'] as string));
}
