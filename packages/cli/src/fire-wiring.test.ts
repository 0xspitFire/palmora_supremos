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
const SHORT = 151_000_000_000_000n; // 0.000151 ETH, like the real wallet
const NOW = new Date(Math.floor(Date.now() / 60_000) * 60_000);
const minuteText = (offsetMs: number): string => new Date(NOW.getTime() + offsetMs).toISOString().slice(0, 16);

async function setup(options: { status?: 'open' | 'upcoming' | 'ended'; failing?: string[]; kill?: boolean; maxRunWei?: bigint; balances?: Record<string, bigint>; walletsInList?: string[]; walletsUsed?: string[]; reconciliations?: Array<{ runId: string; result: string; reason?: string; observedAt: string }>; reconcileNow?: () => Promise<void>; plainReconcile?: boolean; runs?: Array<{ id: string; campaignId: string; state: string; updatedAt?: string }>; readTimeoutMs?: number; slowRead?: boolean; events?: Array<{ type: string; data: Record<string, unknown> }>; started?: Array<{ id: string; campaignId: string }>; claimedAt?: string } = {}) {
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
  const campaigns = [{ id: 'campaign_abcdef12', chainId: 4663, contract: CONTRACT, quantity: 1, dryRun: false, feePolicy: { kind: 'free', configuredPriorityFeeWei: 100_000_000n, totalFeeBudgetWei: 200_000_000_000_000n }, strategy: 'seadrop-v1-public', mintPriceWei: 0n, spendPolicy: { maxRunWei: options.maxRunWei ?? 10n ** 18n, dailyCapWei: 10n ** 18n, gasCeilingWei: 10n ** 18n }, chainVerification: { chainId: 4663, status: 'verified', seaDropCompatible: true }, state: 'draft', createdAt: 'x', updatedAt: 'x', broadcastMode: 'sequencer' }];
  const store = {
    snapshot: () => ({ attempts: [], receipts: [], reservations: [], reconciliations: options.reconciliations ?? [], events: options.events ?? [], campaigns, simulations, chainEvidence: [evidence], runs: options.runs ?? [], killed: false }),
    transaction: async (mutate: (state: { simulations: unknown[] }) => void) => { mutate({ simulations }); },
    recordLiveRunRequest: (input: Record<string, unknown>) => { requests.push(input); },
    claimLiveRunRequest: () => false,
    recentLiveRunRequests: () => [...requests].reverse().map((request) => ({ id: String(request.id ?? request.requestId), wallets: request.wallets as string[], maxFeeGwei: String(request.maxFeeGwei), requestedAt: '2026-10-25T11:00:00.000Z', expiresAt: '9999-12-31T00:00:00.000Z', outcome: request.outcome as string | undefined })),
  };
  const status = options.status ?? 'open';
  const passing = (wallet: string) => ({ wallet, simulation: 'passed' as const, estimatedGas: '120000', estimatedCostEth: '0.0000024', withinPerWalletCap: true, balanceEth: '0.001', hasEnoughForGas: true });
  const failing = (wallet: string) => ({ wallet, simulation: 'failed' as const, reason: 'reverted', estimatedGas: null, estimatedCostEth: null, withinPerWalletCap: null, balanceEth: null, hasEnoughForGas: null });
  const robinhoodDryRun = async (_contract: string, wallets: readonly string[], quantity: number | undefined): Promise<DryRunReport> => ({ contract: CONTRACT, verdict: 'ok', summary: 'ok', quantity: quantity ?? 1, wallets: status === 'open' ? wallets.map((wallet) => (options.failing?.includes(wallet) ? failing(wallet) : passing(wallet))) as never : [], drop: { priceEth: '0', opensAt: '2026-10-25T11:00:00.000Z', closesAt: '2026-10-25T14:00:00.000Z', maxPerWallet: 5, status } });
  const kicks: string[] = [];
  const fire = createFireWiring({
    mode: 'host', store: store as never, approve: async (validated) => { approvals.push(validated); return { id: 'approval_1' }; }, killSwitchPath,
    readTimeoutMs: options.readTimeoutMs, campaignWalletsUsed: () => options.walletsUsed ?? [], fireSchedules: () => schedules, startedRequests: () => (options.started ?? []).map((item) => ({ ...item, claimedAt: options.claimedAt ?? NOW.toISOString() })), unclaimedRequests: () => requests.map((request) => ({ campaignId: String(request.campaignId), expiresAt: String(request.expiresAt) })),
    walletList: async () => options.walletsInList ?? [A, B], evmPort: async () => { throw new Error('not used'); }, evmLatestBlock: async () => { throw new Error('not used'); },
    robinhoodDryRun, robinhoodLatestBlock: async () => options.slowRead ? new Promise<{ number: bigint; hash: string }>(() => undefined) : ({ number: 99n, hash: '0xabc' }), balanceOf: async (_chain, address) => options.balances?.[address.toLowerCase()] ?? 400_000_000_000_000n, kick: () => { kicks.push('kick'); }, now: () => NOW,
  });
  const base: TelegramActionDeps = {
    mode: 'host', custody: 'turnkey', store: store as never, application: { command: async () => ({ id: 'approval_1' }) } as never, coordinator: { kill: async () => undefined }, projectRoot: '/nonexistent', secretRoot: '/nonexistent', killSwitchPath,
    backupStatusPath: '/nonexistent/status.json', startedAt: NOW, walletList: async () => options.walletsInList ?? [A, B], watchedWallets: () => [], watcherHealthy: () => undefined, intelligence: () => ({}) as never, gasAlerts: () => ({}) as never,
    fire, ...(options.reconcileNow ? { reconcileNow: options.reconcileNow } : {}), fireSchedulesRepository: () => schedules, now: () => NOW, robinhoodDryRun, robinhoodLatestBlock: async () => ({ number: 99n, hash: '0xabc' }),
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

  it('a tap is refused when the campaign changed since the preview', async () => {
    const t = await setup();
    try {
      const preview = await t.actions.firePreview('campaign_abcdef12', 'all', 0.2);
      expect(preview.digest).toMatch(/^[0-9a-f]{64}$/);
      await expect(t.actions.fireNow('campaign_abcdef12', A, 0.2, 'f'.repeat(64))).rejects.toThrow('CAMPAIGN_CHANGED');
      expect(t.requests).toEqual([]);
      await expect(t.actions.fireNow('campaign_abcdef12', A, 0.2, preview.digest)).resolves.toContain('sent');
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

  it('a run still armed or active for the campaign holds a new fire back by name; one that stopped does not', async () => {
    const active = await setup({ runs: [{ id: 'run_live1', campaignId: 'campaign_abcdef12', state: 'Active' }] });
    const stopped = await setup({ runs: [{ id: 'run_old1', campaignId: 'campaign_abcdef12', state: 'Blocked' }] });
    try {
      await expect(active.actions.firePreview('campaign_abcdef12', 'all', 0.2)).rejects.toThrow(/FIRE_CONFLICT.*run_live1.*\/runs/);
      await expect(stopped.actions.firePreview('campaign_abcdef12', 'all', 0.2)).resolves.toBeDefined();
      // No clock window: a retry right after a stopped request is allowed.
      await stopped.actions.fireNow('campaign_abcdef12', A, 0.2);
      await expect(stopped.actions.fireNow('campaign_abcdef12', A, 0.2)).rejects.toThrow('FIRE_CONFLICT');
    } finally { await cleanup(active.directory); await cleanup(stopped.directory); }
  });

  it('/requests says what became of each request, and that a stopped one minted nothing', async () => {
    const t = await setup({ events: [{ type: 'live_request_result', data: { requestId: 'live_request_a', state: 'stopped', code: 'FUNDING_NOT_ARRIVED' } }, { type: 'live_request_result', data: { requestId: 'live_request_b', state: 'finished' } }, { type: 'live_request_result', data: { requestId: 'live_request_d', state: 'finished', code: 'RUN_ACTIVE' } }] });
    try {
      t.requests.push({ id: 'live_request_a', campaignId: 'campaign_abcdef12', wallets: [A], maxFeeGwei: '0.2', outcome: 'started' });
      t.requests.push({ id: 'live_request_b', campaignId: 'campaign_abcdef12', wallets: [A], maxFeeGwei: '0.2', outcome: 'started' });
      t.requests.push({ id: 'live_request_c', campaignId: 'campaign_abcdef12', wallets: [A], maxFeeGwei: '0.2' });
      t.requests.push({ id: 'live_request_d', campaignId: 'campaign_abcdef12', wallets: [A], maxFeeGwei: '0.2', outcome: 'started' });
      const text = await t.actions.requests();
      expect(text).toContain('live_request_a — stopped before minting: FUNDING_NOT_ARRIVED');
      expect(text).toContain('live_request_b — finished');
      expect(text).toContain('live_request_c — waiting for the service');
      expect(text).toContain('live_request_d — sent, settling on the chain (see /runs)');
      expect(text).toContain('A request that stopped did not mint anything');
    } finally { await cleanup(t.directory); }
  });

  it('a request the service picked up but has not armed yet holds a new fire; once it reports a result, or after 10 minutes, it does not', async () => {
    const started = [{ id: 'live_request_zz1234', campaignId: 'campaign_abcdef12' }];
    const arming = await setup({ started });
    const resulted = await setup({ started, events: [{ type: 'live_request_result', data: { requestId: 'live_request_zz1234', state: 'stopped', code: 'X' } }] });
    const old = await setup({ started, claimedAt: new Date(NOW.getTime() - 11 * 60_000).toISOString() });
    try {
      await expect(arming.actions.firePreview('campaign_abcdef12', 'all', 0.2)).rejects.toThrow(/FIRE_CONFLICT.*being started/);
      await expect(arming.actions.fireNow('campaign_abcdef12', A, 0.2)).rejects.toThrow('FIRE_CONFLICT');
      expect(arming.requests).toEqual([]);
      await expect(resulted.actions.firePreview('campaign_abcdef12', 'all', 0.2)).resolves.toBeDefined();
      await expect(old.actions.firePreview('campaign_abcdef12', 'all', 0.2)).resolves.toBeDefined();
    } finally { await cleanup(arming.directory); await cleanup(resulted.directory); await cleanup(old.directory); }
  });

  it('a run that completed a moment ago holds a new fire; an old one does not', async () => {
    const recent = await setup({ runs: [{ id: 'run_done1', campaignId: 'campaign_abcdef12', state: 'Completed', updatedAt: NOW.toISOString() }] });
    const old = await setup({ runs: [{ id: 'run_done0', campaignId: 'campaign_abcdef12', state: 'Completed', updatedAt: new Date(NOW.getTime() - 11 * 60_000).toISOString() }] });
    const paused = await setup({ runs: [{ id: 'run_pause', campaignId: 'campaign_abcdef12', state: 'Paused' }] });
    try {
      await expect(recent.actions.firePreview('campaign_abcdef12', 'all', 0.2)).rejects.toThrow(/FIRE_CONFLICT.*run_done1/);
      await expect(paused.actions.firePreview('campaign_abcdef12', 'all', 0.2)).rejects.toThrow(/FIRE_CONFLICT.*run_pause/);
      await expect(old.actions.firePreview('campaign_abcdef12', 'all', 0.2)).resolves.toBeDefined();
    } finally { await cleanup(recent.directory); await cleanup(old.directory); await cleanup(paused.directory); }
  });

  it('a chain read that does not answer fails by name, sends nothing, and leaves the campaign free to retry', async () => {
    const t = await setup({ slowRead: true, readTimeoutMs: 30 });
    try {
      await expect(t.actions.fireNow('campaign_abcdef12', A, 0.2)).rejects.toThrow('READ_TIMED_OUT');
      await expect(t.actions.fireNow('campaign_abcdef12', A, 0.2)).rejects.toThrow('READ_TIMED_OUT');
      expect(t.requests).toEqual([]);
    } finally { await cleanup(t.directory); }
  });

  it('the preview shows exactly what the fire will send: ready wallets in list order wherever they sit, and nothing funded giving the plain funding reason', async () => {
    const laterShort = await setup({ balances: { [B]: SHORT } });
    const firstShort = await setup({ balances: { [A]: SHORT } });
    const none = await setup({ balances: { [A]: SHORT, [B]: SHORT } });
    try {
      expect((await laterShort.actions.firePreview('campaign_abcdef12', 'all', 0.2)).wallets).toEqual([A]);
      expect((await firstShort.actions.firePreview('campaign_abcdef12', 'all', 0.2)).wallets).toEqual([B]);
      await expect(none.actions.firePreview('campaign_abcdef12', 'all', 0.2)).rejects.toThrow('FUNDING_NOT_ARRIVED');
      await expect(none.actions.fireNow('campaign_abcdef12', 'all', 0.2)).rejects.toThrow('FUNDING_NOT_ARRIVED');
    } finally { await cleanup(laterShort.directory); await cleanup(firstShort.directory); await cleanup(none.directory); }
  });

  it('with three wallets, a short middle wallet is left out and the ready ones either side are both used (sized for several)', async () => {
    const C = '0x' + 'c'.repeat(40);
    const t = await setup({ balances: { [B]: SHORT }, walletsInList: [A, B, C], maxRunWei: 10n ** 18n });
    try {
      const text = await t.actions.fireNow('campaign_abcdef12', 'all', 0.2);
      expect(t.requests).toEqual([expect.objectContaining({ wallets: [A, C] })]);
      expect(text).toContain('send 0.000049 ETH more');
    } finally { await cleanup(t.directory); }
  });

  it('a schedule may name any signing wallet, wherever it sits; a stranger is refused when it is made', async () => {
    const t = await setup();
    try {
      await expect(t.actions.schedulePreview('campaign_abcdef12', B, 0.2, ...WINDOW)).resolves.toBeDefined();
      await expect(t.actions.schedulePreview('campaign_abcdef12', '0x' + 'd'.repeat(40), 0.2, ...WINDOW)).rejects.toThrow('WALLET_NOT_IN_FLEET');
      await expect(t.actions.scheduleCreate('campaign_abcdef12', '0x' + 'd'.repeat(40), 0.2, ...WINDOW, 'x')).rejects.toThrow('WALLET_NOT_IN_FLEET');
    } finally { await cleanup(t.directory); }
  });

  it('the guided request offers the ready wallets, in list order, wherever they sit', async () => {
    const t = await setup({ balances: { [B]: SHORT } });
    try {
      await t.actions.simulateCampaign('campaign_abcdef12');
      const found = await t.actions.requestWallets('campaign_abcdef12');
      expect(found.wallets).toEqual([A]);
      expect(found.note).toContain('left out');
    } finally { await cleanup(t.directory); }
  });

  it('a wallet that already has an attempt on the campaign is left out by name before anything is sent (prepare a new campaign)', async () => {
    const t = await setup({ walletsUsed: [A.toLowerCase()] });
    const all = await setup({ walletsUsed: [A.toLowerCase(), B.toLowerCase()] });
    try {
      // The first wallet is used up, so the second goes; with both used up nothing can, and the reason names the fix.
      await t.actions.fireNow('campaign_abcdef12', 'all', 0.2);
      expect(t.requests).toEqual([expect.objectContaining({ wallets: [B] })]);
      await expect(all.actions.fireNow('campaign_abcdef12', 'all', 0.2)).rejects.toThrow(/FUNDING_NOT_ARRIVED.*prepare a new campaign/);
      expect(all.requests).toEqual([]);
    } finally { await cleanup(t.directory); await cleanup(all.directory); }
  });

  it('/reconcile checks the chain now and says where each waiting run stands, in plain words, with the reason when unproven (T-086)', async () => {
    let calls = 0;
    const runs = [{ id: 'run_wait1', campaignId: 'campaign_abcdef12', state: 'Active', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), mode: 'live', intentId: 'i', requestDigest: 'd' }];
    const t = await setup({ runs: runs as never, reconcileNow: async () => { calls += 1; }, reconciliations: [{ runId: 'run_wait1', result: 'unknown', reason: 'a receipt, its finality or its L1 data fee could not be proven; outcome unresolved', observedAt: NOW.toISOString() }] });
    const quiet = await setup({ reconcileNow: async () => undefined });
    const broken = await setup({ runs: runs as never, reconcileNow: async () => { throw new Error('some provider said https://rpc.example/key'); } });
    const practice = await setup();
    try {
      const text = await t.actions.reconcile();
      expect(calls).toBe(1);
      expect(text).toContain('run_wait1');
      expect(text).toContain('not yet proven by the chain');
      expect(text).toContain('could not be proven');
      expect(text).toContain('Robinhood is final only after Ethereum finalises it');
      // A second call right away is not sent to the chain again.
      expect(await t.actions.reconcile()).toContain('Checked a moment ago');
      expect(calls).toBe(1);
      expect(await quiet.actions.reconcile()).toContain('Nothing is waiting to settle.');
      // A failing check says so with a fixed code only, never the provider text.
      const failed = await broken.actions.reconcile();
      expect(failed).toContain('RECONCILE_FAILED');
      expect(failed).not.toContain('rpc.example');
      expect(await practice.actions.reconcile()).toContain('not available here');
    } finally { await cleanup(t.directory); await cleanup(quiet.directory); await cleanup(broken.directory); await cleanup(practice.directory); }
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
      await expect(open.actions.firePreview('campaign_abcdef12', 'all', 0.2)).rejects.toThrow(/FIRE_CONFLICT.*a live request for this campaign/);
      await expect(open.actions.fireNow('campaign_abcdef12', A, 0.2)).rejects.toThrow('FIRE_CONFLICT');
      expect(open.requests).toHaveLength(1);
      expect([early, ended, killed].flatMap((item) => item.requests)).toEqual([]);
    } finally { await Promise.all([early, ended, killed, open].map((item) => cleanup(item.directory))); }
  });
});

describe('a campaign sized for fewer wallets than pass (the screenshot bug)', () => {
  const ONE = 200_000_000_000_000n;

  it('/fire uses only as many wallets as the campaign was sized for and says the others were left out, instead of failing', async () => {
    const t = await setup({ maxRunWei: ONE });
    try {
      const preview = await t.actions.firePreview('campaign_abcdef12', 'all', 0.2);
      // Both are listed: the first one that passes its test mint is used, so a failing first wallet does not stop it.
      expect(preview.wallets).toEqual([A, B]);
      expect(preview.text).toContain('sized for 1 wallet(s), so it uses the first 1 that pass their test mint');
      expect(preview.text).toContain('from 1 wallet(s)');
      const text = await t.actions.fireNow('campaign_abcdef12', `${A},${B}`, 0.2);
      expect(text).toContain('Request');
      expect(text).toContain('sized for fewer wallets');
      expect(t.requests).toEqual([expect.objectContaining({ wallets: [A] })]);
    } finally { await cleanup(t.directory); }
  });

  it('when the first wallet fails its test mint, the next ready wallet is used (sized for 1); a campaign sized for none is refused with a clear reason', async () => {
    const t = await setup({ maxRunWei: ONE, failing: [A] });
    const none = await setup({ maxRunWei: 1_000n });
    try {
      const text = await t.actions.fireNow('campaign_abcdef12', `${A},${B}`, 0.2);
      expect(text).toContain('Request');
      expect(t.requests).toEqual([expect.objectContaining({ wallets: [B] })]);
      await expect(none.actions.firePreview('campaign_abcdef12', 'all', 0.2)).rejects.toThrow('CAMPAIGN_SIZED_FOR_NONE');
      await expect(none.actions.schedulePreview('campaign_abcdef12', 'all', 0.2, ...WINDOW)).rejects.toThrow('CAMPAIGN_SIZED_FOR_NONE');
    } finally { await Promise.all([cleanup(t.directory), cleanup(none.directory)]); }
  });

  it('a schedule sized for fewer wallets than listed says so, and its phrase and amount count only the sized wallets', async () => {
    const t = await setup({ maxRunWei: ONE, status: 'upcoming' });
    try {
      const preview = await t.actions.schedulePreview('campaign_abcdef12', 'all', 0.2, ...WINDOW);
      expect(preview.wallets).toEqual([A, B]);
      expect(preview.text).toContain('sized for 1 wallet(s), so it uses the first 1 that pass their test mint');
      expect(preview.text).toContain('from 1 wallet(s)');
      expect(preview.phrase).toContain('1-WALLETS 0.0002');
    } finally { await cleanup(t.directory); }
  });

  it('simulate then request: the test mints, the wallet list (at most the sized number), a clear refusal for too many, a request only with the reviewed phrase', async () => {
    const t = await setup({ maxRunWei: ONE });
    try {
      const simulated = await t.actions.simulateCampaign('campaign_abcdef12');
      expect(simulated).toMatchObject({ recorded: [A, B], sized: 1 });
      expect(simulated.text).toContain('2 wallet(s) passed the test mint');
      expect(simulated.text).toContain('sized for 1 wallet(s), so a request uses at most 1');
      expect(simulated.text).not.toContain('/request');
      expect((await t.actions.requestCandidates()).map((item) => item.id)).toEqual(['campaign_abcdef12']);
      expect(await t.actions.requestWallets('campaign_abcdef12')).toEqual({ wallets: [A, B], sized: 1 });
      await expect(t.actions.requestPreview('campaign_abcdef12', `${A},${B}`, 0.2)).rejects.toThrow(/PLANNED_EXPOSURE_INVALID: this campaign was sized for 1 wallet\(s\); you chose 2/);
      const preview = await t.actions.requestPreview('campaign_abcdef12', A, 0.2);
      await expect(t.actions.requestSend('campaign_abcdef12', A, 0.2, 'LIVE-REQUEST wrong')).rejects.toThrow('PLAN_CHANGED');
      expect(t.requests).toEqual([]);
      await expect(t.actions.requestSend('campaign_abcdef12', A, 0.2, preview.phrase)).resolves.toContain('Request');
      expect(t.requests).toEqual([expect.objectContaining({ campaignId: 'campaign_abcdef12', wallets: [A] })]);
    } finally { await cleanup(t.directory); }
  });

  it('what can be cancelled lists open schedules and unclaimed requests, and cancels one by its id', async () => {
    const t = await setup({ maxRunWei: ONE, status: 'upcoming' });
    try {
      expect(await t.actions.cancellables()).toEqual([]);
      const preview = await t.actions.schedulePreview('campaign_abcdef12', A, 0.2, ...WINDOW);
      await t.actions.scheduleCreate('campaign_abcdef12', A, 0.2, ...WINDOW, preview.phrase);
      const [item] = await t.actions.cancellables();
      expect(item!.label).toContain('Schedule');
      expect(await t.actions.cancel(item!.id)).toContain('cancelled');
      expect(await t.actions.cancellables()).toEqual([]);
    } finally { await cleanup(t.directory); }
  });
});

describe('a run needs each wallet to hold its full worst case (the second live attempt)', () => {
  // The campaign's worst case per wallet is its fee budget, 0.0002 ETH.
  it('/fire leaves out a wallet that holds less than a run needs, names the exact top-up, and fires a ready one wherever it sits', async () => {
    const laterShort = await setup({ balances: { [B]: SHORT } });
    const firstShort = await setup({ balances: { [A]: SHORT } });
    try {
      const preview = await laterShort.actions.firePreview('campaign_abcdef12', `${A},${B}`, 0.2);
      expect(preview.wallets).toEqual([A]);
      expect(preview.text).toContain('left out');
      expect(preview.text).toContain('it holds 0.000151 ETH and a run needs at least 0.0002 ETH: send 0.000049 ETH more first');
      expect(await laterShort.actions.fireNow('campaign_abcdef12', `${A},${B}`, 0.2)).toContain('send 0.000049 ETH more');
      expect(laterShort.requests).toEqual([expect.objectContaining({ wallets: [A] })]);
      // D-073: a ready second wallet is used when the first is short.
      const text = await firstShort.actions.fireNow('campaign_abcdef12', `${A},${B}`, 0.2);
      expect(text).toContain('send 0.000049 ETH more');
      expect(firstShort.requests).toEqual([expect.objectContaining({ wallets: [B] })]);
    } finally { await cleanup(laterShort.directory); await cleanup(firstShort.directory); }
  });
  it('a request with a wallet list (typed or chosen) is refused with the top-up when a listed wallet is short, and a ready later wallet is used when the first is short', async () => {
    const t = await setup({ balances: { [A]: SHORT }, maxRunWei: 200_000_000_000_000n });
    try {
      await t.actions.simulateCampaign('campaign_abcdef12');
      await expect(t.actions.requestPreview('campaign_abcdef12', A, 0.2)).rejects.toThrow(/FUNDING_NOT_ARRIVED.*send 0\.000049 ETH more first/);
      // D-073: a funded second wallet alone is fine, wherever it sits in the list; a stranger is refused by name.
      await expect(t.actions.requestPreview('campaign_abcdef12', B, 0.2)).resolves.toMatchObject({ wallets: [B] });
      await expect(t.actions.requestPreview('campaign_abcdef12', '0x' + 'd'.repeat(40), 0.2)).rejects.toThrow('WALLET_NOT_IN_FLEET');
      // Sized for one wallet with the first short: the funded second wallet is used.
      await t.actions.fireNow('campaign_abcdef12', `${A},${B}`, 0.2);
      expect(t.requests).toEqual([expect.objectContaining({ wallets: [B] })]);
    } finally { await cleanup(t.directory); }
  });

  it('the simulate-then-request path says who needs funding, offers only funded wallets, and an unreadable balance counts as short (fail closed)', async () => {
    const t = await setup({ balances: { [A]: SHORT } });
    try {
      const simulated = await t.actions.simulateCampaign('campaign_abcdef12');
      expect(simulated.text).toContain('needs funding');
      expect(simulated.text).toContain('send 0.000049 ETH more');
      expect(await t.actions.requestWallets('campaign_abcdef12')).toMatchObject({ wallets: [B], note: expect.stringContaining('left out') });
      const split = await t.fire.fundingSplit({ chainId: 4663, quantity: 1, mintPriceWei: 0n, feePolicy: { kind: 'free', configuredPriorityFeeWei: 0n, totalFeeBudgetWei: 200_000_000_000_000n } } as never, [A]);
      expect(split.short[0]!.why).toContain('send 0.000049 ETH more');
    } finally { await cleanup(t.directory); }
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
      expect(await t.actions.kill()).toContain('1 scheduled mint(s) cancelled');
      expect(t.schedules.open()).toEqual([]);
      expect(await t.actions.schedules()).toContain('cancelled');
    } finally { await cleanup(t.directory); }
  });

  it('a relative window resolves once at the preview, so the stored times match the phrase; /request refuses while a schedule is open', async () => {
    const t = await setup({ status: 'upcoming' });
    try {
      const preview = await t.actions.schedulePreview('campaign_abcdef12', A, 0.2, '+30m', '+2h');
      expect(preview.from).toBe(new Date(NOW.getTime() + 30 * 60_000).toISOString());
      // The router passes these resolved times to /confirm; they must give the same phrase later.
      await expect(t.actions.scheduleCreate('campaign_abcdef12', A, 0.2, preview.from, preview.until, preview.phrase)).resolves.toContain('stored');
      await expect(t.actions.requestCreate('campaign_abcdef12', A, 0.2, 'x')).rejects.toThrow('FIRE_CONFLICT');
      await expect(t.actions.schedulePreview('campaign_abcdef12', A, 1e-7, ...WINDOW)).rejects.toThrow('MAX_FEE_GWEI_REQUIRED');
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
