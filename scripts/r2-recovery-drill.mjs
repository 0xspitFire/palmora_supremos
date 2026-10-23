#!/usr/bin/env node
// Recovery drill (T-052 slice 3b). Restores one named encrypted backup from R2 into a private scratch folder and proves, with the
// INSTALLED release's own code, that the restored database is intact, migrates to the current schema, opens as the canonical store,
// and goes through the start-up reconciliation before anything could arm. It never touches the live database, the backup folder,
// the kill switch or any service path, and prints no secret. The scratch folder is always deleted.
//
//   node scripts/r2-recovery-drill.mjs <backup file name>
//
// Environment: the same as the restore drill (R2_* names, BACKUP_ENCRYPTION_KEY_FILE, or the systemd credential folder).
// Output: one JSON line with each check, read by `ops-evidence-collect.mjs recovery --recovery-drill <file>`.
import { createDecipheriv, createHash } from 'node:crypto';
import { readdirSync, realpathSync } from 'node:fs';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { createR2Client, r2ConfigFromEnv } from './r2-upload.mjs';
import { backupTime } from './r2-restore-drill.mjs';

const scripts = dirname(new URL(import.meta.url).pathname);
const root = resolve(scripts, '..');
const NAME = /^[A-Za-z0-9._-]+\.snapshot\.enc$/;

async function download(client, config, objectName) {
  const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: `${config.prefix}/${objectName}` }), { abortSignal: AbortSignal.timeout(120_000) });
  if (!response.Body) throw new Error('R2_DOWNLOAD_EMPTY');
  return Buffer.from(await response.Body.transformToByteArray());
}

async function backupKey(environment) {
  const value = environment.BACKUP_ENCRYPTION_KEY ?? (environment.BACKUP_ENCRYPTION_KEY_FILE ? (await readFile(resolve(environment.BACKUP_ENCRYPTION_KEY_FILE), 'utf8')).trim() : '');
  if (value.length < 32 || /[\r\n]/.test(value)) throw new Error('BACKUP_ENCRYPTION_KEY_REQUIRED');
  return value;
}

/** Same format as backup.mjs: "MINTBOT1", 12-byte IV, 16-byte tag, AES-256-GCM ciphertext with SHA-256 of the key text. */
function decrypt(encrypted, keyText) {
  if (encrypted.subarray(0, 8).toString('ascii') !== 'MINTBOT1') throw new Error('BACKUP_ENCRYPTION_HEADER_INVALID');
  const decipher = createDecipheriv('aes-256-gcm', createHash('sha256').update(keyText, 'utf8').digest(), encrypted.subarray(8, 20));
  decipher.setAuthTag(encrypted.subarray(20, 36));
  return Buffer.concat([decipher.update(encrypted.subarray(36)), decipher.final()]);
}

/** Highest migration the installed release knows (the numbered .sql files shipped with it). */
export function releaseSchemaVersion(migrationsDir = join(root, 'packages', 'database', 'migrations')) {
  return Math.max(...readdirSync(migrationsDir).map((name) => Number.parseInt(/^(\d+)_/.exec(name)?.[1] ?? '', 10)).filter(Number.isFinite));
}

/** A reconciliation source that cannot reach any chain: every in-flight execution stays unresolved, which is the safe answer. */
const offlineEngine = {
  prepare: async () => { throw new Error('RECOVERY_DRILL_NEVER_PREPARES'); },
  execute: async () => { throw new Error('RECOVERY_DRILL_NEVER_EXECUTES'); },
  reconcile: async () => ({ result: 'unknown', attempts: [], receipts: [], reason: 'recovery drill has no chain access' }),
};

export async function runRecoveryDrill({ fileName, environment = process.env, client, now = () => new Date(), workParent = tmpdir(), modules }) {
  if (!NAME.test(fileName ?? '')) throw new Error('BACKUP_FILE_NAME_INVALID');
  const config = r2ConfigFromEnv(environment);
  if (!config) throw new Error('R2_NOT_CONFIGURED');
  const started = now();
  const checks = {};
  const work = await mkdtemp(join(workParent, 'mintbot-recovery-drill-'));
  try {
    const r2 = client ?? await createR2Client(config);
    const encrypted = await download(r2, config, fileName);
    const checksumText = (await download(r2, config, `${fileName}.sha256`)).toString('utf8');
    const actual = createHash('sha256').update(encrypted).digest('hex');
    if (actual !== checksumText.trim().split(/\s+/)[0]) throw new Error('BACKUP_CHECKSUM_MISMATCH');
    const restored = join(work, 'restored.sqlite');
    await writeFile(restored, decrypt(encrypted, await backupKey(environment)), { mode: 0o600, flag: 'wx' });
    const created = backupTime(fileName);
    checks.restored_from_offhost = { pass: true, observed: `restored ${encrypted.byteLength} bytes from off-host storage; checksum matched; backup ${created ? Math.round((started - created) / 1000) : '?'}s old` };

    const { Database, openDatabase, CanonicalStoreBridge, ExecutionCoordinator, PERSONAL_LIVE_FLEET_POLICY } = modules ?? await loadReleaseModules();
    const plain = new Database(restored, { readonly: true, fileMustExist: true });
    let restoredVersion = 0;
    try {
      const journal = plain.pragma('journal_mode', { simple: true });
      const integrity = plain.pragma('integrity_check', { simple: true });
      restoredVersion = Number(plain.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version ?? 0);
      checks.integrity_ok = { pass: journal === 'wal' && integrity === 'ok', observed: `journal ${journal}, integrity ${integrity}` };
    } finally { plain.close(); }

    // Work on a second copy, so the integrity check above saw the bytes exactly as restored.
    const migratedPath = join(work, 'migrated.sqlite');
    await copyFile(restored, migratedPath);
    const latest = releaseSchemaVersion(modules?.migrationsDir);
    const db = openDatabase(migratedPath);
    try {
      const after = Number(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version ?? 0);
      checks.schema_current = { pass: after === latest, observed: `restored at schema ${restoredVersion}; after the installed release's migrations ${after} of ${latest}` };
      const store = new CanonicalStoreBridge(db, { durable: true, fleetPolicy: PERSONAL_LIVE_FLEET_POLICY });
      await store.open();
      const coordinator = new ExecutionCoordinator(store, offlineEngine);
      await coordinator.start();
      const runtime = store.snapshot().runtime;
      const reasons = runtime.blockingReasons ?? [];
      checks.post_recovery_reconciliation = { pass: Boolean(runtime.reconciliationCompletedAt) && (runtime.startupState === 'Ready' || (runtime.startupState === 'Blocked' && reasons.length > 0)), observed: `start-up reconciliation ran on the restored store: state ${runtime.startupState}${reasons.length ? ` (${reasons.join(', ')})` : ''}` };
      store.close?.();
    } finally { try { db.close(); } catch { /* already closed by the store */ } }
    const finished = now();
    return { status: Object.values(checks).every((check) => check.pass) ? 'ok' : 'failed', object: fileName, checks, restoreSeconds: (finished - started) / 1000, completedAt: finished.toISOString() };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function loadReleaseModules() {
  const requireDb = createRequire(join(root, 'packages', 'database', 'package.json'));
  const Database = requireDb('better-sqlite3');
  const { openDatabase } = await import(join(root, 'packages', 'database', 'dist', 'index.js'));
  const { CanonicalStoreBridge, ExecutionCoordinator, PERSONAL_LIVE_FLEET_POLICY } = await import(join(root, 'packages', 'backend', 'dist', 'index.js'));
  return { Database, openDatabase, CanonicalStoreBridge, ExecutionCoordinator, PERSONAL_LIVE_FLEET_POLICY };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url).pathname)) {
  try {
    const directory = process.env.CREDENTIALS_DIRECTORY;
    const environment = directory
      ? { ...process.env, BACKUP_ENCRYPTION_KEY_FILE: resolve(directory, 'backup-encryption-key'), R2_ACCESS_KEY_ID_FILE: resolve(directory, 'r2-access-key-id'), R2_SECRET_ACCESS_KEY_FILE: resolve(directory, 'r2-secret-access-key') }
      : process.env;
    console.log(JSON.stringify(await runRecoveryDrill({ fileName: process.argv[2], environment })));
  } catch (error) {
    console.log(JSON.stringify({ status: 'failed', code: error instanceof Error ? error.message.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url]').slice(0, 120) : 'RECOVERY_DRILL_FAILED' }));
    process.exitCode = 1;
  }
}
