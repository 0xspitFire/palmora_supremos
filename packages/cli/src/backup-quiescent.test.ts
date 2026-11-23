import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The backup account cannot write the database folder. A cleanly stopped service leaves no -wal/-shm files, and SQLite cannot open
 * a WAL database read-only in that state. backup.mjs then snapshots a verified copy, and refuses when any side file exists.
 * Root ignores folder permissions, so these tests need an ordinary user (CI and the owner's PC are).
 */
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const KEY = 'k'.repeat(40);
const ordinaryUser = typeof process.getuid === 'function' && process.getuid() !== 0;

it('copies one read snapshot even when a WAL writer commits before the first backup batch', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mintbot-pinned-backup-'));
  const store = join(directory, 'source.sqlite');
  const destination = join(directory, 'snapshot.sqlite');
  const Database = createRequire(join(root, 'packages', 'database', 'package.json'))('better-sqlite3') as new (
    path: string, options?: { readonly: boolean },
  ) => Db & {
    readonly inTransaction: boolean;
    prepare(sql: string): { get(): { v: string } };
    backup(path: string, options: { progress(): void }): Promise<unknown>;
  };
  const helperPath = join(root, 'scripts', 'backup-snapshot.mjs');
  const { copyBackupSnapshot } = await import(helperPath) as {
    copyBackupSnapshot(database: Pick<InstanceType<typeof Database>, 'exec' | 'inTransaction' | 'prepare'> & {
      backup(path: string): Promise<unknown>;
    }, path: string): Promise<void>;
  };
  const writer = new Database(store);
  writer.pragma('journal_mode = WAL');
  writer.exec(`CREATE TABLE probe (id INTEGER PRIMARY KEY, v TEXT);
    INSERT INTO probe VALUES (1, 'before');
    INSERT INTO probe VALUES (2, hex(zeroblob(500000)));`);
  const reader = new Database(store, { readonly: true });
  try {
    let committed = false;
    await copyBackupSnapshot({
      exec: reader.exec.bind(reader),
      get inTransaction() { return reader.inTransaction; },
      prepare: reader.prepare.bind(reader),
      backup: (path) => reader.backup(path, { progress() {
        if (!committed) {
          writer.exec("UPDATE probe SET v = 'after' WHERE id = 1");
          committed = true;
        }
      } }),
    }, destination);
    expect(committed).toBe(true);
    expect(reader.inTransaction).toBe(false);
    const snapshot = new Database(destination, { readonly: true });
    try {
      expect(snapshot.prepare('SELECT v FROM probe WHERE id = 1').get().v).toBe('before');
      expect(writer.prepare('SELECT v FROM probe WHERE id = 1').get().v).toBe('after');
    } finally {
      snapshot.close();
    }
  } finally {
    reader.close();
    writer.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

type Db = { pragma(s: string): unknown; exec(s: string): void; close(): void };
function setup(): { dbDir: string; store: string; backups: string } {
  const base = mkdtempSync(join(tmpdir(), 'mintbot-quiet-'));
  const dbDir = join(base, 'db');
  const backups = join(base, 'backups');
  mkdirSync(dbDir);
  mkdirSync(backups);
  const store = join(dbDir, 'mintbot.sqlite');
  const Database = createRequire(join(root, 'packages', 'database', 'package.json'))('better-sqlite3') as new (path: string) => Db;
  const db = new Database(store);
  db.pragma('journal_mode = WAL');
  db.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO probe VALUES (1, 'durable');");
  db.close();
  return { dbDir, store, backups };
}
const runBackup = (store: string, backups: string) => spawnSync(process.execPath, [join(root, 'scripts', 'backup.mjs')], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', STORE_PATH: store, BACKUP_DIR: backups, BACKUP_ENCRYPTION_KEY: KEY } });

describe.skipIf(!ordinaryUser)('backup of a quiescent database the backup account cannot write', () => {
  it('snapshots a verified copy when the folder is read-only and no side files exist, leaving no temporary copy behind', () => {
    const { dbDir, store, backups } = setup();
    expect(readdirSync(dbDir)).toEqual(['mintbot.sqlite']);
    chmodSync(dbDir, 0o555);
    try {
      const result = runBackup(store, backups);
      expect(result.status, result.stderr).toBe(0);
      const files = readdirSync(backups);
      const snapshot = files.find((name) => name.endsWith('.snapshot.enc'));
      expect(snapshot).toBeDefined();
      expect(files.filter((name) => name.startsWith('.'))).toEqual([]);
      const check = execFileSync(process.execPath, [join(root, 'scripts', 'restore-check.mjs')], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', RESTORE_SNAPSHOT: join(backups, snapshot as string), RESTORE_VERIFICATION_ONLY: 'true', BACKUP_ENCRYPTION_KEY: KEY } });
      expect(JSON.parse(check.trim().split('\n').at(-1) as string).status).toBe('ok');
    } finally {
      chmodSync(dbDir, 0o755);
    }
  });

  it('fails closed when a -wal or -shm file exists (a process may have the database open, or it was not recovered)', () => {
    for (const side of ['-wal', '-shm']) {
      const { dbDir, store, backups } = setup();
      writeFileSync(`${store}${side}`, Buffer.alloc(32));
      chmodSync(dbDir, 0o555);
      try {
        const result = runBackup(store, backups);
        expect(result.status).not.toBe(0);
        expect(readdirSync(backups)).toEqual([]);
      } finally {
        chmodSync(dbDir, 0o755);
      }
    }
  });
});
