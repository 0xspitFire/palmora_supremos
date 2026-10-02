import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createPersonalLiveProbes, liveReadinessPhrase } from './personal-live-cli.js';

const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';

async function setup(files: { wallets?: string; backup?: string; kill?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'mint-readiness-'));
  const walletFile = join(directory, 'wallets.json');
  const backupStatusPath = join(directory, 'status.json');
  const killSwitchFile = join(directory, 'killswitch');
  if (files.wallets !== undefined) await writeFile(walletFile, files.wallets);
  if (files.backup !== undefined) await writeFile(backupStatusPath, files.backup);
  if (files.kill) await writeFile(killSwitchFile, 'x');
  const client = { getChainId: async () => 1, getBlock: async () => ({ timestamp: BigInt(Math.floor(Date.now() / 1000) - 5) }) } as never;
  const probes = createPersonalLiveProbes({ client, walletFile, backupStatusPath, killSwitchFile, telegramHealthy: async () => true });
  return { directory, probes };
}

describe('the real checks behind live-readiness record (D-043)', () => {
  it('reads the chain, fingerprints the wallet file without decrypting it, and reads the backup and kill-switch state', async () => {
    const wallets = JSON.stringify({ wallets: [{ index: 0, address: A, encrypted: 'x' }, { index: 1, address: B }] });
    const { directory, probes } = await setup({ wallets, backup: JSON.stringify({ status: 'ok', recordedAt: new Date(Date.now() - 60_000).toISOString() }) });
    try {
      expect(await probes.chain()).toMatchObject({ chainId: 1 });
      expect((await probes.chain()).headAgeSeconds).toBeGreaterThanOrEqual(4);
      expect(await probes.keystore()).toEqual({ digest: `0x${createHash('sha256').update(wallets).digest('hex')}`, addresses: [A, B] });
      const backup = await probes.backup();
      expect(backup.ok).toBe(true);
      expect(backup.ageMs).toBeGreaterThanOrEqual(60_000);
      expect(await probes.killSwitchEngaged()).toBe(false);
      expect(await probes.notifications()).toBe(true);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('reports a present kill switch, a failed backup, and refuses unreadable or malformed files', async () => {
    const { directory, probes } = await setup({ wallets: 'not json', backup: JSON.stringify({ status: 'failed', recordedAt: new Date().toISOString() }), kill: true });
    try {
      expect(await probes.killSwitchEngaged()).toBe(true);
      expect((await probes.backup()).ok).toBe(false);
      await expect(probes.keystore()).rejects.toThrow('WALLET_FILE_UNREADABLE');
    } finally { await rm(directory, { recursive: true, force: true }); }
    const missing = await setup({});
    try {
      await expect(missing.probes.keystore()).rejects.toThrow();
      await expect(missing.probes.backup()).rejects.toThrow('BACKUP_STATUS_UNREADABLE');
    } finally { await rm(missing.directory, { recursive: true, force: true }); }
    const badTime = await setup({ backup: JSON.stringify({ status: 'ok', recordedAt: 'yesterday-ish' }) });
    try { await expect(badTime.probes.backup()).rejects.toThrow('BACKUP_STATUS_UNREADABLE'); } finally { await rm(badTime.directory, { recursive: true, force: true }); }
  });

  it('keeps only valid addresses from the wallet file', async () => {
    const { directory, probes } = await setup({ wallets: JSON.stringify({ wallets: [{ address: A }, { address: 'nope' }, { address: 5 }, {}] }) });
    try { expect((await probes.keystore()).addresses).toEqual([A]); } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('names the wallet count in the confirmation phrase', () => {
    expect(liveReadinessPhrase(6)).toBe('RECORD-LIVE-READINESS 6 wallets');
    expect(liveReadinessPhrase(6)).not.toBe(liveReadinessPhrase(2));
  });

  it('counts the stored kill switch flag as well as the file', async () => {
    const { directory } = await setup({});
    try {
      const client = { getChainId: async () => 1, getBlock: async () => ({ timestamp: 0n }) } as never;
      const base = { client, walletFile: join(directory, 'w.json'), backupStatusPath: join(directory, 's.json'), killSwitchFile: join(directory, 'none'), telegramHealthy: async () => true };
      expect(await createPersonalLiveProbes({ ...base }).killSwitchEngaged()).toBe(false);
      expect(await createPersonalLiveProbes({ ...base, killSwitchStoredFlag: () => false }).killSwitchEngaged()).toBe(false);
      expect(await createPersonalLiveProbes({ ...base, killSwitchStoredFlag: () => true }).killSwitchEngaged()).toBe(true);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
