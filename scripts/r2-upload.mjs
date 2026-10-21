import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function r2ConfigFromEnv(environment = process.env) {
  const required = environment.MINT_BOT_OFFHOST_BACKUP_REQUIRED === 'true';
  const identityPresent = Boolean(environment.R2_ACCESS_KEY_ID || environment.R2_ACCESS_KEY_ID_FILE);
  const secretPresent = Boolean(environment.R2_SECRET_ACCESS_KEY || environment.R2_SECRET_ACCESS_KEY_FILE);
  const present = [environment.R2_ACCOUNT_ID, environment.R2_BUCKET_NAME, identityPresent, secretPresent].filter(Boolean).length;
  if (present === 0 && !required) return undefined;
  if (present !== 4) throw new Error('R2_CONFIGURATION_INCOMPLETE');
  const accountId = environment.R2_ACCOUNT_ID;
  const bucket = environment.R2_BUCKET_NAME;
  const accessKeyId = environment.R2_ACCESS_KEY_ID;
  const secretAccessKey = environment.R2_SECRET_ACCESS_KEY;
  const accessKeyIdFile = environment.R2_ACCESS_KEY_ID_FILE;
  const secretAccessKeyFile = environment.R2_SECRET_ACCESS_KEY_FILE;
  const prefix = environment.R2_OBJECT_PREFIX ?? 'mintbot';
  const hostId = environment.MINT_BOT_HOST_ID;
  const jurisdiction = environment.R2_JURISDICTION ?? '';
  if (!/^[a-f0-9]{32}$/i.test(accountId) || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(prefix) || prefix.includes('..') || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(hostId ?? '') || !['', 'automatic', 'eu', 'us', 'fedramp'].includes(jurisdiction) || (accessKeyId && /[\r\n/]/.test(accessKeyId)) || (secretAccessKey && /[\r\n]/.test(secretAccessKey)) || (accessKeyIdFile && /[\r\n]/.test(accessKeyIdFile)) || (secretAccessKeyFile && /[\r\n]/.test(secretAccessKeyFile))) throw new Error('R2_CONFIGURATION_INVALID');
  const suffix = jurisdiction && jurisdiction !== 'automatic' ? `.${jurisdiction}` : '';
  return {
    bucket,
    accessKeyId,
    secretAccessKey,
    accessKeyIdFile,
    secretAccessKeyFile,
    prefix: `${prefix.replace(/^\/+|\/+$/g, '')}/${hostId}`,
    endpoint: `https://${accountId}${suffix}.r2.cloudflarestorage.com`,
    required,
  };
}

async function credential(value, path) {
  const loaded = value ?? (path ? (await readFile(path, 'utf8')).trim() : '');
  if (!loaded || /[\r\n]/.test(loaded)) throw new Error('R2_CONFIGURATION_INVALID');
  return loaded;
}

export async function createR2Client(config) {
  const [accessKeyId, secretAccessKey] = await Promise.all([credential(config.accessKeyId, config.accessKeyIdFile), credential(config.secretAccessKey, config.secretAccessKeyFile)]);
  return new S3Client({ region: 'auto', endpoint: config.endpoint, credentials: { accessKeyId, secretAccessKey } });
}

export async function uploadR2File(config, path, objectName, options = {}) {
  const body = await readFile(path);
  const contentHash = sha256(body);
  const objectKey = `${config.prefix}/${objectName}`;
  const client = options.client ?? await createR2Client(config);
  try {
    await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: objectKey, Body: body, ContentType: 'application/octet-stream', Metadata: { sha256: contentHash } }), { abortSignal: options.abortSignal ?? AbortSignal.timeout(60_000) });
  } catch { throw new Error('R2_UPLOAD_FAILED'); }
  let downloaded;
  try {
    downloaded = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: objectKey }), { abortSignal: options.abortSignal ?? AbortSignal.timeout(60_000) });
  } catch { throw new Error('R2_UPLOAD_VERIFICATION_FAILED'); }
  if (!downloaded.Body || downloaded.Metadata?.sha256 !== contentHash) throw new Error('R2_UPLOAD_VERIFICATION_FAILED');
  const remote = Buffer.from(await downloaded.Body.transformToByteArray());
  if (remote.byteLength !== body.byteLength || sha256(remote) !== contentHash) throw new Error('R2_UPLOAD_VERIFICATION_FAILED');
  return { objectKey, sha256: contentHash, size: body.byteLength };
}
