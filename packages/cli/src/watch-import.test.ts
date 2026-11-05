import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { importWatchList } from './watch-import.js';
import { openDatabase, IntelligenceRepository } from '@mint-bot/database';

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

  it('imports only into the explicitly selected supported chain and leaves Ethereum as the default', async () => {
    const db = openDatabase();
    const repo = new IntelligenceRepository(db);
    try {
      await withFile(JSON.stringify({ watched: [{ address: A, label: 'whale‮ one' }] }), async (file) => {
        expect(await importWatchList(file, repo)).toMatchObject({ nowWatching: 1 });
        expect(repo.observedAddresses(8453)).toEqual([]);
        expect(await importWatchList(file, repo, 8453)).toMatchObject({ nowWatching: 1 });
        expect(repo.observedAddresses(4663)).toEqual([]);
        expect(await importWatchList(file, repo, 4663)).toMatchObject({ nowWatching: 1 });
      });
      for (const chain of [1, 8453, 4663]) expect(repo.observedAddresses(chain)).toEqual([expect.objectContaining({ chainId: chain, address: A, label: 'whale one' })]);
      await expect(importWatchList('/nonexistent-watch-file', repo, 10)).rejects.toThrow('CHAIN_INVALID');
      expect(repo.observedAddresses(10)).toEqual([]);
    } finally { db.close(); }
  });

  it('retains the selected-chain custody-wallet refusal when importing', async () => {
    const db = openDatabase();
    const repo = new IntelligenceRepository(db);
    try {
      db.prepare('INSERT INTO chain_profile (id, chain_id, name, rpc_endpoints_json, confirmation_depth, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('base-watch-test', 8453, 'Base', '[]', 2, '2026-01-01T00:00:00.000Z');
      db.prepare('INSERT INTO wallet (id, chain_profile_id, address, key_reference, created_at) VALUES (?, ?, ?, ?, ?)').run('base-custody-test', 'base-watch-test', A, 'test-reference', '2026-01-01T00:00:00.000Z');
      await withFile(JSON.stringify([{ address: A }]), async (file) => {
        await expect(importWatchList(file, repo, 8453)).rejects.toThrow('observed address is a custody wallet');
      });
      expect(repo.observedAddresses(8453)).toEqual([]);
    } finally { db.close(); }
  });

  it('requires a chain-tagged export to match the explicit selected chain before any writes', async () => {
    const db = openDatabase();
    const repo = new IntelligenceRepository(db);
    try {
      await withFile(JSON.stringify({ chainId: 8453, watched: [{ address: A }] }), async (file) => {
        await expect(importWatchList(file, repo)).rejects.toThrow('WATCH_IMPORT_CHAIN_MISMATCH');
        await expect(importWatchList(file, repo, 4663)).rejects.toThrow('WATCH_IMPORT_CHAIN_MISMATCH');
        for (const chain of [1, 8453, 4663]) expect(repo.observedAddresses(chain)).toEqual([]);
        expect(await importWatchList(file, repo, 8453)).toEqual({ imported: 1, skipped: 0, nowWatching: 1 });
      });
      expect(repo.observedAddresses(1)).toEqual([]);
      expect(repo.observedAddresses(8453)).toEqual([expect.objectContaining({ address: A, chainId: 8453 })]);
    } finally { db.close(); }
  });

  it('rejects unsupported or malformed root chain metadata instead of treating it as an untagged legacy file', async () => {
    const t = fake();
    for (const chainId of [10, '8453', 'base', null, {}, 8453.1, 0, -1, []]) {
      await withFile(JSON.stringify({ chainId, watched: [{ address: A }] }), async (file) => {
        await expect(importWatchList(file, t.repo, 8453)).rejects.toThrow('WATCH_IMPORT_CHAIN_INVALID');
      });
    }
    expect(t.rows).toEqual([]);
  });
});
