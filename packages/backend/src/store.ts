import type { FundingFeeMetadata, FundingCostObservation } from './native-funding-analytics.js';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { BackendState, EventRecord, StoreCapabilities } from './types.js';

const emptyState = (): BackendState => ({ schemaVersion: 1, campaigns: [], runs: [], intents: [], attempts: [], receipts: [], reconciliations: [], reservations: [], events: [], notificationOutbox: [], chainEvidence: [], simulations: [], readiness: [], jobs: [], runtime: { startupState: 'Cold', blockingReasons: ['RECONCILIATION_REQUIRED'], dependencies: { engine: false, chain: false, backup: false, notifications: false } }, killed: false });
/** Fresh control-plane reads omit historical projections; mutations still use full atomic state. */
export type BackendControlSnapshot = Pick<BackendState, 'runtime' | 'killed' | 'reconciliations' | 'jobs'>;
export type BackendReadinessSnapshot = Pick<BackendState, 'runtime' | 'killed' | 'campaigns' | 'runs' | 'attempts' | 'reservations' | 'reconciliations' | 'jobs' | 'chainEvidence' | 'notificationOutbox'>;
export type HealthMonitorSnapshot = Pick<BackendState, 'notificationOutbox' | 'reservations'>;
export function readHealthMonitorSnapshot(store: BackendStore): HealthMonitorSnapshot {
  return store.healthMonitorSnapshot?.() ?? store.snapshot();
}
export function isDiscoveryJournalEvent(event: EventRecord): boolean {
  return event.type === 'discovery_skipped' || event.type === 'discovery_skip_notice' || event.type === 'discovery_skip_notice_plan'
    || (event.type === 'alert_health' && typeof event.data.dedupe === 'string');
}
export function readDiscoveryJournal(store: BackendStore): EventRecord[] {
  return store.discoveryJournal?.() ?? readEventSnapshot(store).filter(isDiscoveryJournalEvent);
}
export function readEventSnapshot(store: BackendStore): EventRecord[] { return store.eventSnapshot ? store.eventSnapshot() : store.snapshot().events; }
export function isReplicationTickEvent(event: EventRecord): boolean {
  return event.type === 'watched_wallet_mint' || event.type === 'replication_claim'
    || event.type === 'replication_decision' || event.type.startsWith('opportunity_');
}
export function readReplicationTickEvents(store: BackendStore): EventRecord[] {
  return store.replicationTickEvents ? store.replicationTickEvents() : readEventSnapshot(store).filter(isReplicationTickEvent);
}
export function isReadinessSweepEvent(event: EventRecord, chainId: number): boolean {
  return event.data.chainId === chainId && (event.type === 'calendar_entry' || event.type === 'readiness_sweep' || event.type.startsWith('opportunity_'));
}
export function readReadinessSweepEvents(store: BackendStore, chainId: number): EventRecord[] {
  return store.readinessSweepEvents?.(chainId) ?? readEventSnapshot(store).filter(event => isReadinessSweepEvent(event, chainId));
}
export function readRuntimeSnapshot(store: Pick<BackendStore, 'runtimeSnapshot' | 'snapshot'>): Pick<BackendState, 'runtime' | 'killed'> {
  return store.runtimeSnapshot?.() ?? store.snapshot();
}
export function readChainEvidenceSnapshot(store: BackendStore): BackendState['chainEvidence'] {
  return store.chainEvidenceSnapshot?.() ?? store.snapshot().chainEvidence;
}
export function readControlSnapshot(store: BackendStore): BackendControlSnapshot { return store.controlSnapshot ? store.controlSnapshot() : store.snapshot(); }
export interface BackendStore { fundingFeeForRunWallet?(runId: string, wallet: string): FundingFeeMetadata; fundingExpenseSnapshot?(): FundingCostObservation[]; open(): Promise<void>; capabilities(): StoreCapabilities; snapshot(): BackendState; readModelSnapshot?(): BackendState; controlSnapshot?(): BackendControlSnapshot; readinessSnapshot?(): BackendReadinessSnapshot; healthMonitorSnapshot?(): HealthMonitorSnapshot; discoveryJournal?(): EventRecord[]; hasIntelligenceAlert?(type: string, dedupe: string): boolean; eventSnapshot?(): EventRecord[]; readinessSweepEvents?(chainId: number): EventRecord[]; appendReadinessEvents?(events: readonly EventRecord[]): Promise<void>; runtimeSnapshot?(): Pick<BackendState, 'runtime' | 'killed'>; chainEvidenceSnapshot?(): BackendState['chainEvidence']; replicationTickEvents?(): EventRecord[]; appendDiscoveryEvents?(events: readonly EventRecord[]): Promise<void>; transaction<T>(mutate: (state: BackendState) => T): Promise<T>; commit(): Promise<void>; }
export class DurableStore implements BackendStore {
  private state: BackendState = emptyState();
  private writeQueue: Promise<void> = Promise.resolve();
  private transactionQueue: Promise<void> = Promise.resolve();
  constructor(private readonly file?: string) {}
  capabilities(): StoreCapabilities { return { durable: this.file !== undefined, atomicAcrossProcesses: false }; }
  async open(): Promise<void> {
    if (!this.file) return;
    try { const loaded = JSON.parse(await readFile(this.file, 'utf8'), (_, value) => typeof value === 'string' && /^\d+n$/.test(value) ? BigInt(value.slice(0, -1)) : value) as Partial<BackendState>; if (loaded.schemaVersion !== undefined && loaded.schemaVersion !== 1) throw new Error('UNSUPPORTED_STORE_SCHEMA'); const defaults = emptyState(); const defaultRuntime = defaults.runtime; this.state = { ...defaults, ...loaded, schemaVersion: 1, intents: loaded.intents ?? [], attempts: loaded.attempts ?? [], receipts: loaded.receipts ?? [], reconciliations: loaded.reconciliations ?? [], notificationOutbox: loaded.notificationOutbox ?? [], chainEvidence: loaded.chainEvidence ?? [], simulations: loaded.simulations ?? [], readiness: loaded.readiness ?? [], jobs: loaded.jobs ?? [], runtime: loaded.runtime ? { ...defaultRuntime, ...loaded.runtime, dependencies: { ...defaultRuntime.dependencies, ...loaded.runtime.dependencies } } : defaultRuntime }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  snapshot(): BackendState { return structuredClone(this.state); }
  eventSnapshot(): EventRecord[] { return structuredClone(this.state.events); }
  controlSnapshot(): BackendControlSnapshot { const { runtime, killed, reconciliations, jobs } = this.state; return structuredClone({ runtime, killed, reconciliations, jobs }); }
  replace(state: BackendState): void { this.state = state; }
  async transaction<T>(mutate: (state: BackendState) => T): Promise<T> {
    let result!: T;
    const operation = this.transactionQueue.then(async () => {
      const previous = this.snapshot(); const next = structuredClone(previous);
      result = mutate(next);
      this.state = next;
      try { await this.commit(); } catch (error) { this.state = previous; throw error; }
    });
    this.transactionQueue = operation.then(() => undefined, () => undefined);
    await operation;
    return result;
  }
  async commit(): Promise<void> {
    if (!this.file) return;
    const serialized = JSON.stringify(this.state, (_, value) => typeof value === 'bigint' ? `${value}n` : value);
    this.writeQueue = this.writeQueue.then(async () => { await mkdir(dirname(this.file!), { recursive: true }); const tmp = `${this.file}.tmp`; await writeFile(tmp, serialized, 'utf8'); await rename(tmp, this.file!); });
    await this.writeQueue;
  }
  appendEvent(event: EventRecord): Promise<void> { return this.transaction(state => { state.events.push(event); }); }
}
