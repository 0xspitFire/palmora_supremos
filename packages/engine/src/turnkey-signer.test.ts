import { describe, expect, it } from 'vitest';
import { parseTransaction, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { TurnkeySigner, isSecureTurnkeyFileAccess, validateTurnkeyWalletMap, type TurnkeySignerClient } from './turnkey-signer.js';
import { createTurnkeyPolicyRecord, turnkeyPolicyRecordDigest } from './turnkey-policy-record.js';
import { canonicalPolicyDigest, turnkeyPolicyRef, validateTurnkeyPolicyAst, type TurnkeyPolicyAst } from './turnkey-policy.js';

const PRIVATE_KEY = `0x${'11'.repeat(32)}` as Hex;
const ACCOUNT = privateKeyToAccount(PRIVATE_KEY);
const WALLET = ACCOUNT.address;
const TO = '0x2222222222222222222222222222222222222222' as Address;
const DATA = '0x161ac21f' as Hex;
const KEY_ID = 'key-test-1';
const ORG = 'org-test';
const USER = 'user-test';
const ENVIRONMENT = 'testnet' as const;
const timestamp = (seconds: string) => ({ seconds, nanos: '0' });

function policy(overrides: Partial<TurnkeyPolicyAst['transaction']> = {}): TurnkeyPolicyAst {
  return {
    version: 1,
    effect: 'allow',
    scope: { provider: 'turnkey', environment: ENVIRONMENT, organizationId: ORG, userId: USER, policyId: 'policy-test', keyIds: [KEY_ID] },
    transaction: { chainId: 1, from: [WALLET], to: TO, valueWei: '0', data: DATA, gasLimitMax: '50000', maxFeePerGasMax: '1000000000', maxPriorityFeePerGasMax: '100000000', accessList: [], ...overrides },
  };
}

function identity() { return { organizationId: ORG, organizationName: 'MintBot', userId: USER, username: 'runtime' }; }
function providerPolicy() { return { policyId: 'policy-test', policyName: 'exact', effect: 'EFFECT_ALLOW' as const, createdAt: timestamp('1'), updatedAt: timestamp('2'), notes: '', consensus: `user.id == '${USER}'`, condition: "activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2'" }; }
function providerKey() { return { privateKeyId: KEY_ID, publicKey: `02${'ab'.repeat(32)}`, privateKeyName: 'mintbot-key', curve: 'CURVE_SECP256K1', addresses: [{ format: 'ADDRESS_FORMAT_ETHEREUM', address: WALLET }], privateKeyTags: [], createdAt: timestamp('1'), updatedAt: timestamp('2'), exported: false, imported: true }; }

function record(ast = policy()) {
  return createTurnkeyPolicyRecord({ environment: ENVIRONMENT, providerIdentity: identity(), providerPolicy: providerPolicy(), enforcementPolicy: ast, walletReferences: [{ index: 0, address: WALLET, signWith: KEY_ID }], providerKeys: [providerKey()], issuedAt: '2025-01-01T00:00:00.000Z', expiresAt: '2035-01-01T00:00:00.000Z' });
}

function intent(overrides: Record<string, unknown> = {}) {
  const ast = policy();
  return { chainId: 1 as const, from: WALLET, to: TO, value: 0n, data: DATA, nonce: 4, gasLimit: 50_000n, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 100_000_000n, accessList: [], policyRef: turnkeyPolicyRef(ast.scope.policyId, canonicalPolicyDigest(ast)), ...overrides };
}

function clientFor(overrides: Partial<TurnkeySignerClient> = {}): TurnkeySignerClient {
  return {
    async signTransaction(input) {
      const unsigned = parseTransaction(input.unsignedTransaction as Hex);
      const signedTransaction = await ACCOUNT.signTransaction(unsigned);
      return { signedTransaction, activity: { id: 'activity-1', organizationId: ORG, status: 'ACTIVITY_STATUS_COMPLETED', type: 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2', fingerprint: 'fingerprint-1', appProofs: [], intent: { signTransactionIntentV2: { signWith: input.signWith, unsignedTransaction: input.unsignedTransaction, type: input.type } }, result: { signTransactionResult: { signedTransaction } } } };
    },
    getWhoami: async () => identity(),
    getPolicies: async () => ({ policies: [providerPolicy()] }),
    getPrivateKeys: async () => ({ privateKeys: [providerKey()] }),
    ...overrides,
  };
}

function signer(ast = policy(), clientOverrides: Partial<TurnkeySignerClient> = {}) {
  return new TurnkeySigner({ organizationId: ORG, environment: ENVIRONMENT, userId: USER, wallets: [{ index: 0, address: WALLET, signWith: KEY_ID }], policyRecord: record(ast), client: clientFor(clientOverrides) });
}

describe('Turnkey policy boundary', () => {
  it('accepts local 0600 and production root-owned 0440 files while rejecting writable or public modes', () => {
    expect(isSecureTurnkeyFileAccess({ mode: 0o100600, uid: 1000, gid: 1000 }, 1000, [1000])).toBe(true);
    expect(isSecureTurnkeyFileAccess({ mode: 0o100440, uid: 0, gid: 1000 }, 1000, [1000])).toBe(true);
    expect(isSecureTurnkeyFileAccess({ mode: 0o100460, uid: 0, gid: 1000 }, 1000, [1000])).toBe(false);
    expect(isSecureTurnkeyFileAccess({ mode: 0o100444, uid: 0, gid: 1000 }, 1000, [1000])).toBe(false);
    expect(isSecureTurnkeyFileAccess({ mode: 0o100440, uid: 0, gid: 2000 }, 1000, [1000])).toBe(false);
  });

  it('validates actual SDK responses against the canonical record', async () => {
    const report = await signer().probe();
    expect(report).toMatchObject({ provider: 'turnkey', organizationId: ORG, policyId: 'policy-test', policyDigest: canonicalPolicyDigest(policy()), policyRecordDigest: turnkeyPolicyRecordDigest(record()) });
  });

  it('rejects provider policy, identity, and key drift', async () => {
    await expect(signer(policy(), { getPolicies: async () => ({ policies: [{ ...providerPolicy(), condition: 'true' }] }) }).probe()).rejects.toThrow('TURNKEY_PROVIDER_POLICY_DRIFT');
    await expect(signer(policy(), { getWhoami: async () => ({ ...identity(), userId: 'other-user' }) }).probe()).rejects.toThrow('TURNKEY_PROVIDER_IDENTITY_DRIFT');
    await expect(signer(policy(), { getPrivateKeys: async () => ({ privateKeys: [{ ...providerKey(), exported: true }] }) }).probe()).rejects.toThrow('TURNKEY_PROVIDER_KEY_DRIFT');
  });

  it('rechecks signed-record expiry before every provider operation', async () => {
    const expiredRecord = { ...record(), issuedAt: '2024-01-01T00:00:00.000Z', expiresAt: '2025-01-01T00:00:00.000Z' };
    const calls: string[] = [];
    const expiredSigner = new TurnkeySigner({
      organizationId: ORG,
      environment: ENVIRONMENT,
      userId: USER,
      wallets: [{ index: 0, address: WALLET, signWith: KEY_ID }],
      policyRecord: expiredRecord,
      client: clientFor({ signTransaction: async () => { calls.push('sign'); throw new Error('unexpected'); }, getWhoami: async () => { calls.push('probe'); return identity(); } }),
    });
    await expect(expiredSigner.signTransaction(0, intent())).rejects.toThrow('TURNKEY_POLICY_RECORD_NOT_CURRENT');
    await expect(expiredSigner.probe()).rejects.toThrow('TURNKEY_POLICY_RECORD_NOT_CURRENT');
    expect(calls).toEqual([]);
  });

  it('accepts only a strict version-2 wallet map', () => {
    const map = { version: 2, policyRecordDigest: turnkeyPolicyRecordDigest(record()), wallets: [{ index: 0, address: WALLET, signWith: KEY_ID }] };
    expect(validateTurnkeyWalletMap(map)).toEqual(map);
    expect(() => validateTurnkeyWalletMap({ ...map, version: 1 })).toThrow('TURNKEY_WALLET_MAP_INVALID');
    expect(() => validateTurnkeyWalletMap({ ...map, policyRecordDigest: 'sha256:bad' })).toThrow('TURNKEY_WALLET_MAP_INVALID');
    expect(() => validateTurnkeyPolicyAst({ ...policy(), or: [] })).toThrow('TURNKEY_POLICY_AST_INVALID');
  });

  it('preserves each explicitly supported chain in the canonical policy', () => {
    for (const chainId of [1, 8453, 4663] as const) {
      expect(validateTurnkeyPolicyAst({ ...policy(), transaction: { ...policy().transaction, chainId } }).transaction.chainId).toBe(chainId);
    }
  });
});

describe('Turnkey transaction boundary', () => {
  it.each([
    ['wrong chain', { chainId: 4663 }],
    ['wrong from', { from: '0x3333333333333333333333333333333333333333' as Address }],
    ['wrong contract', { to: '0x3333333333333333333333333333333333333333' as Address }],
    ['wrong value', { value: 1n }],
    ['wrong calldata', { data: '0xdeadbeef' as Hex }],
    ['gas above policy', { gasLimit: 50_001n }],
    ['fee above policy', { maxFeePerGas: 1_000_000_001n }],
    ['priority fee above policy', { maxPriorityFeePerGas: 100_000_001n }],
    ['non-empty access list', { accessList: [{ address: TO, storageKeys: [] }] }],
    ['wrong policy reference', { policyRef: 'turnkey:policy-test:0x' + '0'.repeat(64) }],
  ])('rejects %s before any provider signing call', async (_label, overrides) => {
    const calls: string[] = [];
    const testSigner = signer(policy(), { signTransaction: async () => { calls.push('sign'); throw new Error('unexpected'); } });
    await expect(testSigner.signTransaction(0, intent(overrides))).rejects.toThrow(/TURNKEY_(?:POLICY_(?:INTENT_BLOCKED|REFERENCE_MISMATCH)|SIGNER_WALLET_MISMATCH)/);
    expect(calls).toEqual([]);
  });

  it('validates the returned transaction and completed provider activity', async () => {
    const result = await signer().signTransactionWithEvidence(0, intent());
    expect(result.signedTransaction).toMatch(/^0x/);
    expect(result.evidence).toEqual({ activityId: 'activity-1', activityFingerprint: 'fingerprint-1', appProofCount: 0 });
  });

  it('treats omitted canonical zero fields as zero for the non-broadcast rehearsal', async () => {
    const result = await signer().signTransactionWithEvidence(0, intent({
      nonce: Number.MAX_SAFE_INTEGER,
      gasLimit: 0n,
      maxFeePerGas: 0n,
      maxPriorityFeePerGas: 0n,
    }));
    const signed = parseTransaction(result.signedTransaction);
    expect(signed.gas).toBeUndefined();
    expect(signed.maxFeePerGas).toBeUndefined();
    expect(signed.maxPriorityFeePerGas).toBeUndefined();
    expect(result.evidence.activityId).toBe('activity-1');
  });

  it('rejects a signed response whose provider activity is not exact', async () => {
    const normal = clientFor();
    const testSigner = signer(policy(), { signTransaction: async (input) => { const response = await normal.signTransaction(input); return { ...response, activity: { ...response.activity, status: 'ACTIVITY_STATUS_FAILED' } }; } });
    await expect(testSigner.signTransaction(0, intent())).rejects.toThrow('TURNKEY_SIGNING_ACTIVITY_INVALID');
  });

  it('rejects malformed app-proof evidence instead of trusting a length property', async () => {
    const normal = clientFor();
    const testSigner = signer(policy(), { signTransaction: async (input) => { const response = await normal.signTransaction(input); return { ...response, activity: { ...response.activity, appProofs: { length: 1 } } } as unknown as Awaited<ReturnType<TurnkeySignerClient['signTransaction']>>; } });
    await expect(testSigner.signTransaction(0, intent())).rejects.toThrow('TURNKEY_SIGNING_ACTIVITY_INVALID');
  });
});
