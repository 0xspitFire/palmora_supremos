import { describe, expect, it } from 'vitest';
import { buildRotationReport, type RotationInput } from './turnkey-rotation-report.js';

const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const wallet = (index: number, id: string) => ({ index, signWith: id, address: addr(index + 1) });
const NOW = new Date('2026-10-28T12:00:00.000Z');
const E = 10n ** 18n;

function base(overrides: Partial<RotationInput> = {}): RotationInput {
  const previous = { wallets: [wallet(0, 'old'), wallet(1, 'keep')], expiresAt: '2027-01-01T00:00:00.000Z', policyId: 'p-old' };
  const active = { wallets: [wallet(0, 'keep'), wallet(1, 'new')].map((w, i) => ({ ...w, index: i, address: i === 0 ? addr(2) : addr(3) })), expiresAt: '2027-01-01T00:00:00.000Z', policyId: 'p-new' };
  return {
    now: NOW,
    activeDigest: 'sha256:aaa',
    active,
    previous,
    catalog: [active],
    installedMap: active.wallets,
    activeRecordText: '{"record":"active"}',
    walletMapText: '{"map":true}',
    providerKeys: [{ privateKeyId: 'keep', curve: 'CURVE_SECP256K1', exported: false, address: addr(2) }, { privateKeyId: 'new', curve: 'CURVE_SECP256K1', exported: false, address: addr(3) }],
    providerPolicies: [{ policyId: 'p-new', effect: 'EFFECT_ALLOW', text: 'private_key.id in [keep,new]' }],
    balances: [1, 8453, 4663].flatMap((chainId) => [{ chainId, address: addr(2), wei: E / 1000n }, { chainId, address: addr(3), wei: 0n }]),
    ceilings: { 1: { walletMaxWei: E / 100n, fleetMaxWei: E / 50n }, 8453: { walletMaxWei: E / 100n, fleetMaxWei: E / 50n }, 4663: { walletMaxWei: E / 100n, fleetMaxWei: E / 50n } },
    rehearsal: { recordedAt: '2026-10-28T11:00:00.000Z', policyRecordDigest: 'sha256:aaa', broadcastAttempted: false, rawText: '{"rehearsal":1}' },
    retired: ['old'],
    ...overrides,
  };
}

const problems = (input: RotationInput) => { const result = buildRotationReport(input); return result.ok ? '' : result.problems.join(' | '); };

describe('D-078 rotation report', () => {
  it('builds the exact report the collector expects when every check passes, with five real digests', () => {
    const result = buildRotationReport(base());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.report).sort()).toEqual(['checks', 'completedAt', 'environment', 'references', 'status', 'type', 'version']);
    expect(Object.keys(result.report.checks).sort()).toEqual(['fresh_wallet_inventory', 'funding_profile_bounded', 'old_references_excluded']);
    expect(result.report.references.map((r) => r.name)).toEqual(['canonical-policy-record', 'production-wallet-map', 'bounded-funding-profile', 'no-broadcast-rehearsal', 'old-reference-exclusion']);
    expect(result.report.references.every((r) => /^[0-9a-f]{64}$/.test(r.sha256))).toBe(true);
    const text = JSON.stringify(result.report);
    expect(text).not.toMatch(/0x[0-9a-f]{40}/);
    expect(result.report.checks.fresh_wallet_inventory.observed).toBe('2 live wallets match the installed record; 1 new since the previous record');
  });

  it('refuses when a retired reference is still in the record, the map, the catalog or a live allow policy', () => {
    expect(problems(base({ retired: ['keep'] }))).toMatch(/installed record.*installed wallet map.*catalog.*allow policy/);
    const staleCatalog = base();
    expect(problems({ ...staleCatalog, catalog: [staleCatalog.active, staleCatalog.previous] })).toMatch(/unexpired catalog record/);
    expect(problems(base({ providerPolicies: [{ policyId: 'p-old', effect: 'EFFECT_ALLOW', text: 'private_key.id in [old]' }] }))).toMatch(/live provider allow policy/);
  });

  it('does not count a provider DENY policy as authorization', () => {
    expect(problems(base({ providerPolicies: [{ policyId: 'd', effect: 'EFFECT_DENY', text: 'private_key.id in [old]' }] }))).toBe('');
  });

  it('refuses when nothing was retired, or the named reference was never in the previous record', () => {
    expect(problems(base({ retired: [] }))).toMatch(/at least one wallet/);
    expect(problems(base({ retired: ['never-existed'] }))).toMatch(/not in the previous record/);
  });

  it('refuses when no wallet is new, the map mismatches, or a key is exported, wrong curve or has another address', () => {
    const same = base();
    expect(problems({ ...same, previous: same.active })).toMatch(/nothing was rotated in/);
    expect(problems(base({ installedMap: [wallet(0, 'keep')] }))).toMatch(/map does not match/);
    expect(problems(base({ providerKeys: [{ privateKeyId: 'keep', curve: 'CURVE_SECP256K1', exported: true, address: addr(2) }, { privateKeyId: 'new', curve: 'CURVE_SECP256K1', exported: false, address: addr(3) }] }))).toMatch(/not live, unexported/);
    expect(problems(base({ providerKeys: [{ privateKeyId: 'keep', curve: 'CURVE_SECP256K1', exported: false, address: addr(9) }, { privateKeyId: 'new', curve: 'CURVE_SECP256K1', exported: false, address: addr(3) }] }))).toMatch(/not live, unexported/);
  });

  it('refuses when funding exceeds a ceiling, a balance is missing, or no ceilings were given', () => {
    const over = base().balances.map((b) => (b.chainId === 4663 && b.address === addr(2) ? { ...b, wei: E } : b));
    expect(problems(base({ balances: over }))).toMatch(/Chain 4663: a wallet holds more/);
    expect(problems(base({ balances: base().balances.filter((b) => b.chainId !== 8453) }))).toMatch(/Chain 8453: a balance could not be read/);
    expect(problems(base({ ceilings: {} }))).toMatch(/cannot be proven bounded|No balance ceilings/);
    const crowded = base({ ceilings: { 1: { walletMaxWei: E, fleetMaxWei: E / 10000n } } });
    expect(problems(crowded)).toMatch(/fleet holds more/);
  });

  it('refuses a rehearsal for another record, a stale one, or one that does not say nothing was broadcast', () => {
    expect(problems(base({ rehearsal: { ...base().rehearsal, policyRecordDigest: 'sha256:bbb' } }))).toMatch(/different policy record/);
    expect(problems(base({ rehearsal: { ...base().rehearsal, recordedAt: '2026-10-26T00:00:00.000Z' } }))).toMatch(/older than 24 hours/);
    expect(problems(base({ rehearsal: { ...base().rehearsal, broadcastAttempted: true } }))).toMatch(/nothing was broadcast/);
  });
});
