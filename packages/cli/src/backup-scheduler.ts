import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RedactedLogger } from '@mint-bot/backend';
import { backupFacts } from './host-facts.js';

const exec = promisify(execFile);

export interface BackupJobPaths {
  script: string;
  storePath: string;
  backupDir: string;
  statusPath: string;
  killSwitchPath: string;
}

/** Runs one backup (scripts/backup-job.mjs). The key goes to the child's environment only; the result carries a code, never a path or the key. */
export async function runBackupJob(paths: BackupJobPaths, key: string): Promise<{ ok: boolean; code?: string }> {
  try {
    const { stdout } = await exec(process.execPath, [paths.script], {
      env: { ...(process.env.PATH ? { PATH: process.env.PATH } : {}), STORE_PATH: paths.storePath, BACKUP_DIR: paths.backupDir, BACKUP_STATUS_PATH: paths.statusPath, KILL_SWITCH_PATH: paths.killSwitchPath, BACKUP_RETENTION_DAYS: '30', BACKUP_ENCRYPTION_KEY: key },
      timeout: 10 * 60_000,
      maxBuffer: 1024 * 1024,
    });
    return JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}').status === 'ok' ? { ok: true } : { ok: false, code: 'BACKUP_FAILED' };
  } catch (error) {
    const out = (error as { stdout?: unknown }).stdout;
    try {
      const code = (JSON.parse(String(out ?? '').trim().split('\n').at(-1) ?? '{}') as { code?: unknown }).code;
      return { ok: false, code: typeof code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(code) ? code : 'BACKUP_FAILED' };
    } catch { return { ok: false, code: 'BACKUP_FAILED' }; }
  }
}

export interface BackupSchedulerOptions {
  run: () => Promise<{ ok: boolean; code?: string }>;
  statusPath: string;
  /** A fresh backup is made when the last good one is this old (default 6 hours). */
  everyMs?: number;
  /** After a failed backup, try again after this long (default 30 minutes). */
  retryMs?: number;
  /** Never start two backups closer than this, even if the status file cannot be read or written (default 10 minutes). */
  minGapMs?: number;
  /** How often to look at the age (default 5 minutes). */
  checkMs?: number;
  /** Delay before the first look, so the service settles first (default 2 minutes). */
  firstDelayMs?: number;
  now?: () => Date;
  logger?: RedactedLogger;
}

/** Decides from the status file when a backup is due, so a restart never makes two in a row and a missing backup is made soon. */
export function startBackupScheduler(options: BackupSchedulerOptions): { stop(): void; checkNow(): Promise<boolean> } {
  const now = options.now ?? (() => new Date());
  const everyMs = options.everyMs ?? 6 * 60 * 60_000;
  const retryMs = options.retryMs ?? 30 * 60_000;
  const minGapMs = options.minGapMs ?? 10 * 60_000;
  let busy = false;
  let lastAttemptAt: number | undefined;
  const checkNow = async (): Promise<boolean> => {
    if (busy) return false;
    busy = true;
    try {
      const last = await backupFacts(options.statusPath);
      const age = last ? now().getTime() - last.recordedAt.getTime() : Number.POSITIVE_INFINITY;
      // A status dated in the future (clock change) cannot be trusted: treat the backup as due.
      const due = !last || age < -5 * 60_000 || age >= (last.status === 'ok' ? everyMs : retryMs);
      if (!due) return false;
      if (lastAttemptAt !== undefined && now().getTime() - lastAttemptAt < minGapMs) return false;
      lastAttemptAt = now().getTime();
      const result = await options.run();
      if (result.ok) options.logger?.info({ event: 'backup_job_ok' }, 'backup made and restore-checked');
      else options.logger?.warn({ event: 'backup_job_failed', code: result.code ?? 'BACKUP_FAILED' }, 'backup failed');
      return true;
    } catch {
      options.logger?.warn({ event: 'backup_job_failed', code: 'BACKUP_FAILED' }, 'backup failed');
      return true;
    } finally { busy = false; }
  };
  const first = setTimeout(() => void checkNow(), options.firstDelayMs ?? 2 * 60_000);
  const timer = setInterval(() => void checkNow(), options.checkMs ?? 5 * 60_000);
  first.unref();
  timer.unref();
  return { stop: () => { clearTimeout(first); clearInterval(timer); }, checkNow };
}
