import { createHash } from 'node:crypto';
import type { SqliteDatabase } from '@mint-bot/database';
import type { BackendStore } from './store.js';
import type { EventRecord } from './types.js';

export interface FundingFeeMetadata { status: 'known' | 'unknown'; feeWei?: bigint; principalWei?: bigint; reference: string; operationReferences?: readonly string[]; }
export interface FundingCostObservation extends FundingFeeMetadata { operationId: string; holdId: string; campaignId: string; runId?: string; chainId: number; wallet: string; }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value, (_k, v: unknown) => typeof v === 'bigint' ? v.toString() : v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))) : v)).digest('hex');
interface Row { id: string; parent_hold_id: string; campaign_id: string; bound_run_id: string | null; chain_id: number; recipient: string; state: string; transaction_hash: string | null; actual_principal_wei: string | null; actual_fee_wei: string | null; settled_at: string | null; receipt_json: string | null; }
const exists = (db: SqliteDatabase, name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
function cost(row: Row): FundingFeeMetadata {
  const reference = `funding:${hash(row)}`;
  const unknown: FundingFeeMetadata = { status: 'unknown', reference };
  if (row.state === 'released' && !row.transaction_hash && row.actual_principal_wei === null && row.actual_fee_wei === null && !row.receipt_json && !row.settled_at) return { status: 'known', feeWei: 0n, principalWei: 0n, reference };
  if (row.state !== 'settled' || !/^0x[0-9a-f]{64}$/i.test(row.transaction_hash ?? '') || !/^\d+$/.test(row.actual_fee_wei ?? '') || !/^\d+$/.test(row.actual_principal_wei ?? '') || !Number.isFinite(Date.parse(row.settled_at ?? ''))) return unknown;
  try {
    const proof = JSON.parse(row.receipt_json ?? '', (_k, v: unknown) => v && typeof v === 'object' && Object.keys(v).length === 1 && 'wei' in v ? BigInt((v as {wei: string}).wei) : v) as { observations?: Array<{ readerHost: string; blockHash: string; robinhoodFinality?: string; transactionHash: string; chainId: number; to: string; success: boolean; finalityStage: string; finalityEvidenceReference: string; gasUsed: bigint; effectiveGasPrice: bigint; l1DataFeeWei: bigint; operatorFeeWei: bigint; valueWei: bigint }> };
    if (!proof.observations || proof.observations.length !== 2 || typeof proof.observations[0]?.readerHost !== 'string' || typeof proof.observations[1]?.readerHost !== 'string' || proof.observations[0].readerHost.toLowerCase().replace(/\.$/,'') === proof.observations[1].readerHost.toLowerCase().replace(/\.$/,'') || proof.observations[0].blockHash !== proof.observations[1].blockHash || proof.observations.some(p => p.transactionHash.toLowerCase() !== row.transaction_hash!.toLowerCase() || p.chainId !== row.chain_id || p.to.toLowerCase() !== row.recipient.toLowerCase() || typeof p.success !== 'boolean' || p.finalityStage !== 'ethereum_final' || row.chain_id === 4663 && p.robinhoodFinality !== 'final' || !p.finalityEvidenceReference || [p.gasUsed,p.effectiveGasPrice,p.l1DataFeeWei,p.operatorFeeWei,p.valueWei].some(n => typeof n !== 'bigint' || n < 0n) || p.gasUsed * p.effectiveGasPrice + p.l1DataFeeWei + p.operatorFeeWei !== BigInt(row.actual_fee_wei!) || (p.success ? p.valueWei : 0n) !== BigInt(row.actual_principal_wei!))) return unknown;
    return { status: 'known', feeWei: BigInt(row.actual_fee_wei!), principalWei: BigInt(row.actual_principal_wei!), reference };
  } catch { return unknown; }
}
/** Read-only projection. No admission, signing, reconciliation or chain calls. */
export function fundingExpenseSnapshot(db: SqliteDatabase): FundingCostObservation[] {
  if (!exists(db, 'native_funding') || !exists(db, 'mint_funding_hold')) return [];
  const rows = db.prepare('SELECT f.*,h.campaign_id,h.bound_run_id FROM native_funding f JOIN mint_funding_hold h ON h.hold_id=f.parent_hold_id AND h.chain_id=f.chain_id AND h.wallet_address=f.recipient ORDER BY f.id').all() as Row[];
  return rows.map(row => ({ ...cost(row), operationId: row.id, holdId: row.parent_hold_id, campaignId: row.campaign_id, ...(row.bound_run_id ? { runId: row.bound_run_id } : {}), chainId: row.chain_id, wallet: row.recipient }));
}
export function fundingFeeForRunWallet(db: SqliteDatabase, runId: string, wallet: string): FundingFeeMetadata {
  if (!exists(db, 'mint_funding_hold')) return { status: 'known', feeWei: 0n, principalWei: 0n, reference: `funding:none:${hash({runId,wallet:wallet.toLowerCase()})}` };
  const holds = db.prepare('SELECT hold_id,chain_id FROM mint_funding_hold WHERE bound_run_id=? AND wallet_address=?').all(runId, wallet.toLowerCase()) as Array<{hold_id:string;chain_id:number}>;
  const reference = `funding:${hash({runId,wallet:wallet.toLowerCase(),holds})}`;
  if (holds.length === 0) return {status:'known',feeWei:0n,principalWei:0n,reference};
  if (holds.length !== 1 || !exists(db,'native_funding')) return {status:'unknown',reference};
  const rows = fundingExpenseSnapshot(db).filter(row => row.holdId === holds[0]!.hold_id && row.wallet.toLowerCase() === wallet.toLowerCase() && row.chainId === holds[0]!.chain_id);
  if (rows.some(row => row.status !== 'known')) return {status:'unknown',reference:`funding:${hash(rows)}`,operationReferences:rows.map(row=>row.reference).sort()};
  return {status:'known',feeWei:rows.reduce((n,r)=>n+r.feeWei!,0n),principalWei:rows.reduce((n,r)=>n+r.principalWei!,0n),reference:`funding:${hash({holds,rows})}`,operationReferences:rows.map(row=>row.reference).sort()};
}
export function fundingCostEvents(events: readonly EventRecord[], rows: readonly FundingCostObservation[], at = new Date()): EventRecord[] {
  const added: EventRecord[] = [];
  for (const row of rows) {
    const data = JSON.parse(JSON.stringify(row, (_k,v:unknown)=>typeof v==='bigint'?v.toString():v)) as Record<string,unknown>;
    const payloadDigest=hash(data);
    const prior=events.filter(event=>event.type==='analytics_funding_cost' && event.data.operationId===row.operationId).sort((a,b)=>Number(b.data.revision)-Number(a.data.revision))[0];
    if(prior?.data.payloadDigest===payloadDigest) continue;
    const revision=Number(prior?.data.revision??0)+1;
    if(!Number.isSafeInteger(revision)) throw new Error('FUNDING_ANALYTICS_REVISION_EXHAUSTED');
    added.push({id:`funding_cost_${hash({operationId:row.operationId,revision,payloadDigest})}`,type:'analytics_funding_cost',at:at.toISOString(),data:{...data,revision,payloadDigest}});
  }
  return added;
}
export async function captureFundingCosts(store: BackendStore): Promise<void> {
  if (!store.fundingExpenseSnapshot) return;
  await store.transaction(state => { state.events.push(...fundingCostEvents(state.events, store.fundingExpenseSnapshot!())); });
}
/** Latest valid per-operation revisions only; unrelated operations never contaminate another run. */
export function latestFundingCostObservations(events: readonly EventRecord[]): Array<Record<string, unknown>> {
  const latest = new Map<string, Record<string, unknown>>();
  for (const event of events) if (event.type === 'analytics_funding_cost' && typeof event.data.operationId === 'string' && Number.isSafeInteger(event.data.revision) && Number(event.data.revision) > 0) {
    const {revision: _revision, payloadDigest: _digest, ...payload} = event.data;
    if (hash(payload) !== event.data.payloadDigest) continue;
    const prior = latest.get(event.data.operationId);
    if (!prior || Number(event.data.revision) > Number(prior.revision)) latest.set(event.data.operationId, event.data);
  }
  return [...latest.values()];
}
/** Funding principal is an internal transfer; allocated gas is already in acquisition basis. */
export function fundingCostSummary(events: readonly EventRecord[], allocations: readonly {runId:string;wallet:string;status:string;feeWei?:string}[] = []) {
  const latest = new Map<string,Record<string,unknown>>();
  for (const event of events) if(event.type==='analytics_funding_cost' && typeof event.data.operationId==='string' && Number.isSafeInteger(event.data.revision) && Number(event.data.revision)>0) { const prior=latest.get(event.data.operationId); const {revision:_revision,payloadDigest:_digest,...payload}=event.data; if(hash(payload)===event.data.payloadDigest && (!prior || Number(event.data.revision)>Number(prior.revision))) latest.set(event.data.operationId,event.data); }
  let principalWei=0n,gasExpenseWei=0n,unknownOperations=0;
  for(const row of latest.values()) { if(row.status!=='known' || typeof row.feeWei!=='string' || !/^\d+$/.test(row.feeWei) || typeof row.principalWei!=='string' || !/^\d+$/.test(row.principalWei)) {unknownOperations++;continue;} principalWei+=BigInt(row.principalWei);gasExpenseWei+=BigInt(row.feeWei); }
  const groups = new Map<string,bigint>();
  for (const row of latest.values()) if (row.status === 'known' && typeof row.runId === 'string' && typeof row.wallet === 'string' && typeof row.feeWei === 'string' && /^\d+$/.test(row.feeWei)) { const key=`${row.runId}:${row.wallet.toLowerCase()}`; groups.set(key,(groups.get(key)??0n)+BigInt(row.feeWei)); }
  const counted = new Set<string>(); let allocatedGasWei=0n;
  for (const row of allocations) { const key=`${row.runId}:${row.wallet.toLowerCase()}`; const actual=groups.get(key); if (!counted.has(key) && row.status==='known' && typeof row.feeWei==='string' && /^\d+$/.test(row.feeWei) && actual===BigInt(row.feeWei)) { allocatedGasWei+=actual;counted.add(key); } }
  return {principalWei,gasExpenseWei,allocatedGasWei,unallocatedGasWei:gasExpenseWei-allocatedGasWei,unknownOperations,principalIsExpense:false as const,allocatedGasAlreadyInAcquisitionBasis:true as const};
}
