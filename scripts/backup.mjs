import { access, chmod, copyFile, constants, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
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
async function backupKey() {
  const value = process.env.BACKUP_ENCRYPTION_KEY ?? (process.env.BACKUP_ENCRYPTION_KEY_FILE ? (await readFile(resolve(process.env.BACKUP_ENCRYPTION_KEY_FILE), 'utf8')).trim() : '');
  if (value.length < 32 || /[\r\n]/.test(value)) throw new Error('BACKUP_ENCRYPTION_KEY_REQUIRED');
  return value;
}

await mkdir(destinationRoot, { recursive: true });
const sourceMetadata = await lstat(source);
if (!sourceMetadata.isFile() || sourceMetadata.isSymbolicLink()) throw new Error('STORE_PATH_MUST_BE_REGULAR_FILE');
const destinationMetadata = await lstat(destinationRoot);
if (!destinationMetadata.isDirectory() || destinationMetadata.isSymbolicLink()) throw new Error('BACKUP_DIR_MUST_BE_REGULAR_DIRECTORY');
const temporary = resolve(destinationRoot, `.${basename(source)}.${process.pid}.snapshot.tmp`);
const target = resolve(destinationRoot, `${basename(source)}.${new Date().toISOString().replaceAll(':', '-')}.snapshot.enc`);
async function exists(path) {
  try { await lstat(path); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}
const identity = (metadata) => `${metadata.size}:${metadata.mtimeMs}:${metadata.ino}`;
/**
 * Normally the database is opened read-only in place. A cleanly stopped service leaves no -wal/-shm files, and the backup account
 * (which may not write the database folder) cannot open a WAL database in that state. A running service always keeps both side
 * files, so when neither exists nobody has the database open: copy the file into the backup account's own folder, prove the source
 * did not change while copying and no side file appeared, and snapshot the copy. Any side file means "busy or unrecovered": refuse.
 */
async function openForBackup() {
  let direct;
  try {
    direct = new Database(source, { readonly: true, fileMustExist: true });
    // The open itself succeeds; the refusal only shows at the first query.
    direct.pragma('journal_mode', { simple: true });
    return { database: direct, copy: undefined };
  } catch (error) {
    direct?.close();
    if (error?.code !== 'SQLITE_READONLY_DIRECTORY' && error?.code !== 'SQLITE_CANTOPEN') throw error;
  }
  if ((await exists(`${source}-wal`)) || (await exists(`${source}-shm`))) throw new Error('SQLITE_SOURCE_BUSY_OR_UNRECOVERED');
  const copy = resolve(destinationRoot, `.${basename(source)}.${process.pid}.quiet-copy.tmp`);
  try {
    const before = await lstat(source);
    await copyFile(source, copy, constants.COPYFILE_EXCL);
    await chmod(copy, 0o600);
    const after = await lstat(source);
    if (identity(before) !== identity(after) || (await exists(`${source}-wal`)) || (await exists(`${source}-shm`))) throw new Error('SQLITE_SOURCE_CHANGED_DURING_COPY');
    return { database: new Database(copy, { fileMustExist: true }), copy };
  } catch (error) {
    await rm(copy, { force: true });
    throw error;
  }
}
const { database, copy: quietCopy } = await openForBackup();
try {
  if (database.pragma('journal_mode', { simple: true }) !== 'wal') throw new Error('SQLITE_WAL_REQUIRED');
  if (database.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('SQLITE_INTEGRITY_CHECK_FAILED');
  await database.backup(temporary);
} finally {
  database.close();
  if (quietCopy) await Promise.all([quietCopy, `${quietCopy}-wal`, `${quietCopy}-shm`].map((path) => rm(path, { force: true })));
}
try {
  await access(temporary);
  const plaintext = await readFile(temporary);
  const iv = randomBytes(12);
  const key = createHash('sha256').update(await backupKey(), 'utf8').digest();
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const header = Buffer.from('MINTBOT1', 'ascii');
  const authTag = cipher.getAuthTag();
  const encrypted = Buffer.concat([header, iv, authTag, ciphertext]);
  const encryptedTemporary = `${target}.${process.pid}.tmp`;
  await writeFile(encryptedTemporary, encrypted, { encoding: null, mode: 0o600, flag: 'wx' });
  await rename(encryptedTemporary, target);
} finally {
  await rm(temporary, { force: true });
}
await access(target);
const checksum = createHash('sha256').update(await readFile(target)).digest('hex');
const checksumPath = `${target}.sha256`;
const checksumTemporary = `${checksumPath}.${process.pid}.tmp`;
await writeFile(checksumTemporary, `${checksum}  ${basename(target)}\n`, { mode: 0o600, flag: 'wx' });
await rename(checksumTemporary, checksumPath);
if (statusPath) {
  await mkdir(dirname(resolve(statusPath)), { recursive: true, mode: 0o750 });
  const statusTemporary = `${resolve(statusPath)}.${process.pid}.tmp`;
  await writeFile(statusTemporary, `${JSON.stringify({ status: 'ok', operation: 'backup', file: basename(target), sha256: checksum, encrypted: true, retentionDays, recordedAt: new Date().toISOString() })}\n`, { mode: 0o640, flag: 'wx' });
  await rename(statusTemporary, resolve(statusPath));
}
console.log(JSON.stringify({ status: 'ok', file: basename(target), sha256: checksum, encrypted: true, retentionDays }));
