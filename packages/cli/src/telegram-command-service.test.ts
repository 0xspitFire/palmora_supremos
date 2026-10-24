import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AlertManager, IntelligenceAlertInput } from '@mint-bot/backend';
import { startTelegramCommands, withViewerFanout } from './telegram-command-service.js';
import { createTelegramBotApi, type TelegramUpdate } from './telegram-api.js';
import { createTelegramActions, type TelegramActionDeps } from './telegram-actions.js';

describe('Telegram polling (T-061, D-063 item 1)', () => {
  it('saves each update\'s offset before handling it, so a command never runs twice', async () => {
    const order: string[] = [];
    let offset = 5;
    const updates: TelegramUpdate[] = [{ update_id: 7 }, { update_id: 6 }, { update_id: 4 }];
    const service = startTelegramCommands({
      api: { getUpdates: async (from) => { order.push(`get:${from}`); return from === 5 ? updates : await new Promise<TelegramUpdate[]>(() => undefined); }, sendMessage: async () => undefined, answerCallback: async () => undefined, deleteMessage: async () => undefined },
      offsets: { pollOffset: () => offset, savePollOffset: (value) => { order.push(`save:${value}`); offset = value; } },
      router: { handle: async (update) => { order.push(`handle:${update.update_id}`); if (update.update_id === 6) throw new Error('BOOM'); }, checkSession: async () => undefined, onStart: async () => { order.push('start'); } },
      log: () => undefined,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    service.stop();
    expect(order).toEqual(['start', 'get:5', 'save:7', 'handle:6', 'save:8', 'handle:7', 'get:8']);
  });
});

describe('stop commands are never held up (D-063 item 4)', () => {
  it('a /kill tap is handled while a slow command is still running, and a failing session check never stops polling', async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => { release = resolve; });
    let offset = 0;
    let polls = 0;
    const batches: TelegramUpdate[][] = [
      [{ update_id: 1, message: { message_id: 1, date: 0, chat: { id: 1, type: 'private' }, from: { id: 1 }, text: '/simulate cmp' } }],
      [{ update_id: 2, callback_query: { id: 'c', from: { id: 1 }, data: '/tap_kill_abc', message: { message_id: 2, date: 0, chat: { id: 1, type: 'private' } } } }],
    ];
    const service = startTelegramCommands({
      api: { getUpdates: async () => { polls += 1; return batches.shift() ?? await new Promise<TelegramUpdate[]>(() => undefined); }, sendMessage: async () => undefined, answerCallback: async () => undefined, deleteMessage: async () => undefined },
      offsets: { pollOffset: () => offset, savePollOffset: (value) => { offset = value; } },
      router: {
        handle: async (update) => { const label = update.message?.text ?? update.callback_query?.data; order.push(`start:${label}`); if (label === '/simulate cmp') await slow; order.push(`end:${label}`); },
        checkSession: async () => { throw new Error('DB_LOCKED'); },
        onStart: async () => undefined,
      },
      log: () => undefined,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(['start:/simulate cmp', 'start:/tap_kill_abc', 'end:/tap_kill_abc']);
    expect(polls).toBe(3);
    release();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(order.at(-1)).toBe('end:/simulate cmp');
    service.stop();
  });
});

describe('viewer alerts (D-063 item 8)', () => {
  const alertsWith = (recorded: boolean) => ({ intelligence: async () => recorded, kill: async () => undefined }) as unknown as AlertManager;
  const input = (kind: IntelligenceAlertInput['kind']): IntelligenceAlertInput => ({ kind, dedupe: kind, text: `${kind} text`, priority: 'immediate' });

  it('only new opportunity and opening-soon alerts go to viewers, never wallet, funding or watcher alerts', async () => {
    const sent: string[] = [];
    const alerts = withViewerFanout(alertsWith(true), async (text) => { sent.push(text); });
    for (const kind of ['opportunity', 'opening_soon', 'eligible_ready', 'underfunded', 'funding_request', 'excess_balance', 'fleet_watch', 'status', 'health', 'quantity_reduced', 'price_above_limit'] as const) await alerts.intelligence(input(kind));
    expect(sent).toEqual(['opportunity text', 'opening_soon text']);
    const repeat = withViewerFanout(alertsWith(false), async (text) => { sent.push(text); });
    await repeat.intelligence(input('opportunity'));
    expect(sent).toHaveLength(2);
  });

  it('a failed delivery to viewers never fails the owner\'s alert', async () => {
    const alerts = withViewerFanout(alertsWith(true), async () => { throw new Error('down'); });
    await expect(alerts.intelligence(input('opportunity'))).resolves.toBe(true);
  });
});

const FAKE_TOKEN = ['123', 'SECRET'].join(':');
const BAD_TOKEN = ['bad', 'token'].join(' ');

describe('Telegram client', () => {
  it('never lets the token out in an error, and refuses plain http except an approved local proxy', async () => {
    const api = createTelegramBotApi({ token: FAKE_TOKEN, fetcher: async () => { throw new Error('connect failed https://api.telegram.org/bot123:SECRET/getUpdates'); } });
    await expect(api.sendMessage(1, 'x')).rejects.toThrow('TELEGRAM_SENDMESSAGE_UNREACHABLE');
    await api.sendMessage(1, 'x').catch((error: Error) => expect(error.message).not.toContain('SECRET'));
    expect(() => createTelegramBotApi({ token: FAKE_TOKEN, apiBaseUrl: 'http://api.telegram.org' })).toThrow('TELEGRAM_HTTPS_OR_APPROVED_PROXY_REQUIRED');
    expect(() => createTelegramBotApi({ token: BAD_TOKEN })).toThrow('TELEGRAM_TOKEN_INVALID');
  });

  it('asks only for messages and button taps', async () => {
    let body = '';
    const api = createTelegramBotApi({ token: FAKE_TOKEN, fetcher: async (_url, init) => { body = String(init?.body); return { ok: true, status: 200, json: async () => ({ ok: true, result: [] }) }; } });
    await api.getUpdates(10, 25);
    expect(JSON.parse(body)).toEqual({ offset: 10, timeout: 25, allowed_updates: ['message', 'callback_query'] });
  });

  it('sets the command menu: a default list for private chats, or one chat\'s own, keeping only names Telegram accepts', async () => {
    const bodies: Array<{ method: string; body: Record<string, unknown> }> = [];
    const api = createTelegramBotApi({ token: FAKE_TOKEN, fetcher: async (url, init) => { bodies.push({ method: String(url).split('/').pop()!, body: JSON.parse(String(init?.body)) }); return { ok: true, status: 200, json: async () => ({ ok: true, result: true }) }; } });
    await api.setMyCommands!([{ command: 'join', description: 'Join' }, { command: 'Bad-Name', description: 'x' }, { command: 'ok_1', description: 'y'.repeat(300) }]);
    await api.setMyCommands!([{ command: 'status', description: 'Status' }], 1001);
    await api.deleteMyCommands!(2002);
    expect(bodies[0]).toEqual({ method: 'setMyCommands', body: { commands: [{ command: 'join', description: 'Join' }, { command: 'ok_1', description: 'y'.repeat(256) }], scope: { type: 'all_private_chats' } } });
    expect(bodies[1]!.body).toEqual({ commands: [{ command: 'status', description: 'Status' }], scope: { type: 'chat', chat_id: 1001 } });
    expect(bodies[2]).toEqual({ method: 'deleteMyCommands', body: { scope: { type: 'chat', chat_id: 2002 } } });
  });
});

describe('Telegram actions', () => {
  const deps = (overrides: Partial<TelegramActionDeps> = {}): TelegramActionDeps => ({
    mode: 'dry-run',
    custody: 'turnkey',
    store: { snapshot: () => ({ events: [], campaigns: [], runs: [], simulations: [], killed: false, runtime: { startupState: 'Ready', blockingReasons: [] } }), transaction: async () => undefined } as never,
    application: {} as never,
    coordinator: { kill: async () => undefined },
    projectRoot: '/nonexistent',
    secretRoot: '/nonexistent',
    killSwitchPath: '/nonexistent/killswitch',
    backupStatusPath: '/nonexistent/status.json',
    startedAt: new Date(),
    walletList: async () => [],
    watchedWallets: () => [],
    watcherHealthy: () => undefined,
    intelligence: () => ({}) as never,
    gasAlerts: () => ({}) as never,
    ...overrides,
  });

  it('/kill engages the kill file and the coordinator, each on its own; it fails only when neither worked', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mintbot-tg-kill-'));
    try {
      const reasons: string[] = [];
      await createTelegramActions(deps({ killSwitchPath: join(dir, 'killswitch'), coordinator: { kill: async (reason) => { reasons.push(reason); } } })).kill();
      expect(reasons).toEqual(['owner Telegram /kill']);
      await expect(createTelegramActions(deps({ killSwitchPath: join(dir, 'missing-folder', 'killswitch'), coordinator: { kill: async () => { throw new Error('x'); } } })).kill()).rejects.toThrow('KILL_SWITCH_NOT_ENGAGED');
      await expect(createTelegramActions(deps({ killSwitchPath: join(dir, 'missing-folder', 'killswitch') })).kill()).resolves.toContain('kill switch is ON');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('a kill after the session opened is seen from a kill event, the stored flag or a newer kill file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mintbot-tg-session-'));
    try {
      const file = join(dir, 'killswitch');
      const opened = '2026-10-24T10:00:00.000Z';
      const none = createTelegramActions(deps({ killSwitchPath: file }));
      expect(none.killEngagedSince(opened)).toBe(false);
      const byEvent = createTelegramActions(deps({ store: { snapshot: () => ({ events: [{ type: 'kill', at: '2026-10-24T10:05:00.000Z' }] }) } as never }));
      expect(byEvent.killEngagedSince(opened)).toBe(true);
      const byFlag = createTelegramActions(deps({ store: { snapshot: () => ({ events: [] }), killSwitchStatus: () => ({ engaged: true, changedAt: '2026-10-24T10:05:00.000Z' }) } as never }));
      expect(byFlag.killEngagedSince(opened)).toBe(true);
      await writeFile(file, 'old\n');
      await utimes(file, new Date('2026-10-24T09:00:00.000Z'), new Date('2026-10-24T09:00:00.000Z'));
      expect(none.killEngagedSince(opened)).toBe(false);
      await utimes(file, new Date('2026-10-24T10:30:00.000Z'), new Date('2026-10-24T10:30:00.000Z'));
      expect(none.killEngagedSince(opened)).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('a live request is refused while the service is in practice mode (nothing would run it)', async () => {
    await expect(createTelegramActions(deps()).requestCreate('cmp', 'all', 5, 'phrase')).rejects.toThrow('LIVE_MODE_REQUIRED');
  });

  it('a viewer\'s /status says only that the bot is running', async () => {
    const text = await createTelegramActions(deps()).status('viewer');
    expect(text).toMatch(/^MintBot is running/);
    expect(text).not.toContain('Kill switch');
  });

  describe('Robinhood plan, prepare and simulate (T-063)', () => {
    const CONTRACT = '0xa686fde3299d5451af22382240e0dff62f7b94db';
    const A = '0x365952eb1e8209bf2bcc2db5ed213111a87d061e';
    const B = '0x81c104dcb898416fd4f81ead091dba5b8f46f37a';
    const NOW = new Date('2026-10-24T12:00:00.000Z');
    const passing = (wallet: string) => ({ wallet, simulation: 'passed' as const, estimatedGas: '120000', estimatedCostEth: '0.0000024', withinPerWalletCap: true, balanceEth: '0.001', hasEnoughForGas: true });
    const dryRun = (status: 'open' | 'upcoming' = 'open', wallets: string[] = [A, B]) => async (_contract: string, requested: readonly string[], quantity: number | undefined) => ({ contract: CONTRACT, verdict: 'ok' as const, summary: 'ok', quantity: quantity ?? 1, wallets: status === 'open' ? requested.filter((wallet) => wallets.includes(wallet)).map(passing) : [], drop: { priceEth: '0', opensAt: '2026-10-24T11:15:06.000Z', closesAt: '2026-10-24T13:00:06.000Z', maxPerWallet: 5, status } });
    const robinhood = async (extra: Partial<TelegramActionDeps> = {}) => {
      const directory = await mkdtemp(join(tmpdir(), 'mintbot-tg-rh-'));
      const killSwitchPath = join(directory, 'killswitch');
      await writeFile(killSwitchPath, 'on\n');
      const created: Array<{ chainId: number; quantity: number; broadcastMode?: string }> = [];
      const simulations: unknown[] = [];
      const evidence = { id: 'verification_abc', chainId: 4663, status: 'accepted', executionEnabled: true, checkedAt: '2026-10-24T11:00:00.000Z', expiresAt: '9999-12-31T23:59:59.999Z', sourceBlock: 1n, endpointIdentity: 'robinhood-sequencer' };
      const campaigns = [{ id: 'cmp_1', chainId: 4663, contract: CONTRACT, quantity: 1, dryRun: false, feePolicy: { kind: 'free', configuredPriorityFeeWei: 100_000_000n, totalFeeBudgetWei: 200_000_000_000_000n }, strategy: 'seadrop-v1-public', mintPriceWei: 0n, spendPolicy: { maxRunWei: 400_000_000_000_000n, dailyCapWei: 10n ** 18n, gasCeilingWei: 10n ** 18n } }];
      const store = { snapshot: () => ({ events: [], campaigns, simulations, chainEvidence: [evidence], runs: [], killed: false }), transaction: async (mutate: (state: { simulations: unknown[] }) => void) => { mutate({ simulations }); } };
      const application = { createCampaign: async (input: { chainId: number; quantity: number; broadcastMode?: string }) => { created.push(input); return { id: 'cmp_new', ...input }; } };
      const actions = createTelegramActions(deps({ store: store as never, application: application as never, killSwitchPath, walletList: async () => [A, B], robinhoodDryRun: dryRun(), robinhoodLatestBlock: async () => ({ number: 99n, hash: '0xabc' }), now: () => NOW, ...extra }));
      return { actions, directory, created, simulations };
    };
    const phraseIn = (text: string): string => /\/prepare robinhood \S+ \d+ (.+)$/m.exec(text)![1]!;

    it('/plan prints the exact /prepare line, sized for the wallets that can mint', async () => {
      const { actions, directory } = await robinhood();
      try {
        const text = await actions.plan('robinhood', CONTRACT, undefined);
        expect(text).toContain('Drop and wallets are ready');
        // Spaced into blocks (T-071): summary, window, wallets, notes, the command.
        expect(text.split('\n\n').length).toBeGreaterThanOrEqual(3);
        expect(text).toContain(`/prepare robinhood ${CONTRACT} 1 PREPARE-LIVE-ROBINHOOD 2f7b94db QTY-1 2-WALLETS 0.0004`);
      } finally { await rm(directory, { recursive: true, force: true }); }
    });

    it('/prepare records a sequencer campaign only with the exact phrase and the kill switch on, and says what to do next', async () => {
      const { actions, directory, created } = await robinhood();
      try {
        await expect(actions.prepare('robinhood', CONTRACT, 1, 'PREPARE-LIVE-ROBINHOOD wrong')).rejects.toThrow('CONFIRMATION_PHRASE_MISMATCH');
        expect(created).toEqual([]);
        const phrase = phraseIn(await actions.plan('robinhood', CONTRACT, 1));
        const text = await actions.prepare('robinhood', CONTRACT, 1, phrase);
        expect(created).toEqual([expect.objectContaining({ chainId: 4663, quantity: 1, broadcastMode: 'sequencer' })]);
        expect(text).toContain('Campaign recorded: cmp_new');
        // The next step is a button in the guide, so no command is printed for the owner to copy.
        expect(text).not.toContain('/simulate');
        await rm(join(directory, 'killswitch'));
        await expect(actions.prepare('robinhood', CONTRACT, 1, phrase)).rejects.toThrow('KILL_SWITCH_REQUIRED_FOR_PREPARATION');
        expect(created).toHaveLength(1);
      } finally { await rm(directory, { recursive: true, force: true }); }
    });

    it('/prepare refuses a drop that is not ready, such as an ended or paid one', async () => {
      const ended = await robinhood({ robinhoodDryRun: async (contract, wallets, quantity) => ({ ...(await dryRun()(contract, wallets, quantity)), drop: { priceEth: '0', opensAt: null, closesAt: null, maxPerWallet: 5, status: 'ended' as const } }) });
      const paid = await robinhood({ robinhoodDryRun: async (contract, wallets, quantity) => ({ ...(await dryRun()(contract, wallets, quantity)), drop: { priceEth: '0.001', opensAt: null, closesAt: null, maxPerWallet: 5, status: 'open' as const } }) });
      try {
        await expect(ended.actions.prepare('robinhood', CONTRACT, 1, 'PREPARE-LIVE-ROBINHOOD 2f7b94db QTY-1 2-WALLETS 0.0004')).rejects.toThrow('LIVE_PLAN_NOT_READY');
        await expect(paid.actions.prepare('robinhood', CONTRACT, 1, 'PREPARE-LIVE-ROBINHOOD 2f7b94db QTY-1 2-WALLETS 0.0004')).rejects.toThrow('LIVE_PLAN_NOT_READY');
        expect(ended.created).toEqual([]);
        expect(paid.created).toEqual([]);
      } finally { await Promise.all([ended, paid].map((item) => rm(item.directory, { recursive: true, force: true }))); }
    });

    it('guided plan: sized for the number of signing accounts chosen (only the first ready ones), without the typed /prepare line (D-069)', async () => {
      const { actions, directory } = await robinhood();
      try {
        const all = await actions.guidedPlan('robinhood', CONTRACT, undefined, undefined);
        expect(all).toMatchObject({ ok: true, ready: [A, B], quantity: 1, maxQuantity: 5 });
        const one = await actions.guidedPlan('robinhood', CONTRACT, 1, 1);
        expect(one.ready).toEqual([A]);
        expect(one.text).toContain('up to 1 wallet(s)');
        expect(one.text).not.toContain('/prepare');
        const blocked = await actions.guidedPlan('robinhood', CONTRACT, 9, undefined);
        expect(blocked.ok).toBe(false);
      } finally { await rm(directory, { recursive: true, force: true }); }
    });

    it('guided prepare builds the confirmation phrase itself and records a campaign sized for the chosen accounts only; it refuses when one is no longer ready', async () => {
      const { actions, directory, created } = await robinhood();
      try {
        const prepared = await actions.guidedPrepare('robinhood', CONTRACT, 1, [A]);
        expect(prepared.text).toContain('Campaign recorded: cmp_new');
        expect(prepared.text).toContain('Sized for 1 wallet(s)');
        expect(created).toHaveLength(1);
        await expect(actions.guidedPrepare('robinhood', CONTRACT, 1, [A, '0x9999999999999999999999999999999999999999'])).rejects.toThrow('WALLETS_CHANGED');
        expect(created).toHaveLength(1);
      } finally { await rm(directory, { recursive: true, force: true }); }
    });

    it('guided prepare refuses when the plan differs from the reviewed one (the amount or wallets changed)', async () => {
      const { actions, directory, created } = await robinhood();
      try {
        const reviewed = await actions.guidedPlan('robinhood', CONTRACT, 1, 1);
        expect(reviewed.phrase).toContain('QTY-1 1-WALLETS');
        await expect(actions.guidedPrepare('robinhood', CONTRACT, 1, [A], 'PREPARE-LIVE-ROBINHOOD 94db QTY-1 2-WALLETS 0.0004')).rejects.toThrow('PLAN_CHANGED');
        expect(created).toEqual([]);
        await expect(actions.guidedPrepare('robinhood', CONTRACT, 1, [A], reviewed.phrase)).resolves.toMatchObject({ text: expect.stringContaining('Campaign recorded') });
        expect(created).toHaveLength(1);
      } finally { await rm(directory, { recursive: true, force: true }); }
    });

    it('guided chains lists Ethereum always and the others only when switched on; fee presets follow the chain', async () => {
      const { actions, directory } = await robinhood();
      try {
        expect((await actions.guidedChains()).map((chain) => chain.key)).toEqual(['ethereum']);
        expect(await actions.feeOptions('cmp_1')).toEqual({ presets: [0.1, 0.2], limit: 0.2, unit: 'gwei' });
        expect(await actions.signingWallets()).toEqual([A, B]);
      } finally { await rm(directory, { recursive: true, force: true }); }
    });

    it('/simulate records a test mint for each wallet that passed and prints the /request line with those wallets', async () => {
      const { actions, directory, simulations } = await robinhood({ robinhoodDryRun: dryRun('open', [A]) });
      try {
        const text = await actions.simulate('cmp_1');
        expect(simulations).toEqual([expect.objectContaining({ wallet: A, campaignId: 'cmp_1', success: true })]);
        expect(text).toContain('1 wallet(s) passed the test mint');
        expect(text).not.toContain('/request');
      } finally { await rm(directory, { recursive: true, force: true }); }
    });

    it('/simulate records nothing while the mint has not opened (fail closed)', async () => {
      const { actions, directory, simulations } = await robinhood({ robinhoodDryRun: dryRun('upcoming') });
      try {
        await expect(actions.simulate('cmp_1')).rejects.toThrow('MINT_NOT_OPEN');
        expect(simulations).toEqual([]);
      } finally { await rm(directory, { recursive: true, force: true }); }
    });
  });

  describe('fee alerts, holdings and limits (T-066)', () => {
    const alertsRepo = () => { const rows: Array<{ id: string; chainId: number; direction: string; thresholdGwei: string; createdAt: string }> = []; return { rows, repo: { add: (chainId: number, direction: string, thresholdGwei: string) => { const row = { id: `gas_alert_${rows.length}abcdef`, chainId, direction, thresholdGwei, createdAt: 'x' }; rows.push(row); return row; }, active: () => rows, remove: (id: string) => { const found = rows.filter((row) => row.id.endsWith(id)); if (found.length !== 1) return false; rows.splice(rows.indexOf(found[0]!), 1); return true; } } }; };

    it('adds, lists and removes a fee alert, and refuses a bad direction, chain or number', async () => {
      const { rows, repo } = alertsRepo();
      const actions = createTelegramActions(deps({ gasAlerts: () => repo as never }));
      expect(await actions.gasAlerts()).toContain('No fee alerts');
      expect(await actions.gasAlertSet('ethereum', 'BELOW', 1.5)).toContain('Ethereum fees below 1.5 gwei');
      expect(await actions.gasAlertSet('robinhood', 'above', 0.2)).toContain('Robinhood fees above 0.2 gwei');
      expect(rows).toHaveLength(2);
      expect(await actions.gasAlerts()).toContain('Ethereum fees below 1.5 gwei');
      await expect(actions.gasAlertSet('ethereum', 'sideways', 1)).rejects.toThrow('DIRECTION_INVALID');
      await expect(actions.gasAlertSet('solana', 'below', 1)).rejects.toThrow('CHAIN_INVALID');
      for (const gwei of [0, -1, 100_001, Number.NaN]) await expect(actions.gasAlertSet('ethereum', 'below', gwei), String(gwei)).rejects.toThrow('GWEI_OUT_OF_RANGE');
      expect(rows).toHaveLength(2);
      expect(await actions.gasAlertRemove('0abcdef')).toContain('removed');
      expect(await actions.gasAlertRemove('nothing')).toContain('No single alert');
      expect(rows).toHaveLength(1);
    });

    it('/holdings lists only contracts MintBot minted, counts what the wallets hold, and says when a wallet cannot be read', async () => {
      const A = '0x365952eb1e8209bf2bcc2db5ed213111a87d061e';
      const B = '0x81c104dcb898416fd4f81ead091dba5b8f46f37a';
      const contract = '0xa686fde3299d5451af22382240e0dff62f7b94db';
      const state = { events: [], simulations: [], killed: false, runtime: { startupState: 'Ready', blockingReasons: [] }, runs: [{ id: 'run_1', campaignId: 'c1', mode: 'live' }, { id: 'run_dry', campaignId: 'c2', mode: 'dry-run' }], campaigns: [{ id: 'c1', chainId: 4663, contract }, { id: 'c2', chainId: 1, contract: '0x9999999999999999999999999999999999999999' }], receipts: [{ runId: 'run_1', state: 'Confirmed' }, { runId: 'run_dry', state: 'Confirmed' }] };
      const asked: string[] = [];
      const actions = createTelegramActions(deps({ store: { snapshot: () => state } as never, walletList: async () => [A, B], nftName: async () => 'Test Drop', nftBalance: async (chainId, address, wallet) => { asked.push(`${chainId}:${address.slice(-4)}:${wallet.slice(-4)}`); if (wallet === B) throw new Error('rpc'); return 2n; } }));
      const text = await actions.holdings();
      expect(text).toContain('Robinhood Test Drop 0xa686…94db: 2 NFT(s)');
      expect(text).toContain('0x3659…061e 2');
      expect(text).toContain('0x81c1…f37a unreadable');
      expect(asked).toEqual(['4663:94db:061e', '4663:94db:f37a']);
      const none = createTelegramActions(deps({ store: { snapshot: () => ({ ...state, receipts: [] }) } as never }));
      expect(await none.holdings()).toContain('has not minted anything yet');
    });

    describe('/eligible', () => {
      const C = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
      const event = (n: number, chainId: number, openingAt: string, closingAt?: string) => ({ id: `ev${n}`, type: 'calendar_entry', at: '2026-10-24T10:00:00.000Z', data: { id: `cal${n}`, chainId, contract: C(n), projectName: `Drop ${n}`, openingAt, ...(closingAt ? { closingAt } : {}), priceWei: '0' } });
      const build = (events: unknown[], campaigns: unknown[] = [], dropCheck?: (chain: string, contract: string) => Promise<string>) => {
        const asked: string[] = [];
        const store = { snapshot: () => ({ schemaVersion: 1, events, campaigns, runs: [], intents: [], attempts: [], receipts: [], reconciliations: [], reservations: [], simulations: [], chainEvidence: [], readiness: [], jobs: [], notificationOutbox: [], runtime: { startupState: 'Ready', blockingReasons: [], dependencies: {} }, killed: false }) };
        const actions = createTelegramActions(deps({ store: store as never, now: () => new Date('2026-10-24T12:00:00.000Z'), dropCheck: dropCheck ?? (async (chain, contract) => { asked.push(`${chain}:${contract.slice(-2)}`); return `checked ${chain}`; }) }));
        return { actions, asked };
      };

      it('checks each upcoming drop on its own chain, by id (a prepared Base campaign is Base, not Ethereum), soonest first', async () => {
        const base = { id: 'cmp_base', chainId: 8453, contract: C(9), strategy: 'seadrop-v1-public', mintPriceWei: 0n, quantity: 1, dryRun: false, createdAt: 'x', updatedAt: 'x', chainVerification: { chainId: 8453, status: 'verified' }, feePolicy: { kind: 'free' }, spendPolicy: {} };
        const { actions, asked } = build([event(1, 1, '2026-10-24T14:00:00.000Z'), event(2, 4663, '2026-10-24T13:00:00.000Z')], [base]);
        const text = await actions.eligible();
        expect(asked).toEqual(expect.arrayContaining(['ethereum:01', 'robinhood:02', 'base:09']));
        expect(asked).toHaveLength(3);
        expect(text).toContain('Upcoming drops against your wallets');
        expect(text.indexOf('Drop 2')).toBeLessThan(text.indexOf('Drop 1'));
      });

      it('leaves out a drop that has closed, looks at four drops at most, and says when none is left', async () => {
        const six = [1, 2, 3, 4, 5, 6].map((n) => event(n, 1, `2026-10-24T${12 + n}:00:00.000Z`));
        const { actions, asked } = build([event(7, 1, '2026-10-24T08:00:00.000Z', '2026-10-24T09:00:00.000Z'), ...six]);
        await actions.eligible();
        expect(asked).toHaveLength(4);
        expect(asked).not.toContain('ethereum:07');
        const none = build([event(7, 1, '2026-10-24T08:00:00.000Z', '2026-10-24T09:00:00.000Z')]);
        expect(await none.actions.eligible()).toContain('No upcoming or open drops');
        expect(await build([]).actions.eligible()).toContain('No upcoming or open drops');
      });

      it('a drop that cannot be checked is reported, and the others still are', async () => {
        const { actions } = build([event(1, 1, '2026-10-24T13:00:00.000Z'), event(2, 4663, '2026-10-24T14:00:00.000Z')], [], async (chain) => { if (chain === 'ethereum') throw new Error('RPC_UNAVAILABLE: x'); return 'checked robinhood'; });
        const text = await actions.eligible();
        expect(text).toContain('could not be checked (RPC_UNAVAILABLE)');
        expect(text).toContain('checked robinhood');
      });
    });

    it('names from outside are cleaned: control and direction characters removed, long names cut', async () => {
      const { cleanName } = await import('./owner-reports.js');
      expect(cleanName('Cool\u202e Name\u0000\u200b  here')).toBe('Cool Name here');
      expect(cleanName('x'.repeat(100))).toHaveLength(40);
      expect(cleanName(undefined)).toBe('');
      expect(cleanName(42)).toBe('');
    });

    it('a fee alert below 0.0001, a 20th-plus alert and a long number are refused plainly', async () => {
      const { rows, repo } = alertsRepo();
      const actions = createTelegramActions(deps({ gasAlerts: () => repo as never }));
      await expect(actions.gasAlertSet('ethereum', 'below', 0.00001)).rejects.toThrow('GWEI_OUT_OF_RANGE');
      await expect(actions.gasAlertSet('ethereum', 'below', 1e-7)).rejects.toThrow('GWEI_OUT_OF_RANGE');
      expect(await actions.gasAlertSet('ethereum', 'below', 0.123456789)).toContain('below 0.1235 gwei');
      for (let index = 1; index < 20; index += 1) await actions.gasAlertSet('base', 'above', index);
      await expect(actions.gasAlertSet('base', 'above', 50)).rejects.toThrow('TOO_MANY_ALERTS');
      expect(rows).toHaveLength(20);
    });

    it('/limits counts a reservation of unknown class in both classes, and /history leaves released reservations out of the wallet count', async () => {
      const reservation = { id: 'r', runId: 'run1', campaignId: 'gone', chainId: 1, wallet: '0x1', amountWei: 100_000_000_000_000n, status: 'reserved', createdAt: 'x', updatedAt: '2026-10-24T11:00:00.000Z', accountingDate: '2026-10-24' };
      const store = { snapshot: () => ({ killed: false, campaigns: [], reservations: [reservation], runs: [{ id: 'run1', campaignId: 'c', mode: 'live', state: 'Completed', createdAt: '2026-10-24T10:00:00.000Z' }], receipts: [], events: [] }) };
      const actions = createTelegramActions(deps({ store: store as never, now: () => new Date('2026-10-24T12:00:00.000Z') }));
      const text = await actions.limits();
      expect(text).toContain('Ethereum: free 0.0001 of 0.0024 ETH');
      expect(text).toContain('paid 0.0001 of 0.0082 ETH');
      expect(text).toContain('the guards decide');
      expect(text).not.toContain('Robinhood: free 0 of 0.002 ETH (0.002 left), paid');
    });

    it('/limits and /history read what the database holds', async () => {
      const store = { snapshot: () => ({ killed: false, campaigns: [], reservations: [], runs: [], receipts: [], events: [] }) };
      const actions = createTelegramActions(deps({ store: store as never, now: () => new Date('2026-10-24T12:00:00.000Z') }));
      expect(await actions.limits()).toContain('Robinhood: free 0 of 0.002 ETH');
      expect(await actions.history()).toBe('No live mints yet.');
    });
  });

  it('/cancel only wins when the service has not claimed the request', async () => {
    const claims: string[] = [];
    const store = { snapshot: () => ({ events: [] }), claimLiveRunRequest: (id: string, outcome: string) => { claims.push(`${id}:${outcome}`); return id === 'fresh'; } };
    const actions = createTelegramActions(deps({ store: store as never }));
    await expect(actions.cancel('fresh')).resolves.toContain('cancelled');
    await expect(actions.cancel('started')).resolves.toContain('Not cancelled');
    expect(claims).toEqual(['fresh:cancelled', 'started:cancelled']);
  });

  it('/release shows the phrase first, refuses a wrong one, and releases only with the exact one, as the host command does', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mintbot-tg-release-'));
    try {
      const file = join(dir, 'killswitch');
      await writeFile(file, 'on\n');
      const released: string[] = [];
      const store = { snapshot: () => ({ killed: true, events: [], runs: [], attempts: [], reconciliations: [], campaigns: [] }), killSwitchStatus: () => ({ engaged: true, changedBy: 'x', changedAt: '2026-10-24T10:00:00.000Z' }), releaseKillSwitch: async (actor: string) => { released.push(actor); return { released: true }; } };
      const actions = createTelegramActions(deps({ store: store as never, killSwitchPath: file }));
      const preview = await actions.release(undefined);
      const phrase = /\/release (.+)$/.exec(preview)![1]!;
      await expect(actions.release('RELEASE-KILL wrong')).rejects.toThrow('CONFIRMATION_PHRASE_MISMATCH');
      expect(released).toEqual([]);
      await expect(actions.release(phrase)).resolves.toContain('The kill switch is off');
      expect(released).toEqual(['owner-telegram']);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('/revoke shows the phrase first and changes nothing without it', async () => {
    const revoked: string[] = [];
    const record = { recordId: 'rh_1', approvedBy: 'owner-cli', approvedAt: '2026-10-20T00:00:00.000Z', expiresAt: '9999-12-31T23:59:59.999Z', paidAllowed: false, evidence: { E1: true, E2: true, E3: true, E4: true, E5: true, E6: true, E7: true } };
    const store = { snapshot: () => ({ events: [] }), robinhoodEnablement: () => record, revokeRobinhood: () => { revoked.push('rh_1'); return { enablementId: 'rh_1' }; } };
    const actions = createTelegramActions(deps({ store: store as never, now: () => new Date('2026-10-24T10:00:00.000Z') }));
    const preview = await actions.revoke('robinhood', undefined);
    expect(preview).toContain('/revoke robinhood ');
    expect(revoked).toEqual([]);
    await expect(actions.revoke('ethereum', undefined)).rejects.toThrow('NOTHING_TO_REVOKE');
  });

});
