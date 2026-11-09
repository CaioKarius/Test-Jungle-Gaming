import {
  IdempotencyConflictError,
  ValidationError,
  WalletNotFoundError,
} from '../../application/errors';
import { hashCanonical } from '../../shared/canonical';
import { DomainError } from '../../shared/domain/errors';

export const CONSUMER_NAME = 'wager-transactions-consumer';
export const MESSAGE_TYPE = 'WagerTransactionRequested';

/** The message itself is unusable (malformed JSON, wrong type…). Never retryable. */
export class PermanentMessageError extends Error {
  readonly code = 'MALFORMED_MESSAGE';
}

export interface ParsedMessage {
  messageId: string;
  data: Record<string, unknown>;
  idempotencyKey: string;
  inboxPayloadHash: string;
}

export function parseEnvelope(body: string | undefined): ParsedMessage {
  if (!body) throw new PermanentMessageError('empty message body');
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new PermanentMessageError('message body is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new PermanentMessageError('message must be a JSON object');
  }
  const envelope = parsed as Record<string, unknown>;
  if (typeof envelope['messageId'] !== 'string' || envelope['messageId'].trim() === '') {
    throw new PermanentMessageError('messageId is required');
  }
  if (envelope['type'] !== MESSAGE_TYPE) {
    throw new PermanentMessageError(`unsupported message type "${String(envelope['type'])}"`);
  }
  const data = envelope['data'];
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new PermanentMessageError('data must be an object');
  }
  const record = data as Record<string, unknown>;
  const idempotencyKey = record['idempotencyKey'];
  if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
    throw new PermanentMessageError('data.idempotencyKey is required');
  }
  return {
    messageId: envelope['messageId'],
    data: record,
    idempotencyKey,
    inboxPayloadHash: hashCanonical(record),
  };
}

export type ErrorClass = 'permanent' | 'transient';

/**
 * Business outcomes (REJECTED etc.) are NOT errors — they come back as results and are acked.
 * What reaches here is either permanent (will never succeed → DLQ) or transient (retry).
 * Unknown errors default to transient: they are retried up to the attempt limit, then DLQ'd.
 */
export function classifyError(error: unknown): ErrorClass {
  if (
    error instanceof PermanentMessageError ||
    error instanceof ValidationError ||
    error instanceof WalletNotFoundError ||
    error instanceof IdempotencyConflictError ||
    error instanceof DomainError ||
    error instanceof SyntaxError
  ) {
    return 'permanent';
  }
  return 'transient';
}

export function errorReason(error: unknown): string {
  if (typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string') {
    return (error as { code: string }).code;
  }
  return error instanceof Error ? error.name : 'UNKNOWN';
}

/** Visibility timeout (seconds) for the n-th attempt: base · 2^(n-1), capped. */
export function retryDelaySeconds(receiveCount: number, baseSeconds: number, maxSeconds: number): number {
  return Math.min(maxSeconds, baseSeconds * 2 ** Math.max(0, receiveCount - 1));
}
