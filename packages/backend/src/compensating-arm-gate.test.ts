import { describe, expect, it } from 'vitest';
import { BackendApplication } from './application.js';
import { ExecutionCoordinator } from './coordinator.js';
import { ETHEREUM, WALLET_ONE, campaign, close, fixture, noopEngine } from './canonical-fixtures.js';
import { COMPENSATING_ASSURANCE_KIND, type CompensatingAssuranceConfig, type CompensatingControlsEvidence } from './compensating-controls.js';
import type { OperationalReadiness } from './types.js';

/**
 * D-058/D-059 at the real arm gate: compensated Turnkey custody evidence is refused unless the service accepts it, and one
 * missing control stops arming and names that control. With every control current, arming moves past custody to the next wall.
 */
/** The coordinator checks custody evidence against the real clock, so this evidence is built relative to it. */
const NOW = new Date();
const FIXTURE_NOW = new Date('2026-09-14T14:00:00.000Z');
const iso = (offsetMs: number): string => new Date(NOW.getTime() + offsetMs).toISOString();
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const RECORD = `sha256:${'a'.repeat(64)}`;
const WALLET_SET = `sha256:${'b'.repeat(64)}`;
const LOCK = `sha256:${'c'.repeat(64)}`;

const controls = (): CompensatingControlsEvidence => ({
  version: 1,
  chainId: ETHEREUM,
  recordDigest: RECORD,
  walletSetDigest: WALLET_SET,
  lockfileDigest: LOCK,
  balances: { observedAt: iso(-MIN), expiresAt: iso(9 * MIN), wallets: [{ address: WALLET_ONE, balanceWei: '300000000000000' }] },
  policyRecord: { digest: RECORD, issuedAt: iso(-2 * DAY), expiresAt: iso(5 * DAY) },
  providerProbe: { observedAt: iso(-MIN), status: 'ok', policyRecordDigest: RECORD },
  signatureChecks: { transactionMatch: true, signerRecovery: true },
  rehearsal: { recordedAt: iso(-DAY), policyRecordDigest: RECORD, walletSetDigest: WALLET_SET, lockfileDigest: LOCK, broadcastAttempted: false },
  trustCenter: { reviewedAt: iso(-10 * DAY), documents: [{ name: 'report', date: '2026-08-01T00:00:00.000Z', sha256: 'd'.repeat(64) }] },
  driftResponse: { killSwitchOnDrift: true },
});

const operational = (evidence: CompensatingControlsEvidence): OperationalReadiness => ({
  secretStoreReference: 'secret-store-ref', storePath: '/tmp/state.sqlite', signerReady: true, killSwitchEngaged: false, notificationReady: true, chainVerification: 'verified',
  observedAt: iso(-MIN), expiresAt: '2099-01-01T00:00:00.000Z', lastReconciliationAt: iso(-2 * MIN),
  custody: { provider: 'turnkey', providerIdentity: 'turnkey-org', policyReference: 'turnkey:policy-1', policyDigest: `0x${'ab'.repeat(32)}`, policyStatus: 'approved', healthStatus: 'healthy', attestationStatus: 'unknown', evidenceId: 'evidence-1', observedAt: iso(-MIN), expiresAt: '2099-01-01T00:00:00.000Z', assuranceKind: COMPENSATING_ASSURANCE_KIND, compensatingControls: evidence },
} as OperationalReadiness);

const assurance: CompensatingAssuranceConfig = {
  ceilings: { [ETHEREUM]: { walletMaxWei: 400_000_000_000_000n, fleetMaxWei: 2_000_000_000_000_000n } },
  expected: { recordDigest: RECORD, walletSetDigest: WALLET_SET, lockfileDigest: LOCK },
};

async function armWith(evidence: CompensatingControlsEvidence, options: ConstructorParameters<typeof ExecutionCoordinator>[2]): Promise<string> {
  const value = await fixture(ETHEREUM, false, true, '2099-01-01T00:00:00.000Z', true, undefined, () => FIXTURE_NOW);
  try {
    const created = await campaign(value, ETHEREUM);
    const validated = { campaign: created, wallets: [WALLET_ONE], simulationIds: [] as string[], evidenceAt: FIXTURE_NOW.toISOString() };
    const application = new BackendApplication(value.store, new ExecutionCoordinator(value.store, noopEngine, options));
    await application.command('approve', { validated });
    await value.store.transaction((state) => { state.runtime.startupState = 'Ready'; state.runtime.dependencies = { engine: true, chain: true, backup: true, notifications: true }; state.runtime.operational = operational(evidence); });
    try { await application.command('arm', { validated, mode: 'live' }); return 'ARMED'; } catch (error) { return (error as Error).message.split(':')[0]!; }
  } finally { await close(value); }
}

describe('compensating controls at the live arm gate', () => {
  it('is refused when the service has not accepted the compensated kind', async () => {
    expect(await armWith(controls(), {})).toBe('CUSTODY_COMPENSATING_ASSURANCE_NOT_ACCEPTED');
  });

  it('with every control current, arming moves past custody to the next wall (per-wallet simulation records)', async () => {
    expect(await armWith(controls(), { compensatingAssurance: assurance })).toBe('PER_WALLET_SIMULATION_REQUIRED');
  });

  it('one missing control stops arming and names it', async () => {
    const withoutRehearsal = controls();
    delete withoutRehearsal.rehearsal;
    expect(await armWith(withoutRehearsal, { compensatingAssurance: assurance })).toBe('COMPENSATING_CONTROL_REHEARSAL_MISSING');
    const overFunded = controls();
    overFunded.balances = { observedAt: iso(-MIN), expiresAt: iso(9 * MIN), wallets: [{ address: WALLET_ONE, balanceWei: '400000000000001' }] };
    expect(await armWith(overFunded, { compensatingAssurance: assurance })).toBe('COMPENSATING_CONTROL_BOUNDED_BALANCES_WALLET_ABOVE_LIMIT');
  });

  it('a chain without a configured ceiling cannot arm', async () => {
    expect(await armWith(controls(), { compensatingAssurance: { ...assurance, ceilings: {} } })).toBe('COMPENSATING_CONTROL_BOUNDED_BALANCES_NO_BALANCE_CEILING_FOR_CHAIN');
  });
});
