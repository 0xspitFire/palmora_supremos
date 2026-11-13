import { createHash } from 'node:crypto';
import type { BackendStore } from '../store.js';
import { isMeasuredOutcome, measuredOutcomes, validActiveModel, type ActiveAdaptiveModel, type IntelligenceChainId, type MeasuredIntelligenceOutcome } from './advanced-scoring.js';

export interface AdaptiveGovernancePolicy {
  version: 'adaptive-governance-v1'; decisionId: 'D-093'; policyId: string; ownerApprovalDigest: string;
  approvedAt: string; expiresAt: string; chainId: IntelligenceChainId;
  minimumOutcomes: number; minimumCollections: number; holdoutBps: 2000; minimumHoldout: number;
  maximumWeightChangeBps: number; maximumScoreChange: number; epochLifetimeDays: number;
}
export interface FeedbackSample extends MeasuredIntelligenceOutcome {
  baselineScore: number; eligibleFreeWatched: boolean;
  factors: readonly { code: string; points: number; max: number }[];
}
export interface AdaptiveCandidate {
  version: 'adaptive-candidate-v1'; id: string; policyDigest: string; chainId: IntelligenceChainId; createdAt: string;
  trainingIds: string[]; holdoutIds: string[]; sourceReferences: string[]; weightsBps: Record<string, number>;
  validation: { training: number; holdout: number; collections: number; baselinePnlWei: string; candidatePnlWei: string; candidateSelected: number };
}
const OPAQUE = /^[A-Za-z0-9_.:-]{1,160}$/;
const FACTORS = new Set(['track_record', 'project_reputation', 'convergence', 'price', 'floor_margin', 'known_pattern', 'contract_code', 'verified_source', 'contract_age', 'demand', 'freshness']);
const digest = (value: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
export function adaptivePolicyDigest(policy: AdaptiveGovernancePolicy): string { return digest(policy); }
export function validAdaptivePolicy(policy: AdaptiveGovernancePolicy | undefined, now: Date): policy is AdaptiveGovernancePolicy {
  if (!policy || policy.version !== 'adaptive-governance-v1' || policy.decisionId !== 'D-093' || !OPAQUE.test(policy.policyId) || !/^sha256:[a-f0-9]{64}$/.test(policy.ownerApprovalDigest) || ![1, 8453, 4663].includes(policy.chainId) || policy.holdoutBps !== 2000) return false;
  const from = Date.parse(policy.approvedAt); const until = Date.parse(policy.expiresAt);
  return Number.isFinite(from) && Number.isFinite(until) && from <= now.getTime() && until > now.getTime() && [policy.minimumOutcomes, policy.minimumCollections, policy.minimumHoldout, policy.maximumWeightChangeBps, policy.maximumScoreChange, policy.epochLifetimeDays].every(Number.isSafeInteger) && policy.minimumOutcomes >= 50 && policy.minimumOutcomes <= 100_000 && policy.minimumCollections >= 10 && policy.minimumCollections <= policy.minimumOutcomes && policy.minimumHoldout >= 10 && policy.maximumWeightChangeBps >= 0 && policy.maximumWeightChangeBps <= 2000 && policy.maximumScoreChange >= 0 && policy.maximumScoreChange <= 10 && policy.epochLifetimeDays >= 1 && policy.epochLifetimeDays <= 90;
}
function validSample(row: FeedbackSample, now: Date): boolean {
  return isMeasuredOutcome(row, now) && Number.isFinite(row.baselineScore) && row.baselineScore >= 0 && row.baselineScore <= 100 && typeof row.eligibleFreeWatched === 'boolean' && Array.isArray(row.factors) && row.factors.length > 0 && row.factors.length <= 20 && new Set(row.factors.map(factor => factor.code)).size === row.factors.length && row.factors.every(factor => FACTORS.has(factor.code) && Number.isFinite(factor.points) && Number.isFinite(factor.max) && factor.max > 0 && factor.points >= 0 && factor.points <= factor.max) && row.baselineScore === Math.round(100 * row.factors.reduce((sum, factor) => sum + factor.points, 0) / row.factors.reduce((sum, factor) => sum + factor.max, 0));
}
function adjustedScore(sample: FeedbackSample, weights: Readonly<Record<string, number>>, maximumChange: number): number {
  const points = sample.factors.reduce((sum, factor) => sum + factor.points * (weights[factor.code] ?? 10000), 0);
  const max = sample.factors.reduce((sum, factor) => sum + factor.max * (weights[factor.code] ?? 10000), 0);
  const proposed = Math.round(points * 100 / max);
  return Math.max(0, Math.min(100, Math.max(sample.baselineScore - maximumChange, Math.min(sample.baselineScore + maximumChange, proposed))));
}
/** Walk-forward training: only outcomes known BEFORE the held-out decisions enter training. */
export function trainAdaptiveCandidate(samples: readonly FeedbackSample[], policy: AdaptiveGovernancePolicy, now = new Date()): AdaptiveCandidate {
  if (!validAdaptivePolicy(policy, now)) throw new Error('ADAPTIVE_OWNER_POLICY_REQUIRED');
  const measured = new Set(measuredOutcomes(samples, now).map(row => `${row.chainId}:${row.sourceReference}`));
  const ordered = samples.filter(row => row.chainId === policy.chainId && measured.has(`${row.chainId}:${row.sourceReference}`) && validSample(row, now)).sort((a, b) => Date.parse(a.decisionAt) - Date.parse(b.decisionAt) || a.id.localeCompare(b.id));
  // Source identities are unique even if a caller repeats byte-identical samples.
  const unique = ordered.filter((row, index) => ordered.findIndex(candidate => candidate.sourceReference === row.sourceReference) === index);
  const holdoutCount = Math.max(policy.minimumHoldout, Math.ceil(unique.length * policy.holdoutBps / 10000));
  const holdout = unique.slice(-holdoutCount);
  const cutoff = holdout[0] ? Date.parse(holdout[0].decisionAt) : 0;
  const training = unique.slice(0, -holdoutCount).filter(row => Date.parse(row.outcomeAt) < cutoff);
  const all = [...training, ...holdout];
  const collections = new Set(all.map(row => row.collection.toLowerCase())).size;
  if (all.length < policy.minimumOutcomes || holdout.length < policy.minimumHoldout || training.length < policy.minimumOutcomes - policy.minimumHoldout || collections < policy.minimumCollections) throw new Error('ADAPTIVE_MEASURED_HISTORY_INSUFFICIENT');
  const weights: Record<string, number> = {};
  for (const code of FACTORS) {
    const high = training.filter(row => row.factors.some(factor => factor.code === code && factor.points * 2 >= factor.max));
    const low = training.filter(row => row.factors.some(factor => factor.code === code && factor.points * 2 < factor.max));
    if (high.length < 5 || low.length < 5) { weights[code] = 10000; continue; }
    const positiveRate = (rows: FeedbackSample[]) => rows.filter(row => BigInt(row.realizedPnlWei!) > 0n).length / rows.length;
    const difference = positiveRate(high) - positiveRate(low);
    weights[code] = 10000 + Math.round(Math.max(-1, Math.min(1, difference)) * policy.maximumWeightChangeBps);
  }
  const selected = holdout.filter(row => row.eligibleFreeWatched && adjustedScore(row, weights, policy.maximumScoreChange) >= 70);
  const baseline = holdout.filter(row => row.eligibleFreeWatched && row.baselineScore >= 70);
  const pnl = (rows: FeedbackSample[]) => rows.reduce((sum, row) => sum + BigInt(row.realizedPnlWei!), 0n);
  const candidatePnl = pnl(selected); const baselinePnl = pnl(baseline);
  if (!selected.length || candidatePnl <= 0n || candidatePnl < baselinePnl) throw new Error('ADAPTIVE_HOLDOUT_NOT_BETTER_OR_EQUAL');
  const candidate = { version: 'adaptive-candidate-v1' as const, policyDigest: adaptivePolicyDigest(policy), chainId: policy.chainId, createdAt: now.toISOString(), trainingIds: training.map(row => row.id), holdoutIds: holdout.map(row => row.id), sourceReferences: all.map(row => row.sourceReference).sort(), weightsBps: weights, validation: { training: training.length, holdout: holdout.length, collections, baselinePnlWei: baselinePnl.toString(), candidatePnlWei: candidatePnl.toString(), candidateSelected: selected.length } };
  return { ...candidate, id: `adaptive_candidate_${digest(candidate).slice(7)}` };
}

/** Durable append-only epochs. Merely constructing this controller never trains or activates anything. */
export class AdaptiveFeedbackController {
  private readonly policy?: AdaptiveGovernancePolicy;
  public constructor(private readonly store: BackendStore, policy?: AdaptiveGovernancePolicy, private readonly now: () => Date = () => new Date()) { this.policy = policy ? Object.freeze(structuredClone(policy)) : undefined; }
  private assertPolicy(): AdaptiveGovernancePolicy { if (!validAdaptivePolicy(this.policy, this.now())) throw new Error('ADAPTIVE_OWNER_POLICY_REQUIRED'); return this.policy; }
  public async propose(samples: readonly FeedbackSample[]): Promise<AdaptiveCandidate> {
    const candidate = trainAdaptiveCandidate(samples, this.assertPolicy(), this.now());
    await this.store.transaction(state => { if (!state.events.some(event => event.id === candidate.id)) state.events.push({ id: candidate.id, type: 'adaptive_model_candidate', at: this.now().toISOString(), data: { candidate } }); });
    return candidate;
  }
  private candidate(id: string): AdaptiveCandidate {
    const policy = this.assertPolicy();
    const event = this.store.snapshot().events.find(row => row.id === id && row.type === 'adaptive_model_candidate');
    const candidate = event?.data.candidate as AdaptiveCandidate | undefined;
    if (!candidate || !Number.isFinite(Date.parse(candidate.createdAt)) || Date.parse(candidate.createdAt) > this.now().getTime() || candidate.policyDigest !== adaptivePolicyDigest(policy) || candidate.chainId !== policy.chainId || candidate.id !== id || candidate.version !== 'adaptive-candidate-v1') throw new Error('ADAPTIVE_CANDIDATE_INVALID');
    const { id: _id, ...body } = candidate;
    if (`adaptive_candidate_${digest(body).slice(7)}` !== id) throw new Error('ADAPTIVE_CANDIDATE_INVALID');
    return candidate;
  }
  public initialAcceptancePhrase(candidateId: string): string { this.candidate(candidateId); return `ACCEPT-ADAPTIVE-MODEL ${candidateId.slice(-12)}`; }
  public async acceptInitialCandidate(candidateId: string, ownerConfirmation: string): Promise<void> {
    const candidate = this.candidate(candidateId);
    if (ownerConfirmation !== this.initialAcceptancePhrase(candidateId)) throw new Error('ADAPTIVE_INITIAL_MODEL_OWNER_APPROVAL_REQUIRED');
    const id = `adaptive_acceptance_${candidateId}`;
    await this.store.transaction(state => { if (!state.events.some(event => event.id === id)) state.events.push({ id, type: 'adaptive_initial_model_accepted', at: this.now().toISOString(), data: { candidateId, policyDigest: candidate.policyDigest } }); });
  }
  public async promote(candidateId: string): Promise<ActiveAdaptiveModel> {
    const policy = this.assertPolicy(); const candidate = this.candidate(candidateId); const now = this.now();
    if (now.getTime() - Date.parse(candidate.createdAt) > 7 * 86_400_000) throw new Error('ADAPTIVE_CANDIDATE_STALE');
    const expires = Math.min(Date.parse(policy.expiresAt), now.getTime() + policy.epochLifetimeDays * 86_400_000);
    const model: ActiveAdaptiveModel = { version: 'adaptive-model-v1', epochId: `epoch_${candidateId.slice(-32)}`, policyDigest: adaptivePolicyDigest(policy), chainId: policy.chainId, issuedAt: now.toISOString(), expiresAt: new Date(expires).toISOString(), maxScoreChange: policy.maximumScoreChange, weightsBps: { ...candidate.weightsBps } };
    await this.store.transaction(state => {
      this.assertPolicy();
      const priorPromotion = state.events.some(event => event.type === 'adaptive_model_promoted' && event.data.policyDigest === model.policyDigest);
      if (!state.events.some(event => event.type === 'adaptive_initial_model_accepted' && event.data.policyDigest === model.policyDigest && (priorPromotion || event.data.candidateId === candidateId))) throw new Error('ADAPTIVE_INITIAL_MODEL_OWNER_APPROVAL_REQUIRED');
      if (state.events.some(event => event.type === 'adaptive_lineage_invalidated' && Array.isArray(event.data.sourceReferences) && (event.data.sourceReferences as string[]).some(ref => candidate.sourceReferences.includes(ref)))) throw new Error('ADAPTIVE_LINEAGE_INVALIDATED');
      const id = `adaptive_promotion_${candidateId}`;
      if (!state.events.some(event => event.id === id)) state.events.push({ id, type: 'adaptive_model_promoted', at: now.toISOString(), data: { candidateId, policyDigest: model.policyDigest, model, sourceReferences: candidate.sourceReferences } });
    });
    const active = this.active(policy.chainId, now);
    if (!active || active.epochId !== model.epochId) throw new Error('ADAPTIVE_MODEL_NOT_ACTIVE');
    return active;
  }
  public async rollback(reason: 'owner' | 'validation' | 'reorg' = 'owner'): Promise<void> {
    const policy = this.assertPolicy();
    await this.store.transaction(state => state.events.push({ id: `adaptive_rollback_${policy.chainId}_${state.events.length}`, type: 'adaptive_model_rolled_back', at: this.now().toISOString(), data: { chainId: policy.chainId, policyDigest: adaptivePolicyDigest(policy), reason } }));
  }
  public async invalidateReferences(sourceReferences: readonly string[]): Promise<void> {
    const policy = this.assertPolicy(); const refs = [...new Set(sourceReferences)].filter(ref => OPAQUE.test(ref)).sort();
    if (!refs.length) return;
    const id = `adaptive_invalid_${digest({ chainId: policy.chainId, refs }).slice(7)}`;
    await this.store.transaction(state => { if (!state.events.some(event => event.id === id)) state.events.push({ id, type: 'adaptive_lineage_invalidated', at: this.now().toISOString(), data: { chainId: policy.chainId, policyDigest: adaptivePolicyDigest(policy), sourceReferences: refs } }); });
  }
  public active(chainId: IntelligenceChainId, now = this.now()): ActiveAdaptiveModel | undefined {
    if (!validAdaptivePolicy(this.policy, now) || this.policy.chainId !== chainId) return undefined;
    const policyDigest = adaptivePolicyDigest(this.policy); const events = this.store.snapshot().events;
    const latest = [...events].reverse().find(event => (event.type === 'adaptive_model_promoted' || event.type === 'adaptive_model_rolled_back') && event.data.policyDigest === policyDigest);
    if (!latest || latest.type !== 'adaptive_model_promoted') return undefined;
    const model = latest.data.model as ActiveAdaptiveModel | undefined;
    const references = latest.data.sourceReferences as string[] | undefined;
    if (!model || !validActiveModel(model, chainId, now) || model.policyDigest !== policyDigest || !Array.isArray(references) || !events.some(event => event.type === 'adaptive_initial_model_accepted' && event.data.policyDigest === policyDigest)) return undefined;
    const firstPromotion = events.find(event => event.type === 'adaptive_model_promoted' && event.data.policyDigest === policyDigest);
    if (!firstPromotion || !events.some(event => event.type === 'adaptive_initial_model_accepted' && event.data.policyDigest === policyDigest && event.data.candidateId === firstPromotion.data.candidateId)) return undefined;
    let candidate: AdaptiveCandidate;
    try { candidate = this.candidate(String(latest.data.candidateId)); } catch { return undefined; }
    if (JSON.stringify(references) !== JSON.stringify(candidate.sourceReferences)) return undefined;
    if (model.maxScoreChange !== this.policy.maximumScoreChange || model.epochId !== `epoch_${candidate.id.slice(-32)}` || Date.parse(model.issuedAt) < Date.parse(candidate.createdAt) || Date.parse(model.expiresAt) > Date.parse(this.policy.expiresAt) || Date.parse(model.expiresAt) - Date.parse(model.issuedAt) > this.policy.epochLifetimeDays * 86_400_000 || JSON.stringify(model.weightsBps) !== JSON.stringify(candidate.weightsBps) || Object.values(model.weightsBps).some(weight => Math.abs(weight - 10000) > this.policy!.maximumWeightChangeBps)) return undefined;
    if (events.some(event => event.type === 'adaptive_lineage_invalidated' && event.data.chainId === chainId && Array.isArray(event.data.sourceReferences) && (event.data.sourceReferences as string[]).some(ref => references.includes(ref)))) return undefined;
    return model;
  }
}
