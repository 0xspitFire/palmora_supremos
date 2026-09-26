import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import { TurnkeySigner, validateTurnkeyWalletMap } from './turnkey-signer.js';
import {
  canonicalPolicyDigest,
  turnkeyPolicyRef,
  validateTurnkeyPolicyAst,
  type TurnkeyPolicyAst,
  type TurnkeyProviderBinding,
} from './turnkey-policy.js';

const WALLET = '0x1111111111111111111111111111111111111111' as Address;
const TO = '0x2222222222222222222222222222222222222222' as Address;
const DATA = '0x161ac21f' as Hex;
const KEY_ID = 'key-test-1';
const ORG = 'org-test';
const USER = 'user-test';
const ENVIRONMENT = 'testnet' as const;

function policy(overrides: Partial<TurnkeyPolicyAst['transaction']> = {}): TurnkeyPolicyAst {
  return {
    version: 1,
    effect: 'allow',
    scope: { provider: 'turnkey', environment: ENVIRONMENT, organizationId: ORG, userId: USER, policyId: 'policy-test', keyIds: [KEY_ID] },
    transaction: {
      chainId: 1,
      from: [WALLET],
      to: TO,
      valueWei: '0',
      data: DATA,
      gasLimitMax: '21000',
      maxFeePerGasMax: '1000000000',
      maxPriorityFeePerGasMax: '100000000',
      accessList: [],
      ...overrides,
    },
  };
}

function binding(ast: TurnkeyPolicyAst): TurnkeyProviderBinding {
  return { provider: 'turnkey', environment: ENVIRONMENT, organizationId: ORG, userId: USER, policyId: ast.scope.policyId, policyDigest: canonicalPolicyDigest(ast) };
}

function intent(overrides: Record<string, unknown> = {}) {
  const ast = policy();
  return {
    chainId: 1 as const,
    from: WALLET,
    to: TO,
    value: 0n,
    data: DATA,
    nonce: 4,
    gasLimit: 21_000n,
    maxFeePerGas: 1_000_000_000n,
    maxPriorityFeePerGas: 100_000_000n,
    accessList: [],
    policyRef: turnkeyPolicyRef(ast.scope.policyId, canonicalPolicyDigest(ast)),
    ...overrides,
  };
}

function clientFor(ast: TurnkeyPolicyAst, overrides: Record<string, unknown> = {}) {
  const provider = binding(ast);
  return {
    signTransaction: async () => ({ signedTransaction: '0x02' }),
    getWhoami: async () => ({ organizationId: ORG, userId: USER, environment: ENVIRONMENT }),
    getPolicies: async () => ({ policies: [{ policyId: ast.scope.policyId, effect: 'EFFECT_ALLOW', digest: provider.policyDigest, ast, providerBinding: provider }] }),
    getPrivateKeys: async () => ({ organizationId: ORG, userId: USER, environment: ENVIRONMENT, privateKeys: [{ privateKeyId: KEY_ID, addresses: [{ format: 'ADDRESS_FORMAT_ETHEREUM', address: WALLET }], organizationId: ORG, userId: USER, environment: ENVIRONMENT }] }),
    ...overrides,
  };
}

function signer(ast = policy(), clientOverrides: Record<string, unknown> = {}) {
  const provider = binding(ast);
  return new TurnkeySigner({
    organizationId: ORG,
    environment: ENVIRONMENT,
    userId: USER,
    wallets: [{ index: 0, address: WALLET, signWith: KEY_ID }],
    policyId: ast.scope.policyId,
    policyDigest: provider.policyDigest,
    policy: ast,
    providerBinding: provider,
    client: clientFor(ast, clientOverrides),
  });
}

describe('Turnkey policy boundary', () => {
  it('uses exact canonical AST/effect/scope and provider/key binding', async () => {
    const ast = policy();
    const report = await signer(ast).probe();
    expect(report).toMatchObject({ provider: 'turnkey', organizationId: ORG, policyId: 'policy-test', policyDigest: canonicalPolicyDigest(ast), providerBinding: binding(ast) });
  });

  it('rejects policy drift, broad AST keys, and provider digest mismatch', async () => {
    const drifted = policy({ maxFeePerGasMax: '1000000001' });
    await expect(signer(policy(), { getPolicies: async () => ({ policies: [{ policyId: 'policy-test', effect: 'EFFECT_ALLOW', digest: canonicalPolicyDigest(drifted), ast: drifted, providerBinding: binding(drifted) }] }) }).probe()).rejects.toThrow('TURNKEY_POLICY_DIGEST_MISMATCH');
    expect(() => validateTurnkeyPolicyAst({ ...policy(), or: [] })).toThrow('TURNKEY_POLICY_AST_INVALID');
    expect(() => validateTurnkeyPolicyAst(policy({ valueWei: '1' }))).toThrow('TURNKEY_POLICY_TRANSACTION_INVALID');
    const wrongProvider = { ...binding(policy()), userId: 'other-user' };
    await expect(signer(policy(), { getPolicies: async () => ({ policies: [{ policyId: 'policy-test', effect: 'EFFECT_ALLOW', digest: binding(policy()).policyDigest, ast: policy(), providerBinding: wrongProvider }] }) }).probe()).rejects.toThrow('TURNKEY_POLICY_PROVIDER_BINDING_INVALID');
    await expect(signer(policy(), { getPolicies: async () => ({ policies: [{ policyId: 'policy-test', effect: 'EFFECT_ALLOW', digest: binding(policy()).policyDigest, ast: policy(), condition: 'allow any transaction OR wildcard', providerBinding: binding(policy()) }] }) }).probe()).rejects.toThrow('TURNKEY_POLICY_SEMANTICS_INVALID');
  });

  it('rejects key/address inventory drift and provider environment drift', async () => {
    await expect(signer(policy(), { getPrivateKeys: async () => ({ organizationId: ORG, userId: USER, environment: ENVIRONMENT, privateKeys: [{ privateKeyId: 'other-key', addresses: [{ address: WALLET }], organizationId: ORG, userId: USER, environment: ENVIRONMENT }] }) }).probe()).rejects.toThrow('TURNKEY_KEY_INVENTORY_BINDING_INVALID');
    await expect(signer(policy(), { getWhoami: async () => ({ organizationId: ORG, userId: 'other-user', environment: ENVIRONMENT }) }).probe()).rejects.toThrow('TURNKEY_PROVIDER_BINDING_MISMATCH');
  });

  it('rejects wallet-map address/signWith collisions and policy scope drift', () => {
    const ast = policy();
    const base = {
      version: 1 as const,
      organizationId: ORG,
      userId: USER,
      environment: ENVIRONMENT,
      policyId: ast.scope.policyId,
      policyDigest: canonicalPolicyDigest(ast),
      policy: ast,
      wallets: [{ index: 0, address: WALLET, signWith: KEY_ID }],
    };
    expect(() => validateTurnkeyWalletMap({ ...base, wallets: [{ ...base.wallets[0]!, index: 0 }, { ...base.wallets[0]!, index: 1, signWith: 'key-test-2' }] })).toThrow('TURNKEY_WALLET_MAP_DUPLICATE');
    expect(() => validateTurnkeyWalletMap({ ...base, wallets: [{ ...base.wallets[0]!, index: 0 }, { ...base.wallets[0]!, index: 1, address: '0x3333333333333333333333333333333333333333' }] })).toThrow('TURNKEY_WALLET_MAP_DUPLICATE');
    expect(() => validateTurnkeyWalletMap({ ...base, policy: { ...ast, scope: { ...ast.scope, keyIds: ['other-key'] } } })).toThrow('TURNKEY_POLICY_PROVIDER_BINDING_INVALID');
  });
});

describe('Turnkey transaction boundary', () => {
  it.each([
    ['wrong chain', { chainId: 4663 }],
    ['wrong from', { from: '0x3333333333333333333333333333333333333333' as Address }],
    ['wrong contract', { to: '0x3333333333333333333333333333333333333333' as Address }],
    ['wrong value', { value: 1n }],
    ['wrong calldata', { data: '0xdeadbeef' as Hex }],
    ['gas above policy', { gasLimit: 21_001n }],
    ['fee above policy', { maxFeePerGas: 1_000_000_001n }],
    ['priority fee above policy', { maxPriorityFeePerGas: 100_000_001n }],
    ['non-empty access list', { accessList: [{ address: TO, storageKeys: [] }] }],
    ['wrong policy reference', { policyRef: 'turnkey:policy-test:0x' + '0'.repeat(64) }],
  ])('rejects %s before any provider signing call', async (_label, overrides) => {
    const calls: string[] = [];
    const testSigner = signer(policy(), { signTransaction: async () => { calls.push('sign'); return { signedTransaction: '0x02' }; } });
    await expect(testSigner.signTransaction(0, intent(overrides))).rejects.toThrow(/TURNKEY_(?:POLICY_(?:INTENT_BLOCKED|REFERENCE_MISMATCH)|SIGNER_WALLET_MISMATCH)/);
    expect(calls).toEqual([]);
    testSigner.zeroize();
  });

  it('does not treat an arbitrary successful response as provider-bound health', async () => {
    const testSigner = signer(policy(), { getPolicies: async () => ({ policies: [] }) });
    await expect(testSigner.probe()).rejects.toThrow('TURNKEY_POLICY_NOT_FOUND');
    testSigner.zeroize();
  });
});
