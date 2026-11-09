import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Inject } from '@nestjs/common';
import type { Response } from 'express';
import {
  IdempotencyConflictError,
  TransactionNotFoundError,
  TransientInfrastructureError,
  ValidationError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../application/errors';
import { Logger } from '../../application/ports';
import { DomainError } from '../../shared/domain/errors';
import { LOGGER } from '../../tokens';
import { isTransientInfrastructure } from '../../infrastructure/persistence/pg-errors';

/**
 * Status mapping (identical on every endpoint):
 *   400 invalid payload · 404 not found · 409 idempotency/duplicate-wallet conflict ·
 *   422 business rejection (returned by the submit endpoint itself) ·
 *   202 accepted, processing pending (also from the submit endpoint) ·
 *   503 transient infrastructure failure (+ Retry-After, retryable) · 500 unexpected bug.
 * Body: { error: { code, message, retryable, details? } } — `retryable` tells the provider whether
 * re-sending the SAME request can ever succeed.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const { status, code, message, retryable, details } = this.translate(exception);

    if (status >= 500) {
      this.logger.error('request failed', {
        code,
        status,
        error: exception instanceof Error ? `${exception.name}: ${exception.message}` : String(exception),
      });
    }
    if (status === 503) res.setHeader('Retry-After', '1');
    res.status(status).json({ error: { code, message, retryable, ...(details ? { details } : {}) } });
  }

  private translate(e: unknown): { status: number; code: string; message: string; retryable: boolean; details?: unknown } {
    if (e instanceof ValidationError) {
      return { status: 400, code: e.code, message: e.message, retryable: false, details: e.issues };
    }
    if (e instanceof IdempotencyConflictError) return { status: 409, code: e.code, message: e.message, retryable: false };
    if (e instanceof WalletAlreadyExistsError) return { status: 409, code: e.code, message: e.message, retryable: false };
    if (e instanceof WalletNotFoundError || e instanceof TransactionNotFoundError) {
      return { status: 404, code: e.code, message: e.message, retryable: false };
    }
    if (e instanceof TransientInfrastructureError) {
      return { status: 503, code: e.code, message: 'service temporarily unavailable, retry with the same Idempotency-Key', retryable: true };
    }
    if (e instanceof DomainError) {
      return { status: 400, code: e.code, message: e.message, retryable: false };
    }
    if (e instanceof HttpException) {
      const status = e.getStatus();
      return { status, code: status === 404 ? 'NOT_FOUND' : `HTTP_${status}`, message: e.message, retryable: false };
    }
    const status = (e as { status?: unknown; statusCode?: unknown } | null)?.status ?? (e as { statusCode?: unknown } | null)?.statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      // e.g. malformed JSON rejected by the body parser
      return { status, code: status === 400 ? 'VALIDATION_ERROR' : `HTTP_${status}`, message: 'invalid request', retryable: false };
    }
    if (isTransientInfrastructure(e)) {
      return { status: 503, code: 'TRANSIENT_INFRASTRUCTURE_ERROR', message: 'service temporarily unavailable', retryable: true };
    }
    return { status: 500, code: 'INTERNAL_ERROR', message: 'internal error', retryable: false };
  }
}
