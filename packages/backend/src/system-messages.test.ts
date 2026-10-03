import { describe, expect, it } from 'vitest';
import { renderSystemCard, type SystemCard } from './system-card.js';
import { checkInCard, healthCard, killEngagedCard, killReleasedCard, reasonCode, reasonText, recoveredCard, runProblemCard, spendCapCard, startCard, telegramTestCard } from './system-messages.js';

const NOW = new Date('2026-10-03T14:03:22.000Z');
const render = (card: SystemCard, dashboardUrl = 'http://127.0.0.1:8780/') => renderSystemCard(card, { now: NOW, dashboardUrl });
const at = new Date(NOW.getTime() - 2_000);

describe('system messages (T-030)', () => {
  it('turns a reason code into words with the code kept for support, and never copies free text from a notice', () => {
    expect(reasonCode('run_1: DAILY_SPEND_CAP_EXCEEDED by 3')).toBe('DAILY_SPEND_CAP_EXCEEDED');
    expect(reasonText('SPEND_CAP_EXCEEDED', 'x')).toBe('it would exceed your per-mint limit [SPEND_CAP_EXCEEDED]');
    expect(reasonText('SOME_NEW_CODE', 'a limit was reached')).toBe('a limit was reached [SOME_NEW_CODE]');
    expect(reasonText(undefined, 'a limit was reached')).toBe('a limit was reached');
    expect(reasonText('__proto__', 'fallback')).toBe('fallback [__proto__]');
    const hostile = render(spendCapCard({ notice: 'wallet 0xabc1230000000000000000000000000000000000 at https://user:pw@node.example/v2/KEY gave up', runId: 'run_1', at })).plain;
    expect(hostile).not.toContain('node.example');
    expect(hostile).not.toContain('pw@');
    expect(hostile).not.toContain('0xabc123');
  });

  it('kill switch engaged: critical, what it means, what to do, run, and the seconds after the kill', () => {
    const { html } = render(killEngagedCard({ reason: 'KILL_SWITCH_ENGAGED', runId: 'run_1', at }));
    expect(html).toContain('<b>KILL SWITCH ENGAGED</b> · CRITICAL');
    expect(html).toContain('<b>the kill switch was engaged [KILL_SWITCH_ENGAGED]</b>');
    expect(html).toContain('no new mints are admitted. Anything already submitted still has to be checked.');
    expect(html).toContain('<b>Run:</b> <code>run_1</code>');
    expect(html).toContain('Sent 14:03:22 UTC, 2 s after the kill');
  });

  it('spend cap: names the limit in words and the run, and says limits change only by the owner', () => {
    const { html } = render(spendCapCard({ notice: 'DAILY_SPEND_CAP_EXCEEDED', runId: 'run_9', at }));
    expect(html).toContain('<b>Which limit:</b> <b>daily, per wallet</b>');
    expect(html).toContain('it would exceed your daily limit for one wallet [DAILY_SPEND_CAP_EXCEEDED]');
    expect(html).toContain('Limits change only by your own decision.');
    expect(render(spendCapCard({ at })).html).toContain('a spending limit was reached');
  });

  it('kill switch released: attention, and tells the owner what to do if they did not do it', () => {
    const { html } = render(killReleasedCard());
    expect(html).toContain('KILL SWITCH RELEASED</b> · ATTENTION');
    expect(html).toContain('<b>If you did not do this:</b> <b>engage the kill switch and check the host.</b>');
  });

  it('blocked and failed run alerts say whether anything was sent', () => {
    expect(render(runProblemCard('blocked', { reason: 'PRICE_ABOVE_LIMIT', runId: 'r', at })).html).toContain('nothing was bought or sent.');
    expect(render(runProblemCard('failed', { runId: 'r', at })).html).toContain('check the run before assuming anything was or was not sent.');
  });

  it('telegram test: info, and says nothing was sent or spent', () => {
    expect(render(telegramTestCard()).html).toContain('<b>TELEGRAM TEST</b> · INFO');
    expect(render(telegramTestCard()).html).toContain('Nothing was sent or spent.');
  });

  it('start message: mode, watching, wallets, first-start vs restart, version, dashboard, and what to expect', () => {
    const first = render(startCard({ mode: 'read-only', watched: 90, ownWallets: 4, startNumber: 1, version: 'a1b2c3d4', at: NOW })).html;
    expect(first).toContain('<b>MINTBOT STARTED</b> · INFO');
    expect(first).toContain('<b>Mode:</b> <b>read-only. Nothing will be bought or sent.</b>');
    expect(first).toContain('<b>Watching:</b> <b>90 watched wallets on ETHEREUM SeaDrop mints</b>');
    expect(first).toContain('<b>Your wallets checked:</b> <b>4 wallets for mint readiness</b>');
    expect(first).toContain('<b>Start:</b> first start');
    expect(render(startCard({ mode: 'read-only', watched: 1, ownWallets: 1, at: NOW })).html).toContain('1 watched wallet on ETHEREUM');
    expect(first).toContain('<b>Version:</b> a1b2c3d4');
    expect(first).toContain('(opens on this laptop only)');
    expect(first).toContain('If it stops arriving, the bot has stopped.');
    expect(first).not.toContain('What to do');
    const again = render(startCard({ mode: 'read-only', watched: 90, ownWallets: 4, startNumber: 3, at: NOW })).html;
    expect(again).toContain('MINTBOT STARTED</b> · ATTENTION');
    expect(again).toContain('<b>Start:</b> <b>#3</b>');
    expect(again).toContain('If you did not restart it, check the host');
  });

  const checkIn = (overrides: Partial<Parameters<typeof checkInCard>[0]> = {}) => checkInCard({
    runningSince: new Date('2026-10-01T11:02:00.000Z'), now: NOW, opportunities: 12, upcomingMints: 3, alerts: 5, healthWarnings: 0,
    lastScanAt: new Date(NOW.getTime() - 120_000), lastBlock: '24631002', scanStale: false, telegramDelivering: true, failedDeliveries: 0,
    latest: { title: 'WORTH A LOOK', name: 'Pudgy Example', at: new Date(NOW.getTime() - 2 * 3_600_000) }, ...overrides,
  });

  it('daily check-in: uptime, counts, last good scan with its block, delivery state and the latest alert', () => {
    const { html } = render(checkIn());
    expect(html).toContain('<b>DAILY CHECK-IN</b> · INFO');
    expect(html).toContain('<b>Running since:</b> Thu 1 Oct 11:02 UTC (2 days 3 h)');
    expect(html).toContain('<b>Last 24 hours:</b> <b>12 mints scored · 3 upcoming mints on the calendar · 5 alerts</b>');
    expect(html).toContain('<b>Chain scan:</b> last successful scan 2 min ago, block 24,631,002');
    expect(html).toContain('<b>Telegram:</b> delivering · failed deliveries in 24 h: 0');
    expect(html).toContain('<b>Health warnings:</b> none in 24 h');
    expect(html).toContain('<b>Latest alert:</b> WORTH A LOOK · Pudgy Example, 2 h 0 min ago');
    expect(html).not.toContain('What to do');
  });

  it('daily check-in turns to ATTENTION with steps when scanning is stale, never worked, or Telegram is failing', () => {
    const stale = render(checkIn({ scanStale: true, lastScanAt: new Date(NOW.getTime() - 3 * 3_600_000) })).html;
    expect(stale).toContain('DAILY CHECK-IN</b> · ATTENTION');
    expect(stale).toContain('<b>last successful scan 3 h 0 min ago, block 24,631,002</b>');
    expect(stale).toContain('The bot is not reaching the chain.');
    const never = render(checkIn({ lastScanAt: null, lastBlock: null, scanStale: true })).html;
    expect(never).toContain('<b>no successful scan yet</b>');
    const telegram = render(checkIn({ telegramDelivering: false, failedDeliveries: 2 })).html;
    expect(telegram).toContain('<b>not delivering · failed deliveries in 24 h: 2</b>');
    expect(telegram).toContain('retried for 6 hours');
    expect(render(checkIn({ healthWarnings: 1 })).html).toContain('ATTENTION');
  });

  it('health warning: facts, meaning, steps, the reminder number and the delay since it began', () => {
    const card = healthCard({ key: 'disk_pressure', severity: 'critical', facts: [{ label: 'What happened', value: 'only 0.3 GB of disk space is free (4%).', strong: true }], meaning: 'the bot may stop.', steps: ['Free up space.'], since: at }, { reminder: 2 });
    const { html } = render(card);
    expect(html).toContain('<b>DISK SPACE LOW</b> · CRITICAL');
    expect(html).toContain('<b>Reminder:</b> <b>still not fixed (reminder 2)</b>');
    expect(html).toContain('1. Free up space.');
    expect(html).toContain('Sent 14:03:22 UTC, 2 s after the trouble began');
  });

  it('recovered message: info, with how long it lasted', () => {
    const { html } = render(recoveredCard('scan_stalled', { since: new Date(NOW.getTime() - 47 * 60_000), now: NOW }));
    expect(html).toContain('<b>RECOVERED · CHAIN SCAN STALLED</b> · INFO');
    expect(html).toContain('<b>It lasted:</b> <b>47 min</b>');
  });
});
