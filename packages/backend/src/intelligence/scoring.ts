import { readAdvancedFeatures, validActiveModel, type ActiveAdaptiveModel, type AdvancedIntelligenceSnapshot, type HistoricalQualitySnapshot, type IntelligenceChainId } from './advanced-scoring.js';
/**
 * Deterministic opportunity scoring, PRODUCT_SPEC §12 adapted for Phase 2 data (T-004, P2-04).
 *
 * Factors without a data source in Phase 2 are reported as `unavailable`, never
 * scored as zero. The score is earned points over available points, so missing
 * data lowers confidence rather than the score. A score is desire, not
 * permission: blocking risks and safety gates stay separate (§12 blocking rule).
 */
export const SCORING_MODEL_VERSION = 'v1-rules-p2';
export const SCORING_MODEL_VERSION_PHASE4 = 'v1-rules-p4';
export const SCORING_MODEL_VERSION_ADVANCED = 'v2-rules-advanced';

export interface ScoringInput {
  /** Distinct watched addresses that minted this contract in the convergence window. */
  watchedMinters: number;
  /** Optional historical result supplied by a Phase 4 history consumer. */
  trackRecord?: { successRate: number; sampleSize: number; recencyHours?: number };
  /** Whether any watched addresses are configured; without them convergence is unavailable. */
  watchingConfigured: boolean;
  /** Mint price per NFT in wei, or null when not known yet. */
  priceWei: bigint | null;
  /** Owner price limit per NFT (D-033). */
  budgetPerNftWei: bigint;
  /** Drop is configured on the SeaDrop singleton (known strategy pattern). */
  knownSeaDropPattern: boolean;
  /** True only after independent checks against an owner-signed reviewed template. */
  knownReviewedTemplate?: boolean;
  /** Contract has bytecode; null when unknown. */
  hasCode: boolean | null;
  /** SeaDrop mints of this contract in the last hour, counted in NFTs. */
  mintsLastHour: number;
  /** When the system first saw this opportunity. */
  discoveredAt: Date;
  now: Date;
  chainId?: IntelligenceChainId;
  contract?: string;
  advanced?: AdvancedIntelligenceSnapshot;
  history?: HistoricalQualitySnapshot;
  adaptiveModel?: ActiveAdaptiveModel;
}

export type FactorStatus = 'available' | 'unavailable';
export interface ScoredFactor { code: string; status: FactorStatus; points: number; max: number; explanation: string; }
export interface RiskOut { code: string; severity: 'info' | 'warning' | 'blocking'; message: string; }
export type ScoreBand = 'proposal' | 'notify' | 'log';

export interface ScoreResult {
  modelVersion: string;
  /** 0–100, earned over available points. */
  score: number;
  /** Share of the full model's weight that had data, 0–1. */
  confidence: number;
  confidenceLabel: 'low' | 'medium' | 'high';
  band: ScoreBand;
  factors: ScoredFactor[];
  risks: RiskOut[];
  /** True when a blocking risk means the opportunity must not be acted on. */
  blocked: boolean;
  baseScore?: number;
  modelEpochId?: string;
}

const WEI_PER_ETH = 10n ** 18n;
const FRESH_FULL_MS = 15 * 60_000;
const FRESH_ZERO_MS = 6 * 60 * 60_000;
/** Below this share of model weight, a score drops one band (§12 low-confidence rule). */
const LOW_CONFIDENCE = 0.6;

function available(code: string, points: number, max: number, explanation: string): ScoredFactor {
  return { code, status: 'available', points: Math.max(0, Math.min(points, max)), max, explanation };
}
function unavailable(code: string, max: number, explanation: string): ScoredFactor {
  return { code, status: 'unavailable', points: 0, max, explanation };
}

export function scoreOpportunity(input: ScoringInput): ScoreResult {
  const factors: ScoredFactor[] = [];
  const risks: RiskOut[] = [];
  const enriched = input.chainId !== undefined && input.contract !== undefined && (input.advanced !== undefined || input.history !== undefined);
  const features = enriched ? readAdvancedFeatures({ chainId: input.chainId!, contract: input.contract!, watchedWallets: [], now: input.now }, input.advanced, input.history) : undefined;
  const trackMax = enriched ? 20 : 25;

  if (features?.walletQuality) {
    const quality = features.walletQuality;
    const recent = Math.max(0, 1 - (input.now.getTime() - Date.parse(quality.lastOutcomeAt)) / (30 * 86_400_000));
    const points = Math.round(trackMax * quality.profitable / quality.samples * Math.min(1, quality.samples / 10) * (0.5 + 0.5 * recent));
    factors.push(available('track_record', points, trackMax, `${quality.samples} fully costed wallet outcomes; ${quality.profitable} profitable; measured coverage only.`));
  } else if (!enriched && input.trackRecord && Number.isFinite(input.trackRecord.successRate) && Number.isFinite(input.trackRecord.sampleSize) && input.trackRecord.sampleSize > 0) {
    const successRate = Math.max(0, Math.min(1, input.trackRecord.successRate));
    const recencyHours = input.trackRecord.recencyHours === undefined ? 0 : Math.max(0, input.trackRecord.recencyHours);
    const recency = Math.max(0, Math.min(1, 1 - recencyHours / (30 * 24)));
    const confidence = Math.min(1, input.trackRecord.sampleSize / 10);
    const points = Math.round(trackMax * successRate * (0.5 + 0.5 * recency) * confidence);
    factors.push(available('track_record', points, trackMax, `${input.trackRecord.sampleSize} historical result(s), ${(successRate * 100).toFixed(0)}% success, recency factor ${(recency * 100).toFixed(0)}%.`));
  } else factors.push(unavailable('track_record', trackMax, 'Measured, fresh wallet outcome history is unavailable.'));
  if (enriched) {
    const quality = features?.projectQuality;
    factors.push(quality ? available('project_reputation', Math.round(5 * quality.profitable / quality.samples * Math.min(1, quality.samples / 10)), 5, `${quality.samples} fully costed project outcomes; no unobserved reputation inferred.`) : unavailable('project_reputation', 5, 'Measured project outcome history is unavailable.'));
  }

  if (!input.watchingConfigured) factors.push(unavailable('convergence', 20, 'No watched wallets are set up, so wallet agreement cannot be measured.'));
  else {
    const points = input.watchedMinters >= 3 ? 20 : input.watchedMinters === 2 ? 14 : input.watchedMinters === 1 ? 8 : 0;
    factors.push(available('convergence', points, 20, input.watchedMinters === 0 ? 'None of your watched wallets minted this.' : `${input.watchedMinters} of your watched wallets minted this.`));
  }

  if (input.priceWei === null) factors.push(unavailable('price', 12, 'Mint price is not known yet.'));
  else if (input.priceWei === 0n) factors.push(available('price', 12, 12, 'Free mint: you only pay the network fee.'));
  else if (input.priceWei <= input.budgetPerNftWei / 2n) factors.push(available('price', 10, 12, `Price ${formatEth(input.priceWei)} ETH is well within your ${formatEth(input.budgetPerNftWei)} ETH limit.`));
  else if (input.priceWei <= input.budgetPerNftWei) factors.push(available('price', 6, 12, `Price ${formatEth(input.priceWei)} ETH is within your ${formatEth(input.budgetPerNftWei)} ETH limit.`));
  else {
    factors.push(available('price', 0, 12, `Price ${formatEth(input.priceWei)} ETH is above your ${formatEth(input.budgetPerNftWei)} ETH limit.`));
    risks.push({ code: 'PRICE_ABOVE_LIMIT', severity: 'blocking', message: `Price is above your ${formatEth(input.budgetPerNftWei)} ETH per-NFT limit.` });
  }
  if (features?.floor && input.priceWei !== null) {
    const cost = input.priceWei + BigInt(features.floor.feePerNftWei);
    const floor = BigInt(features.floor.floorWei);
    const points = floor <= cost ? 0 : cost === 0n || floor >= cost * 2n ? 8 : 4;
    factors.push(available('floor_margin', points, 8, 'Fresh listing-floor estimate against mint plus estimated network cost; not guaranteed sale proceeds.'));
  } else factors.push(unavailable('floor_margin', 8, 'A fresh, covered floor and fee estimate are unavailable.'));

  factors.push(available('known_pattern', input.knownSeaDropPattern || input.knownReviewedTemplate === true ? 6 : 0, 6, input.knownSeaDropPattern ? 'Uses the standard SeaDrop public mint.' : input.knownReviewedTemplate === true ? 'Matches an owner-signed reviewed free mint template.' : 'Does not use a mint pattern the bot knows.'));
  if (input.hasCode === null) factors.push(unavailable('contract_code', 3, 'Could not confirm the contract exists.'));
  else {
    factors.push(available('contract_code', input.hasCode ? 3 : 0, 3, input.hasCode ? 'Contract code is present on chain.' : 'No contract code at this address.'));
    if (!input.hasCode) risks.push({ code: 'NO_CONTRACT_CODE', severity: 'blocking', message: 'There is no contract at this address.' });
  }
  factors.push(features?.sourceVerified !== undefined ? available('verified_source', features.sourceVerified ? 3 : 0, 3, features.sourceVerified ? 'Source verification was observed; this is not a safety certificate.' : 'Source is observed as unverified.') : unavailable('verified_source', 3, 'Fresh source-verification coverage is unavailable.'));
  if (features?.sourceVerified === false) risks.push({ code: 'SOURCE_UNVERIFIED', severity: 'warning', message: 'Source code is not verified by the covered source.' });
  if (features?.contractCreatedAt) {
    const hours = (input.now.getTime() - Date.parse(features.contractCreatedAt)) / 3_600_000;
    factors.push(available('contract_age', hours >= 168 ? 3 : hours >= 24 ? 2 : hours >= 1 ? 1 : 0, 3, `Deployment observed ${Math.floor(hours)} hour(s) ago; bot discovery time is not used as contract age.`));
  } else factors.push(unavailable('contract_age', 3, 'A covered creation observation is unavailable.'));

  const demandCount = features?.demand?.distinctPayers;
  const demand = demandCount !== undefined ? demandCount >= 20 ? 10 : demandCount >= 5 ? 6 : demandCount >= 1 ? 3 : 0 : input.mintsLastHour >= 50 ? 10 : input.mintsLastHour >= 10 ? 6 : input.mintsLastHour >= 1 ? 3 : 0;
  factors.push(available('demand', demand, 10, demandCount !== undefined ? `${demandCount} distinct observed payers; economic independence is not proven.` : input.mintsLastHour === 0 ? 'No mints observed in the last hour.' : `${input.mintsLastHour} NFTs minted in the last hour; distinct payer coverage unavailable.`));

  const ageMs = Math.max(0, input.now.getTime() - input.discoveredAt.getTime());
  const freshness = ageMs <= FRESH_FULL_MS ? 10 : ageMs >= FRESH_ZERO_MS ? 0 : Math.round(10 * (FRESH_ZERO_MS - ageMs) / (FRESH_ZERO_MS - FRESH_FULL_MS));
  factors.push(available('freshness', freshness, 10, ageMs <= FRESH_FULL_MS ? 'Found in the last 15 minutes.' : `Found ${Math.round(ageMs / 60_000)} minutes ago.`));

  const availableMax = factors.filter((factor) => factor.status === 'available').reduce((total, factor) => total + factor.max, 0);
  const earned = factors.filter((factor) => factor.status === 'available').reduce((total, factor) => total + factor.points, 0);
  const baseScore = availableMax === 0 ? 0 : Math.round((100 * earned) / availableMax);
  const active = validActiveModel(input.adaptiveModel, input.chainId ?? 0, input.now) ? input.adaptiveModel : undefined;
  const weighted = factors.filter(f => f.status === 'available').reduce((sum, factor) => sum + factor.points * (active?.weightsBps[factor.code] ?? 10_000), 0);
  const weightedMax = factors.filter(f => f.status === 'available').reduce((sum, factor) => sum + factor.max * (active?.weightsBps[factor.code] ?? 10_000), 0);
  const proposed = weightedMax === 0 ? baseScore : Math.round(100 * weighted / weightedMax);
  const score = active ? Math.max(0, Math.min(100, Math.max(baseScore - active.maxScoreChange, Math.min(baseScore + active.maxScoreChange, proposed)))) : baseScore;
  const confidence = Math.round(availableMax) / 100;
  const confidenceLabel = confidence >= 0.8 ? 'high' : confidence >= LOW_CONFIDENCE ? 'medium' : 'low';
  const blocked = risks.some((risk) => risk.severity === 'blocking');
  let band: ScoreBand = score >= 70 ? 'proposal' : score >= 40 ? 'notify' : 'log';
  if (confidence < LOW_CONFIDENCE) band = band === 'proposal' ? 'notify' : 'log';
  if (blocked) band = 'log';
  return { modelVersion: active ? `${SCORING_MODEL_VERSION_ADVANCED}:${active.epochId}` : enriched ? SCORING_MODEL_VERSION_ADVANCED : input.trackRecord ? SCORING_MODEL_VERSION_PHASE4 : SCORING_MODEL_VERSION, score, confidence, confidenceLabel, band, factors, risks, blocked, ...(active ? { baseScore, modelEpochId: active.epochId } : {}) };
}

/** Paid mints: NFTs per wallet by score (D-033): 70+ → 2, 40–69 → 1, below 40 → 0. */
export function paidQuantityForScore(score: number | null): number {
  if (score === null || !Number.isFinite(score)) return 0;
  return score >= 70 ? 2 : score >= 40 ? 1 : 0;
}

/** Formats wei as ETH for owner-facing text without floating point. */
export function formatEth(wei: bigint): string {
  const negative = wei < 0n;
  const abs = negative ? -wei : wei;
  const whole = abs / WEI_PER_ETH;
  const fraction = (abs % WEI_PER_ETH).toString().padStart(18, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction.slice(0, 6).replace(/0+$/, '') || '0'}` : ''}`;
}
