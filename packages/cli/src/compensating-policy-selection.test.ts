import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createTurnkeyPolicyRecord, signTurnkeyPolicyRecord, turnkeyPolicyRecordDigest, turnkeyPolicySelection, turnkeyProviderPolicyExpressions, verifyTurnkeySignedPolicyCatalog, verifyTurnkeySignedPolicyRecord, type TurnkeyCanonicalPolicyRecord, type TurnkeySignedPolicyRecord } from '@mint-bot/engine';
import { robinhoodTurnkeyPolicy } from './turnkey-policy-template.js';
import { rehearsalFileName } from './compensating-controls-cli.js';
import { inspectCompensatingPolicy, type SelectedCompensatingPolicy } from './compensating-policy-selection.js';

const NOW = new Date('2030-06-01T00:00:00.000Z');
const keys = generateKeyPairSync('ed25519');
const wallet = { index: 0, address: '0x1111111111111111111111111111111111111111' as const, signWith: 'key-1' };

function makeRecord(chainId: 1 | 8453 | 4663, policyId: string, kind: 'public' | 'allowlist' | 'exact' = 'public'): TurnkeyCanonicalPolicyRecord {
  const policy = robinhoodTurnkeyPolicy({ environment: 'production', organizationId: 'org', userId: 'runtime-user', policyId, wallets: [wallet],
    nftContract: '0x2222222222222222222222222222222222222222', feeRecipient: '0x3333333333333333333333333333333333333333',
    quantity: 1, gasLimitMax: '500000', maxFeePerGasGwei: '0.2', maxPriorityFeePerGasGwei: '0.1',
    ...(kind === 'exact' ? {} : { chainId, ...(kind === 'allowlist' ? { allowlistFamily: true } : { publicFamily: true }) }),
  });
  const expressions = turnkeyProviderPolicyExpressions(policy);
  return createTurnkeyPolicyRecord({ environment: 'production',
    providerIdentity: { organizationId: 'org', organizationName: 'MintBot', userId: 'runtime-user', username: 'mintbot-runtime' },
    providerPolicy: { policyId, policyName: policyId, effect: 'EFFECT_ALLOW', createdAt: { seconds: '1', nanos: '0' }, updatedAt: { seconds: '2', nanos: '0' }, notes: '', ...expressions },
    enforcementPolicy: policy, walletReferences: [wallet],
    providerKeys: [{ privateKeyId: wallet.signWith, publicKey: `02${'ab'.repeat(32)}`, privateKeyName: 'wallet-1', curve: 'CURVE_SECP256K1', addresses: [{ format: 'ADDRESS_FORMAT_ETHEREUM', address: wallet.address }], privateKeyTags: [], createdAt: { seconds: '1', nanos: '0' }, updatedAt: { seconds: '2', nanos: '0' }, exported: false, imported: false }],
    issuedAt: '2030-01-01T00:00:00.000Z', expiresAt: '2031-01-01T00:00:00.000Z',
  });
}

const base = makeRecord(8453, 'base-public');
const rhPublic = makeRecord(4663, 'rh-public');
const rhAllowlist = makeRecord(4663, 'rh-allowlist', 'allowlist');
const signed = [base, rhPublic, rhAllowlist].map(record => signTurnkeyPolicyRecord(record, keys.privateKey));

function loader(records: readonly TurnkeySignedPolicyRecord[] = signed, active = signed[0]!, now = NOW) {
  return vi.fn(async () => ({ activeRecord: verifyTurnkeySignedPolicyRecord(active, keys.publicKey, now),
    records: verifyTurnkeySignedPolicyCatalog({ version: 1, context: 'mintbot.turnkey-policy-catalog/v1', records }, keys.publicKey, now),
  }));
}

describe('compensating diagnostics signed-policy selection', () => {
  it('preserves the active policy default on its own chain', async () => {
    const inspect = vi.fn(async (selected: SelectedCompensatingPolicy) => selected.record.providerPolicy.policyId);
    expect(await inspectCompensatingPolicy({ chainId: 8453 }, loader(), inspect)).toBe('base-public');
    expect(inspect).toHaveBeenCalledWith({ record: base, selection: turnkeyPolicySelection(base) });
  });

  it('selects the explicit Robinhood public record instead of the globally active Base policy', async () => {
    const createSigner = vi.fn(async (_reference: string, _digest: string) => 'inspected');
    const result = await inspectCompensatingPolicy({ chainId: 4663, policyId: 'rh-public' }, loader(), async ({ selection }) => createSigner(selection.policyReference, selection.recordDigest));
    expect(result).toBe('inspected');
    const expected = turnkeyPolicySelection(rhPublic);
    expect(createSigner).toHaveBeenCalledTimes(1);
    expect(createSigner).toHaveBeenCalledWith(expected.policyReference, expected.recordDigest);
    expect(createSigner).not.toHaveBeenCalledWith(turnkeyPolicySelection(base).policyReference, turnkeyPolicyRecordDigest(base));
  });

  it('binds allowlist inspection to its own record and rehearsal, separately from the public policy', async () => {
    const readRehearsal = vi.fn(async (name: string) => name);
    const result = await inspectCompensatingPolicy({ chainId: 4663, policyId: 'rh-allowlist' }, loader(), async ({ record, selection }) => {
      expect(record.enforcementPolicy.family?.kind).toBe('seadrop-free-allowlist-v1');
      return readRehearsal(rehearsalFileName(selection.recordDigest));
    });
    expect(result).toBe(rehearsalFileName(turnkeyPolicyRecordDigest(rhAllowlist)));
    expect(result).not.toBe(rehearsalFileName(turnkeyPolicyRecordDigest(rhPublic)));
    expect(result).not.toBe(rehearsalFileName(turnkeyPolicyRecordDigest(base)));
  });

  it.each([undefined, 'base-public'])('refuses a cross-chain active/explicit policy (%s) before any inspection I/O', async policyId => {
    const inspect = vi.fn();
    await expect(inspectCompensatingPolicy({ chainId: 4663, ...(policyId === undefined ? {} : { policyId }) }, loader(), inspect)).rejects.toThrow('COMPENSATING_POLICY_CHAIN_MISMATCH');
    expect(inspect).not.toHaveBeenCalled();
  });

  it.each(['missing-policy', ''])('never falls back to active for an unknown explicit selection (%s)', async policyId => {
    const inspect = vi.fn();
    await expect(inspectCompensatingPolicy({ chainId: 8453, policyId }, loader(), inspect)).rejects.toThrow('COMPENSATING_POLICY_SELECTION_NOT_FOUND');
    expect(inspect).not.toHaveBeenCalled();
  });

  it.each([0, 42161, Number.NaN, Number.POSITIVE_INFINITY])('rejects unsupported chain %s before even loading records', async chainId => {
    const read = loader(); const inspect = vi.fn();
    await expect(inspectCompensatingPolicy({ chainId }, read, inspect)).rejects.toThrow('COMPENSATING_POLICY_CHAIN_INVALID');
    expect(read).not.toHaveBeenCalled(); expect(inspect).not.toHaveBeenCalled();
  });

  it('propagates real signature-verification failure before selecting or inspecting a policy', async () => {
    const tampered = structuredClone(signed[1]!);
    const signature = Buffer.from(tampered.signature, 'base64url');
    signature[0] = signature[0]! ^ 1;
    (tampered as { signature: string }).signature = signature.toString('base64url');
    const inspect = vi.fn();
    await expect(inspectCompensatingPolicy({ chainId: 4663, policyId: 'rh-public' }, loader([signed[0]!, tampered, signed[2]!]), inspect)).rejects.toThrow('TURNKEY_POLICY_SIGNATURE_INVALID');
    expect(inspect).not.toHaveBeenCalled();
  });

  it('refuses expired owner authority before inspection', async () => {
    const inspect = vi.fn();
    await expect(inspectCompensatingPolicy({ chainId: 8453 }, loader(signed, signed[0], new Date('2032-01-01T00:00:00.000Z')), inspect)).rejects.toThrow('TURNKEY_POLICY_RECORD_NOT_CURRENT');
    expect(inspect).not.toHaveBeenCalled();
  });

  it('requires active authority to remain in the verified catalog', async () => {
    const inspect = vi.fn();
    await expect(inspectCompensatingPolicy({ chainId: 4663, policyId: 'rh-public' }, async () => ({ activeRecord: base, records: [rhPublic] }), inspect)).rejects.toThrow('TURNKEY_PROVIDER_POLICY_CATALOG_ACTIVE_RECORD_MISSING');
    expect(inspect).not.toHaveBeenCalled();
  });

  it('rejects an ambiguous policy ID rather than selecting a record by array order', async () => {
    const inspect = vi.fn();
    await expect(inspectCompensatingPolicy({ chainId: 4663, policyId: 'rh-public' }, async () => ({ activeRecord: base, records: [base, rhPublic, rhPublic] }), inspect)).rejects.toThrow('COMPENSATING_POLICY_SELECTION_AMBIGUOUS');
    expect(inspect).not.toHaveBeenCalled();
  });

  it('retains same-chain legacy exact-policy diagnostics', async () => {
    const exact = signTurnkeyPolicyRecord(makeRecord(4663, 'rh-exact', 'exact'), keys.privateKey);
    const inspect = vi.fn(async ({ record }: SelectedCompensatingPolicy) => record.enforcementPolicy.family ?? 'exact-policy');
    expect(await inspectCompensatingPolicy({ chainId: 4663 }, loader([exact], exact), inspect)).toBe('exact-policy');
  });
});
