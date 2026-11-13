import { describe, expect, it } from 'vitest';
import { AdaptiveFeedbackController, trainAdaptiveCandidate, type AdaptiveGovernancePolicy, type FeedbackSample } from './adaptive-feedback.js';
import { DurableStore } from '../store.js';
const NOW = new Date('2026-11-13T12:00:00Z');
const policy: AdaptiveGovernancePolicy = { version: 'adaptive-governance-v1', decisionId: 'D-093', policyId: 'owner-policy', ownerApprovalDigest: `sha256:${'a'.repeat(64)}`, chainId: 1, approvedAt: '2026-11-01T00:00:00Z', expiresAt: '2027-01-01T00:00:00Z', minimumOutcomes: 50, minimumCollections: 10, holdoutBps: 2000, minimumHoldout: 10, maximumWeightChangeBps: 2000, maximumScoreChange: 10, epochLifetimeDays: 30 };
function samples(): FeedbackSample[] {
  return Array.from({ length: 50 }, (_, i) => ({ id: `sample-${i}`, sourceReference: `receipt:${i}`, chainId: 1, collection: `0x${(i % 10 + 1).toString(16).padStart(40, '0')}`, sourceWallet: '0x1111111111111111111111111111111111111111', decisionAt: new Date(Date.parse('2026-10-01T00:00:00Z') + i * 86_400_000 / 2).toISOString(), outcomeAt: new Date(Date.parse('2026-10-01T01:00:00Z') + i * 86_400_000 / 2).toISOString(), status: 'confirmed', synthetic: false, costBasisWei: '100', grossProceedsWei: i % 5 === 0 && i < 40 ? '90' : '150', dispositionFeesWei: '10', realizedPnlWei: i % 5 === 0 && i < 40 ? '-20' : '40', baselineScore: 75, eligibleFreeWatched: true, factors: [{ code: 'demand', points: 3, max: 4 }] }));
}

describe('bounded owner-governed adaptive epochs', () => {
  it('trains chronological holdout only from genuinely measured complete outcomes', () => {
    const candidate = trainAdaptiveCandidate(samples(), policy, NOW);
    expect(candidate.validation).toMatchObject({ training: 40, holdout: 10, collections: 10, baselinePnlWei: '400', candidatePnlWei: '400' });
    expect(candidate.holdoutIds).toEqual(samples().slice(40).map(row => row.id));
    expect(Object.values(candidate.weightsBps).every(weight => weight >= 8000 && weight <= 12000)).toBe(true);
  });
  it.each(['synthetic', 'missing-cost', 'pending', 'cross-chain', 'future', 'bad-cost', 'leaked-future-outcome', 'few-collections'] as const)('refuses insufficient or invalid %s history', kind => {
    const rows = samples().map(row => ({ ...row }));
    if (kind === 'few-collections') rows.forEach(row => { row.collection = rows[0]!.collection; });
    else if (kind === 'leaked-future-outcome') rows.slice(0, 40).forEach(row => { row.outcomeAt = NOW.toISOString(); });
    else rows.forEach(row => {
      if (kind === 'synthetic') row.synthetic = true;
      if (kind === 'missing-cost') row.costBasisWei = null;
      if (kind === 'pending') row.status = 'pending';
      if (kind === 'cross-chain') row.chainId = 8453;
      if (kind === 'future') row.outcomeAt = '2027-01-01T00:00:00Z';
      if (kind === 'bad-cost') row.realizedPnlWei = '1000';
    });
    expect(() => trainAdaptiveCandidate(rows, policy, NOW)).toThrow('ADAPTIVE_MEASURED_HISTORY_INSUFFICIENT');
  });
  it('refuses a negative held-out result and conflicting/reorged lineage', () => {
    const rows = samples(); rows.slice(40).forEach(row => { row.grossProceedsWei = '90'; row.realizedPnlWei = '-20'; });
    expect(() => trainAdaptiveCandidate(rows, policy, NOW)).toThrow('ADAPTIVE_HOLDOUT_NOT_BETTER_OR_EQUAL');
    const reorg = samples(); reorg[0]!.status = 'reorged';
    expect(() => trainAdaptiveCandidate(reorg, policy, NOW)).toThrow('ADAPTIVE_MEASURED_HISTORY_INSUFFICIENT');
  });
  it('is disabled without approved policy and requires exact first-model acceptance before activation', async () => {
    const store = new DurableStore();
    const disabled = new AdaptiveFeedbackController(store, undefined, () => NOW);
    expect(disabled.active(1)).toBeUndefined();
    await expect(disabled.propose(samples())).rejects.toThrow('ADAPTIVE_OWNER_POLICY_REQUIRED');
    const controller = new AdaptiveFeedbackController(store, policy, () => NOW);
    const candidate = await controller.propose(samples());
    await expect(controller.promote(candidate.id)).rejects.toThrow('ADAPTIVE_INITIAL_MODEL_OWNER_APPROVAL_REQUIRED');
    await expect(controller.acceptInitialCandidate(candidate.id, 'yes')).rejects.toThrow('ADAPTIVE_INITIAL_MODEL_OWNER_APPROVAL_REQUIRED');
    await controller.acceptInitialCandidate(candidate.id, controller.initialAcceptancePhrase(candidate.id));
    const model = await controller.promote(candidate.id);
    expect(model.maxScoreChange).toBe(10);
    expect(new AdaptiveFeedbackController(store, policy, () => NOW).active(1)?.epochId).toBe(model.epochId);
    expect(controller.active(8453)).toBeUndefined();
    await controller.rollback(); expect(controller.active(1)).toBeUndefined();
    await expect(controller.promote(candidate.id)).rejects.toThrow('ADAPTIVE_MODEL_NOT_ACTIVE');
  });
  it('invalidates active lineage and falls back to static on reorg or epoch expiry', async () => {
    const store = new DurableStore(); const controller = new AdaptiveFeedbackController(store, policy, () => NOW);
    const candidate = await controller.propose(samples());
    await controller.acceptInitialCandidate(candidate.id, controller.initialAcceptancePhrase(candidate.id));
    await controller.promote(candidate.id);
    await controller.invalidateReferences(['receipt:2']);
    expect(controller.active(1)).toBeUndefined();
    await expect(controller.promote(candidate.id)).rejects.toThrow('ADAPTIVE_LINEAGE_INVALIDATED');
    expect(controller.active(1, new Date(NOW.getTime() + 31 * 86_400_000))).toBeUndefined();
    expect(store.snapshot().events.filter(event => event.type === 'adaptive_model_promoted')).toHaveLength(1);
  });
});

 it('copies governance input and rejects a cross-chain attempt to restore invalidated training references',async()=>{
 const mutable={...policy};const controller=new AdaptiveFeedbackController(new DurableStore(),mutable,()=>NOW);mutable.maximumScoreChange=100;
 const candidate=await controller.propose(samples());expect(candidate.policyDigest).not.toBe('');
 const rows=samples();rows.push({...rows[0]!,status:'reorged'});rows.push({...rows[0]!,id:'base-copy',chainId:8453});
 expect(()=>trainAdaptiveCandidate(rows,policy,NOW)).toThrow('ADAPTIVE_MEASURED_HISTORY_INSUFFICIENT');
 });
