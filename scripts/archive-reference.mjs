import { lstat, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const APPROVED_ARCHIVE_PATH = '/home/Junayd/W3/Rets/archive-rpc.env';
export const APPROVED_ARCHIVE_REFERENCE = '~/W3/Rets/archive-rpc.env';
export const APPROVED_ETHEREUM_ARCHIVE_PATH = '/home/Junayd/W3/Rets/eth-archive-rpc.env';
export const APPROVED_ETHEREUM_ARCHIVE_REFERENCE = '~/W3/Rets/eth-archive-rpc.env';

const ALLOWED_KEYS = new Set([
  'ROBINHOOD_ARCHIVE_RPC',
  'ETHEREUM_FORK_RPC',
  'ETHEREUM_ARCHIVE_RPC',
  'ETHEREUM_FORK_BLOCK',
  'ETHEREUM_SEADROP_NFT',
  'ETHEREUM_SEADROP_FEE_RECIPIENT',
  'ETHEREUM_SEADROP_MINT_VALUE_WEI',
]);

export function parseArchiveReference(sourceReference, defaultKey) {
  assertNativeWslWorkspace();
  const reference = sourceReference ?? `${APPROVED_ARCHIVE_REFERENCE}:${defaultKey}`;
  const separator = reference.lastIndexOf(':');
  const sourcePath = separator > 0 ? reference.slice(0, separator) : reference;
  const key = separator > 0 ? reference.slice(separator + 1) : defaultKey;
  const ethereumKey = key.startsWith('ETHEREUM_');
  const approvedReferences = ethereumKey
    ? [APPROVED_ETHEREUM_ARCHIVE_REFERENCE, APPROVED_ETHEREUM_ARCHIVE_PATH]
    : [APPROVED_ARCHIVE_REFERENCE, APPROVED_ARCHIVE_PATH];
  if (!approvedReferences.includes(sourcePath)) {
    throw new Error(ethereumKey ? 'Ethereum archive source must be ~/W3/Rets/eth-archive-rpc.env' : 'Archive source must be ~/W3/Rets/archive-rpc.env');
  }
  if (!ALLOWED_KEYS.has(key)) throw new Error('Archive reference key is not approved');
  const filePath = ethereumKey ? APPROVED_ETHEREUM_ARCHIVE_PATH : APPROVED_ARCHIVE_PATH;
  const displayPath = ethereumKey ? APPROVED_ETHEREUM_ARCHIVE_REFERENCE : APPROVED_ARCHIVE_REFERENCE;
  return { filePath, key, display: `${displayPath}:${key}` };
}

function assertNativeWslWorkspace() {
  const root = resolve(process.cwd()).replaceAll('\\', '/');
  let kernel = '';
  try {
    kernel = `${readFileSync('/proc/sys/kernel/osrelease', 'utf8')}\n${readFileSync('/proc/version', 'utf8')}`;
  } catch {
    // Fall through to the fail-closed check below.
  }
  if (process.platform !== 'linux' || !/(?:microsoft|wsl)/i.test(kernel)
    || (root !== '/home/Junayd/W3' && !root.startsWith('/home/Junayd/W3/'))) {
    throw new Error('Fork replay requires a native WSL worktree below /home/Junayd/W3');
  }
}

export async function readArchiveValue(sourceReference, defaultKey) {
  const { filePath, key } = parseArchiveReference(sourceReference, defaultKey);
  const values = await readApprovedFile(filePath, [key]);
  const value = values.get(key);
  if (!value) throw new Error(`Missing required archive reference: ${key}`);
  return value;
}

export async function readArchiveValues(sourceReference, defaultKey, keys) {
  const parsed = parseArchiveReference(sourceReference, defaultKey);
  for (const key of keys) {
    if (!ALLOWED_KEYS.has(key)) throw new Error('Archive reference key is not approved');
  }
  return { reference: parsed, values: await readApprovedFile(parsed.filePath, keys) };
}

async function readApprovedFile(filePath, keys) {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('Archive reference must be a regular file');
  const source = await readFile(filePath, 'utf8');
  const values = new Map();
  for (const key of keys) {
    const prefix = `${key}=`;
    const line = source.split(/\r?\n/).map((entry) => entry.trim()).find((entry) => entry.startsWith(prefix));
    if (line) {
      const rawValue = line.slice(prefix.length).trim();
      const quoted = rawValue.match(/^("|')(.*)\1$/);
      values.set(key, quoted ? quoted[2] : rawValue);
    }
  }
  return values;
}
