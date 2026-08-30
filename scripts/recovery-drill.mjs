import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const root = await mkdtemp(join(tmpdir(), 'mint-bot-recovery-'));
const store = join(root, 'state.sqlite');
const backupDir = join(root, 'backups');
const killSwitch = join(root, 'killswitch');
const script = (name) => join(process.cwd(), 'scripts', name);

function run(command, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} failed with exit code ${code}`)));
  });
}

try {
  await run('sqlite3', [store, 'CREATE TABLE recovery_probe (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO recovery_probe VALUES (1, "durable");']);
  await writeFile(killSwitch, '', { mode: 0o600 });
  await run(process.execPath, [script('backup.mjs')], { STORE_PATH: store, BACKUP_DIR: backupDir, BACKUP_RETENTION_DAYS: '30' });
  const snapshot = (await readdir(backupDir)).find((entry) => entry.endsWith('.snapshot'));
  if (!snapshot) throw new Error('Recovery drill did not produce a snapshot');
  await run(process.execPath, [script('restore-check.mjs')], { RESTORE_SNAPSHOT: join(backupDir, snapshot), KILL_SWITCH_PATH: killSwitch });
  console.log(JSON.stringify({ status: 'ok', drill: 'sqlite-backup-restore', killSwitch: 'engaged', retentionDays: 30 }));
} finally {
  await rm(root, { recursive: true, force: true });
}
