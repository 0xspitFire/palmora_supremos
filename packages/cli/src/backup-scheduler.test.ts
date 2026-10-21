import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { runBackupJob, startBackupScheduler } from './backup-scheduler.js';

const exec = promisify(execFile);
const root = resolve(new URL('../../..', import.meta.url).pathname);
const script = join(root, 'scripts', 'backup-job.mjs');
const Database = createRequire(join(root, 'packages', 'database', 'package.json'))('better-sqlite3') as new (path: string) => { pragma(sql: string): unknown; exec(sql: string): void; close(): void };
const KEY = 'test-only-key-0123456789abcdef0123456789abcdef';

async function workspace() {
  const directory = await mkdtemp(join(tmpdir(), 'mint-backup-'));
  const store = join(directory, 'state.sqlite');
  const database = new Database(store);
  database.pragma('journal_mode = WAL');
  database.exec('create table t (a text); insert into t values (\'x\');');
  database.close();
  const kill = join(directory, 'killswitch');
  await writeFile(kill, 'x');
  const paths = { script, storePath: store, backupDir: join(directory, 'backups'), statusPath: join(directory, 'backups', 'status.json'), killSwitchPath: kill };
  return { directory, paths };
}

describe('scheduled backup job', () => {
  it('keeps systemd credentials in files under a separate backup identity', async () => {
    const [wrapper, unit, mainUnit, backupJob] = await Promise.all([
      readFile(join(root, 'scripts', 'backup-service.mjs'), 'utf8'),
      readFile(join(root, 'ops', 'systemd', 'mint-bot-backup.service'), 'utf8'),
      readFile(join(root, 'ops', 'systemd', 'mint-bot.service'), 'utf8'),
      readFile(join(root, 'scripts', 'backup-job.mjs'), 'utf8'),
    ]);
    expect(unit).toContain('User=mintbot-backup');
    expect(unit).not.toContain('SupplementaryGroups=mintbot');
    expect(unit).toContain('Group=mintbot-status');
    expect(mainUnit).toContain('SupplementaryGroups=mintbot-status');
    expect(mainUnit).toContain('ReadOnlyPaths=/var/lib/mint-bot/backup-status');
    expect(unit).toContain('ReadOnlyPaths=/var/lib/mint-bot');
    expect(unit).toContain('ReadWritePaths=/var/lib/mint-bot/backups /var/lib/mint-bot/backup-status');
    expect(unit).toContain('UMask=0027');
    expect(backupJob).toContain('mode: 0o640');
    expect(unit).toContain('LoadCredential=backup-encryption-key:');
    expect(wrapper).toContain('BACKUP_ENCRYPTION_KEY_FILE');
    expect(wrapper).toContain('R2_ACCESS_KEY_ID_FILE');
    expect(wrapper).toContain('delete childEnvironment.BACKUP_ENCRYPTION_KEY');
    expect(wrapper).not.toMatch(/BACKUP_ENCRYPTION_KEY:\s*backupKey|R2_ACCESS_KEY_ID:\s*accessKeyId|R2_SECRET_ACCESS_KEY:\s*secretAccessKey/);
  });

  it('builds a complete R2 configuration only and verifies uploaded bytes with a GET', async () => {
    const { r2ConfigFromEnv, uploadR2File } = (await import(join(root, 'scripts', 'r2-upload.mjs'))) as {
      r2ConfigFromEnv: (env: Record<string, string>) => { bucket: string; accessKeyId: string; secretAccessKey: string; prefix: string; endpoint: string } | undefined;
      uploadR2File: (config: unknown, path: string, objectName: string, options: { client: { send(command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<Record<string, unknown>> } }) => Promise<{ objectKey: string; sha256: string; size: number }>;
    };
    expect(r2ConfigFromEnv({})).toBeUndefined();
    expect(() => r2ConfigFromEnv({ MINT_BOT_OFFHOST_BACKUP_REQUIRED: 'true' })).toThrow('R2_CONFIGURATION_INCOMPLETE');
    expect(() => r2ConfigFromEnv({ R2_ACCOUNT_ID: 'a'.repeat(32), R2_BUCKET_NAME: 'backup', R2_ACCESS_KEY_ID: 'id', R2_SECRET_ACCESS_KEY: 'secret', MINT_BOT_HOST_ID: '../escape' })).toThrow('R2_CONFIGURATION_INVALID');
    const config = r2ConfigFromEnv({ R2_ACCOUNT_ID: 'a'.repeat(32), R2_BUCKET_NAME: 'backup', R2_ACCESS_KEY_ID: 'id', R2_SECRET_ACCESS_KEY: 'secret', R2_OBJECT_PREFIX: 'mintbot/production', MINT_BOT_HOST_ID: 'host-1' });
    expect(config).toBeDefined();
    expect(config?.endpoint).toBe(`https://${'a'.repeat(32)}.r2.cloudflarestorage.com`);
    expect(r2ConfigFromEnv({ R2_ACCOUNT_ID: 'a'.repeat(32), R2_BUCKET_NAME: 'backup', R2_ACCESS_KEY_ID: 'id', R2_SECRET_ACCESS_KEY: 'secret', MINT_BOT_HOST_ID: 'host-1', R2_JURISDICTION: 'automatic' })?.endpoint).toBe(`https://${'a'.repeat(32)}.r2.cloudflarestorage.com`);
    const directory = await mkdtemp(join(tmpdir(), 'mint-r2-'));
    try {
      const file = join(directory, 'snapshot.enc');
      await writeFile(file, 'encrypted bytes');
      const calls: string[] = [];
      let hash = '';
      const client = { async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
        calls.push(command.constructor.name);
        if (command.constructor.name === 'PutObjectCommand') {
          hash = (command.input.Metadata as { sha256: string }).sha256;
          return {};
        }
        return { Metadata: { sha256: hash }, Body: { transformToByteArray: async () => new TextEncoder().encode('encrypted bytes') } };
      } };
      const uploaded = await uploadR2File(config, file, 'snapshot.enc', { client });
      expect(uploaded).toMatchObject({ objectKey: 'mintbot/production/host-1/snapshot.enc', size: 15 });
      expect(calls).toEqual(['PutObjectCommand', 'GetObjectCommand']);
      const corruptClient = { async send(command: { constructor: { name: string } }) {
        if (command.constructor.name === 'PutObjectCommand') return {};
        return { Metadata: { sha256: uploaded.sha256 }, Body: { transformToByteArray: async () => new TextEncoder().encode('corrupt bytes') } };
      } };
      await expect(uploadR2File(config, file, 'snapshot.enc', { client: corruptClient })).rejects.toThrow('R2_UPLOAD_VERIFICATION_FAILED');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('makes an encrypted snapshot, proves it restores, and writes an ok status without the key', async () => {
    const { directory, paths } = await workspace();
    try {
      expect(await runBackupJob(paths, KEY)).toEqual({ ok: true });
      const files = await readdir(paths.backupDir);
      expect(files.some((name) => name.endsWith('.snapshot.enc'))).toBe(true);
      expect(files.some((name) => name.endsWith('.snapshot.enc.sha256'))).toBe(true);
      const status = JSON.parse(await readFile(paths.statusPath, 'utf8')) as Record<string, unknown>;
      expect((await stat(paths.statusPath)).mode & 0o777).toBe(0o640);
      expect(status).toMatchObject({ status: 'ok', encrypted: true, restoreVerified: true, retentionDays: 30 });
      expect(JSON.stringify(status)).not.toContain(KEY);
      expect(JSON.stringify(status)).not.toContain(directory);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('fails closed: no key, a database that is not in WAL mode, or a missing store each write a failed status with a code only', async () => {
    const { directory, paths } = await workspace();
    try {
      expect(await runBackupJob(paths, '')).toEqual({ ok: false, code: 'BACKUP_ENCRYPTION_KEY_REQUIRED' });
      expect(JSON.parse(await readFile(paths.statusPath, 'utf8'))).toMatchObject({ status: 'failed', code: 'BACKUP_ENCRYPTION_KEY_REQUIRED' });
      expect(await runBackupJob(paths, 'short')).toEqual({ ok: false, code: 'BACKUP_ENCRYPTION_KEY_TOO_SHORT' });
      const plain = join(directory, 'plain.sqlite');
      const database = new Database(plain);
      database.exec('create table t (a text)');
      database.close();
      expect((await runBackupJob({ ...paths, storePath: plain }, KEY)).ok).toBe(false);
      expect(JSON.parse(await readFile(paths.statusPath, 'utf8')).status).toBe('failed');
      expect(await runBackupJob({ ...paths, storePath: join(directory, 'missing.sqlite') }, KEY)).toMatchObject({ ok: false });
      const text = await readFile(paths.statusPath, 'utf8');
      expect(text).not.toContain(KEY);
      expect(text).not.toContain(directory);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('verifies scheduled snapshots offline without requiring the live kill switch, and never passes the status path to the snapshot step', async () => {
    const { backupChildEnv } = (await import(script)) as { backupChildEnv: (env: Record<string, string>) => Record<string, string> };
    expect(backupChildEnv({ A: '1', BACKUP_STATUS_PATH: '/x', MINT_BOT_BACKUP_STATUS_PATH: '/y' })).toEqual({ A: '1' });
    const { directory, paths } = await workspace();
    try {
      // Scheduled verification restores only to an isolated temporary file and never starts the application.
      const result = await runBackupJob({ ...paths, killSwitchPath: join(directory, 'no-such-kill-file') }, KEY);
      expect(result).toEqual({ ok: true });
      expect((await readdir(paths.backupDir)).some((name) => name.endsWith('.snapshot.enc'))).toBe(true);
      expect(JSON.parse(await readFile(paths.statusPath, 'utf8'))).toMatchObject({ status: 'ok', restoreVerified: true });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('leaves no restore-check side files behind after a good backup, and removes only this snapshot\'s', async () => {
    const { removeRestoreLeftovers } = (await import(script)) as { removeRestoreLeftovers: (directory: string, file: string) => Promise<string[]> };
    const { directory, paths } = await workspace();
    try {
      expect(await runBackupJob(paths, KEY)).toEqual({ ok: true });
      expect((await readdir(paths.backupDir)).filter((name) => name.includes('.restore.tmp'))).toEqual([]);
      // Leftovers of this snapshot go; another snapshot's files and unrelated files stay.
      await writeFile(join(paths.backupDir, '.a.snapshot.enc.1.restore.tmp-wal'), 'x');
      await writeFile(join(paths.backupDir, '.a.snapshot.enc.1.restore.tmp-shm'), 'x');
      await writeFile(join(paths.backupDir, '.b.snapshot.enc.2.restore.tmp-wal'), 'x');
      await writeFile(join(paths.backupDir, 'notes.txt'), 'x');
      expect((await removeRestoreLeftovers(paths.backupDir, 'a.snapshot.enc')).sort()).toEqual(['.a.snapshot.enc.1.restore.tmp-shm', '.a.snapshot.enc.1.restore.tmp-wal']);
      const left = await readdir(paths.backupDir);
      expect(left).toContain('.b.snapshot.enc.2.restore.tmp-wal');
      expect(left).toContain('notes.txt');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('refuses a retention other than 30 days', async () => {
    const { directory, paths } = await workspace();
    try {
      await expect(exec(process.execPath, [script], { env: { PATH: process.env.PATH ?? '', STORE_PATH: paths.storePath, BACKUP_DIR: paths.backupDir, BACKUP_STATUS_PATH: paths.statusPath, KILL_SWITCH_PATH: paths.killSwitchPath, BACKUP_RETENTION_DAYS: '7', BACKUP_ENCRYPTION_KEY: KEY } })).rejects.toMatchObject({ stdout: expect.stringContaining('BACKUP_RETENTION_MUST_BE_30_DAYS') });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('removes snapshots older than 30 days with their checksums, and always keeps the newest', async () => {
    const { prune } = (await import(script)) as { prune: (directory: string, now?: number, keepNewest?: number) => Promise<string[]> };
    const directory = await mkdtemp(join(tmpdir(), 'mint-prune-'));
    try {
      const now = Date.parse('2026-10-11T12:00:00Z');
      const make = async (name: string, daysOld: number) => {
        await writeFile(join(directory, name), 'x');
        await writeFile(join(directory, `${name}.sha256`), 'x');
        const at = new Date(now - daysOld * 86_400_000);
        await utimes(join(directory, name), at, at);
      };
      await make('a.snapshot.enc', 45);
      await make('b.snapshot.enc', 31);
      await make('c.snapshot.enc', 29);
      expect((await prune(directory, now)).sort()).toEqual(['a.snapshot.enc', 'b.snapshot.enc']);
      expect((await readdir(directory)).sort()).toEqual(['c.snapshot.enc', 'c.snapshot.enc.sha256']);
      // Everything old: the newest one still stays.
      // A dangling link and a folder with a snapshot name are skipped, not followed, not removed, and do not stop the prune.
      await symlink(join(directory, 'nowhere'), join(directory, 'link.snapshot.enc'));
      await mkdir(join(directory, 'dir.snapshot.enc'));
      await make('d.snapshot.enc', 60);
      expect(await prune(directory, now + 90 * 86_400_000)).toEqual(['d.snapshot.enc']);
      expect((await readdir(directory)).includes('link.snapshot.enc')).toBe(true);
      expect((await readdir(directory)).includes('dir.snapshot.enc')).toBe(true);
      expect((await readdir(directory)).includes('c.snapshot.enc')).toBe(true);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

describe('startBackupScheduler', () => {
  const statusFile = async (status: 'ok' | 'failed', at: string) => {
    const directory = await mkdtemp(join(tmpdir(), 'mint-status-'));
    const path = join(directory, 'status.json');
    await writeFile(path, JSON.stringify({ status, recordedAt: at }));
    return { directory, path };
  };

  it('runs when there is no backup or the last good one is 6 hours old, and not otherwise', async () => {
    const now = () => new Date('2026-10-11T12:00:00.000Z');
    const run = vi.fn(async () => ({ ok: true }));
    const missing = join(tmpdir(), 'does-not-exist-status.json');
    expect(await startBackupScheduler({ run, statusPath: missing, now, firstDelayMs: 3_600_000, checkMs: 3_600_000 }).checkNow()).toBe(true);
    const fresh = await statusFile('ok', '2026-10-11T10:00:00.000Z');
    const old = await statusFile('ok', '2026-10-11T05:59:00.000Z');
    try {
      const a = startBackupScheduler({ run, statusPath: fresh.path, now, firstDelayMs: 3_600_000, checkMs: 3_600_000 });
      expect(await a.checkNow()).toBe(false);
      a.stop();
      const b = startBackupScheduler({ run, statusPath: old.path, now, firstDelayMs: 3_600_000, checkMs: 3_600_000 });
      expect(await b.checkNow()).toBe(true);
      b.stop();
      expect(run).toHaveBeenCalledTimes(2);
    } finally { await rm(fresh.directory, { recursive: true, force: true }); await rm(old.directory, { recursive: true, force: true }); }
  });

  it('treats a status dated in the future as untrustworthy and runs', async () => {
    const run = vi.fn(async () => ({ ok: true }));
    const future = await statusFile('ok', '2026-10-12T12:00:00.000Z');
    try {
      const scheduler = startBackupScheduler({ run, statusPath: future.path, now: () => new Date('2026-10-11T12:00:00.000Z'), firstDelayMs: 3_600_000, checkMs: 3_600_000 });
      expect(await scheduler.checkNow()).toBe(true);
      scheduler.stop();
    } finally { await rm(future.directory, { recursive: true, force: true }); }
  });

  it('retries a failed backup after 30 minutes, not sooner, and survives a crash in the job', async () => {
    const now = () => new Date('2026-10-11T12:00:00.000Z');
    const logs: unknown[] = [];
    const logger = { info: (...a: unknown[]) => logs.push(a), warn: (...a: unknown[]) => logs.push(a), error: () => undefined } as never;
    const soon = await statusFile('failed', '2026-10-11T11:45:00.000Z');
    const later = await statusFile('failed', '2026-10-11T11:20:00.000Z');
    try {
      const run = vi.fn(async () => { throw new Error('boom'); });
      const a = startBackupScheduler({ run, statusPath: soon.path, now, logger, firstDelayMs: 3_600_000, checkMs: 3_600_000 });
      expect(await a.checkNow()).toBe(false);
      a.stop();
      const b = startBackupScheduler({ run, statusPath: later.path, now, logger, firstDelayMs: 3_600_000, checkMs: 3_600_000 });
      expect(await b.checkNow()).toBe(true);
      b.stop();
      expect(JSON.stringify(logs)).toContain('backup_job_failed');
      expect(JSON.stringify(logs)).not.toContain('boom');
    } finally { await rm(soon.directory, { recursive: true, force: true }); await rm(later.directory, { recursive: true, force: true }); }
  });

  it('does not start a second backup within the minimum gap even if the status file never changes', async () => {
    let clock = new Date('2026-10-11T12:00:00.000Z');
    const run = vi.fn(async () => ({ ok: true }));
    const scheduler = startBackupScheduler({ run, statusPath: join(tmpdir(), 'never-written-status.json'), now: () => clock, firstDelayMs: 3_600_000, checkMs: 3_600_000 });
    expect(await scheduler.checkNow()).toBe(true);
    clock = new Date('2026-10-11T12:05:00.000Z');
    expect(await scheduler.checkNow()).toBe(false);
    clock = new Date('2026-10-11T12:11:00.000Z');
    expect(await scheduler.checkNow()).toBe(true);
    scheduler.stop();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('never runs two backups at once', async () => {
    const now = () => new Date('2026-10-11T12:00:00.000Z');
    let release: (value: { ok: boolean }) => void = () => undefined;
    const run = vi.fn(() => new Promise<{ ok: boolean }>((resolve) => { release = resolve; }));
    const scheduler = startBackupScheduler({ run, statusPath: join(tmpdir(), 'nope-status.json'), now, firstDelayMs: 3_600_000, checkMs: 3_600_000 });
    const first = scheduler.checkNow();
    expect(await scheduler.checkNow()).toBe(false);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    release({ ok: true });
    await first;
    scheduler.stop();
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('service wiring', () => {
  it('starts the scheduler only when the backup key exists, never logs it, and stops it with the service', async () => {
    const source = await readFile(join(root, 'packages', 'cli', 'src', 'orchestrator-service.ts'), 'utf8');
    const start = source.indexOf("get('BACKUP_ENCRYPTION_KEY')");
    expect(start).toBeGreaterThan(0);
    const block = source.slice(start, start + 1_600);
    expect(block.indexOf('if (backupKey)')).toBeGreaterThan(-1);
    expect(block.indexOf('registerSecret(backupKey)')).toBeLessThan(block.indexOf('startBackupScheduler('));
    expect(source).toContain('backups?.stop();');
  });
});
