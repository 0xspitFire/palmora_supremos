import { createHash } from 'node:crypto';
import type { AnalyticsActivity } from './analytics.js';
import type { BackendStore } from './store.js';
import type { BackendState, EventRecord, ExecutionChainId } from './types.js';

export interface AnalyticsChainLog { address: string; topics: readonly string[]; data: string; logIndex: number; transactionHash: string; blockNumber: bigint; blockHash: string; removed?: boolean; }
export interface AnalyticsChainReceipt { transactionHash: string; from: string; to: string | null; status: 'success' | 'reverted'; blockNumber: bigint; blockHash: string; transactionIndex: number; logs: readonly AnalyticsChainLog[]; }
export interface AnalyticsChainTransaction { hash: string; from: string; to: string | null; value: bigint; blockNumber: bigint | null; blockHash: string | null; }
/** Composition supplies the reviewed strategy target. There is no network, signer or mutating RPC in this port. */
export interface CanonicalAnalyticsPort {
  readonly expectedTarget: string;
  chainId(): Promise<number>;
  transaction(hash: string): Promise<AnalyticsChainTransaction | null>;
  receipt(hash: string): Promise<AnalyticsChainReceipt | null>;
  block(number: bigint): Promise<{ number: bigint; hash: string | null; timestamp: bigint } | null>;
}
const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO_TOPIC = `0x${'0'.repeat(64)}`;
const OBSERVATION = 'analytics_canonical_observation';
const CURSOR = 'analytics_ingestion_cursor';
const same = (a: string | null | undefined, b: string | null | undefined) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const json = (value: unknown) => JSON.stringify(value, (_key, entry: unknown) => typeof entry === 'bigint' ? entry.toString() : entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry);
const digest = (value: unknown) => createHash('sha256').update(json(value)).digest('hex');
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,180}$/.test(value);

function canonicalSource(state: BackendState, executionId: string) {
  const receipt = state.receipts.filter(row => row.executionId === executionId).sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt) || b.id.localeCompare(a.id))[0];
  const attempt = receipt && state.attempts.find(row => row.id === receipt.transactionAttemptId && row.executionId === executionId && row.runId === receipt.runId);
  const run = receipt && state.runs.find(row => row.id === receipt.runId && row.mode === 'live');
  const intent = run && state.intents.find(row => row.id === run.intentId && row.runId === run.id && row.campaignId === run.campaignId);
  const campaign = intent?.campaignSnapshot;
  const reservations = run && attempt ? state.reservations.filter(row => row.runId === run.id && row.campaignId === campaign?.id && same(row.wallet, attempt.wallet)) : [];
  const settlement = reservations.length === 1 && reservations[0]!.status === 'settled' ? reservations[0] : undefined;
  const fingerprint = digest({ receipt, attempt: attempt && { id: attempt.id, hash: attempt.hash, wallet: attempt.wallet, runId: attempt.runId, executionId: attempt.executionId }, run: run && { id: run.id, intentId: run.intentId, campaignId: run.campaignId, mode: run.mode }, campaign, reservations });
  return { receipt, attempt, run, campaign, settlement, fingerprint };
}
type ObservationState = 'confirmed' | 'reorged' | 'unavailable';
interface Observation { executionId: string; revision: number; state: ObservationState; code: string; sourceFingerprint: string; payloadDigest: string; activities: AnalyticsActivity[]; }
function observations(events: readonly EventRecord[]): Map<string, Observation> {
  const result = new Map<string, Observation>();
  for (const event of events) {
    if (event.type !== OBSERVATION || event.data.version !== 1) continue;
    const row = event.data;
    if (!validId(row.executionId) || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1 || !['confirmed', 'reorged', 'unavailable'].includes(String(row.state)) || typeof row.code !== 'string' || !/^[A-Z][A-Z0-9_]{2,90}$/.test(row.code) || typeof row.sourceFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(row.sourceFingerprint) || typeof row.payloadDigest !== 'string' || !Array.isArray(row.activities)) continue;
    const payload = { state: row.state, code: row.code, sourceFingerprint: row.sourceFingerprint, activities: row.activities };
    if (digest(payload) !== row.payloadDigest) continue;
    const prior = result.get(row.executionId);
    if (!prior || Number(row.revision) > prior.revision) result.set(row.executionId, { ...payload, executionId: row.executionId, revision: Number(row.revision), payloadDigest: row.payloadDigest } as Observation);
  }
  return result;
}
/** Historical acquisitions only. These facts do not assert complete holdings, sale history or current ownership. */
export function readCanonicalAnalyticsActivities(events: readonly EventRecord[]) {
  const latest = [...observations(events).values()];
  return {
    activities: latest.flatMap(row => row.state === 'unavailable' ? [] : row.activities.map(activity => ({ ...activity, status: row.state === 'reorged' ? 'reorged' as const : 'confirmed' as const }))),
    coverage: { executions: latest.length, confirmed: latest.filter(row => row.state === 'confirmed').length, reorged: latest.filter(row => row.state === 'reorged').length, unavailable: latest.filter(row => row.state === 'unavailable').length, scope: 'canonical-finalized-mints-only' as const, externalTransfersAndSalesComplete: false as const },
  };
}

async function inspect(source: ReturnType<typeof canonicalSource>, port: CanonicalAnalyticsPort, state: BackendState, now: Date): Promise<{ state: ObservationState; code: string; activities: AnalyticsActivity[] }> {
  const fail = (code: string, status: ObservationState = 'unavailable') => ({ state: status, code, activities: [] as AnalyticsActivity[] });
  const { receipt: c, attempt, run, campaign, settlement } = source;
  if (c?.state === 'Reorged') return fail('CANONICAL_RECEIPT_REORGED', 'reorged');
  if (!c || !attempt || !run || !campaign || !settlement || c.state !== 'Confirmed' || ![1, 8453, 4663].includes(campaign.chainId) || campaign.chainId !== 1 && c.finalityStage !== 'ethereum_final' && c.robinhoodFinality !== 'final') return fail('CANONICAL_MINT_NOT_FINAL');
  if (!attempt.hash || !HASH.test(attempt.hash) || !ADDRESS.test(attempt.wallet) || !ADDRESS.test(campaign.contract) || !Number.isSafeInteger(campaign.quantity) || campaign.quantity < 1 || campaign.quantity > 15 || c.blockNumber === undefined || c.blockNumber < 0n || !c.blockHash || !HASH.test(c.blockHash) || c.actualSpendWei === undefined || c.actualSpendWei < 0n || settlement.actualAmountWei !== c.actualSpendWei) return fail('CANONICAL_ACCOUNTING_INCOMPLETE');
  if (!ADDRESS.test(port.expectedTarget) || await port.chainId() !== campaign.chainId) return fail('ANALYTICS_CHAIN_MISMATCH');
  const block = await port.block(c.blockNumber);
  if (!block?.hash || block.number !== c.blockNumber || !HASH.test(block.hash)) return fail('ANALYTICS_BLOCK_UNAVAILABLE');
  if (!same(block.hash, c.blockHash)) return fail('ANALYTICS_BLOCK_REORGED', 'reorged');
  const [tx, receipt] = await Promise.all([port.transaction(attempt.hash), port.receipt(attempt.hash)]);
  if (!tx || !receipt) return fail('ANALYTICS_RECEIPT_UNAVAILABLE');
  const mintValue = campaign.mintPriceWei * BigInt(campaign.quantity);
  if (mintValue < 0n || c.actualSpendWei < mintValue || !same(tx.hash, attempt.hash) || !same(receipt.transactionHash, attempt.hash) || !same(tx.from, attempt.wallet) || !same(receipt.from, attempt.wallet) || !same(tx.to, port.expectedTarget) || !same(receipt.to, port.expectedTarget) || tx.value !== mintValue || tx.blockNumber !== c.blockNumber || receipt.blockNumber !== c.blockNumber || !same(tx.blockHash, c.blockHash) || !same(receipt.blockHash, c.blockHash) || receipt.status !== 'success' || !Number.isSafeInteger(receipt.transactionIndex) || receipt.transactionIndex < 0 || !Array.isArray(receipt.logs) || receipt.logs.length > 10_000) return fail('ANALYTICS_RECEIPT_BINDING_INVALID');
  const timestampMs = Number(block.timestamp) * 1000;
  if (!Number.isSafeInteger(timestampMs) || timestampMs < 0 || timestampMs > now.getTime() || Number.isNaN(new Date(timestampMs).getTime())) return fail('ANALYTICS_BLOCK_TIME_INVALID');
  const minted: Array<{ tokenId: string; logIndex: number }> = [];
  for (const log of receipt.logs as readonly AnalyticsChainLog[]) {
    if (!same(log.address, campaign.contract) || !same(log.topics[0], TRANSFER)) continue;
    if (log.topics.length !== 4 || !log.topics.every(topic => HASH.test(topic)) || log.data !== '0x' || log.removed === true || !same(log.transactionHash, attempt.hash) || log.blockNumber !== c.blockNumber || !same(log.blockHash, c.blockHash) || !Number.isSafeInteger(log.logIndex) || log.logIndex < 0) return fail('ANALYTICS_MINT_LOG_INVALID');
    if (!same(log.topics[1], ZERO_TOPIC) || !same(log.topics[2], `0x${'0'.repeat(24)}${attempt.wallet.slice(2)}`)) continue;
    minted.push({ tokenId: BigInt(log.topics[3]!).toString(), logIndex: log.logIndex });
  }
  if (minted.length !== campaign.quantity || new Set(minted.map(log => log.tokenId)).size !== minted.length || new Set(minted.map(log => log.logIndex)).size !== minted.length) return fail('ANALYTICS_MINT_QUANTITY_UNPROVEN');
  minted.sort((a, b) => a.logIndex - b.logIndex);
  const prepared = state.events.find(event => event.type === 'replication_prepared' && event.data.campaignId === campaign.id);
  const sourceWallet = typeof prepared?.data.sourceWallet === 'string' && ADDRESS.test(prepared.data.sourceWallet) ? prepared.data.sourceWallet.toLowerCase() : undefined;
  let costLeft = mintValue; let gasLeft = c.actualSpendWei - mintValue;
  const activities: AnalyticsActivity[] = minted.map((log, index) => {
    const remaining = BigInt(minted.length - index);
    const cost = costLeft / remaining; const gas = gasLeft / remaining;
    costLeft -= cost; gasLeft -= gas;
    return { id: `canonical:${digest({ executionId: c.executionId, hash: attempt.hash, logIndex: log.logIndex })}`, sourceReference: `canonical:${digest({ receiptId: c.id, blockHash: c.blockHash })}`, kind: 'acquisition', chainId: campaign.chainId as ExecutionChainId, collection: campaign.contract.toLowerCase(), tokenId: log.tokenId, quantity: '1', wallet: attempt.wallet.toLowerCase(), status: 'confirmed', transactionHash: attempt.hash!.toLowerCase(), blockHash: c.blockHash!.toLowerCase(), blockNumber: c.blockNumber!.toString(), transactionIndex: receipt.transactionIndex, logIndex: log.logIndex, at: new Date(timestampMs).toISOString(), costWei: cost.toString(), gasWei: gas.toString(), campaignId: campaign.id, ...(sourceWallet ? { sourceWallet } : {}), mintType: campaign.strategy === 'seadrop-v1-public' ? 'public' : campaign.strategy === 'seadrop-v1-allowlist' ? 'allowlist' : 'other' };
  });
  return { state: 'confirmed', code: 'CANONICAL_MINT_VERIFIED', activities };
}

/** At most20 executions per pass, round-robin. No admission, reconciliation, signing or chain writes. */
export async function ingestCanonicalAnalytics(input: { store: BackendStore; port(chainId: ExecutionChainId): Promise<CanonicalAnalyticsPort>; now?: () => Date; maxReceipts?: number }) {
  const now = input.now ?? (() => new Date());
  const limit = input.maxReceipts ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20 || !Number.isFinite(now().getTime())) throw new Error('ANALYTICS_INGESTION_CONFIG_INVALID');
  const snapshot = input.store.snapshot();
  const previous = observations(snapshot.events);
  const executionIds = [...new Set([...snapshot.receipts.filter(row => row.state === 'Confirmed' || row.state === 'Reorged').map(row => row.executionId), ...previous.keys()])].filter(validId).sort();
  const lastCursor = snapshot.events.filter(event => event.type === CURSOR && typeof event.data.executionId === 'string').at(-1)?.data.executionId;
  const after = typeof lastCursor === 'string' ? executionIds.findIndex(id => id > lastCursor) : 0;
  const start = after < 0 ? 0 : after;
  const selected = [...executionIds.slice(start), ...executionIds.slice(0, start)].slice(0, limit);
  const result = { checked: 0, written: 0, confirmed: 0, reorged: 0, unavailable: 0, remaining: Math.max(0, executionIds.length - selected.length) };
  for (const executionId of selected) {
    const source = canonicalSource(snapshot, executionId);
    let outcome: Awaited<ReturnType<typeof inspect>>;
    try { outcome = await inspect(source, await input.port(source.campaign?.chainId ?? 1), snapshot, now()); }
    catch { outcome = { state: 'unavailable', code: 'ANALYTICS_OBSERVATION_UNAVAILABLE', activities: [] }; }
    await input.store.transaction(state => {
      const current = canonicalSource(state, executionId);
      if (current.fingerprint !== source.fingerprint) outcome = { state: 'unavailable', code: 'CANONICAL_SOURCE_CHANGED_DURING_READ', activities: [] };
      const prior = observations(state.events).get(executionId);
      if (outcome.state === 'reorged' && outcome.activities.length === 0) outcome.activities = prior?.activities.map(activity => ({ ...activity, status: 'reorged' })) ?? [];
      const payload = { ...outcome, sourceFingerprint: current.fingerprint };
      const payloadDigest = digest(payload);
      if (prior?.payloadDigest !== payloadDigest) {
        const revision = (prior?.revision ?? 0) + 1;
        if (!Number.isSafeInteger(revision)) throw new Error('ANALYTICS_REVISION_EXHAUSTED');
        state.events.push({ id: `analytics_ingestion_${digest({ executionId, revision, payloadDigest })}`, type: OBSERVATION, at: now().toISOString(), data: { version: 1, executionId, revision, ...payload, payloadDigest } });
        result.written += 1;
      }
      result.checked += 1; result[outcome.state] += 1;
    });
  }
  const next = selected.at(-1);
  if (next && next !== lastCursor) await input.store.transaction(state => state.events.push({ id: `analytics_cursor_${digest({ next, at: now().toISOString(), count: state.events.length })}`, type: CURSOR, at: now().toISOString(), data: { executionId: next } }));
  return result;
}
