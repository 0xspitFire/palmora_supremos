import { access, constants, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const snapshot = resolve(process.env.RESTORE_SNAPSHOT ?? '');
const checksumFile = `${snapshot}.sha256`;
if (!process.env.RESTORE_SNAPSHOT || !process.env.KILL_SWITCH_PATH) throw new Error('RESTORE_SNAPSHOT and KILL_SWITCH_PATH are required');
await access(snapshot, constants.R_OK);
await access(process.env.KILL_SWITCH_PATH, constants.F_OK);
const actual = createHash('sha256').update(await readFile(snapshot)).digest('hex');
const expected = (await readFile(checksumFile, 'utf8')).trim().split(/\s+/)[0];
if (actual !== expected) throw new Error('Backup checksum mismatch');
console.log(JSON.stringify({ status: 'ok', checksum: actual, killSwitch: 'engaged' }));
