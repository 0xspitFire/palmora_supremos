import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FireScheduleRepository, openDatabase } from '@mint-bot/database';
import { createFireWiring } from './fire-wiring.js';
import { createTelegramActions, type TelegramActionDeps } from './telegram-actions.js';
import type { DryRunReport } from './robinhood-readonly.js';

/** T-067 (D-067): `/fire` and `/schedule` through the real actions, the shared pipeline and the schedule table, with a fake store and chain. */
const CONTRACT = '0xa686fde3299d5451af22382240e0dff62f7b94db';
const A = '0x365952eb1e8209bf2bcc2db5ed213111a87d061e';
const B = '0x81c104dcb898416fd4f81ead091dba5b8f46f37a';
// The test mints are stamped by the real clock, so the test clock starts at the real time (whole minutes).
const NOW = new Date(Math.floor(Date.now() / 60_000) * 60_000);
const minuteText = (offsetMs: number): string => new Date(NOW.getTime() + offsetMs).toISOString().slice(0, 16);

async function setup(options: { status?: 'open' | 'upcoming' | 'ended'; failing?: string[]; kill?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'mintbot-fire-'));
  const killSwitchPath = join(directory, 'killswitch');
  if (options.kill) await writeFile(killSwitchPath, 'on\n');
  const db = openDatabase();
  db.prepare("INSERT INTO chain_profile (id, chain_id, name, rpc_endpoints_json, confirmation_depth, created_at) VALUES ('chain', 4663, 'Robinhood', '[]', 2, '2026-01-01T00:00:00.000Z')").run();
  db.prepare("INSERT INTO contract (id, chain_profile_id, address, kind) VALUES ('contract', 'chain', '0xc', 'nft')").run();
  db.prepare("INSERT INTO collection (id, contract_id, name) VALUES ('collection', 'contract', 'c')").run();
  db.prepare("INSERT INTO \"drop\" (id, collection_id, strategy, mint_price_wei, observed_at) VALUES ('drop', 'collection', 'test', '0', '2026-01-01T00:00:00.000Z')").run();
  db.prepare("INSERT INTO campaign (id, drop_id, state, created_at) VALUES ('campaign_abcdef12', 'drop', 'draft', '2026-01-01T00:00:00.000Z')").run();
  const schedules = new FireScheduleRepository(db, () => NOW);
  const simulations: Array<Record<string, unknown>> = [];
  const requests: Array<Record<string, unknown>> = [];
  const approvals: unknown[] = [];
  const evidence = { id: 'verification_abc', chainId: 4663, status: 'accepted', executionEnabled: true, checkedAt: '2026-10-25T11:00:00.000Z', expiresAt: '9999-12-31T23:59:59.999Z', sourceBlock: 1n, endpointIdentity: 'robinhood-sequencer' };
  const campaigns = [{ id: 'campaign_abcdef12', chainId: 4663, contract: CONTRACT, quantity: 1, dryRun: false, feePolicy: { kind: 'free', configuredPriorityFeeWei: 100_000_000n, totalFeeBudgetWei: 200_000_000_000_000n }, strategy: 'seadrop-v1-public', mintPriceWei: 0n, spendPolicy: { maxRunWei: 10n ** 18n, dailyCapWei: 10n ** 18n, gasCeilingWei: 10n ** 18n }, chainVerification: { chainId: 4663, status: 'verified', seaDropCompatible: true }, state: 'draft', createdAt: 'x', updatedAt: 'x', broadcastMode: 'sequencer' }];
  const store = {
    snapshot: () => ({ events: [], campaigns, simulations, chainEvidence: [evidence], runs: [], killed: false }),
    transaction: async (mutate: (state: { simulations: unknown[] }) => void) => { mutate({ simulations }); },
    recordLiveRunRequest: (input: Record<string, unknown>) => { requests.push(input); },
    claimLiveRunRequest: () => false,
  };
  const status = options.status ?? 'open';
  const passing = (wallet: string) => ({ wallet, simulation: 'passed' as const, estimatedGas: '120000', estimatedCostEth: '0.0000024', withinPerWalletCap: true, balanceEth: '0.001', hasEnoughForGas: true });
  const failing = (wallet: string) => ({ wallet, simulation: 'failed' as const, reason: 'reverted', estimatedGas: null, estimatedCostEth: null, withinPerWalletCap: null, balanceEth: null, hasEnoughForGas: null });
  const robinhoodDryRun = async (_contract: string, wallets: readonly string[], quantity: number | undefined): Promise<DryRunReport> => ({ contract: CONTRACT, verdict: 'ok', summary: 'ok', quantity: quantity ?? 1, wallets: status === 'open' ? wallets.map((wallet) => (options.failing?.includes(wallet) ? failing(wallet) : passing(wallet))) as never : [], drop: { priceEth: '0', opensAt: '2026-10-25T11:00:00.000Z', closesAt: '2026-10-25T14:00:00.000Z', maxPerWallet: 5, status } });
  const kicks: string[] = [];
  const fire = createFireWiring({
    mode: 'host', store: store as never, approve: async (validated) => { approvals.push(validated); return { id: 'approval_1' }; }, killSwitchPath,
    fireSchedules: () => schedules, unclaimedRequests: () => requests.map((request) => ({ campaignId: String(request.campaignId), expiresAt: String(request.expiresAt) })),
    walletList: async () => [A, B], evmPort: async () => { throw new Error('not used'); }, evmLatestBlock: async () => { throw new Error('not used'); },
    robinhoodDryRun, robinhoodLatestBlock: async () => ({ number: 99n, hash: '0xabc' }), kick: () => { kicks.push('kick'); }, now: () => NOW,
  });
  const base: TelegramActionDeps = {
    mode: 'host', custody: 'turnkey', store: store as never, application: {} as never, coordinator: { kill: async () => undefined }, projectRoot: '/nonexistent', secretRoot: '/nonexistent', killSwitchPath,
    backupStatusPath: '/nonexistent/status.json', startedAt: NOW, walletList: async () => [A, B], watchedWallets: () => [], watcherHealthy: () => undefined, intelligence: () => ({}) as never, gasAlerts: () => ({}) as never,
    fire, fireSchedulesRepository: () => schedules, now: () => NOW,
  };
  return { actions: createTelegramActions(base), fire, schedules, simulations, requests, approvals, kicks, directory, practice: createTelegramActions({ ...base, mode: 'dry-run' }) };
}
const cleanup = (directory: string) => rm(directory, { recursive: true, force: true });
const WINDOW = [minuteText(30 * 60_000), minuteText(3 * 3_600_000)] as const;
const compactText = (text: string): string => `${text.replace(/[-:]/g, '')}00Z`;

describe('/fire', () => {
  it('previews only when the mint is open, then tests, approves, requests and nudges the processor in one go', async () => {
    const t = await setup();
    try {
      const preview = await t.actions.firePreview('campaign_abcdef12', 'all', 0.2);
      expect(preview.wallets).toEqual([A, B]);
      expect(preview.text).toContain('OPEN');
      expect(t.requests).toEqual([]);
      const text = await t.actions.fireNow('campaign_abcdef12', preview.wallets.join(','), 0.2);
      expect(text).toContain('2 wallet(s)');
      expect(t.simulations.map((item) => item.wallet)).toEqual([A, B]);
      expect(t.approvals).toHaveLength(1);
      expect(t.requests).toEqual([expect.objectContaining({ campaignId: 'campaign_abcdef12', wallets: [A, B], maxFeeGwei: '0.2', approvalId: 'approval_1' })]);
      expect(t.kicks).toEqual(['kick']);
    } finally { await cleanup(t.directory); }
  });

  it('a wallet that fails its test mint is left out and named; the others still go', async () => {
    const t = await setup({ failing: [B] });
    try {
      const text = await t.actions.fireNow('campaign_abcdef12', `${A},${B}`, 0.2);
      expect(text).toContain('1 wallet(s)');
      expect(text).toContain('skipped');
      expect(t.requests[0]).toEqual(expect.objectContaining({ wallets: [A] }));
    } finally { await cleanup(t.directory); }
  });

  it('refuses before the mint opens or after it ended (suggesting /schedule), with the kill switch on, in practice mode, and for a second fire', async () => {
    const early = await setup({ status: 'upcoming' });
    const ended = await setup({ status: 'ended' });
    const killed = await setup({ kill: true });
    const open = await setup();
    try {
      await expect(early.actions.firePreview('campaign_abcdef12', 'all', 0.2)).rejects.toThrow(/MINT_NOT_OPEN.*\/schedule/);
      await expect(ended.actions.firePreview('campaign_abcdef12', 'all', 0.2)).rejects.toThrow('MINT_NOT_OPEN');
      await expect(killed.actions.firePreview('campaign_abcdef12', 'all', 0.2)).rejects.toThrow('KILL_SWITCH_ON');
      await expect(killed.actions.fireNow('campaign_abcdef12', A, 0.2)).rejects.toThrow('KILL_SWITCH_ON');
      await expect(open.practice.firePreview('campaign_abcdef12', 'all', 0.2)).rejects.toThrow('LIVE_MODE_REQUIRED');
      await expect(open.actions.firePreview('campaign_abcdef12', 'all', 0)).rejects.toThrow('MAX_FEE_GWEI_REQUIRED');
      await expect(open.actions.firePreview('nope', 'all', 0.2)).rejects.toThrow('CAMPAIGN_NOT_FOUND');
      await open.actions.fireNow('campaign_abcdef12', A, 0.2);
      await expect(open.actions.firePreview('campaign_abcdef12', 'all', 0.2)).rejects.toThrow(/FIRE_CONFLICT.*waiting/);
      await expect(open.actions.fireNow('campaign_abcdef12', A, 0.2)).rejects.toThrow('FIRE_CONFLICT');
      expect(open.requests).toHaveLength(1);
      expect([early, ended, killed].flatMap((item) => item.requests)).toEqual([]);
    } finally { await Promise.all([early, ended, killed, open].map((item) => cleanup(item.directory))); }
  });
});

describe('/schedule', () => {
  it('stores an immutable schedule only with the exact phrase, and refuses a second one for the same campaign', async () => {
    const t = await setup({ status: 'upcoming' });
    try {
      const preview = await t.actions.schedulePreview('campaign_abcdef12', 'all', 0.2, ...WINDOW);
      expect(preview.phrase).toBe(`SCHEDULE abcdef12 2-WALLETS 0.0004 0.2-GWEI ${compactText(WINDOW[0])}-${compactText(WINDOW[1])}`);
      expect(t.schedules.open()).toEqual([]);
      await expect(t.actions.scheduleCreate('campaign_abcdef12', preview.wallets.join(','), 0.2, ...WINDOW, 'SCHEDULE wrong')).rejects.toThrow('CONFIRMATION_PHRASE_MISMATCH');
      await expect(t.actions.scheduleCreate('campaign_abcdef12', A, 0.2, ...WINDOW, preview.phrase)).rejects.toThrow('CONFIRMATION_PHRASE_MISMATCH');
      expect(t.schedules.open()).toEqual([]);
      const text = await t.actions.scheduleCreate('campaign_abcdef12', preview.wallets.join(','), 0.2, ...WINDOW, preview.phrase);
      expect(text).toContain('stored');
      const [stored] = t.schedules.open();
      expect(stored).toEqual(expect.objectContaining({ campaignId: 'campaign_abcdef12', wallets: [A, B], maxFeeGwei: '0.2', windowFrom: `${WINDOW[0]}:00.000Z`, windowUntil: `${WINDOW[1]}:00.000Z` }));
      expect(await t.actions.schedules()).toContain('waiting for its window');
      await expect(t.actions.schedulePreview('campaign_abcdef12', 'all', 0.2, ...WINDOW)).rejects.toThrow(/FIRE_CONFLICT/);
      await expect(t.actions.firePreview('campaign_abcdef12', 'all', 0.2)).rejects.toThrow();
    } finally { await cleanup(t.directory); }
  });

  it('refuses a bad window, a window over 6 hours, practice mode and the kill switch', async () => {
    const t = await setup();
    const killed = await setup({ kill: true });
    try {
      await expect(t.actions.schedulePreview('campaign_abcdef12', 'all', 0.2, 'soon', 'later')).rejects.toThrow('WINDOW_INVALID');
      await expect(t.actions.schedulePreview('campaign_abcdef12', 'all', 0.2, WINDOW[0], minuteText(7 * 3_600_000))).rejects.toThrow('WINDOW_TOO_LONG');
      await expect(t.actions.schedulePreview('campaign_abcdef12', 'all', 0.2, minuteText(-3 * 3_600_000), minuteText(-2 * 3_600_000))).rejects.toThrow('WINDOW_IN_THE_PAST');
      await expect(t.practice.schedulePreview('campaign_abcdef12', 'all', 0.2, ...WINDOW)).rejects.toThrow('LIVE_MODE_REQUIRED');
      await expect(killed.actions.schedulePreview('campaign_abcdef12', 'all', 0.2, ...WINDOW)).rejects.toThrow('KILL_SWITCH_ON');
    } finally { await Promise.all([cleanup(t.directory), cleanup(killed.directory)]); }
  });

  it('/cancel ends a schedule by its short id, and /kill ends every open schedule', async () => {
    const t = await setup({ status: 'upcoming' });
    try {
      const preview = await t.actions.schedulePreview('campaign_abcdef12', A, 0.2, ...WINDOW);
      await t.actions.scheduleCreate('campaign_abcdef12', A, 0.2, ...WINDOW, preview.phrase);
      const short = t.schedules.open()[0]!.id.slice(-6);
      expect(await t.actions.cancel(short)).toContain('cancelled');
      expect(t.schedules.open()).toEqual([]);
      expect(await t.actions.cancel(short)).toContain('Not cancelled');
      const again = await t.actions.schedulePreview('campaign_abcdef12', A, 0.2, ...WINDOW);
      await t.actions.scheduleCreate('campaign_abcdef12', A, 0.2, ...WINDOW, again.phrase);
      expect(t.schedules.open()).toHaveLength(1);
      expect(await t.actions.kill()).toContain('Scheduled mints are cancelled');
      expect(t.schedules.open()).toEqual([]);
      expect(await t.actions.schedules()).toContain('cancelled');
    } finally { await cleanup(t.directory); }
  });

  it('the scheduler-side fire uses the same pipeline and frees the campaign when done', async () => {
    const t = await setup();
    try {
      const preview = await t.actions.schedulePreview('campaign_abcdef12', 'all', 0.2, ...WINDOW);
      await t.actions.scheduleCreate('campaign_abcdef12', 'all', 0.2, ...WINDOW, preview.phrase);
      const schedule = t.schedules.open()[0]!;
      expect(t.fire.conflict('campaign_abcdef12')).toMatch(/scheduled mint/);
      expect(t.fire.conflict('campaign_abcdef12', schedule.id)).toBeUndefined();
      t.schedules.claim(schedule.id, 'started');
      await t.fire.fireSchedule(schedule);
      expect(t.requests).toHaveLength(1);
      expect(t.kicks).toEqual(['kick']);
    } finally { await cleanup(t.directory); }
  });
});
