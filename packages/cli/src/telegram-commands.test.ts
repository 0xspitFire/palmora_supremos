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
    check: ok('check'), plan: ok('plan'),
    requestPreview: async (campaignId, wallets, gwei) => { calls.push(`requestPreview(${campaignId}|${wallets}|${gwei})`); return { text: 'preview', wallets: ['0x1111111111111111111111111111111111111111'], phrase: `LIVE-REQUEST ${campaignId.slice(-8)} 1-WALLETS 0.0002 ${gwei}-GWEI` }; },
    requestCreate: ok('requestCreate'), requests: ok('requests'), runs: ok('runs'), run: ok('run'), watchlist: ok('watchlist'), track: ok('track'), untrack: ok('untrack'),
    limits: ok('limits'), history: ok('history'), eligible: ok('eligible'), activity: ok('activity'), holdings: ok('holdings'), gasAlerts: ok('gasAlerts'), gasAlertSet: ok('gasAlertSet'), gasAlertRemove: ok('gasAlertRemove'),
    prepare: ok('prepare'), simulate: ok('simulate'), cancel: ok('cancel'), kill: ok('kill'), revoke: ok('revoke'), release: ok('release'), watchAccept: ok('watchAccept'),
    firePreview: async (campaignId, wallets, gwei) => { calls.push(`firePreview(${campaignId}|${wallets}|${gwei})`); return { text: 'fire preview', wallets: ['0x1111111111111111111111111111111111111111'] }; },
    fireNow: ok('fireNow'), portfolio: ok('portfolio'), schedules: ok('schedules'), scheduleCreate: ok('scheduleCreate'),
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
    for (const text of ['/release', '/confirm X', '/watchaccept base 0x1111111111111111111111111111111111111111']) {
      await t.send(t.message(OWNER, text));
      expect(t.lastTo(OWNER), text).toContain('needs an unlocked session');
    }
    expect(t.calls).toEqual([]);
    await t.send(t.message(OWNER, '/status'));
    await t.send(t.message(OWNER, '/cancel request-1'));
    await t.send(t.message(OWNER, '/revoke base'));
    expect(t.calls).toEqual(['status(owner)', 'cancel(request-1)', 'revoke(base)']);
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

  it('/confirm sends only a request the owner previewed, with exactly the previewed numbers, once', async () => {
    const t = setup();
    await t.send(t.message(OWNER, `/unlock ${t.code()}`));
    await t.send(t.message(OWNER, '/confirm LIVE-REQUEST abcdef12 1-WALLETS 0.0002 5-GWEI'));
    expect(t.lastTo(OWNER)).toContain('PREVIEW_NOT_FOUND');
    await t.send(t.message(OWNER, '/request cmp_00000000abcdef12 all 5'));
    expect(t.lastTo(OWNER)).toContain('/confirm LIVE-REQUEST abcdef12 1-WALLETS 0.0002 5-GWEI');
    await t.send(t.message(OWNER, '/confirm LIVE-REQUEST abcdef12 1-WALLETS 0.0002 5-GWEI'));
    expect(t.calls.at(-1)).toBe('requestCreate(cmp_00000000abcdef12|0x1111111111111111111111111111111111111111|5|LIVE-REQUEST abcdef12 1-WALLETS 0.0002 5-GWEI)');
    await t.send(t.message(OWNER, '/confirm LIVE-REQUEST abcdef12 1-WALLETS 0.0002 5-GWEI'));
    expect(t.lastTo(OWNER)).toContain('PREVIEW_NOT_FOUND');
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

  it('/schedule stores nothing until the typed phrase is confirmed, and the phrase works once', async () => {
    const t = setup();
    await unlocked(t);
    await t.send(t.message(OWNER, '/schedule camp1 all 0.2 2026-10-25T18:00 2026-10-25T20:00'));
    expect(t.lastTo(OWNER)).toContain('/confirm SCHEDULE abcd1234 1-WALLETS 0.0001 0.2-GWEI');
    expect(t.calls.some((call) => call.startsWith('scheduleCreate'))).toBe(false);
    await t.send(t.message(OWNER, '/confirm SCHEDULE abcd1234 1-WALLETS 0.0001 0.2-GWEI'));
    expect(t.calls).toContain('scheduleCreate(camp1|0x1111111111111111111111111111111111111111|0.2|2026-10-25T18:00|2026-10-25T20:00|SCHEDULE abcd1234 1-WALLETS 0.0001 0.2-GWEI)');
    await t.send(t.message(OWNER, '/confirm SCHEDULE abcd1234 1-WALLETS 0.0001 0.2-GWEI'));
    expect(t.calls.filter((call) => call.startsWith('scheduleCreate'))).toHaveLength(1);
    expect(t.lastTo(OWNER)).toMatch(/PREVIEW_NOT_FOUND|Not done/);
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
