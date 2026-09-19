import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../packages/database/package.json', import.meta.url));
const Database = require('better-sqlite3');

const source = resolve(process.env.STORE_PATH ?? '');
const destinationRoot = resolve(process.env.BACKUP_DIR ?? '');
const statusPath = process.env.BACKUP_STATUS_PATH ?? process.env.MINT_BOT_BACKUP_STATUS_PATH;
const retentionDays = Number(process.env.BACKUP_RETENTION_DAYS ?? 30);
if (!process.env.STORE_PATH || !process.env.BACKUP_DIR || source === destinationRoot || destinationRoot.startsWith(`${source}${process.platform === 'win32' ? '\\' : '/'}`)) {
  throw new Error('STORE_PATH and BACKUP_DIR must be separate explicit paths');
}
if (retentionDays !== 30) throw new Error('Encrypted backup retention must be exactly 30 days');
if (!process.env.BACKUP_ENCRYPTION_KEY) throw new Error('BACKUP_ENCRYPTION_KEY_REQUIRED');

await mkdir(destinationRoot, { recursive: true });
const temporary = resolve(destinationRoot, `.${basename(source)}.${process.pid}.snapshot.tmp`);
const target = resolve(destinationRoot, `${basename(source)}.${new Date().toISOString().replaceAll(':', '-')}.snapshot.enc`);
const database = new Database(source, { readonly: true, fileMustExist: true });
try {
  await database.backup(temporary);
} finally {
  database.close();
}
try {
  await access(temporary);
  const plaintext = await readFile(temporary);
  const iv = randomBytes(12);
  const key = createHash('sha256').update(process.env.BACKUP_ENCRYPTION_KEY, 'utf8').digest();
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const header = Buffer.from('MINTBOT1', 'ascii');
  const authTag = cipher.getAuthTag();
  await writeFile(target, Buffer.concat([header, iv, authTag, ciphertext]), { mode: 0o600 });
} finally {
  await rm(temporary, { force: true });
}
await access(target);
const checksum = createHash('sha256').update(await readFile(target)).digest('hex');
await writeFile(`${target}.sha256`, `${checksum}  ${basename(target)}\n`, { mode: 0o600 });
if (statusPath) {
  await mkdir(dirname(resolve(statusPath)), { recursive: true, mode: 0o700 });
  await writeFile(statusPath, `${JSON.stringify({ status: 'ok', operation: 'backup', file: basename(target), sha256: checksum, encrypted: true, retentionDays, recordedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
}
console.log(JSON.stringify({ status: 'ok', file: basename(target), sha256: checksum, encrypted: true, retentionDays }));
