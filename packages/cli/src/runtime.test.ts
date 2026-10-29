import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { configuredWalletPath, createCliRuntime, personalLiveLocalCustodyAllowed, selectTurnkeyRobinhoodFamilyPolicy, type SpendAlertSink } from './runtime.js';
import { PERSONAL_LIVE_FLEET_POLICY, type EngineAdapter } from '@mint-bot/backend';
import { createTurnkeyPolicyRecord, turnkeyProviderPolicyExpressions, SEADROP_V1_ADDRESS, type TurnkeyPolicyAst } from '@mint-bot/engine';
import type { Address, Hex } from 'viem';

const FAMILY_WALLET = '0x1111111111111111111111111111111111111111' as Address;
const FAMILY_KEY = 'key-family';

function familyRecord(maxQuantity = 4, policyId = 'policy-family') {
  const policy: TurnkeyPolicyAst = {
    version: 1,
    effect: 'allow',
    scope: { provider: 'turnkey', environment: 'production', organizationId: 'org', userId: 'runtime', policyId, keyIds: [FAMILY_KEY] },
    transaction: { chainId: 4663, from: [FAMILY_WALLET], to: SEADROP_V1_ADDRESS, valueWei: '0', data: '0x161ac21f' as Hex, gasLimitMax: '500000', maxFeePerGasMax: '200000000', maxPriorityFeePerGasMax: '100000000', accessList: [] },
    family: { kind: 'robinhood-seadrop-public-v1', maxQuantity },
  };
  const expressions = turnkeyProviderPolicyExpressions(policy);
  return createTurnkeyPolicyRecord({
    environment: 'production',
    providerIdentity: { organizationId: 'org', organizationName: 'MintBot', userId: 'runtime', username: 'mintbot-runtime' },
    providerPolicy: { policyId, policyName: 'Robinhood family', effect: 'EFFECT_ALLOW', createdAt: { seconds: '1', nanos: '0' }, updatedAt: { seconds: '2', nanos: '0' }, notes: '', ...expressions, time: null },
    enforcementPolicy: policy,
    walletReferences: [{ index: 0, address: FAMILY_WALLET, signWith: FAMILY_KEY }],
    providerKeys: [{ privateKeyId: FAMILY_KEY, publicKey: `02${'ab'.repeat(32)}`, privateKeyName: 'family', curve: 'CURVE_SECP256K1', addresses: [{ format: 'ADDRESS_FORMAT_ETHEREUM', address: FAMILY_WALLET }], privateKeyTags: [], createdAt: { seconds: '1', nanos: '0' }, updatedAt: null, exported: false, imported: false }],
    issuedAt: '2030-01-01T00:00:00.000Z',
    expiresAt: '2031-01-01T00:00:00.000Z',
  });
}

describe('CLI runtime custody boundaries', () => {
  it('automatically binds any free Robinhood SeaDrop campaign to the one approved family record', () => {
    const selection = selectTurnkeyRobinhoodFamilyPolicy([familyRecord()], { chainId: 4663, strategy: 'seadrop-v1-public', quantity: 2, mintPriceWei: 0n });
    expect(selection?.policyReference).toMatch(/^turnkey:policy-family:0x[0-9a-f]{64}$/);
  });

  it('does not use the family for paid, over-quantity or non-Robinhood campaigns', () => {
    const records = [familyRecord()];
    expect(selectTurnkeyRobinhoodFamilyPolicy(records, { chainId: 4663, strategy: 'seadrop-v1-public', quantity: 1, mintPriceWei: 1n })).toBeUndefined();
    expect(selectTurnkeyRobinhoodFamilyPolicy(records, { chainId: 4663, strategy: 'seadrop-v1-public', quantity: 5, mintPriceWei: 0n })).toBeUndefined();
    expect(selectTurnkeyRobinhoodFamilyPolicy(records, { chainId: 1, strategy: 'seadrop-v1-public', quantity: 1, mintPriceWei: 0n })).toBeUndefined();
  });

  it('fails closed when more than one eligible family record is installed', () => {
    expect(() => selectTurnkeyRobinhoodFamilyPolicy([familyRecord(4, 'family-a'), familyRecord(8, 'family-b')], { chainId: 4663, strategy: 'seadrop-v1-public', quantity: 1, mintPriceWei: 0n })).toThrow('TURNKEY_POLICY_FAMILY_AMBIGUOUS');
  });

  it('accepts only wallet files under the workspace or configured external secret wallet roots', () => {
    const root = '/workspace/mintbot';
    const priorSecretRoot = process.env.MINT_BOT_SECRET_ROOT;
    process.env.MINT_BOT_SECRET_ROOT = '/secure/mintbot';
    try {
      expect(configuredWalletPath(root)).toBe('/secure/mintbot/wallets/wallets.json');
      expect(configuredWalletPath(root, '/secure/mintbot/wallets/selected.json')).toBe('/secure/mintbot/wallets/selected.json');
      expect(configuredWalletPath(root, '/workspace/mintbot/Rets/wallets/local.json')).toBe('/workspace/mintbot/Rets/wallets/local.json');
      expect(() => configuredWalletPath(root, '/secure/mintbot/other.json')).toThrow('WALLET_PATH_OUTSIDE_APPROVED_ROOT');
      expect(() => configuredWalletPath(root, '/tmp/wallets.json')).toThrow('WALLET_PATH_OUTSIDE_APPROVED_ROOT');
    } finally {
      if (priorSecretRoot === undefined) delete process.env.MINT_BOT_SECRET_ROOT; else process.env.MINT_BOT_SECRET_ROOT = priorSecretRoot;
    }
  });

  it('does not read Turnkey files when dry-run explicitly disables custody loading', async () => {
    const root = await mkdtemp(join('/tmp', 'mintbot-runtime-'));
    const priorCustody = process.env.MINT_BOT_CUSTODY;
    const priorSecretRoot = process.env.MINT_BOT_SECRET_ROOT;
    process.env.MINT_BOT_CUSTODY = 'turnkey';
    process.env.MINT_BOT_SECRET_ROOT = join(root, 'missing-turnkey-root');
    try {
      const runtime = await createCliRuntime(root, {} as EngineAdapter, join(root, 'state.sqlite'), {}, { allowTurnkey: false, startCoordinator: false });
      expect(runtime.store.snapshot().runtime.startupState).toBe('Cold');
      (runtime.store as { close?: () => void }).close?.();
    } finally {
      if (priorCustody === undefined) delete process.env.MINT_BOT_CUSTODY; else process.env.MINT_BOT_CUSTODY = priorCustody;
      if (priorSecretRoot === undefined) delete process.env.MINT_BOT_SECRET_ROOT; else process.env.MINT_BOT_SECRET_ROOT = priorSecretRoot;
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('CLI runtime spend limits (T-003)', () => {
  it('installs the Personal Live fleet policy and routes headroom alerts to a durable event, then to the service sink', async () => {
    const root = await mkdtemp(join('/tmp', 'mintbot-runtime-'));
    try {
      const runtime = await createCliRuntime(root, {} as EngineAdapter, join(root, 'state.sqlite'), {}, { allowTurnkey: false, startCoordinator: false });
      expect((runtime.store as unknown as { fleetPolicy?: unknown }).fleetPolicy).toEqual(PERSONAL_LIVE_FLEET_POLICY);
      const coordinatorAlerts = (runtime.coordinator as unknown as { options: { alerts?: SpendAlertSink } }).options.alerts;
      expect(coordinatorAlerts).toBeDefined();
      await coordinatorAlerts!.cap('PAID_DAILY_HEADROOM_USED');
      expect(runtime.store.snapshot().events.some((event) => event.type === 'alert_cap' && event.data.reason === 'PAID_DAILY_HEADROOM_USED')).toBe(true);
      const delivered: Array<[string, string | undefined]> = [];
      runtime.setAlertSink({ cap: async (reason, runId) => { delivered.push([reason, runId]); } });
      await coordinatorAlerts!.cap('PAID_DAILY_HEADROOM_USED', 'run-service');
      expect(delivered).toEqual([['PAID_DAILY_HEADROOM_USED', 'run-service']]);
      expect(runtime.store.snapshot().events.some((event) => event.runId === 'run-service')).toBe(false);
      (runtime.store as { close?: () => void }).close?.();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('local key file custody option (D-043)', () => {
  it('is on only when asked for and Turnkey custody is not in use', () => {
    expect(personalLiveLocalCustodyAllowed(true, false)).toBe(true);
    expect(personalLiveLocalCustodyAllowed(true, true)).toBe(false);
    expect(personalLiveLocalCustodyAllowed(false, false)).toBe(false);
    expect(personalLiveLocalCustodyAllowed(undefined, false)).toBe(false);
    expect(personalLiveLocalCustodyAllowed(undefined, true)).toBe(false);
  });
});
