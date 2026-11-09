import { InvalidMoneyError, InvalidWagerTransactionError } from '../shared/domain/errors';
import { Money } from '../shared/domain/money';
import { UUID_PATTERN } from '../shared/ids';
import {
  SUBMITTABLE_KINDS,
  WagerTransaction,
  WagerTransactionKind,
} from '../wagering/domain/wager-transaction';
import { ValidationError, ValidationIssue } from './errors';

const MAX_ID_LENGTH = 128;
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

export interface ValidatedSubmission {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
}

function readString(
  source: Record<string, unknown>,
  field: string,
  issues: ValidationIssue[],
  maxLength = MAX_ID_LENGTH,
): string {
  const value = source[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    issues.push({ field, message: 'must be a non-empty string' });
    return '';
  }
  if (value.length > maxLength) {
    issues.push({ field, message: `must be at most ${maxLength} characters` });
  }
  return value;
}

/**
 * Validates the business payload shared by HTTP and SQS. `idempotencyKey` comes from the
 * `Idempotency-Key` header (HTTP) or from the message (SQS).
 */
export function validateSubmission(idempotencyKey: unknown, data: unknown): ValidatedSubmission {
  const issues: ValidationIssue[] = [];

  if (typeof idempotencyKey !== 'string' || idempotencyKey.trim().length === 0) {
    issues.push({ field: 'Idempotency-Key', message: 'is required' });
  } else if (idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    issues.push({ field: 'Idempotency-Key', message: `must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters` });
  }

  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    issues.push({ field: 'body', message: 'must be a JSON object' });
    throw new ValidationError('invalid request payload', issues);
  }
  const source = data as Record<string, unknown>;

  const providerId = readString(source, 'providerId', issues);
  const externalTransactionId = readString(source, 'externalTransactionId', issues);
  const playerId = readString(source, 'playerId', issues);
  const roundId = readString(source, 'roundId', issues);
  const gameId = readString(source, 'gameId', issues);

  const walletId = readString(source, 'walletId', issues);
  if (walletId && !UUID_PATTERN.test(walletId)) {
    issues.push({ field: 'walletId', message: 'must be a UUID' });
  }

  let kind = WagerTransactionKind.Bet;
  const rawKind = source['kind'];
  if (rawKind === WagerTransactionKind.Opening) {
    issues.push({ field: 'kind', message: 'OPENING is internal and cannot be submitted' });
  } else if (!SUBMITTABLE_KINDS.includes(rawKind as WagerTransactionKind)) {
    issues.push({ field: 'kind', message: `must be one of ${SUBMITTABLE_KINDS.join(', ')}` });
  } else {
    kind = rawKind as WagerTransactionKind;
  }

  let money = Money.zero('BRL');
  try {
    money = Money.from(source['money'] as { amount: string; currency: string });
    if (!money.isPositive()) {
      issues.push({ field: 'money.amount', message: 'must be greater than zero' });
    }
  } catch (error) {
    if (error instanceof InvalidMoneyError) {
      issues.push({ field: 'money', message: error.message });
    } else {
      throw error;
    }
  }

  let referenceExternalTransactionId: string | undefined;
  const rawReference = source['referenceExternalTransactionId'];
  if (rawReference !== undefined && rawReference !== null) {
    if (typeof rawReference !== 'string' || rawReference.trim().length === 0 || rawReference.length > MAX_ID_LENGTH) {
      issues.push({ field: 'referenceExternalTransactionId', message: 'must be a non-empty string' });
    } else {
      referenceExternalTransactionId = rawReference;
    }
  }

  if (issues.length > 0) {
    throw new ValidationError('invalid request payload', issues);
  }

  const submission: ValidatedSubmission = {
    idempotencyKey: idempotencyKey as string,
    providerId,
    externalTransactionId,
    playerId,
    walletId,
    roundId,
    gameId,
    kind,
    money,
    ...(referenceExternalTransactionId !== undefined ? { referenceExternalTransactionId } : {}),
  };

  // Cross-field rules (reference required per kind, no self reference…) live in the aggregate:
  // dry-run its factory instead of duplicating them here.
  try {
    WagerTransaction.create({
      id: 'validation',
      ...submission,
      payloadHash: '',
      createdAt: new Date(0),
    });
  } catch (error) {
    if (error instanceof InvalidWagerTransactionError) {
      throw new ValidationError('invalid request payload', [{ field: 'body', message: error.message }]);
    }
    throw error;
  }
  return submission;
}

