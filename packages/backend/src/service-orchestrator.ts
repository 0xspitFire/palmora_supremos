import { access, readFile } from 'node:fs/promises';
import type { BackendApplication } from './application.js';
import type { ExecutionCoordinator } from './coordinator.js';
import type { BackendStore } from './store.js';
import { JsonJobStore, type ScheduledJob } from './job-store.js';
import { MetricsRegistry, type RedactedLogger } from './observability.js';
import { AlertManager } from './alerts.js';

export interface ScheduleInput {
  id: string;
  runId: string;
  wallets: readonly string[];
  executeAt: string;
  mode: 'dry-run' | 'live';
}
export interface OrchestratorOptions {
  jobs: JsonJobStore;
  schedulerIntervalMs?: number;
  reconciliationIntervalMs?: number;
  maxConcurrentJobs?: number;
  dryRunOnly?: boolean;
  killSwitchProbe?: () => boolean | Promise<boolean>;
  now?: () => Date;
  logger?: RedactedLogger;
  metrics?: MetricsRegistry;
  alerts?: AlertManager;
  backupStatusPath?: string;
}
export interface OrchestratorStatus {
  running: boolean;
  state: string;
  startupState: string;
  active: number;
  queued: number;
  blocked: number;
  failed: number;
  completed: number;
  blockingReasons: string[];
}

export async function pathKillSwitchProbe(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

/**
 * Supervised, durable scheduler. Jobs are persisted before execution and are
 * re-queued on restart. Execution remains behind the existing BackendApplication
 * and coordinator safety gates; this service does not sign or broadcast itself.
 */
export class OrchestratorService {
  private readonly schedulerIntervalMs: number;
  private readonly reconciliationIntervalMs: number;
  private readonly maxConcurrentJobs: number;
  private readonly now: () => Date;
  private readonly metrics: MetricsRegistry;
  private schedulerTimer?: NodeJS.Timeout;
  private reconciliationTimer?: NodeJS.Timeout;
  private running = false;
  private ticking = false;
  private jobsSnapshot: ScheduledJob[] = [];
  private lastBackupObservation?: string;

  public constructor(private readonly store: BackendStore, private readonly application: BackendApplication, private readonly coordinator: Pick<ExecutionCoordinator, 'start' | 'reconcile'> & Partial<Pick<ExecutionCoordinator, 'kill'>>, private readonly options: OrchestratorOptions) {
    this.schedulerIntervalMs = options.schedulerIntervalMs ?? 1_000;
    this.reconciliationIntervalMs = options.reconciliationIntervalMs ?? 30_000;
    this.maxConcurrentJobs = options.maxConcurrentJobs ?? 1;
    this.now = options.now ?? (() => new Date());
    this.metrics = options.metrics ?? new MetricsRegistry();
    if (!Number.isSafeInteger(this.schedulerIntervalMs) || this.schedulerIntervalMs < 100) throw new Error('SCHEDULER_INTERVAL_INVALID');
    if (!Number.isSafeInteger(this.reconciliationIntervalMs) || this.reconciliationIntervalMs < 100) throw new Error('RECONCILIATION_INTERVAL_INVALID');
    if (!Number.isSafeInteger(this.maxConcurrentJobs) || this.maxConcurrentJobs < 1) throw new Error('MAX_CONCURRENT_JOBS_INVALID');
  }

  public async schedule(input: ScheduleInput): Promise<ScheduledJob> {
    if (!input.id || !input.runId || input.wallets.length === 0) throw new Error('SCHEDULED_JOB_IDENTITY_INVALID');
    if (input.mode !== 'dry-run' || this.options.dryRunOnly !== true) throw new Error('PHASE2_LIVE_MODE_DISABLED');
    return this.options.jobs.put({ id: input.id, runId: input.runId, wallets: input.wallets, executeAt: input.executeAt, mode: input.mode });
  }

  public async start(options: { skipReconciliation?: boolean } = {}): Promise<void> {
    if (this.running) return;
    await this.options.jobs.open();
    await this.options.jobs.recoverRunning();
    this.jobsSnapshot = await this.options.jobs.list();
    await this.observeBackupStatus();
    this.recordReconciliationMetrics();
    this.running = true;
    this.metrics.recordRestart();
    if (!options.skipReconciliation) {
      try {
        await this.coordinator.start();
      } catch (error) {
        this.options.logger?.error({ error }, 'orchestrator_reconciliation_failed');
        await this.store.transaction((state) => { state.runtime = { ...state.runtime, startupState: 'Blocked', blockingReasons: [...new Set([...state.runtime.blockingReasons, 'RECONCILIATION_FAILED'])] }; });
      }
    }
    await this.tick();
    this.schedulerTimer = setInterval(() => { void this.tick(); }, this.schedulerIntervalMs);
    this.schedulerTimer.unref?.();
    this.reconciliationTimer = setInterval(() => { void this.reconcile(); }, this.reconciliationIntervalMs);
    this.reconciliationTimer.unref?.();
  }

  public async stop(): Promise<void> {
    this.running = false;
    if (this.schedulerTimer) clearInterval(this.schedulerTimer);
    if (this.reconciliationTimer) clearInterval(this.reconciliationTimer);
    this.schedulerTimer = undefined;
    this.reconciliationTimer = undefined;
  }

  public status(): OrchestratorStatus {
    const state = this.store.snapshot();
    const jobs = this.cachedJobs();
    return { running: this.running, state: this.running ? state.runtime.startupState : 'stopped', startupState: state.runtime.startupState, active: jobs.filter((job) => job.state === 'running').length, queued: jobs.filter((job) => job.state === 'scheduled').length, blocked: jobs.filter((job) => job.state === 'blocked' || job.state === 'cancelled').length, failed: jobs.filter((job) => job.state === 'failed').length, completed: jobs.filter((job) => job.state === 'succeeded').length, blockingReasons: [...state.runtime.blockingReasons] };
  }

  public async tick(): Promise<void> {
    if (!this.running || this.ticking) return;
    this.ticking = true;
    try {
      await this.observeBackupStatus();
      this.recordReconciliationMetrics();
      if (this.options.backupStatusPath && this.lastBackupObservation !== 'ok') {
        await this.store.transaction((state) => {
          state.runtime = { ...state.runtime, startupState: 'Blocked', blockingReasons: [...new Set([...state.runtime.blockingReasons, 'BACKUP_NOT_READY'])] };
        });
        return;
      }
      const killed = this.store.snapshot().killed || (this.options.killSwitchProbe ? await this.options.killSwitchProbe() : false);
      const capacity = Math.max(0, this.maxConcurrentJobs - this.cachedJobs().filter((job) => job.state === 'running').length);
      if (killed) {
        await this.store.transaction((state) => {
          state.runtime = { ...state.runtime, startupState: 'Blocked', blockingReasons: [...new Set([...state.runtime.blockingReasons, 'KILL_SWITCH_ENGAGED'])] };
        });
        try { await this.options.alerts?.kill('KILL_SWITCH_ENGAGED'); }
        catch (error) { this.options.logger?.warn({ error }, 'kill_switch_alert_delivery_failed'); }
        for (const job of await this.options.jobs.list()) if (job.state === 'scheduled' && job.mode === 'live') await this.options.jobs.update(job.id, { state: 'blocked', lastError: 'KILL_SWITCH_ENGAGED' });
        this.jobsSnapshot = await this.options.jobs.list();
        return;
      }
      if (this.store.snapshot().runtime.startupState !== 'Ready') return;
      if (capacity === 0) return;
      const claimed = await this.options.jobs.claimDue(this.now(), capacity);
      this.jobsSnapshot = await this.options.jobs.list();
      this.metrics.recordQueue(this.cachedJobs().filter((job) => job.state === 'scheduled').length, this.cachedJobs().filter((job) => job.state === 'running').length);
      await Promise.allSettled(claimed.map((job) => this.runJob(job)));
      this.jobsSnapshot = await this.options.jobs.list();
    } finally { this.ticking = false; }
  }

  private async reconcile(): Promise<void> {
    if (!this.running || this.store.snapshot().killed) return;
    try { await this.coordinator.reconcile(); }
    catch (error) { this.options.logger?.error({ error }, 'orchestrator_periodic_reconciliation_failed'); }
  }

  private async observeBackupStatus(): Promise<void> {
    if (!this.options.backupStatusPath) return;
    try {
      const status = JSON.parse(await readFile(this.options.backupStatusPath, 'utf8')) as { status?: string; recordedAt?: string };
      const recordedAt = status.recordedAt ? Date.parse(status.recordedAt) : Number.NaN;
      const fingerprint = `${status.status ?? 'unknown'}:${status.recordedAt ?? ''}`;
      if (fingerprint === this.lastBackupObservation) return;
      this.lastBackupObservation = fingerprint;
      this.metrics.recordBackup(status.status === 'ok' ? 'ok' : 'failed', Number.isFinite(recordedAt) ? recordedAt / 1_000 : undefined);
    } catch {
      if (this.lastBackupObservation === 'missing') return;
      this.lastBackupObservation = 'missing';
      this.metrics.recordBackup('failed');
    }
  }

  private recordReconciliationMetrics(): void {
    const reconciliations = this.store.snapshot().reconciliations;
    const latest = reconciliations.map((item) => Date.parse(item.observedAt)).filter(Number.isFinite).reduce((maximum, value) => Math.max(maximum, value), 0);
    this.metrics.recordReconciliation(latest === 0 ? Number.MAX_SAFE_INTEGER : Math.max(0, this.now().getTime() - latest), reconciliations.filter((item) => item.result === 'unknown').length);
  }

  private async runJob(job: ScheduledJob): Promise<void> {
    try {
      if (job.mode !== 'dry-run' || this.options.dryRunOnly !== true) throw new Error('PHASE2_LIVE_MODE_DISABLED');
      const result = await this.application.command('execute', { runId: job.runId, wallets: [...job.wallets], idempotencyKey: `scheduled:${job.id}` });
      const outcome = result.state === 'Failed' ? 'failed' : result.state === 'Aborted' ? 'blocked' : 'succeeded';
      await this.options.jobs.update(job.id, { state: outcome, ...(outcome !== 'succeeded' ? { lastError: outcome === 'failed' ? 'RUN_FAILED' : 'RUN_ABORTED' } : {}), completedAt: this.now().toISOString() });
    } catch (error) {
      await this.options.jobs.update(job.id, { state: 'blocked', lastError: error instanceof Error ? error.message : String(error), completedAt: this.now().toISOString() });
      this.options.logger?.error({ jobId: job.id, error }, 'scheduled_job_failed');
    }
    this.jobsSnapshot = await this.options.jobs.list();
  }

  private cachedJobs(): ScheduledJob[] {
    // Status is intentionally best-effort and side-effect free; the durable list
    // is read asynchronously by tick and HTTP callers only need a safe snapshot.
    return this.jobsSnapshot.map((job) => structuredClone(job));
  }
}

export { OrchestratorService as SupervisedOrchestrator };
