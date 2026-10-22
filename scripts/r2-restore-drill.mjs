#!/usr/bin/env node
// Isolated restore drill (T-048). Downloads one named encrypted backup from R2 into a private scratch folder, verifies its checksum,
// decrypts it and runs the database integrity checks with the existing offline restore check, then deletes the scratch folder.
// It never reads or writes the live database, the backup folder, the kill switch or any service path, and prints no secret.
//
//   node scripts/r2-restore-drill.mjs <backup file name>      e.g. mintbot.sqlite.2026-10-22T19-12-44.561Z.snapshot.enc
//
// Environment: the same R2_* names the backup job uses (R2_ACCESS_KEY_ID_FILE, R2_SECRET_ACCESS_KEY_FILE, MINT_BOT_HOST_ID, ...)
// and BACKUP_ENCRYPTION_KEY_FILE. Output: one JSON line with the timings (RTO) and the age of the backup (RPO).
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { createR2Client, r2ConfigFromEnv } from './r2-upload.mjs';

const run = promisify(execFile);
const scripts = dirname(new URL(import.meta.url).pathname);
const NAME = /^[A-Za-z0-9._-]+\.snapshot\.enc$/;

/** The backup file name carries its creation time, with the colons replaced: 2026-10-22T19-12-44.561Z. */
export function backupTime(fileName) {
  const match = /\.(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2}\.\d{3})Z\.snapshot\.enc$/.exec(fileName);
  return match ? new Date(`${match[1]}T${match[2]}:${match[3]}:${match[4]}Z`) : undefined;
}

async function download(client, config, objectName, destination) {
  const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: `${config.prefix}/${objectName}` }), { abortSignal: AbortSignal.timeout(120_000) });
  if (!response.Body) throw new Error('R2_DOWNLOAD_EMPTY');
  const bytes = Buffer.from(await response.Body.transformToByteArray());
  await writeFile(destination, bytes, { mode: 0o600, flag: 'wx' });
  return bytes.byteLength;
}

export async function runRestoreDrill({ fileName, environment = process.env, client, now = () => new Date(), workParent = tmpdir() }) {
  if (!NAME.test(fileName ?? '')) throw new Error('BACKUP_FILE_NAME_INVALID');
  const config = r2ConfigFromEnv(environment);
  if (!config) throw new Error('R2_NOT_CONFIGURED');
  const started = now();
  const work = await mkdtemp(join(workParent, 'mintbot-restore-drill-'));
  try {
    const r2 = client ?? await createR2Client(config);
    const snapshot = join(work, fileName);
    const bytes = await download(r2, config, fileName, snapshot);
    await download(r2, config, `${fileName}.sha256`, `${snapshot}.sha256`);
    const downloaded = now();
    const { stdout } = await run(process.execPath, [resolve(scripts, 'restore-check.mjs')], {
      env: { PATH: process.env.PATH ?? '', RESTORE_SNAPSHOT: snapshot, RESTORE_VERIFICATION_ONLY: 'true', BACKUP_ENCRYPTION_KEY_FILE: environment.BACKUP_ENCRYPTION_KEY_FILE ?? '' },
      timeout: 4 * 60_000,
    });
    const verified = JSON.parse(stdout.trim().split('\n').at(-1));
    if (verified.status !== 'ok') throw new Error('RESTORE_CHECK_NOT_OK');
    const finished = now();
    const created = backupTime(fileName);
    return {
      status: 'ok',
      object: fileName,
      bytes,
      downloadSeconds: (downloaded - started) / 1000,
      verifySeconds: (finished - downloaded) / 1000,
      restoreSeconds: (finished - started) / 1000,
      backupAgeSecondsAtDrill: created ? Math.round((started - created) / 1000) : null,
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  try {
    // Under systemd the secrets arrive as private credential files, exactly as for the backup job.
    const directory = process.env.CREDENTIALS_DIRECTORY;
    const environment = directory
      ? { ...process.env, BACKUP_ENCRYPTION_KEY_FILE: resolve(directory, 'backup-encryption-key'), R2_ACCESS_KEY_ID_FILE: resolve(directory, 'r2-access-key-id'), R2_SECRET_ACCESS_KEY_FILE: resolve(directory, 'r2-secret-access-key') }
      : process.env;
    console.log(JSON.stringify(await runRestoreDrill({ fileName: process.argv[2], environment })));
  } catch (error) {
    console.log(JSON.stringify({ status: 'failed', code: error instanceof Error ? error.message : 'RESTORE_DRILL_FAILED' }));
    process.exitCode = 1;
  }
}
