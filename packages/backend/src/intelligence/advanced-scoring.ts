/** Public, read-only intelligence facts. None of these facts grant permission to spend. */
export type IntelligenceChainId = 1 | 8453 | 4663;
export interface FeatureContext { chainId: IntelligenceChainId; contract: string; watchedWallets: readonly string[]; now: Date; }
export interface SourcedFact<T> { chainId: IntelligenceChainId; contract: string; observedAt: string; expiresAt: string; sourceReference: string; value: T; }
export interface QualityMeasure {
  samples: number; profitable: number; unprofitable: number; breakEven: number;
  fullyCosted: true; lastOutcomeAt: string; coverageFrom: string; coverageUntil: string;
}
export interface AdvancedIntelligenceSnapshot {
  version: 'advanced-facts-v1'; chainId: IntelligenceChainId; contract: string;
  floor?: SourcedFact<{ floorWei: string; feePerNftWei: string }>;
  contractCreatedAt?: SourcedFact<string>;
  sourceVerified?: SourcedFact<boolean>;
  demand?: SourcedFact<{ distinctPayers: number; mintCount: number }>;
}
export interface HistoricalQualitySnapshot {
  version: 'quality-facts-v1'; chainId: IntelligenceChainId; contract: string;
  walletQuality?: SourcedFact<QualityMeasure>;
  projectQuality?: SourcedFact<QualityMeasure>;
}
/** Reads cached facts only. Network work belongs in a separately bounded background worker. */
export interface AdvancedIntelligencePort { snapshot(context: FeatureContext): AdvancedIntelligenceSnapshot | undefined; request?(context: FeatureContext): void; }
export interface HistoricalQualityPort { snapshot(context: FeatureContext): HistoricalQualitySnapshot | undefined; }
export interface ActiveAdaptiveModel {
  version: 'adaptive-model-v1'; epochId: string; policyDigest: string; chainId: IntelligenceChainId;
  issuedAt: string; expiresAt: string; maxScoreChange: number; weightsBps: Readonly<Record<string, number>>;
}
export interface AdaptiveModelPort { active(chainId: IntelligenceChainId, now: Date): ActiveAdaptiveModel | undefined; }

const OPAQUE = /^[A-Za-z0-9_.:-]{1,160}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const uint = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value);
export function freshFact<T>(fact: SourcedFact<T> | undefined, context: FeatureContext, valid: (value: T) => boolean): T | undefined {
  try {
    if (!fact || fact.chainId !== context.chainId || !ADDRESS.test(fact.contract) || fact.contract.toLowerCase() !== context.contract.toLowerCase() || !OPAQUE.test(fact.sourceReference)) return undefined;
    const observed = Date.parse(fact.observedAt); const expires = Date.parse(fact.expiresAt); const now = context.now.getTime();
    if (![observed, expires, now].every(Number.isFinite) || observed > now || expires <= now || expires <= observed || expires - observed > 24 * 3_600_000 || !valid(fact.value)) return undefined;
    return fact.value;
  } catch { return undefined; }
}
export function validQuality(value: QualityMeasure, now: Date): boolean {
  if (!value || value.fullyCosted !== true || ![value.samples, value.profitable, value.unprofitable, value.breakEven].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 1_000_000) || value.samples < 1 || value.profitable + value.unprofitable + value.breakEven !== value.samples) return false;
  const times = [value.coverageFrom, value.coverageUntil, value.lastOutcomeAt].map(Date.parse);
  return times.every(Number.isFinite) && times[0]! <= times[2]! && times[2]! <= times[1]! && times[1]! <= now.getTime();
}
export function readAdvancedFeatures(context: FeatureContext, advanced?: AdvancedIntelligenceSnapshot, history?: HistoricalQualitySnapshot) {
  const a = advanced?.version === 'advanced-facts-v1' && advanced.chainId === context.chainId && typeof advanced.contract === 'string' && advanced.contract.toLowerCase() === context.contract.toLowerCase() ? advanced : undefined;
  const h = history?.version === 'quality-facts-v1' && history.chainId === context.chainId && typeof history.contract === 'string' && history.contract.toLowerCase() === context.contract.toLowerCase() ? history : undefined;
  return {
    floor: freshFact(a?.floor, context, value => !!value && uint(value.floorWei) && uint(value.feePerNftWei)),
    contractCreatedAt: freshFact(a?.contractCreatedAt, context, value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && Date.parse(value) <= context.now.getTime()),
    sourceVerified: freshFact(a?.sourceVerified, context, value => typeof value === 'boolean'),
    demand: freshFact(a?.demand, context, value => !!value && [value.distinctPayers, value.mintCount].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 10_000_000) && value.distinctPayers <= value.mintCount),
    walletQuality: freshFact(h?.walletQuality, context, value => validQuality(value, context.now)),
    projectQuality: freshFact(h?.projectQuality, context, value => validQuality(value, context.now)),
  };
}

/** Active models cannot exceed hard development bounds even if a caller supplies malformed input. */
export function validActiveModel(model: ActiveAdaptiveModel | undefined, chainId: number, now: Date): model is ActiveAdaptiveModel {
  if (!model || !model.weightsBps || typeof model.weightsBps !== 'object' || Array.isArray(model.weightsBps) || model.version !== 'adaptive-model-v1' || model.chainId !== chainId || !OPAQUE.test(model.epochId) || !/^sha256:[a-f0-9]{64}$/.test(model.policyDigest) || !Number.isSafeInteger(model.maxScoreChange) || model.maxScoreChange < 0 || model.maxScoreChange > 10) return false;
  const issued = Date.parse(model.issuedAt); const expires = Date.parse(model.expiresAt);
  return Number.isFinite(issued) && Number.isFinite(expires) && issued <= now.getTime() && expires > now.getTime() && expires - issued <= 90 * 86_400_000 && Object.entries(model.weightsBps).length <= 20 && Object.entries(model.weightsBps).every(([key, weight]) => /^[a-z_]{1,40}$/.test(key) && Number.isSafeInteger(weight) && weight >= 8000 && weight <= 12000);
}

export interface MeasuredIntelligenceOutcome {
  id: string; sourceReference: string; chainId: IntelligenceChainId; collection: string; sourceWallet?: string;
  decisionAt: string; outcomeAt: string; status: 'confirmed' | 'pending' | 'reorged'; synthetic: boolean;
  costBasisWei: string | null; grossProceedsWei: string | null; dispositionFeesWei: string | null; realizedPnlWei: string | null;
}
export function isMeasuredOutcome(row: MeasuredIntelligenceOutcome, now: Date): boolean {
  try {
    if (!row || !OPAQUE.test(row.id) || !OPAQUE.test(row.sourceReference) || ![1, 8453, 4663].includes(row.chainId) || !ADDRESS.test(row.collection) || row.sourceWallet !== undefined && !ADDRESS.test(row.sourceWallet) || row.status !== 'confirmed' || row.synthetic !== false || ![row.costBasisWei, row.grossProceedsWei, row.dispositionFeesWei].every(uint) || typeof row.realizedPnlWei !== 'string' || !/^-?(0|[1-9][0-9]{0,77})$/.test(row.realizedPnlWei)) return false;
    const decision = Date.parse(row.decisionAt); const outcome = Date.parse(row.outcomeAt);
    return [decision, outcome, now.getTime()].every(Number.isFinite) && decision <= outcome && outcome <= now.getTime() && BigInt(row.grossProceedsWei!) - BigInt(row.dispositionFeesWei!) - BigInt(row.costBasisWei!) === BigInt(row.realizedPnlWei);
  } catch { return false; }
}
/** Duplicate/conflicting and reorged lineages do not become measured successes. */
export function measuredOutcomes(rows: readonly MeasuredIntelligenceOutcome[], now: Date): MeasuredIntelligenceOutcome[] {
  const seen = new Map<string, MeasuredIntelligenceOutcome>(); const invalid = new Set<string>();
  for (const row of rows.slice(0, 100_000)) {
    if (!row || !OPAQUE.test(row.sourceReference)) continue;
    const key = `${row.chainId}:${row.sourceReference}`;
    const prior = seen.get(key);
    if (row.status === 'reorged' || prior && JSON.stringify(prior) !== JSON.stringify(row)) invalid.add(key);
    if (!prior) seen.set(key, row);
  }
  return [...seen.entries()].filter(([key, row]) => !invalid.has(key) && isMeasuredOutcome(row, now)).map(([, row]) => row);
}
export function createHistoricalQualityPort(read: () => readonly MeasuredIntelligenceOutcome[]): HistoricalQualityPort {
  return { snapshot(context) {
    const rows = measuredOutcomes(read(), context.now).filter(row => row.chainId === context.chainId);
    const watched = new Set(context.watchedWallets.map(wallet => wallet.toLowerCase()));
    const fact = (selected: MeasuredIntelligenceOutcome[], sourceReference: string): SourcedFact<QualityMeasure> | undefined => {
      if (!selected.length) return undefined;
      const ordered = [...selected].sort((a, b) => a.outcomeAt.localeCompare(b.outcomeAt));
      const decisionTimes = selected.map(row => row.decisionAt).sort();
      return { chainId: context.chainId, contract: context.contract, observedAt: context.now.toISOString(), expiresAt: new Date(context.now.getTime() + 15 * 60_000).toISOString(), sourceReference, value: { samples: selected.length, profitable: selected.filter(row => BigInt(row.realizedPnlWei!) > 0n).length, unprofitable: selected.filter(row => BigInt(row.realizedPnlWei!) < 0n).length, breakEven: selected.filter(row => BigInt(row.realizedPnlWei!) === 0n).length, fullyCosted: true, lastOutcomeAt: ordered.at(-1)!.outcomeAt, coverageFrom: decisionTimes[0]!, coverageUntil: ordered.at(-1)!.outcomeAt } };
    };
    return { version: 'quality-facts-v1', chainId: context.chainId, contract: context.contract, walletQuality: fact(rows.filter(row => row.sourceWallet && watched.has(row.sourceWallet.toLowerCase())), 'canonical-wallet-outcomes'), projectQuality: fact(rows.filter(row => row.collection.toLowerCase() === context.contract.toLowerCase()), 'canonical-project-outcomes') };
  } };
}
