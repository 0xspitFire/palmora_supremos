import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { validateImportedTurnkeyKey, type TurnkeyImportBinding } from './turnkey-import.js';

const ADDRESS = '0x1111111111111111111111111111111111111111' as Address;
const binding: TurnkeyImportBinding = { organizationId: 'org-test', userId: 'user-test', environment: 'testnet' };

function result(overrides: Record<string, unknown> = {}) {
  const base = {
    privateKeyId: 'key-test-1',
    addresses: [{ format: 'ADDRESS_FORMAT_ETHEREUM', address: ADDRESS }],
    activity: {
      organizationId: binding.organizationId,
      status: 'ACTIVITY_STATUS_COMPLETED',
      type: 'ACTIVITY_TYPE_IMPORT_PRIVATE_KEY',
      intent: { importPrivateKeyIntent: { userId: binding.userId } },
      result: { importPrivateKeyResult: { privateKeyId: 'key-test-1', addresses: [{ format: 'ADDRESS_FORMAT_ETHEREUM', address: ADDRESS }] } },
    },
  };
  return { ...base, ...overrides };
}

describe('Turnkey import metadata boundary', () => {
  it('accepts only a provider-bound public key reference', () => {
    expect(validateImportedTurnkeyKey(result(), binding, ADDRESS)).toEqual({ index: 0, address: ADDRESS, signWith: 'key-test-1' });
  });

  it.each([
    ['wrong organization', { activity: { ...result().activity, organizationId: 'other-org' } }],
    ['wrong API user', { activity: { ...result().activity, intent: { importPrivateKeyIntent: { userId: 'other-user' } } } }],
    ['failed activity', { activity: { ...result().activity, status: 'ACTIVITY_STATUS_FAILED' } }],
    ['wrong activity type', { activity: { ...result().activity, type: 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' } }],
    ['mismatched activity result', { activity: { ...result().activity, result: { importPrivateKeyResult: { privateKeyId: 'other-key', addresses: result().addresses } } } }],
    ['wrong address', { addresses: [{ format: 'ADDRESS_FORMAT_ETHEREUM', address: '0x2222222222222222222222222222222222222222' }] }],
    ['missing key reference', { privateKeyId: '' }],
  ])('rejects %s without accessing key material', (_label, overrides) => {
    expect(() => validateImportedTurnkeyKey(result(overrides), binding, ADDRESS)).toThrow();
  });
});
