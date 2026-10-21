// systemd-facing wrapper. Credentials stay in LoadCredential files; neither
// this process nor the child puts their contents in an environment variable.
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const directory = process.env.CREDENTIALS_DIRECTORY;
if (!directory) throw new Error('SYSTEMD_CREDENTIALS_REQUIRED');

const script = resolve(new URL('./backup-job.mjs', import.meta.url).pathname);
try {
  const childEnvironment = { ...process.env };
  delete childEnvironment.BACKUP_ENCRYPTION_KEY;
  delete childEnvironment.R2_ACCESS_KEY_ID;
  delete childEnvironment.R2_SECRET_ACCESS_KEY;
  const child = await run(process.execPath, [script], {
    env: {
      ...childEnvironment,
      BACKUP_ENCRYPTION_KEY_FILE: resolve(directory, 'backup-encryption-key'),
      R2_ACCESS_KEY_ID_FILE: resolve(directory, 'r2-access-key-id'),
      R2_SECRET_ACCESS_KEY_FILE: resolve(directory, 'r2-secret-access-key'),
    },
    timeout: 10 * 60_000,
    maxBuffer: 1024 * 1024,
  });
  process.stdout.write(child.stdout);
} catch (error) {
  const output = error && typeof error === 'object' && 'stdout' in error ? String(error.stdout ?? '') : '';
  process.stdout.write(output || '{"status":"failed","code":"BACKUP_SERVICE_FAILED"}\n');
  process.exitCode = 1;
}
