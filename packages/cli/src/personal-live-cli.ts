import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { PublicClient } from 'viem';
import type { PersonalLiveProbes } from '@mint-bot/backend';

/**
 * The real checks behind `live-readiness record` (D-043). Each probe only reads: the RPC, the wallet file's bytes and
 * public addresses, Telegram's health endpoint, the backup status file, and whether the kill-switch file exists.
 * The wallet file is never decrypted here and no passphrase is read.
 */
export function createPersonalLiveProbes(options: {
  client: Pick<PublicClient, 'getChainId' | 'getBlock'>;
  walletFile: string;
  backupStatusPath: string;
  killSwitchFile: string;
  telegramHealthy: () => Promise<boolean>;
  now?: () => number;
}): PersonalLiveProbes {
  const now = options.now ?? (() => Date.now());
  return {
    chain: async () => {
      const [chainId, block] = await Promise.all([options.client.getChainId(), options.client.getBlock({ blockTag: 'latest' })]);
      return { chainId, headAgeSeconds: Math.max(0, now() / 1_000 - Number(block.timestamp)) };
    },
    keystore: async () => {
      const bytes = await readFile(options.walletFile);
      let parsed: { wallets?: Array<{ address?: unknown }> };
      try { parsed = JSON.parse(bytes.toString('utf8')) as typeof parsed; } catch { throw new Error('WALLET_FILE_UNREADABLE'); }
      const addresses = (parsed.wallets ?? []).map((wallet) => wallet.address).filter((address): address is string => typeof address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(address));
      return { digest: `0x${createHash('sha256').update(bytes).digest('hex')}`, addresses };
    },
    notifications: options.telegramHealthy,
    backup: async () => {
      let parsed: { status?: string; recordedAt?: string };
      try { parsed = JSON.parse(await readFile(options.backupStatusPath, 'utf8')) as typeof parsed; } catch { throw new Error('BACKUP_STATUS_UNREADABLE'); }
      const recorded = Date.parse(parsed.recordedAt ?? '');
      if (!Number.isFinite(recorded)) throw new Error('BACKUP_STATUS_UNREADABLE');
      return { ok: parsed.status === 'ok', ageMs: Math.max(0, now() - recorded) };
    },
    killSwitchEngaged: async () => existsSync(options.killSwitchFile),
  };
}

/** The phrase that records readiness; it names how many wallets, so a copied phrase for another set does not match. */
export function liveReadinessPhrase(walletCount: number): string {
  return `RECORD-LIVE-READINESS ${walletCount} wallets`;
}
