import type { BackendState, ExecutionChainId, ReceiptRecord } from './types.js';

/** Read-only, ETH-denominated accounting. No result is execution authority. */
interface ActivityBase {
  id: string;
  sourceReference: string;
  chainId: ExecutionChainId;
  collection: string;
  tokenId: string;
  quantity: string;
  wallet: string;
  status: 'confirmed' | 'pending' | 'reorged';
  transactionHash: string;
  blockHash: string;
  blockNumber: string;
  transactionIndex: number;
  logIndex: number;
  /** ERC1155 batch item position; omitted legacy records mean0. */
  subIndex?: number;
  at: string;
  campaignId?: string;
  sourceWallet?: string;
  mintType?: 'public' | 'allowlist' | 'other';
}
export type AnalyticsActivity = ActivityBase & (
  | { kind: 'acquisition'; costWei: string | null; gasWei: string }
  | { kind: 'sale'; grossProceedsWei: string; marketplaceFeesWei: string; gasWei: string }
  | { kind: 'transfer'; toWallet: string; gasWei: string }
);
export interface AnalyticsFloorQuote { chainId: ExecutionChainId; collection: string; floorWei: string; observedAt: string; expiresAt: string; sourceReference: string; }
export interface ReplayOpportunity { id: string; at: string; score: number; watchedMintVerified: boolean; free: boolean; guardsPassed: boolean; realizedPnlWei: string | null; }
export interface ShadowPolicy { id: string; minimumScore: number; requireWatchedMint: boolean; freeOnly: boolean; }
export interface AnalyticsOptions { ownedWallets?: readonly { chainId: number; address: string }[]; activities?: readonly AnalyticsActivity[]; floorQuotes?: readonly AnalyticsFloorQuote[]; replay?: { opportunities: readonly ReplayOpportunity[]; policies: readonly ShadowPolicy[] }; now?: Date; }
interface BasisLot { fifoOrder: number; chainId: ExecutionChainId; collection: string; tokenId: string; wallet: string; quantity: bigint; basis: bigint | null; acquiredAt: string; activityId: string; campaignId: string | null; sourceWallet: string | null; mintType: string | null; }
interface Disposition { acquisitionActivityId: string; acquiredAt: string; collection: string; tokenId: string; grossProceedsWei: string; dispositionFeesWei: string; activityId: string; chainId: ExecutionChainId; wallet: string; campaignId: string | null; sourceWallet: string | null; mintType: string | null; quantity: string; proceedsWei: string; basisWei: string | null; realizedPnlWei: string | null; }
interface Issue { code: string; activityId?: string; }

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const UINT = /^(0|[1-9][0-9]*)$/;
const INT = /^-?(0|[1-9][0-9]*)$/;
const OPAQUE = /^[A-Za-z0-9_:\-.]{1,160}$/;
const chains = new Set([1, 8453, 4663]);
const uint = (value: unknown): value is string => typeof value === 'string' && value.length <= 80 && UINT.test(value);
const signed = (value: unknown): value is string => typeof value === 'string' && value.length <= 81 && INT.test(value);
const timestamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const opaque = (value: unknown): value is string => typeof value === 'string' && OPAQUE.test(value);
const address = (value: unknown): value is string => typeof value === 'string' && ADDRESS.test(value);
const assetKey = (chainId: number, collection: string, tokenId: string) => `${chainId}:${collection.toLowerCase()}:${tokenId}`;

function validActivity(row: AnalyticsActivity, now: number): boolean {
  if (!row || !opaque(row.id) || !opaque(row.sourceReference) || !chains.has(row.chainId) || !address(row.collection) || !address(row.wallet) || !uint(row.tokenId) || !uint(row.quantity) || BigInt(row.quantity) <= 0n || !HASH.test(row.transactionHash ?? '') || !HASH.test(row.blockHash ?? '') || !uint(row.blockNumber) || !Number.isSafeInteger(row.transactionIndex) || row.transactionIndex < 0 || !Number.isSafeInteger(row.logIndex) || row.logIndex < 0 || row.subIndex !== undefined && (!Number.isSafeInteger(row.subIndex) || row.subIndex < 0 || row.subIndex > 999) || !timestamp(row.at) || Date.parse(row.at) > now || !['confirmed', 'pending', 'reorged'].includes(row.status)) return false;
  if (row.campaignId !== undefined && !opaque(row.campaignId) || row.sourceWallet !== undefined && !address(row.sourceWallet) || row.mintType !== undefined && !['public', 'allowlist', 'other'].includes(row.mintType) || !uint(row.gasWei)) return false;
  if (row.kind === 'acquisition') return row.costWei === null || uint(row.costWei);
  if (row.kind === 'sale') return uint(row.grossProceedsWei) && uint(row.marketplaceFeesWei);
  return row.kind === 'transfer' && address(row.toWallet) && row.toWallet.toLowerCase() !== row.wallet.toLowerCase();
}

function compareActivities(a: AnalyticsActivity, b: AnalyticsActivity): number {
  if (a.chainId !== b.chainId) return a.chainId - b.chainId;
  const block = BigInt(a.blockNumber) - BigInt(b.blockNumber);
  if (block !== 0n) return block < 0n ? -1 : 1;
  return a.transactionIndex - b.transactionIndex || a.logIndex - b.logIndex || (a.subIndex ?? 0) - (b.subIndex ?? 0) || a.id.localeCompare(b.id);
}

/** Inputs are explicit confirmed transaction facts. Missing provider coverage remains missing. */
export function buildAnalyticsReport(options: AnalyticsOptions = {}) {
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error('ANALYTICS_TIME_INVALID');
  const issues: Issue[] = [];
  const valid: AnalyticsActivity[] = [];
  let pending = 0;
  let reorged = 0;
  let duplicates = 0;
  const identities = new Map<string, AnalyticsActivity>();
  const conflicting = new Set<string>();
  const rows = options.activities ?? [];
  // Reorg markers invalidate their exact transaction/log even if a confirmed row
  // was encountered first. Conflicting copies are never selected arbitrarily.
  for (const row of rows) {
    if (!validActivity(row, now.getTime())) { issues.push({ code: 'ACTIVITY_INVALID', ...(opaque(row?.id) ? { activityId: row.id } : {}) }); continue; }
    const key = `${row.chainId}:${row.transactionHash.toLowerCase()}:${row.logIndex}:${row.subIndex ?? 0}`;
    const prior = identities.get(key);
    if (!prior) { identities.set(key, row); continue; }
    const fingerprint = (activity: AnalyticsActivity): string => JSON.stringify(Object.fromEntries(Object.entries({ ...activity, subIndex: activity.subIndex ?? 0 }).filter(([field]) => !['id', 'sourceReference', 'status'].includes(field)).sort(([a], [b]) => a.localeCompare(b))));
    if (prior.status === 'reorged' || row.status === 'reorged') { identities.set(key, { ...row, status: 'reorged' }); duplicates += 1; }
    else if (fingerprint(prior) === fingerprint(row)) { duplicates += 1; if (row.status === 'confirmed') identities.set(key, row); }
    else { conflicting.add(key); issues.push({ code: 'ACTIVITY_CONFLICT', activityId: row.id }); }
  }
  for (const [key, row] of identities) {
    if (conflicting.has(key)) continue;
    if (row.status === 'pending') { pending += 1; continue; }
    if (row.status === 'reorged') { reorged += 1; continue; }
    valid.push(row);
  }
  valid.sort(compareActivities);
  const inventory = new Map<string, BasisLot[]>();
  const dispositions: Disposition[] = [];
  let standaloneTransferGas = 0n;
  let fees = 0n;
  const take = (row: AnalyticsActivity): BasisLot[] => {
    const key = `${assetKey(row.chainId, row.collection, row.tokenId)}:${row.wallet.toLowerCase()}`;
    const available = inventory.get(key) ?? [];
    let quantity = BigInt(row.quantity);
    const parts: BasisLot[] = [];
    for (const lot of available) {
      if (quantity === 0n) break;
      if (lot.quantity === 0n) continue;
      const amount = quantity < lot.quantity ? quantity : lot.quantity;
      const basis = lot.basis === null ? null : amount === lot.quantity ? lot.basis : lot.basis * amount / lot.quantity;
      parts.push({ ...lot, quantity: amount, basis });
      if (lot.basis !== null && basis !== null) lot.basis -= basis;
      lot.quantity -= amount; quantity -= amount;
    }
    if (quantity > 0n) {
      issues.push({ code: 'ACQUISITION_HISTORY_MISSING', activityId: row.id });
      parts.push({ fifoOrder: Number.MAX_SAFE_INTEGER, chainId: row.chainId, collection: row.collection.toLowerCase(), tokenId: row.tokenId, wallet: row.wallet.toLowerCase(), quantity, basis: null, acquiredAt: row.at, activityId: row.id, campaignId: null, sourceWallet: null, mintType: null });
    }
    return parts;
  };
  const put = (lot: BasisLot): void => {
    const key = `${assetKey(lot.chainId, lot.collection, lot.tokenId)}:${lot.wallet}`;
    const list = inventory.get(key) ?? []; list.push(lot);
    // A transferred older lot retains its original FIFO age.
    list.sort((a, b) => a.fifoOrder - b.fifoOrder || a.activityId.localeCompare(b.activityId));
    inventory.set(key, list);
  };
  let fifoOrder = 0;
  for (const row of valid) {
    fifoOrder += 1;
    fees += BigInt(row.gasWei);
    if (row.kind === 'acquisition') {
      put({ fifoOrder, chainId: row.chainId, collection: row.collection.toLowerCase(), tokenId: row.tokenId, wallet: row.wallet.toLowerCase(), quantity: BigInt(row.quantity), basis: row.costWei === null ? null : BigInt(row.costWei) + BigInt(row.gasWei), acquiredAt: row.at, activityId: row.id, campaignId: row.campaignId ?? null, sourceWallet: row.sourceWallet?.toLowerCase() ?? null, mintType: row.mintType ?? null });
    } else if (row.kind === 'transfer') {
      standaloneTransferGas += BigInt(row.gasWei);
      for (const part of take(row)) put({ ...part, wallet: row.toWallet.toLowerCase() });
    } else {
      fees += BigInt(row.marketplaceFeesWei);
      let remainingGross = BigInt(row.grossProceedsWei);
      let remainingFees = BigInt(row.marketplaceFeesWei) + BigInt(row.gasWei);
      let remainingQuantity = BigInt(row.quantity);
      for (const part of take(row)) {
        const gross = part.quantity === remainingQuantity ? remainingGross : BigInt(row.grossProceedsWei) * part.quantity / BigInt(row.quantity);
        const partFees = part.quantity === remainingQuantity ? remainingFees : (BigInt(row.marketplaceFeesWei) + BigInt(row.gasWei)) * part.quantity / BigInt(row.quantity);
        const proceeds = gross - partFees;
        remainingGross -= gross; remainingFees -= partFees; remainingQuantity -= part.quantity;
        dispositions.push({ acquisitionActivityId: part.activityId, acquiredAt: part.acquiredAt, collection: row.collection.toLowerCase(), tokenId: row.tokenId, grossProceedsWei: gross.toString(), dispositionFeesWei: partFees.toString(), activityId: row.id, chainId: row.chainId, wallet: row.wallet.toLowerCase(), campaignId: part.campaignId, sourceWallet: part.sourceWallet, mintType: part.mintType, quantity: part.quantity.toString(), proceedsWei: proceeds.toString(), basisWei: part.basis?.toString() ?? null, realizedPnlWei: part.basis === null ? null : (proceeds - part.basis).toString() });
      }
    }
  }
  const quotes = new Map<string, AnalyticsFloorQuote[]>();
  const quoteConflicts = new Set<string>();
  for (const quote of options.floorQuotes ?? []) {
    if (!quote || !chains.has(quote.chainId) || !address(quote.collection) || !uint(quote.floorWei) || !opaque(quote.sourceReference) || !timestamp(quote.observedAt) || !timestamp(quote.expiresAt) || Date.parse(quote.observedAt) > now.getTime() || Date.parse(quote.expiresAt) < Date.parse(quote.observedAt)) { issues.push({ code: 'FLOOR_QUOTE_INVALID' }); continue; }
    const key = `${quote.chainId}:${quote.collection.toLowerCase()}`;
    const list = quotes.get(key) ?? [];
    if (list.some(prior => Date.parse(prior.observedAt) === Date.parse(quote.observedAt) && prior.floorWei !== quote.floorWei)) { quoteConflicts.add(`${key}:${Date.parse(quote.observedAt)}`); issues.push({ code: 'FLOOR_QUOTE_CONFLICT' }); }
    if (!list.some(prior => Date.parse(prior.observedAt) === Date.parse(quote.observedAt) && prior.floorWei === quote.floorWei && prior.sourceReference === quote.sourceReference)) list.push(quote);
    quotes.set(key, list);
  }
  for (const list of quotes.values()) list.sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt) || a.sourceReference.localeCompare(b.sourceReference));
  const holdings = [...inventory.values()].flat().filter(lot => lot.quantity > 0n && (options.ownedWallets === undefined || options.ownedWallets.some(wallet => wallet.chainId === lot.chainId && wallet.address.toLowerCase() === lot.wallet))).map(lot => {
    const quote = quotes.get(`${lot.chainId}:${lot.collection}`)?.[0];
    const conflict = quote && quoteConflicts.has(`${lot.chainId}:${lot.collection}:${Date.parse(quote.observedAt)}`);
    const fresh = quote && !conflict && Date.parse(quote.expiresAt) > now.getTime();
    const valuation = fresh ? BigInt(quote.floorWei) * lot.quantity : null;
    return { ...lot, quantity: lot.quantity.toString(), basis: undefined, basisWei: lot.basis?.toString() ?? null, floorValueWei: valuation?.toString() ?? null, floorSource: fresh ? quote.sourceReference : null, unrealizedPnlWei: valuation !== null && lot.basis !== null ? (valuation - lot.basis).toString() : null, priceStatus: conflict ? 'conflict' : fresh ? 'fresh' : quote ? 'stale' : 'missing' };
  });
  const knownRealized = dispositions.filter(row => row.realizedPnlWei !== null);
  const unknownRealized = dispositions.filter(row => row.realizedPnlWei === null);
  const sum = (values: readonly string[]): string => values.reduce((total, value) => total + BigInt(value), 0n).toString();
  const knownPnl = sum(knownRealized.map(row => row.realizedPnlWei!));
  const basisSold = sum(knownRealized.map(row => row.basisWei!));
  const group = (field: 'wallet' | 'campaignId' | 'sourceWallet' | 'mintType') => {
    const groups = new Map<string, Disposition[]>();
    for (const row of dispositions) { const key = `${row.chainId}:${row[field] ?? 'unattributed'}`; const list = groups.get(key) ?? []; list.push(row); groups.set(key, list); }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, members]) => ({ key, dispositions: members.length, knownPnlWei: sum(members.filter(row => row.realizedPnlWei !== null).map(row => row.realizedPnlWei!)), unknownBasisQuantity: sum(members.filter(row => row.basisWei === null).map(row => row.quantity)) }));
  };
  return {
    contract: 'mintbot.analytics', version: '1', mode: 'shadow-only', currency: 'ETH', method: 'FIFO', generatedAt: now.toISOString(),
    coverage: { inputActivities: rows.length, confirmedActivities: valid.length, pendingExcluded: pending, reorgedExcluded: reorged, duplicatesIgnored: duplicates, conflictingIdentities: conflicting.size, acquisitionCoverage: issues.some(issue => issue.code === 'ACQUISITION_HISTORY_MISSING') || holdings.some(lot => lot.basisWei === null) || unknownRealized.length > 0 ? 'partial' : rows.length ? 'provided-input-only' : 'no_samples', saleHistory: 'provided-input-only', providerCoverageAsserted: false },
    totals: { knownRealizedPnlWei: knownPnl, realizedPnlWei: unknownRealized.length || issues.some(issue => issue.code === 'ACTIVITY_INVALID' || issue.code === 'ACTIVITY_CONFLICT') ? null : dispositions.length ? knownPnl : null, knownBasisSoldWei: basisSold, unknownRealizedQuantity: sum(unknownRealized.map(row => row.quantity)), realizedRoiBps: BigInt(basisSold) > 0n && unknownRealized.length === 0 ? (BigInt(knownPnl) * 10_000n / BigInt(basisSold)).toString() : null, knownUnrealizedPnlWei: sum(holdings.filter(lot => lot.unrealizedPnlWei !== null).map(lot => lot.unrealizedPnlWei!)), unrealizedPnlWei: holdings.length && holdings.every(lot => lot.unrealizedPnlWei !== null) ? sum(holdings.map(lot => lot.unrealizedPnlWei!)) : null, transactionAndMarketplaceFeesWei: fees.toString(), transferGasExpenseWei: standaloneTransferGas.toString() },
    holdings, dispositions, attribution: { wallets: group('wallet'), campaigns: group('campaignId'), signalSources: group('sourceWallet'), mintTypes: group('mintType') },
    floorMovement: [...quotes.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, list]) => ({ key, currentWei: quoteConflicts.has(`${key}:${Date.parse(list[0]!.observedAt)}`) ? null : list[0]!.floorWei, previousWei: list[1]?.floorWei ?? null, changeWei: list[1] && !quoteConflicts.has(`${key}:${Date.parse(list[0]!.observedAt)}`) && !quoteConflicts.has(`${key}:${Date.parse(list[1].observedAt)}`) ? (BigInt(list[0]!.floorWei) - BigInt(list[1].floorWei)).toString() : null, currentStatus: quoteConflicts.has(`${key}:${Date.parse(list[0]!.observedAt)}`) ? 'conflict' : Date.parse(list[0]!.expiresAt) > now.getTime() ? 'fresh' : 'stale' })),
    replay: evaluateShadowPolicies(options.replay?.opportunities ?? [], options.replay?.policies ?? [], now), issues,
    limitations: ['Only supplied confirmed acquisition, sale and transfer facts are accounted for; absence is not proof of a complete history.', 'Floor prices are estimates, not executable sale proceeds.', 'Transfer gas is reported separately and does not change carried FIFO basis.', 'Shadow analytics never changes live scores, policy limits, wallet selection or execution authority.'],
  };
}

/** Deterministic historical comparison only; guard failures are never selected. */
export function evaluateShadowPolicies(opportunities: readonly ReplayOpportunity[], policies: readonly ShadowPolicy[], now = new Date()) {
  if (!Number.isFinite(now.getTime())) throw new Error('ANALYTICS_TIME_INVALID');
  const unique = new Map<string, ReplayOpportunity>();
  const conflicting = new Set<string>();
  let invalid = 0;
  for (const row of opportunities) {
    if (!row || !opaque(row.id) || !timestamp(row.at) || Date.parse(row.at) > now.getTime() || !Number.isFinite(row.score) || row.score < 0 || row.score > 100 || typeof row.free !== 'boolean' || typeof row.watchedMintVerified !== 'boolean' || typeof row.guardsPassed !== 'boolean' || row.realizedPnlWei !== null && !signed(row.realizedPnlWei)) { invalid += 1; continue; }
    const prior = unique.get(row.id);
    if (prior && (prior.at !== row.at || prior.score !== row.score || prior.free !== row.free || prior.watchedMintVerified !== row.watchedMintVerified || prior.guardsPassed !== row.guardsPassed || prior.realizedPnlWei !== row.realizedPnlWei)) conflicting.add(row.id);
    else unique.set(row.id, row);
  }
  const rows = [...unique.values()].filter(row => !conflicting.has(row.id)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id));
  return policies.map(policy => {
    if (!policy || !opaque(policy.id) || !Number.isFinite(policy.minimumScore) || policy.minimumScore < 0 || policy.minimumScore > 100 || typeof policy.requireWatchedMint !== 'boolean' || typeof policy.freeOnly !== 'boolean') throw new Error('ANALYTICS_SHADOW_POLICY_INVALID');
    const selected = rows.filter(row => row.guardsPassed && row.score >= policy.minimumScore && (!policy.requireWatchedMint || row.watchedMintVerified) && (!policy.freeOnly || row.free));
    const measured = selected.filter(row => row.realizedPnlWei !== null);
    return { policyId: policy.id, mode: 'shadow-only', invalidSamples: invalid, conflictingSamples: conflicting.size, selectedIds: selected.map(row => row.id), selected: selected.length, measured: measured.length, unknownOutcomes: selected.length - measured.length, profitable: measured.filter(row => BigInt(row.realizedPnlWei!) > 0n).length, unprofitable: measured.filter(row => BigInt(row.realizedPnlWei!) < 0n).length, breakEven: measured.filter(row => BigInt(row.realizedPnlWei!) === 0n).length, knownRealizedPnlWei: measured.reduce((total, row) => total + BigInt(row.realizedPnlWei!), 0n).toString(), winRateBps: measured.length ? Math.floor(measured.filter(row => BigInt(row.realizedPnlWei!) > 0n).length * 10_000 / measured.length) : null };
  });
}

function canonicalCosts(state: BackendState) {
  const groups = new Map<string, ReceiptRecord[]>();
  for (const receipt of state.receipts) { const list = groups.get(receipt.executionId) ?? []; list.push(receipt); groups.set(receipt.executionId, list); }
  const rows = [];
  for (const [executionId, receipts] of groups) {
    const receipt = [...receipts].sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt) || b.id.localeCompare(a.id))[0]!;
    const attempt = state.attempts.find(item => item.id === receipt.transactionAttemptId && item.executionId === executionId && item.runId === receipt.runId);
    const run = state.runs.find(item => item.id === receipt.runId && item.mode === 'live');
    const intent = state.intents.find(item => item.id === run?.intentId && item.runId === receipt.runId);
    if (!attempt || !run || !intent) continue;
    const campaign = intent.campaignSnapshot;
    const final = (receipt.state === 'Confirmed' || receipt.state === 'Failed') && (campaign.chainId === 1 || receipt.finalityStage === 'ethereum_final' || receipt.robinhoodFinality === 'final');
    const settlement = state.reservations.find(item => item.runId === run.id && item.wallet.toLowerCase() === attempt.wallet.toLowerCase() && item.status === 'settled');
    const total = final && settlement && receipt.actualSpendWei !== undefined && receipt.actualSpendWei >= 0n && settlement.actualAmountWei === receipt.actualSpendWei ? receipt.actualSpendWei : null;
    const mint = receipt.state === 'Confirmed' ? campaign.mintPriceWei * BigInt(campaign.quantity) : 0n;
    const fee = total !== null && total >= mint ? total - mint : null;
    const prepared = state.events.find(event => event.type === 'replication_prepared' && event.data.campaignId === campaign.id);
    rows.push({ executionId, runId: run.id, campaignId: campaign.id, chainId: campaign.chainId, collection: campaign.contract.toLowerCase(), wallet: attempt.wallet.toLowerCase(), status: receipt.state, requestedQuantity: campaign.quantity, confirmedIntentQuantity: receipt.state === 'Confirmed' && total !== null ? campaign.quantity : null, tokenIds: null, tokenIdentityCoverage: 'not-recorded-in-receipt', mintCostWei: total !== null ? mint.toString() : null, gasAndChainFeesWei: fee?.toString() ?? null, totalCostWei: total?.toString() ?? null, receiptId: receipt.id, sourceWallet: typeof prepared?.data.sourceWallet === 'string' && address(prepared.data.sourceWallet) ? prepared.data.sourceWallet.toLowerCase() : null, sourceEventId: typeof prepared?.data.sourceEventId === 'string' && opaque(prepared.data.sourceEventId) ? prepared.data.sourceEventId : null, finalityLatencyMs: Number.isFinite(Date.parse(receipt.observedAt) - Date.parse(run.createdAt)) ? Math.max(0, Date.parse(receipt.observedAt) - Date.parse(run.createdAt)) : null });
  }
  return rows.sort((a, b) => a.executionId.localeCompare(b.executionId));
}

/** Canonical receipt costs do not fabricate token IDs, sale prices or external history. */
export function buildCanonicalAnalyticsReport(state: BackendState, options: AnalyticsOptions = {}) {
  const report = buildAnalyticsReport(options);
  const executions = canonicalCosts(state);
  const performance = (field: 'wallet' | 'campaignId' | 'sourceWallet') => {
    const groups = new Map<string, typeof executions>();
    for (const row of executions) { const key = `${row.chainId}:${row[field] ?? 'unattributed'}`; const list = groups.get(key) ?? []; list.push(row); groups.set(key, list); }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, members]) => {
      const completed = members.filter(row => row.totalCostWei !== null);
      const latencies = completed.flatMap(row => row.finalityLatencyMs === null ? [] : [row.finalityLatencyMs]);
      return { key, executions: members.length, confirmed: completed.filter(row => row.status === 'Confirmed').length, failed: completed.filter(row => row.status === 'Failed').length, unknownCosts: members.length - completed.length, totalCostWei: completed.reduce((sum, row) => sum + BigInt(row.totalCostWei!), 0n).toString(), averageFinalityLatencyMs: latencies.length ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length) : null, realizedPnlWei: null };
    });
  };
  return { ...report, canonical: { performance: { wallets: performance('wallet'), campaigns: performance('campaignId'), signalSources: performance('sourceWallet') }, executions, executionsSeen: executions.length, confirmed: executions.filter(row => row.status === 'Confirmed' && row.totalCostWei !== null).length, failed: executions.filter(row => row.status === 'Failed' && row.totalCostWei !== null).length, completeCosts: executions.filter(row => row.totalCostWei !== null).length, incompleteCosts: executions.filter(row => row.totalCostWei === null).length, recordedTotalCostWei: executions.reduce((total, row) => total + BigInt(row.totalCostWei ?? '0'), 0n).toString(), tokenIdentityCoverage: 'external-confirmed-log-input-required', saleHistoryCoverage: 'external-confirmed-sale-input-required', accountingNotDoubleCounted: true } };
}
