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

  it('Robinhood planning and preparing are refused plainly until they exist', async () => {
    const actions = createTelegramActions(deps());
    await expect(actions.plan('robinhood', '0x1111111111111111111111111111111111111111', undefined)).rejects.toThrow('ROBINHOOD_NOT_SUPPORTED_YET');
    await expect(actions.prepare('robinhood', '0x1111111111111111111111111111111111111111', 1, 'x')).rejects.toThrow('ROBINHOOD_NOT_SUPPORTED_YET');
  });
});
