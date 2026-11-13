import { describe, expect, it, vi } from 'vitest';
import { createWalletAdministration, DurableStore, type WalletAdministrationPort } from '@mint-bot/backend';
import { openDatabase, TelegramAccessRepository } from '@mint-bot/database';
import { TelegramCommandRouter, menuFor } from './telegram-commands.js';
import { createTelegramActions, type TelegramActionDeps } from './telegram-actions.js';
import type { TelegramBotApi, TelegramUpdate } from './telegram-api.js';
import type { WalletAdministrationRuntime } from './wallet-administration-runtime.js';
import { readWalletAdministrationQueue } from './wallet-administration-service.js';
import { timeStepAt } from './totp.js';
const now = new Date('2026-11-13T12:00:00Z'); const address = `0x${'1'.repeat(40)}`;
async function fixture() {
  const store = new DurableStore(); await store.open(); const db = openDatabase(); const access = new TelegramAccessRepository(db, () => now);
  const generate = vi.fn(async () => ({ activityId: 'never', keys: [] })); const importSealed = vi.fn(async () => ({ activityId: 'never', keys: [] }));
  const provider: WalletAdministrationPort = { capability: async () => ({ organizationId: 'org', ownerAdminAvailable: false, code: 'WALLET_OWNER_ADMIN_CLIENT_REQUIRED' }), inventory: async () => ({ organizationId: 'org', keys: [{ keyId: 'existing-key', label: 'existing', address, usable: true, issues: [] }], complete: true, issues: [] }), generate, importSealed };
  const runtime: WalletAdministrationRuntime = { store, ownerId: '1001', mode: 'public', profileStatus: { code: 'WALLET_OWNER_ADMIN_WORKER_REQUIRED' }, serviceFor: authorize => createWalletAdministration({ store, ownerId: '1001', authorize, provider, authorizedWallets: async () => [{ chainId: 1, keyId: 'existing-key', address }], now: () => now }), approvalCurrent: async approval => access.openSession()?.id === approval.sessionId, close: async () => undefined };
  const factory = vi.fn(async () => runtime);
  const actions = createTelegramActions({ mode: 'host', custody: 'turnkey', store, projectRoot: '/synthetic', secretRoot: '/synthetic', killSwitchPath: '/synthetic/no-kill', now: () => now, walletAdministrationOwnerId: '1001', walletAdministrationRuntime: factory } as unknown as TelegramActionDeps);
  const sent: string[] = []; const deleted: number[] = []; const recorded: unknown[] = [];
  const api: TelegramBotApi = { getUpdates: async () => [], sendMessage: async (_chat, text) => { sent.push(text); }, answerCallback: async () => undefined, deleteMessage: async (_chat, id) => { deleted.push(id); } };
  const router = new TelegramCommandRouter({ api, access, actions, ownerUserId: '1001', totpKey: Buffer.from('synthetic totp marker'), record: async row => { recorded.push(row); }, alert: async () => undefined, now: () => now }); let next = 1;
  const message = (text: string, options: { user?: number; group?: boolean; ageSeconds?: number } = {}): TelegramUpdate => { const user = options.user ?? 1001; return { update_id: next++, message: { message_id: next++, date: now.getTime() / 1000 - (options.ageSeconds ?? 0), chat: { id: user, type: options.group ? 'group' : 'private' }, from: { id: user }, text } }; };
  const unlock = () => access.startSession(timeStepAt(now), 12 * 3600_000);
  return { store, access, router, sent, recorded, deleted, factory, runtime, generate, importSealed, message, unlock, close: () => db.close() };
}
describe('owner-private wallet administration Telegram integration', () => {
  it('routes authenticated fresh generation/import to durable public queues without any provider mutation', async () => {
    const s = await fixture(); try {
      s.unlock(); await s.router.handle(s.message('/walletadmin generate create1 1,8453 2')); await s.router.handle(s.message(`/walletadmin import import1 1 ${address}`));
      const rows = readWalletAdministrationQueue(s.store.snapshot().events); expect(rows).toMatchObject([{ request: { requestId: 'create1', kind: 'generate', count: 2 }, approval: { channel: 'telegram' }, state: 'queued' }, { request: { requestId: 'import1', kind: 'import', expectedAddresses: [address] }, state: 'queued' }]);
      expect(s.generate).not.toHaveBeenCalled(); expect(s.importSealed).not.toHaveBeenCalled(); expect(s.sent.join('\n')).toContain('isolated owner worker');
    } finally { s.close(); }
  });
  it.each(['locked', 'viewer', 'stranger', 'group', 'stale'] as const)('refuses %s wallet administration before action composition', async mode => {
    const s = await fixture(); try {
      if (mode !== 'locked') s.unlock();
      if (mode === 'viewer') { s.access.createInvite('viewer-code', 'viewer', 60_000); s.access.join('viewer-code', '2002'); }
      await s.router.handle(s.message('/walletadmin generate r 1 1', { ...(mode === 'viewer' ? { user: 2002 } : {}), ...(mode === 'stranger' ? { user: 3003 } : {}), group: mode === 'group', ageSeconds: mode === 'stale' ? 301 : 0 }));
      expect(s.factory).not.toHaveBeenCalled(); expect(readWalletAdministrationQueue(s.store.snapshot().events)).toHaveLength(0);
    } finally { s.close(); }
  });
  it('rechecks the same owner session after asynchronous composition instead of queuing after lock', async () => {
    const s = await fixture(); try { s.unlock(); s.factory.mockImplementationOnce(async () => { s.access.closeSession('lock'); return s.runtime; }); await s.router.handle(s.message('/walletadmin generate r 1 1')); expect(readWalletAdministrationQueue(s.store.snapshot().events)).toHaveLength(0); expect(s.sent.join('\n')).toContain('WALLET_ADMIN_APPROVAL_REQUIRED'); } finally { s.close(); }
  });
  it('routes chain groups, campaign selection and retirement to actual public service operations', async () => {
    const s = await fixture(); try {
      s.unlock(); await s.router.handle(s.message(`/walletgroups save main 1 Main_Fleet ${address}`));
      await s.store.transaction(state => state.campaigns.push({ id: 'c', state: 'Draft', chainId: 1, contract: address, strategy: 'seadrop-v1-public', quantity: 1, mintPriceWei: 0n, feePolicy: { kind: 'free', configuredPriorityFeeWei: 1n } } as never));
      await s.router.handle(s.message('/walletgroups assign c main')); await s.router.handle(s.message('/walletadmin retire retirement1 existing-key'));
      expect(s.store.snapshot().events.some(row => row.type === 'wallet_administration_group')).toBe(true); expect(s.store.snapshot().events.some(row => row.type === 'wallet_administration_campaign_selection')).toBe(true); expect(s.store.snapshot().events.find(row => row.type === 'wallet_administration_retirement_draft')?.data.state).toBe('pending-owner-rebind-revoke'); expect(s.store.snapshot().campaigns[0]!.state).toBe('Draft');
    } finally { s.close(); }
  });
  it('rejects and best-effort deletes key/envelope input, never echoes or audits its contents, and offers no Telegram execution action', async () => {
    const s = await fixture(); const raw = `0x${'a'.repeat(64)}`;
    try { s.unlock(); await s.router.handle(s.message(`/walletadmin import i 1 ${raw}`)); await s.router.handle(s.message('/walletadmin import i 1 {"ciphertext":"not-accepted"}')); await s.router.handle(s.message('/walletadmin execute existing'));
      expect(s.deleted).toHaveLength(2); expect(s.sent.join('\n')).not.toContain(raw); expect(JSON.stringify(s.recorded)).not.toContain(raw); expect(s.factory).not.toHaveBeenCalled(); expect(s.importSealed).not.toHaveBeenCalled();
      expect(menuFor('viewer').some(row => row.command === 'walletadmin')).toBe(false); expect(menuFor('owner').some(row => row.command === 'walletgroups')).toBe(true);
    } finally { s.close(); }
  });
});
