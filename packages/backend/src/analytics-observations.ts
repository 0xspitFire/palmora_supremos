import { createHash } from 'node:crypto';
import { buildAnalyticsReport, type AnalyticsActivity, type AnalyticsFloorQuote } from './analytics.js';
import { readCanonicalAnalyticsActivities } from './canonical-analytics-ingestion.js';
import { readExternalAnalyticsActivities } from './external-analytics.js';
import type { EventRecord } from './types.js';
import type { MeasuredIntelligenceOutcome } from './intelligence/advanced-scoring.js';

function stableFacts(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableFacts).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>`${JSON.stringify(key)}:${stableFacts(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/** Shared by CLI, Telegram, dashboard and the intelligence feedback consumer. */
export function readAnalyticsObservations(events: readonly EventRecord[]) {
  const canonical = readCanonicalAnalyticsActivities(events);
  const external = readExternalAnalyticsActivities(events);
  return { fundingAllocations: canonical.fundingAllocations, activities: [...canonical.activities, ...external.activities], coverage: { canonical: canonical.coverage, external: external.coverage, historyComplete: false as const } };
}

/** Realized, fully costed FIFO outcomes only. Floors and unconfirmed history never train a model. */
export function measuredAnalyticsOutcomes(events: readonly EventRecord[], now = new Date()): MeasuredIntelligenceOutcome[] {
  const { activities } = readAnalyticsObservations(events);
  const report = buildAnalyticsReport({ activities, now });
  const byId = new Map(activities.map(activity => [activity.id, activity]));
  return report.dispositions.flatMap(row => {
    const sale = byId.get(row.activityId), acquired = byId.get(row.acquisitionActivityId);
    if (!sale || !acquired || sale.status !== 'confirmed' || acquired.status !== 'confirmed' || sale.kind !== 'sale' || acquired.kind !== 'acquisition' || row.basisWei === null || row.realizedPnlWei === null || report.coverage.conflictingIdentities > 0) return [];
    const fingerprint = createHash('sha256').update(stableFacts({ sale: {...sale,subIndex:sale.subIndex??0}, acquisition: {...acquired,subIndex:acquired.subIndex??0}, tokenId: row.tokenId, quantity: row.quantity, wallet: row.wallet, basisWei: row.basisWei, grossProceedsWei: row.grossProceedsWei, dispositionFeesWei: row.dispositionFeesWei })).digest('hex');
    const decision = events.find(event => event.type === 'replication_prepared' && event.data.campaignId === row.campaignId);
    const decisionAt = decision?.at ?? row.acquiredAt;
    return [{ id: `outcome:${fingerprint}`, sourceReference: `lineage:${fingerprint}`, chainId: row.chainId, collection: row.collection,
      sourceWallet: row.sourceWallet ?? acquired.wallet, decisionAt, outcomeAt: sale.at, status: 'confirmed' as const, synthetic: false,
      costBasisWei: row.basisWei, grossProceedsWei: row.grossProceedsWei, dispositionFeesWei: row.dispositionFeesWei, realizedPnlWei: row.realizedPnlWei }];
  });
}

/** Personal reporting excludes watched-wallet trades; inter-owned transfers keep basis. */
export function personalAnalyticsActivities(activities: readonly AnalyticsActivity[], owned: readonly { chainId: number; address: string }[]): AnalyticsActivity[] {
  const contains = (chainId: number, wallet: string) => owned.some(item => item.chainId === chainId && item.address.toLowerCase() === wallet.toLowerCase());
  return activities.flatMap(row => {
    if (contains(row.chainId, row.wallet)) return [row];
    if (row.kind === 'transfer' && contains(row.chainId, row.toWallet)) return [{ ...row, kind: 'acquisition' as const, wallet: row.toWallet, costWei: null, gasWei: '0' }];
    return [];
  });
}


export function readAnalyticsWalletScope(events: readonly EventRecord[]): Array<{ chainId: 1 | 8453 | 4663; address: string }> | undefined {
  const rows = events.filter(event => event.type === 'analytics_wallet_scope' && Number.isSafeInteger(event.data.revision)).sort((a, b) => Number(a.data.revision) - Number(b.data.revision));
  const row = rows.at(-1);
  if (!row) return undefined;
  const wallets = row.data.wallets;
  if (!Array.isArray(wallets) || wallets.length > 300 || wallets.some(wallet => !wallet || ![1, 8453, 4663].includes(wallet.chainId) || typeof wallet.address !== 'string' || !/^0x[0-9a-f]{40}$/i.test(wallet.address))) return [];
  const values = wallets.map(wallet => ({ chainId: wallet.chainId as 1 | 8453 | 4663, address: String(wallet.address).toLowerCase() }));
  if (new Set(values.map(wallet => `${wallet.chainId}:${wallet.address}`)).size !== values.length) return [];
  return values;
}


/** Two historical quotes per collection; expired estimates remain marked stale by FIFO reporting. */
export function readAnalyticsFloorQuotes(events: readonly EventRecord[], now = new Date()): AnalyticsFloorQuote[] {
  const groups = new Map<string, AnalyticsFloorQuote[]>();
  for (const event of events) {
    if (event.type !== 'analytics_floor_quote') continue;
    const q = event.data.quote as AnalyticsFloorQuote | undefined;
    if (!q || ![1, 8453, 4663].includes(q.chainId) || !/^0x[0-9a-f]{40}$/i.test(q.collection) || !/^(0|[1-9][0-9]{0,77})$/.test(q.floorWei) || !/^opensea:[A-Za-z0-9_.:-]{1,150}$/.test(q.sourceReference)) continue;
    const observed = Date.parse(q.observedAt), expires = Date.parse(q.expiresAt);
    if (![observed, expires, now.getTime()].every(Number.isFinite) || observed > now.getTime() || expires <= observed || expires - observed > 10 * 60_000 || now.getTime() - observed > 30 * 86_400_000) continue;
    const key = `${q.chainId}:${q.collection.toLowerCase()}`, rows = groups.get(key) ?? [];
    // Preserve contradictions at the same timestamp: the accounting layer marks conflicts unknown.
    if (!rows.some(row => row.observedAt === q.observedAt && row.floorWei === q.floorWei)) rows.push({ ...q, collection: q.collection.toLowerCase() });
    rows.sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt)); groups.set(key, rows.slice(0, 4));
  }
  return [...groups.values()].flat();
}


export function readPersonalAnalyticsObservations(events: readonly EventRecord[]) {
  const merged = readAnalyticsObservations(events), owned = readAnalyticsWalletScope(events);
  return owned === undefined ? { activities: merged.activities } : { activities: personalAnalyticsActivities(merged.activities, owned), ownedWallets: owned };
}
