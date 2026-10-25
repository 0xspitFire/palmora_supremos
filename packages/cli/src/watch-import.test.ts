import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { importWatchList } from './watch-import.js';

const A = `0x${'a'.repeat(40)}`;
const B = `0x${'B'.repeat(40)}`;

async function withFile(content: string, run: (file: string, directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'mintbot-watch-'));
  try { const file = join(directory, 'list.json'); await writeFile(file, content); await run(file, directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
const fake = () => {
  const rows: Array<{ address: string; label?: string }> = [];
  return { rows, repo: { addObservedAddress: (_chain: number, address: string, label?: string) => { rows.push({ address, ...(label ? { label } : {}) }); }, observedAddresses: () => rows } };
};

describe('watch import', () => {
  it('imports a `watch list` output, lower-cases addresses, cleans labels and counts the bad entries it skipped', async () => {
    const t = fake();
    await withFile(JSON.stringify({ watched: [{ address: A, label: 'whale‮ one' }, { address: B }, { address: '0x123' }, 'junk'] }), async (file) => {
      expect(await importWatchList(file, t.repo)).toEqual({ imported: 2, skipped: 2, nowWatching: 2 });
    });
    expect(t.rows).toEqual([{ address: A, label: 'whale one' }, { address: B.toLowerCase() }]);
  });

  it('refuses a bad file by name and adds nothing (negative, fail closed)', async () => {
    const t = fake();
    await withFile('not json', async (file) => { await expect(importWatchList(file, t.repo)).rejects.toThrow('FILE_INVALID'); });
    await withFile('{"other":1}', async (file) => { await expect(importWatchList(file, t.repo)).rejects.toThrow('FILE_INVALID'); });
    await withFile(JSON.stringify(Array.from({ length: 1001 }, () => ({ address: A }))), async (file) => { await expect(importWatchList(file, t.repo)).rejects.toThrow('FILE_TOO_LARGE'); });
    await withFile('[]', async (file, directory) => { const link = join(directory, 'link.json'); await symlink(file, link); await expect(importWatchList(link, t.repo)).rejects.toThrow('FILE_INVALID'); });
    // A link in the folder part of the path is refused too.
    await withFile('[]', async (file, directory) => { await mkdir(join(directory, 'real')); await writeFile(join(directory, 'real', 'list.json'), '[]'); await symlink(join(directory, 'real'), join(directory, 'via')); await expect(importWatchList(join(directory, 'via', 'list.json'), t.repo)).rejects.toThrow('FILE_INVALID'); void file; });
    expect(t.rows).toEqual([]);
  });
});
