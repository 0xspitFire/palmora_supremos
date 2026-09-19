import { createHash, randomUUID } from 'node:crypto';
import type { BackendStore } from './store.js';
import { ExecutionCoordinator } from './coordinator.js';
import { normalizeError } from './errors.js';
import { NotificationDispatcher } from './notifications.js';
import { PHASE2_DEFAULTS } from './phase2-defaults.js';
import type { BackendState, EventRecord, JobKind, JobState, RunRecord, ScheduledJobRecord } from './types.js';

export interface ScheduleJobInput {
  kind?: JobKind;
  runId?: string;
  campaignId?: string;
  wallets?: readonly string[];
  /** Chain opening/target time. `openingAt` is accepted as a readable alias. */
  targetAt?: string | Date;
  openingAt?: string | Date;
  /** Start the job this many milliseconds before target chain time. */
  tMinusMs?: number;
  /** Chain time minus local wall time. */
  chainTimeOffsetMs?: number;
  idempotencyKey: string;
  requestDigest?: string;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
}

export interface ScheduleExecutionInput extends Omit<ScheduleJobInput, 'kind' | 'idempotencyKey'> {
  idempotencyKey?: string;
}

export interface OrchestratorOptions {
  maxConcurrency?: number;
  jobLeaseMs?: number;
  pollIntervalMs?: number;
  retryDelayMs?: number;
  ownerId?: string;
  chainTimeOffsetMs?: number;
  chainTime?: () => Date | Promise<Date>;
  now?: () => Date;
  notifications?: NotificationDispatcher;
}

export interface OrchestratorStatus {
  running: boolean;
  startupState: BackendState['runtime']['startupState'];
  active: number;
  queued: number;
  blocked: number;
  failed: number;
  completed: number;
  blockingReasons: string[];
}

export interface TickResult {
  claimed: string[];
  completed: string[];
  failed: string[];
  blocked: string[];
}

const SAFE_PAYLOAD_KEYS = new Set(['runId', 'campaignId', 'wallets', 'sourceEventId', 'text', 'reason', 'requestDigest', 'mode', 'targetAt', 'tMinusMs']);
const SENSITIVE_KEY = /(?:private[_-]?key|mnemonic|seed(?:[_-]?phrase)?|passphrase|password|api[_-]?key|access[_-]?token|secret[_-]?key|auth[_-]?token|authorization|calldata|raw(?:[_-]?transaction)?|provider[_-]?payload)/i;

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item)).digest('hex');
}

function iso(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('INVALID_SCHEDULE_TIME');
  return date.toISOString();
}

function assertSafePayload(value: unknown, path = 'payload'): void {
  if (value === undefined) return;
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return;
  if (typeof value === 'bigint') throw new Error('JOB_PAYLOAD_MUST_BE_JSON_SAFE');
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) assertSafePayload(item, `${path}[${index}]`);
    return;
  }
  if (typeof value !== 'object') throw new Error('JOB_PAYLOAD_MUST_BE_JSON_SAFE');
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) throw new Error('JOB_PAYLOAD_SECRET_REJECTED');
    assertSafePayload(item, `${path}.${key}`);
  }
}

function safePayload(value: Record<string, unknown> | undefined): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value ?? {})) {
    if (!SAFE_PAYLOAD_KEYS.has(key)) continue;
    result[key] = key === 'wallets' && Array.isArray(item) ? item.map((wallet) => String(wallet).toLowerCase()) : item;
  }
  assertSafePayload(result);
  return structuredClone(result);
}

function requestDigest(input: ScheduleJobInput, runId: string | undefined, targetAt: string | undefined, tMinusMs: number, offset: number): string {
  return digest({ kind: input.kind ?? 'execute', runId, campaignId: input.campaignId, wallets: [...(input.wallets ?? [])].map((wallet) => wallet.toLowerCase()).sort(), targetAt: targetAt ?? null, tMinusMs, offset, payload: safePayload(input.payload) });
}

function runHasSubmittedWork(state: BackendState, runId: string | undefined): boolean {
  return Boolean(runId && state.attempts.some((attempt) => attempt.runId === runId && attempt.hash));
}

function isTerminalRun(run: RunRecord | undefined): boolean {
  return Boolean(run && ['Completed', 'Failed', 'Aborted', 'Cancelled'].includes(run.state));
}

export class Orchestrator {
  private readonly now: () => Date;
  private readonly options: Required<Pick<OrchestratorOptions, 'maxConcurrency' | 'jobLeaseMs' | 'pollIntervalMs' | 'retryDelayMs' | 'ownerId'>> & OrchestratorOptions;
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  private started = false;

  public constructor(private readonly store: BackendStore, private readonly coordinator: ExecutionCoordinator, options: OrchestratorOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.options = {
      ...options,
      maxConcurrency: options.maxConcurrency ?? PHASE2_DEFAULTS.maxConcurrency,
      jobLeaseMs: options.jobLeaseMs ?? PHASE2_DEFAULTS.jobLeaseMs,
      pollIntervalMs: options.pollIntervalMs ?? PHASE2_DEFAULTS.schedulerPollMs,
      retryDelayMs: options.retryDelayMs ?? 1_000,
      ownerId: options.ownerId ?? `orchestrator_${randomUUID()}`,
    };
    if (!Number.isInteger(this.options.maxConcurrency) || this.options.maxConcurrency < 1) throw new Error('INVALID_MAX_CONCURRENCY');
    if (!Number.isInteger(this.options.jobLeaseMs) || this.options.jobLeaseMs < 1) throw new Error('INVALID_JOB_LEASE');
  }

  /** Persist a job before any scheduler or engine side effect. */
  public async schedule(input: ScheduleJobInput): Promise<ScheduledJobRecord> {
    if (!input.idempotencyKey) throw new Error('JOB_IDEMPOTENCY_KEY_REQUIRED');
    assertSafePayload(input.payload);
    if (input.chainTimeOffsetMs === undefined && this.options.chainTime) await this.observeChainTime();
    const kind = input.kind ?? 'execute';
    const initial = this.store.snapshot();
    const run = input.runId ? initial.runs.find((candidate) => candidate.id === input.runId) : undefined;
    if (kind === 'execute' && !run) throw new Error('RUN_NOT_FOUND');
    if (input.runId && !run) throw new Error('RUN_NOT_FOUND');
    if (run && run.mode === 'live') throw new Error('PHASE2_LIVE_MODE_DISABLED');
    const campaignId = input.campaignId ?? run?.campaignId;
    const target = input.targetAt ?? input.openingAt;
    const targetAt = target === undefined ? undefined : iso(target);
    const tMinusMs = input.tMinusMs ?? 0;
    if (!Number.isInteger(tMinusMs) || tMinusMs < 0) throw new Error('INVALID_T_MINUS');
    const offset = input.chainTimeOffsetMs ?? initial.runtime.chainTimeOffsetMs ?? this.options.chainTimeOffsetMs ?? 0;
    if (!Number.isFinite(offset)) throw new Error('INVALID_CHAIN_TIME_OFFSET');
    const scheduledAt = targetAt ? new Date(Date.parse(targetAt) - tMinusMs - offset).toISOString() : this.now().toISOString();
    const payload = safePayload({ ...input.payload, ...(input.wallets ? { wallets: [...input.wallets] } : {}), ...(input.runId ? { runId: input.runId } : {}), ...(campaignId ? { campaignId } : {}), ...(targetAt ? { targetAt } : {}), ...(tMinusMs ? { tMinusMs } : {}) });
    const fingerprint = input.requestDigest ?? requestDigest({ ...input, kind, campaignId, payload }, input.runId, targetAt, tMinusMs, offset);
    const now = this.now().toISOString();
    const job: ScheduledJobRecord = { id: `job_${randomUUID()}`, kind, ...(input.runId ? { runId: input.runId } : {}), ...(campaignId ? { campaignId } : {}), state: 'scheduled', scheduledAt, ...(targetAt ? { targetAt } : {}), tMinusMs, chainTimeOffsetMs: offset, idempotencyKey: input.idempotencyKey, requestDigest: fingerprint, payload, attempts: 0, maxAttempts: input.maxAttempts ?? 1, createdAt: now, updatedAt: now };
    if (!Number.isInteger(job.maxAttempts) || job.maxAttempts < 1) throw new Error('INVALID_JOB_ATTEMPTS');
    return this.store.transaction((state) => {
      const existing = state.jobs.find((candidate) => candidate.idempotencyKey === input.idempotencyKey);
      if (existing) {
        if (existing.requestDigest !== fingerprint) throw new Error('IDEMPOTENCY_KEY_CONFLICT');
        return structuredClone(existing);
      }
      state.jobs.push(job);
      state.events.push(this.event('job_scheduled', job.runId, { jobId: job.id, kind: job.kind, scheduledAt: job.scheduledAt, targetAt: job.targetAt, tMinusMs: job.tMinusMs, idempotencyKey: job.idempotencyKey }));
      return structuredClone(job);
    });
  }

  public scheduleRun(input: ScheduleExecutionInput): Promise<ScheduledJobRecord> {
    const runId = input.runId;
    if (!runId) return Promise.reject(new Error('RUN_ID_REQUIRED'));
    const wallets = input.wallets ?? [];
    const target = input.targetAt ?? input.openingAt;
    const targetKey = target === undefined ? 'immediate' : iso(target);
    return this.schedule({ ...input, kind: 'execute', idempotencyKey: input.idempotencyKey ?? `execute:${runId}:${wallets.map((wallet) => wallet.toLowerCase()).sort().join(',')}:${targetKey}:${input.tMinusMs ?? 0}` });
  }

  public enqueue(input: ScheduleJobInput): Promise<ScheduledJobRecord> { return this.schedule(input); }

  /** Boot is fail-closed: submitted work is reconciled before execution jobs run. */
  public async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.observeChainTime();
    await this.store.transaction((state) => {
      state.runtime = { ...state.runtime, startupState: 'Reconciling', blockingReasons: [...new Set([...state.runtime.blockingReasons.filter((reason) => reason !== 'RECONCILIATION_IN_PROGRESS'), 'RECONCILIATION_IN_PROGRESS'])] };
    });
    await this.recoverJobs(true);
    const before = this.store.snapshot();
    const hasInFlightSubmission = before.runs.some((run) => run.state === 'Active' || run.state === 'Armed' && (runHasSubmittedWork(before, run.id) || before.reservations.some((reservation) => reservation.runId === run.id && reservation.status === 'reserved')));
    try {
      if (hasInFlightSubmission) {
        await this.coordinator.start();
        await this.enforceRuntimeReadiness();
      } else {
        await this.store.transaction((state) => {
          const reasons = state.runtime.blockingReasons.filter((reason) => reason !== 'RECONCILIATION_IN_PROGRESS');
          const dependenciesReady = Object.values(state.runtime.dependencies).every(Boolean);
          const killed = state.killed || state.runtime.operational?.killSwitchEngaged === true;
          const startupState = killed || !dependenciesReady || reasons.length > 0 ? 'Blocked' : 'Ready';
          const blockingReasons = [...new Set([
            ...reasons,
            ...(killed ? ['KILLED'] : []),
            ...(!dependenciesReady ? ['DEPLOYMENT_DEPENDENCIES_NOT_READY'] : []),
          ])];
          state.runtime = { ...state.runtime, startupState, reconciliationCompletedAt: this.now().toISOString(), blockingReasons };
        });
      }
    } catch (error) {
      const normalized = normalizeError(error);
      await this.store.transaction((state) => {
        state.runtime = { ...state.runtime, startupState: 'Blocked', reconciliationCompletedAt: this.now().toISOString(), blockingReasons: [...new Set([...state.runtime.blockingReasons.filter((reason) => reason !== 'RECONCILIATION_IN_PROGRESS'), 'RECONCILIATION_FAILED', normalized.code])] };
        state.events.push(this.event('orchestrator_blocked', undefined, { reason: normalized.code }));
      });
    }
    await this.tick();
    this.timer = setInterval(() => { void this.tick(); }, this.options.pollIntervalMs);
  }

  public async stop(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.started = false;
  }

  public async tick(): Promise<TickResult> {
    if (this.ticking) return { claimed: [], completed: [], failed: [], blocked: [] };
    this.ticking = true;
    try {
      await this.recoverJobs(false);
      const snapshot = this.store.snapshot();
      if (snapshot.killed) {
        await this.cancelQueued('KILLED');
        return { claimed: [], completed: [], failed: [], blocked: [] };
      }
      const ready = snapshot.runtime.startupState === 'Ready';
      const active = snapshot.jobs.filter((job) => job.state === 'running').length;
      const capacity = Math.max(0, this.options.maxConcurrency - active);
      if (capacity === 0) return { claimed: [], completed: [], failed: [], blocked: [] };
      const now = this.now().getTime();
      const claimed = await this.claim(capacity, now, ready);
      const results = await Promise.allSettled(claimed.map((job) => this.runJob(job)));
      const result: TickResult = { claimed: claimed.map((job) => job.id), completed: [], failed: [], blocked: [] };
      for (const [index, settled] of results.entries()) {
        const job = claimed[index]!;
        const latest = this.store.snapshot().jobs.find((candidate) => candidate.id === job.id);
        if (latest?.state === 'succeeded') result.completed.push(job.id);
        else if (latest?.state === 'blocked') result.blocked.push(job.id);
        else if (latest?.state === 'failed' || settled.status === 'rejected') result.failed.push(job.id);
      }
      return result;
    } finally {
      this.ticking = false;
    }
  }

  public status(): OrchestratorStatus {
    const state = this.store.snapshot();
    return { running: this.started, startupState: state.runtime.startupState, active: state.jobs.filter((job) => job.state === 'running').length, queued: state.jobs.filter((job) => job.state === 'scheduled').length, blocked: state.jobs.filter((job) => job.state === 'blocked').length, failed: state.jobs.filter((job) => job.state === 'failed').length, completed: state.jobs.filter((job) => job.state === 'succeeded').length, blockingReasons: [...state.runtime.blockingReasons] };
  }

  private async claim(capacity: number, now: number, startupReady: boolean): Promise<ScheduledJobRecord[]> {
    return this.store.transaction((state) => {
      const selected: ScheduledJobRecord[] = [];
      const leaseExpiresAt = new Date(now + this.options.jobLeaseMs).toISOString();
      const candidates = state.jobs.filter((job) => job.state === 'scheduled' && Date.parse(job.scheduledAt) <= now && (!job.nextAttemptAt || Date.parse(job.nextAttemptAt) <= now)).sort((left, right) => Date.parse(left.scheduledAt) - Date.parse(right.scheduledAt) || left.id.localeCompare(right.id));
      for (const job of candidates) {
        if (selected.length >= capacity) break;
        const run = job.runId ? state.runs.find((candidate) => candidate.id === job.runId) : undefined;
        if (job.kind === 'execute' && !startupReady && run?.mode === 'live') continue;
        job.state = 'running';
        job.attempts += 1;
        job.leaseOwner = this.options.ownerId;
        job.leaseExpiresAt = leaseExpiresAt;
        job.startedAt = this.now().toISOString();
        job.updatedAt = job.startedAt;
        selected.push(structuredClone(job));
        state.events.push(this.event('job_claimed', job.runId, { jobId: job.id, attempt: job.attempts, kind: job.kind }));
      }
      return selected;
    });
  }

  private async runJob(job: ScheduledJobRecord): Promise<void> {
    try {
      if (this.store.snapshot().killed) throw new Error('KILLED');
      if (job.kind === 'execute') await this.runExecutionJob(job);
      else if (job.kind === 'reconcile') await this.coordinator.reconcile();
      else if (job.kind === 'notification') {
        const dispatcher = this.options.notifications;
        if (!dispatcher) throw new Error('NOTIFICATIONS_NOT_CONFIGURED');
        const sourceEventId = typeof job.payload.sourceEventId === 'string' ? job.payload.sourceEventId : undefined;
        if (!sourceEventId) throw new Error('NOTIFICATION_SOURCE_EVENT_REQUIRED');
        await dispatcher.dispatch(sourceEventId, typeof job.payload.text === 'string' ? job.payload.text : undefined);
      } else if (job.kind === 'health') {
        this.store.snapshot();
      }
      await this.finishJob(job.id, 'succeeded');
    } catch (error) {
      await this.failJob(job, error);
      throw error;
    }
  }

  private async runExecutionJob(job: ScheduledJobRecord): Promise<void> {
    if (!job.runId) throw new Error('RUN_ID_REQUIRED');
    const state = this.store.snapshot();
    const run = state.runs.find((candidate) => candidate.id === job.runId);
    if (!run) throw new Error('RUN_NOT_FOUND');
    if (isTerminalRun(run)) return;
    if (runHasSubmittedWork(state, job.runId)) {
      await this.finishJob(job.id, 'blocked', 'UNRESOLVED_SUBMISSION_REQUIRES_RECONCILIATION');
      return;
    }
    const wallets = Array.isArray(job.payload.wallets) ? job.payload.wallets.filter((wallet): wallet is string => typeof wallet === 'string') : state.intents.find((intent) => intent.runId === job.runId)?.wallets ?? [];
    const started = this.event('run_started', job.runId, { jobId: job.id, walletCount: wallets.length });
    await this.store.transaction((current) => { current.events.push(started); });
    try {
      await this.coordinator.execute(job.runId, [...wallets]);
      const after = this.store.snapshot();
      const resultRun = after.runs.find((candidate) => candidate.id === job.runId);
      if (resultRun?.state === 'Failed') await this.emitTerminalNotification(resultRun, 'run_failed');
      else if (resultRun?.state === 'Aborted') await this.emitTerminalNotification(resultRun, 'run_aborted');
      else if (resultRun?.state === 'Completed') await this.emitTerminalNotification(resultRun, 'run_succeeded');
    } catch (error) {
      const after = this.store.snapshot();
      const resultRun = after.runs.find((candidate) => candidate.id === job.runId);
      if (resultRun?.state === 'Aborted') await this.emitTerminalNotification(resultRun, 'run_aborted');
      else if (runHasSubmittedWork(after, job.runId)) await this.emitTerminalNotification(resultRun ?? run, 'run_blocked');
      throw error;
    }
  }

  private async emitTerminalNotification(run: RunRecord, type: string): Promise<void> {
    const event = this.event(type, run.id, { state: run.state, runId: run.id });
    await this.store.transaction((state) => { if (!state.events.some((existing) => existing.type === type && existing.runId === run.id)) state.events.push(event); });
    if (this.options.notifications) {
      try { await this.options.notifications.dispatch(event.id, `${type.replaceAll('_', ' ')}: ${run.id}`); } catch { /* delivery is durable and must not change execution truth */ }
    }
  }

  private async failJob(job: ScheduledJobRecord, error: unknown): Promise<void> {
    const normalized = normalizeError(error);
    const latestState = this.store.snapshot();
    const submitted = runHasSubmittedWork(latestState, job.runId);
    const outcomeUnknown = Boolean(job.runId && latestState.events.some((event) => event.runId === job.runId && event.type === 'execution_outcome_unknown'));
    const blocked = normalized.code === 'KILLED' || submitted || outcomeUnknown || /RECONCILIATION|AMBIGUOUS|UNRESOLVED/i.test(normalized.message);
    const retryable = normalized.retryable && job.attempts < job.maxAttempts && !blocked;
    if (retryable) {
      await this.store.transaction((state) => {
        const current = state.jobs.find((candidate) => candidate.id === job.id);
        if (!current) return;
        current.state = 'scheduled';
        current.nextAttemptAt = new Date(this.now().getTime() + this.options.retryDelayMs * current.attempts).toISOString();
        current.lastError = normalized.code;
        current.leaseOwner = undefined;
        current.leaseExpiresAt = undefined;
        current.updatedAt = this.now().toISOString();
        state.events.push(this.event('job_retry_scheduled', current.runId, { jobId: current.id, reason: normalized.code }));
      });
      return;
    }
    await this.finishJob(job.id, blocked ? (normalized.code === 'KILLED' ? 'cancelled' : 'blocked') : 'failed', normalized.code);
    if (job.runId) {
      const run = this.store.snapshot().runs.find((candidate) => candidate.id === job.runId);
      if (run && !isTerminalRun(run) && !blocked) await this.store.transaction((state) => { const current = state.runs.find((candidate) => candidate.id === job.runId); if (current && current.state === 'Armed') { current.state = 'Failed'; current.updatedAt = this.now().toISOString(); } });
    }
  }

  private async finishJob(id: string, stateValue: JobState, reason?: string): Promise<void> {
    await this.store.transaction((state) => {
      const job = state.jobs.find((candidate) => candidate.id === id);
      if (!job) throw new Error('JOB_NOT_FOUND');
      if (job.state !== 'running' && job.state !== stateValue) return;
      job.state = stateValue;
      job.updatedAt = this.now().toISOString();
      job.completedAt = stateValue === 'succeeded' || stateValue === 'failed' || stateValue === 'blocked' || stateValue === 'cancelled' ? job.updatedAt : undefined;
      job.leaseOwner = undefined;
      job.leaseExpiresAt = undefined;
      job.lastError = reason;
      state.events.push(this.event('job_state', job.runId, { jobId: job.id, state: stateValue, reason }));
    });
  }

  private async recoverJobs(force: boolean): Promise<void> {
    const now = this.now().getTime();
    await this.store.transaction((state) => {
      for (const job of state.jobs) {
        if (job.state !== 'running') continue;
        const expired = force || !job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) <= now;
        if (!expired) continue;
        if (runHasSubmittedWork(state, job.runId)) {
          job.state = 'blocked';
          job.lastError = 'UNRESOLVED_SUBMISSION_REQUIRES_RECONCILIATION';
          job.completedAt = this.now().toISOString();
        } else {
          job.state = 'scheduled';
          job.nextAttemptAt = this.now().toISOString();
        }
        job.leaseOwner = undefined;
        job.leaseExpiresAt = undefined;
        job.updatedAt = this.now().toISOString();
        state.events.push(this.event('job_recovered', job.runId, { jobId: job.id, state: job.state }));
      }
    });
  }

  private async observeChainTime(): Promise<void> {
    if (!this.options.chainTime) return;
    try {
      const chainNow = await this.options.chainTime();
      if (!(chainNow instanceof Date) || !Number.isFinite(chainNow.getTime())) throw new Error('INVALID_CHAIN_TIME');
      const observedAt = this.now();
      const offset = chainNow.getTime() - observedAt.getTime();
      await this.store.transaction((state) => {
        state.runtime = { ...state.runtime, chainTimeOffsetMs: offset, chainTimeObservedAt: observedAt.toISOString() };
      });
    } catch (error) {
      const normalized = normalizeError(error);
      await this.store.transaction((state) => {
        state.runtime = { ...state.runtime, blockingReasons: [...new Set([...state.runtime.blockingReasons, 'CHAIN_TIME_UNAVAILABLE', normalized.code])] };
      });
    }
  }

  private async enforceRuntimeReadiness(): Promise<void> {
    await this.store.transaction((state) => {
      const dependenciesReady = Object.values(state.runtime.dependencies).every(Boolean);
      const killed = state.killed || state.runtime.operational?.killSwitchEngaged === true;
      const missingChainTime = Boolean(this.options.chainTime && !state.runtime.chainTimeObservedAt);
      const reasons = [...new Set([
        ...state.runtime.blockingReasons.filter((reason) => reason !== 'RECONCILIATION_IN_PROGRESS'),
        ...(missingChainTime ? ['CHAIN_TIME_UNAVAILABLE'] : []),
        ...(killed ? ['KILLED'] : []),
        ...(!dependenciesReady ? ['DEPLOYMENT_DEPENDENCIES_NOT_READY'] : []),
      ])];
      if (state.runtime.startupState === 'Ready' && (reasons.length > 0 || missingChainTime)) {
        state.runtime = { ...state.runtime, startupState: 'Blocked', blockingReasons: reasons };
      }
    });
  }

  private async cancelQueued(reason: string): Promise<void> {
    await this.store.transaction((state) => {
      for (const job of state.jobs.filter((candidate) => candidate.state === 'scheduled' && candidate.kind === 'execute')) {
        job.state = 'cancelled';
        job.lastError = reason;
        job.completedAt = this.now().toISOString();
        job.updatedAt = job.completedAt;
        state.events.push(this.event('job_cancelled', job.runId, { jobId: job.id, reason }));
      }
    });
  }

  private event(type: string, runId: string | undefined, data: Record<string, unknown>): EventRecord {
    return { id: `evt_${randomUUID()}`, ...(runId ? { runId } : {}), type, at: this.now().toISOString(), data };
  }
}

export { Orchestrator as ExecutionOrchestrator };
export { Orchestrator as BackendOrchestrator };
