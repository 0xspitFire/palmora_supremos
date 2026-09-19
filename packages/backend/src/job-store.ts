import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { redactText } from './observability.js';

export type ScheduledJobState = 'scheduled' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled';

export interface ScheduledJob {
  id: string;
  runId: string;
  wallets: readonly string[];
  executeAt: string;
  mode: 'dry-run' | 'live';
  state: ScheduledJobState;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
  completedAt?: string;
}

export interface ScheduledJobStore {
  open(): Promise<void>;
  list(): Promise<ScheduledJob[]>;
  put(input: Omit<ScheduledJob, 'state' | 'attempts' | 'createdAt' | 'updatedAt'> & Partial<Pick<ScheduledJob, 'state' | 'attempts' | 'createdAt' | 'updatedAt'>>): Promise<ScheduledJob>;
  claimDue(now?: Date, limit?: number): Promise<ScheduledJob[]>;
  update(id: string, patch: Partial<Pick<ScheduledJob, 'state' | 'lastError' | 'completedAt' | 'updatedAt' | 'executeAt'>>): Promise<ScheduledJob>;
  recoverRunning(): Promise<number>;
}

interface JobFile {
  version: 1;
  jobs: ScheduledJob[];
}

const secretKey = /(?:private[_-]?key|mnemonic|seed(?:[_-]?phrase)?|passphrase|password|secret|token|authorization|api[_-]?key|raw(?:tx|_transaction)|calldata|payload)/i;

function cloneJob(job: ScheduledJob): ScheduledJob { return structuredClone(job); }

function assertJob(job: ScheduledJob): void {
  if (!job.id || !job.runId || !Array.isArray(job.wallets) || job.wallets.length === 0 || job.wallets.some((wallet) => typeof wallet !== 'string' || wallet.length === 0 || /[\r\n]/.test(wallet))) throw new Error('SCHEDULED_JOB_IDENTITY_INVALID');
  if (Number.isNaN(Date.parse(job.executeAt)) || Number.isNaN(Date.parse(job.createdAt)) || Number.isNaN(Date.parse(job.updatedAt))) throw new Error('SCHEDULED_JOB_TIME_INVALID');
  if (!['dry-run', 'live'].includes(job.mode) || !['scheduled', 'running', 'succeeded', 'failed', 'blocked', 'cancelled'].includes(job.state) || !Number.isSafeInteger(job.attempts) || job.attempts < 0) throw new Error('SCHEDULED_JOB_STATE_INVALID');
  if (job.lastError !== undefined && /[\r\n]/.test(job.lastError)) throw new Error('SCHEDULED_JOB_ERROR_INVALID');
}

function parseFile(value: unknown): JobFile {
  if (!value || typeof value !== 'object') throw new Error('SCHEDULED_JOB_FILE_INVALID');
  const candidate = value as Partial<JobFile>;
  if (candidate.version !== 1 || !Array.isArray(candidate.jobs)) throw new Error('SCHEDULED_JOB_FILE_INVALID');
  const jobs = candidate.jobs.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('SCHEDULED_JOB_FILE_INVALID');
    const job = item as ScheduledJob;
    assertJob(job);
    return cloneJob(job);
  });
  if (new Set(jobs.map((job) => job.id)).size !== jobs.length || new Set(jobs.map((job) => job.runId)).size !== jobs.length) throw new Error('SCHEDULED_JOB_DUPLICATE');
  return { version: 1, jobs };
}

function encode(file: JobFile): string {
  const output = JSON.stringify(file, null, 2);
  if (secretKey.test(output)) throw new Error('SCHEDULED_JOB_SECRET_LIKE_VALUE');
  return `${output}\n`;
}

/**
 * Single-process durable scheduler state. SQLite remains the authority for
 * runs, reservations, and transaction facts; this file only makes timers
 * restartable without adding a second lifecycle implementation to the DB.
 */
export class JsonJobStore implements ScheduledJobStore {
  private state: JobFile = { version: 1, jobs: [] };
  private opened = false;
  private queue: Promise<void> = Promise.resolve();

  public constructor(private readonly filePath: string) {}

  public async open(): Promise<void> {
    await this.enqueue(async () => {
      if (this.opened) return;
      try {
        this.state = parseFile(JSON.parse(await readFile(this.filePath, 'utf8')));
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await this.persist();
      }
      this.opened = true;
    });
  }

  public async list(): Promise<ScheduledJob[]> {
    return this.enqueue(async () => {
      this.ensureOpen();
      return this.state.jobs.map(cloneJob);
    });
  }

  public async put(input: Omit<ScheduledJob, 'state' | 'attempts' | 'createdAt' | 'updatedAt'> & Partial<Pick<ScheduledJob, 'state' | 'attempts' | 'createdAt' | 'updatedAt'>>): Promise<ScheduledJob> {
    return this.enqueue(async () => {
      this.ensureOpen();
      const now = new Date().toISOString();
      const existing = this.state.jobs.find((job) => job.id === input.id);
      if (existing && existing.runId !== input.runId) throw new Error('SCHEDULED_JOB_ID_CONFLICT');
      const job: ScheduledJob = {
        id: input.id,
        runId: input.runId,
        wallets: [...input.wallets],
        executeAt: input.executeAt,
        mode: input.mode,
        state: input.state ?? existing?.state ?? 'scheduled',
        attempts: input.attempts ?? existing?.attempts ?? 0,
        createdAt: input.createdAt ?? existing?.createdAt ?? now,
        updatedAt: input.updatedAt ?? now,
        ...(input.lastError === undefined ? existing?.lastError === undefined ? {} : { lastError: existing.lastError } : { lastError: redactText(input.lastError) }),
        ...(input.completedAt === undefined ? existing?.completedAt === undefined ? {} : { completedAt: existing.completedAt } : { completedAt: input.completedAt }),
      };
      assertJob(job);
      if (existing) Object.assign(existing, job);
      else {
        if (this.state.jobs.some((candidate) => candidate.runId === job.runId)) throw new Error('SCHEDULED_JOB_RUN_CONFLICT');
        this.state.jobs.push(job);
      }
      await this.persist();
      return cloneJob(job);
    });
  }

  public async claimDue(now = new Date(), limit = 1): Promise<ScheduledJob[]> {
    return this.enqueue(async () => {
      this.ensureOpen();
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('SCHEDULED_JOB_LIMIT_INVALID');
      const timestamp = now.getTime();
      if (Number.isNaN(timestamp)) throw new Error('SCHEDULED_JOB_TIME_INVALID');
      const claimed: ScheduledJob[] = [];
      for (const job of this.state.jobs) {
        if (claimed.length >= limit || job.state !== 'scheduled' || Date.parse(job.executeAt) > timestamp) continue;
        job.state = 'running';
        job.attempts += 1;
        job.updatedAt = now.toISOString();
        claimed.push(cloneJob(job));
      }
      if (claimed.length > 0) await this.persist();
      return claimed;
    });
  }

  public async update(id: string, patch: Partial<Pick<ScheduledJob, 'state' | 'lastError' | 'completedAt' | 'updatedAt' | 'executeAt'>>): Promise<ScheduledJob> {
    return this.enqueue(async () => {
      this.ensureOpen();
      const job = this.state.jobs.find((candidate) => candidate.id === id);
      if (!job) throw new Error('SCHEDULED_JOB_NOT_FOUND');
      if (patch.state !== undefined) job.state = patch.state;
      if (patch.executeAt !== undefined) job.executeAt = patch.executeAt;
      if (patch.lastError !== undefined) job.lastError = redactText(patch.lastError);
      if (patch.completedAt !== undefined) job.completedAt = patch.completedAt;
      job.updatedAt = patch.updatedAt ?? new Date().toISOString();
      assertJob(job);
      await this.persist();
      return cloneJob(job);
    });
  }

  /** Requeue jobs interrupted by process loss before the next reconciliation. */
  public async recoverRunning(): Promise<number> {
    return this.enqueue(async () => {
      this.ensureOpen();
      let recovered = 0;
      for (const job of this.state.jobs) {
        if (job.state !== 'running') continue;
        job.state = 'scheduled';
        job.updatedAt = new Date().toISOString();
        job.lastError = 'RESTART_RECOVERY_PENDING_RECONCILIATION';
        recovered += 1;
      }
      if (recovered > 0) await this.persist();
      return recovered;
    });
  }

  private ensureOpen(): void { if (!this.opened) throw new Error('SCHEDULED_JOB_STORE_NOT_OPEN'); }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, encode(this.state), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temporaryPath, this.filePath);
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    let result!: T;
    const pending = this.queue.then(async () => { result = await operation(); });
    this.queue = pending.then(() => undefined, () => undefined);
    await pending;
    return result;
  }
}
