import { execFile } from 'node:child_process';
import { readFile, statfs } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { HealthSample } from '@mint-bot/backend';

const run = promisify(execFile);

/** Short commit of the running code for the start message, or `unknown`. Never throws and never shows anything but a hex id. */
export async function codeVersion(projectRoot: string): Promise<string> {
  try {
    const { stdout } = await run('git', ['rev-parse', '--short=8', 'HEAD'], { cwd: projectRoot, timeout: 2_000, windowsHide: true });
    const id = stdout.trim();
    return /^[0-9a-f]{7,40}$/.test(id) ? id : 'unknown';
  } catch { return 'unknown'; }
}

/** Free space of the disk holding the given directory; undefined when it cannot be read. */
export async function diskFacts(directory: string): Promise<HealthSample['disk']> {
  try {
    const stats = await statfs(directory);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    const totalBytes = Number(stats.blocks) * Number(stats.bsize);
    return Number.isFinite(freeBytes) && Number.isFinite(totalBytes) && totalBytes > 0 ? { freeBytes, totalBytes } : undefined;
  } catch { return undefined; }
}

/** The last backup, from the status file the backup job writes; undefined when there is none (no backup is set up) or it cannot be read. */
export async function backupFacts(statusPath: string): Promise<HealthSample['backup']> {
  try {
    const parsed = JSON.parse(await readFile(statusPath, 'utf8')) as { status?: unknown; recordedAt?: unknown };
    const at = typeof parsed.recordedAt === 'string' ? new Date(parsed.recordedAt) : undefined;
    if ((parsed.status !== 'ok' && parsed.status !== 'failed') || !at || !Number.isFinite(at.getTime())) return undefined;
    return { status: parsed.status, recordedAt: at };
  } catch { return undefined; }
}
