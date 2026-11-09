import { hashCanonical } from '../shared/canonical';
import { ValidatedSubmission } from './validation';

/**
 * payloadHash = SHA-256 (hex) over the canonical JSON (keys sorted recursively, no whitespace)
 * of the BUSINESS fields only:
 *
 *   providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind,
 *   money { amount (normalised to 2 decimals), currency }, referenceExternalTransactionId (null if absent)
 *
 * The Idempotency-Key header, correlation ids, message ids and any other transport metadata
 * are deliberately excluded, so the same operation hashes identically over HTTP and SQS.
 */
export function computePayloadHash(submission: ValidatedSubmission): string {
  return hashCanonical({
    providerId: submission.providerId,
    externalTransactionId: submission.externalTransactionId,
    playerId: submission.playerId,
    walletId: submission.walletId,
    roundId: submission.roundId,
    gameId: submission.gameId,
    kind: submission.kind,
    money: submission.money.toJSON(),
    referenceExternalTransactionId: submission.referenceExternalTransactionId ?? null,
  });
}
