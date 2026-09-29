import { describe, expect, it } from 'vitest';
import { formatEth, paidQuantityForScore, scoreOpportunity, SCORING_MODEL_VERSION, type ScoringInput } from './scoring.js';

const NOW = new Date('2026-09-29T12:00:00.000Z');
const LIMIT = 3_700_000_000_000_000n;

function input(overrides: Partial<ScoringInput> = {}): ScoringInput {
  return { watchedMinters: 0, watchingConfigured: true, priceWei: 0n, budgetPerNftWei: LIMIT, knownSeaDropPattern: true, hasCode: true, mintsLastHour: 0, discoveredAt: NOW, now: NOW, ...overrides };
}

describe('v1-rules-p2 scoring', () => {
  it('scores a fresh, free, busy SeaDrop mint that three watched wallets joined at the top of the scale', () => {
    const result = scoreOpportunity(input({ watchedMinters: 3, mintsLastHour: 80 }));
    expect(result).toMatchObject({ modelVersion: SCORING_MODEL_VERSION, score: 100, band: 'proposal', blocked: false, confidenceLabel: 'medium' });
    expect(result.confidence).toBe(0.61);
  });

  it('never scores missing data as zero: unavailable factors are listed and excluded from the maximum', () => {
    const result = scoreOpportunity(input());
    const unavailable = result.factors.filter((factor) => factor.status === 'unavailable').map((factor) => factor.code);
    expect(unavailable).toEqual(['track_record', 'floor_margin', 'verified_source', 'contract_age']);
    expect(result.factors.filter((factor) => factor.status === 'unavailable').every((factor) => factor.points === 0)).toBe(true);
    const withoutWatch = scoreOpportunity(input({ watchingConfigured: false }));
    expect(withoutWatch.factors.find((factor) => factor.code === 'convergence')?.status).toBe('unavailable');
    expect(withoutWatch.confidence).toBeLessThan(result.confidence);
  });

  it('drops one band when too little of the model has data, and blocks on a blocking risk', () => {
    const lowConfidence = scoreOpportunity(input({ watchingConfigured: false, watchedMinters: 0, mintsLastHour: 80, priceWei: null, hasCode: null }));
    expect(lowConfidence.confidence).toBeLessThan(0.6);
    expect(lowConfidence.score).toBeGreaterThanOrEqual(70);
    expect(lowConfidence.band).toBe('notify');
    const tooExpensive = scoreOpportunity(input({ watchedMinters: 3, mintsLastHour: 80, priceWei: LIMIT + 1n }));
    expect(tooExpensive).toMatchObject({ blocked: true, band: 'log' });
    expect(tooExpensive.risks).toEqual([expect.objectContaining({ code: 'PRICE_ABOVE_LIMIT', severity: 'blocking' })]);
    expect(scoreOpportunity(input({ hasCode: false })).risks.map((risk) => risk.code)).toEqual(['NO_CONTRACT_CODE']);
  });

  it('rates price against the owner limit and decays freshness to zero at six hours', () => {
    const price = (priceWei: bigint) => scoreOpportunity(input({ priceWei })).factors.find((factor) => factor.code === 'price')?.points;
    expect([price(0n), price(LIMIT / 2n), price(LIMIT), price(LIMIT + 1n)]).toEqual([12, 10, 6, 0]);
    const fresh = (minutes: number) => scoreOpportunity(input({ discoveredAt: new Date(NOW.getTime() - minutes * 60_000) })).factors.find((factor) => factor.code === 'freshness')?.points;
    expect([fresh(0), fresh(15), fresh(360), fresh(600)]).toEqual([10, 10, 0, 0]);
    expect(fresh(120)).toBeGreaterThan(0);
  });

  it('maps paid quantity by score and formats ETH without floats', () => {
    expect([paidQuantityForScore(100), paidQuantityForScore(70), paidQuantityForScore(69), paidQuantityForScore(40), paidQuantityForScore(39), paidQuantityForScore(null)]).toEqual([2, 2, 1, 1, 0, 0]);
    expect([formatEth(0n), formatEth(LIMIT), formatEth(10n ** 18n), formatEth(400_000_000_000_000n), formatEth(1n)]).toEqual(['0', '0.0037', '1', '0.0004', '0.0']);
  });
});
