import Database from 'better-sqlite3';
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
