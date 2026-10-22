import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** T-048: the isolated restore drill pulls a named backup from R2 into a scratch folder and verifies it, touching nothing live. */
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const KEY = 'a'.repeat(40);

async function loadDrill() {
  return (await import(join(root, 'scripts', 'r2-restore-drill.mjs'))) as {
    runRestoreDrill: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
    backupTime: (name: string) => Date | undefined;
  };
}

function makeBackup(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'mintbot-drill-test-'));
  const Database = createRequire(join(root, 'packages', 'database', 'package.json'))('better-sqlite3') as new (path: string) => { pragma(s: string): unknown; exec(s: string): void; close(): void };
  const store = join(dir, 'state.sqlite');
  const db = new Database(store);
  db.pragma('journal_mode = WAL');
  db.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO probe VALUES (1, 'durable');");
  db.close();
  const backups = join(dir, 'backups');
  mkdirSync(backups);
  execFileSync(process.execPath, [join(root, 'scripts', 'backup.mjs')], { env: { PATH: process.env.PATH ?? '', STORE_PATH: store, BACKUP_DIR: backups, BACKUP_ENCRYPTION_KEY: KEY } });
  const file = readdirSync(backups).find((name) => name.endsWith('.snapshot.enc'));
  if (!file) throw new Error('no backup made');
  return { dir: backups, file };
}

const env = (dir: string): Record<string, string> => {
  const keyFile = join(dir, 'key');
  writeFileSync(keyFile, KEY, { mode: 0o600 });
  return { PATH: process.env.PATH ?? '', R2_ACCOUNT_ID: 'a'.repeat(32), R2_BUCKET_NAME: 'test-bucket', R2_OBJECT_PREFIX: 'mintbot', MINT_BOT_HOST_ID: 'host-a', R2_ACCESS_KEY_ID: 'id', R2_SECRET_ACCESS_KEY: 'secret', MINT_BOT_OFFHOST_BACKUP_REQUIRED: 'true', BACKUP_ENCRYPTION_KEY_FILE: keyFile };
};

const fakeClient = (dir: string, calls: string[]) => ({
  async send(command: { input: { Key: string } }) {
    const name = command.input.Key.split('/').at(-1) as string;
    calls.push(command.input.Key);
    const bytes = readFileSync(join(dir, name));
    return { Body: { transformToByteArray: async () => new Uint8Array(bytes) } };
  },
});

describe('R2 restore drill (T-048)', () => {
  it('parses the backup time from the file name', async () => {
    const { backupTime } = await loadDrill();
    expect(backupTime('mintbot.sqlite.2026-10-22T19-12-44.561Z.snapshot.enc')?.toISOString()).toBe('2026-10-22T19:12:44.561Z');
    expect(backupTime('weird.enc')).toBeUndefined();
  });

  it('downloads the snapshot and its checksum, verifies them, reports the timings and removes the scratch folder', async () => {
    const { runRestoreDrill } = await loadDrill();
    const { dir, file } = makeBackup();
    const calls: string[] = [];
    const work = mkdtempSync(join(tmpdir(), 'mintbot-drill-work-'));
    const result = await runRestoreDrill({ fileName: file, environment: env(dir), client: fakeClient(dir, calls), workParent: work });
    expect(result.status).toBe('ok');
    expect(calls).toEqual([`mintbot/host-a/${file}`, `mintbot/host-a/${file}.sha256`]);
    expect(typeof result.restoreSeconds).toBe('number');
    expect(readdirSync(work)).toEqual([]);
  });

  it('fails closed on a wrong key, a tampered snapshot and an invalid file name, and still cleans up', async () => {
    const { runRestoreDrill } = await loadDrill();
    const { dir, file } = makeBackup();
    const work = mkdtempSync(join(tmpdir(), 'mintbot-drill-work-'));
    const wrong = env(dir);
    writeFileSync(wrong.BACKUP_ENCRYPTION_KEY_FILE as string, 'b'.repeat(40));
    await expect(runRestoreDrill({ fileName: file, environment: wrong, client: fakeClient(dir, []), workParent: work })).rejects.toThrow();
    const bytes = readFileSync(join(dir, file));
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
    writeFileSync(join(dir, file), bytes);
    await expect(runRestoreDrill({ fileName: file, environment: env(dir), client: fakeClient(dir, []), workParent: work })).rejects.toThrow();
    await expect(runRestoreDrill({ fileName: '../etc/passwd', environment: env(dir), client: fakeClient(dir, []), workParent: work })).rejects.toThrow('BACKUP_FILE_NAME_INVALID');
    expect(readdirSync(work)).toEqual([]);
  });
});

describe('started through a link (the host runs scripts via /opt/mint-bot/current)', () => {
  it('the drill still runs its main code: it prints a JSON failure for a missing file name instead of exiting silently', () => {
    const base = mkdtempSync(join(tmpdir(), 'mintbot-drill-link-'));
    symlinkSync(root, join(base, 'current'));
    const result = spawnSync(process.execPath, [join(base, 'current', 'scripts', 'r2-restore-drill.mjs')], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', R2_ACCOUNT_ID: 'a'.repeat(32), R2_BUCKET_NAME: 'test-bucket', MINT_BOT_HOST_ID: 'host-a', R2_ACCESS_KEY_ID: 'id', R2_SECRET_ACCESS_KEY: 'secret' } });
    expect(JSON.parse(result.stdout.trim())).toEqual({ status: 'failed', code: 'BACKUP_FILE_NAME_INVALID' });
    expect(result.status).toBe(1);
  });
});
