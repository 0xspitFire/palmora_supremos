import { randomBytes } from 'node:crypto';
import { lstat, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export function assertApprovalKeyOutsideRuntimeRoot(privateKeyPath: string, secretRoot: string): string {
  const candidate = resolve(privateKeyPath);
  const outside = relative(resolve(secretRoot), candidate);
  if (outside === '' || (outside !== '..' && !outside.startsWith(`..${sep}`) && !isAbsolute(outside))) throw new Error('TURNKEY_APPROVER_PRIVATE_KEY_RUNTIME_BOUNDARY');
  return candidate;
}

export function approvalConfirmation(recordDigest: string, walletCount: number, keyId: string): string {
  if (!/^sha256:[0-9a-f]{64}$/.test(recordDigest) || !Number.isSafeInteger(walletCount) || walletCount < 1 || !/^ed25519:[0-9a-f]{64}$/.test(keyId)) throw new Error('TURNKEY_POLICY_CONFIRMATION_INPUT_INVALID');
  return `SIGN-TURNKEY-POLICY ${recordDigest.slice(-8)} ${walletCount}-WALLETS KEY-${keyId.slice(-8)}`;
}

export function approverRotationConfirmation(oldKeyId: string, newKeyId: string): string {
  if (!/^ed25519:[0-9a-f]{64}$/.test(oldKeyId) || !/^ed25519:[0-9a-f]{64}$/.test(newKeyId) || oldKeyId === newKeyId) throw new Error('TURNKEY_POLICY_ROTATION_INPUT_INVALID');
  return `ROTATE-TURNKEY-APPROVER ${oldKeyId.slice(-8)} ${newKeyId.slice(-8)}`;
}

async function assertNoSymlinkParents(path: string): Promise<void> {
  let current = dirname(resolve(path));
  while (true) {
    const entry = await lstat(current).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? undefined : Promise.reject(error));
    if (entry?.isSymbolicLink()) throw new Error('TURNKEY_ARTIFACT_PATH_INVALID');
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export async function writeTurnkeyApprovalBundle(recordPath: string, record: unknown, publicKeyPath: string, publicKey: string): Promise<void> {
  if (resolve(recordPath) === resolve(publicKeyPath)) throw new Error('TURNKEY_POLICY_OUTPUT_PATH_CONFLICT');
  await mkdir(dirname(recordPath), { recursive: true });
  await mkdir(dirname(publicKeyPath), { recursive: true });
  await assertNoSymlinkParents(recordPath);
  await assertNoSymlinkParents(publicKeyPath);
  const nonce = `${process.pid}.${randomBytes(8).toString('hex')}`;
  const recordTemporaryPath = `${recordPath}.${nonce}.tmp`;
  const publicKeyTemporaryPath = `${publicKeyPath}.${nonce}.tmp`;
  const recordBackupPath = `${recordPath}.${nonce}.bak`;
  const publicKeyBackupPath = `${publicKeyPath}.${nonce}.bak`;
  let recordBackedUp = false;
  let publicKeyBackedUp = false;
  let recordCommitted = false;
  let publicKeyCommitted = false;
  try {
    await writeFile(recordTemporaryPath, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await writeFile(publicKeyTemporaryPath, publicKey, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try { await rename(publicKeyPath, publicKeyBackupPath); publicKeyBackedUp = true; } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    try { await rename(recordPath, recordBackupPath); recordBackedUp = true; } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    await rename(publicKeyTemporaryPath, publicKeyPath);
    publicKeyCommitted = true;
    await rename(recordTemporaryPath, recordPath);
    recordCommitted = true;
    await unlink(publicKeyBackupPath).catch(() => undefined);
    await unlink(recordBackupPath).catch(() => undefined);
  } catch (error) {
    if (recordCommitted) await unlink(recordPath).catch(() => undefined);
    if (publicKeyCommitted) await unlink(publicKeyPath).catch(() => undefined);
    if (recordBackedUp) await rename(recordBackupPath, recordPath).catch(() => undefined);
    if (publicKeyBackedUp) await rename(publicKeyBackupPath, publicKeyPath).catch(() => undefined);
    throw error;
  } finally {
    await unlink(recordTemporaryPath).catch(() => undefined);
    await unlink(publicKeyTemporaryPath).catch(() => undefined);
  }
}
