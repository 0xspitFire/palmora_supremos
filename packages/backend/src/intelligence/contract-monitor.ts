import { createHash } from 'node:crypto';
import { readEventSnapshot, type BackendStore } from '../store.js';
import type { EventRecord } from '../types.js';

/** Structural read-only engine boundary; this module has no signer or execution port. */
export interface ContractMonitorCandidate {
  version: 1; kind: 'mint' | 'deployment'; chainId: number; transactionHash: string;
  blockNumber: string; blockHash: string; logIndex?: number; contract?: string; wallet?: string; standard?: 'erc721' | 'erc1155';
}
export interface ContractObservation {
  version: 1; kind: 'mint' | 'deployment'; chainId: number; identity: string; contract: string;
  standard: 'erc721' | 'erc1155'; transactionHash: string; blockNumber: string; blockHash: string;
  blockTimestamp: string; observedAt: string; sender: string; wallet?: string;
  tokenIds: readonly string[]; quantities: readonly string[]; quantity: string;
  strategy: 'unsupported'; priceWei: null; stage: 'unknown'; factoryCoverage: 'not-observed';
}
export interface ContractMonitorContinuation {
  fromBlock: string; toBlock: string; watchlistDigest: string; phase: 'logs' | 'deployments';
  queryIndex: number; offset: number; deploymentBlockIndex: number; rangeEndHash?: string;
}
export interface ContractMonitorScan {
  fromBlock: string; toBlock: string; settledHead: string; candidates: ContractMonitorCandidate[];
  continuation?: ContractMonitorContinuation; partialReasons: string[]; deploymentBlocksInspected: string[];
  deploymentBlocksOmitted: string; factoryCoverage: 'not-observed'; callsUsed: number;
}
export interface ContractMonitorPort {
  beginTick(signal?: AbortSignal): void;
  scan(input: { fromBlock?: string; watched: readonly string[]; maxCandidates: number; continuation?: ContractMonitorContinuation }): Promise<ContractMonitorScan>;
  verify(candidate: ContractMonitorCandidate, watched: readonly string[]): Promise<{ status: 'verified'; observation: ContractObservation } | { status: 'rejected' | 'unavailable'; code: string }>;
  assertVerified(observation: ContractObservation): void;
}
const verified = new WeakSet<object>();
export function assertVerifiedContractObservation(observation: ContractObservation): void {
  if (!verified.has(observation)) throw new Error('CONTRACT_MONITOR_UNVERIFIED_OBSERVATION');
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const key = (candidate: ContractMonitorCandidate) => digest(`${candidate.chainId}:${candidate.transactionHash.toLowerCase()}:${candidate.kind === 'deployment' ? 'creation' : `${candidate.logIndex}:${candidate.standard}`}:${candidate.blockHash.toLowerCase()}`);
const safeCode = (value: unknown) => typeof value === 'string' && /^NFT_MONITOR_[A-Z_]{1,70}$/.test(value) ? value : 'NFT_MONITOR_UNAVAILABLE';
export interface ContractMonitorOptions {
  store: BackendStore; chainId: number; port: ContractMonitorPort;
  watched: () => readonly string[] | Promise<readonly string[]>;
  publish: (observation: ContractObservation) => Promise<void>;
  now?: () => Date; maxPending?: number; captureBatch?: number; maxVerificationAttempts?: number;
}
export interface ContractMonitorTick { status: 'ok' | 'partial' | 'idle'; pending: number; published: number; captured: number; reason?: string; scan?: ContractMonitorScan; }
/** Candidates and continuation are committed together, candidates first. Queue pressure pauses coverage; it never jumps the cursor. */
export class ContractMonitor {
  private busy = false;
  private readonly prefix: string;
  private readonly maxPending: number;
  private readonly captureBatch: number;
  private readonly attempts: number;
  constructor(private readonly options: ContractMonitorOptions) {
    this.prefix = `contract-monitor:${options.chainId}:`;
    this.maxPending = options.maxPending ?? 256; this.captureBatch = options.captureBatch ?? 32; this.attempts = options.maxVerificationAttempts ?? 5;
    if (!Number.isSafeInteger(options.chainId) || options.chainId < 1 || !Number.isSafeInteger(this.maxPending) || this.maxPending < 1 || this.maxPending > 1024 || !Number.isSafeInteger(this.captureBatch) || this.captureBatch < 1 || this.captureBatch > 128 || !Number.isSafeInteger(this.attempts) || this.attempts < 1 || this.attempts > 10) throw new Error('CONTRACT_MONITOR_CONFIG_INVALID');
  }
  async tick(signal?: AbortSignal): Promise<ContractMonitorTick> {
    if (this.busy) return { status: 'idle', pending: 0, published: 0, captured: 0, reason: 'TICK_IN_PROGRESS' };
    this.busy = true;
    const result: ContractMonitorTick = { status: 'ok', pending: 0, published: 0, captured: 0 };
    try {
      this.options.port.beginTick(signal);
      const watched = await this.options.watched();
      if (signal?.aborted) return { ...result, status: 'partial', reason: 'ABORTED' };
      let events = this.events();
      // Least-recently attempted first; one verification leaves budget for a full 137-wallet scan.
      const pending = this.pending(events).sort((a, b) => this.lastAttempt(events, a.id).localeCompare(this.lastAttempt(events, b.id)));
      const next = pending[0];
      if (next) {
        const candidate = next.data.candidate as unknown as ContractMonitorCandidate;
        const verification = await this.options.port.verify(candidate, watched);
        if (verification.status === 'verified') {
          this.options.port.assertVerified(verification.observation);
          const observation: ContractObservation = Object.freeze({ ...verification.observation, tokenIds: Object.freeze([...verification.observation.tokenIds]), quantities: Object.freeze([...verification.observation.quantities]) });
          verified.add(observation);
          await this.appendOnce({ id: `${next.id}:fact`, type: 'contract_observation_verified', at: observation.blockTimestamp, data: { chainId: this.options.chainId, candidateId: next.id, observation } });
          await this.options.publish(observation);
          await this.done(next.id, 'published'); result.published++;
        } else if (verification.status === 'rejected') await this.done(next.id, 'rejected', safeCode(verification.code));
        else if (!['NFT_MONITOR_CALL_BUDGET_EXHAUSTED', 'NFT_MONITOR_ABORTED'].includes(verification.code)) {
          const count = events.filter(event => event.type === 'contract_monitor_attempt' && event.data.candidateId === next.id).length + 1;
          await this.appendOnce({ id: `${next.id}:attempt:${count}`, type: 'contract_monitor_attempt', at: this.now(), data: { chainId: this.options.chainId, candidateId: next.id, code: safeCode(verification.code) } });
          if (count >= this.attempts) await this.done(next.id, 'unavailable', safeCode(verification.code));
          result.status = 'partial'; result.reason = safeCode(verification.code);
        }
      }
      events = this.events(); result.pending = this.pending(events).length;
      if (signal?.aborted) return { ...result, status: 'partial', reason: 'ABORTED' };
      if (result.pending >= this.maxPending) return { ...result, status: 'partial', reason: 'CANDIDATE_QUEUE_FULL' };
      const last = events.filter(event => event.type === 'contract_monitor_cursor').at(-1);
      const scan = await this.options.port.scan({ watched, maxCandidates: Math.min(this.captureBatch, this.maxPending - result.pending), ...(typeof last?.data.cursor === 'string' ? { fromBlock: (BigInt(last.data.cursor) + 1n).toString() } : {}), ...(last?.data.continuation ? { continuation: last.data.continuation as unknown as ContractMonitorContinuation } : {}) });
      result.scan = scan;
      if (scan.callsUsed > 64 || scan.candidates.length > Math.min(this.captureBatch, this.maxPending - result.pending) || scan.factoryCoverage !== 'not-observed') throw new Error('CONTRACT_MONITOR_PORT_INVALID');
      await this.options.store.transaction(state => {
        for (const candidate of scan.candidates) {
          if (candidate.chainId !== this.options.chainId) throw new Error('CONTRACT_MONITOR_CHAIN_MISMATCH');
          const id = this.prefix + key(candidate);
          if (!state.events.some(event => event.id === id)) { state.events.push({ id, type: 'contract_monitor_candidate', at: this.now(), data: { chainId: this.options.chainId, candidate } }); result.captured++; }
        }
        const cursor = scan.continuation || BigInt(scan.toBlock) < BigInt(scan.fromBlock) ? last?.data.cursor : scan.toBlock;
        state.events.push({ id: `${this.prefix}cursor:${state.events.length}`, type: 'contract_monitor_cursor', at: this.now(), data: { chainId: this.options.chainId, cursor, continuation: scan.continuation ?? null, fromBlock: scan.fromBlock, toBlock: scan.toBlock, settledHead: scan.settledHead, partialReasons: scan.partialReasons, deploymentBlocksInspected: scan.deploymentBlocksInspected, deploymentBlocksOmitted: scan.deploymentBlocksOmitted, factoryCoverage: scan.factoryCoverage, caughtUp: !scan.continuation && scan.toBlock === scan.settledHead } });
      });
      result.pending = this.pending(this.events()).length;
      if (scan.continuation || scan.partialReasons.length) result.status = 'partial';
      return result;
    } catch (error) { return { ...result, captured: 0, status: 'partial', reason: error instanceof Error ? safeCode(error.message) : 'NFT_MONITOR_UNAVAILABLE' }; }
    finally { this.busy = false; }
  }
  private now(): string { return (this.options.now?.() ?? new Date()).toISOString(); }
  private events(): EventRecord[] { return readEventSnapshot(this.options.store).filter(event => event.data.chainId === this.options.chainId && event.type.startsWith('contract_monitor_')); }
  private pending(events: EventRecord[]): EventRecord[] { const done = new Set(events.filter(event => event.type === 'contract_monitor_done').map(event => event.data.candidateId)); return events.filter(event => event.type === 'contract_monitor_candidate' && !done.has(event.id)); }
  private lastAttempt(events: EventRecord[], id: string): string { return events.filter(event => event.type === 'contract_monitor_attempt' && event.data.candidateId === id).at(-1)?.at ?? ''; }
  private appendOnce(event: EventRecord): Promise<void> { return this.options.store.transaction(state => { if (!state.events.some(row => row.id === event.id)) state.events.push(event); }); }
  private done(candidateId: string, status: string, code?: string): Promise<void> { return this.appendOnce({ id: `${candidateId}:done`, type: 'contract_monitor_done', at: this.now(), data: { chainId: this.options.chainId, candidateId, status, ...(code ? { code, coverageGap: status === 'unavailable' } : {}) } }); }
}
