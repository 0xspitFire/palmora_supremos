import { describe, expect, it } from 'vitest';
import { CanonicalStoreBridge, hasConfirmedLiveEthereumMint } from './canonical-store.js';
import { assertRobinhoodLiveAllowed } from './robinhood-enablement.js';
import { BackendApplication } from './application.js';
import { OrchestratorService } from './service-orchestrator.js';
import { EvidenceService } from './evidence.js';
import { recordWalletSimulations } from './personal-live-readiness.js';
import { ETHEREUM, NOW, OPEN_FLEET_POLICY, ROBINHOOD, WALLET_ONE, WALLET_TWO, armed, campaign, campaignInput, close, fixture } from './canonical-fixtures.js';
import { PERSONAL_LIVE_FLEET_POLICY } from './fleet-policy.js';

// The database compares expiry with its own clock, so the enablement times are relative to now (the fixture's NOW is in the past).
const REAL = new Date().toISOString();
// D-062: new enablements last until the owner revokes them.
const PERM = '9999-12-31T23:59:59.999Z';
const day = (offset: number): string => new Date(Date.parse(REAL) + offset * 86_400_000).toISOString();
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
    // A mint that was confirmed and later reorged, or failed, does not count; another clean confirmed mint does.
    const two = state() as unknown as { receipts: Array<Record<string, unknown>> };
    two.receipts = [{ id: 'a', runId: 'r1', executionId: 'e1', state: 'Confirmed' }, { id: 'b', runId: 'r1', executionId: 'e1', state: 'Reorged' }];
    expect(hasConfirmedLiveEthereumMint({ ...(state() as object), receipts: two.receipts } as never)).toBe(false);
    two.receipts = [{ id: 'a', runId: 'r1', executionId: 'e1', state: 'Confirmed' }, { id: 'b', runId: 'r1', executionId: 'e1', state: 'Failed' }];
    expect(hasConfirmedLiveEthereumMint({ ...(state() as object), receipts: two.receipts } as never)).toBe(false);
    two.receipts = [{ id: 'a', runId: 'r1', executionId: 'e1', state: 'Confirmed' }, { id: 'b', runId: 'r1', executionId: 'e2', state: 'Reorged' }, { id: 'c', runId: 'r1', executionId: 'e3', state: 'Confirmed' }];
    expect(hasConfirmedLiveEthereumMint({ ...(state() as object), receipts: two.receipts } as never)).toBe(true);
  });
});

describe('Robinhood enablement through the canonical store (T-032 part B2)', () => {
  it('has no record by default, and refuses to enable without a proven Ethereum live mint', async () => {
    const value = await fixture(ROBINHOOD);
    try {
      expect(value.store.robinhoodEnablement()).toBeUndefined();
      expect(() => value.store.enableRobinhood({ id: 'rh-1', approvedAt: REAL, expiresAt: PERM, evidence: { ...EVIDENCE }, paidAllowed: false, confirmationDigest: DIGEST })).toThrow('ETHEREUM_LIVE_MINT_REQUIRED');
      expect(value.store.robinhoodEnablement()).toBeUndefined();
      expect(value.db.prepare('SELECT count(*) AS n FROM robinhood_enablement').get()).toEqual({ n: 0 });
      expect(() => assertRobinhoodLiveAllowed('free', value.store.robinhoodEnablement(), new Date(REAL))).toThrow('ROBINHOOD_EXECUTION_DISABLED');
    } finally { await close(value); }
  });

  it('an imported Ethereum mint proof (T-062, D-064) counts, and nothing else does: no proof, no enablement, and the proof alone enables nothing', async () => {
    const value = await fixture(ROBINHOOD);
    try {
      expect(value.store.ethereumLiveMintProven()).toBe(false);
      value.store.recordEthereumLiveMintProofs([{ id: 'proof-1', txHash: `0x${'1'.repeat(64)}`, blockNumber: '26227572', blockHash: `0x${'ab'.repeat(32)}`, seadropAddress: '0x00005ea00ac477b1030ce78506496e8c2de24bf5', sender: '0x1111111111111111111111111111111111111111', nftContract: '0xa686fde3299d5451af22382240e0dff62f7b94db', callSelector: '0x161ac21f', evidenceReference: 'Docs/phase3-first-live-evidence.md', approvedAt: REAL, confirmationDigest: 'c'.repeat(64) }]);
      expect(value.store.ethereumLiveMintProven()).toBe(true);
      // The proof is not an enablement: Robinhood stays off, free and paid, until the owner's own evidence file is recorded.
      expect(value.store.robinhoodEnablement()).toBeUndefined();
      expect(() => assertRobinhoodLiveAllowed('free', value.store.robinhoodEnablement(), new Date(REAL))).toThrow('ROBINHOOD_EXECUTION_DISABLED');
      expect(value.db.prepare("SELECT execution_enabled AS e FROM chain_profile WHERE chain_id = 4663").get()).not.toMatchObject({ e: 1 });
      value.store.enableRobinhood({ id: 'rh-1', approvedAt: REAL, expiresAt: PERM, evidence: { ...EVIDENCE }, paidAllowed: false, confirmationDigest: DIGEST });
      expect(() => assertRobinhoodLiveAllowed('free', value.store.robinhoodEnablement(), new Date(REAL))).not.toThrow();
      expect(() => assertRobinhoodLiveAllowed('paid', value.store.robinhoodEnablement(), new Date(REAL))).toThrow('ROBINHOOD_PAID_MINTS_DISABLED');
    } finally { await close(value); }
  });

  it('with the proof, writes the record, enables the profile, and the policy then says yes for free and no for paid', async () => {
    const value = await fixture(ROBINHOOD);
    const proven = new ProvenStore(value.db, { now: () => new Date(REAL) });
    try {
      await proven.open();
      proven.enableRobinhood({ id: 'rh-1', approvedAt: REAL, expiresAt: PERM, evidence: { ...EVIDENCE }, paidAllowed: false, confirmationDigest: DIGEST });
      expect(value.db.prepare("SELECT execution_enabled AS e, verification_status AS s FROM chain_profile WHERE chain_id = 4663").get()).toEqual({ e: 1, s: 'verified' });
      const record = value.store.robinhoodEnablement();
      expect(record).toMatchObject({ recordId: 'rh-1', approvedBy: 'owner-cli', paidAllowed: false });
      expect(() => assertRobinhoodLiveAllowed('free', record, new Date(REAL))).not.toThrow();
      expect(() => assertRobinhoodLiveAllowed('paid', record, new Date(REAL))).toThrow('ROBINHOOD_PAID_MINTS_DISABLED');
      // No end date any more: a year later it still allows free; before the approval it never did.
      expect(() => assertRobinhoodLiveAllowed('free', record, new Date(day(400)))).not.toThrow();
      expect(() => assertRobinhoodLiveAllowed('free', record, new Date(day(-1)))).toThrow('ROBINHOOD_EXECUTION_DISABLED');
    } finally { proven.close(); await close(value); }
  });

  it('admits paid Robinhood only from a complete paid record and applies the D-041 price and two-wallet limits', async () => {
    const value = await fixture(ROBINHOOD, false, true, '2099-01-01T00:00:00.000Z', true, PERSONAL_LIVE_FLEET_POLICY);
    const proven = new ProvenStore(value.db, { now: () => new Date(REAL), fleetPolicy: PERSONAL_LIVE_FLEET_POLICY });
    try {
      await proven.open();
      const paidEvidence = { ...EVIDENCE, paidRehearsal: true, paidPolicyApproved: true } as const;
      proven.enableRobinhood({ id: 'rh-paid', approvedAt: REAL, expiresAt: PERM, evidence: paidEvidence, paidAllowed: true, confirmationDigest: DIGEST });
      expect(() => assertRobinhoodLiveAllowed('paid', proven.robinhoodEnablement(), new Date(REAL))).not.toThrow();
      const paidFixture = { ...value, store: proven, application: new BackendApplication(proven, {} as never) };
      const paidCampaign = await campaign(paidFixture, ROBINHOOD, true);
      const prepared = await armed(paidFixture, paidCampaign, [WALLET_ONE, WALLET_TWO]);
      const admission = await proven.admitExecution(prepared.input);
      expect(admission.reservations).toHaveLength(2);
      expect(value.db.prepare("SELECT COUNT(*) AS n FROM spend_reservation WHERE campaign_id = ? AND mint_class = 'paid' AND CAST(mint_value_wei AS INTEGER) = 100").get(paidCampaign.id)).toEqual({ n: 2 });

      const tooExpensive = { ...campaignInput(ROBINHOOD, true), mintPriceWei: PERSONAL_LIVE_FLEET_POLICY.paidMaxPricePerNftWei + 1n, maxRunWei: 10n ** 18n, dailyCapWei: 10n ** 18n };
      const expensiveCampaign = await paidFixture.application.createCampaign(tooExpensive);
      const expensive = await armed(paidFixture, expensiveCampaign, [WALLET_ONE], [], '-expensive');
      await expect(proven.admitExecution(expensive.input)).rejects.toThrow('PAID_PRICE_PER_NFT_EXCEEDED');
      const another = await campaign(paidFixture, ROBINHOOD, true);
      const third = '0x3333333333333333333333333333333333333333';
      const threeWallets = await armed(paidFixture, another, [WALLET_ONE, WALLET_TWO, third], [], '-three');
      await expect(proven.admitExecution(threeWallets.input)).rejects.toThrow('PAID_WALLET_LIMIT_EXCEEDED');
    } finally { proven.close(); await close(value); }
  });

  describe('the enablement writes the chain evidence a live arm reads (D-065 item 2)', () => {
    const live = async () => {
      const value = await fixture(ROBINHOOD);
      const proven = new ProvenStore(value.db, { now: () => new Date(REAL) });
      await proven.open();
      proven.enableRobinhood({ id: 'rh-1', approvedAt: REAL, expiresAt: PERM, evidence: { ...EVIDENCE }, paidAllowed: false, confirmationDigest: DIGEST });
      const evidence = proven.snapshot().chainEvidence.find((item) => item.chainId === ROBINHOOD && item.status === 'accepted' && item.executionEnabled)!;
      const application = new BackendApplication(proven, {} as never);
      const created = await application.createCampaign({ ...campaignInput(ROBINHOOD), chainVerification: { chainId: ROBINHOOD, status: 'verified', seaDropCompatible: true, evidenceId: evidence.id, checkedAt: evidence.checkedAt, sourceBlock: evidence.sourceBlock, endpointReference: evidence.endpointIdentity } });
      value.db.prepare('INSERT OR IGNORE INTO wallet (id, chain_profile_id, address, key_reference, created_at) VALUES (?, ?, ?, ?, ?)').run('wallet-rh-evidence', 'profile-4663', WALLET_ONE, 'test-key', NOW);
      value.db.prepare('INSERT OR IGNORE INTO campaign_wallet (campaign_id, wallet_id, enabled, selected_at) VALUES (?, ?, 1, ?)').run(created.id, 'wallet-rh-evidence', NOW);
      const ids = await recordWalletSimulations(proven, created, [{ wallet: WALLET_ONE, success: true }], { blockNumber: 5n, blockHash: '0xabc' }, () => new Date(REAL));
      const service = new EvidenceService(proven, () => new Date(REAL));
      return { value, proven, evidence, created, ids, service };
    };

    it('carries every fact the arm needs, so a real enablement can pass assertLiveEvidence, and revoking it ends that', async () => {
      const { value, proven, evidence, created, ids, service } = await live();
      try {
        expect(evidence).toMatchObject({ seaDropCompatible: true, positiveLivePath: true, archiveForkPassed: true, reconciliationPassed: true, finalityPassed: true, endpointIdentity: 'robinhood-sequencer', strategyVersion: 'seadrop-v1-public@1', sourceBlock: 1n, acceptedBy: 'owner-cli', expiresAt: PERM });
        expect(Object.values(evidence.negativeCases)).toEqual(Array(9).fill(true));
        expect(evidence.approvalProof).toBe(DIGEST);
        expect(service.assertLiveEvidence({ campaign: created, wallets: [WALLET_ONE], simulationIds: ids, evidenceAt: REAL })).toEqual(ids);
        proven.revokeRobinhood({ id: 'rev-1', confirmationDigest: DIGEST });
        expect(() => new EvidenceService(proven, () => new Date(REAL)).assertLiveEvidence({ campaign: created, wallets: [WALLET_ONE], simulationIds: ids, evidenceAt: REAL })).toThrow('CHAIN_VERIFICATION_NOT_ACCEPTED');
      } finally { proven.close(); await close(value); }
    });

    it('after a revoke and a new record, only the newest enablement\'s evidence counts; the older one never comes back', async () => {
      const { value, proven, evidence, created, ids } = await live();
      try {
        proven.revokeRobinhood({ id: 'rev-1', confirmationDigest: DIGEST });
        proven.enableRobinhood({ id: 'rh-2', approvedAt: new Date(Date.parse(REAL) + 1000).toISOString(), expiresAt: PERM, evidence: { ...EVIDENCE }, paidAllowed: false, confirmationDigest: 'c'.repeat(64) });
        const service = new EvidenceService(proven, () => new Date(REAL));
        const evidenceRows = proven.snapshot().chainEvidence.filter((item) => item.chainId === ROBINHOOD && item.status === 'accepted');
        expect(evidenceRows.filter((item) => item.executionEnabled)).toHaveLength(1);
        expect(evidenceRows.find((item) => item.id === evidence.id)?.executionEnabled).toBe(false);
        expect(() => service.assertLiveEvidence({ campaign: created, wallets: [WALLET_ONE], simulationIds: ids, evidenceAt: REAL })).toThrow('CHAIN_VERIFICATION_NOT_ACCEPTED');
      } finally { proven.close(); await close(value); }
    });

    it('fails closed when any single fact is missing, or the snapshot no longer matches', async () => {
      const { value, proven, evidence, created, ids } = await live();
      try {
        const check = (changed: Partial<typeof evidence> | { negativeCases: Record<string, boolean> }) => new EvidenceService({ ...proven, snapshot: () => ({ ...proven.snapshot(), chainEvidence: [{ ...evidence, ...changed }] }) } as never, () => new Date(REAL)).assertLiveEvidence({ campaign: created, wallets: [WALLET_ONE], simulationIds: ids, evidenceAt: REAL });
        expect(() => check({})).not.toThrow();
        expect(() => check({ seaDropCompatible: false })).toThrow('SEADROP_EVIDENCE_REQUIRED');
        expect(() => check({ positiveLivePath: false })).toThrow('SEADROP_EVIDENCE_REQUIRED');
        expect(() => check({ archiveForkPassed: false })).toThrow('ROBINHOOD_SAFETY_EVIDENCE_INCOMPLETE');
        expect(() => check({ reconciliationPassed: false })).toThrow('ROBINHOOD_SAFETY_EVIDENCE_INCOMPLETE');
        expect(() => check({ finalityPassed: false })).toThrow('ROBINHOOD_SAFETY_EVIDENCE_INCOMPLETE');
        for (const name of Object.keys(evidence.negativeCases)) expect(() => check({ negativeCases: { ...evidence.negativeCases, [name]: false } }), name).toThrow('ROBINHOOD_NEGATIVE_EVIDENCE_INCOMPLETE');
        expect(() => check({ executionEnabled: false })).toThrow('CHAIN_VERIFICATION_NOT_ACCEPTED');
        expect(() => check({ status: 'pending' })).toThrow('CHAIN_VERIFICATION_NOT_ACCEPTED');
        expect(() => check({ endpointIdentity: 'another-endpoint' })).toThrow('CHAIN_VERIFICATION_PROVENANCE_REQUIRED');
        expect(() => check({ checkedAt: '2026-01-01T00:00:00.000Z' })).toThrow('CHAIN_VERIFICATION_SNAPSHOT_MISMATCH');
      } finally { proven.close(); await close(value); }
    });
  });

  it('lets a free Robinhood run get past the chain checks while enabled, and refuses again once revoked', async () => {
    const value = await fixture(ROBINHOOD);
    const proven = new ProvenStore(value.db, { now: () => new Date(REAL) });
    try {
      await proven.open();
      const campaignValue = await campaign(value, ROBINHOOD);
      const prepared = await armed(value, campaignValue);
      await expect(value.store.admitExecution(prepared.input)).rejects.toThrow('ROBINHOOD_EXECUTION_DISABLED');
      proven.enableRobinhood({ id: 'rh-1', approvedAt: REAL, expiresAt: PERM, evidence: { ...EVIDENCE }, paidAllowed: false, confirmationDigest: DIGEST });
      const now = new CanonicalStoreBridge(value.db, { now: () => new Date(REAL), fleetPolicy: OPEN_FLEET_POLICY });
      await now.open();
      await expect(now.admitExecution(prepared.input)).resolves.toBeDefined();
      // (That it stays allowed with time is shown at the policy above; a second admission here would meet D-056's stale-reservation rule.)
      const later = new CanonicalStoreBridge(value.db, { now: () => new Date(REAL), fleetPolicy: OPEN_FLEET_POLICY });
      await later.open();
      proven.revokeRobinhood({ id: 'rev-1', confirmationDigest: DIGEST });
      const afterRevoke = await armed(value, await campaign(value, ROBINHOOD), [WALLET_ONE], [], '-revoked');
      await expect(later.admitExecution(afterRevoke.input)).rejects.toThrow('ROBINHOOD_EXECUTION_DISABLED');
      later.close();
    } finally { proven.close(); await close(value); }
  });

  it('never switches itself off with time; the owner revocation switches it off', async () => {
    const value = await fixture(ROBINHOOD);
    const proven = new ProvenStore(value.db, { now: () => new Date(REAL) });
    try {
      await proven.open();
      proven.enableRobinhood({ id: 'rh-1', approvedAt: REAL, expiresAt: PERM, evidence: { ...EVIDENCE }, paidAllowed: false, confirmationDigest: DIGEST });
      expect(proven.disableExpiredRobinhood()).toBe(false);
      const later = new CanonicalStoreBridge(value.db, { now: () => new Date(day(400)) });
      await later.open();
      expect(later.disableExpiredRobinhood()).toBe(false);
      expect(value.db.prepare("SELECT execution_enabled AS e FROM chain_profile WHERE chain_id = 4663").get()).toEqual({ e: 1 });
      expect(later.revokeRobinhood({ id: 'rev-1', confirmationDigest: DIGEST })).toEqual({ enablementId: 'rh-1' });
      expect(value.db.prepare("SELECT execution_enabled AS e FROM chain_profile WHERE chain_id = 4663").get()).toEqual({ e: 0 });
      expect(later.robinhoodEnablement()).toBeUndefined();
      expect(() => later.revokeRobinhood({ id: 'rev-2', confirmationDigest: DIGEST })).toThrow('NOTHING_TO_REVOKE');
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

describe('the service tick leaves a permanent enablement alone (D-062)', () => {
  const idleJobs = { open: async () => undefined, list: async () => [], recoverRunning: async () => 0, claimDue: async () => [], update: async () => undefined, put: async () => undefined } as never;
  const run = async (clock: string) => {
    const value = await fixture(ROBINHOOD);
    const proven = new ProvenStore(value.db, { now: () => new Date(REAL) });
    await proven.open();
    proven.enableRobinhood({ id: 'rh-1', approvedAt: REAL, expiresAt: PERM, evidence: { ...EVIDENCE }, paidAllowed: false, confirmationDigest: DIGEST });
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

  it('keeps Robinhood on at any later time; only a revocation (tested above) switches it off', async () => {
    expect(await run(day(3))).toBe(1);
    expect(await run(day(400))).toBe(1);
  });
});
