import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { validateImportedTurnkeyKey, type TurnkeyImportBinding } from './turnkey-import.js';

const ADDRESS = '0x1111111111111111111111111111111111111111' as Address;
const binding: TurnkeyImportBinding = { organizationId: 'org-test', userId: 'user-test', environment: 'testnet' };

function result(overrides: Record<string, unknown> = {}) {
  return {
    privateKeyId: 'key-test-1',
    addresses: [{ format: 'ADDRESS_FORMAT_ETHEREUM', address: ADDRESS }],
    organizationId: binding.organizationId,
    userId: binding.userId,
    environment: binding.environment,
    ...overrides,
  };
}

describe('Turnkey import metadata boundary', () => {
  it('accepts only a provider-bound public key reference', () => {
    expect(validateImportedTurnkeyKey(result(), binding, ADDRESS)).toEqual({ index: 0, address: ADDRESS, signWith: 'key-test-1' });
  });

  it.each([
    ['wrong organization', { organizationId: 'other-org' }],
    ['wrong API user', { userId: 'other-user' }],
    ['wrong environment', { environment: 'production' }],
    ['wrong address', { addresses: [{ format: 'ADDRESS_FORMAT_ETHEREUM', address: '0x2222222222222222222222222222222222222222' }] }],
    ['missing key reference', { privateKeyId: '' }],
  ])('rejects %s without accessing key material', (_label, overrides) => {
    expect(() => validateImportedTurnkeyKey(result(overrides), binding, ADDRESS)).toThrow();
  });
});
