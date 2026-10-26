import { describe, expect, it } from 'vitest';
import { openDatabase, TelegramAccessRepository } from '@mint-bot/database';
import { COMMANDS, TelegramCommandRouter, menuFor, type TelegramActions } from './telegram-commands.js';
import type { InlineButton, TelegramBotApi, TelegramUpdate } from './telegram-api.js';
import { timeStepAt, totpCode } from './totp.js';

/** T-061 (D-063): who may use which command, the unlocked session, codes, taps, invites and the record of every command. */
const OWNER = 1001;
const VIEWER = 2002;
const STRANGER = 3003;
const KEY = Buffer.from('0123456789abcdef0123', 'ascii');

function setup(start = '2026-10-24T10:00:00.000Z') {
  let now = new Date(start);
  const clock = () => now;
  const access = new TelegramAccessRepository(openDatabase(), clock);
  const sent: Array<{ chatId: string; text: string; buttons?: InlineButton[][] }> = [];
  const deleted: number[] = [];
  const menus: Array<{ chat: string; commands: string[] }> = [];
  const api: TelegramBotApi = {
    getUpdates: async () => [],
    sendMessage: async (chatId, text, buttons) => { sent.push({ chatId: String(chatId), text, ...(buttons ? { buttons } : {}) }); },
    answerCallback: async () => undefined,
    deleteMessage: async (_chat, messageId) => { deleted.push(messageId); },
    setMyCommands: async (commands, chatId) => { menus.push({ chat: chatId === undefined ? 'default' : String(chatId), commands: commands.map((item) => item.command) }); },
    deleteMyCommands: async (chatId) => { menus.push({ chat: String(chatId), commands: [] }); },
  };
  const calls: string[] = [];
  let killedAfter: string | undefined;
  const ok = (name: string) => async (...args: unknown[]) => { calls.push(`${name}(${args.filter((arg) => arg !== undefined).join('|')})`); return `${name} done`; };
  const actions: TelegramActions = {
    status: ok('status'), health: ok('health'), rpc: ok('rpc'), gas: ok('gas'), backup: ok('backup'), wallets: ok('wallets'), funding: ok('funding'), enablement: ok('enablement'), drops: ok('drops'), calendar: ok('calendar'),
    check: ok('check'),
    requestPreview: async (campaignId, wallets, gwei) => { calls.push(`requestPreview(${campaignId}|${wallets}|${gwei})`); return { text: 'preview', wallets: ['0x1111111111111111111111111111111111111111'], phrase: `LIVE-REQUEST ${campaignId.slice(-8)} 1-WALLETS 0.0002 ${gwei}-GWEI` }; },
    requestCreate: ok('requestCreate'), requests: ok('requests'), runs: ok('runs'), reconcile: ok('reconcile'), run: ok('run'), watchlist: ok('watchlist'), track: ok('track'), untrack: ok('untrack'),
    limits: ok('limits'), history: ok('history'), eligible: ok('eligible'), activity: ok('activity'), holdings: ok('holdings'), gasAlerts: ok('gasAlerts'), gasAlertSet: ok('gasAlertSet'), gasAlertRemove: ok('gasAlertRemove'),
    prepare: async (...args: unknown[]) => { calls.push(`prepare(${args.filter((arg) => arg !== undefined).join('|')})`); return 'Campaign recorded: cmp_11111111-1111-1111-1111-111111111111'; }, simulate: ok('simulate'), cancel: ok('cancel'), kill: ok('kill'), revoke: ok('revoke'), release: ok('release'), watchAccept: ok('watchAccept'),
    firePreview: async (campaignId, wallets, gwei) => { calls.push(`firePreview(${campaignId}|${wallets}|${gwei})`); return { text: 'fire preview', wallets: ['0x1111111111111111111111111111111111111111'] }; },
    fireNow: ok('fireNow'), portfolio: ok('portfolio'),
    guidedChains: async () => [{ key: 'ethereum', name: 'Ethereum' }, { key: 'robinhood', name: 'Robinhood' }],
    guidedPlan: async (chain, contract, quantity, count) => { calls.push(`guidedPlan(${chain}|${contract}|${quantity ?? ''}|${count ?? ''})`); const ready = ['0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222', '0x3333333333333333333333333333333333333333'].slice(0, count ?? 3); return { text: 'plan text', ok: true, ready, quantity: quantity ?? 1, maxQuantity: 3 }; },
    guidedPrepare: async (chain, contract, quantity, wallets) => { calls.push(`guidedPrepare(${chain}|${contract}|${quantity}|${wallets.length})`); return { text: 'Campaign recorded: cmp_11111111-1111-1111-1111-111111111111', campaignId: 'cmp_11111111-1111-1111-1111-111111111111' }; },
    simulateCampaign: async (campaignId) => { calls.push(`simulateCampaign(${campaignId})`); return { text: '2 wallet(s) passed the test mint.', recorded: ['0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222'], sized: 1 }; },
    requestCandidates: async () => [{ id: 'cmp_a', label: 'Robinhood 0xa686…94db · 1 NFT', note: '2 wallet(s) tested' }],
    requestWallets: async () => ({ wallets: ['0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222'], sized: 1 }),
    requestSend: async (campaignId, wallets, gwei, phrase) => { calls.push(`requestSend(${campaignId}|${wallets}|${gwei}|${phrase})`); return 'Request sent.'; },
    cancellables: async () => [{ id: 'live_request_1', label: 'Request 000001' }],
    recentRuns: async () => [{ id: 'run_1', label: 'live · Completed' }],
    revokeChoices: async () => [{ key: 'robinhood', name: 'Robinhood' }],
    revokeStatus: async () => ({ text: 'Switching Robinhood off stops new runs.', phrase: 'REVOKE robinhood rec1' }),
    revokeNow: async (chain, expected) => { calls.push(`revokeNow(${chain}|${expected})`); return 'Robinhood is off.'; },
    watchChains: async () => [{ key: 'ethereum', name: 'Ethereum' }],
    watchWallets: async () => ['0x1111111111111111111111111111111111111111'],
    watchStatus: async (_chain, address) => ({ text: `The wallet ${address} now has 3 sent transactions.`, phrase: 'ACCEPT 3' }),
    watchAcceptNow: async (chain, address, expected) => { calls.push(`watchAcceptNow(${chain}|${address}|${expected})`); return 'Accepted.'; },

    releaseStatus: async () => ({ text: 'The kill switch is ON.', canRelease: true }),
    releaseNow: async () => { calls.push('releaseNow()'); return 'The kill switch is off.'; },
    guidedCampaigns: async () => [{ id: 'cmp_a', label: 'Robinhood 0xa686…94db · 1 NFT', note: 'mint is open' }],
    signingWallets: async () => ['0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222'],
    feeOptions: async () => ({ presets: [0.1, 0.2], limit: 0.2, unit: 'gwei' }), schedules: ok('schedules'), scheduleCreate: ok('scheduleCreate'),
    schedulePreview: async (campaignId, wallets, gwei, from, until) => { calls.push(`schedulePreview(${campaignId}|${wallets}|${gwei}|${from}|${until})`); return { text: 'schedule preview', phrase: 'SCHEDULE abcd1234 1-WALLETS 0.0001 0.2-GWEI', wallets: ['0x1111111111111111111111111111111111111111'], from, until };  },
    killEngagedSince: (openedAt) => killedAfter !== undefined && killedAfter > openedAt,
  };
  const records: Array<{ role: string; userId: string; command: string; outcome: string }> = [];
  const alerts: string[] = [];
  const router = new TelegramCommandRouter({ api, access, actions, ownerUserId: String(OWNER), totpKey: KEY, record: async (event) => { records.push(event); }, alert: async (text) => { alerts.push(text); }, now: clock });
  let updateId = 1;
  let messageId = 100;
  const message = (from: number, text: string, options: { chatId?: number; type?: string; ageMs?: number } = {}): TelegramUpdate => ({ update_id: updateId++, message: { message_id: messageId++, date: Math.floor((now.getTime() - (options.ageMs ?? 0)) / 1000), chat: { id: options.chatId ?? from, type: options.type ?? 'private' }, from: { id: from }, text } });
  const tap = (from: number, data: string): TelegramUpdate => ({ update_id: updateId++, callback_query: { id: `cb${updateId}`, from: { id: from }, data, message: { message_id: messageId++, date: Math.floor(now.getTime() / 1000), chat: { id: from, type: 'private' } } } });
  const send = (update: TelegramUpdate) => router.handle(update);
  const code = (offsetSteps = 0) => totpCode(KEY, timeStepAt(now) + offsetSteps);
  const lastTo = (chat: number) => [...sent].reverse().find((item) => item.chatId === String(chat))?.text ?? '';
  return { now: clock, menus, access, sent, deleted, calls, records, alerts, router, message, tap, send, code, lastTo, advance: (ms: number) => { now = new Date(now.getTime() + ms); }, killAt: (iso: string) => { killedAfter = iso; } };
}

const admitViewer = async (t: ReturnType<typeof setup>) => {
  await t.send(t.message(OWNER, '/invite'));
  const code = /\/join ([A-Z2-7]{16})/.exec(t.lastTo(OWNER))![1]!;
  await t.send(t.message(VIEWER, `/join ${code}`));
  return code;
};

describe('who is listened to (D-063 item 1)', () => {
  it('ignores strangers entirely, except /join, and never runs anything for them', async () => {
    const t = setup();
    for (const text of ['/status', '/kill', '/menu', '/release', '/unlock 123456']) await t.send(t.message(STRANGER, text));
    expect(t.sent).toEqual([]);
    expect(t.calls).toEqual([]);
  });

  it('ignores group chats, chats that are not the sender\'s own, bots and plain text, even from the owner', async () => {
    const t = setup();
    await t.send(t.message(OWNER, '/status', { type: 'group', chatId: -5 }));
    await t.send(t.message(OWNER, '/status', { chatId: 42 }));
    await t.send({ update_id: 99, message: { message_id: 1, date: Math.floor(Date.now() / 1000), chat: { id: OWNER, type: 'private' }, from: { id: OWNER, is_bot: true }, text: '/status' } });
    await t.send(t.message(OWNER, 'status please'));
    expect(t.calls).toEqual([]);
  });

  it('refuses a message older than 5 minutes, so a backlog never runs a stale command', async () => {
    const t = setup();
    await t.send(t.message(OWNER, '/kill', { ageMs: 6 * 60_000 }));
    expect(t.lastTo(OWNER)).toContain('more than 5 minutes old');
    expect(t.records.at(-1)).toMatchObject({ command: 'kill', outcome: 'refused:TOO_OLD' });
  });

  it('records every command with a fixed outcome and never its arguments', async () => {
    const t = setup();
    await t.send(t.message(OWNER, '/track 0x1111111111111111111111111111111111111111 whale'));
    await t.send(t.message(OWNER, `/unlock ${t.code()}`));
    expect(t.records).toEqual([{ role: 'owner', userId: String(OWNER), command: 'track', outcome: 'ok' }, { role: 'owner', userId: String(OWNER), command: 'unlock', outcome: 'ok' }]);
    expect(JSON.stringify(t.records)).not.toContain('0x1111');
  });
});

describe('viewers (D-063 item 8)', () => {
  it('a viewer gets only commands that never show the owner\'s wallets, balances, requests or runs', async () => {
    const t = setup();
    await admitViewer(t);
    const allowed = Object.entries(COMMANDS).filter(([, spec]) => spec.roles.includes('viewer')).map(([name]) => name).sort();
    expect(allowed).toEqual(['calendar', 'check', 'drops', 'gas', 'help', 'menu', 'start', 'status', 'watchlist']);
    for (const name of ['wallets', 'funding', 'runs', 'run', 'requests', 'request', 'plan', 'health', 'kill', 'unlock', 'release', 'invite', 'users', 'broadcast', 'track', 'prepare', 'cancel', 'revoke', 'limits', 'history', 'eligible', 'activity', 'holdings', 'gasalerts', 'gasalert']) {
      t.calls.length = 0;
      await t.send(t.message(VIEWER, `/${name} x y z`));
      expect(t.calls, name).toEqual([]);
      expect(t.lastTo(VIEWER), name).toContain('not available to you');
    }
  });

  it('a viewer\'s /check never includes the fleet, and their /status is the short one', async () => {
    const t = setup();
    await admitViewer(t);
    await t.send(t.message(VIEWER, '/check ethereum 0x1111111111111111111111111111111111111111'));
    await t.send(t.message(VIEWER, '/status'));
    expect(t.calls).toEqual(['check(ethereum|0x1111111111111111111111111111111111111111|false)', 'status(viewer)']);
    await t.send(t.message(OWNER, '/check ethereum 0x1111111111111111111111111111111111111111'));
    expect(t.calls.at(-1)).toBe('check(ethereum|0x1111111111111111111111111111111111111111|true)');
  });

  it('an invite works once; the owner is told who joined, and /removeuser ends access at once', async () => {
    const t = setup();
    const code = await admitViewer(t);
    expect(t.lastTo(OWNER)).toContain(`${VIEWER} joined as a viewer`);
    await t.send(t.message(STRANGER, `/join ${code}`));
    expect(t.lastTo(STRANGER)).toBe('');
    await t.send(t.message(OWNER, `/removeuser ${VIEWER}`));
    expect(t.lastTo(VIEWER)).toContain('access to this MintBot has ended');
    t.calls.length = 0;
    await t.send(t.message(VIEWER, '/drops'));
    expect(t.calls).toEqual([]);
  });

  it('/join is limited to five tries an hour per person, and a bad code is answered with silence', async () => {
    const t = setup();
    await t.send(t.message(OWNER, '/invite'));
    const code = /\/join ([A-Z2-7]{16})/.exec(t.lastTo(OWNER))![1]!;
    for (let attempt = 0; attempt < 5; attempt += 1) await t.send(t.message(STRANGER, '/join AAAAAAAAAAAAAAAA'));
    await t.send(t.message(STRANGER, `/join ${code}`));
    expect(t.access.activeUser(String(STRANGER))).toBeUndefined();
    expect(t.lastTo(STRANGER)).toBe('');
  });

  it('a viewer is limited to 10 commands a minute; the owner never is', async () => {
    const t = setup();
    await admitViewer(t);
    t.calls.length = 0;
    for (let index = 0; index < 15; index += 1) await t.send(t.message(VIEWER, '/drops'));
    expect(t.calls).toHaveLength(10);
    for (let index = 0; index < 15; index += 1) await t.send(t.message(OWNER, '/drops'));
    expect(t.calls).toHaveLength(25);
    t.advance(60_000);
    await t.send(t.message(VIEWER, '/drops'));
    expect(t.calls).toHaveLength(26);
  });

  it('button taps carry only the bot\'s own buttons; anything else in a tap is ignored', async () => {
    const t = setup();
    await t.send(t.tap(OWNER, '/release RELEASE-KILL x'));
    await t.send(t.tap(OWNER, '/track 0x1111111111111111111111111111111111111111'));
    expect(t.calls).toEqual([]);
    await t.send(t.tap(OWNER, '/status'));
    expect(t.calls).toEqual(['status(owner)']);
  });

  it('/broadcast reaches every viewer', async () => {
    const t = setup();
    await admitViewer(t);
    await t.send(t.message(OWNER, '/broadcast Drop at 18:00'));
    expect(t.lastTo(VIEWER)).toBe('Message from the owner:\nDrop at 18:00');
    expect(t.lastTo(OWNER)).toBe('Sent to 1 of 1 user(s).');
  });
});

describe('more owner commands and the Telegram menu (T-066)', () => {
  it('the owner can read limits, history, eligibility, activity and holdings, and set or remove a fee alert', async () => {
    const t = setup();
    for (const name of ['limits', 'history', 'eligible', 'activity', 'holdings', 'gasalerts']) await t.send(t.message(OWNER, `/${name}`));
    await t.send(t.message(OWNER, '/gasalert ethereum below 1.5'));
    await t.send(t.message(OWNER, '/gasalert remove abc123'));
    expect(t.calls).toEqual(['limits()', 'history()', 'eligible()', 'activity()', 'holdings()', 'gasAlerts()', 'gasAlertSet(ethereum|below|1.5)', 'gasAlertRemove(abc123)']);
  });

  it('a fee alert needs all its parts, and a number above zero', async () => {
    const t = setup();
    await t.send(t.message(OWNER, '/gasalert'));
    expect(t.lastTo(OWNER)).toContain('MISSING_CHAIN');
    await t.send(t.message(OWNER, '/gasalert ethereum below'));
    expect(t.lastTo(OWNER)).toContain('MISSING_GWEI');
    await t.send(t.message(OWNER, '/gasalert ethereum below -2'));
    expect(t.lastTo(OWNER)).toContain('INVALID_GWEI');
    await t.send(t.message(OWNER, '/gasalert remove'));
    expect(t.lastTo(OWNER)).toContain('MISSING_ALERT_ID');
    expect(t.calls).toEqual([]);
  });

  it('the menu Telegram shows has only valid names, and a viewer\'s has none of the owner\'s commands', () => {
    for (const role of ['owner', 'viewer'] as const) for (const item of menuFor(role)) { expect(item.command, item.command).toMatch(/^[a-z0-9_]{1,32}$/); expect(item.description.length).toBeGreaterThan(0); expect(item.description.length).toBeLessThanOrEqual(256); }
    const owner = menuFor('owner').map((item) => item.command);
    const viewer = menuFor('viewer').map((item) => item.command);
    for (const name of ['limits', 'history', 'eligible', 'activity', 'holdings', 'gasalerts', 'gasalert', 'plan', 'kill', 'unlock', 'invite']) expect(owner).toContain(name);
    for (const name of ['limits', 'history', 'holdings', 'gasalert', 'plan', 'kill', 'unlock', 'invite', 'wallets', 'runs']) expect(viewer).not.toContain(name);
    expect(owner.length).toBeLessThanOrEqual(100);
    expect(viewer).toEqual(expect.arrayContaining(['drops', 'calendar', 'check']));
  });

  it('at start everyone sees only /join, the owner sees the owner list, each viewer the viewer list; joining and removal update the menu', async () => {
    const t = setup();
    await admitViewer(t);
    t.menus.length = 0;
    await t.router.registerMenus();
    expect(t.menus[0]).toEqual({ chat: 'default', commands: ['join'] });
    expect(t.menus[1]).toEqual({ chat: String(OWNER), commands: menuFor('owner').map((item) => item.command) });
    expect(t.menus[2]).toEqual({ chat: String(VIEWER), commands: menuFor('viewer').map((item) => item.command) });
    t.menus.length = 0;
    await t.send(t.message(OWNER, `/removeuser ${VIEWER}`));
    expect(t.menus).toEqual([{ chat: String(VIEWER), commands: [] }]);
  });

  it('a new viewer gets the viewer menu when they join', async () => {
    const t = setup();
    await admitViewer(t);
    expect(t.menus).toContainEqual({ chat: String(VIEWER), commands: menuFor('viewer').map((item) => item.command) });
  });

  it('a menu that fails for one chat does not stop the others from being set', async () => {
    const t = setup();
    await admitViewer(t);
    const set: string[] = [];
    const router = new TelegramCommandRouter({ api: { getUpdates: async () => [], sendMessage: async () => undefined, answerCallback: async () => undefined, deleteMessage: async () => undefined, setMyCommands: async (_commands, chatId) => { if (chatId === undefined) throw new Error('TELEGRAM_SETMYCOMMANDS_FAILED:429'); set.push(String(chatId)); } }, access: t.access, actions: {} as never, ownerUserId: String(OWNER), totpKey: KEY, record: async () => undefined, alert: async () => undefined, now: t.now });
    await router.registerMenus();
    expect(set).toEqual([String(OWNER), String(VIEWER)]);
  });

  it('a menu that cannot be set never stops the bot', async () => {
    const t = setup();
    const failing = new TelegramCommandRouter({ api: { getUpdates: async () => [], sendMessage: async () => undefined, answerCallback: async () => undefined, deleteMessage: async () => undefined, setMyCommands: async () => { throw new Error('TELEGRAM_SETMYCOMMANDS_FAILED:429'); } }, access: t.access, actions: {} as never, ownerUserId: String(OWNER), totpKey: KEY, record: async () => undefined, alert: async () => undefined, now: t.now });
    await expect(failing.registerMenus()).resolves.toBeUndefined();
  });
});

describe('the unlocked session (D-063 items 5 and 6)', () => {
  it('start commands are refused without a session; read, change and stop commands never need one', async () => {
    const t = setup();
    for (const text of ['/release', '/fire', '/schedule', '/watchaccept base 0x1111111111111111111111111111111111111111']) {
      await t.send(t.message(OWNER, text));
      expect(t.lastTo(OWNER), text).toContain('needs an unlocked session');
    }
    expect(t.calls).toEqual([]);
    await t.send(t.message(OWNER, '/status'));
    await t.send(t.message(OWNER, '/cancel request-1'));
    await t.send(t.message(OWNER, '/revoke base PHRASE'));
    expect(t.calls).toEqual(['status(owner)', 'cancel(request-1)', 'revoke(base|PHRASE)']);
    // The guided revoke needs no session either (turning something off is never held back).
    await t.send(t.message(OWNER, '/revoke'));
    expect(t.sent.at(-1)!.buttons!.flat().map((item) => item.text)).toEqual(['Robinhood', 'Cancel']);
  });

  it('/unlock with a good code opens 12 hours; the code\'s message is deleted; start commands then work with their phrase', async () => {
    const t = setup();
    const unlock = t.message(OWNER, `/unlock ${t.code()}`);
    await t.send(unlock);
    expect(t.deleted).toEqual([unlock.message!.message_id]);
    expect(t.lastTo(OWNER)).toContain('Unlocked until 2026-10-24 22:00 UTC');
    await t.send(t.message(OWNER, '/release RELEASE-KILL 2026-10-24'));
    expect(t.calls).toEqual(['release(RELEASE-KILL 2026-10-24)']);
  });

  it('a code works once, wrong codes are counted, and the fifth wrong code in an hour blocks unlocking and alerts (fail closed)', async () => {
    const t = setup();
    const good = t.code();
    await t.send(t.message(OWNER, `/unlock ${good}`));
    await t.send(t.message(OWNER, '/lock'));
    await t.send(t.message(OWNER, `/unlock ${good}`));
    expect(t.lastTo(OWNER)).toContain('did not work');
    for (let attempt = 0; attempt < 4; attempt += 1) await t.send(t.message(OWNER, '/unlock 000000'));
    expect(t.alerts).toHaveLength(1);
    t.advance(30_000);
    await t.send(t.message(OWNER, `/unlock ${t.code()}`));
    expect(t.lastTo(OWNER)).toContain('Unlocking is blocked until');
    expect(t.access.openSession()).toBeUndefined();
    t.advance(60 * 60_000);
    await t.send(t.message(OWNER, `/unlock ${t.code()}`));
    expect(t.access.openSession()).toBeDefined();
  });

  it('a session from before a restart never carries over, even when closing it at start failed (fail closed)', async () => {
    const t = setup();
    await t.send(t.message(OWNER, `/unlock ${t.code()}`));
    t.advance(60_000);
    // A new process: its router starts after the session opened, and nothing closed the session at start.
    const restarted = new TelegramCommandRouter({
      api: { getUpdates: async () => [], sendMessage: async (chat, text) => { t.sent.push({ chatId: String(chat), text }); }, answerCallback: async () => undefined, deleteMessage: async () => undefined },
      access: t.access,
      actions: { release: async () => 'released', killEngagedSince: () => false } as unknown as TelegramActions,
      ownerUserId: String(OWNER), totpKey: KEY, record: async () => undefined, alert: async () => undefined, now: () => new Date('2026-10-24T10:01:00.000Z'),
    });
    await restarted.handle(t.message(OWNER, '/release'));
    expect(t.lastTo(OWNER)).toContain('needs an unlocked session');
    expect(t.access.openSession()).toBeUndefined();
  });

  it('a code sent with a space ("123 456") still counts as the code', async () => {
    const t = setup();
    const code = t.code();
    await t.send(t.message(OWNER, `/unlock ${code.slice(0, 3)} ${code.slice(3)}`));
    expect(t.access.openSession()).toBeDefined();
  });

  it('a session whose kill state cannot be checked counts as ended (fail closed)', async () => {
    const t = setup();
    await t.send(t.message(OWNER, `/unlock ${t.code()}`));
    const failing = new TelegramCommandRouter({
      api: { getUpdates: async () => [], sendMessage: async (_chat, text) => { t.sent.push({ chatId: String(OWNER), text }); }, answerCallback: async () => undefined, deleteMessage: async () => undefined },
      access: t.access,
      actions: { release: async () => 'released', killEngagedSince: () => { throw new Error('DB_LOCKED'); } } as unknown as TelegramActions,
      ownerUserId: String(OWNER), totpKey: KEY, record: async () => undefined, alert: async () => undefined, now: t.now,
    });
    await failing.handle(t.message(OWNER, '/release'));
    expect(t.access.openSession()).toBeUndefined();
    expect(t.lastTo(OWNER)).toContain('needs an unlocked session');
  });

  it('the session ends after 12 hours, and the owner is told', async () => {
    const t = setup();
    await t.send(t.message(OWNER, `/unlock ${t.code()}`));
    t.advance(12 * 60 * 60_000);
    await t.router.checkSession();
    expect(t.lastTo(OWNER)).toContain('12-hour unlocked session has ended');
    await t.send(t.message(OWNER, '/release'));
    expect(t.lastTo(OWNER)).toContain('needs an unlocked session');
  });

  it('a kill engaged after the session opened ends it, however the kill came', async () => {
    const t = setup();
    await t.send(t.message(OWNER, `/unlock ${t.code()}`));
    t.advance(60_000);
    t.killAt('2026-10-24T10:01:00.000Z');
    await t.send(t.message(OWNER, '/release'));
    expect(t.sent.some((item) => item.text.includes('your unlocked session has ended'))).toBe(true);
    expect(t.lastTo(OWNER)).toContain('needs an unlocked session');
    expect(t.calls).toEqual([]);
  });

  it('/lock and a service restart end the session', async () => {
    const t = setup();
    await t.send(t.message(OWNER, `/unlock ${t.code()}`));
    await t.send(t.message(OWNER, '/lock'));
    expect(t.access.openSession()).toBeUndefined();
    t.advance(30_000);
    await t.send(t.message(OWNER, `/unlock ${t.code()}`));
    await t.router.onStart();
    expect(t.access.openSession()).toBeUndefined();
    expect(t.lastTo(OWNER)).toContain('service restarted');
  });
});

describe('stop and request commands', () => {
  it('/kill asks for one tap; only that tap, by the owner, within 2 minutes, engages it and ends the session', async () => {
    const t = setup();
    await t.send(t.message(OWNER, `/unlock ${t.code()}`));
    await t.send(t.message(OWNER, '/kill'));
    expect(t.calls).toEqual([]);
    const button = t.sent.at(-1)!.buttons![0]![0]!;
    await t.send(t.tap(VIEWER, button.callback_data));
    expect(t.calls).toEqual([]);
    await t.send(t.tap(OWNER, '/tap_kill_000000000000000000'));
    expect(t.calls).toEqual([]);
    expect(t.lastTo(OWNER)).toContain('expired');
    await t.send(t.tap(OWNER, button.callback_data));
    expect(t.calls).toEqual(['kill()']);
    expect(t.access.openSession()).toBeUndefined();
    await t.send(t.tap(OWNER, button.callback_data));
    expect(t.calls).toEqual(['kill()']);
  });

  it('a kill that could not be engaged still ends the session', async () => {
    const t = setup();
    await t.send(t.message(OWNER, `/unlock ${t.code()}`));
    const router = new TelegramCommandRouter({
      api: { getUpdates: async () => [], sendMessage: async (chat, text, buttons) => { t.sent.push({ chatId: String(chat), text, ...(buttons ? { buttons } : {}) }); }, answerCallback: async () => undefined, deleteMessage: async () => undefined },
      access: t.access,
      actions: { kill: async () => { throw new Error('KILL_SWITCH_NOT_ENGAGED'); }, killEngagedSince: () => false } as unknown as TelegramActions,
      ownerUserId: String(OWNER), totpKey: KEY, record: async () => undefined, alert: async () => undefined, now: t.now,
    });
    await router.handle(t.message(OWNER, '/kill'));
    await router.handle(t.tap(OWNER, t.sent.at(-1)!.buttons![0]![0]!.callback_data));
    expect(t.lastTo(OWNER)).toContain('KILL_SWITCH_NOT_ENGAGED');
    expect(t.access.openSession()).toBeUndefined();
  });

  it('a kill tap that is more than 2 minutes old does nothing (fail closed)', async () => {
    const t = setup();
    await t.send(t.message(OWNER, '/kill'));
    const button = t.sent.at(-1)!.buttons![0]![0]!;
    t.advance(2 * 60_000 + 1);
    await t.send(t.tap(OWNER, button.callback_data));
    expect(t.calls).toEqual([]);
  });

  it('/request in full shows the summary with a Send Request button, and the tap sends it once with the reviewed phrase (nothing to copy)', async () => {
    const t = setup();
    await t.send(t.message(OWNER, `/unlock ${t.code()}`));
    await t.send(t.message(OWNER, '/request cmp_00000000abcdef12 all 0.2'));
    expect(t.lastTo(OWNER)).not.toContain('/confirm');
    const button = t.sent.at(-1)!.buttons!.flat().find((item) => item.text === 'Send Request')!;
    expect(t.calls.some((call) => call.startsWith('requestSend'))).toBe(false);
    await t.send(t.tap(OWNER, button.callback_data));
    expect(t.calls.at(-1)).toMatch(/^requestSend\(cmp_00000000abcdef12\|0x1111111111111111111111111111111111111111\|0.2\|LIVE-REQUEST abcdef12/);
    await t.send(t.tap(OWNER, button.callback_data));
    expect(t.lastTo(OWNER)).toContain('expired');
    expect(t.calls.filter((call) => call.startsWith('requestSend'))).toHaveLength(1);
  });

  it('a refused action is answered with its plain reason, cleaned of links and long hex', async () => {
    const t = setup();
    const router = new TelegramCommandRouter({
      api: { getUpdates: async () => [], sendMessage: async (_chat, text) => { t.sent.push({ chatId: String(OWNER), text }); }, answerCallback: async () => undefined, deleteMessage: async () => undefined },
      access: t.access,
      actions: { status: async () => { throw new Error(`RPC_FAILED: https://rpc.example/key ${'a'.repeat(64)}`); } } as unknown as TelegramActions,
      ownerUserId: String(OWNER), totpKey: KEY, record: async () => undefined, alert: async () => undefined, now: t.now,
    });
    await router.handle(t.message(OWNER, '/status'));
    expect(t.sent.at(-1)!.text).toMatch(/^Not done: RPC_FAILED/);
    expect(t.sent.at(-1)!.text).not.toContain('rpc.example');
    expect(t.sent.at(-1)!.text).not.toContain('a'.repeat(64));
  });
});

describe('/fire and /schedule (D-067)', () => {
  const unlocked = async (t: ReturnType<typeof setup>) => { await t.send(t.message(OWNER, `/unlock ${t.code()}`)); };

  it('/fire needs an unlocked session, shows a preview with one button, and mints only on the owner\'s tap', async () => {
    const t = setup();
    await t.send(t.message(OWNER, '/fire camp1 all 0.2'));
    expect(t.lastTo(OWNER)).toMatch(/unlocked session/);
    expect(t.calls).toEqual([]);
    await unlocked(t);
    await t.send(t.message(OWNER, '/fire camp1 all 0.2'));
    expect(t.calls).toContain('firePreview(camp1|all|0.2)');
    const button = t.sent.at(-1)!.buttons![0]![0]!;
    expect(button.callback_data).toMatch(/^\/tap_fire_[0-9a-f]{18}$/);
    expect(t.calls.some((call) => call.startsWith('fireNow'))).toBe(false);
    await t.send(t.tap(OWNER, button.callback_data));
    expect(t.calls).toContain('fireNow(camp1|0x1111111111111111111111111111111111111111|0.2)');
    // A second tap on the same button does nothing more.
    await t.send(t.tap(OWNER, button.callback_data));
    expect(t.calls.filter((call) => call.startsWith('fireNow'))).toHaveLength(1);
    expect(t.lastTo(OWNER)).toMatch(/expired/);
  });

  it('a fire button expires after 2 minutes, and a locked session or a viewer cannot use it', async () => {
    const t = setup();
    await unlocked(t);
    await t.send(t.message(OWNER, '/fire camp1 all 0.2'));
    const data = t.sent.at(-1)!.buttons![0]![0]!.callback_data;
    t.advance(3 * 60_000);
    await t.send(t.tap(OWNER, data));
    expect(t.calls.some((call) => call.startsWith('fireNow'))).toBe(false);
    await t.send(t.message(OWNER, '/fire camp1 all 0.2'));
    const fresh = t.sent.at(-1)!.buttons![0]![0]!.callback_data;
    await t.send(t.message(OWNER, '/lock'));
    await t.send(t.tap(OWNER, fresh));
    expect(t.lastTo(OWNER)).toMatch(/unlocked session/);
    expect(t.calls.some((call) => call.startsWith('fireNow'))).toBe(false);
    await admitViewer(t);
    await t.send(t.message(VIEWER, '/fire camp1 all 0.2'));
    await t.send(t.tap(VIEWER, fresh));
    expect(t.calls.some((call) => call.startsWith('fireNow'))).toBe(false);
  });

  it('/schedule in full shows the summary with a Store Schedule button; nothing is stored until the tap (nothing to copy)', async () => {
    const t = setup();
    await unlocked(t);
    await t.send(t.message(OWNER, '/schedule camp1 all 0.2 2026-10-25T18:00 2026-10-25T20:00'));
    expect(t.lastTo(OWNER)).not.toContain('/confirm');
    expect(t.calls.some((call) => call.startsWith('scheduleCreate'))).toBe(false);
    const button = t.sent.at(-1)!.buttons!.flat().find((item) => item.text === 'Store Schedule')!;
    await t.send(t.tap(OWNER, button.callback_data));
    expect(t.calls).toContain('scheduleCreate(camp1|0x1111111111111111111111111111111111111111|0.2|2026-10-25T18:00|2026-10-25T20:00|SCHEDULE abcd1234 1-WALLETS 0.0001 0.2-GWEI)');
    await t.send(t.tap(OWNER, button.callback_data));
    expect(t.calls.filter((call) => call.startsWith('scheduleCreate'))).toHaveLength(1);
    expect(t.lastTo(OWNER)).toContain('expired');
  });

  it('viewers cannot see or use /fire, /schedule or /schedules, and the owner menu lists them', async () => {
    const t = setup();
    await admitViewer(t);
    for (const text of ['/fire c all 0.2', '/schedule c all 0.2 now +1h', '/schedules']) {
      await t.send(t.message(VIEWER, text));
      expect(t.lastTo(VIEWER)).toMatch(/not available/);
    }
    expect(menuFor('viewer').map((item) => item.command)).not.toEqual(expect.arrayContaining(['fire']));
    expect(menuFor('owner').map((item) => item.command)).toEqual(expect.arrayContaining(['fire', 'schedule', 'schedules']));
  });
});

describe('guided flows through the router (D-069)', () => {
  const CONTRACT = '0xa686fde3299d5451af22382240e0dff62f7b94db';
  const unlock = async (t: ReturnType<typeof setup>, step = 0) => { await t.send(t.message(OWNER, `/unlock ${t.code(step)}`)); };
  const buttonsOf = (t: ReturnType<typeof setup>) => t.sent.at(-1)!.buttons!.flat();
  const tapLabel = async (t: ReturnType<typeof setup>, label: string) => {
    const button = buttonsOf(t).find((item) => item.text === label);
    if (!button) throw new Error(`no "${label}" in ${buttonsOf(t).map((item) => item.text).join(' | ')}`);
    await t.send(t.tap(OWNER, button.callback_data));
  };

  it('/prepare with no arguments guides the owner: chain, contract typed as a message, quantity, wallets, then one tap (no unlock needed)', async () => {
    const t = setup();
    await t.send(t.message(OWNER, '/prepare'));
    expect(buttonsOf(t).map((item) => item.text)).toEqual(['Ethereum', 'Robinhood', 'Cancel']);
    await tapLabel(t, 'Robinhood');
    expect(t.lastTo(OWNER)).toContain('Send the contract address as a message');
    await t.send(t.message(OWNER, CONTRACT));
    expect(t.lastTo(OWNER)).toContain('How many NFTs per wallet?');
    await tapLabel(t, '1');
    await tapLabel(t, 'All ready (3)');
    await tapLabel(t, 'Prepare (Spends Nothing)');
    expect(t.lastTo(OWNER)).toContain('Campaign recorded: cmp_11111111-1111-1111-1111-111111111111');
    expect(t.calls.at(-1)).toBe(`guidedPrepare(robinhood|${CONTRACT}|1|3)`);
    expect(t.records.at(-1)).toMatchObject({ command: 'prepare', outcome: 'ok' });
    // The next step is a button, not a command to copy: record the test mints, then pick the wallets for the request.
    expect(t.lastTo(OWNER)).not.toContain('/simulate');
    await tapLabel(t, 'Record Test Mints');
    expect(t.calls.at(-1)).toBe('simulateCampaign(cmp_11111111-1111-1111-1111-111111111111)');
    expect(t.lastTo(OWNER)).toContain('This campaign was sized for 1 wallet(s)');
    expect(buttonsOf(t).map((item) => item.text)).toContain('All Tested (1)');
  });

  it('typed commands with arguments still work as before', async () => {
    const t = setup();
    await t.send(t.message(OWNER, `/prepare robinhood ${CONTRACT} 1 PREPARE-LIVE-ROBINHOOD x`));
    expect(t.calls.some((call) => call.startsWith('prepare('))).toBe(true);
    // The next step comes with it as a button.
    expect(buttonsOf(t).map((item) => item.text)).toEqual(['Record Test Mints', 'Cancel']);
  });

  it('release and fire flows need the unlocked session at the tap, and act once after it', async () => {
    const t = setup();
    await t.send(t.message(OWNER, '/release'));
    expect(t.lastTo(OWNER)).toContain('unlocked session');
    await unlock(t);
    await t.send(t.message(OWNER, '/release'));
    const release = buttonsOf(t).find((item) => item.text === 'Release The Kill Switch')!;
    await t.send(t.message(OWNER, '/lock'));
    await t.send(t.tap(OWNER, release.callback_data));
    expect(t.lastTo(OWNER)).toContain('unlocked session');
    expect(t.calls).not.toContain('releaseNow()');
    expect(t.records.at(-1)).toMatchObject({ command: 'release', outcome: 'refused:SESSION_REQUIRED' });
    // A code works once, so the second unlock uses the next one.
    await unlock(t, 1);
    await t.send(t.tap(OWNER, release.callback_data));
    expect(t.calls.filter((call) => call === 'releaseNow()')).toHaveLength(1);
    expect(t.lastTo(OWNER)).toBe('The kill switch is off.');
    await t.send(t.tap(OWNER, release.callback_data));
    expect(t.lastTo(OWNER)).toContain('expired');
    expect(t.calls.filter((call) => call === 'releaseNow()')).toHaveLength(1);
  });

  it('/fire with no arguments picks the campaign, wallets and fee, then fires only on the final tap', async () => {
    const t = setup();
    await unlock(t);
    await t.send(t.message(OWNER, '/fire'));
    await tapLabel(t, 'Robinhood 0xa686…94db · 1 NFT');
    await tapLabel(t, 'All Signing Wallets (2)');
    await tapLabel(t, '0.2 gwei');
    expect(t.calls.some((call) => call.startsWith('fireNow'))).toBe(false);
    await tapLabel(t, 'Fire Now');
    expect(t.calls.some((call) => call.startsWith('fireNow'))).toBe(true);
    expect(t.records.at(-1)).toMatchObject({ command: 'fire', outcome: 'ok' });
  });

  it('plain text is only the owner\'s answer to a flow: a viewer\'s or a stranger\'s message is ignored, and "join CODE" without a slash is not a join', async () => {
    const t = setup();
    await admitViewer(t);
    await t.send(t.message(OWNER, '/prepare'));
    await tapLabel(t, 'Ethereum');
    const before = t.sent.length;
    await t.send(t.message(VIEWER, CONTRACT));
    await t.send(t.message(STRANGER, `join ${CONTRACT}`));
    await t.send(t.message(OWNER, 'hello there'));
    // The owner's text is taken as the flow's answer and refused in words; the others get nothing.
    expect(t.sent.slice(before).map((item) => item.chatId)).toEqual([String(OWNER)]);
    expect(t.lastTo(OWNER)).toContain('is not a contract address');
    expect(t.calls.some((call) => call.startsWith('guidedPlan'))).toBe(false);
  });

  it('another command ends the wait for typed text; a button from an old flow or someone else\'s tap does nothing', async () => {
    const t = setup();
    await t.send(t.message(OWNER, '/prepare'));
    await tapLabel(t, 'Ethereum');
    await t.send(t.message(OWNER, '/status'));
    const before = t.sent.length;
    await t.send(t.message(OWNER, CONTRACT));
    expect(t.sent.length).toBe(before);
    expect(t.calls.some((call) => call.startsWith('guidedPlan'))).toBe(false);
    await admitViewer(t);
    await t.send(t.tap(VIEWER, '/f_00000000_0o1'));
    await t.send(t.tap(OWNER, '/f_00000000_0o1'));
    expect(t.lastTo(OWNER)).toContain('expired');
  });

  it('/kill ends an open flow so an old button cannot act after it; a stale typed answer is not used', async () => {
    const t = setup();
    await unlock(t);
    await t.send(t.message(OWNER, '/release'));
    const release = buttonsOf(t).find((item) => item.text === 'Release The Kill Switch')!;
    await t.send(t.message(OWNER, '/kill'));
    await t.send(t.tap(OWNER, t.sent.at(-1)!.buttons![0]![0]!.callback_data));
    await unlock(t, 1);
    await t.send(t.tap(OWNER, release.callback_data));
    expect(t.lastTo(OWNER)).toContain('expired');
    expect(t.calls).not.toContain('releaseNow()');
    await t.send(t.message(OWNER, '/prepare'));
    await tapLabel(t, 'Ethereum');
    await t.send(t.message(OWNER, CONTRACT, { ageMs: 6 * 60_000 }));
    expect(t.lastTo(OWNER)).toContain('more than 5 minutes old');
    expect(t.calls.some((call) => call.startsWith('guidedPlan'))).toBe(false);
  });

  it('/plan with a chain and a contract goes straight to the quantity buttons; with nothing after it, it starts the same guide', async () => {
    const t = setup();
    await t.send(t.message(OWNER, `/plan robinhood ${CONTRACT}`));
    expect(t.calls.at(-1)).toBe(`guidedPlan(robinhood|${CONTRACT}||)`);
    expect(t.lastTo(OWNER)).toContain('How many NFTs per wallet?');
    expect(t.lastTo(OWNER)).not.toContain('/prepare');
    await t.send(t.message(OWNER, '/plan'));
    expect(buttonsOf(t).map((item) => item.text)).toEqual(['Ethereum', 'Robinhood', 'Cancel']);
  });

  it('/simulate with nothing after it picks the campaign; with a campaign it records the test mints at once; both go on to the wallet buttons', async () => {
    const t = setup();
    await t.send(t.message(OWNER, '/simulate'));
    await tapLabel(t, 'Robinhood 0xa686…94db · 1 NFT');
    expect(t.lastTo(OWNER)).toContain('Record a test mint for each wallet');
    await tapLabel(t, 'Record Test Mints');
    expect(t.calls.at(-1)).toBe('simulateCampaign(cmp_a)');
    expect(buttonsOf(t).map((item) => item.text)).toContain('All Tested (1)');
    await t.send(t.message(OWNER, '/simulate cmp_b'));
    expect(t.calls.at(-1)).toBe('simulateCampaign(cmp_b)');
    expect(t.lastTo(OWNER)).toContain('2 wallet(s) passed the test mint');
    expect(t.lastTo(OWNER)).not.toContain('/request');
    expect(t.records.at(-1)).toMatchObject({ command: 'simulate', outcome: 'ok' });
  });

  it('a typed /prepare with its phrase also goes straight on to the Record Test Mints button', async () => {
    const t = setup();
    await t.send(t.message(OWNER, `/prepare robinhood ${CONTRACT} 1 PREPARE-LIVE-ROBINHOOD x`));
    expect(t.lastTo(OWNER)).toContain('Record Test Mints');
    expect(buttonsOf(t).map((item) => item.text)).toEqual(['Record Test Mints', 'Cancel']);
  });

  it('the request guide needs the unlocked session only for its last tap', async () => {
    const t = setup();
    await t.send(t.message(OWNER, '/request'));
    await tapLabel(t, 'Robinhood 0xa686…94db · 1 NFT');
    await tapLabel(t, 'All Tested (1)');
    await tapLabel(t, '0.2 gwei');
    expect(t.lastTo(OWNER)).toContain('preview');
    const send = buttonsOf(t).find((item) => item.text === 'Send Request')!;
    await t.send(t.tap(OWNER, send.callback_data));
    expect(t.lastTo(OWNER)).toContain('unlocked session');
    expect(t.calls.some((call) => call.startsWith('requestSend'))).toBe(false);
    await unlock(t);
    await t.send(t.tap(OWNER, send.callback_data));
    expect(t.calls.filter((call) => call.startsWith('requestSend'))).toHaveLength(1);
  });

  it('/cancel and /funding with nothing after them offer buttons instead of asking for an id', async () => {
    const t = setup();
    await t.send(t.message(OWNER, '/cancel'));
    await tapLabel(t, 'Request 000001');
    expect(t.calls.at(-1)).toBe('cancel(live_request_1)');
    await t.send(t.message(OWNER, '/funding'));
    await tapLabel(t, 'Robinhood 0xa686…94db · 1 NFT');
    expect(t.lastTo(OWNER)).toBe('funding done');
    expect(t.calls.at(-1)).toBe('funding(cmp_a)');
  });

  it('/revoke guides with a button and needs no session; the tap is bound to the record that was shown', async () => {
    const t = setup();
    await t.send(t.message(OWNER, '/revoke'));
    await tapLabel(t, 'Robinhood');
    expect(t.lastTo(OWNER)).toContain('Switching Robinhood off stops new runs.');
    expect(t.lastTo(OWNER)).not.toContain('/revoke robinhood');
    await tapLabel(t, 'Switch It Off');
    expect(t.calls.at(-1)).toBe('revokeNow(robinhood|REVOKE robinhood rec1)');
    expect(t.records.at(-1)).toMatchObject({ command: 'revoke', outcome: 'ok' });
    await t.send(t.message(OWNER, '/revoke robinhood'));
    expect(buttonsOf(t).map((item) => item.text)).toEqual(['Switch It Off', 'Cancel']);
  });

  it('/watchaccept guides: chain, wallet (or a typed address), the wallet as it is now, one button; the tap needs the unlocked session', async () => {
    const t = setup();
    await t.send(t.message(OWNER, '/watchaccept'));
    expect(t.lastTo(OWNER)).toContain('unlocked session');
    await unlock(t);
    await t.send(t.message(OWNER, '/watchaccept'));
    await tapLabel(t, 'Ethereum');
    await tapLabel(t, '0x1111…1111');
    expect(t.lastTo(OWNER)).toContain('now has 3 sent transactions');
    const accept = buttonsOf(t).find((item) => item.text === 'Accept This Change')!;
    await t.send(t.message(OWNER, '/lock'));
    await t.send(t.tap(OWNER, accept.callback_data));
    expect(t.lastTo(OWNER)).toContain('unlocked session');
    expect(t.calls.some((call) => call.startsWith('watchAcceptNow'))).toBe(false);
    await unlock(t, 1);
    await t.send(t.tap(OWNER, accept.callback_data));
    expect(t.calls.at(-1)).toBe('watchAcceptNow(ethereum|0x1111111111111111111111111111111111111111|ACCEPT 3)');
    await t.send(t.message(OWNER, '/watchaccept ethereum 0x1111111111111111111111111111111111111111'));
    expect(buttonsOf(t).map((item) => item.text)).toEqual(['Accept This Change', 'Cancel']);
  });

  it('across every guided flow no message shows a phrase or a command with arguments to copy, and the campaign id stays in view (D-070)', async () => {
    const t = setup();
    await unlock(t);
    const press = async (label: string) => { await tapLabel(t, label); };
    // prepare -> record test mints -> request
    await t.send(t.message(OWNER, '/prepare'));
    await press('Robinhood'); await t.send(t.message(OWNER, CONTRACT));
    await press('1'); await press('All ready (3)'); await press('Prepare (Spends Nothing)');
    expect(t.lastTo(OWNER)).toContain('cmp_11111111-1111-1111-1111-111111111111');
    await press('Record Test Mints'); await press('All Tested (1)'); await press('0.2 gwei'); await press('Send Request');
    // release, fire, schedule, cancel, funding, run, revoke, watchaccept
    await t.send(t.message(OWNER, '/release')); await press('Release The Kill Switch');
    await t.send(t.message(OWNER, '/fire')); await press('Robinhood 0xa686…94db · 1 NFT'); await press('All Signing Wallets (2)'); await press('0.2 gwei'); await press('Fire Now');
    await t.send(t.message(OWNER, '/schedule')); await press('Robinhood 0xa686…94db · 1 NFT'); await press('All Signing Wallets (2)'); await press('0.2 gwei'); await press('Now To +2 H'); await press('Store Schedule');
    await t.send(t.message(OWNER, '/cancel')); await press('Request 000001');
    await t.send(t.message(OWNER, '/funding')); await press('Robinhood 0xa686…94db · 1 NFT');
    await t.send(t.message(OWNER, '/run')); await press('live · Completed');
    await t.send(t.message(OWNER, '/revoke')); await press('Robinhood'); await press('Switch It Off');
    await t.send(t.message(OWNER, '/watchaccept')); await press('Ethereum'); await press('0x1111…1111'); await press('Accept This Change');
    for (const sent of t.sent) {
      expect(sent.text, sent.text).not.toMatch(/(^|\n)\/(?!f_)[a-z]+ \S+/);
      expect(sent.text, sent.text).not.toMatch(/PREPARE-LIVE|RELEASE-KILL|LIVE-REQUEST |SCHEDULE [0-9a-f]{8} |ENABLE-ROBINHOOD|REVOKE /);
    }
  });

  it('the owner menu has the guided buttons', async () => {
    const t = setup();
    await t.send(t.message(OWNER, '/menu'));
    expect(t.sent.at(-1)!.buttons!.flat().map((item) => item.callback_data)).toEqual(expect.arrayContaining(['/prepare', '/release', '/fire']));
  });
});
