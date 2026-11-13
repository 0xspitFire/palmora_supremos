import type { EventRecord } from '../types.js';
import { measuredOutcomes, type MeasuredIntelligenceOutcome } from './advanced-scoring.js';
import type { FeedbackSample } from './adaptive-feedback.js';

/** Only the score retained at a real prepared replication decision can train.
 * No retrospective scoring, floor-profit labels or inferred historical guards. */
export function feedbackSamplesFromOutcomes(outcomes: readonly MeasuredIntelligenceOutcome[], events: readonly EventRecord[], now = new Date()): FeedbackSample[] {
  return measuredOutcomes(outcomes, now).flatMap(outcome => {
    const prepared = events.find(event => event.type === 'replication_prepared' && event.at === outcome.decisionAt && event.data.policyVersion === 'free-watched-v1' && event.data.mintPriceWei === '0' && typeof event.data.sourceWallet === 'string' && event.data.sourceWallet.toLowerCase() === outcome.sourceWallet?.toLowerCase() && typeof event.data.scoreEventId === 'string');
    const score = prepared && events.find(event => event.id === prepared.data.scoreEventId && ['opportunity_scored', 'opportunity_notified'].includes(event.type));
    const source = prepared && events.find(event => event.id === prepared.data.sourceEventId && event.type === 'watched_wallet_mint');
    if (!prepared || !score || !source || score.data.chainId !== outcome.chainId || source.data.chainId !== outcome.chainId || String(score.data.contract).toLowerCase() !== outcome.collection.toLowerCase() || String(source.data.contract).toLowerCase() !== outcome.collection.toLowerCase() || String(source.data.wallet).toLowerCase() !== outcome.sourceWallet?.toLowerCase() || source.data.txHash !== prepared.data.sourceTxHash || score.data.blocked !== false || score.data.priceWei !== '0' || !Number.isFinite(Date.parse(score.at)) || Date.parse(score.at) > Date.parse(prepared.at) || Date.parse(prepared.at) - Date.parse(score.at) > 15 * 60_000 || Date.parse(score.at) > Date.parse(outcome.outcomeAt) || !Array.isArray(score.data.factors)) return [];
    const factors = score.data.factors.filter((factor: unknown): factor is { code: string; points: number; max: number; status: string } => {
      if (!factor || typeof factor !== 'object') return false;
      const row = factor as Record<string, unknown>;
      return row.status === 'available' && typeof row.code === 'string' && typeof row.points === 'number' && Number.isFinite(row.points) && typeof row.max === 'number' && Number.isFinite(row.max) && row.max > 0 && row.points >= 0 && row.points <= row.max;
    }).map(({ code, points, max }) => ({ code, points, max }));
    if (!factors.length || factors.length > 20 || new Set(factors.map(factor => factor.code)).size !== factors.length) return [];
    const baselineScore = Math.round(100 * factors.reduce((sum, factor) => sum + factor.points, 0) / factors.reduce((sum, factor) => sum + factor.max, 0));
    if (baselineScore !== (score.data.staticScore ?? score.data.score)) return [];
    return [{ ...outcome, decisionAt: score.at, baselineScore, factors, eligibleFreeWatched: true }];
  });
}
