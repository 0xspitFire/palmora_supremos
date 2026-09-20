import { redactText } from './observability.js';
import type { BackendStore } from './store.js';
import type { ScheduledJob } from './job-store.js';
import type { ScheduledJobRecord } from './types.js';

function clone(job: ScheduledJob): ScheduledJob { return structuredClone(job); }

function assertJob(job: ScheduledJob): void {
  if (!job.id || !job.runId || job.wallets.length === 0 || !['dry-run', 'live'].includes(job.mode)) throw new Error('SCHEDULED_JOB_INVALID');
  if (!['scheduled', 'running', 'succeeded', 'failed', 'blocked', 'cancelled'].includes(job.state)) throw new Error('SCHEDULED_JOB_STATE_INVALID');
}

function fromRecord(record: ScheduledJobRecord): ScheduledJob {
  const payload = record.payload as { wallets?: unknown; mode?: unknown };
  return {
    id: record.id,
    runId: record.runId ?? '',
    wallets: Array.isArray(payload.wallets) ? payload.wallets.filter((item): item is string => typeof item === 'string') : [],
    executeAt: record.scheduledAt,
    mode: payload.mode === 'live' ? 'live' : 'dry-run',
    state: record.state,
    attempts: record.attempts,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.lastError ? { lastError: record.lastError } : {}),
    ...(record.completedAt ? { completedAt: record.completedAt } : {}),
  };
}

function toRecord(job: ScheduledJob, previous?: ScheduledJobRecord): ScheduledJobRecord {
  return {
    id: job.id,
    kind: 'phase2',
    runId: job.runId,
    ...(previous?.campaignId ? { campaignId: previous.campaignId } : {}),
    state: job.state,
    scheduledAt: job.executeAt,
    ...(previous?.targetAt ? { targetAt: previous.targetAt } : { targetAt: job.executeAt }),
    tMinusMs: previous?.tMinusMs ?? 0,
    chainTimeOffsetMs: previous?.chainTimeOffsetMs ?? 0,
    idempotencyKey: previous?.idempotencyKey ?? `phase2:${job.id}`,
    requestDigest: previous?.requestDigest ?? `phase2:${job.id}`,
    payload: { wallets: [...job.wallets], mode: job.mode },
    attempts: job.attempts,
    maxAttempts: previous?.maxAttempts ?? 1,
    ...(job.lastError ? { lastError: redactText(job.lastError) } : {}),
    ...(previous?.nextAttemptAt ? { nextAttemptAt: previous.nextAttemptAt } : {}),
    ...(previous?.leaseOwner ? { leaseOwner: previous.leaseOwner } : {}),
    ...(previous?.leaseExpiresAt ? { leaseExpiresAt: previous.leaseExpiresAt } : {}),
    ...(previous?.startedAt ? { startedAt: previous.startedAt } : {}),
    ...(job.completedAt ? { completedAt: job.completedAt } : {}),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

/** Phase 2 scheduler state persisted in the authoritative normalized store. */
export class CanonicalJobStore {
  public constructor(private readonly store: BackendStore) {}
  public async open(): Promise<void> {}

  public async list(): Promise<ScheduledJob[]> {
    return this.store.snapshot().jobs.filter((record) => record.kind === 'phase2').map(fromRecord).map(clone);
  }

  public async put(input: Omit<ScheduledJob, 'state' | 'attempts' | 'createdAt' | 'updatedAt'> & Partial<Pick<ScheduledJob, 'state' | 'attempts' | 'createdAt' | 'updatedAt'>>): Promise<ScheduledJob> {
    return this.store.transaction((state) => {
      const now = new Date().toISOString();
      const existingRecord = state.jobs.find((record) => record.kind === 'phase2' && record.id === input.id);
      const existing = existingRecord ? fromRecord(existingRecord) : undefined;
      if (existing && existing.runId !== input.runId) throw new Error('SCHEDULED_JOB_ID_CONFLICT');
      const job: ScheduledJob = {
        id: input.id, runId: input.runId, wallets: [...input.wallets], executeAt: input.executeAt, mode: input.mode,
        state: input.state ?? existing?.state ?? 'scheduled', attempts: input.attempts ?? existing?.attempts ?? 0,
        createdAt: input.createdAt ?? existing?.createdAt ?? now, updatedAt: input.updatedAt ?? now,
        ...(input.lastError === undefined ? existing?.lastError === undefined ? {} : { lastError: existing.lastError } : { lastError: redactText(input.lastError) }),
        ...(input.completedAt === undefined ? existing?.completedAt === undefined ? {} : { completedAt: existing.completedAt } : { completedAt: input.completedAt }),
      };
      assertJob(job);
      if (existingRecord) Object.assign(existingRecord, toRecord(job, existingRecord));
      else {
        if (state.jobs.some((record) => record.kind === 'phase2' && record.runId === job.runId)) throw new Error('SCHEDULED_JOB_RUN_CONFLICT');
        state.jobs.push(toRecord(job));
      }
      return clone(job);
    });
  }

  public async claimDue(now = new Date(), limit = 1): Promise<ScheduledJob[]> {
    return this.store.transaction((state) => {
      const claimed: ScheduledJob[] = [];
      for (const record of state.jobs) {
        if (record.kind !== 'phase2' || claimed.length >= limit || record.state !== 'scheduled' || Date.parse(record.scheduledAt) > now.getTime()) continue;
        const job = fromRecord(record);
        job.state = 'running'; job.attempts += 1; job.updatedAt = now.toISOString();
        Object.assign(record, toRecord(job, record)); claimed.push(clone(job));
      }
      return claimed;
    });
  }

  public async update(id: string, patch: Partial<Pick<ScheduledJob, 'state' | 'lastError' | 'completedAt' | 'updatedAt' | 'executeAt'>>): Promise<ScheduledJob> {
    return this.store.transaction((state) => {
      const record = state.jobs.find((candidate) => candidate.kind === 'phase2' && candidate.id === id);
      if (!record) throw new Error('SCHEDULED_JOB_NOT_FOUND');
      const job = fromRecord(record);
      Object.assign(job, patch);
      if (patch.lastError !== undefined) job.lastError = redactText(patch.lastError);
      job.updatedAt = patch.updatedAt ?? new Date().toISOString();
      assertJob(job); Object.assign(record, toRecord(job, record));
      return clone(job);
    });
  }

  public async recoverRunning(): Promise<number> {
    return this.store.transaction((state) => {
      let recovered = 0;
      for (const record of state.jobs) {
        if (record.kind !== 'phase2' || record.state !== 'running') continue;
        const job = fromRecord(record); job.state = 'scheduled'; job.updatedAt = new Date().toISOString(); job.lastError = 'RESTART_RECOVERY_PENDING_RECONCILIATION';
        Object.assign(record, toRecord(job, record)); recovered += 1;
      }
      return recovered;
    });
  }
}
