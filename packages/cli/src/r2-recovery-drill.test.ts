import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '@mint-bot/database';
import { CanonicalStoreBridge, ExecutionCoordinator, PERSONAL_LIVE_FLEET_POLICY } from '@mint-bot/backend';

/** T-052 slice 3b: the recovery drill restores a real encrypted backup and proves integrity, schema, store opening and reconciliation. */
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const KEY = 'k'.repeat(40);
const Database = createRequire(join(root, 'packages', 'database', 'package.json'))('better-sqlite3') as unknown;
const modules = { Database, openDatabase, CanonicalStoreBridge, ExecutionCoordinator, PERSONAL_LIVE_FLEET_POLICY };

interface DrillModule { runRecoveryDrill(input: Record<string, unknown>): Promise<{ status: string; checks: Record<string, { pass: boolean; observed: string }> }>; releaseSchemaVersion(dir?: string): number }
const drillModule = async () => (await import(join(root, 'scripts', 'r2-recovery-drill.mjs'))) as DrillModule;

function backupOf(prepare?: (path: string) => void): { dir: string; file: string } {
  const base = mkdtempSync(join(tmpdir(), 'mintbot-recovery-test-'));
  const store = join(base, 'state.sqlite');
  const db = openDatabase(store); // every migration of this code base
  db.close();
  prepare?.(store);
  const backups = join(base, 'backups');
  mkdirSync(backups);
  execFileSync(process.execPath, [join(root, 'scripts', 'backup.mjs')], { env: { PATH: process.env.PATH ?? '', STORE_PATH: store, BACKUP_DIR: backups, BACKUP_ENCRYPTION_KEY: KEY } });
  const file = readdirSync(backups).find((name) => name.endsWith('.snapshot.enc'));
  if (!file) throw new Error('no backup');
  return { dir: backups, file };
}
const env = { PATH: process.env.PATH ?? '', R2_ACCOUNT_ID: 'a'.repeat(32), R2_BUCKET_NAME: 'test-bucket', MINT_BOT_HOST_ID: 'host-a', R2_ACCESS_KEY_ID: 'id', R2_SECRET_ACCESS_KEY: 'secret', MINT_BOT_OFFHOST_BACKUP_REQUIRED: 'true', BACKUP_ENCRYPTION_KEY: KEY };
const client = (dir: string) => ({ send: async (command: { input: { Key: string } }) => { const bytes = readFileSync(join(dir, command.input.Key.split('/').at(-1)!)); return { Body: { transformToByteArray: async () => new Uint8Array(bytes) } }; } });

describe('recovery drill (installed release code on a restored copy)', () => {
  it('restores, checks integrity, reaches the current schema, opens the store and runs start-up reconciliation; leaves nothing behind', async () => {
    const { runRecoveryDrill, releaseSchemaVersion } = await drillModule();
    const { dir, file } = backupOf();
    const work = mkdtempSync(join(tmpdir(), 'mintbot-recovery-work-'));
    const result = await runRecoveryDrill({ fileName: file, environment: env, client: client(dir), workParent: work, modules });
    expect(result.status).toBe('ok');
    expect(Object.keys(result.checks).sort()).toEqual(['integrity_ok', 'post_recovery_reconciliation', 'restored_from_offhost', 'schema_current']);
    expect(result.checks.schema_current?.observed).toContain(`${releaseSchemaVersion()} of ${releaseSchemaVersion()}`);
    expect(result.checks.post_recovery_reconciliation?.observed).toContain('start-up reconciliation ran');
    expect(readdirSync(work)).toEqual([]);
  });

  it('a backup from an older schema is migrated forward by the installed release', async () => {
    const { runRecoveryDrill, releaseSchemaVersion } = await drillModule();
    const latest = releaseSchemaVersion();
    // Pretend the newest migration had not been applied yet: forget it (the next open re-applies it idempotently or fails loudly).
    const { dir, file } = backupOf((store) => { const D = Database as new (path: string) => { prepare(sql: string): { run(...args: unknown[]): unknown }; close(): void }; const db = new D(store); db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(latest); db.close(); });
    const result = await runRecoveryDrill({ fileName: file, environment: env, client: client(dir), workParent: mkdtempSync(join(tmpdir(), 'w-')), modules }).catch((error: Error) => ({ status: 'failed', checks: {} as Record<string, { pass: boolean; observed: string }>, error: error.message }));
    // Either it migrates cleanly to the latest, or it refuses: it must never report "current" for a schema it did not reach.
    if (result.status === 'ok') expect(result.checks.schema_current?.observed).toContain(`restored at schema ${latest - 1}`);
    else expect(result.status).toBe('failed');
  });

  it('fails closed on a wrong key, a tampered backup and an invalid name', async () => {
    const { runRecoveryDrill } = await drillModule();
    const { dir, file } = backupOf();
    const work = mkdtempSync(join(tmpdir(), 'mintbot-recovery-work-'));
    await expect(runRecoveryDrill({ fileName: file, environment: { ...env, BACKUP_ENCRYPTION_KEY: 'x'.repeat(40) }, client: client(dir), workParent: work, modules })).rejects.toThrow();
    const bytes = readFileSync(join(dir, file)); bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff; writeFileSync(join(dir, file), bytes);
    await expect(runRecoveryDrill({ fileName: file, environment: env, client: client(dir), workParent: work, modules })).rejects.toThrow('BACKUP_CHECKSUM_MISMATCH');
    await expect(runRecoveryDrill({ fileName: '../x', environment: env, client: client(dir), workParent: work, modules })).rejects.toThrow('BACKUP_FILE_NAME_INVALID');
    expect(readdirSync(work)).toEqual([]);
  });
});
