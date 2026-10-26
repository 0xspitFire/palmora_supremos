import { createHash } from 'node:crypto';
import { chmod, chown, lstat, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join, parse, resolve } from 'node:path';
import type { KeyObject } from 'node:crypto';
import { turnkeyPolicyRecordDigest, verifyTurnkeySignedPolicyCatalog, verifyTurnkeySignedPolicyRecord, type TurnkeySignedPolicyCatalog, type TurnkeySignedPolicyRecord } from './turnkey-policy-record.js';
import { validateTurnkeyWalletMap, type TurnkeyWalletMap } from './turnkey-signer.js';

export interface TurnkeyPolicyBundle {
  readonly version: 1;
  readonly context: 'mintbot.turnkey-policy-bundle/v1';
  readonly activeRecord: TurnkeySignedPolicyRecord;
  readonly catalog: TurnkeySignedPolicyCatalog;
  readonly walletMap: TurnkeyWalletMap;
}

export function validateTurnkeyPolicyBundle(value: unknown, pinnedPublicKey: string | Buffer | KeyObject, now = new Date()): TurnkeyPolicyBundle {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('TURNKEY_POLICY_BUNDLE_INVALID');
  const item = value as Partial<TurnkeyPolicyBundle>;
  if (item.version !== 1 || item.context !== 'mintbot.turnkey-policy-bundle/v1' || JSON.stringify(Object.keys(item).sort()) !== JSON.stringify(['activeRecord', 'catalog', 'context', 'version', 'walletMap'])) throw new Error('TURNKEY_POLICY_BUNDLE_INVALID');
  const active = verifyTurnkeySignedPolicyRecord(item.activeRecord, pinnedPublicKey, now);
  const approved = verifyTurnkeySignedPolicyCatalog(item.catalog, pinnedPublicKey, now);
  const map = validateTurnkeyWalletMap(item.walletMap);
  const activeDigest = turnkeyPolicyRecordDigest(active);
  if (map.policyRecordDigest !== activeDigest || !approved.some((record) => turnkeyPolicyRecordDigest(record) === activeDigest)) throw new Error('TURNKEY_POLICY_BUNDLE_BINDING_INVALID');
  const expectedWallets = active.wallets.map(({ index, address, signWith }) => ({ index, address, signWith }));
  if (JSON.stringify(map.wallets.map(({ index, address, signWith }) => ({ index, address: address.toLowerCase(), signWith }))) !== JSON.stringify(expectedWallets)) throw new Error('TURNKEY_POLICY_BUNDLE_BINDING_INVALID');
  return item as TurnkeyPolicyBundle;
}

/**
 * Installs one validated JSON bundle with a single atomic rename. Configure
 * TURNKEY_POLICY_BUNDLE_PATH to `current.json`; a reader can therefore observe
 * only the old complete bundle or the new complete bundle.
 */
export async function installTurnkeyPolicyBundleAtomic(input: { bundle: unknown; pinnedPublicKey: string | Buffer | KeyObject; bundleRoot: string; groupReadable?: boolean; expectedGroupId?: number; now?: Date; /** Tests may disable the root check while retaining the same filesystem checks. */ privileged?: boolean }): Promise<{ generation: string; current: string }> {
  const bundle = validateTurnkeyPolicyBundle(input.bundle, input.pinnedPublicKey, input.now);
  const privileged = input.privileged ?? true;
  if (privileged && process.getuid?.() !== 0) throw new Error('TURNKEY_POLICY_BUNDLE_INSTALL_REQUIRES_ROOT');
  if (privileged && input.groupReadable && (!Number.isSafeInteger(input.expectedGroupId) || Number(input.expectedGroupId) <= 0)) throw new Error('TURNKEY_POLICY_BUNDLE_SERVICE_GROUP_REQUIRED');
  if (!isAbsolute(input.bundleRoot) || resolve(input.bundleRoot) !== input.bundleRoot) throw new Error('TURNKEY_POLICY_BUNDLE_ROOT_INVALID');
  // Refuse symlink traversal before creating anything. The bundle directory is
  // a trust boundary: when privileged it must be root-owned and never writable
  // by group or other users.
  const rootParts = input.bundleRoot.slice(parse(input.bundleRoot).root.length).split('/').filter(Boolean);
  let walked = parse(input.bundleRoot).root;
  for (const part of rootParts) {
    walked = join(walked, part);
    const entry = await lstat(walked).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? undefined : Promise.reject(error));
    if (!entry) break;
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('TURNKEY_POLICY_BUNDLE_ROOT_INVALID');
  }
  const digest = createHash('sha256').update(JSON.stringify(bundle)).digest('hex');
  const generation = join(input.bundleRoot, `generation-${digest}.json`);
  const current = join(input.bundleRoot, 'current.json');
  const mode = input.groupReadable ? 0o640 : 0o600;
  const rootMode = input.groupReadable ? 0o2750 : 0o700;
  const groupId = input.groupReadable ? input.expectedGroupId ?? process.getgid?.() ?? 0 : 0;
  await mkdir(input.bundleRoot, { recursive: true, mode: rootMode });
  if (privileged) {
    await chown(input.bundleRoot, 0, groupId);
    await chmod(input.bundleRoot, rootMode);
  }
  const rootEntry = await lstat(input.bundleRoot);
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink() || (privileged && (rootEntry.uid !== 0 || rootEntry.gid !== groupId || (rootEntry.mode & 0o022) !== 0 || (input.groupReadable && (rootEntry.mode & 0o2000) === 0)))) throw new Error('TURNKEY_POLICY_BUNDLE_ROOT_INVALID');
  const existing = await lstat(generation).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? undefined : Promise.reject(error));
  const serialized = `${JSON.stringify(bundle, null, 2)}\n`;
  if (!existing) {
    await writeFile(generation, serialized, { mode, flag: 'wx' });
    if (privileged) await chown(generation, 0, groupId);
    const handle = await open(generation, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  } else {
    if (!existing.isFile() || existing.isSymbolicLink() || (privileged && (existing.uid !== 0 || existing.gid !== groupId || (existing.mode & 0o022) !== 0))) throw new Error('TURNKEY_POLICY_BUNDLE_GENERATION_INVALID');
    if (await readFile(generation, 'utf8') !== serialized) throw new Error('TURNKEY_POLICY_BUNDLE_GENERATION_MISMATCH');
  }
  const currentEntry = await lstat(current).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? undefined : Promise.reject(error));
  if (currentEntry && (!currentEntry.isFile() || currentEntry.isSymbolicLink())) throw new Error('TURNKEY_POLICY_BUNDLE_CURRENT_INVALID');
  const next = join(input.bundleRoot, `.current-${digest}-${process.pid}.json`);
  await writeFile(next, serialized, { mode, flag: 'wx' });
  if (privileged) await chown(next, 0, groupId);
  const nextHandle = await open(next, 'r');
  try { await nextHandle.sync(); } finally { await nextHandle.close(); }
  await rename(next, current);
  const rootHandle = await open(input.bundleRoot, 'r');
  try { await rootHandle.sync(); } finally { await rootHandle.close(); }
  return { generation, current };
}
