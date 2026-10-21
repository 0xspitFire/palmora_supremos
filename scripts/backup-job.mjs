// One scheduled backup: make an encrypted snapshot, prove it can be restored, remove snapshots older than the
// retention window, and write the status file the health warnings and the live-readiness check read.
//
// Environment (set by the service, never printed): STORE_PATH, BACKUP_DIR, BACKUP_STATUS_PATH, KILL_SWITCH_PATH,
// BACKUP_ENCRYPTION_KEY, BACKUP_RETENTION_DAYS (must be 30). The key is passed on to the two existing scripts and is
// never written anywhere. On any failure the status file says "failed" with a short code only (no path, no key).
import { execFile } from 'node:child_process';
import { lstat, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
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

/** backup.mjs writes its own "ok" status as soon as the snapshot exists, before the restore check. It must not get the status path, so an unverified "ok" can never be left behind if this job stops half way. */
export function backupChildEnv(env) {
  const { BACKUP_STATUS_PATH: _a, MINT_BOT_BACKUP_STATUS_PATH: _b, ...rest } = env;
  return rest;
}

async function script(name, extra = {}, base = process.env) {
  try {
    const { stdout } = await run(process.execPath, [resolve(scripts, name)], { env: { ...base, ...extra }, timeout: 4 * 60_000, maxBuffer: 1024 * 1024 });
    return JSON.parse(stdout.trim().split('\n').at(-1));
  } catch { throw new Error(name === 'backup.mjs' ? 'BACKUP_SNAPSHOT_FAILED' : 'BACKUP_RESTORE_CHECK_FAILED'); }
}

/** restore-check.mjs removes its temporary restored database but leaves the SQLite side files (-shm, -wal) beside it. Those can hold plaintext pages, so remove every leftover of this snapshot's restore check. */
export async function removeRestoreLeftovers(directory, snapshotFile) {
  const prefix = `.${snapshotFile}.`;
  const removed = [];
  for (const name of await readdir(directory)) {
    if (!name.startsWith(prefix) || !/\.restore\.tmp(-shm|-wal|-journal)?$/.test(name)) continue;
    const info = await lstat(resolve(directory, name)).catch(() => undefined);
    if (!info?.isFile()) continue;
    await rm(resolve(directory, name), { force: true });
    removed.push(name);
  }
  return removed;
}

/** Removes snapshot files (and their checksum files) older than the retention window. The newest snapshot is never removed. */
export async function prune(directory, now = Date.now(), keepNewest = 1) {
  const names = (await readdir(directory)).filter((name) => name.endsWith('.snapshot.enc'));
  const dated = [];
  // Only regular files count; a dangling link or a folder with that name is skipped, never followed or removed.
  for (const name of names) {
    try { const info = await lstat(resolve(directory, name)); if (info.isFile()) dated.push({ name, at: info.mtimeMs }); } catch { /* vanished: ignore */ }
  }
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
  if (process.env.BACKUP_ENCRYPTION_KEY.length < 32) throw new Error('BACKUP_ENCRYPTION_KEY_TOO_SHORT');
  if (!backupDir) throw new Error('BACKUP_DIR_REQUIRED');
  const made = await script('backup.mjs', {}, backupChildEnv(process.env));
  const snapshot = resolve(backupDir, made.file);
  const discard = async () => { await rm(snapshot, { force: true }); await rm(`${snapshot}.sha256`, { force: true }); };
  let restored;
  try { restored = await script('restore-check.mjs', { RESTORE_SNAPSHOT: snapshot, RESTORE_VERIFICATION_ONLY: 'true' }); } catch (error) { await removeRestoreLeftovers(backupDir, made.file); await discard(); throw error; }
  await removeRestoreLeftovers(backupDir, made.file);
  if (restored.status !== 'ok') { await discard(); throw new Error('BACKUP_RESTORE_CHECK_FAILED'); }
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
