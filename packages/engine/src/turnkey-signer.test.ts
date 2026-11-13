import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { encodeFunctionData, parseTransaction, parseAbi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { TurnkeySigner, isSecureTurnkeyFileAccess, validateTurnkeyWalletMap, parseTurnkeyFundingCredentialText, readTurnkeyFundingCredentials, type TurnkeySignerClient } from './turnkey-signer.js';
import { createTurnkeyPolicyRecord, turnkeyPolicyRecordDigest, turnkeyProviderPolicyExpressions } from './turnkey-policy-record.js';
import { canonicalPolicyDigest, turnkeyPolicyRef, validateTurnkeyPolicyAst, type TurnkeyPolicyAst } from './turnkey-policy.js';
import { OPENSEA_FEE_COLLECTOR, SEADROP_V1_ADDRESS } from './chains.js';
import { allowlistLeaf } from './allowlist.js';
import { buildAllowlistMint, type VerifiedWalletProof } from './allowlist-authority.js';
import { createTurnkeyWalletAdminPolicyRecord, signTurnkeyWalletAdminPolicyRecord, verifyTurnkeyWalletAdminPolicyRecord, turnkeyWalletAdminPolicyExpressions } from './turnkey-wallet-admin-policy.js';

describe('optional wallet admin records at the actual mint signing boundary', () => {
  function setup() {
    const owner = generateKeyPairSync('ed25519'); const now = new Date();
    const expressions = turnkeyWalletAdminPolicyExpressions({ adminUserId: 'distinct-admin' });
    let adminPolicy = { policyId: 'admin-only', policyName: 'create-import-only', createdAt: timestamp('1'), updatedAt: timestamp('2'), notes: '', ...expressions };
    const adminRecord = createTurnkeyWalletAdminPolicyRecord({ environment: ENVIRONMENT, organizationId: ORG, adminUserId: 'distinct-admin', mintRuntimeUserId: USER, providerPolicy: adminPolicy, issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString() });
    const verified = verifyTurnkeyWalletAdminPolicyRecord(signTurnkeyWalletAdminPolicyRecord(adminRecord, owner.privateKey), owner.publicKey, now);
    const client = clientFor({ getPolicies: async () => ({ policies: [providerPolicy(), adminPolicy] }) });
    const signing = vi.spyOn(client, 'signTransaction');
    const mintRecord = record();
    const instance = new TurnkeySigner({ organizationId: ORG, environment: ENVIRONMENT, userId: USER, wallets: [{ index: 0, address: WALLET, signWith: KEY_ID }], policyRecord: mintRecord, approvedPolicyRecords: [mintRecord], walletAdminPolicyRecords: [verified], client });
    return { instance, client, signing, now, adminRecord, verified, drift: () => { adminPolicy = { ...adminPolicy, condition: "activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2'" }; } };
  }

  it('accepts only the separately verified non-signing policy and still signs the original exact mint intent', async () => {
    const f = setup();
    await expect(f.instance.probe()).resolves.toMatchObject({ status: 'ok', policyId: 'policy-test' });
    await expect(f.instance.signTransaction(0, intent())).resolves.toMatch(/^0x/);
    expect(f.signing).toHaveBeenCalledOnce();
  });

  it('rechecks actual admin DSL drift before every provider signature', async () => {
    const f = setup(); await f.instance.probe(); f.drift();
    await expect(f.instance.signTransaction(0, intent())).rejects.toThrow('PROVIDER_POLICY_DRIFT');
    expect(f.signing).not.toHaveBeenCalled();
  });

  it('refuses unsigned records and expiry crossing during the awaited inventory query', async () => {
    const f = setup();
    expect(() => new TurnkeySigner({ organizationId: ORG, environment: ENVIRONMENT, userId: USER, wallets: [{ index: 0, address: WALLET, signWith: KEY_ID }], policyRecord: record(), walletAdminPolicyRecords: [f.adminRecord], client: f.client })).toThrow('SIGNATURE_VERIFICATION_REQUIRED');
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(f.now);
      const read = f.client.getPolicies.bind(f.client);
      f.client.getPolicies = async input => { const response = await read(input); vi.setSystemTime(new Date(f.adminRecord.expiresAt)); return response; };
      await expect(f.instance.signTransaction(0, intent())).rejects.toThrow('RECORD_NOT_CURRENT');
      expect(f.signing).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});

describe('dedicated funding credentials decoder', () => {
  const synthetic = () => ['TURNKEY_ORGANIZATION_ID=org-funding', 'TURNKEY_USER_ID=user-funding', 'TURNKEY_API_PUBLIC_KEY=synthetic', 'TURNKEY_API_PRIVATE_KEY=synthetic', 'TURNKEY_ENVIRONMENT=production'].join('\n');
  it('decodes only funding fields without wallet maps, mint records or fallback configuration', () => {
    expect(parseTurnkeyFundingCredentialText(synthetic())).toEqual({ organizationId: 'org-funding', userId: 'user-funding', apiPublicKey: 'synthetic', apiPrivateKey: 'synthetic', environment: 'production' });
    expect(() => parseTurnkeyFundingCredentialText(`${synthetic()}\nTURNKEY_POLICY_RECORD_PATH=unused`)).toThrow('CREDENTIAL_INVALID');
    expect(() => parseTurnkeyFundingCredentialText(`${synthetic()}\nTURNKEY_USER_ID=other`)).toThrow('CREDENTIAL_INVALID');
    expect(() => parseTurnkeyFundingCredentialText(synthetic().replace('production', 'testnet'))).toThrow('CREDENTIAL_INVALID');
  });
  it('rejects mint/default/relative paths before any credential read', async () => {
    await expect(readTurnkeyFundingCredentials('turnkey-funding.env')).rejects.toThrow('CREDENTIAL_PATH_INVALID');
    await expect(readTurnkeyFundingCredentials('/tmp/turnkey.env')).rejects.toThrow('CREDENTIAL_PATH_INVALID');
    await expect(readTurnkeyFundingCredentials('/tmp/turnkey-wallet-admin.env')).rejects.toThrow('CREDENTIAL_PATH_INVALID');
  });
});

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

function familyPolicy(): TurnkeyPolicyAst {
  return {
    version: 1,
    effect: 'allow',
    scope: { provider: 'turnkey', environment: ENVIRONMENT, organizationId: ORG, userId: USER, policyId: 'policy-family', keyIds: [KEY_ID] },
    transaction: { chainId: 4663, from: [WALLET], to: SEADROP_V1_ADDRESS, valueWei: '0', data: DATA, gasLimitMax: '50000', maxFeePerGasMax: '1000000000', maxPriorityFeePerGasMax: '100000000', accessList: [] },
    family: { kind: 'robinhood-seadrop-public-v1', maxQuantity: 4 },
  };
}

function identity() { return { organizationId: ORG, organizationName: 'MintBot', userId: USER, username: 'runtime' }; }
function organization(rootUserIds = ['root-user']) { return { configs: { quorum: { threshold: 1, userIds: rootUserIds } } }; }
function providerPolicy(ast = policy()) { const expressions = turnkeyProviderPolicyExpressions(ast); return { policyId: ast.scope.policyId, policyName: 'exact', effect: 'EFFECT_ALLOW' as const, createdAt: timestamp('1'), updatedAt: timestamp('2'), notes: '', consensus: expressions.consensus, condition: expressions.condition }; }
function providerKey() { return { privateKeyId: KEY_ID, publicKey: `02${'ab'.repeat(32)}`, privateKeyName: 'mintbot-key', curve: 'CURVE_SECP256K1', addresses: [{ format: 'ADDRESS_FORMAT_ETHEREUM', address: WALLET }], privateKeyTags: [], createdAt: timestamp('1'), updatedAt: timestamp('2'), exported: false, imported: true }; }

function record(ast = policy()) {
  return createTurnkeyPolicyRecord({ environment: ENVIRONMENT, providerIdentity: identity(), providerPolicy: providerPolicy(ast), enforcementPolicy: ast, walletReferences: [{ index: 0, address: WALLET, signWith: KEY_ID }], providerKeys: [providerKey()], issuedAt: '2025-01-01T00:00:00.000Z', expiresAt: '2035-01-01T00:00:00.000Z' });
}

function intent(overrides: Record<string, unknown> = {}) {
  const ast = policy();
  return { chainId: 1 as const, from: WALLET, to: TO, value: 0n, data: DATA, nonce: 4, gasLimit: 50_000n, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 100_000_000n, accessList: [], policyRef: turnkeyPolicyRef(ast.scope.policyId, canonicalPolicyDigest(ast)), ...overrides };
}

function familyIntent(ast = familyPolicy(), overrides: Record<string, unknown> = {}) {
  const data = encodeFunctionData({ abi: parseAbi(['function mintPublic(address,address,address,uint256)']), functionName: 'mintPublic', args: ['0x3333333333333333333333333333333333333333', '0x4444444444444444444444444444444444444444', '0x0000000000000000000000000000000000000000', 4n] });
  return { chainId: 4663 as const, from: WALLET, to: SEADROP_V1_ADDRESS, value: 0n, data, nonce: 4, gasLimit: 50_000n, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 100_000_000n, accessList: [], familyContext: { nftContract: '0x3333333333333333333333333333333333333333' as Address, feeRecipient: '0x4444444444444444444444444444444444444444' as Address }, policyRef: turnkeyPolicyRef(ast.scope.policyId, canonicalPolicyDigest(ast)), ...overrides };
}

function clientFor(overrides: Partial<TurnkeySignerClient> = {}): TurnkeySignerClient {
  return {
    async signTransaction(input) {
      const unsigned = parseTransaction(input.unsignedTransaction as Hex);
      const signedTransaction = await ACCOUNT.signTransaction(unsigned);
      return { signedTransaction, activity: { id: 'activity-1', organizationId: ORG, status: 'ACTIVITY_STATUS_COMPLETED', type: 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2', fingerprint: 'fingerprint-1', appProofs: [], intent: { signTransactionIntentV2: { signWith: input.signWith, unsignedTransaction: input.unsignedTransaction, type: input.type } }, result: { signTransactionResult: { signedTransaction } } } };
    },
    getWhoami: async () => identity(),
    getOrganizationConfigs: async () => organization(),
    getPolicies: async () => ({ policies: [providerPolicy()] }),
    getPrivateKeys: async () => ({ privateKeys: [providerKey()] }),
    ...overrides,
  };
}

function signer(ast = policy(), clientOverrides: Partial<TurnkeySignerClient> = {}) {
  return new TurnkeySigner({ organizationId: ORG, environment: ENVIRONMENT, userId: USER, wallets: [{ index: 0, address: WALLET, signWith: KEY_ID }], policyRecord: record(ast), client: clientFor({ getPolicies: async () => ({ policies: [providerPolicy(ast)] }), ...clientOverrides }) });
}

describe('Turnkey policy boundary', () => {
  it('accepts local 0600 and production root-owned 0440 files while rejecting writable or public modes', () => {
    expect(isSecureTurnkeyFileAccess({ mode: 0o100600, uid: 1000, gid: 1000 }, 1000, [1000])).toBe(true);
    expect(isSecureTurnkeyFileAccess({ mode: 0o100440, uid: 0, gid: 1000 }, 1000, [1000])).toBe(true);
    expect(isSecureTurnkeyFileAccess({ mode: 0o100640, uid: 0, gid: 1000 }, 0, [0])).toBe(true);
    expect(isSecureTurnkeyFileAccess({ mode: 0o100644, uid: 0, gid: 1000 }, 0, [0])).toBe(false);
    expect(isSecureTurnkeyFileAccess({ mode: 0o100660, uid: 0, gid: 1000 }, 0, [0])).toBe(false);
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
  it('accepts a bounded family calldata shape while retaining local quantity and selector checks', async () => {
    const ast = familyPolicy();
    const result = await signer(ast).signTransactionWithEvidence(0, familyIntent(ast));
    expect(result.signedTransaction).toMatch(/^0x/);
    await expect(signer(ast).signTransaction(0, familyIntent(ast, { data: '0x161ac21f' as Hex }))).rejects.toThrow('TURNKEY_POLICY_INTENT_BLOCKED');
    const tooMany = encodeFunctionData({ abi: parseAbi(['function mintPublic(address,address,address,uint256)']), functionName: 'mintPublic', args: ['0x3333333333333333333333333333333333333333', '0x4444444444444444444444444444444444444444', '0x0000000000000000000000000000000000000000', 5n] });
    await expect(signer(ast).signTransaction(0, familyIntent(ast, { data: tooMany }))).rejects.toThrow('TURNKEY_POLICY_INTENT_BLOCKED');
    const wrongTarget = encodeFunctionData({ abi: parseAbi(['function mintPublic(address,address,address,uint256)']), functionName: 'mintPublic', args: ['0x5555555555555555555555555555555555555555', '0x4444444444444444444444444444444444444444', '0x0000000000000000000000000000000000000000', 1n] });
    await expect(signer(ast).signTransaction(0, familyIntent(ast, { data: wrongTarget }))).rejects.toThrow('TURNKEY_POLICY_INTENT_BLOCKED');
  });

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


describe('free allowlist family signing boundary', () => {
  it('requires independent live authority and rechecks readiness before calling Turnkey', async () => {
    const ast: TurnkeyPolicyAst = { ...familyPolicy(), transaction: { ...familyPolicy().transaction, data: '0x4300a4e6', maxFeePerGasMax: '200000000' }, family: { kind: 'seadrop-free-allowlist-v1', maxQuantity: 4 } };
    const nft = '0x3333333333333333333333333333333333333333' as Address;
    const params = { mintPrice: 0n, maxTotalMintableByWallet: 4n, startTime: 1n, endTime: 2_000_000_000n, dropStageIndex: 1n, maxTokenSupplyForStage: 100n, feeBps: 0n, restrictFeeRecipients: false };
    const p: VerifiedWalletProof = { wallet: WALLET, mintParams: params, proof: [], source: { chainId: 4663, nftContract: nft, stageIndex: '1', sourceId: 'test', contentDigest: `sha256:${'a'.repeat(64)}` }, authority: { chainId: 4663, nftContract: nft, seaDrop: SEADROP_V1_ADDRESS, root: allowlistLeaf(WALLET, params), blockNumber: 100n, blockHash: `0x${'a'.repeat(64)}`, observedAt: new Date().toISOString(), feeRecipient: OPENSEA_FEE_COLLECTOR } };
    const base = { ...familyIntent(ast, { maxFeePerGas: 200000000n }), campaignId: 'campaign', runId: 'run', data: buildAllowlistMint(p, WALLET, 1).data, familyContext: { nftContract: nft, feeRecipient: OPENSEA_FEE_COLLECTOR, allowlistProof: p, assertReady: () => undefined } };
    let sent = 0;
    const client = clientFor({ getPolicies: async () => ({ policies: [providerPolicy(ast)] }), signTransaction: async (input) => { sent += 1; return clientFor().signTransaction(input); } });
    const make = (verifyAllowlistAuthority?: (value: import('./types.js').TransactionIntent) => Promise<void>) => new TurnkeySigner({ organizationId: ORG, environment: ENVIRONMENT, userId: USER, wallets: [{ index: 0, address: WALLET, signWith: KEY_ID }], policyRecord: record(ast), client, verifyAllowlistAuthority });
    await expect(make().signTransaction(0, base)).rejects.toThrow('TURNKEY_ALLOWLIST_AUTHORITY_REQUIRED');
    await expect(make(async () => { throw new Error('TURNKEY_ALLOWLIST_ROOT_CHANGED'); }).signTransaction(0, base)).rejects.toThrow('TURNKEY_ALLOWLIST_ROOT_CHANGED');
    await expect(make(async () => undefined).signTransaction(0, { ...base, familyContext: { ...base.familyContext, assertReady: () => { throw new Error('KILLED'); } } })).rejects.toThrow('KILLED');
    expect(sent).toBe(0);
    await expect(make(async () => undefined).signTransaction(0, base)).resolves.toMatch(/^0x/);
    expect(sent).toBe(1);
    const noNetwork = make();
    const rehearsal = await noNetwork.rehearseFreeAllowlist(0, async () => undefined);
    expect(rehearsal.signedTransactionHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(rehearsal).not.toHaveProperty('signedTransaction');
    expect(sent).toBe(2);
    await expect(noNetwork.rehearseFreeAllowlist(0, async () => { throw new Error('KILL_SWITCH_NOT_ENGAGED'); })).rejects.toThrow('KILL_SWITCH_NOT_ENGAGED');
    expect(sent).toBe(2);
  });
});

describe('free public family signing boundary', () => {
  it('checks current authority then readiness before every signature and isolates rehearsal', async () => {
    const ast: TurnkeyPolicyAst = { ...familyPolicy(), transaction: { ...familyPolicy().transaction, chainId: 1, maxFeePerGasMax: '200000000' }, family: { kind: 'seadrop-free-public-v1', maxQuantity: 10 } };
    const order: string[] = [];
    const client = clientFor({ signTransaction: async (input) => { order.push('sign'); return clientFor().signTransaction(input); } });
    const make = (verifyPublicAuthority?: (value: import('./types.js').TransactionIntent) => Promise<void>) => new TurnkeySigner({ organizationId: ORG, environment: ENVIRONMENT, userId: USER, wallets: [{ index: 0, address: WALLET, signWith: KEY_ID }], policyRecord: record(ast), client, verifyPublicAuthority });
    const base = { ...familyIntent(ast, { chainId: 1, maxFeePerGas: 200000000n }), campaignId: 'campaign', runId: 'run', familyContext: { ...familyIntent(ast).familyContext, assertReady: () => { order.push('ready'); } } };
    await expect(make().signTransaction(0, base)).rejects.toThrow('TURNKEY_PUBLIC_AUTHORITY_REQUIRED');
    await expect(make(async () => { throw new Error('TURNKEY_PUBLIC_RPC_DISAGREEMENT'); }).signTransaction(0, base)).rejects.toThrow('TURNKEY_PUBLIC_RPC_DISAGREEMENT');
    await expect(make(async () => undefined).signTransaction(0, { ...base, familyContext: { ...base.familyContext, assertReady: () => { throw new Error('KILLED'); } } })).rejects.toThrow('KILLED');
    await expect(make(async () => undefined).signTransaction(0, { ...base, gasLimit: 0n })).rejects.toThrow('TURNKEY_PUBLIC_AUTHORITY_REQUIRED');
    expect(order).toEqual([]);
    await expect(make(async () => { order.push('authority'); }).signTransaction(0, base)).resolves.toMatch(/^0x/);
    expect(order).toEqual(['authority', 'ready', 'sign']);
    const changed = { ...base };
    await expect(make(async () => { changed.value = 1n; }).signTransaction(0, changed)).rejects.toThrow('TURNKEY_POLICY_INTENT_BLOCKED');
    const rehearsal = await make().rehearseFreePublic(0, async () => undefined);
    expect(rehearsal.signedTransactionHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(rehearsal).not.toHaveProperty('signedTransaction');
    await expect(make().rehearseFreePublic(0, async () => { throw new Error('KILL_SWITCH_NOT_ENGAGED'); })).rejects.toThrow('KILL_SWITCH_NOT_ENGAGED');
    expect(order.filter((step) => step === 'sign')).toHaveLength(2);
  });
});

// Signed mints are a distinct, owner-approved family. Existing families cannot authorize this selector.
describe('Turnkey bounded free signed mint family', () => {
  async function setupSigned(verifyAuthority = true) {
    const { signedMintTypedData, verifySignedWalletAuthorization, buildSignedMint } = await import('./signed-mint-authority.js');
    const { assertIndependentSignedAuthority } = await import('./turnkey-signed-authority.js');
    const seconds = BigInt(Math.floor(Date.now() / 1000));
    const raw: import('./signed-mint-authority.js').SignedWalletAuthorization = { chainId: 4663, nftContract: TO, wallet: WALLET, feeRecipient: OPENSEA_FEE_COLLECTOR, mintParams: { mintPrice: 0n, maxTotalMintableByWallet: 10n, startTime: seconds - 60n, endTime: seconds + 600n, dropStageIndex: 1n, maxTokenSupplyForStage: 1000n, feeBps: 250n, restrictFeeRecipients: true }, salt: 123n, signature: '0x', source: { chainId: 4663, nftContract: TO, wallet: WALLET, stageIndex: '1', sourceId: 'official-platform', contentDigest: `sha256:${'a'.repeat(64)}` } };
    raw.signature = await ACCOUNT.signTypedData(signedMintTypedData(raw));
    const authorityClient = (): import('./signed-mint-authority.js').SignedMintAuthorityClient => ({ getBlockNumber: async () => 100n, getChainId: async () => 4663, getBlock: async () => ({ hash: `0x${'a'.repeat(64)}`, timestamp: seconds }), readContract: async (request) => request.functionName === 'getFeeRecipientIsAllowed' ? true : request.functionName === 'getMintStats' ? [0n, 0n, 2000n] : [0n, 10n, seconds - 120n, seconds + 1000n, 1000n, 0n, 1000n], call: async () => ({ data: '0x' }) });
    const proof = await verifySignedWalletAuthorization(raw, [authorityClient(), authorityClient()], 4);
    const ast: TurnkeyPolicyAst = { ...familyPolicy(), transaction: { ...familyPolicy().transaction, data: '0x4b61cd6f', maxFeePerGasMax: '200000000' }, family: { kind: 'seadrop-free-signed-v1', maxQuantity: 4 } };
    const calls: string[] = [];
    const client = clientFor({ getPolicies: async () => ({ policies: [providerPolicy(ast)] }) });
    const sign = client.signTransaction.bind(client);
    client.signTransaction = async (request) => { calls.push('sign'); return sign(request); };
    const signer = new TurnkeySigner({ organizationId: ORG, environment: ENVIRONMENT, userId: USER, wallets: [{ index: 0, address: WALLET, signWith: KEY_ID }], policyRecord: record(ast), client, ...(verifyAuthority ? { verifySignedAuthority: async (value: import('./types.js').TransactionIntent) => { calls.push('authority'); await assertIndependentSignedAuthority(value, [authorityClient(), authorityClient()]); } } : {}) });
    const tx: import('./types.js').TransactionIntent = { chainId: 4663, from: WALLET, to: SEADROP_V1_ADDRESS, value: 0n, data: buildSignedMint(proof, WALLET, 4).data, nonce: 4, gasLimit: 50_000n, maxFeePerGas: 200_000_000n, maxPriorityFeePerGas: 100_000_000n, accessList: [], campaignId: 'signed-campaign', runId: 'signed-run', policyRef: turnkeyPolicyRef(ast.scope.policyId, canonicalPolicyDigest(ast)), familyContext: { nftContract: TO, feeRecipient: OPENSEA_FEE_COLLECTOR, signedAuthorization: proof, assertReady: async () => { calls.push('ready'); } } };
    return { signer, tx, ast, calls };
  }
  it('checks exact own authorization, both providers and readiness before signing', async () => {
    const { signer, tx, calls } = await setupSigned();
    const signed = await signer.signTransaction(0, tx);
    expect(parseTransaction(signed).data).toBe(tx.data);
    expect(calls).toEqual(['authority', 'ready', 'sign']);
  });
  it('cannot sign without independent authority or with a kill after authority reads', async () => {
    const missing = await setupSigned(false);
    await expect(missing.signer.signTransaction(0, missing.tx)).rejects.toThrow('TURNKEY_SIGNED_AUTHORITY_REQUIRED');
    expect(missing.calls).not.toContain('sign');
    const killed = await setupSigned();
    await expect(killed.signer.signTransaction(0, { ...killed.tx, familyContext: { ...killed.tx.familyContext!, assertReady: async () => { throw new Error('KILLED'); } } })).rejects.toThrow('KILLED');
    expect(killed.calls).not.toContain('sign');
  });
  it.each([{ value: 1n }, { chainId: 1 }, { maxFeePerGas: 200_000_001n }, { gasLimit: 500_001n }, { familyContext: undefined }])('rejects out-of-policy intents before any provider operation', async (change) => {
    const { signer, tx, calls } = await setupSigned();
    await expect(signer.signTransaction(0, { ...tx, ...change } as import('./types.js').TransactionIntent)).rejects.toThrow('TURNKEY_POLICY_INTENT_BLOCKED');
    expect(calls).toEqual([]);
  });
  it('does not allow the signed selector under old public/Merkle policies', async () => {
    const { tx, ast } = await setupSigned();
    for (const kind of ['seadrop-free-public-v1', 'seadrop-free-allowlist-v1'] as const) {
      const old = { ...ast, transaction: { ...ast.transaction, data: kind === 'seadrop-free-public-v1' ? '0x161ac21f' as Hex : '0x4300a4e6' as Hex }, family: { ...ast.family!, kind } };
      const oldSigner = signer(old);
      await expect(oldSigner.signTransaction(0, { ...tx, policyRef: turnkeyPolicyRef(old.scope.policyId, canonicalPolicyDigest(old)) })).rejects.toThrow('TURNKEY_POLICY_INTENT_BLOCKED');
    }
  });
  it('rehearses only impossible zero-gas, maximum-nonce transactions and returns no signed bytes', async () => {
    const { signer, calls } = await setupSigned();
    let stoppedChecks = 0;
    const rehearsal = await signer.rehearseFreeSigned(0, async () => { stoppedChecks++; });
    expect(rehearsal.signedTransactionHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(rehearsal).not.toHaveProperty('signedTransaction');
    expect(stoppedChecks).toBe(2);
    expect(calls).toEqual(['sign']);
  });
  it('bounds generation by chain, pinned fees and exact provider slices', async () => {
    const { ast } = await setupSigned();
    const expression = turnkeyProviderPolicyExpressions(ast).condition;
    expect(expression).toContain("eth.tx.data[0..10] == '0x4b61cd6f'");
    expect(expression).toContain("eth.tx.data[266..330] == '0000000000000000000000000000000000000000000000000000000000000000'");
    expect(expression).toContain("eth.tx.data[714..778] == '0000000000000000000000000000000000000000000000000000000000000001'");
    expect(() => validateTurnkeyPolicyAst({ ...ast, transaction: { ...ast.transaction, chainId: 8453 }, family: { ...ast.family!, maxQuantity: 5 } })).toThrow('TURNKEY_POLICY_FAMILY_INVALID');
    expect(() => validateTurnkeyPolicyAst({ ...ast, transaction: { ...ast.transaction, maxFeePerGasMax: '200000001' } })).toThrow('TURNKEY_POLICY_FAMILY_FEE_LIMIT_INVALID');
  });
});
