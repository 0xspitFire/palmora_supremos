import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const ERROR = 'WALLET_ADMIN_OS_ISOLATION_REQUIRED';
const fail = (): never => { throw new Error(ERROR); };
export interface WalletAdminIsolationProfile {
  version: 1; kind: 'wallet-admin-linux-isolation-v1'; ownerId: string;
  adminUid: number; mintServiceUid: number; mintServiceGids: number[];
  credentialPath: string; credentialRoot: string; databasePath: string; killSwitchPath: string;
}
export interface WalletAdminIsolationIdentity { uid: number; gids: readonly number[]; }
export interface WalletAdminIsolationFile { uid: number; mode: number; regular: boolean; directory: boolean; symlink: boolean; nlink: number; }
const FIELDS = 'version kind ownerId adminUid mintServiceUid mintServiceGids credentialPath credentialRoot databasePath killSwitchPath'.split(' ').sort().join('|');
const uid = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const within = (root: string, path: string) => { const sub = relative(root, path); return sub !== '' && sub !== '..' && !sub.startsWith(`..${sep}`) && !isAbsolute(sub); };
export function validateWalletAdminIsolationProfile(value: unknown): WalletAdminIsolationProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join('|') !== FIELDS) fail();
  const profile = value as WalletAdminIsolationProfile;
  if (profile.version !== 1 || profile.kind !== 'wallet-admin-linux-isolation-v1' || typeof profile.ownerId !== 'string' || !/^[A-Za-z0-9_.:-]{1,180}$/.test(profile.ownerId) || !uid(profile.adminUid) || !uid(profile.mintServiceUid) || profile.adminUid === profile.mintServiceUid || !Array.isArray(profile.mintServiceGids) || !profile.mintServiceGids.length || profile.mintServiceGids.length > 64 || profile.mintServiceGids.some(value => !uid(value)) || new Set(profile.mintServiceGids).size !== profile.mintServiceGids.length) fail();
  for (const path of [profile.credentialPath, profile.credentialRoot, profile.databasePath, profile.killSwitchPath]) if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || /[\x00-\x1f]/.test(path)) fail();
  if (basename(profile.credentialPath) !== 'turnkey-wallet-admin.env' || !within(profile.credentialRoot, profile.credentialPath) || within(profile.credentialRoot, profile.databasePath) || within(profile.credentialRoot, profile.killSwitchPath) || new Set([profile.credentialPath, profile.credentialRoot, profile.databasePath, profile.killSwitchPath]).size !== 4 || dirname(profile.databasePath) === profile.credentialRoot) fail();
  return profile;
}
/** Pure decision exported for adversarial synthetic identity/mode fixtures. */
export function assertWalletAdminIsolationIdentity(profile: WalletAdminIsolationProfile, identity: WalletAdminIsolationIdentity, expected: { ownerId: string; credentialPath: string; databasePath: string; killSwitchPath: string }): void {
  validateWalletAdminIsolationProfile(profile);
  if (identity.uid !== profile.adminUid || identity.uid === 0 || !identity.gids.length || identity.gids.some(gid => !uid(gid) || profile.mintServiceGids.includes(gid)) || profile.ownerId !== expected.ownerId || profile.credentialPath !== resolve(expected.credentialPath) || profile.databasePath !== resolve(expected.databasePath) || profile.killSwitchPath !== resolve(expected.killSwitchPath)) fail();
}
export function assertWalletAdminIsolationEntry(entry: WalletAdminIsolationFile, kind: 'profile' | 'credential' | 'private-root' | 'ancestor', profile: WalletAdminIsolationProfile): void {
  if (entry.symlink || kind === 'ancestor' && !entry.directory) fail();
  if (kind === 'profile' && (!entry.regular || entry.uid !== 0 || (entry.mode & 0o022) !== 0 || entry.nlink !== 1)) fail();
  if (kind === 'credential' && (!entry.regular || entry.uid !== profile.adminUid || ![0o400, 0o600].includes(entry.mode & 0o7777) || entry.nlink !== 1)) fail();
  if (kind === 'private-root' && (!entry.directory || entry.uid !== profile.adminUid || (entry.mode & 0o7777) !== 0o700)) fail();
  if (kind === 'ancestor' && (![0, profile.adminUid].includes(entry.uid) || (entry.mode & 0o022) !== 0)) fail();
}
const projection = (stat: Awaited<ReturnType<typeof lstat>>): WalletAdminIsolationFile => ({ uid: Number(stat.uid), mode: Number(stat.mode), regular: stat.isFile(), directory: stat.isDirectory(), symlink: stat.isSymbolicLink(), nlink: Number(stat.nlink) });
async function ancestors(path: string, profile: WalletAdminIsolationProfile): Promise<void> {
  let current = dirname(path);
  for (;;) { assertWalletAdminIsolationEntry(projection(await lstat(current)), 'ancestor', profile); const parent = dirname(current); if (parent === current) return; current = parent; }
}
/** Root pin loaded via protected descriptor. No credential content, DB handle or provider client is opened here. */
export async function assertWalletAdminLinuxIsolation(options: {
  profilePath: string | undefined; ownerId: string; credentialPath: string; databasePath: string; killSwitchPath: string;
}): Promise<WalletAdminIsolationProfile> {
  let handle;
  try {
    if (!options.profilePath || !isAbsolute(options.profilePath)) fail();
    const profilePath = resolve(options.profilePath!);
    // Protect the profile pathname itself before reading its root-owned descriptor.
    let parent = dirname(profilePath);
    for (;;) { const info = await lstat(parent); if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) !== 0) fail(); const next = dirname(parent); if (next === parent) break; parent = next; }
    handle = await open(profilePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0 || stat.nlink !== 1 || stat.size < 2 || stat.size > 8192) fail();
    const profile = validateWalletAdminIsolationProfile(JSON.parse(await handle.readFile('utf8')));
    const runtimeUid = process.geteuid?.() ?? process.getuid?.(); const runtimeGid = process.getegid?.() ?? process.getgid?.();
    if (runtimeUid === undefined || runtimeGid === undefined) fail();
    assertWalletAdminIsolationIdentity(profile, { uid: runtimeUid!, gids: [...new Set([runtimeGid!, ...(process.getgroups?.() ?? [])])] }, options);
    await ancestors(profile.credentialPath, profile);
    assertWalletAdminIsolationEntry(projection(await lstat(profile.credentialRoot)), 'private-root', profile);
    assertWalletAdminIsolationEntry(projection(await lstat(profile.credentialPath)), 'credential', profile);
    // Canonical DB and kill locations must not be links or writable by arbitrary users.
    for (const path of [profile.databasePath, profile.killSwitchPath]) {
      let current = path;
      for (;;) {
        const info = await lstat(current).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' && current === path && path === profile.killSwitchPath ? undefined : Promise.reject(error));
        if (info && (current === path && !info.isFile() || info.isSymbolicLink() || (info.mode & 0o002) !== 0 || ![0, profile.adminUid, profile.mintServiceUid].includes(Number(info.uid)))) fail();
        const parent = dirname(current); if (parent === current) break; current = parent;
      }
    }
    return profile;
  } catch { throw new Error(ERROR); }
  finally { await handle?.close().catch(() => undefined); }
}
