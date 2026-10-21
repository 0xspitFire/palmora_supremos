import { generateKeyPairSync, sign as signBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import {
  canonicalTurnkeyPolicyRecordJson,
  createTurnkeyPolicyRecord,
  projectTurnkeyProviderKey,
  signTurnkeyPolicyRecord,
  turnkeyPolicyApproverKeyId,
  turnkeyProviderPolicyExpressions,
  validateTurnkeyActualProviderState,
  validateTurnkeyCanonicalPolicyRecord,
  verifyTurnkeySignedPolicyRecord,
} from './turnkey-policy-record.js';
import type { TurnkeyPolicyAst } from './turnkey-policy.js';

const ORG = 'org-1';
const USER = 'user-1';
const POLICY_ID = 'policy-1';
const KEY_ID = 'key-1';
const WALLET = '0x1111111111111111111111111111111111111111' as Address;
const TO = '0x2222222222222222222222222222222222222222' as Address;
const NOW = new Date('2030-06-01T00:00:00.000Z');

const timestamp = (seconds: string) => ({ seconds, nanos: '0' });

function identity() {
  return { organizationId: ORG, organizationName: 'MintBot', userId: USER, username: 'mintbot-runtime' };
}

function organization(rootUserIds = ['root-user']) {
  return { configs: { quorum: { threshold: 1, userIds: rootUserIds } } };
}

function providerPolicy() {
  const expressions = turnkeyProviderPolicyExpressions(enforcementPolicy());
  return {
    policyId: POLICY_ID,
    policyName: 'MintBot exact transaction',
    effect: 'EFFECT_ALLOW' as const,
    createdAt: timestamp('1800000000'),
    updatedAt: timestamp('1800000001'),
    notes: 'Reviewed production policy',
    consensus: expressions.consensus,
    condition: expressions.condition,
  };
}

function providerKey(id = KEY_ID, address = WALLET) {
  return {
    privateKeyId: id,
    publicKey: `02${'ab'.repeat(32)}`,
    privateKeyName: `mintbot-${id}`,
    curve: 'CURVE_SECP256K1',
    addresses: [{ format: 'ADDRESS_FORMAT_ETHEREUM', address }],
    privateKeyTags: ['tag-b', 'tag-a'],
    createdAt: timestamp('1800000000'),
    updatedAt: timestamp('1800000001'),
    exported: false,
    imported: true,
  };
}

function enforcementPolicy(): TurnkeyPolicyAst {
  return {
    version: 1,
    effect: 'allow',
    scope: { provider: 'turnkey', environment: 'production', organizationId: ORG, userId: USER, policyId: POLICY_ID, keyIds: [KEY_ID] },
    transaction: {
      chainId: 1,
      from: [WALLET],
      to: TO,
      valueWei: '0',
      data: '0x161ac21f' as Hex,
      gasLimitMax: '200000',
      maxFeePerGasMax: '1000000000',
      maxPriorityFeePerGasMax: '100000000',
      accessList: [],
    },
  };
}

function record() {
  return createTurnkeyPolicyRecord({
    environment: 'production',
    providerIdentity: identity(),
    providerPolicy: providerPolicy(),
    enforcementPolicy: enforcementPolicy(),
    walletReferences: [{ index: 0, address: WALLET, signWith: KEY_ID }],
    providerKeys: [providerKey()],
    issuedAt: '2030-01-01T00:00:00.000Z',
    expiresAt: '2031-01-01T00:00:00.000Z',
  });
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('Turnkey signed canonical policy record', () => {
  it('renders the reviewed provider CEL exactly', () => {
    expect(turnkeyProviderPolicyExpressions(enforcementPolicy())).toEqual({
      consensus: "approvers.any(user, user.id == 'user-1')",
      condition: "activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && private_key.id in ['key-1'] && eth.tx.chain_id == 1 && eth.tx.from in ['0x1111111111111111111111111111111111111111'] && eth.tx.to == '0x2222222222222222222222222222222222222222' && eth.tx.value == 0 && eth.tx.data == '0x161ac21f' && eth.tx.gas <= 200000 && eth.tx.max_fee_per_gas <= 1000000000 && eth.tx.max_priority_fee_per_gas <= 100000000",
    });
  });

  it('normalizes actual SDK response projections and verifies with a separately pinned Ed25519 key', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const canonical = record();
    const signed = signTurnkeyPolicyRecord(canonical, privateKey);
    expect(signed.keyId).toBe(turnkeyPolicyApproverKeyId(publicKey));
    expect(signed).not.toHaveProperty('publicKey');
    expect(verifyTurnkeySignedPolicyRecord(signed, publicKey, NOW)).toEqual(canonical);
    expect(canonical.providerPolicy.time).toBeNull();
    expect(canonical.wallets[0]!.providerKey.privateKeyTags).toEqual(['tag-a', 'tag-b']);
    expect(canonicalTurnkeyPolicyRecordJson(clone(canonical))).toBe(canonicalTurnkeyPolicyRecordJson(canonical));
  });

  it('rejects tampering, the wrong key, an attacker-supplied key, and a signature without the domain separator', () => {
    const owner = generateKeyPairSync('ed25519');
    const attacker = generateKeyPairSync('ed25519');
    const signed = signTurnkeyPolicyRecord(record(), owner.privateKey);

    const tampered = clone(signed) as unknown as { record: { providerPolicy: { condition: string } } };
    tampered.record.providerPolicy.condition = 'true';
    expect(() => verifyTurnkeySignedPolicyRecord(tampered, owner.publicKey, NOW)).toThrow(/BINDING_INVALID|DIGEST_MISMATCH|SIGNATURE_INVALID/);
    expect(() => verifyTurnkeySignedPolicyRecord(signed, attacker.publicKey, NOW)).toThrow('TURNKEY_POLICY_SIGNATURE_INVALID');
    expect(() => verifyTurnkeySignedPolicyRecord({ ...signed, publicKey: attacker.publicKey.export({ type: 'spki', format: 'pem' }) }, owner.publicKey, NOW)).toThrow('TURNKEY_POLICY_SIGNATURE_INVALID');

    const wrongDomain = clone(signed) as unknown as { record: ReturnType<typeof record>; signature: string };
    wrongDomain.signature = signBytes(null, Buffer.from(canonicalTurnkeyPolicyRecordJson(wrongDomain.record)), owner.privateKey).toString('base64url');
    expect(() => verifyTurnkeySignedPolicyRecord(wrongDomain, owner.publicKey, NOW)).toThrow('TURNKEY_POLICY_SIGNATURE_INVALID');
  });

  it('rejects records outside their signed validity interval', () => {
    const owner = generateKeyPairSync('ed25519');
    const signed = signTurnkeyPolicyRecord(record(), owner.privateKey);
    expect(() => verifyTurnkeySignedPolicyRecord(signed, owner.publicKey, new Date('2029-12-31T23:59:59.999Z'))).toThrow('TURNKEY_POLICY_RECORD_NOT_CURRENT');
    expect(() => verifyTurnkeySignedPolicyRecord(signed, owner.publicKey, new Date('2031-01-01T00:00:00.000Z'))).toThrow('TURNKEY_POLICY_RECORD_NOT_CURRENT');
  });

  it.each([
    ['policy id', (policy: ReturnType<typeof providerPolicy>) => ({ ...policy, policyId: 'policy-2' })],
    ['effect', (policy: ReturnType<typeof providerPolicy>) => ({ ...policy, effect: 'EFFECT_DENY' as const })],
    ['condition', (policy: ReturnType<typeof providerPolicy>) => ({ ...policy, condition: 'true' })],
    ['consensus', (policy: ReturnType<typeof providerPolicy>) => ({ ...policy, consensus: 'true' })],
    ['time', (policy: ReturnType<typeof providerPolicy>) => ({ ...policy, time: 'now() < 1' })],
    ['updated timestamp', (policy: ReturnType<typeof providerPolicy>) => ({ ...policy, updatedAt: timestamp('1800000002') })],
  ])('detects provider %s drift', (_label, mutate) => {
    const canonical = record();
    expect(() => validateTurnkeyActualProviderState(canonical, {
      whoami: identity(),
      organization: organization(),
      policies: [mutate(providerPolicy())],
      privateKeys: [providerKey()],
    })).toThrow('TURNKEY_PROVIDER_POLICY_DRIFT');
  });

  it('detects authenticated identity and provider key drift while allowing unrelated organization keys', () => {
    const canonical = record();
    expect(() => validateTurnkeyActualProviderState(canonical, { whoami: { ...identity(), userId: 'other-user' }, organization: organization(), policies: [providerPolicy()], privateKeys: [providerKey()] })).toThrow('TURNKEY_PROVIDER_IDENTITY_DRIFT');
    expect(() => validateTurnkeyActualProviderState(canonical, { whoami: identity(), organization: organization(), policies: [providerPolicy()], privateKeys: [{ ...providerKey(), publicKey: `03${'cd'.repeat(32)}` }] })).toThrow('TURNKEY_PROVIDER_KEY_DRIFT');
    expect(() => validateTurnkeyActualProviderState(canonical, { whoami: identity(), organization: organization(), policies: [providerPolicy()], privateKeys: [{ ...providerKey(), exported: true }] })).toThrow('TURNKEY_PROVIDER_KEY_DRIFT');
    expect(() => validateTurnkeyActualProviderState(canonical, { whoami: identity(), organization: organization(), policies: [providerPolicy()], privateKeys: [providerKey(), providerKey('unrelated', '0x3333333333333333333333333333333333333333' as Address)] })).not.toThrow();
  });

  it('requires an isolated sole provider policy and a non-root runtime user', () => {
    const canonical = record();
    expect(() => validateTurnkeyActualProviderState(canonical, { whoami: identity(), organization: organization(), policies: [providerPolicy(), { ...providerPolicy(), policyId: 'broad-policy', condition: 'true' }], privateKeys: [providerKey()] })).toThrow('TURNKEY_PROVIDER_POLICY_INVENTORY_NOT_ISOLATED');
    expect(() => validateTurnkeyActualProviderState(canonical, { whoami: identity(), organization: organization([USER]), policies: [providerPolicy()], privateKeys: [providerKey()] })).toThrow('TURNKEY_PROVIDER_RUNTIME_USER_MUST_BE_NON_ROOT');
  });

  it('rejects a duplicate provider key, wallet binding drift, and an unbound embedded approver key', () => {
    const canonical = record();
    expect(() => validateTurnkeyActualProviderState(canonical, { whoami: identity(), organization: organization(), policies: [providerPolicy()], privateKeys: [providerKey(), providerKey()] })).toThrow('TURNKEY_PROVIDER_KEY_DUPLICATE');
    expect(() => validateTurnkeyCanonicalPolicyRecord({ ...canonical, wallets: [{ ...canonical.wallets[0]!, signWith: 'other-key' }] })).toThrow('TURNKEY_POLICY_RECORD_KEY_BINDING_INVALID');
    expect(() => validateTurnkeyCanonicalPolicyRecord({ ...canonical, wallets: [{ ...canonical.wallets[0]!, providerKey: { ...canonical.wallets[0]!.providerKey, exported: true } }] })).toThrow('TURNKEY_POLICY_RECORD_KEY_BINDING_INVALID');
    expect(() => validateTurnkeyCanonicalPolicyRecord({ ...canonical, approverPublicKey: 'attacker-controlled' })).toThrow('TURNKEY_POLICY_RECORD_INVALID');
  });

  it('fails closed on SDK shape changes and malformed key metadata', () => {
    expect(() => projectTurnkeyProviderKey({ ...providerKey(), organizationId: ORG })).toThrow('TURNKEY_PROVIDER_KEY_INVALID');
    expect(() => projectTurnkeyProviderKey({ ...providerKey(), privateKeyTags: ['duplicate', 'duplicate'] })).toThrow('TURNKEY_PROVIDER_KEY_INVALID');
    expect(() => projectTurnkeyProviderKey({ ...providerKey(), updatedAt: { seconds: '01', nanos: '0' } })).toThrow('TURNKEY_PROVIDER_TIMESTAMP_INVALID');
    expect(projectTurnkeyProviderKey({ ...providerKey(), updatedAt: null }).updatedAt).toBeNull();
  });
});
