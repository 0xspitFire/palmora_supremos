/**
 * Deterministic opportunity scoring, PRODUCT_SPEC §12 adapted for Phase 2 data (T-004, P2-04).
 *
 * Factors without a data source in Phase 2 are reported as `unavailable`, never
 * scored as zero. The score is earned points over available points, so missing
 * data lowers confidence rather than the score. A score is desire, not
 * permission: blocking risks and safety gates stay separate (§12 blocking rule).
 */
export const SCORING_MODEL_VERSION = 'v1-rules-p2';

export interface ScoringInput {
  /** Distinct watched addresses that minted this contract in the convergence window. */
  watchedMinters: number;
  /** Whether any watched addresses are configured; without them convergence is unavailable. */
  watchingConfigured: boolean;
  /** Mint price per NFT in wei, or null when not known yet. */
  priceWei: bigint | null;
  /** Owner price limit per NFT (D-033). */
  budgetPerNftWei: bigint;
  /** Drop is configured on the SeaDrop singleton (known strategy pattern). */
  knownSeaDropPattern: boolean;
  /** Contract has bytecode; null when unknown. */
  hasCode: boolean | null;
  /** SeaDrop mints of this contract in the last hour, counted in NFTs. */
  mintsLastHour: number;
  /** When the system first saw this opportunity. */
  discoveredAt: Date;
  now: Date;
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

  factors.push(unavailable('track_record', 25, 'Past results of the wallets involved are not measured yet (arrives with analytics).'));

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
  factors.push(unavailable('floor_margin', 8, 'Resale value is not tracked yet (no market data source).'));

  factors.push(available('known_pattern', input.knownSeaDropPattern ? 6 : 0, 6, input.knownSeaDropPattern ? 'Uses the standard SeaDrop public mint.' : 'Does not use a mint pattern the bot knows.'));
  if (input.hasCode === null) factors.push(unavailable('contract_code', 3, 'Could not confirm the contract exists.'));
  else {
    factors.push(available('contract_code', input.hasCode ? 3 : 0, 3, input.hasCode ? 'Contract code is present on chain.' : 'No contract code at this address.'));
    if (!input.hasCode) risks.push({ code: 'NO_CONTRACT_CODE', severity: 'blocking', message: 'There is no contract at this address.' });
  }
  factors.push(unavailable('verified_source', 3, 'Source-code verification is not checked yet.'));
  factors.push(unavailable('contract_age', 3, 'Contract age is not checked yet.'));

  const demand = input.mintsLastHour >= 50 ? 10 : input.mintsLastHour >= 10 ? 6 : input.mintsLastHour >= 1 ? 3 : 0;
  factors.push(available('demand', demand, 10, input.mintsLastHour === 0 ? 'No public mints in the last hour.' : `${input.mintsLastHour} NFTs minted in the last hour.`));

  const ageMs = Math.max(0, input.now.getTime() - input.discoveredAt.getTime());
  const freshness = ageMs <= FRESH_FULL_MS ? 10 : ageMs >= FRESH_ZERO_MS ? 0 : Math.round(10 * (FRESH_ZERO_MS - ageMs) / (FRESH_ZERO_MS - FRESH_FULL_MS));
  factors.push(available('freshness', freshness, 10, ageMs <= FRESH_FULL_MS ? 'Found in the last 15 minutes.' : `Found ${Math.round(ageMs / 60_000)} minutes ago.`));

  const availableMax = factors.filter((factor) => factor.status === 'available').reduce((total, factor) => total + factor.max, 0);
  const earned = factors.filter((factor) => factor.status === 'available').reduce((total, factor) => total + factor.points, 0);
  const score = availableMax === 0 ? 0 : Math.round((100 * earned) / availableMax);
  const confidence = Math.round(availableMax) / 100;
  const confidenceLabel = confidence >= 0.8 ? 'high' : confidence >= LOW_CONFIDENCE ? 'medium' : 'low';
  const blocked = risks.some((risk) => risk.severity === 'blocking');
  let band: ScoreBand = score >= 70 ? 'proposal' : score >= 40 ? 'notify' : 'log';
  if (confidence < LOW_CONFIDENCE) band = band === 'proposal' ? 'notify' : 'log';
  if (blocked) band = 'log';
  return { modelVersion: SCORING_MODEL_VERSION, score, confidence, confidenceLabel, band, factors, risks, blocked };
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
