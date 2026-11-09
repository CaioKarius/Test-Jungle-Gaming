import { describe, expect, test } from 'bun:test';
import { computePayloadHash } from '../../src/application/payload-hash';
import { validateSubmission } from '../../src/application/validation';
import { ValidationError } from '../../src/application/errors';
import { canonicalJson } from '../../src/shared/canonical';

const W = '00000000-0000-7000-8000-000000000001';
const data = () => ({
  providerId: 'a', externalTransactionId: 'x', playerId: 'p', walletId: W, roundId: 'r', gameId: 'g',
  kind: 'BET', money: { amount: '25.00', currency: 'BRL' },
});
const hash = (d: unknown, key = 'a:x') => computePayloadHash(validateSubmission(key, d));

describe('payload hash', () => {
  test('canonical JSON sorts keys recursively', () => {
    expect(canonicalJson({ b: 1, a: { d: 1, c: 2 } })).toBe('{"a":{"c":2,"d":1},"b":1}');
  });
  test('independent of key order and of the idempotency key header', () => {
    const reordered = { money: { currency: 'BRL', amount: '25.00' }, kind: 'BET', gameId: 'g', roundId: 'r', walletId: W, playerId: 'p', externalTransactionId: 'x', providerId: 'a' };
    expect(hash(reordered)).toBe(hash(data()));
    expect(hash(data(), 'other-key')).toBe(hash(data()));
  });
  test('amount is normalised, so "25" equals "25.00"', () => {
    expect(hash({ ...data(), money: { amount: '25', currency: 'BRL' } })).toBe(hash(data()));
  });
  test('any business field changes the hash', () => {
    expect(hash({ ...data(), money: { amount: '25.01', currency: 'BRL' } })).not.toBe(hash(data()));
    expect(hash({ ...data(), roundId: 'r2' })).not.toBe(hash(data()));
  });
  test('is a 64-char hex sha256', () => {
    expect(hash(data())).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('submission validation', () => {
  test('OPENING cannot be submitted', () => {
    expect(() => hash({ ...data(), kind: 'OPENING' })).toThrow(ValidationError);
  });
  test('missing idempotency key / bad wallet id / bad money / missing reference', () => {
    expect(() => validateSubmission(undefined, data())).toThrow(ValidationError);
    expect(() => hash({ ...data(), walletId: 'nope' })).toThrow(ValidationError);
    expect(() => hash({ ...data(), money: { amount: '1e3', currency: 'BRL' } })).toThrow(ValidationError);
    expect(() => hash({ ...data(), money: { amount: '0.00', currency: 'BRL' } })).toThrow(ValidationError);
    expect(() => hash({ ...data(), kind: 'REFUND' })).toThrow(ValidationError);
    expect(() => hash({ ...data(), kind: 'BET', referenceExternalTransactionId: 'y' })).toThrow(ValidationError);
    expect(() => hash('not an object')).toThrow(ValidationError);
  });
});
