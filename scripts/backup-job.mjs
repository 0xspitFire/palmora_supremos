// One scheduled backup: make an encrypted snapshot, prove it can be restored, remove snapshots older than the
// retention window, and write the status file the health warnings and the live-readiness check read.
//
// Environment (set by the service, never printed): STORE_PATH, BACKUP_DIR, BACKUP_STATUS_PATH, KILL_SWITCH_PATH,
// BACKUP_ENCRYPTION_KEY, BACKUP_RETENTION_DAYS (must be 30). The key is passed on to the two existing scripts and is
// never written anywhere. On any failure the status file says "failed" with a short code only (no path, no key).
import { execFile } from 'node:child_process';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const scripts = dirname(new URL(import.meta.url).pathname);
const RETENTION_DAYS = 30;
const statusPath = process.env.BACKUP_STATUS_PATH ? resolve(process.env.BACKUP_STATUS_PATH) : undefined;
const backupDir = process.env.BACKUP_DIR ? resolve(process.env.BACKUP_DIR) : undefined;

async function writeStatus(body) {
  if (!statusPath) return;
  await mkdir(dirname(statusPath), { recursive: true, mode: 0o700 });
  const temporary = `${statusPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ ...body, recordedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
  await rename(temporary, statusPath);
}

async function script(name, extra = {}) {
  try {
    const { stdout } = await run(process.execPath, [resolve(scripts, name)], { env: { ...process.env, ...extra }, timeout: 4 * 60_000, maxBuffer: 1024 * 1024 });
    return JSON.parse(stdout.trim().split('\n').at(-1));
  } catch { throw new Error(name === 'backup.mjs' ? 'BACKUP_SNAPSHOT_FAILED' : 'BACKUP_RESTORE_CHECK_FAILED'); }
}

/** Removes snapshot files (and their checksum files) older than the retention window. The newest snapshot is never removed. */
export async function prune(directory, now = Date.now(), keepNewest = 1) {
  const names = (await readdir(directory)).filter((name) => name.endsWith('.snapshot.enc'));
  const dated = [];
  for (const name of names) dated.push({ name, at: (await stat(resolve(directory, name))).mtimeMs });
  dated.sort((left, right) => right.at - left.at);
  const removed = [];
  for (const { name, at } of dated.slice(keepNewest)) {
    if (now - at <= RETENTION_DAYS * 86_400_000) continue;
    await rm(resolve(directory, name), { force: true });
    await rm(resolve(directory, `${name}.sha256`), { force: true });
    removed.push(name);
  }
  return removed;
}

async function main() {
  if (Number(process.env.BACKUP_RETENTION_DAYS ?? RETENTION_DAYS) !== RETENTION_DAYS) throw new Error('BACKUP_RETENTION_MUST_BE_30_DAYS');
  if (!process.env.BACKUP_ENCRYPTION_KEY) throw new Error('BACKUP_ENCRYPTION_KEY_REQUIRED');
  if (!backupDir) throw new Error('BACKUP_DIR_REQUIRED');
  const made = await script('backup.mjs');
  const snapshot = resolve(backupDir, made.file);
  const restored = await script('restore-check.mjs', { RESTORE_SNAPSHOT: snapshot });
  if (restored.status !== 'ok') throw new Error('BACKUP_RESTORE_CHECK_FAILED');
  const removed = await prune(backupDir);
  await writeStatus({ status: 'ok', operation: 'backup', file: made.file, sha256: made.sha256, encrypted: true, restoreVerified: true, retentionDays: RETENTION_DAYS, removedOld: removed.length });
  console.log(JSON.stringify({ status: 'ok', file: made.file, restoreVerified: true, removedOld: removed.length }));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().catch(async (error) => {
    const code = error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'BACKUP_FAILED';
    try { await writeStatus({ status: 'failed', operation: 'backup', code }); } catch { /* the exit code still reports it */ }
    console.log(JSON.stringify({ status: 'failed', code }));
    process.exitCode = 1;
  });
}
