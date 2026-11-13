import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import type { CampaignInput, EngineAdapter } from '@mint-bot/backend';
import { createTurnkeyPolicyRecord, SEADROP_V1_ADDRESS, turnkeyProviderPolicyExpressions, type TurnkeyCanonicalPolicyRecord, type TurnkeyPolicyAst } from '@mint-bot/engine';
import { createCliRuntime } from './runtime.js';

const fixture = vi.hoisted(() => ({ records: [] as unknown[], rpcCalls: 0, wallet: `0x${'1'.repeat(40)}` }));
vi.mock('@mint-bot/engine', async load => ({ ...await load<typeof import('@mint-bot/engine')>(),
  readTurnkeySecretConfig: async () => ({}), readTurnkeyApprovedPolicyRecords: async () => fixture.records,
  resolveChainConfigFromSecrets: async () => { fixture.rpcCalls += 1; throw new Error('UNEXPECTED_PUBLIC_RPC_FALLBACK'); },
  TurnkeySigner: class { public static async fromSecrets() { return { policyReference: () => 'turnkey:configured', listWallets: async () => [{ index: 0, address: fixture.wallet }], zeroize: () => undefined }; } },
}));
const originalCustody = process.env.MINT_BOT_CUSTODY;
afterEach(() => { if (originalCustody === undefined) delete process.env.MINT_BOT_CUSTODY; else process.env.MINT_BOT_CUSTODY = originalCustody; fixture.records = []; fixture.rpcCalls = 0; });
function record(signed: boolean): TurnkeyCanonicalPolicyRecord {
  const policy: TurnkeyPolicyAst = { version: 1, effect: 'allow', scope: { provider: 'turnkey', environment: 'production', organizationId: 'org', userId: 'runtime', policyId: signed ? 'signed' : 'public', keyIds: ['key'] }, transaction: { chainId: 4663, from: [fixture.wallet as Address], to: SEADROP_V1_ADDRESS, valueWei: '0', data: signed ? '0x4b61cd6f' : '0x161ac21f', gasLimitMax: '500000', maxFeePerGasMax: '200000000', maxPriorityFeePerGasMax: '100000000', accessList: [] }, family: { kind: signed ? 'seadrop-free-signed-v1' : 'seadrop-free-public-v1', maxQuantity: 10 } };
  return createTurnkeyPolicyRecord({ environment: 'production', providerIdentity: { organizationId: 'org', organizationName: 'MintBot', userId: 'runtime', username: 'runtime' }, providerPolicy: { policyId: policy.scope.policyId, policyName: 'family', effect: 'EFFECT_ALLOW', createdAt: { seconds: '1', nanos: '0' }, updatedAt: { seconds: '2', nanos: '0' }, notes: '', ...turnkeyProviderPolicyExpressions(policy), time: null }, enforcementPolicy: policy, walletReferences: [{ index: 0, address: fixture.wallet as Address, signWith: 'key' }], providerKeys: [{ privateKeyId: 'key', publicKey: `02${'ab'.repeat(32)}`, privateKeyName: 'family', curve: 'CURVE_SECP256K1', addresses: [{ format: 'ADDRESS_FORMAT_ETHEREUM', address: fixture.wallet }], privateKeyTags: [], createdAt: { seconds: '1', nanos: '0' }, updatedAt: null, exported: false, imported: false }], issuedAt: '2030-01-01T00:00:00.000Z', expiresAt: '2031-01-01T00:00:00.000Z' });
}
const input: CampaignInput = { chainId: 4663, contract: `0x${'2'.repeat(40)}`, strategy: 'seadrop-v1-signed', quantity: 2, mintPriceWei: 0n, walletScope: [fixture.wallet], maxRunWei: 100n, dailyCapWei: 100n, gasCeilingWei: 100n, feePolicy: { kind: 'free', configuredPriorityFeeWei: 1n }, chainVerification: { chainId: 4663, status: 'verified', seaDropCompatible: true, endpointReference: 'test' } };
async function runtimeTest(run: (runtime: Awaited<ReturnType<typeof createCliRuntime>>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'mintbot-signed-runtime-')); process.env.MINT_BOT_CUSTODY = 'turnkey';
  const runtime = await createCliRuntime(root, {} as EngineAdapter, join(root, 'state.sqlite'), {}, { allowTurnkey: true, startCoordinator: false });
  try { await run(runtime); } finally { (runtime.store as { close?: () => void }).close?.(); await rm(root, { recursive: true, force: true }); }
}
describe('signed custody cannot fall back to a public policy', () => {
  it.each([false, true])('blocks absent or old-public-only approval without resolving public calldata (%s)', async withPublic => {
    fixture.records = withPublic ? [record(false)] : [];
    await runtimeTest(async runtime => { await expect(runtime.custodyPolicyFor!(input)).rejects.toThrow('TURNKEY_SIGNED_FAMILY_APPROVAL_REQUIRED'); expect(fixture.rpcCalls).toBe(0); });
  });
  it('binds the explicitly signed family and resolves omitted scope from the active signed wallet map', async () => {
    fixture.records = [record(false), record(true)];
    await runtimeTest(async runtime => {
      await expect(runtime.custodyPolicyFor!(input)).resolves.toMatchObject({ provider: 'turnkey', policyReference: expect.stringContaining('turnkey:signed:') });
      await expect(runtime.custodyPolicyFor!({ ...input, walletScope: undefined })).resolves.toMatchObject({ provider: 'turnkey', policyReference: expect.stringContaining('turnkey:signed:') });
      await expect(runtime.custodyPolicyFor!({ ...input, walletScope: [`0x${'3'.repeat(40)}`] })).rejects.toThrow('TURNKEY_SIGNED_FAMILY_APPROVAL_REQUIRED'); expect(fixture.rpcCalls).toBe(0);
    });
  });
});
