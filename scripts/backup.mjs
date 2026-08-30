import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const source = resolve(process.env.STORE_PATH ?? '');
const destinationRoot = resolve(process.env.BACKUP_DIR ?? '');
const retentionDays = Number(process.env.BACKUP_RETENTION_DAYS ?? 30);
if (!process.env.STORE_PATH || !process.env.BACKUP_DIR || source === destinationRoot || destinationRoot.startsWith(`${source}${process.platform === 'win32' ? '\\' : '/'}`)) {
  throw new Error('STORE_PATH and BACKUP_DIR must be separate explicit paths');
}
if (retentionDays !== 30) throw new Error('Encrypted backup retention must be exactly 30 days');

await mkdir(destinationRoot, { recursive: true });
const target = resolve(destinationRoot, `${basename(source)}.${new Date().toISOString().replaceAll(':', '-')}.snapshot`);
await new Promise((resolvePromise, reject) => {
  const child = spawn('sqlite3', [source, `VACUUM INTO '${target.replaceAll("'", "''")}'`], { stdio: 'ignore' });
  child.once('error', () => reject(new Error('sqlite3 is required for a consistent backup snapshot')));
  child.once('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`sqlite3 backup failed with exit code ${code}`)));
});
await access(target);
const checksum = createHash('sha256').update(await readFile(target)).digest('hex');
await writeFile(`${target}.sha256`, `${checksum}  ${basename(target)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ status: 'ok', file: basename(target), sha256: checksum, retentionDays }));
