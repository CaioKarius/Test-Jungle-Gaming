/** Errors raised by the application layer. HTTP/SQS mapping lives at the edges. */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export interface ValidationIssue {
  field: string;
  message: string;
}

/** Payload / contract violation. Never retryable as-is. */
export class ValidationError extends ApplicationError {
  readonly code = 'VALIDATION_ERROR';

  constructor(
    message: string,
    public readonly issues: readonly ValidationIssue[] = [],
  ) {
    super(message);
  }
}

/** Same idempotency key (or external id) reused with a different payload. */
export class IdempotencyConflictError extends ApplicationError {
  readonly code = 'IDEMPOTENCY_CONFLICT';
}

export class WalletNotFoundError extends ApplicationError {
  readonly code = 'WALLET_NOT_FOUND';

  constructor(walletId: string) {
    super(`wallet ${walletId} not found`);
  }
}

export class TransactionNotFoundError extends ApplicationError {
  readonly code = 'TRANSACTION_NOT_FOUND';
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = 'WALLET_ALREADY_EXISTS';

  constructor(playerId: string, currency: string) {
    super(`a ${currency} wallet already exists for player ${playerId}`);
  }
}

/**
 * Wallet row changed under us despite the lock — should never happen, but the version check is
 * the safety net, so it is reported (and retried) rather than silently overwritten.
 */
export class ConcurrentWalletModificationError extends ApplicationError {
  readonly code = 'CONCURRENT_WALLET_MODIFICATION';
}

/** PostgreSQL / SQS temporarily unavailable, lock timeout, deadlock victim… Safe to retry. */
export class TransientInfrastructureError extends ApplicationError {
  readonly code = 'TRANSIENT_INFRASTRUCTURE_ERROR';

  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
  }
}
