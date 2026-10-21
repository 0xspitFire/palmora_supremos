import { chmod, lstat, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { approvalConfirmation, approverRotationConfirmation, assertApprovalKeyOutsideRuntimeRoot, writeTurnkeyApprovalBundle } from './turnkey-approval.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const KEY_A = `ed25519:${'1'.repeat(64)}`;
const KEY_B = `ed25519:${'2'.repeat(64)}`;

describe('Turnkey approval workflow', () => {
  it('binds approval to record digest, wallet count, and approver key ID', () => {
    expect(approvalConfirmation(DIGEST, 3, KEY_A)).toBe('SIGN-TURNKEY-POLICY aaaaaaaa 3-WALLETS KEY-11111111');
    expect(approverRotationConfirmation(KEY_A, KEY_B)).toBe('ROTATE-TURNKEY-APPROVER 11111111 22222222');
    expect(() => approverRotationConfirmation(KEY_A, KEY_A)).toThrow('TURNKEY_POLICY_ROTATION_INPUT_INVALID');
  });

  it('requires the owner private key to remain outside the runtime secret root', () => {
    expect(() => assertApprovalKeyOutsideRuntimeRoot('/srv/mintbot/secrets/approver.key', '/srv/mintbot/secrets')).toThrow('TURNKEY_APPROVER_PRIVATE_KEY_RUNTIME_BOUNDARY');
    expect(assertApprovalKeyOutsideRuntimeRoot('/offline/owner/approver.key', '/srv/mintbot/secrets')).toBe('/offline/owner/approver.key');
  });

  it('installs and renews the signed record/public-key pair with owner-only permissions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mintbot-approval-'));
    const recordPath = join(root, 'secrets', 'record.json');
    const publicKeyPath = join(root, 'secrets', 'approver.pub');
    await writeTurnkeyApprovalBundle(recordPath, { version: 1 }, publicKeyPath, 'key-a');
    expect(JSON.parse(await readFile(recordPath, 'utf8'))).toEqual({ version: 1 });
    expect(await readFile(publicKeyPath, 'utf8')).toBe('key-a');
    expect((await lstat(recordPath)).mode & 0o777).toBe(0o600);
    expect((await lstat(publicKeyPath)).mode & 0o777).toBe(0o600);

    await writeTurnkeyApprovalBundle(recordPath, { version: 2 }, publicKeyPath, 'key-a');
    expect(JSON.parse(await readFile(recordPath, 'utf8'))).toEqual({ version: 2 });
    expect(await readFile(publicKeyPath, 'utf8')).toBe('key-a');
  });

  it('rejects an output path reached through a symlink parent without changing the existing pair', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mintbot-approval-link-'));
    const safe = join(root, 'safe');
    const linked = join(root, 'linked');
    await writeTurnkeyApprovalBundle(join(safe, 'record.json'), { version: 1 }, join(safe, 'approver.pub'), 'key-a');
    await symlink(safe, linked);
    await expect(writeTurnkeyApprovalBundle(join(linked, 'record.json'), { version: 2 }, join(linked, 'approver.pub'), 'key-b')).rejects.toThrow('TURNKEY_ARTIFACT_PATH_INVALID');
    expect(JSON.parse(await readFile(join(safe, 'record.json'), 'utf8'))).toEqual({ version: 1 });
    expect(await readFile(join(safe, 'approver.pub'), 'utf8')).toBe('key-a');
    await chmod(safe, 0o700);
    await writeFile(join(root, 'complete'), 'ok');
  });
});
