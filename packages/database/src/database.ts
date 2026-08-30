import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export type SqliteDatabase = Database.Database;

export function openDatabase(filename = ':memory:'): SqliteDatabase {
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

export function migrate(db: SqliteDatabase): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const applied = new Set((db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map((row) => row.version));
  const migrations = readdirSync(migrationsDirectory).filter((file) => /^\d+_.+\.sql$/.test(file)).sort();
  for (const file of migrations) {
    const match = /^(\d+)_/.exec(file);
    if (!match) continue;
    const version = Number(match[1]);
    if (applied.has(version)) continue;
    const applyMigration = db.transaction(() => {
      db.exec(readFileSync(join(migrationsDirectory, file), 'utf8'));
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(version, file, new Date().toISOString());
    });
    applyMigration();
  }
}

export async function backupDatabase(db: SqliteDatabase, destination: string): Promise<void> {
  await db.backup(destination);
}

export interface BackupVerification {
  sha256: string;
  schemaVersion: number;
}

export function verifyBackup(destination: string): BackupVerification {
  const checksum = createHash('sha256').update(readFileSync(destination)).digest('hex');
  const backup = new Database(destination, { readonly: true });
  try {
    const row = backup.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null };
    if (row.version === null) throw new Error('backup has no schema migration version');
    return { sha256: checksum, schemaVersion: row.version };
  } finally {
    backup.close();
  }
}

export function pruneRawObservations(db: SqliteDatabase, olderThan: Date): number {
  const result = db.prepare('DELETE FROM raw_observation WHERE observed_at < ?').run(olderThan.toISOString());
  return result.changes;
}
