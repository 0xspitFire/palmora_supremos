import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface WatchImportTarget {
  addObservedAddress(chainId: number, address: string, label?: string): unknown;
  observedAddresses(chainId: number): readonly unknown[];
}

/** Adds the addresses of a `watch list` output (or a plain list of {address, label}) to the watch list. A bad entry is skipped and counted; a bad file stops it by name before anything is added. */
export async function importWatchList(file: string, repo: WatchImportTarget): Promise<{ imported: number; skipped: number; nowWatching: number }> {
  // The path must be a real location (no symlink anywhere in it), and the file is checked and read through one open handle so it cannot be swapped in between.
  if (await realpath(file) !== resolve(file)) throw new Error('FILE_INVALID: the path must not go through a link');
  let text: string;
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 500_000) throw new Error('FILE_INVALID: it must be a plain file under 500 KB');
    text = await handle.readFile('utf8');
  } finally { await handle.close(); }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error('FILE_INVALID: it is not valid JSON'); }
  const items = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' && Array.isArray((parsed as { watched?: unknown }).watched) ? (parsed as { watched: unknown[] }).watched : undefined);
  if (!items) throw new Error('FILE_INVALID: expected the output of `watch list` or a list of {address, label}');
  if (items.length > 1_000) throw new Error('FILE_TOO_LARGE: at most 1000 wallets at a time');
  const accepted: Array<{ address: string; label?: string }> = [];
  let skipped = 0;
  for (const item of items) {
    const entry = item && typeof item === 'object' ? item as { address?: unknown; label?: unknown } : {};
    const address = typeof entry.address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(entry.address) ? entry.address.toLowerCase() : undefined;
    if (!address) { skipped += 1; continue; }
    // eslint-disable-next-line no-control-regex
    const label = typeof entry.label === 'string' ? entry.label.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, '').trim().slice(0, 60) : '';
    accepted.push({ address, ...(label ? { label } : {}) });
  }
  // Every entry is checked first; only then are any added.
  for (const entry of accepted) repo.addObservedAddress(1, entry.address, entry.label);
  return { imported: accepted.length, skipped, nowWatching: repo.observedAddresses(1).length };
}
