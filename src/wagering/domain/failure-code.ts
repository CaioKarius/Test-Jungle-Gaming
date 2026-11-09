/**
 * Stable, machine-readable failure taxonomy. Codes are part of the public contract:
 * never rename one, only add new ones. See ARCHITECTURE.md §"Failure codes".
 */
export enum FailureCode {
  // --- REJECTED: business rule violations ---------------------------------------------
  /** BET: wallet balance is lower than the stake. */
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  /** ROLLBACK that would debit the wallet below zero (operationally different from a BET without funds). */
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',
  /** Operation currency differs from the wallet currency. */
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  /** `playerId` differs from the wallet owner. */
  PlayerMismatch = 'PLAYER_MISMATCH',
  /** Referenced transaction never arrived within the retry budget. */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  /** Referenced transaction exists but was REJECTED/FAILED (or never became processable). */
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  /** Reference belongs to another provider / player / wallet / currency / round. */
  ReferenceContextMismatch = 'REFERENCE_CONTEXT_MISMATCH',
  /** Reference kind not allowed for this operation (e.g. REFUND of a WIN). */
  InvalidReferenceKind = 'INVALID_REFERENCE_KIND',
  /** REFUND/ROLLBACK amount differs from the referenced amount (partial reversals are out of scope). */
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',
  /** The reference was already reverted by a processed REFUND/ROLLBACK. */
  AlreadyReversed = 'ALREADY_REVERSED',

  // --- FAILED: permanent infrastructure / invariant errors ----------------------------
  InfrastructureFailure = 'INFRASTRUCTURE_FAILURE',
  InvariantViolation = 'INVARIANT_VIOLATION',
}

/** What the provider should do on seeing a given code. */
export type ProviderAction =
  | 'RESEND_AS_NEW_TRANSACTION' // same intent may succeed later, but needs a new externalTransactionId
  | 'FIX_PAYLOAD' // the request is wrong; correct it and send as a new transaction
  | 'GIVE_UP' // nothing left to do — the outcome is final and correct
  | 'CONTACT_SUPPORT'; // needs a human; do not retry blindly

export const PROVIDER_ACTION: Readonly<Record<FailureCode, ProviderAction>> = {
  [FailureCode.InsufficientFunds]: 'RESEND_AS_NEW_TRANSACTION',
  [FailureCode.ReversalInsufficientFunds]: 'CONTACT_SUPPORT',
  [FailureCode.CurrencyMismatch]: 'FIX_PAYLOAD',
  [FailureCode.PlayerMismatch]: 'FIX_PAYLOAD',
  [FailureCode.ReferenceNotFound]: 'FIX_PAYLOAD',
  [FailureCode.ReferenceNotProcessed]: 'GIVE_UP',
  [FailureCode.ReferenceContextMismatch]: 'FIX_PAYLOAD',
  [FailureCode.InvalidReferenceKind]: 'FIX_PAYLOAD',
  [FailureCode.ReferenceAmountMismatch]: 'FIX_PAYLOAD',
  [FailureCode.AlreadyReversed]: 'GIVE_UP',
  [FailureCode.InfrastructureFailure]: 'CONTACT_SUPPORT',
  [FailureCode.InvariantViolation]: 'CONTACT_SUPPORT',
};
