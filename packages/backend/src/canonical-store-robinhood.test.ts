import { describe, expect, it } from 'vitest';
import { CanonicalStoreBridge, hasConfirmedLiveEthereumMint } from './canonical-store.js';
import { assertRobinhoodLiveAllowed } from './robinhood-enablement.js';
import { BackendApplication } from './application.js';
import { OrchestratorService } from './service-orchestrator.js';
import { ETHEREUM, NOW, OPEN_FLEET_POLICY, ROBINHOOD, armed, campaign, close, fixture } from './canonical-fixtures.js';

const day = (offset: number): string => new Date(Date.parse(NOW) + offset * 86_400_000).toISOString();
const EVIDENCE = { E1: true, E2: true, E3: true, E4: true, E5: true, E6: true, E7: true } as const;
const DIGEST = 'b'.repeat(64);

/** Stands in for "one Ethereum live mint has worked" without building a whole live run. */
class ProvenStore extends CanonicalStoreBridge {
  protected override hasConfirmedLiveEthereumMint(): boolean { return true; }
}

describe('hasConfirmedLiveEthereumMint (D-040 item 6)', () => {
  const state = (overrides: { mode?: 'live' | 'dry-run'; chainId?: number; receiptState?: string; runId?: string } = {}) => ({
    campaigns: [{ id: 'c1', chainId: overrides.chainId ?? 1 }],
    runs: [{ id: 'r1', campaignId: 'c1', mode: overrides.mode ?? 'live' }],
    receipts: [{ id: 'x1', runId: overrides.runId ?? 'r1', state: overrides.receiptState ?? 'Confirmed' }],
  }) as never;

  it('is true only for a confirmed receipt of a live run on Ethereum', () => {
    expect(hasConfirmedLiveEthereumMint(state())).toBe(true);
    expect(hasConfirmedLiveEthereumMint(state({ mode: 'dry-run' }))).toBe(false);
    expect(hasConfirmedLiveEthereumMint(state({ chainId: 4663 }))).toBe(false);
    expect(hasConfirmedLiveEthereumMint(state({ receiptState: 'Pending' }))).toBe(false);
    expect(hasConfirmedLiveEthereumMint(state({ receiptState: 'Failed' }))).toBe(false);
    expect(hasConfirmedLiveEthereumMint(state({ runId: 'other' }))).toBe(false);
    expect(hasConfirmedLiveEthereumMint({ campaigns: [], runs: [], receipts: [] } as never)).toBe(false);
  });
});

describe('Robinhood enablement through the canonical store (T-032 part B2)', () => {
  it('has no record by default, and refuses to enable without a proven Ethereum live mint', async () => {
    const value = await fixture(ROBINHOOD);
    try {
      expect(value.store.robinhoodEnablement()).toBeUndefined();
      expect(() => value.store.enableRobinhood({ id: 'rh-1', approvedAt: NOW, expiresAt: day(7), evidence: { ...EVIDENCE }, confirmationDigest: DIGEST })).toThrow('ETHEREUM_LIVE_MINT_REQUIRED');
      expect(value.store.robinhoodEnablement()).toBeUndefined();
      expect(value.db.prepare('SELECT count(*) AS n FROM robinhood_enablement').get()).toEqual({ n: 0 });
      expect(() => assertRobinhoodLiveAllowed('free', value.store.robinhoodEnablement(), new Date(NOW))).toThrow('ROBINHOOD_EXECUTION_DISABLED');
    } finally { await close(value); }
  });

  it('with the proof, writes the record, enables the profile, and the policy then says yes for free and no for paid', async () => {
    const value = await fixture(ROBINHOOD);
    const proven = new ProvenStore(value.db, { now: () => new Date(NOW) });
    try {
      await proven.open();
      proven.enableRobinhood({ id: 'rh-1', approvedAt: NOW, expiresAt: day(7), evidence: { ...EVIDENCE }, confirmationDigest: DIGEST });
      expect(value.db.prepare("SELECT execution_enabled AS e, verification_status AS s FROM chain_profile WHERE chain_id = 4663").get()).toEqual({ e: 1, s: 'verified' });
      const record = value.store.robinhoodEnablement();
      expect(record).toMatchObject({ recordId: 'rh-1', approvedBy: 'owner-cli', paidAllowed: false });
      expect(() => assertRobinhoodLiveAllowed('free', record, new Date(NOW))).not.toThrow();
      expect(() => assertRobinhoodLiveAllowed('paid', record, new Date(NOW))).toThrow('ROBINHOOD_PAID_MINTS_DISABLED');
      expect(() => assertRobinhoodLiveAllowed('free', record, new Date(day(7)))).toThrow('ROBINHOOD_EXECUTION_DISABLED');
      expect(() => assertRobinhoodLiveAllowed('free', record, new Date(day(-1)))).toThrow('ROBINHOOD_EXECUTION_DISABLED');
    } finally { proven.close(); await close(value); }
  });

  it('lets a free Robinhood run get past the chain checks only while the record is valid, and refuses again once it has expired', async () => {
    const value = await fixture(ROBINHOOD);
    const proven = new ProvenStore(value.db, { now: () => new Date(NOW) });
    try {
      await proven.open();
      const campaignValue = await campaign(value, ROBINHOOD);
      const prepared = await armed(value, campaignValue);
      await expect(value.store.admitExecution(prepared.input)).rejects.toThrow('ROBINHOOD_EXECUTION_DISABLED');
      proven.enableRobinhood({ id: 'rh-1', approvedAt: NOW, expiresAt: day(7), evidence: { ...EVIDENCE }, confirmationDigest: DIGEST });
      await expect(value.store.admitExecution(prepared.input)).resolves.toBeDefined();
      // Past the expiry the same store refuses again, even though the profile flag was never switched off.
      const later = new CanonicalStoreBridge(value.db, { now: () => new Date(day(8)), fleetPolicy: OPEN_FLEET_POLICY });
      await later.open();
      await expect(later.admitExecution(prepared.input)).rejects.toThrow('ROBINHOOD_EXECUTION_DISABLED');
      later.close();
    } finally { proven.close(); await close(value); }
  });

  it('switches the profile off when the record expires, and not before', async () => {
    const value = await fixture(ROBINHOOD);
    const proven = new ProvenStore(value.db, { now: () => new Date(NOW) });
    try {
      await proven.open();
      proven.enableRobinhood({ id: 'rh-1', approvedAt: NOW, expiresAt: day(7), evidence: { ...EVIDENCE }, confirmationDigest: DIGEST });
      expect(proven.disableExpiredRobinhood()).toBe(false);
      const later = new CanonicalStoreBridge(value.db, { now: () => new Date(day(7)) });
      await later.open();
      expect(later.disableExpiredRobinhood()).toBe(true);
      expect(value.db.prepare("SELECT execution_enabled AS e FROM chain_profile WHERE chain_id = 4663").get()).toEqual({ e: 0 });
      expect(later.disableExpiredRobinhood()).toBe(false);
      later.close();
    } finally { proven.close(); await close(value); }
  });

  it('does nothing for Ethereum: a Robinhood record never enables or disables the Ethereum profile', async () => {
    const value = await fixture(ETHEREUM);
    try {
      expect(value.store.disableExpiredRobinhood()).toBe(false);
      expect(value.db.prepare('SELECT execution_enabled AS e FROM chain_profile WHERE chain_id = 1').get()).toEqual({ e: 1 });
    } finally { await close(value); }
  });
});

describe('the service switches Robinhood off when the record expires (D-051)', () => {
  const idleJobs = { open: async () => undefined, list: async () => [], recoverRunning: async () => 0, claimDue: async () => [], update: async () => undefined, put: async () => undefined } as never;
  const run = async (clock: string) => {
    const value = await fixture(ROBINHOOD);
    const proven = new ProvenStore(value.db, { now: () => new Date(NOW) });
    await proven.open();
    proven.enableRobinhood({ id: 'rh-1', approvedAt: NOW, expiresAt: day(7), evidence: { ...EVIDENCE }, confirmationDigest: DIGEST });
    const store = new CanonicalStoreBridge(value.db, { now: () => new Date(clock), fleetPolicy: OPEN_FLEET_POLICY });
    await store.open();
    const coordinator = { start: async () => undefined, reconcile: async () => ({}) } as never;
    const service = new OrchestratorService(store, new BackendApplication(store, coordinator), coordinator, { jobs: idleJobs, now: () => new Date(clock), schedulerIntervalMs: 3_600_000, reconciliationIntervalMs: 3_600_000 });
    await service.start();
    await service.stop();
    const enabled = (value.db.prepare('SELECT execution_enabled AS e FROM chain_profile WHERE chain_id = 4663').get() as { e: number }).e;
    store.close();
    proven.close();
    await close(value);
    return enabled;
  };

  it('leaves a valid enablement alone and switches an expired one off on the first tick', async () => {
    expect(await run(day(3))).toBe(1);
    expect(await run(day(8))).toBe(0);
  });
});

