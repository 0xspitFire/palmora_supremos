import { describe, expect, it, vi } from 'vitest';
import { DurableStore } from './store.js';
import { EvidenceService, campaignInputDigest, SEADROP_PUBLIC_FREE_ALLOWLIST_BASELINE as BASELINE, SEADROP_PUBLIC_FREE_ALLOWLIST_SIGNED_BASELINE as SIGNED_BASELINE } from './evidence.js';
import { ExecutionCoordinator } from './coordinator.js';
import type { Campaign, ChainEvidenceRecord, EngineAdapter } from './types.js';

const at = '2020-01-01T00:00:00.000Z'; const until = '2099-01-01T00:00:00.000Z';
const binding = { provider: 'turnkey' as const, policyReference: 'turnkey-allowlist', policyDigest: `0x${'1'.repeat(64)}`, recordDigest: `sha256:${'a'.repeat(64)}` };
class Store extends DurableStore {
  override capabilities() { return { durable: true, atomicAcrossProcesses: true }; }
  admitExecution(): never { throw new Error('ARM_MUST_NOT_ADMIT_EXECUTION'); }
  abortRemaining(): never { throw new Error('ARM_MUST_NOT_ABORT_EXECUTION'); }
  baseEnablement() { return { recordId: 'base', approvedBy: 'owner-cli', approvedAt: at, expiresAt: until, freeAllowed: true, paidAllowed: false,
    evidence: { reviewedCode: true, forkRehearsal: true, finality: true, endpointAgreement: true, feeObservation: true, liveSimulation: true, custodyReadiness: true }, evidenceDigest: 'a'.repeat(64), strategyVersion: BASELINE, feePolicyVersion: 'base-free-d057-v1', primaryEndpointReference: 'primary', fallbackEndpointReference: 'fallback', custodyMode: 'local-personal-live' }; }
}
async function setup(chainId: 1 | 8453 | 4663 = 1, strategyVersion: string = BASELINE) {
  const store = new Store();
  const campaign: Campaign = { id: 'campaign', state: 'Ready', chainId, contract: `0x${'2'.repeat(40)}`, strategy: 'seadrop-v1-allowlist', quantity: 1,
    dryRun: false, spendPolicy: { maxRunWei: 100n, dailyCapWei: 100n, gasCeilingWei: 100n }, createdAt: at, updatedAt: at,
    broadcastMode: chainId === 4663 ? 'sequencer' : 'public', chainVerification: { chainId, status: 'verified', seaDropCompatible: true, endpointReference: 'configured', evidenceId: 'evidence', checkedAt: at, sourceBlock: 1n },
    mintPriceWei: 0n, feePolicy: { kind: 'free', configuredPriorityFeeWei: 1n, freeTotalSpendCapWei: 100n, totalFeeBudgetWei: 100n }, custodyPolicy: binding };
  const evidence: ChainEvidenceRecord = { id: 'evidence', chainId, status: 'pending', executionEnabled: false, checkedAt: at, expiresAt: until,
    sourceBlock: 1n, sourceBlockHash: 'anchor', endpointIdentity: 'configured', strategyVersion, seaDropCompatible: true, positiveLivePath: true, archiveForkPassed: true,
    reconciliationPassed: true, finalityPassed: true, negativeCases: { revert: true, sold_out: true, price_drift: true, insufficient_funds: true, quantity_limit: true, stale_phase: true, fee_recipient: true, kill: true, cap: true } };
  const service = new EvidenceService(store, () => new Date(), { verify: (record, approval) => record.strategyVersion === strategyVersion && approval.proof === 'owner-reviewed-scope' });
  await service.recordChainEvidence(evidence); await service.acceptChainEvidence('evidence', { verifierId: 'owner-cli', proof: 'owner-reviewed-scope', acceptedAt: at });
  await store.transaction(state => {
    state.runtime = { startupState: 'Ready', blockingReasons: [], reconciliationCompletedAt: at, dependencies: { engine: true, chain: true, backup: true, notifications: true },
      operational: { secretStoreReference: 'configured', storePath: 'state.sqlite', signerReady: true, killSwitchEngaged: false, notificationReady: true, chainVerification: 'verified', observedAt: at, expiresAt: until, lastReconciliationAt: at,
        custody: { ...binding, providerIdentity: 'organization', policyStatus: 'approved', healthStatus: 'healthy', attestationStatus: 'verified', evidenceId: 'custody', observedAt: at, expiresAt: until } } };
    state.campaigns.push(campaign);
  });
  const simulate = () => service.recordSimulation({ id: 'simulation', campaignId: campaign.id, wallet: 'wallet', inputDigest: campaignInputDigest(campaign), success: true,
    sourceBlock: 1n, sourceBlockHash: 'anchor', checkedAt: at, expiresAt: until, worstCaseFeeWei: 1n });
  await simulate();
  const execute = vi.fn();
  const coordinator = new ExecutionCoordinator(store, { prepare: vi.fn(), execute, reconcile: vi.fn() } as unknown as EngineAdapter);
  const input = () => ({ campaign, wallets: ['wallet'], simulationIds: ['simulation'], evidenceAt: at });
  return { store, campaign, service, coordinator, execute, input };
}

describe('explicit public/free-allowlist chain baseline', () => {
  it.each([1, 8453, 4663] as const)('arms a bound free allowlist campaign on chain %i through the real evidence/coordinator gates', async chain => {
    const value = await setup(chain);
    expect((await value.coordinator.arm(value.input(), 'live')).state).toBe('Armed');
    expect(value.execute).not.toHaveBeenCalled();
  });
  it.each(['seadrop-v1-public', 'seadrop-v1-public@1', 'seadrop-v1-public-1', 'seadrop-v1-baseline-public-free-allowlist@2'])('does not widen legacy or unknown evidence %s', async version => {
    const value = await setup(1, version);
    await expect(value.coordinator.arm(value.input(), 'live')).rejects.toThrow('CHAIN_VERIFICATION_PROVENANCE_REQUIRED');
  });
  it('rejects paid allowlist, unsupported methods, absent bindings and mismatched signed-record selections', async () => {
    for (const change of ['paid', 'method', 'missing-binding', 'record-drift'] as const) {
      const value = await setup();
      await value.store.transaction(state => {
        const campaign = state.campaigns[0]!;
        if (change === 'paid') { campaign.mintPriceWei = 1n; campaign.feePolicy.kind = 'paid'; }
        if (change === 'method') campaign.strategy = 'seadrop-v2-allowlist';
        if (change === 'missing-binding') delete campaign.custodyPolicy;
        if (change === 'record-drift') state.runtime.operational!.custody!.recordDigest = `sha256:${'b'.repeat(64)}`;
      });
      await expect(value.coordinator.arm(value.input(), 'live')).rejects.toThrow('CHAIN_VERIFICATION_PROVENANCE_REQUIRED');
    }
  });
  it('requires fresh bound own-wallet simulation and rejects revoked chain authority', async () => {
    const value = await setup();
    await value.store.transaction(state => { state.simulations[0]!.inputDigest = 'another-policy-or-wallet-proof'; });
    await expect(value.coordinator.arm(value.input(), 'live')).rejects.toThrow('WALLET_SIMULATION_SNAPSHOT_MISMATCH');
    await value.store.transaction(state => { state.chainEvidence[0]!.executionEnabled = false; });
    await expect(value.coordinator.arm(value.input(), 'live')).rejects.toThrow('CHAIN_VERIFICATION_NOT_ACCEPTED');
  });
  it.each([1, 8453, 4663] as const)('requires a new signed baseline and current bound custody for free signed mints on chain %i', async chainId => {
    const legacy = await setup(chainId);
    legacy.campaign.strategy = 'seadrop-v1-signed';
    await legacy.store.transaction(state => { state.campaigns[0]!.strategy = 'seadrop-v1-signed'; state.simulations[0]!.inputDigest = campaignInputDigest(legacy.campaign); });
    await expect(legacy.coordinator.arm(legacy.input(), 'live')).rejects.toThrow('CHAIN_VERIFICATION_PROVENANCE_REQUIRED');

    const signed = await setup(chainId, SIGNED_BASELINE);
    signed.campaign.strategy = 'seadrop-v1-signed';
    await signed.store.transaction(state => { state.campaigns[0]!.strategy = 'seadrop-v1-signed'; state.simulations[0]!.inputDigest = campaignInputDigest(signed.campaign); });
    expect((await signed.coordinator.arm(signed.input(), 'live')).state).toBe('Armed');
    expect(signed.execute).not.toHaveBeenCalled();
  });

  it.each(['paid-value', 'paid-fee', 'missing-binding', 'record-drift', 'stale-custody', 'custody-expired', 'custody-future', 'custody-unhealthy', 'signer-unready', 'unknown-method', 'simulation-drift'] as const)('keeps signed baseline fail closed on %s', async change => {
    const value = await setup(1, SIGNED_BASELINE);
    value.campaign.strategy = 'seadrop-v1-signed';
    if (change === 'paid-value') value.campaign.mintPriceWei = 1n;
    if (change === 'paid-fee') value.campaign.feePolicy.kind = 'paid';
    if (change === 'missing-binding') delete value.campaign.custodyPolicy;
    if (change === 'unknown-method') value.campaign.strategy = 'seadrop-v2-signed';
    await value.store.transaction(state => {
      state.campaigns[0] = value.campaign;
      state.simulations[0]!.inputDigest = change === 'simulation-drift' ? 'old-policy' : campaignInputDigest(value.campaign);
      if (change === 'record-drift') state.runtime.operational!.custody!.recordDigest = `sha256:${'b'.repeat(64)}`;
      if (change === 'stale-custody') state.runtime.operational!.expiresAt = at;
      if (change === 'custody-expired') state.runtime.operational!.custody!.expiresAt = at;
      if (change === 'custody-future') state.runtime.operational!.custody!.observedAt = until;
      if (change === 'custody-unhealthy') state.runtime.operational!.custody!.healthStatus = 'unhealthy';
      if (change === 'signer-unready') state.runtime.operational!.signerReady = false;
    });
    expect(() => value.service.assertLiveEvidence(value.input())).toThrow(change === 'simulation-drift' ? 'WALLET_SIMULATION_SNAPSHOT_MISMATCH' : 'CHAIN_VERIFICATION_PROVENANCE_REQUIRED');
    expect(value.execute).not.toHaveBeenCalled();
  });

});
