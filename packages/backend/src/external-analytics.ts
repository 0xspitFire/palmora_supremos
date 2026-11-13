import { createHash } from 'node:crypto';
import type { AnalyticsActivity } from './analytics.js';
import type { BackendStore } from './store.js';
import type { EventRecord, ExecutionChainId } from './types.js';

export interface ExternalAnalyticsWallet { chainId: ExecutionChainId; address: string; }
export interface ExternalAnalyticsCandidatePage {
  candidates: readonly { transactionHash: string }[];
  next?: string;
  /** Exhausting an indexer page never proves complete chain history. */
  coverage: 'partial' | 'unknown';
  code: string;
}
export interface ExternalAnalyticsCandidatePort {
  page(input: { chainId: ExecutionChainId; wallet: string; after: number; before: number; cursor?: string }): Promise<ExternalAnalyticsCandidatePage>;
}
export interface ExternalNftTransfer { collection: string; tokenId: string; quantity: string; from: string; to: string; logIndex: number; subIndex?: number; batch?: true; }
export interface ExternalSaleSettlement {
  protocol: 'seaport-single-nft-v1';
  transferLogIndex: number;
  seller: string;
  buyer: string;
  currency: 'ETH' | 'WETH';
  grossWei: string;
  /** Sum paid to recipients other than seller, including royalties. */
  feesWei: string;
}
export interface ExternalMintCost {
  protocol: 'seadrop-direct-v1';
  method: 'mintPublic' | 'mintAllowList' | 'mintSigned';
  collection: string;
  minter: string;
  quantity: string;
  totalValueWei: string;
  transferLogIndices: readonly number[];
}
/** Only independently agreed, finalized public chain facts cross this boundary.
 * RPC comparison, protocol decoding and chain-specific finality live in CLI adapters.
 */
export interface ExternalTransactionEvidence {
  chainId: ExecutionChainId;
  transactionHash: string;
  blockHash: string;
  blockNumber: string;
  transactionIndex: number;
  at: string;
  from: string;
  valueWei: string;
  finality: 'finalized';
  readerIdentities: readonly [string, string];
  /** Null when full chain fees (including L1/operator fees) cannot be proved. */
  transactionFeeWei: string | null;
  transfers: readonly ExternalNftTransfer[];
  settlements: readonly ExternalSaleSettlement[];
  /** Exact known direct calldata and SeaDropMint event corroborate msg.value.
   * Calldata, Merkle proofs and signatures themselves are never persisted. */
  mintCost?: ExternalMintCost;
  issues: readonly string[];
}
export interface ExternalAnalyticsChainPort { observe(transactionHash: string): Promise<ExternalTransactionEvidence>; }
export interface ExternalAnalyticsOptions {
  store: BackendStore;
  wallets(): Promise<readonly ExternalAnalyticsWallet[]>;
  candidatePort: ExternalAnalyticsCandidatePort;
  chainPort(chainId: ExecutionChainId): Promise<ExternalAnalyticsChainPort>;
  now?: () => Date;
  startAtUnix?: number;
  overlapSeconds?: number;
  intervalMs?: number;
  maxTransactions?: number;
  maxWalletsPerTick?: number;
  record?(code: string): void;
}
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const HASH = /^0x[0-9a-f]{64}$/i;
const UINT = /^(0|[1-9][0-9]{0,77})$/;
const CODE = /^[A-Z][A-Z0-9_]{2,90}$/;
const ZERO = `0x${'0'.repeat(40)}`;
const OBSERVATION = 'analytics_external_observation';
const CANDIDATE = 'analytics_external_candidate';
const CURSOR = 'analytics_external_cursor';
const stable = (value: unknown): string => JSON.stringify(value, (_key, row: unknown) => row && typeof row === 'object' && !Array.isArray(row) ? Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))) : row);
const digest = (value: unknown): string => createHash('sha256').update(stable(value)).digest('hex');
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const uint = (value: unknown): value is string => typeof value === 'string' && UINT.test(value) && BigInt(value) < 2n ** 256n;
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const chain = (value: unknown): value is ExecutionChainId => value === 1 || value === 8453 || value === 4663;
const identity = (chainId: ExecutionChainId, hash: string): string => `${chainId}:${hash.toLowerCase()}`;
const SAFE_CODES = new Set(['EXTERNAL_ANALYTICS_UNAVAILABLE', 'EXTERNAL_ANALYTICS_REORGED', 'EXTERNAL_ANALYTICS_RPC_DISAGREEMENT', 'EXTERNAL_ANALYTICS_RPC_TIMEOUT', 'EXTERNAL_ANALYTICS_CHAIN_UNAVAILABLE', 'EXTERNAL_ANALYTICS_HASH_INVALID', 'EXTERNAL_ANALYTICS_RECEIPT_INVALID', 'EXTERNAL_ANALYTICS_LOG_BINDING_INVALID', 'EXTERNAL_ANALYTICS_FINALITY_UNPROVEN', 'EXTERNAL_ANALYTICS_FEES_INVALID', 'EXTERNAL_ANALYTICS_EVIDENCE_INVALID', 'EXTERNAL_ANALYTICS_TRANSFER_INVALID', 'EXTERNAL_ANALYTICS_SETTLEMENT_INVALID', 'EXTERNAL_ANALYTICS_PAGE_INVALID', 'EXTERNAL_NFT_LOG_INVALID', 'EXTERNAL_OPENSEA_ACCESS_DENIED', 'EXTERNAL_OPENSEA_RATE_LIMITED', 'EXTERNAL_OPENSEA_UNAVAILABLE', 'EXTERNAL_OPENSEA_RESPONSE_INVALID', 'EXTERNAL_OPENSEA_RESPONSE_TOO_LARGE', 'EXTERNAL_OPENSEA_SCOPE_INVALID']);
SAFE_CODES.add('EXTERNAL_ANALYTICS_MINT_COST_INVALID');
const safeCode = (error: unknown): string => error instanceof Error && SAFE_CODES.has(error.message) ? error.message : 'EXTERNAL_ANALYTICS_UNAVAILABLE';
const latestEvent = (events: readonly EventRecord[], type: string, matches: (event: EventRecord) => boolean = () => true): EventRecord | undefined => events.filter(event => event.type === type && matches(event)).sort((a, b) => Number(a.data.revision ?? 0) - Number(b.data.revision ?? 0)).at(-1);

export function validateExternalTransactionEvidence(value: ExternalTransactionEvidence, chainId: ExecutionChainId, hash: string, now = new Date()): void {
  if (!value || value.chainId !== chainId || !HASH.test(value.transactionHash) || !same(value.transactionHash, hash) || !HASH.test(value.blockHash) || !uint(value.blockNumber) || !count(value.transactionIndex) || !Number.isFinite(Date.parse(value.at)) || Date.parse(value.at) > now.getTime() || !ADDRESS.test(value.from) || !uint(value.valueWei) || value.finality !== 'finalized' || value.transactionFeeWei !== null && !uint(value.transactionFeeWei) || !Array.isArray(value.readerIdentities) || value.readerIdentities.length !== 2 || value.readerIdentities.some(row => typeof row !== 'string' || !/^[a-z0-9.-]{1,253}$/.test(row)) || value.readerIdentities[0] === value.readerIdentities[1] || !Array.isArray(value.transfers) || value.transfers.length > 1000 || !Array.isArray(value.settlements) || value.settlements.length > 1 || !Array.isArray(value.issues) || value.issues.length > 30 || value.issues.some(code => !CODE.test(code))) throw new Error('EXTERNAL_ANALYTICS_EVIDENCE_INVALID');
  const logs = new Set<string>();
  for (const row of value.transfers) {
    if (!row || !ADDRESS.test(row.collection) || !ADDRESS.test(row.from) || !ADDRESS.test(row.to) || same(row.from, row.to) || !uint(row.tokenId) || !uint(row.quantity) || BigInt(row.quantity) < 1n || !count(row.logIndex) || row.subIndex !== undefined && (!count(row.subIndex) || row.subIndex > 999) || row.batch !== undefined && row.batch !== true || logs.has(transferIdentity(row))) throw new Error('EXTERNAL_ANALYTICS_TRANSFER_INVALID');
    logs.add(transferIdentity(row));
  }
  for (const sale of value.settlements) {
    const transfer = value.transfers.find(row => row.logIndex === sale.transferLogIndex);
    if (value.transfers.length !== 1 || sale.protocol !== 'seaport-single-nft-v1' || !transfer || transfer.batch === true || (transfer.subIndex ?? 0) !== 0 || !ADDRESS.test(sale.seller) || !ADDRESS.test(sale.buyer) || !same(transfer.from, sale.seller) || !same(transfer.to, sale.buyer) || !['ETH', 'WETH'].includes(sale.currency) || !uint(sale.grossWei) || !uint(sale.feesWei) || BigInt(sale.grossWei) === 0n || BigInt(sale.feesWei) > BigInt(sale.grossWei)) throw new Error('EXTERNAL_ANALYTICS_SETTLEMENT_INVALID');
  }
  const mint = value.mintCost;
  if (mint) {
    if (mint.protocol !== 'seadrop-direct-v1' || !['mintPublic', 'mintAllowList', 'mintSigned'].includes(mint.method) || !ADDRESS.test(mint.collection) || !ADDRESS.test(mint.minter) || !same(mint.minter, value.from) || !uint(mint.quantity) || BigInt(mint.quantity) < 1n || !uint(mint.totalValueWei) || mint.totalValueWei !== value.valueWei || value.settlements.length || !Array.isArray(mint.transferLogIndices) || mint.transferLogIndices.length !== value.transfers.length || new Set(mint.transferLogIndices).size !== value.transfers.length || !value.transfers.length || value.transfers.some(row => row.batch === true || (row.subIndex ?? 0) !== 0 || !same(row.from, ZERO) || !same(row.to, mint.minter) || !same(row.collection, mint.collection) || !mint.transferLogIndices.includes(row.logIndex)) || value.transfers.reduce((sum, row) => sum + BigInt(row.quantity), 0n) !== BigInt(mint.quantity)) throw new Error('EXTERNAL_ANALYTICS_MINT_COST_INVALID');
  }
}

const transferIdentity = (row: ExternalNftTransfer): string => `${row.logIndex}:${row.subIndex ?? 0}`;
const transferOrder = (left: ExternalNftTransfer, right: ExternalNftTransfer): number => left.logIndex - right.logIndex || (left.subIndex ?? 0) - (right.subIndex ?? 0);

interface Outcome { state: 'confirmed' | 'unavailable'; coverage: 'complete' | 'partial' | 'unknown'; code: string; activities: AnalyticsActivity[]; issues: string[]; blockHash?: string; }
interface Observation extends Outcome { key: string; revision: number; payloadDigest: string; }
function observations(events: readonly EventRecord[]): Map<string, Observation> {
  const rows = new Map<string, Observation>();
  for (const event of events) {
    const data = event.data;
    if (event.type !== OBSERVATION || data.version !== 1 || typeof data.key !== 'string' || !/^(1|8453|4663):0x[0-9a-f]{64}$/.test(data.key) || !count(data.revision) || data.revision < 1 || !['confirmed', 'unavailable'].includes(String(data.state)) || !['complete', 'partial', 'unknown'].includes(String(data.coverage)) || typeof data.code !== 'string' || !CODE.test(data.code) || !Array.isArray(data.activities) || !Array.isArray(data.issues)) continue;
    const payload = { state: data.state, coverage: data.coverage, code: data.code, activities: data.activities, issues: data.issues, ...(typeof data.blockHash === 'string' ? { blockHash: data.blockHash } : {}) };
    if (digest(payload) !== data.payloadDigest) continue;
    const prior = rows.get(data.key);
    if (!prior || data.revision > prior.revision) rows.set(data.key, { ...payload, key: data.key, revision: data.revision, payloadDigest: data.payloadDigest } as Observation);
  }
  return rows;
}

/** These remain observed-transaction facts, never an assertion of all historical holdings. */
export function readExternalAnalyticsActivities(events: readonly EventRecord[]) {
  const rows = [...observations(events).values()];
  const discovery = events.filter(event => event.type === CURSOR);
  const discoveryStatus = new Map<string, EventRecord>();
  for (const event of events) if (event.type === 'analytics_external_discovery_status' && typeof event.data.scope === 'string' && Number(event.data.revision) > Number(discoveryStatus.get(event.data.scope)?.data.revision ?? 0)) discoveryStatus.set(event.data.scope, event);
  return {
    activities: rows.flatMap(row => row.state === 'confirmed' ? row.activities : []),
    coverage: { status: rows.some(row => row.state === 'confirmed') ? 'partial' as const : 'unknown' as const, scope: 'verified-external-observed-transactions' as const, historyComplete: false as const, transactions: rows.length, completeTransactions: rows.filter(row => row.coverage === 'complete').length, partialTransactions: rows.filter(row => row.coverage === 'partial').length, unavailableTransactions: rows.filter(row => row.state === 'unavailable').length, discoveryWindows: discovery.length, unknownDiscoveryScopes: [...discoveryStatus.values()].filter(event => event.data.coverage === 'unknown').length, issues: [...new Set([...rows.flatMap(row => row.issues), ...[...discoveryStatus.values()].flatMap(event => typeof event.data.code === 'string' && CODE.test(event.data.code) ? [event.data.code] : [])])].sort() },
  };
}

function activitiesFor(evidence: ExternalTransactionEvidence, wallets: readonly ExternalAnalyticsWallet[], canonicalMintHashes: Set<string>): Outcome {
  const owned = new Set(wallets.filter(wallet => wallet.chainId === evidence.chainId).map(wallet => wallet.address.toLowerCase()));
  const relevant = [...evidence.transfers].filter(row => owned.has(row.from.toLowerCase()) || owned.has(row.to.toLowerCase())).sort(transferOrder);
  const issues = [...evidence.issues];
  if (evidence.transactionFeeWei === null) issues.push('EXTERNAL_TRANSACTION_FEES_UNKNOWN');
  const allocations = new Map<string, bigint>();
  const mintAllocations = new Map<string, bigint>();
  const charged = owned.has(evidence.from.toLowerCase()) ? relevant.filter(row => same(evidence.from, row.from) || same(evidence.from, row.to) && !owned.has(row.from.toLowerCase())) : [];
  let feeLeft = BigInt(evidence.transactionFeeWei ?? '0');
  for (const [index, row] of charged.entries()) { const fee = feeLeft / BigInt(charged.length - index); allocations.set(transferIdentity(row), fee); feeLeft -= fee; }
  if (evidence.mintCost && evidence.transactionFeeWei !== null) {
    let valueLeft = BigInt(evidence.mintCost.totalValueWei); let quantityLeft = BigInt(evidence.mintCost.quantity);
    for (const row of [...evidence.transfers].sort(transferOrder)) { const quantity = BigInt(row.quantity); const cost = quantity === quantityLeft ? valueLeft : valueLeft * quantity / quantityLeft; mintAllocations.set(transferIdentity(row), cost); valueLeft -= cost; quantityLeft -= quantity; }
  }
  const activities: AnalyticsActivity[] = [];
  for (const row of relevant) {
    // The canonical pipeline already has exact mint basis/attribution. Never
    // replace it with an external unknown-basis duplicate of the same log.
    if (same(row.from, ZERO) && canonicalMintHashes.has(identity(evidence.chainId, evidence.transactionHash))) continue;
    const sale = evidence.settlements.find(item => item.transferLogIndex === row.logIndex);
    const gas = allocations.get(transferIdentity(row)) ?? 0n;
    const base = { sourceReference: `external:${digest({ hash: evidence.transactionHash, blockHash: evidence.blockHash })}`, chainId: evidence.chainId, collection: row.collection.toLowerCase(), tokenId: row.tokenId, quantity: row.quantity, status: 'confirmed' as const, transactionHash: evidence.transactionHash.toLowerCase(), blockHash: evidence.blockHash.toLowerCase(), blockNumber: evidence.blockNumber, transactionIndex: evidence.transactionIndex, logIndex: row.logIndex, subIndex: row.subIndex ?? 0, at: evidence.at };
    const id = `external:${digest({ chainId: evidence.chainId, hash: evidence.transactionHash, logIndex: row.logIndex, ...((row.subIndex ?? 0) ? { subIndex: row.subIndex } : {}) })}`;
    if (owned.has(row.from.toLowerCase())) {
      // Never publish a sale with an unproved fee cost for its gas payer.
      if (sale && (!same(evidence.from, row.from) || evidence.transactionFeeWei !== null)) activities.push({ ...base, id, wallet: row.from.toLowerCase(), kind: 'sale', grossProceedsWei: sale.grossWei, marketplaceFeesWei: sale.feesWei, gasWei: gas.toString() });
      else { activities.push({ ...base, id, wallet: row.from.toLowerCase(), kind: 'transfer', toWallet: row.to.toLowerCase(), gasWei: gas.toString() }); issues.push('EXTERNAL_DISPOSITION_CONSIDERATION_UNKNOWN'); }
    }
    if (owned.has(row.to.toLowerCase()) && (!owned.has(row.from.toLowerCase()) || sale)) {
      const feesKnown = !same(evidence.from, row.to) || evidence.transactionFeeWei !== null;
      // An internal sale has two accounting legs. A distinct log identity is
      // impossible in the existing FIFO contract; leave that shape unknown.
      if (sale && owned.has(row.from.toLowerCase())) { issues.push('EXTERNAL_INTERNAL_SALE_UNSUPPORTED'); activities.pop(); activities.push({ ...base, id, wallet: row.from.toLowerCase(), kind: 'transfer', toWallet: row.to.toLowerCase(), gasWei: gas.toString() }); continue; }
      const mintValue = mintAllocations.get(transferIdentity(row));
      const costWei = sale && feesKnown ? sale.grossWei : mintValue !== undefined ? mintValue.toString() : null;
      activities.push({ ...base, id, wallet: row.to.toLowerCase(), kind: 'acquisition', costWei, gasWei: gas.toString(), ...(evidence.mintCost ? { mintType: evidence.mintCost.method === 'mintPublic' ? 'public' as const : evidence.mintCost.method === 'mintAllowList' ? 'allowlist' as const : 'other' as const } : {}) });
      if (costWei === null) issues.push('EXTERNAL_ACQUISITION_BASIS_UNKNOWN');
    }
  }
  const unique = [...new Set(issues)].sort();
  return { state: 'confirmed', coverage: unique.length ? 'partial' : 'complete', code: 'EXTERNAL_TRANSACTION_VERIFIED', activities, issues: unique, blockHash: evidence.blockHash.toLowerCase() };
}

function optionsChecked(options: ExternalAnalyticsOptions): { maxTransactions: number; maxWallets: number; startAt: number; overlap: number } {
  const maxTransactions = options.maxTransactions ?? 10; const maxWallets = options.maxWalletsPerTick ?? 2; const startAt = options.startAtUnix ?? 0; const overlap = options.overlapSeconds ?? 3600;
  if (!Number.isSafeInteger(maxTransactions) || maxTransactions < 1 || maxTransactions > 20 || !Number.isSafeInteger(maxWallets) || maxWallets < 1 || maxWallets > 10 || !count(startAt) || !count(overlap) || overlap > 86_400) throw new Error('EXTERNAL_ANALYTICS_CONFIG_INVALID');
  return { maxTransactions, maxWallets, startAt, overlap };
}

/** Durable discovery first, then bounded independent verification. Restart never
 * advances pagination without retaining every candidate from that page. */
export async function ingestExternalAnalytics(options: ExternalAnalyticsOptions): Promise<void> {
  const limits = optionsChecked(options); const now = options.now ?? (() => new Date());
  const time = now(); if (!Number.isFinite(time.getTime())) throw new Error('EXTERNAL_ANALYTICS_TIME_INVALID');
  const wallets = await options.wallets();
  if (!Array.isArray(wallets) || wallets.length > 1000 || wallets.some(row => !chain(row.chainId) || !ADDRESS.test(row.address)) || new Set(wallets.map(row => `${row.chainId}:${row.address.toLowerCase()}`)).size !== wallets.length) throw new Error('EXTERNAL_ANALYTICS_WALLETS_INVALID');
  const snapshot = options.store.snapshot();
  const rotations = latestEvent(snapshot.events, 'analytics_external_rotation')?.data;
  const offset = count(rotations?.walletOffset) ? rotations.walletOffset % Math.max(1, wallets.length) : 0;
  const selectedWallets = [...wallets.slice(offset), ...wallets.slice(0, offset)].slice(0, limits.maxWallets);
  for (const wallet of selectedWallets) {
    const scope = `${wallet.chainId}:${wallet.address.toLowerCase()}`;
    const previous = latestEvent(snapshot.events, CURSOR, event => event.data.scope === scope)?.data;
    const after = count(previous?.after) ? previous.after : limits.startAt;
    const before = count(previous?.before) && typeof previous?.next === 'string' ? previous.before : Math.floor(time.getTime() / 1000);
    const cursor = typeof previous?.next === 'string' ? previous.next : undefined;
    if (after >= before) continue;
    try {
      const page = await options.candidatePort.page({ chainId: wallet.chainId, wallet: wallet.address, after, before, ...(cursor ? { cursor } : {}) });
      if (!page || !Array.isArray(page.candidates) || page.candidates.length > 200 || page.candidates.some(row => !HASH.test(row.transactionHash)) || !['partial', 'unknown'].includes(page.coverage) || !CODE.test(page.code) || page.next !== undefined && (typeof page.next !== 'string' || page.next.length < 1 || page.next.length > 2048 || /[\u0000-\u001f]/.test(page.next) || page.next === cursor)) throw new Error('EXTERNAL_ANALYTICS_PAGE_INVALID');
      await options.store.transaction(state => {
        const known = new Set(state.events.map(event => event.id));
        for (const candidate of page.candidates) {
          const key = identity(wallet.chainId, candidate.transactionHash); const id = `external_candidate_${digest(key)}`;
          if (!known.has(id)) { state.events.push({ id, type: CANDIDATE, at: time.toISOString(), data: { chainId: wallet.chainId, transactionHash: candidate.transactionHash.toLowerCase(), key } }); known.add(id); }
        }
        const priorCursor = latestEvent(state.events, CURSOR, event => event.data.scope === scope);
        const data = { scope, after: page.next ? after : Math.max(limits.startAt, before - limits.overlap), before, ...(page.next ? { next: page.next } : {}), coverage: page.coverage, code: page.code, revision: Number(priorCursor?.data.revision ?? 0) + 1 };
        const id = `external_cursor_${digest({ data, previous: priorCursor?.id ?? null })}`;
        state.events.push({ id, type: CURSOR, at: time.toISOString(), data });
        const status = { scope, coverage: page.coverage, code: page.code };
        const prior = latestEvent(state.events, 'analytics_external_discovery_status', event => event.data.scope === scope);
        if (prior?.data.coverage !== status.coverage || prior?.data.code !== status.code) state.events.push({ id: `external_discovery_${digest({ status, prior: prior?.id ?? null })}`, type: 'analytics_external_discovery_status', at: time.toISOString(), data: { ...status, revision: Number(prior?.data.revision ?? 0) + 1 } });
      });
    } catch (error) {
      const code = safeCode(error); const status = { scope, coverage: 'unknown', code };
      await options.store.transaction(state => { const prior = latestEvent(state.events, 'analytics_external_discovery_status', event => event.data.scope === scope); if (prior?.data.coverage !== status.coverage || prior?.data.code !== status.code) state.events.push({ id: `external_discovery_${digest({ status, prior: prior?.id ?? null })}`, type: 'analytics_external_discovery_status', at: time.toISOString(), data: { ...status, revision: Number(prior?.data.revision ?? 0) + 1 } }); });
      try { options.record?.(code); } catch { /* reporting cannot prevent existing observations being rechecked */ }
    }
  }
  const state = options.store.snapshot();
  const candidates = state.events.filter(event => event.type === CANDIDATE && chain(event.data.chainId) && typeof event.data.transactionHash === 'string' && HASH.test(event.data.transactionHash)).map(event => ({ chainId: event.data.chainId as ExecutionChainId, hash: String(event.data.transactionHash) })).sort((a, b) => identity(a.chainId, a.hash).localeCompare(identity(b.chainId, b.hash)));
  const last = typeof rotations?.transactionKey === 'string' ? rotations.transactionKey : '';
  const index = candidates.findIndex(row => identity(row.chainId, row.hash) > last);
  const start = index < 0 ? 0 : index;
  const selected = [...candidates.slice(start), ...candidates.slice(0, start)].slice(0, limits.maxTransactions);
  const canonical = new Set(state.receipts.flatMap(receipt => { const attempt = state.attempts.find(item => item.id === receipt.transactionAttemptId); const run = state.runs.find(item => item.id === receipt.runId); const campaign = run && state.intents.find(item => item.id === run.intentId)?.campaignSnapshot; return attempt?.hash && campaign ? [identity(campaign.chainId, attempt.hash)] : []; }));
  for (const candidate of selected) {
    const key = identity(candidate.chainId, candidate.hash);
    let outcome: Outcome;
    try { const evidence = await (await options.chainPort(candidate.chainId)).observe(candidate.hash); validateExternalTransactionEvidence(evidence, candidate.chainId, candidate.hash, now()); outcome = activitiesFor(evidence, wallets, canonical); }
    catch (error) { const code = safeCode(error); outcome = { state: 'unavailable', coverage: 'unknown', code, activities: [], issues: [code] }; }
    await options.store.transaction(current => {
      const prior = observations(current.events).get(key); const payloadDigest = digest(outcome);
      if (prior?.payloadDigest === payloadDigest) return;
      const revision = (prior?.revision ?? 0) + 1;
      current.events.push({ id: `external_observation_${digest({ key, revision, payloadDigest })}`, type: OBSERVATION, at: now().toISOString(), data: { version: 1, key, revision, ...outcome, payloadDigest } });
    });
  }
  if (wallets.length || selected.length) await options.store.transaction(current => current.events.push({ id: `external_rotation_${digest({ count: current.events.length, time: now().toISOString() })}`, type: 'analytics_external_rotation', at: now().toISOString(), data: { walletOffset: (offset + selectedWallets.length) % Math.max(1, wallets.length), transactionKey: selected.length ? identity(selected.at(-1)!.chainId, selected.at(-1)!.hash) : last, revision: Number(latestEvent(current.events, 'analytics_external_rotation')?.data.revision ?? 0) + 1 } }));
}

/** Completion-driven read-only worker. stop drains writers before store closure. */
export function startExternalAnalyticsIngestion(options: ExternalAnalyticsOptions): { tick(): Promise<void>; stop(): Promise<void> } {
  optionsChecked(options);
  const interval = options.intervalMs ?? 300_000;
  if (!Number.isSafeInteger(interval) || interval < 60_000) throw new Error('EXTERNAL_ANALYTICS_INTERVAL_INVALID');
  let stopped = false; let running: Promise<void> | undefined; let timer: ReturnType<typeof setTimeout> | undefined;
  const record = (error: unknown): void => { try { options.record?.(safeCode(error)); } catch { /* diagnostics cannot alter scheduling */ } };
  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = ingestExternalAnalytics(options).catch(record);
    try { await running; } finally { running = undefined; }
  };
  const schedule = (delay: number): void => { if (!stopped) { timer = setTimeout(() => { void tick().finally(() => schedule(interval)); }, delay); timer.unref(); } };
  schedule(0);
  return { tick, async stop() { stopped = true; if (timer) clearTimeout(timer); await running; } };
}
