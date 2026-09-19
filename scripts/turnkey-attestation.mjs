import { dirname, resolve } from 'node:path';
import { lstat, rename, unlink, writeFile } from 'node:fs/promises';
import { verify } from '../packages/engine/node_modules/@turnkey/crypto/dist/index.js';
import { createTurnkeyClient, readTurnkeySecretConfig } from '../packages/engine/dist/index.js';

const secretRoot = resolve(process.env.MINT_BOT_SECRET_ROOT ?? resolve(process.cwd(), 'Rets'));
const config = await readTurnkeySecretConfig(secretRoot);
if (!config.appName) throw new Error('TURNKEY_APP_NAME_REQUIRED');
if (!config.attestationActivityId) throw new Error('TURNKEY_ATTESTATION_ACTIVITY_REQUIRED');
const output = resolve(config.attestationPath ?? resolve(secretRoot, 'turnkey-attestation.json'));
let parent = dirname(output);
while (true) {
  const entry = await lstat(parent);
  if (entry.isSymbolicLink()) throw new Error('TURNKEY_ATTESTATION_PARENT_SYMLINK');
  const next = dirname(parent);
  if (next === parent) break;
  parent = next;
}
const client = createTurnkeyClient(config.organizationId, config.apiPublicKey, config.apiPrivateKey);

const activitiesResponse = await client.getActivities({ organizationId: config.organizationId, paginationOptions: { limit: '100' } });
const activity = activitiesResponse.activities.find((candidate) => candidate.id === config.attestationActivityId && candidate.status === 'ACTIVITY_STATUS_COMPLETED' && candidate.type.startsWith('ACTIVITY_TYPE_SIGN_TRANSACTION'));
if (!activity) throw new Error('TURNKEY_SIGN_ACTIVITY_REQUIRED');
const appProofs = (await client.getAppProofs({ organizationId: config.organizationId, activityId: activity.id })).appProofs;
if (appProofs.length === 0) throw new Error('TURNKEY_APP_PROOFS_UNAVAILABLE');
const bootProof = (await client.getLatestBootProof({ organizationId: config.organizationId, appName: config.appName })).bootProof;
for (const appProof of appProofs) await verify(appProof, bootProof);

const evidence = {
  version: 1,
  provider: 'turnkey',
  organizationId: config.organizationId,
  appName: config.appName,
  activityId: activity.id,
  activityType: activity.type,
  verifiedAt: new Date().toISOString(),
  verification: 'reference-grade-proof-pair',
  bootProof,
  appProofs,
};
const temporary = `${output}.${process.pid}.tmp`;
try {
  await writeFile(temporary, JSON.stringify(evidence, null, 2), { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, output);
} finally {
  await unlink(temporary).catch(() => undefined);
}
const file = await lstat(output);
if ((file.mode & 0o077) !== 0) throw new Error('TURNKEY_ATTESTATION_PERMISSIONS_REQUIRED');
console.log(JSON.stringify({ status: 'ok', activityId: activity.id, appProofCount: appProofs.length, evidencePath: output }));
