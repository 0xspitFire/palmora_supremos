import { access, constants, readFile, rm, writeFile } from 'node:fs/promises';
import { createDecipheriv, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { basename, dirname, resolve } from 'node:path';

const require = createRequire(new URL('../packages/database/package.json', import.meta.url));
const Database = require('better-sqlite3');

const snapshot = resolve(process.env.RESTORE_SNAPSHOT ?? '');
const checksumFile = `${snapshot}.sha256`;
if (!process.env.RESTORE_SNAPSHOT || !process.env.KILL_SWITCH_PATH) throw new Error('RESTORE_SNAPSHOT and KILL_SWITCH_PATH are required');
if (!process.env.BACKUP_ENCRYPTION_KEY) throw new Error('BACKUP_ENCRYPTION_KEY_REQUIRED');
await access(snapshot, constants.R_OK);
await access(process.env.KILL_SWITCH_PATH, constants.F_OK);
const actual = createHash('sha256').update(await readFile(snapshot)).digest('hex');
const expected = (await readFile(checksumFile, 'utf8')).trim().split(/\s+/)[0];
if (actual !== expected) throw new Error('Backup checksum mismatch');
const encrypted = await readFile(snapshot);
if (encrypted.subarray(0, 8).toString('ascii') !== 'MINTBOT1') throw new Error('Backup encryption header invalid');
const iv = encrypted.subarray(8, 20);
const authTag = encrypted.subarray(20, 36);
const ciphertext = encrypted.subarray(36);
const key = createHash('sha256').update(process.env.BACKUP_ENCRYPTION_KEY, 'utf8').digest();
const decipher = createDecipheriv('aes-256-gcm', key, iv);
decipher.setAuthTag(authTag);
const restoredPath = resolve(dirname(snapshot), `.${basename(snapshot)}.${process.pid}.restore.tmp`);
try {
  await writeFile(restoredPath, Buffer.concat([decipher.update(ciphertext), decipher.final()]));
  const database = new Database(restoredPath, { readonly: true, fileMustExist: true });
  try {
    const integrity = database.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') throw new Error('Restored SQLite integrity check failed');
  } finally {
    database.close();
  }
} finally {
  await rm(restoredPath, { force: true });
}
console.log(JSON.stringify({ status: 'ok', checksum: actual, encrypted: true, killSwitch: 'engaged' }));
