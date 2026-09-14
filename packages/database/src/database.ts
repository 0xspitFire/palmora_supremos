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
  const applied = new Map((db.prepare('SELECT version, name FROM schema_migrations').all() as Array<{ version: number; name: string }>).map((row) => [row.version, row.name]));
  const migrations = readdirSync(migrationsDirectory)
    .filter((file) => /^\d+_.+\.sql$/.test(file))
    .map((file) => {
      const match = /^(\d+)_/.exec(file);
      if (!match) throw new Error(`invalid migration filename: ${file}`);
      return { file, version: Number(match[1]) };
    })
    .sort((left, right) => left.version - right.version || left.file.localeCompare(right.file));
  for (let index = 1; index < migrations.length; index += 1) {
    const previous = migrations[index - 1];
    const current = migrations[index];
    if (previous !== undefined && current !== undefined && previous.version === current.version) {
      throw new Error(`duplicate migration version: ${current.version}`);
    }
  }
  for (const migration of migrations) {
    const existingName = applied.get(migration.version);
    if (existingName !== undefined) {
      if (existingName !== migration.file) throw new Error(`migration ${migration.version} name mismatch: ${existingName} != ${migration.file}`);
      continue;
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(readFileSync(join(migrationsDirectory, migration.file), 'utf8'));
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(migration.version, migration.file, new Date().toISOString());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

export async function backupDatabase(db: SqliteDatabase, destination: string): Promise<void> {
  await db.backup(destination);
}

export interface BackupVerification {
  sha256: string;
  schemaVersion: number;
  integrityCheck: 'ok';
  foreignKeyViolations: number;
}

export function verifyBackup(destination: string): BackupVerification {
  const checksum = createHash('sha256').update(readFileSync(destination)).digest('hex');
  const backup = new Database(destination, { readonly: true });
  try {
    const integrity = backup.pragma('integrity_check', { simple: true }) as string;
    if (integrity !== 'ok') throw new Error(`backup integrity check failed: ${integrity}`);
    const foreignKeyViolations = (backup.pragma('foreign_key_check') as Array<unknown>).length;
    if (foreignKeyViolations !== 0) throw new Error(`backup foreign-key check failed: ${foreignKeyViolations} violations`);
    const row = backup.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null };
    if (row.version === null) throw new Error('backup has no schema migration version');
    return { sha256: checksum, schemaVersion: row.version, integrityCheck: 'ok', foreignKeyViolations };
  } finally {
    backup.close();
  }
}

export function pruneRawObservations(db: SqliteDatabase, olderThan: Date): number {
  const result = db.prepare('DELETE FROM raw_observation WHERE observed_at < ?').run(olderThan.toISOString());
  return result.changes;
}
