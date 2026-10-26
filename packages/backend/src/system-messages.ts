import { buildSystemCard, type SystemCard, type SystemLine } from './system-card.js';
import { chainDisplay } from './alert-card.js';

/**
 * Builders for the owner's system messages (T-030, D-045). Each one answers three things in plain language: what
 * happened, what it means, what to do. Reason codes become words, with the code kept in brackets for support. No
 * builder takes a secret, an endpoint or a local path, and free text from a notice is never copied in: only a code
 * that matches the code pattern is shown.
 */

// A code, optionally followed by up to two fixed upper-case detail parts (READINESS_REFRESH_FAILED:FUNDING_NOT_ARRIVED), so the failing step shows on the card.
const CODE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+(?::[A-Z][A-Z0-9_]{2,80}){0,2}\b/;

/** Reason code → what it means, in words. Unknown codes are shown as the code alone. */
export const REASON_WORDS: Readonly<Record<string, string>> = {
  KILL_SWITCH_ENGAGED: 'the kill switch was engaged',
  SPEND_CAP_EXCEEDED: 'it would exceed your per-mint limit',
  DAILY_SPEND_CAP_EXCEEDED: 'it would exceed your daily limit for one wallet',
  FLEET_DAILY_CAP_EXCEEDED: 'it would exceed your daily limit across all wallets',
  FREE_TOTAL_SPEND_CAP_EXCEEDED: 'it would exceed your total limit for free mints',
  PAID_WALLET_LIMIT_EXCEEDED: 'it would exceed your paid-mint limit for one wallet',
  PAID_ETHEREUM_CAP_REQUIRED: 'a paid mint on Ethereum needs a limit you have not set',
  PRICE_ABOVE_LIMIT: 'the mint price is above your limit',
  ROBINHOOD_ACTIVE_PERIOD_CAP_EXCEEDED: 'it would exceed the limit for this Robinhood period',
  ROBINHOOD_PER_WALLET_CAP_EXCEEDED: 'it would exceed the Robinhood limit for one wallet',
  FEE_POLICY_CAP_EXCEEDED: 'the network fee would be above your fee limit',
  AMBIGUOUS_TOTAL_FEE_BUDGET: 'the total fee limit was not clear, so nothing was admitted',
  HEAD_UNAVAILABLE: 'the bot could not read the latest block',
  LOGS_UNAVAILABLE: 'the bot could not read the mint events',
  ENGINE_ERROR: 'the execution engine reported an error',
  READINESS_REFRESH_FAILED: 'a readiness check failed before the run could start (the part after the colon names which)',
  FUNDING_NOT_ARRIVED: 'a wallet does not hold enough to cover the run',
  WALLET_ORDER_NOT_READY: 'wallets are used in list order and an earlier wallet is not ready',
  WALLET_SELECTION_NOT_REPRESENTABLE: 'the wallets chosen are not the first wallets of the list, which is what the engine uses',
  STARTUP_RECONCILIATION_REQUIRED: 'the service is still finishing its start-up check; wait a minute and try again',
  LIVE_REQUEST_FAILED: 'the run failed with an error the bot does not show (the part after the colon is a safe hint)',
};

/** The first code-shaped word in a notice, if any. Nothing else of the notice is used. */
export function reasonCode(notice: string | undefined): string | undefined {
  return notice?.match(CODE)?.[0];
}

export function reasonText(code: string | undefined, fallback: string): string {
  if (!code) return fallback;
  const head = code.split(':')[0]!;
  const words = Object.hasOwn(REASON_WORDS, head) ? REASON_WORDS[head] : undefined;
  return words ? `${words} [${code}]` : `${fallback} [${code}]`;
}

const duration = (seconds: number): string => {
  const total = Math.max(0, Math.round(seconds));
  if (total < 90) return `${total} s`;
  const minutes = Math.round(total / 60);
  if (minutes < 120) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h ${minutes % 60} min` : `${Math.floor(hours / 24)} days ${hours % 24} h`;
};
export { duration as durationText };

/** Kill switch engaged (the one message that always goes out at once). */
export function killEngagedCard(input: { reason?: string; runId?: string; at: Date | string }): SystemCard {
  return buildSystemCard({
    title: 'KILL SWITCH ENGAGED',
    severity: 'critical',
    lines: [
      { label: 'What happened', value: reasonText(reasonCode(input.reason), 'the kill switch was engaged'), strong: true },
      { label: 'What it means', value: 'no new mints are admitted. Anything already submitted still has to be checked.' },
    ],
    steps: ['Nothing is needed. To resume, check the state first, then release the kill switch from the terminal.'],
    ...(input.runId ? { code: { label: 'Run', value: input.runId } } : {}),
    eventAt: input.at,
    eventLabel: 'the kill',
    summary: 'Kill switch engaged: no new mints are admitted.',
  });
}

export function killReleasedCard(): SystemCard {
  return buildSystemCard({
    title: 'KILL SWITCH RELEASED',
    severity: 'attention',
    lines: [
      { label: 'What happened', value: 'the kill switch was released from the command line.', strong: true },
      { label: 'What it means', value: 'live runs are possible again once readiness is recorded.' },
      { label: 'If you did not do this', value: 'engage the kill switch and check the host.', strong: true },
    ],
    steps: [],
    summary: 'Kill switch released from the command line.',
  });
}

const CAP_WHICH: Readonly<Record<string, string>> = {
  SPEND_CAP_EXCEEDED: 'per mint',
  DAILY_SPEND_CAP_EXCEEDED: 'daily, per wallet',
  FLEET_DAILY_CAP_EXCEEDED: 'daily, all wallets',
  FREE_TOTAL_SPEND_CAP_EXCEEDED: 'total for free mints',
  PAID_WALLET_LIMIT_EXCEEDED: 'paid mints, per wallet',
  ROBINHOOD_ACTIVE_PERIOD_CAP_EXCEEDED: 'Robinhood period',
  ROBINHOOD_PER_WALLET_CAP_EXCEEDED: 'Robinhood, per wallet',
  FEE_POLICY_CAP_EXCEEDED: 'network fee',
};

export function spendCapCard(input: { notice?: string; runId?: string; at: Date | string }): SystemCard {
  const code = reasonCode(input.notice);
  const which = code && Object.hasOwn(CAP_WHICH, code) ? CAP_WHICH[code] : undefined;
  return buildSystemCard({
    title: 'SPEND CAP REACHED',
    severity: 'critical',
    lines: [
      { label: 'What happened', value: 'a run was stopped because it would exceed one of your limits.', strong: true },
      ...(which ? [{ label: 'Which limit', value: which, strong: true } as SystemLine] : []),
      { label: 'Why', value: reasonText(code, 'a spending limit was reached') },
      { label: 'What it means', value: 'nothing more is admitted against that limit until it resets or you change it.' },
    ],
    steps: ['Nothing is needed. Limits change only by your own decision.'],
    ...(input.runId ? { code: { label: 'Run', value: input.runId } } : {}),
    eventAt: input.at,
    eventLabel: 'it was blocked',
    summary: 'Spend cap reached: a run was stopped.',
  });
}

/** A run that was blocked or failed (reason code in words). Not sent by any caller today; kept for the alert kinds that exist. */
export function runProblemCard(kind: 'blocked' | 'failed', input: { reason?: string; runId?: string; at: Date | string }): SystemCard {
  const blocked = kind === 'blocked';
  return buildSystemCard({
    title: blocked ? 'RUN BLOCKED' : 'RUN FAILED',
    severity: 'attention',
    lines: [
      { label: 'What happened', value: blocked ? 'a run was blocked before anything was sent.' : 'a run failed.', strong: true },
      { label: 'Why', value: reasonText(reasonCode(input.reason), 'no reason was given') },
      { label: 'What it means', value: blocked ? 'nothing was bought or sent.' : 'check the run before assuming anything was or was not sent.' },
    ],
    steps: ['Open the run on the dashboard and read its result.'],
    ...(input.runId ? { code: { label: 'Run', value: input.runId } } : {}),
    dashboard: true,
    eventAt: input.at,
    eventLabel: blocked ? 'it was blocked' : 'it failed',
    summary: blocked ? 'Run blocked.' : 'Run failed.',
  });
}

export function telegramTestCard(): SystemCard {
  return buildSystemCard({
    title: 'TELEGRAM TEST',
    severity: 'info',
    lines: [{ label: 'Result', value: 'if you can read this, alerts reach you. Nothing was sent or spent.', strong: true }],
    steps: [],
    summary: 'Telegram test.',
  });
}

export interface StartInput {
  mode: string;
  watched: number;
  ownWallets: number;
  /** Number of this start (from the restart counter); 1 is the first ever. */
  startNumber?: number;
  version?: string;
  firstCheckIn?: string;
  chainId?: number;
  at: Date | string;
}

export function startCard(input: StartInput): SystemCard {
  const chain = chainDisplay(input.chainId ?? 1).name;
  const lines: SystemLine[] = [
    { label: 'Mode', value: `${input.mode}. Nothing will be bought or sent.`, strong: true },
    { label: 'Watching', value: `${input.watched} watched ${input.watched === 1 ? 'wallet' : 'wallets'} on ${chain} SeaDrop mints`, strong: true },
    { label: 'Your wallets checked', value: `${input.ownWallets} ${input.ownWallets === 1 ? 'wallet' : 'wallets'} for mint readiness`, strong: true },
    ...(input.startNumber !== undefined ? [{ label: 'Start', value: input.startNumber <= 1 ? 'first start' : `#${input.startNumber}`, strong: input.startNumber > 1 } as SystemLine] : []),
    ...(input.version ? [{ label: 'Version', value: input.version } as SystemLine] : []),
    { label: 'Next', value: `${input.firstCheckIn ?? 'one check-in a day at 09:00 UTC'}. If it stops arriving, the bot has stopped.` },
  ];
  return buildSystemCard({
    title: 'MINTBOT STARTED',
    severity: input.startNumber !== undefined && input.startNumber > 1 ? 'attention' : 'info',
    lines,
    steps: input.startNumber !== undefined && input.startNumber > 1 ? ['If you did not restart it, check the host: something stopped and restarted the bot.'] : [],
    dashboard: true,
    eventAt: input.at,
    eventLabel: 'the start',
    summary: 'MintBot started.',
  });
}

export interface CheckInInput {
  runningSince: Date;
  now: Date;
  opportunities: number;
  upcomingMints: number;
  alerts: number;
  healthWarnings: number;
  lastScanAt: Date | null;
  lastBlock: string | null;
  scanStale: boolean;
  telegramDelivering: boolean;
  failedDeliveries: number;
  latest?: { title: string; name: string; at: Date };
}

const UTC_DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const UTC_MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dateText = (date: Date): string => `${UTC_DAY[date.getUTCDay()]} ${date.getUTCDate()} ${UTC_MONTH[date.getUTCMonth()]} ${date.toISOString().slice(11, 16)} UTC`;

export function checkInCard(input: CheckInInput): SystemCard {
  const upSeconds = (input.now.getTime() - input.runningSince.getTime()) / 1_000;
  const attention = input.scanStale || input.lastScanAt === null || !input.telegramDelivering || input.failedDeliveries > 0 || input.healthWarnings > 0;
  const scan = input.lastScanAt === null
    ? 'no successful scan yet'
    : `last successful scan ${duration((input.now.getTime() - input.lastScanAt.getTime()) / 1_000)} ago${input.lastBlock ? `, block ${Number(input.lastBlock).toLocaleString('en-US')}` : ''}`;
  const lines: SystemLine[] = [
    { label: 'Running since', value: `${dateText(input.runningSince)} (${duration(upSeconds)})` },
    { label: 'Last 24 hours', value: `${input.opportunities} mints scored · ${input.upcomingMints} upcoming mints on the calendar · ${input.alerts} alerts`, strong: true },
    { label: 'Chain scan', value: scan, strong: input.scanStale || input.lastScanAt === null },
    { label: 'Telegram', value: `${input.telegramDelivering ? 'delivering' : 'not delivering'} · failed deliveries in 24 h: ${input.failedDeliveries}`, strong: !input.telegramDelivering || input.failedDeliveries > 0 },
    { label: 'Health warnings', value: input.healthWarnings === 0 ? 'none in 24 h' : `${input.healthWarnings} in 24 h`, strong: input.healthWarnings > 0 },
    ...(input.latest ? [{ label: 'Latest alert', value: `${input.latest.title} · ${input.latest.name}, ${duration((input.now.getTime() - input.latest.at.getTime()) / 1_000)} ago` } as SystemLine] : []),
  ];
  const steps: string[] = [];
  if (input.scanStale || input.lastScanAt === null) steps.push('The bot is not reaching the chain. Check the health warning message, or look at the dashboard.');
  if (input.failedDeliveries > 0) steps.push('Some messages did not reach Telegram; they are retried for 6 hours.');
  return buildSystemCard({
    title: 'DAILY CHECK-IN',
    severity: attention ? 'attention' : 'info',
    lines,
    steps,
    dashboard: true,
    summary: 'Daily check-in.',
  });
}

export type HealthKey = 'scan_stalled' | 'endpoint_errors' | 'disk_pressure' | 'backup_stale' | 'delivery_trouble' | 'pending_exposure';

export interface HealthFacts {
  key: HealthKey;
  severity: 'attention' | 'critical';
  /** Plain words, never raw provider output. */
  facts: SystemLine[];
  meaning: string;
  steps: string[];
  /** When the trouble began (ISO). */
  since: Date | string;
}

const HEALTH_TITLE: Readonly<Record<HealthKey, string>> = {
  scan_stalled: 'CHAIN SCAN STALLED',
  endpoint_errors: 'CHAIN CONNECTION ERRORS',
  disk_pressure: 'DISK SPACE LOW',
  backup_stale: 'BACKUP PROBLEM',
  delivery_trouble: 'TELEGRAM DELIVERY TROUBLE',
  pending_exposure: 'PENDING EXPOSURE NEEDS RECONCILIATION',
};

export function healthCard(input: HealthFacts, extra: { reminder?: number } = {}): SystemCard {
  return buildSystemCard({
    title: HEALTH_TITLE[input.key],
    severity: input.severity,
    lines: [
      ...input.facts,
      { label: 'What it means', value: input.meaning },
      ...(extra.reminder ? [{ label: 'Reminder', value: `still not fixed (reminder ${extra.reminder})`, strong: true } as SystemLine] : []),
    ],
    steps: input.steps,
    dashboard: true,
    eventAt: input.since,
    eventLabel: 'the trouble began',
    summary: `${HEALTH_TITLE[input.key]}.`,
  });
}

export function recoveredCard(key: HealthKey, input: { since: Date; now: Date }): SystemCard {
  return buildSystemCard({
    title: `RECOVERED · ${HEALTH_TITLE[key]}`,
    severity: 'info',
    lines: [
      { label: 'What happened', value: 'the problem is over.', strong: true },
      { label: 'It lasted', value: duration((input.now.getTime() - input.since.getTime()) / 1_000), strong: true },
      { label: 'What it means', value: key === 'pending_exposure' ? 'the stale reservation is resolved and no longer blocks live admission.' : 'nothing is needed. Anything missed while it lasted is picked up on the next scan.' },
    ],
    steps: [],
    summary: `Recovered: ${HEALTH_TITLE[key]}.`,
  });
}

/** The scan was too far behind the chain and jumped ahead; the skipped blocks were not read. */
export function scanSkippedCard(input: { blocks: bigint; fromBlock: string; toBlock: string; at: Date }): SystemCard {
  // Ethereum blocks come every 12 seconds; the scan is Ethereum-only (D-014), so this is the conversion to hours.
  const hours = Number(input.blocks) * 12 / 3600;
  const span = hours >= 1 ? `about ${hours.toFixed(1)} hours` : `about ${Math.max(1, Math.round(hours * 60))} minutes`;
  return buildSystemCard({
    title: 'SCAN JUMPED AHEAD',
    severity: 'attention',
    lines: [
      { label: 'What happened', value: `the chain scan was too far behind (${span} of blocks), so it skipped ahead to recent blocks.`, strong: true },
      { label: 'Skipped', value: `blocks ${Number(input.fromBlock).toLocaleString('en-US')} to ${Number(input.toBlock).toLocaleString('en-US')} were not read.` },
      { label: 'What it means', value: 'mints and wallet activity in that stretch are not in the results. Alerts from now on describe recent blocks again.' },
    ],
    steps: ['Nothing is needed. If this keeps happening, the host is too slow or off for long stretches; see the pause and scan-stalled warnings.'],
    dashboard: true,
    eventAt: input.at,
    eventLabel: 'the jump',
    summary: `Scan jumped ahead by ${span}.`,
  });
}

/** The bot was not running for a while (asleep, stopped or frozen). Sent after the fact, when it is back. */
export function pauseCard(input: { from: Date; to: Date; resumedBlock?: string }): SystemCard {
  const seconds = (input.to.getTime() - input.from.getTime()) / 1_000;
  const clock = (date: Date): string => `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  return buildSystemCard({
    title: 'BOT WAS PAUSED',
    severity: 'attention',
    lines: [
      { label: 'What happened', value: `the bot was not running from ${clock(input.from)} to ${clock(input.to)} (${duration(seconds)}). It is running again now.`, strong: true },
      { label: 'Likely cause', value: 'the computer was asleep or off, or the service was stopped.' },
      { label: 'What it means', value: `nothing was watched during that time. Scanning continues from the last block it checked${input.resumedBlock ? ` (block ${Number(input.resumedBlock).toLocaleString('en-US')})` : ''}, so no mints are skipped, but alerts for that period arrive late.` },
    ],
    steps: ['If this was not planned, keep the computer awake and plugged in, or run the bot on an always-on machine.'],
    dashboard: true,
    eventAt: input.from,
    eventLabel: 'the pause began',
    summary: `Bot was paused for ${duration(seconds)}; running again.`,
  });
}
