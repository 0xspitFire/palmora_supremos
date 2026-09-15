import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export type SqliteDatabase = Database.Database;

interface MigrationDefinition {
  file: string;
  version: number;
  checksum: string;
}

function migrationDefinitions(): MigrationDefinition[] {
  const migrations = readdirSync(migrationsDirectory)
    .filter((file) => /^\d+_.+\.sql$/.test(file))
    .map((file) => {
      const match = /^(\d+)_/.exec(file);
      if (!match) throw new Error(`invalid migration filename: ${file}`);
      return { file, version: Number(match[1]), checksum: createHash('sha256').update(readFileSync(join(migrationsDirectory, file))).digest('hex') };
    })
    .sort((left, right) => left.version - right.version || left.file.localeCompare(right.file));
  for (let index = 1; index < migrations.length; index += 1) {
    const previous = migrations[index - 1];
    const current = migrations[index];
    if (previous !== undefined && current !== undefined && previous.version === current.version) throw new Error(`duplicate migration version: ${current.version}`);
  }
  return migrations;
}

function hasColumn(db: SqliteDatabase, table: string, column: string): boolean {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).some((entry) => entry.name === column);
}

function isMemoryDatabase(filename: string): boolean {
  return filename === ':memory:' || filename.startsWith('file::memory:');
}

function waitForDatabaseLock(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function enableWal(db: SqliteDatabase): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return db.pragma('journal_mode = WAL', { simple: true }) as string;
    } catch (error) {
      if (!(error instanceof Error) || !/database is locked|database table is locked|busy/i.test(error.message) || attempt === 99) throw error;
      waitForDatabaseLock(50);
    }
  }
  throw new Error('unable to enable SQLite WAL');
}

export function openDatabase(filename = ':memory:'): SqliteDatabase {
  const db = new Database(filename);
  db.pragma('busy_timeout = 5000');
  const journalMode = enableWal(db);
  if (!isMemoryDatabase(filename) && journalMode.toLowerCase() !== 'wal') {
    db.close();
    throw new Error(`file-backed SQLite must use WAL, received ${journalMode}`);
  }
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  migrate(db);
  return db;
}

export function migrate(db: SqliteDatabase): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const migrations = migrationDefinitions();
  if (db.inTransaction) throw new Error('cannot migrate while another SQLite transaction is active');
  db.exec('BEGIN IMMEDIATE');
  try {
    let hasChecksums = hasColumn(db, 'schema_migrations', 'checksum');
    const applied = (db.prepare(`SELECT version, name${hasChecksums ? ', checksum' : ''} FROM schema_migrations`).all() as Array<{ version: number; name: string; checksum?: string | null }>);
    const definitionsByVersion = new Map(migrations.map((migration) => [migration.version, migration]));
    for (const row of applied) {
      const definition = definitionsByVersion.get(row.version);
      if (!definition) throw new Error(`unknown applied migration version: ${row.version}`);
      if (definition.file !== row.name) throw new Error(`migration ${row.version} name mismatch: ${row.name} != ${definition.file}`);
      if (row.checksum !== undefined && row.checksum !== null && row.checksum !== definition.checksum) throw new Error(`migration ${row.version} checksum mismatch`);
    }
    const appliedVersions = new Set(applied.map((row) => row.version));
    for (const migration of migrations) {
      if (appliedVersions.has(migration.version)) continue;
      db.exec(readFileSync(join(migrationsDirectory, migration.file), 'utf8'));
      hasChecksums = hasColumn(db, 'schema_migrations', 'checksum');
      if (hasChecksums) {
        db.prepare('INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)').run(migration.version, migration.file, new Date().toISOString(), migration.checksum);
      } else {
        db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(migration.version, migration.file, new Date().toISOString());
      }
    }
    if (hasColumn(db, 'schema_migrations', 'checksum')) {
      const updateChecksum = db.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = ? AND checksum IS NULL');
      for (const migration of migrations) updateChecksum.run(migration.checksum, migration.version);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export async function backupDatabase(db: SqliteDatabase, destination: string): Promise<void> {
  const temporaryDirectory = mkdtempSync(join(dirname(destination), '.mintbot-backup-'));
  const temporaryDestination = join(temporaryDirectory, 'state.sqlite');
  try {
    await db.backup(temporaryDestination);
    verifyBackup(temporaryDestination);
    renameSync(temporaryDestination, destination);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function restoreDatabase(source: string, destination: string): Promise<BackupVerification> {
  const sourceVerification = verifyBackup(source);
  const sourceDb = new Database(source, { readonly: true });
  try {
    await backupDatabase(sourceDb, destination);
  } finally {
    sourceDb.close();
  }
  const restored = verifyBackup(destination);
  if (restored.schemaVersion !== sourceVerification.schemaVersion) throw new Error('restored backup schema version mismatch');
  return restored;
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
    backup.pragma('foreign_keys = ON');
    const integrity = backup.pragma('integrity_check', { simple: true }) as string;
    if (integrity !== 'ok') throw new Error(`backup integrity check failed: ${integrity}`);
    const foreignKeyViolations = (backup.pragma('foreign_key_check') as Array<unknown>).length;
    if (foreignKeyViolations !== 0) throw new Error(`backup foreign-key check failed: ${foreignKeyViolations} violations`);
    const migrations = migrationDefinitions();
    if (!hasColumn(backup, 'schema_migrations', 'checksum')) throw new Error('backup has no migration checksums');
    const rows = backup.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all() as Array<{ version: number; name: string; checksum: string | null }>;
    if (rows.length !== migrations.length) throw new Error(`backup schema migration count mismatch: ${rows.length} != ${migrations.length}`);
    for (const [index, migration] of migrations.entries()) {
      const row = rows[index];
      if (row === undefined || row.version !== migration.version || row.name !== migration.file || row.checksum !== migration.checksum) throw new Error(`backup migration mismatch at version ${migration.version}`);
    }
    const requiredTables = ['schema_migrations', 'chain_profile', 'wallet', 'campaign', 'fee_policy', 'spend_policy', 'transaction_intent', 'transaction_attempt', 'transaction_receipt', 'execution', 'execution_run', 'spend_reservation', 'spend_ledger_entry', 'state_transition', 'audit_event', 'reconciliation_record', 'campaign_wallet', 'campaign_period', 'reorg_event', 'reorg_resolution', 'simulation', 'retention_policy', 'retention_evidence', 'backup_policy', 'backup_restore_evidence'];
    const objects = new Set((backup.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')").all() as Array<{ name: string }>).map((row) => row.name));
    for (const table of requiredTables) if (!objects.has(table)) throw new Error(`backup is missing required object: ${table}`);
    return { sha256: checksum, schemaVersion: migrations[migrations.length - 1]?.version ?? 0, integrityCheck: 'ok', foreignKeyViolations };
  } finally {
    backup.close();
  }
}

export function pruneRawObservations(db: SqliteDatabase, olderThan: Date): number {
  if (Number.isNaN(olderThan.getTime())) throw new Error('retention cutoff must be a valid date');
  if (db.inTransaction) throw new Error('cannot prune while another SQLite transaction is active');
  db.exec('BEGIN IMMEDIATE');
  try {
    const policy = db.prepare("SELECT id, retention_days FROM retention_policy WHERE entity_type = 'raw_observation' AND active = 1 AND retain_indefinitely = 0 LIMIT 1").get() as { id: string; retention_days: number } | undefined;
    if (!policy) throw new Error('active raw-observation retention policy not found');
    const minimumCutoff = Date.now() - policy.retention_days * 86_400_000;
    if (olderThan.getTime() > minimumCutoff) throw new Error('retention cutoff exceeds the approved raw-observation retention window');
    const result = db.prepare('DELETE FROM raw_observation WHERE observed_at < ?').run(olderThan.toISOString());
    const retained = db.prepare('SELECT COUNT(*) AS count FROM raw_observation').get() as { count: number };
    db.prepare("INSERT INTO retention_evidence (id, policy_id, entity_type, cutoff_at, rows_deleted, rows_retained, outcome, evidence_json, recorded_at) VALUES (?, ?, 'raw_observation', ?, ?, ?, 'passed', ?, ?)").run(randomUUID(), policy.id, olderThan.toISOString(), result.changes, retained.count, JSON.stringify({ source: 'pruneRawObservations', retentionDays: policy.retention_days }), new Date().toISOString());
    db.exec('COMMIT');
    return result.changes;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
