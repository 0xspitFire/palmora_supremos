import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertWalletAdminIsolationEntry, assertWalletAdminIsolationIdentity, assertWalletAdminLinuxIsolation, validateWalletAdminIsolationProfile, type WalletAdminIsolationFile, type WalletAdminIsolationProfile } from './wallet-administration-isolation.js';
const profile: WalletAdminIsolationProfile = { version: 1, kind: 'wallet-admin-linux-isolation-v1', ownerId: '1001', adminUid: 2002, mintServiceUid: 2001, mintServiceGids: [2001], credentialRoot: '/var/lib/mintbot-wallet-admin/private', credentialPath: '/var/lib/mintbot-wallet-admin/private/turnkey-wallet-admin.env', databasePath: '/var/lib/mintbot-state/backend.sqlite', killSwitchPath: '/var/lib/mintbot-control/killswitch' };
const expected = { ownerId: profile.ownerId, credentialPath: profile.credentialPath, databasePath: profile.databasePath, killSwitchPath: profile.killSwitchPath };
const regular: WalletAdminIsolationFile = { uid: 2002, mode: 0o100600, regular: true, directory: false, symlink: false, nlink: 1 };
const directory: WalletAdminIsolationFile = { ...regular, mode: 0o40700, regular: false, directory: true };
describe('wallet admin Linux privilege boundary', () => {
  it('accepts only the separate nonroot identity and exact owner/path binding', () => {
    expect(validateWalletAdminIsolationProfile(profile)).toEqual(profile);
    expect(() => assertWalletAdminIsolationIdentity(profile, { uid: 2002, gids: [2002] }, expected)).not.toThrow();
    expect(() => assertWalletAdminIsolationEntry(regular, 'credential', profile)).not.toThrow();
    expect(() => assertWalletAdminIsolationEntry(directory, 'private-root', profile)).not.toThrow();
    expect(() => assertWalletAdminIsolationEntry({ ...regular, uid: 0, mode: 0o100644 }, 'profile', profile)).not.toThrow();
  });
  it.each([{ adminUid: 0 }, { mintServiceUid: 0 }, { adminUid: 2001 }, { mintServiceGids: [] }, { mintServiceGids: [2001, 2001] }, { credentialPath: '/tmp/turnkey-wallet-admin.env' }, { databasePath: '/var/lib/mintbot-wallet-admin/private/state.sqlite' }, { killSwitchPath: '/var/lib/mintbot-wallet-admin/private/killswitch' }, { databasePath: '/var/lib/mintbot-state/../private/state.sqlite' }, { unexpected: true }])('rejects unsafe deployment profile %j', change => {
    expect(() => validateWalletAdminIsolationProfile({ ...profile, ...change })).toThrow('WALLET_ADMIN_OS_ISOLATION_REQUIRED');
  });
  it.each([{ uid: 0, gids: [2002] }, { uid: 2001, gids: [2002] }, { uid: 2002, gids: [2001, 2002] }, { uid: 2002, gids: [0, 2002] }, { uid: 2002, gids: [] }])('rejects shared/root/wrong process identity %j', identity => {
    expect(() => assertWalletAdminIsolationIdentity(profile, identity, expected)).toThrow();
  });
  it.each(['ownerId', 'databasePath', 'credentialPath', 'killSwitchPath'] as const)('rejects actual %s drift', field => {
    expect(() => assertWalletAdminIsolationIdentity(profile, { uid: 2002, gids: [2002] }, { ...expected, [field]: field === 'ownerId' ? 'other' : '/other' })).toThrow();
  });
  it.each([{ mode: 0o100640 }, { mode: 0o100644 }, { mode: 0o100660 }, { mode: 0o100700 }, { mode: 0o104600 }, { uid: 2001 }, { nlink: 2 }, { symlink: true }, { regular: false }])('rejects credential disclosure/replacement configuration %j', change => {
    expect(() => assertWalletAdminIsolationEntry({ ...regular, ...change }, 'credential', profile)).toThrow();
  });
  it.each([{ mode: 0o40750 }, { mode: 0o40770 }, { mode: 0o41700 }, { uid: 2001 }, { symlink: true }])('rejects a shared private root %j', change => {
    expect(() => assertWalletAdminIsolationEntry({ ...directory, ...change }, 'private-root', profile)).toThrow();
  });
  it.each([{ uid: 2002, mode: 0o100644 }, { uid: 0, mode: 0o100664 }, { uid: 0, mode: 0o100644, nlink: 2 }, { uid: 0, mode: 0o100644, symlink: true }])('rejects mutable/unpinned profile %j', change => {
    expect(() => assertWalletAdminIsolationEntry({ ...regular, ...change }, 'profile', profile)).toThrow();
  });
  it('rejects symlink, other-owned and group-writable credential ancestry', () => {
    for (const change of [{ symlink: true }, { uid: 2001 }, { mode: 0o40775 }]) expect(() => assertWalletAdminIsolationEntry({ ...directory, ...change }, 'ancestor', profile)).toThrow();
  });
  it('refuses absent or unprivileged mutable profile before credential access', async () => {
    await expect(assertWalletAdminLinuxIsolation({ ...expected, profilePath: undefined })).rejects.toThrow('WALLET_ADMIN_OS_ISOLATION_REQUIRED');
    const dir = await mkdtemp(join(tmpdir(), 'wallet-isolation-'));
    try { const path = join(dir, 'profile.json'); await writeFile(path, JSON.stringify(profile)); await expect(assertWalletAdminLinuxIsolation({ ...expected, profilePath: path })).rejects.toThrow('WALLET_ADMIN_OS_ISOLATION_REQUIRED'); }
    finally { await rm(dir, { recursive: true, force: true }); }
  });
});
