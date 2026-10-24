import { randomBytes } from 'node:crypto';
import { redactText } from '@mint-bot/backend';
import type { TelegramSessionCloseReason, TelegramSessionRow, TelegramUserRow } from '@mint-bot/database';
import type { BotCommand, InlineButton, TelegramBotApi, TelegramUpdate } from './telegram-api.js';
import { GuidedFlows, flowNeedsSession, type FlowKind, type FlowResult, type GuidedActions } from './guided-flows.js';
import { base32Encode, matchTotp } from './totp.js';

/**
 * T-061 (D-063): the owner's commands over Telegram. This router decides who may do what; the work itself is done by
 * `TelegramActions`, which call the same functions as the host commands (D-063 item 9).
 *
 * - Only private chats are read. The owner is the one Telegram user ID in the host secret store; viewers are users the owner
 *   admitted with a one-time invite. Everyone else is ignored, except `/join`.
 * - Updates are acknowledged before they are handled (the service saves the offset first), so a command never runs twice, and a
 *   message older than five minutes is refused, so a backlog after a restart never runs a stale command.
 * - Start commands need an unlocked session (D-063 items 5 and 6) and their own typed phrase. Stop commands never need one.
 */

export type TelegramRole = 'owner' | 'viewer';

export interface TelegramAccess {
  activeUser(userId: string): TelegramUserRow | undefined;
  activeUsers(): TelegramUserRow[];
  touchUser(userId: string): void;
  removeUser(userId: string): boolean;
  createInvite(code: string, role: 'viewer', lifetimeMs: number): { id: string; expiresAt: string };
  join(code: string, userId: string): TelegramUserRow | undefined;
  openSession(): TelegramSessionRow | undefined;
  startSession(timeStep: number, lifetimeMs: number): TelegramSessionRow | undefined;
  closeSession(reason: TelegramSessionCloseReason): TelegramSessionRow | undefined;
  recordUnlockFailure(): void;
  unlockFailuresSince(since: Date): string[];
}

/** A reply, and the phrase a later command must repeat when there is one. */
export interface ActionReply { text: string; buttons?: InlineButton[][] }

/** The work behind each command. Every method throws a plain error (`CODE: words`) when the action is refused. */
export interface TelegramActions extends GuidedActions {
  status(role: TelegramRole): Promise<string>;
  health(): Promise<string>;
  rpc(): Promise<string>;
  gas(chain: string | undefined): Promise<string>;
  backup(): Promise<string>;
  wallets(): Promise<string>;
  funding(campaignId: string | undefined): Promise<string>;
  enablement(): Promise<string>;
  drops(): Promise<string>;
  calendar(): Promise<string>;
  check(chain: string, contract: string, includeFleet: boolean): Promise<string>;
  plan(chain: string, contract: string, quantityLimit: number | undefined): Promise<string>;
  /** The preview names the exact wallets, so a later `/confirm` uses those and no others. */
  requestPreview(campaignId: string, wallets: string, maxFeeGwei: number): Promise<{ text: string; phrase: string; wallets: string[] }>;
  requestCreate(campaignId: string, wallets: string, maxFeeGwei: number, phrase: string): Promise<string>;
  requests(): Promise<string>;
  runs(): Promise<string>;
  run(runId: string): Promise<string>;
  watchlist(): Promise<string>;
  track(address: string, label: string | undefined): Promise<string>;
  untrack(address: string): Promise<string>;
  prepare(chain: string, contract: string, quantityLimit: number, phrase: string): Promise<string>;
  simulate(campaignId: string): Promise<string>;
  /** Cancels a request the service has not started, or a scheduled mint (id starting `fire_schedule_` or its short form). */
  cancel(requestId: string): Promise<string>;
  schedules(): Promise<string>;
  kill(): Promise<string>;
  revoke(chain: string, phrase: string | undefined): Promise<string>;
  release(phrase: string | undefined): Promise<string>;
  watchAccept(chain: string, address: string, phrase: string | undefined): Promise<string>;
  limits(): Promise<string>;
  history(): Promise<string>;
  eligible(): Promise<string>;
  activity(): Promise<string>;
  holdings(): Promise<string>;
  /** T-068: every NFT the owner's wallets hold on Ethereum and Robinhood, from the outside data service. */
  portfolio(): Promise<string>;
  gasAlerts(): Promise<string>;
  gasAlertSet(chain: string, direction: string, gwei: number): Promise<string>;
  gasAlertRemove(id: string): Promise<string>;
  /** True when a kill (file or stored) was engaged after this moment: an open session then ends (D-063 item 6). */
  killEngagedSince(openedAt: string): boolean;
}

export interface TelegramRouterOptions {
  api: TelegramBotApi;
  access: TelegramAccess;
  actions: TelegramActions;
  ownerUserId: string;
  totpKey: Buffer;
  /** Durable record of every command (D-063 item 1). Never given arguments, codes or phrases. */
  record(event: { role: TelegramRole | 'unknown'; userId: string; command: string; outcome: string }): Promise<void>;
  /** Alert to the owner through the normal alert path (five wrong codes). */
  alert(text: string, dedupe: string): Promise<void>;
  now?: () => Date;
  sessionLifetimeMs?: number;
  inviteLifetimeMs?: number;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

export const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;
export const INVITE_LIFETIME_MS = 24 * 60 * 60 * 1000;
const MAX_MESSAGE_AGE_MS = 5 * 60 * 1000;
const CONFIRM_TAP_LIFETIME_MS = 2 * 60 * 1000;
const PREVIEW_LIFETIME_MS = 15 * 60 * 1000;
const UNLOCK_FAILURE_LIMIT = 5;
const UNLOCK_WINDOW_MS = 60 * 60 * 1000;
const JOIN_ATTEMPT_LIMIT = 5;

type Tier = 'read' | 'change' | 'stop' | 'start' | 'session' | 'admin';
interface CommandSpec { tier: Tier; roles: readonly TelegramRole[]; usage: string; help: string }

const OWNER: readonly TelegramRole[] = ['owner'];
const BOTH: readonly TelegramRole[] = ['owner', 'viewer'];

/** D-063 items 2 to 6 and 8. Viewers get only commands that never show the owner's wallets, balances, requests or runs. */
export const COMMANDS: Readonly<Record<string, CommandSpec>> = {
  start: { tier: 'read', roles: BOTH, usage: '/start', help: 'Open the menu' },
  menu: { tier: 'read', roles: BOTH, usage: '/menu', help: 'Open the menu' },
  help: { tier: 'read', roles: BOTH, usage: '/help', help: 'List the commands' },
  status: { tier: 'read', roles: BOTH, usage: '/status', help: 'Mode, kill switch, blocks, version, uptime' },
  health: { tier: 'read', roles: OWNER, usage: '/health', help: 'Readiness checks' },
  rpc: { tier: 'read', roles: OWNER, usage: '/rpc', help: 'Provider health and delay per chain' },
  gas: { tier: 'read', roles: BOTH, usage: '/gas [ethereum|base|robinhood]', help: 'Current network fees' },
  backup: { tier: 'read', roles: OWNER, usage: '/backup', help: 'Last backup and its check' },
  wallets: { tier: 'read', roles: OWNER, usage: '/wallets', help: 'Fleet balances per chain, watcher state' },
  funding: { tier: 'read', roles: OWNER, usage: '/funding <campaign>', help: 'What each wallet needs for a campaign' },
  enablement: { tier: 'read', roles: OWNER, usage: '/enablement', help: 'Base and Robinhood records' },
  drops: { tier: 'read', roles: BOTH, usage: '/drops', help: 'Upcoming opportunities' },
  calendar: { tier: 'read', roles: BOTH, usage: '/calendar', help: 'Mint calendar' },
  check: { tier: 'read', roles: BOTH, usage: '/check <chain> <contract>', help: 'Price, phase and limits (and your wallets, for the owner)' },
  plan: { tier: 'read', roles: OWNER, usage: '/plan <chain> <contract> [quantity]', help: 'Quantity and cost plan (Ethereum, Base, Robinhood), and the phrase for /prepare' },
  request: { tier: 'read', roles: OWNER, usage: '/request <campaign> <wallets|all> <max gwei>', help: 'Preview a live request and its phrase' },
  requests: { tier: 'read', roles: OWNER, usage: '/requests', help: 'Pending and recent requests' },
  runs: { tier: 'read', roles: OWNER, usage: '/runs', help: 'Recent runs' },
  run: { tier: 'read', roles: OWNER, usage: '/run <run id>', help: 'Result, spend and receipts of a run' },
  watchlist: { tier: 'read', roles: BOTH, usage: '/watchlist', help: 'Tracked whale wallets' },
  track: { tier: 'change', roles: OWNER, usage: '/track <address> [label]', help: 'Track a whale wallet' },
  untrack: { tier: 'change', roles: OWNER, usage: '/untrack <address>', help: 'Stop tracking a wallet' },
  prepare: { tier: 'change', roles: OWNER, usage: '/prepare <chain> <contract> <quantity> <phrase from /plan>', help: 'Record a live campaign (spends nothing)' },
  simulate: { tier: 'change', roles: OWNER, usage: '/simulate <campaign>', help: 'Record fresh test mints (good 30 minutes)' },
  cancel: { tier: 'change', roles: OWNER, usage: '/cancel <request or schedule id>', help: 'Cancel a request or scheduled mint the service has not started' },
  kill: { tier: 'stop', roles: OWNER, usage: '/kill', help: 'Stop everything at once (one tap to confirm)' },
  revoke: { tier: 'stop', roles: OWNER, usage: '/revoke <base|robinhood> [phrase]', help: 'Switch a chain off' },
  lock: { tier: 'stop', roles: OWNER, usage: '/lock', help: 'End the unlocked session now' },
  unlock: { tier: 'session', roles: OWNER, usage: '/unlock <6-digit code>', help: 'Unlock start commands for 12 hours' },
  release: { tier: 'start', roles: OWNER, usage: '/release [phrase]', help: 'Turn the kill switch off' },
  confirm: { tier: 'start', roles: OWNER, usage: '/confirm <phrase from /request or /schedule>', help: 'Send a live request, or store a scheduled mint' },
  fire: { tier: 'start', roles: OWNER, usage: '/fire <campaign> <wallets|all> <max gwei>', help: 'Mint now: test, approve and run a prepared campaign (one tap)' },
  schedule: { tier: 'start', roles: OWNER, usage: '/schedule <campaign> <wallets|all> <max gwei> <from> <until>', help: 'Fire a prepared mint when it opens, inside a window (UTC)' },
  schedules: { tier: 'read', roles: OWNER, usage: '/schedules', help: 'Scheduled mints and what became of them' },
  watchaccept: { tier: 'start', roles: OWNER, usage: '/watchaccept <chain> <address> [phrase]', help: 'Accept a wallet change the watcher flagged' },
  limits: { tier: 'read', roles: OWNER, usage: '/limits', help: 'How much of each daily limit is used and left' },
  history: { tier: 'read', roles: OWNER, usage: '/history', help: 'Past live mints: totals per chain and newest runs' },
  eligible: { tier: 'read', roles: OWNER, usage: '/eligible', help: 'Upcoming drops against your wallets' },
  activity: { tier: 'read', roles: OWNER, usage: '/activity', help: 'Recent mints by wallets you track' },
  holdings: { tier: 'read', roles: OWNER, usage: '/holdings', help: 'NFTs your wallets hold from MintBot mints' },
  portfolio: { tier: 'read', roles: OWNER, usage: '/portfolio', help: 'Every NFT your wallets hold (Ethereum, Robinhood)' },
  gasalerts: { tier: 'read', roles: OWNER, usage: '/gasalerts', help: 'Your fee alerts' },
  gasalert: { tier: 'change', roles: OWNER, usage: '/gasalert <chain> <below|above> <gwei>  or  /gasalert remove <id>', help: 'Add or remove a fee alert' },
  invite: { tier: 'admin', roles: OWNER, usage: '/invite', help: 'One-time code for a friend (viewer, 24 hours)' },
  users: { tier: 'admin', roles: OWNER, usage: '/users', help: 'Who has access' },
  removeuser: { tier: 'admin', roles: OWNER, usage: '/removeuser <user id>', help: 'End someone\'s access now' },
  broadcast: { tier: 'admin', roles: OWNER, usage: '/broadcast <text>', help: 'Message every user' },
};

/** The commands Telegram lists for a role (names are lower case letters, digits and underscores, as Telegram requires). */
export function menuFor(role: TelegramRole): BotCommand[] {
  return Object.entries(COMMANDS).filter(([name, spec]) => spec.roles.includes(role) && name !== 'start' && /^[a-z0-9_]{1,32}$/.test(name)).map(([name, spec]) => ({ command: name, description: spec.help.slice(0, 256) }));
}

/** Text from errors is cleaned before it reaches a chat: no addresses with keys, no long hex. */
export function plainError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'FAILED';
  const cleaned = redactText(message).replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[link]').replace(/\b[0-9a-fA-F]{64,}\b/g, '[hidden]');
  return cleaned.slice(0, 600);
}
const errorCode = (error: unknown): string => {
  const code = (error instanceof Error ? error.message : '').split(':')[0] ?? '';
  return /^[A-Z][A-Z0-9_]{2,80}$/.test(code) ? code : 'FAILED';
};

interface Incoming { userId: string; chatId: number; text: string; messageId?: number; callbackId?: string; sentAt: number; /** Plain text that is not a command: only the owner's answer to a guided flow uses it. */ plain?: boolean }

export class TelegramCommandRouter {
  private readonly now: () => Date;
  private readonly sessionLifetimeMs: number;
  private readonly inviteLifetimeMs: number;
  private readonly confirmTaps = new Map<string, number>();
  private readonly previews = new Map<string, { campaignId: string; wallets: string; maxFeeGwei: number; at: number; schedule?: { from: string; until: string; digest?: string } }>();
  private readonly fireTaps = new Map<string, { campaignId: string; wallets: string; maxFeeGwei: number; at: number; digest?: string }>();
  private readonly joinAttempts = new Map<string, number[]>();
  private readonly flows: GuidedFlows;

  public constructor(private readonly options: TelegramRouterOptions) {
    if (!/^\d{1,20}$/.test(options.ownerUserId)) throw new Error('TELEGRAM_OWNER_USER_ID_INVALID');
    this.now = options.now ?? (() => new Date());
    this.sessionLifetimeMs = options.sessionLifetimeMs ?? SESSION_LIFETIME_MS;
    this.inviteLifetimeMs = options.inviteLifetimeMs ?? INVITE_LIFETIME_MS;
    this.startedAt = this.now().getTime();
    this.flows = new GuidedFlows({ actions: options.actions, now: this.now, explain: plainError });
  }
  private readonly startedAt: number;
  private readonly viewerUse = new Map<string, number[]>();

  /**
   * T-066: the command list Telegram shows in its menu. Everyone sees only /join; the owner and each viewer see their own commands.
   * Best effort: a failure here never stops the bot.
   */
  public async registerMenus(): Promise<void> {
    const api = this.options.api;
    if (!api.setMyCommands) return;
    const set = async (commands: BotCommand[], chatId?: number | string): Promise<void> => {
      try { await api.setMyCommands!(commands, chatId); } catch (error) { this.options.log?.('telegram_menu_failed', { code: errorCode(error) }); }
    };
    await set([{ command: 'join', description: 'Join with an invite code from the owner' }]);
    await set(menuFor('owner'), this.options.ownerUserId);
    for (const user of this.options.access.activeUsers()) await set(menuFor('viewer'), user.userId);
  }

  /** The service restarted: any open session ends (D-063 item 6). */
  public async onStart(): Promise<void> {
    if (this.options.access.closeSession('restart')) await this.announce('Your unlocked session ended because the service restarted. Send /unlock with a new code when you need start commands.');
  }

  /** Ends a session that expired or that a kill ended, and says so. Called on every polling pass. */
  public async checkSession(): Promise<void> { await this.currentSession(); }

  public async handle(update: TelegramUpdate): Promise<void> {
    const incoming = this.incoming(update);
    if (!incoming) return;
    if (incoming.callbackId) await this.options.api.answerCallback(incoming.callbackId).catch(() => undefined);
    const role = this.roleOf(incoming.userId);
    // Plain text (not a command) is only ever the owner's answer to a guided flow; anyone else's is ignored without a reply.
    if (incoming.plain) { if (role === 'owner') await this.flowText(incoming); return; }
    const [rawCommand = '', ...args] = incoming.text.trim().split(/\s+/);
    const command = rawCommand.replace(/^\//, '').replace(/@.*$/, '').toLowerCase();
    if (!role) {
      if (command === 'join') await this.join(incoming, args);
      return;
    }
    if (role === 'viewer') {
      // A viewer is limited to 10 commands a minute, so a friend's chat can never crowd out the owner's.
      const nowMs = this.now().getTime();
      const recent = (this.viewerUse.get(incoming.userId) ?? []).filter((at) => nowMs - at < 60_000);
      if (recent.length >= VIEWER_COMMANDS_PER_MINUTE) return;
      this.viewerUse.set(incoming.userId, [...recent, nowMs]);
      this.options.access.touchUser(incoming.userId);
    }
    if (this.now().getTime() - incoming.sentAt > MAX_MESSAGE_AGE_MS) {
      await this.reply(incoming, 'That message is more than 5 minutes old, so it was not run. Send it again if you still want it.');
      await this.record(role, incoming, command || 'unknown', 'refused:TOO_OLD');
      return;
    }
    if (command.startsWith('tap_kill_')) { await this.confirmKill(incoming, command.slice('tap_kill_'.length)); return; }
    if (command.startsWith('tap_fire_')) { await this.confirmFire(incoming, command.slice('tap_fire_'.length)); return; }
    if (command.startsWith('f_')) { await this.flowButton(incoming, command); return; }
    const spec = COMMANDS[command];
    if (!spec || !spec.roles.includes(role)) {
      await this.reply(incoming, role === 'owner' ? 'Unknown command. Send /help for the list.' : 'That command is not available to you. Send /help for the list.');
      await this.record(role, incoming, 'unknown', 'refused:UNKNOWN_COMMAND');
      return;
    }
    // Another command ends any wait for typed text in a guided flow (its buttons still work).
    if (role === 'owner') this.flows.interrupt();
    try {
      if (spec.tier === 'start' && !(await this.currentSession())) {
        await this.reply(incoming, 'This needs an unlocked session. Send /unlock followed by the 6-digit code from your authenticator app, then send the command again.');
        await this.record(role, incoming, command, 'refused:SESSION_REQUIRED');
        return;
      }
      const work = this.run(command, role, incoming, args);
      // Only a read is given up after a while: anything that records something runs to its end, so its answer is always true.
      await (spec.tier === 'read' ? withTimeout(work, ACTION_TIMEOUT_MS) : work);
      await this.record(role, incoming, command, 'ok');
    } catch (error) {
      await this.reply(incoming, `Not done: ${plainError(error)}`);
      await this.record(role, incoming, command, `refused:${errorCode(error)}`);
    }
  }

  private incoming(update: TelegramUpdate): Incoming | undefined {
    if (update.callback_query) {
      const query = update.callback_query;
      const message = query.message;
      if (!message || message.chat.type !== 'private' || message.chat.id !== query.from.id || query.from.is_bot || typeof query.data !== 'string') return undefined;
      // Only the bot's own buttons: a menu command without arguments, or a kill or fire confirmation.
      if (!/^\/(?:tap_kill_[0-9a-f]{18}|tap_fire_[0-9a-f]{18}|f_[0-9a-f]{8}_[0-9][a-z0-9]{1,12}|[a-z]{2,16})$/.test(query.data)) return undefined;
      // A tap counts from the moment it was made, not when its message was sent.
      return { userId: String(query.from.id), chatId: message.chat.id, text: query.data, callbackId: query.id, sentAt: this.now().getTime() };
    }
    const message = update.message;
    if (!message || !message.from || message.from.is_bot || message.chat.type !== 'private' || message.chat.id !== message.from.id || typeof message.text !== 'string') return undefined;
    if (!message.text.startsWith('/')) return { userId: String(message.from.id), chatId: message.chat.id, text: message.text.slice(0, 500), messageId: message.message_id, sentAt: message.date * 1000, plain: true };
    return { userId: String(message.from.id), chatId: message.chat.id, text: message.text, messageId: message.message_id, sentAt: message.date * 1000 };
  }

  private roleOf(userId: string): TelegramRole | undefined {
    if (userId === this.options.ownerUserId) return 'owner';
    return this.options.access.activeUser(userId) ? 'viewer' : undefined;
  }

  private async run(command: string, role: TelegramRole, incoming: Incoming, args: string[]): Promise<void> {
    const a = this.options.actions;
    const reply = (text: string, buttons?: InlineButton[][]) => this.reply(incoming, text, buttons);
    switch (command) {
      case 'start': case 'menu': return reply(role === 'owner' ? 'MintBot. Choose, or send /help for every command.' : 'MintBot (viewer). Choose, or send /help.', this.menu(role));
      case 'help': return reply(this.helpText(role));
      case 'status': return reply(await a.status(role));
      case 'health': return reply(await a.health());
      case 'rpc': return reply(await a.rpc());
      case 'gas': return reply(await a.gas(args[0]));
      case 'backup': return reply(await a.backup());
      case 'wallets': return reply(await a.wallets());
      case 'funding': return reply(await a.funding(args[0]));
      case 'enablement': return reply(await a.enablement());
      case 'drops': return reply(await a.drops());
      case 'calendar': return reply(await a.calendar());
      case 'check': return reply(await a.check(required(args[0], 'chain'), required(args[1], 'contract'), role === 'owner'));
      case 'plan': return reply(await a.plan(required(args[0], 'chain'), required(args[1], 'contract'), optionalNumber(args[2], 'quantity')));
      case 'request': {
        const preview = await a.requestPreview(required(args[0], 'campaign'), required(args[1], 'wallets'), requiredNumber(args[2], 'max gwei'));
        this.prune();
        this.previews.set(preview.phrase, { campaignId: args[0]!, wallets: preview.wallets.join(','), maxFeeGwei: Number(args[2]), at: this.now().getTime() });
        return reply(`${preview.text}\n\nTo send it, within 15 minutes:\n\n/confirm ${preview.phrase}`);
      }
      case 'fire': {
        if (args.length === 0) return this.startFlow(incoming, 'fire');
        const campaignId = required(args[0], 'campaign');
        const maxFeeGwei = requiredNumber(args[2], 'max gwei');
        const preview = await a.firePreview(campaignId, required(args[1], 'wallets'), maxFeeGwei);
        this.prune();
        const nonce = randomBytes(9).toString('hex');
        this.fireTaps.set(nonce, { campaignId, wallets: preview.wallets.join(','), maxFeeGwei, at: this.now().getTime(), ...(preview.digest ? { digest: preview.digest } : {}) });
        return reply(`${preview.text}\n\nTap within 2 minutes to test, approve and mint now.`, [[{ text: 'Yes, mint now', callback_data: `/tap_fire_${nonce}` }]]);
      }
      case 'schedule': {
        if (args.length === 0) return this.startFlow(incoming, 'schedule');
        const campaignId = required(args[0], 'campaign');
        const maxFeeGwei = requiredNumber(args[2], 'max gwei');
        const from = required(args[3], 'from');
        const until = required(args[4], 'until');
        const preview = await a.schedulePreview(campaignId, required(args[1], 'wallets'), maxFeeGwei, from, until);
        this.prune();
        this.previews.set(preview.phrase, { campaignId, wallets: preview.wallets.join(','), maxFeeGwei, at: this.now().getTime(), schedule: { from: preview.from, until: preview.until, ...(preview.digest ? { digest: preview.digest } : {}) } });
        return reply(`${preview.text}\n\nTo store it, within 15 minutes:\n\n/confirm ${preview.phrase}`);
      }
      case 'schedules': return reply(await a.schedules());
      case 'confirm': {
        const phrase = args.join(' ');
        this.prune();
        const preview = this.previews.get(phrase);
        if (!preview) throw new Error('PREVIEW_NOT_FOUND: send /request or /schedule again and copy the /confirm line it prints');
        this.previews.delete(phrase);
        if (preview.schedule) return reply(await a.scheduleCreate(preview.campaignId, preview.wallets, preview.maxFeeGwei, preview.schedule.from, preview.schedule.until, phrase, preview.schedule.digest));
        return reply(await a.requestCreate(preview.campaignId, preview.wallets, preview.maxFeeGwei, phrase));
      }
      case 'requests': return reply(await a.requests());
      case 'runs': return reply(await a.runs());
      case 'run': return reply(await a.run(required(args[0], 'run id')));
      case 'watchlist': return reply(await a.watchlist());
      case 'limits': return reply(await a.limits());
      case 'history': return reply(await a.history());
      case 'eligible': return reply(await a.eligible());
      case 'activity': return reply(await a.activity());
      case 'holdings': return reply(await a.holdings());
      case 'portfolio': return reply(await a.portfolio());
      case 'gasalerts': return reply(await a.gasAlerts());
      case 'gasalert': return reply(args[0]?.toLowerCase() === 'remove' ? await a.gasAlertRemove(required(args[1], 'alert id')) : await a.gasAlertSet(required(args[0], 'chain'), required(args[1], 'below or above'), requiredNumber(args[2], 'gwei')));
      case 'track': return reply(await a.track(required(args[0], 'address'), args.slice(1).join(' ') || undefined));
      case 'untrack': return reply(await a.untrack(required(args[0], 'address')));
      case 'prepare': if (args.length === 0) return this.startFlow(incoming, 'prepare'); return reply(await a.prepare(required(args[0], 'chain'), required(args[1], 'contract'), requiredNumber(args[2], 'quantity'), required(args.slice(3).join(' ') || undefined, 'phrase from /plan')));
      case 'simulate': return reply(await a.simulate(required(args[0], 'campaign')));
      case 'cancel': return reply(await a.cancel(required(args[0], 'request id')));
      case 'kill': {
        this.prune();
        const nonce = randomBytes(9).toString('hex');
        this.confirmTaps.set(nonce, this.now().getTime());
        return reply('Stop everything now? This engages the kill switch: no new live work until you release it. Tap within 2 minutes.', [[{ text: 'Yes, stop everything', callback_data: `/tap_kill_${nonce}` }]]);
      }
      case 'revoke': return reply(await a.revoke(required(args[0], 'base or robinhood'), args.slice(1).join(' ') || undefined));
      case 'lock': {
        const closed = this.options.access.closeSession('lock');
        return reply(closed ? 'Locked. Start commands need /unlock again.' : 'There was no unlocked session.');
      }
      case 'unlock': return this.unlock(incoming, args.length > 0 ? args.join('') : undefined);
      case 'release': return args.length === 0 ? this.startFlow(incoming, 'release') : reply(await a.release(args.join(' ')));
      case 'watchaccept': return reply(await a.watchAccept(required(args[0], 'chain'), required(args[1], 'address'), args.slice(2).join(' ') || undefined));
      case 'invite': {
        const code = base32Encode(randomBytes(10));
        const invite = this.options.access.createInvite(code, 'viewer', this.inviteLifetimeMs);
        return reply(`Invite for one person (viewer), valid until ${invite.expiresAt}, usable once.\n\nAsk them to open a private chat with this bot and send:\n/join ${code}\n\nViewers see drops, the calendar, contract checks and status. They never see your wallets, balances, requests or runs, and cannot change anything.`);
      }
      case 'users': {
        const users = this.options.access.activeUsers();
        return reply(users.length === 0 ? 'Nobody else has access.' : ['People with access:', ...users.map((user) => `• ${user.userId} (${user.role}) since ${user.addedAt.slice(0, 16)}, last used ${user.lastUsedAt ? user.lastUsedAt.slice(0, 16) : 'never'}`), '', 'Remove someone with /removeuser <user id>.'].join('\n'));
      }
      case 'removeuser': {
        const userId = required(args[0], 'user id');
        if (!/^\d{1,20}$/.test(userId)) throw new Error('USER_ID_INVALID: use the number /users shows');
        const removed = this.options.access.removeUser(userId);
        if (removed) await this.options.api.sendMessage(userId, 'Your access to this MintBot has ended.').catch(() => undefined);
        if (removed) await this.options.api.deleteMyCommands?.(userId).catch(() => undefined);
        return reply(removed ? `Access for ${userId} ended.` : `${userId} had no access.`);
      }
      case 'broadcast': {
        const text = args.join(' ').trim();
        if (!text) throw new Error('TEXT_REQUIRED: /broadcast <text>');
        let sent = 0;
        for (const user of this.options.access.activeUsers()) {
          try { await this.options.api.sendMessage(user.userId, `Message from the owner:\n${text.slice(0, 3_000)}`); sent += 1; } catch { /* one undeliverable user never stops the others */ }
        }
        return reply(`Sent to ${sent} of ${this.options.access.activeUsers().length} user(s).`);
      }
      default: throw new Error('UNKNOWN_COMMAND');
    }
  }

  // ── guided flows (T-073, D-069) ─────────────────────────────────────────────────────────────────

  private async startFlow(incoming: Incoming, kind: FlowKind): Promise<void> {
    const result = await this.flows.start(kind);
    await this.reply(incoming, result.reply.text, result.reply.buttons);
  }

  private async showFlow(incoming: Incoming, result: FlowResult): Promise<void> {
    await this.reply(incoming, result.reply.text, result.reply.buttons);
    if (result.done) await this.record('owner', incoming, result.done.command, result.done.outcome);
  }

  private async flowButton(incoming: Incoming, command: string): Promise<void> {
    if (incoming.userId !== this.options.ownerUserId || !incoming.callbackId) return;
    const match = /^f_([0-9a-f]{8})_(.+)$/.exec(command);
    if (!match) return;
    try {
      const kind = this.flows.kind(match[1]!);
      // A flow that releases, fires or schedules needs the unlocked session at every tap, as the typed commands do.
      if (kind && flowNeedsSession(kind) && match[2] !== 'x' && !(await this.currentSession())) {
        await this.reply(incoming, 'This needs an unlocked session. Send /unlock followed by the 6-digit code, then tap the button again.');
        await this.record('owner', incoming, kind, 'refused:SESSION_REQUIRED');
        return;
      }
      await this.showFlow(incoming, await this.flows.onButton(match[1]!, match[2]!));
    } catch (error) {
      await this.reply(incoming, `Not done: ${plainError(error)}`);
    }
  }

  private async flowText(incoming: Incoming): Promise<void> {
    // An answer that is more than 5 minutes old is not used, as for commands.
    if (this.now().getTime() - incoming.sentAt > MAX_MESSAGE_AGE_MS) { await this.reply(incoming, 'That message is more than 5 minutes old, so it was not used. Send it again if you still want it.'); return; }
    try {
      const result = await this.flows.onText(incoming.text);
      if (result) await this.showFlow(incoming, result);
    } catch (error) {
      await this.reply(incoming, `Not done: ${plainError(error)}`);
    }
  }

  private async confirmKill(incoming: Incoming, nonce: string): Promise<void> {
    if (incoming.userId !== this.options.ownerUserId) return;
    this.prune();
    if (!incoming.callbackId || !this.confirmTaps.delete(nonce)) {
      await this.reply(incoming, 'That button has expired. Send /kill again.');
      await this.record('owner', incoming, 'kill', 'refused:TAP_EXPIRED');
      return;
    }
    // A kill ends any open guided flow, so an old button cannot act after it.
    this.flows.cancel();
    try {
      const text = await this.options.actions.kill();
      this.options.access.closeSession('kill');
      await this.reply(incoming, `${text}\nAny unlocked session has ended.`);
      await this.record('owner', incoming, 'kill', 'ok');
    } catch (error) {
      // Even when the kill could not be engaged, the session ends: the owner meant to stop.
      this.options.access.closeSession('kill');
      await this.reply(incoming, `Not done: ${plainError(error)}. If you need to stop now, create the kill file on the host.`);
      await this.record('owner', incoming, 'kill', `refused:${errorCode(error)}`);
    }
  }

  /** The owner's tap on a `/fire` preview is the approval (D-067). It needs the owner, an unlocked session and a tap under 2 minutes old. */
  private async confirmFire(incoming: Incoming, nonce: string): Promise<void> {
    if (incoming.userId !== this.options.ownerUserId) return;
    this.prune();
    const tap = incoming.callbackId ? this.fireTaps.get(nonce) : undefined;
    if (!tap) {
      await this.reply(incoming, 'That button has expired. Send /fire again.');
      await this.record('owner', incoming, 'fire', 'refused:TAP_EXPIRED');
      return;
    }
    try {
      if (!(await this.currentSession())) {
        await this.reply(incoming, 'This needs an unlocked session. Send /unlock followed by the 6-digit code, then send /fire again.');
        await this.record('owner', incoming, 'fire', 'refused:SESSION_REQUIRED');
        return;
      }
      this.fireTaps.delete(nonce);
      await this.reply(incoming, await this.options.actions.fireNow(tap.campaignId, tap.wallets, tap.maxFeeGwei, tap.digest));
      await this.record('owner', incoming, 'fire', 'ok');
    } catch (error) {
      this.fireTaps.delete(nonce);
      await this.reply(incoming, `Not done: ${plainError(error)}`);
      await this.record('owner', incoming, 'fire', `refused:${errorCode(error)}`);
    }
  }

  private async unlock(incoming: Incoming, code: string | undefined): Promise<void> {
    // The code is taken out of the chat history at once, whatever happens next.
    if (incoming.messageId !== undefined) await this.options.api.deleteMessage(incoming.chatId, incoming.messageId).catch(() => undefined);
    const now = this.now();
    const failures = this.options.access.unlockFailuresSince(new Date(now.getTime() - UNLOCK_WINDOW_MS));
    if (failures.length >= UNLOCK_FAILURE_LIMIT) {
      const until = new Date(Date.parse(failures[failures.length - UNLOCK_FAILURE_LIMIT]!) + UNLOCK_WINDOW_MS);
      throw new Error(`UNLOCK_LOCKED: too many wrong codes. Unlocking is blocked until ${until.toISOString().slice(0, 16).replace('T', ' ')} UTC`);
    }
    const step = code === undefined ? undefined : matchTotp(this.options.totpKey, code, now);
    const session = step === undefined ? undefined : this.options.access.startSession(step, this.sessionLifetimeMs);
    if (!session) {
      this.options.access.recordUnlockFailure();
      const count = failures.length + 1;
      if (count >= UNLOCK_FAILURE_LIMIT) await this.options.alert('Five wrong unlock codes were sent to the Telegram bot in the last hour. Unlocking is blocked for an hour. If this was not you, send /kill and secure your Telegram account.', `telegram-unlock-locked:${Math.floor(now.getTime() / UNLOCK_WINDOW_MS)}`).catch(() => undefined);
      throw new Error(`UNLOCK_CODE_WRONG: that code did not work (codes work once and change every 30 seconds). ${Math.max(0, UNLOCK_FAILURE_LIMIT - count)} attempt(s) left this hour`);
    }
    await this.reply(incoming, `Unlocked until ${session.expiresAt.slice(0, 16).replace('T', ' ')} UTC. Start commands (/release, /confirm, /fire, /schedule, /watchaccept) now need only their phrase. Send /lock when you are done.`);
  }

  private async join(incoming: Incoming, args: string[]): Promise<void> {
    const now = this.now().getTime();
    // Strangers are counted in memory only (bounded), so nobody outside can fill the store or this map.
    if (this.joinAttempts.size > 1_000) for (const [userId, times] of this.joinAttempts) if (times.every((at) => now - at >= UNLOCK_WINDOW_MS)) this.joinAttempts.delete(userId);
    if (this.joinAttempts.size > 1_000) return;
    const attempts = (this.joinAttempts.get(incoming.userId) ?? []).filter((at) => now - at < UNLOCK_WINDOW_MS);
    if (attempts.length >= JOIN_ATTEMPT_LIMIT) return;
    this.joinAttempts.set(incoming.userId, [...attempts, now]);
    const code = (args[0] ?? '').toUpperCase();
    const user = /^[A-Z2-7]{16}$/.test(code) ? this.options.access.join(code, incoming.userId) : undefined;
    if (!user) return;
    await this.record('viewer', incoming, 'join', 'ok');
    await this.reply(incoming, 'Welcome. You can now see drops, the calendar and contract checks. Send /menu to start.', this.menu('viewer'));
    await this.options.api.setMyCommands?.(menuFor('viewer'), incoming.userId).catch(() => undefined);
    await this.options.api.sendMessage(this.options.ownerUserId, `Telegram user ${incoming.userId} joined as a viewer. Remove them at any time with /removeuser ${incoming.userId}.`).catch(() => undefined);
  }

  /** The open session, after ending it if it expired or a kill was engaged after it opened. */
  private async currentSession(): Promise<TelegramSessionRow | undefined> {
    const session = this.options.access.openSession();
    if (!session) return undefined;
    // A session from before this process started never carries over a restart, even if closing it at start failed.
    if (Date.parse(session.openedAt) < this.startedAt) {
      if (this.options.access.closeSession('restart')) await this.announce('Your unlocked session ended because the service restarted. Send /unlock with a new code when you need start commands.');
      return undefined;
    }
    if (Date.parse(session.expiresAt) <= this.now().getTime()) {
      if (this.options.access.closeSession('expired')) await this.announce('Your 12-hour unlocked session has ended. Send /unlock with a new code when you need start commands again.');
      return undefined;
    }
    // A session whose kill state cannot be checked counts as ended (fail closed).
    let killed: boolean;
    try { killed = this.options.actions.killEngagedSince(session.openedAt); } catch { killed = true; }
    if (killed) {
      if (this.options.access.closeSession('kill')) await this.announce('The kill switch was engaged (or could not be checked), so your unlocked session has ended.');
      return undefined;
    }
    return session;
  }

  private menu(role: TelegramRole): InlineButton[][] {
    const button = (command: string, text: string): InlineButton => ({ text, callback_data: `/${command}` });
    if (role === 'viewer') return [[button('drops', 'Drops'), button('calendar', 'Calendar')], [button('status', 'Status'), button('gas', 'Fees')], [button('watchlist', 'Watchlist'), button('help', 'Help')]];
    return [
      [button('status', 'Status'), button('health', 'Health'), button('rpc', 'RPC')],
      [button('drops', 'Drops'), button('calendar', 'Calendar'), button('gas', 'Fees')],
      [button('wallets', 'Wallets'), button('requests', 'Requests'), button('runs', 'Runs')],
      [button('prepare', 'Prepare'), button('release', 'Release'), button('fire', 'Fire')],
      [button('enablement', 'Chains'), button('backup', 'Backup'), button('users', 'Users')],
      [button('kill', 'STOP (kill)'), button('lock', 'Lock')],
    ];
  }

  private helpText(role: TelegramRole): string {
    const lines = Object.values(COMMANDS).filter((spec) => spec.roles.includes(role) && spec.usage !== '/start').map((spec) => `${spec.usage} — ${spec.help}`);
    const note = role === 'owner' ? '\n\nStart commands (/release, /confirm, /fire, /schedule, /watchaccept) need /unlock first; /kill never does.' : '';
    return `Commands:\n${lines.join('\n')}${note}`;
  }

  private prune(): void {
    const now = this.now().getTime();
    for (const [nonce, at] of this.confirmTaps) if (now - at > CONFIRM_TAP_LIFETIME_MS) this.confirmTaps.delete(nonce);
    for (const [nonce, tap] of this.fireTaps) if (now - tap.at > CONFIRM_TAP_LIFETIME_MS) this.fireTaps.delete(nonce);
    for (const [phrase, preview] of this.previews) if (now - preview.at > PREVIEW_LIFETIME_MS) this.previews.delete(phrase);
  }

  private async reply(incoming: Incoming, text: string, buttons?: InlineButton[][]): Promise<void> {
    try { await this.options.api.sendMessage(incoming.chatId, text, buttons); }
    catch (error) { this.options.log?.('telegram_reply_failed', { code: errorCode(error) }); }
  }

  private async announce(text: string): Promise<void> {
    try { await this.options.api.sendMessage(this.options.ownerUserId, text); }
    catch (error) { this.options.log?.('telegram_announce_failed', { code: errorCode(error) }); }
  }

  private async record(role: TelegramRole | 'unknown', incoming: Incoming, command: string, outcome: string): Promise<void> {
    try { await this.options.record({ role, userId: incoming.userId, command: /^[a-z_]{1,32}$/.test(command) ? command : 'unknown', outcome }); }
    catch (error) { this.options.log?.('telegram_record_failed', { code: errorCode(error) }); }
  }
}

const ACTION_TIMEOUT_MS = 90_000;
const VIEWER_COMMANDS_PER_MINUTE = 10;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('TIMED_OUT: the chain or a provider did not answer in time; try again')), ms); timer.unref?.(); });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** Stop commands and their confirmation taps (D-063 item 4): the service handles these at once, never behind a slower command. */
export function isStopUpdate(update: TelegramUpdate): boolean {
  const text = (update.callback_query?.data ?? update.message?.text ?? '').trim();
  const command = (text.split(/\s+/)[0] ?? '').replace(/^\//, '').replace(/@.*$/, '').toLowerCase();
  return command.startsWith('tap_kill_') || COMMANDS[command]?.tier === 'stop';
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === '') throw new Error(`MISSING_${name.toUpperCase().replace(/[^A-Z]+/g, '_')}: add the ${name}. Send /help for the format`);
  return value;
}
function requiredNumber(value: string | undefined, name: string): number {
  const parsed = Number(required(value, name));
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`INVALID_${name.toUpperCase().replace(/[^A-Z]+/g, '_')}: the ${name} must be a number above 0`);
  return parsed;
}
function optionalNumber(value: string | undefined, name: string): number | undefined {
  return value === undefined ? undefined : requiredNumber(value, name);
}
