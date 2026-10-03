import { describe, expect, it } from 'vitest';
import { HealthMonitor, scanCauseWords, type HealthSample } from './health-monitor.js';
import { renderSystemCard } from './system-card.js';
import type { IntelligenceAlertInput } from './alerts.js';

const START = new Date('2026-10-03T08:00:00.000Z');
const minutes = (count: number): Date => new Date(START.getTime() + count * 60_000);
const hours = (count: number): Date => minutes(count * 60);

function setup(options: { failDelivery?: boolean } = {}) {
  const sent: IntelligenceAlertInput[] = [];
  const errors: unknown[] = [];
  const alerts = { intelligence: async (input: IntelligenceAlertInput): Promise<boolean> => { sent.push(input); if (options.failDelivery) throw new Error('TELEGRAM_DELIVERY_FAILED:500'); return true; } };
  const monitor = new HealthMonitor(alerts, { onError: (error) => errors.push(error) });
  const sample = (now: Date, overrides: Partial<HealthSample> = {}): HealthSample => ({
    now, scan: { startedAt: START, lastOkAt: new Date(now.getTime() - 60_000), lastOkBlock: '24631002' }, endpoint: { total: 12, failed: 0 }, delivery: { failed: 0 }, ...overrides,
  });
  const html = (index: number): string => renderSystemCard(sent[index]!.system!, { now: START }).html;
  return { sent, errors, monitor, sample, html };
}

describe('health monitor (T-030)', () => {
  it('stays silent for a healthy bot, including when disk and backup are not known (missing facts are not the worst case)', async () => {
    const { monitor, sample, sent } = setup();
    expect(await monitor.check(sample(minutes(5)))).toEqual([]);
    expect(await monitor.check(sample(minutes(10), { disk: { freeBytes: 50 * 1024 ** 3, totalBytes: 200 * 1024 ** 3 }, backup: { status: 'ok', recordedAt: hours(-1) } }))).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('warns once when scanning stalls, with the last good scan and a cause in words, and does not repeat', async () => {
    const { monitor, sample, sent, html } = setup();
    const stalled = (now: Date) => sample(now, { scan: { startedAt: START, lastOkAt: minutes(0), lastOkBlock: '24631002', lastProblem: 'RATE_LIMITED' } });
    expect(await monitor.check(stalled(minutes(14)))).toEqual([]);
    expect(await monitor.check(stalled(minutes(16)))).toEqual(['scan_stalled:open']);
    expect(await monitor.check(stalled(minutes(30)))).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'health', priority: 'immediate' });
    expect(html(0)).toContain('<b>CHAIN SCAN STALLED</b> · ATTENTION');
    expect(html(0)).toContain('<b>no successful chain scan for 16 min.</b>');
    expect(html(0)).toContain('<b>Last good scan:</b> <b>08:00 UTC, block 24,631,002</b>');
    expect(html(0)).toContain('the chain provider is limiting requests');
    expect(html(0)).toContain('Check that the chain provider is up');
    expect(sent[0]!.text).toContain('CHAIN SCAN STALLED');
  });

  it('escalates to CRITICAL once after an hour, then sends a reminder every six hours, then a recovered message with the duration', async () => {
    const { monitor, sample, sent, html } = setup();
    const stalled = (now: Date) => sample(now, { scan: { startedAt: START, lastOkAt: minutes(0) } });
    await monitor.check(stalled(minutes(20)));
    expect(await monitor.check(stalled(minutes(61)))).toEqual(['scan_stalled:critical']);
    expect(await monitor.check(stalled(minutes(120)))).toEqual([]);
    expect(await monitor.check(stalled(minutes(61 + 6 * 60)))).toEqual(['scan_stalled:reminder1']);
    expect(html(2)).toContain('<b>still not fixed (reminder 1)</b>');
    // The delay counts from when the trouble began, not from the latest sample.
    expect(renderSystemCard(sent[2]!.system!, { now: minutes(61 + 6 * 60) }).html).toContain('Sent 15:01:00 UTC, 25260 s (421 min) after the trouble began');
    expect(await monitor.check(stalled(minutes(61 + 11 * 60)))).toEqual([]);
    const back = await monitor.check(sample(minutes(12 * 60)));
    expect(back).toEqual(['scan_stalled:recovered']);
    expect(html(3)).toContain('RECOVERED · CHAIN SCAN STALLED</b> · INFO');
    expect(html(3)).toContain('<b>It lasted:</b> <b>12 h 0 min</b>');
    expect(new Set(sent.map((entry) => entry.dedupe)).size).toBe(4);
    expect(await monitor.check(sample(minutes(13 * 60)))).toEqual([]);
  });

  it('counts the time since the bot started when no scan has ever worked, and says so', async () => {
    const { monitor, sample, html } = setup();
    await monitor.check(sample(minutes(20), { scan: { startedAt: START, lastProblem: 'HEAD_UNAVAILABLE' } }));
    expect(html(0)).toContain('<b>Last good scan:</b> <b>none since the bot started</b>');
    expect(html(0)).toContain('the chain provider is not answering');
  });

  it('never shows raw provider text: only fixed words for the failure class', () => {
    expect(scanCauseWords('RATE_LIMITED: https://user:pw@node.example/v2/SECRETKEY')).toContain('limiting requests');
    expect(scanCauseWords('HTTP 500 at https://node.example/v2/SECRETKEY')).not.toContain('SECRETKEY');
    expect(scanCauseWords(undefined)).toBe('not known yet');
  });

  it('warns about connection errors only with enough attempts, and clears only when the failures fall well below the trigger', async () => {
    const { monitor, sample, html } = setup();
    expect(await monitor.check(sample(minutes(1), { endpoint: { total: 4, failed: 4 } }))).toEqual([]);
    expect(await monitor.check(sample(minutes(2), { endpoint: { total: 12, failed: 3 } }))).toEqual(['endpoint_errors:open']);
    expect(html(0)).toContain('3 of 12 chain scans failed in the last hour (25%).');
    expect(await monitor.check(sample(minutes(3), { endpoint: { total: 12, failed: 2 } }))).toEqual([]);
    expect(await monitor.check(sample(minutes(4), { endpoint: { total: 12, failed: 1 } }))).toEqual(['endpoint_errors:recovered']);
  });

  it('warns critically about low disk space with the numbers in plain units', async () => {
    const { monitor, sample, html } = setup();
    expect(await monitor.check(sample(minutes(1), { disk: { freeBytes: 300 * 1024 ** 2, totalBytes: 100 * 1024 ** 3 } }))).toEqual(['disk_pressure:critical']);
    expect(html(0)).toContain('<b>DISK SPACE LOW</b> · CRITICAL');
    expect(html(0)).toContain('only 0.3 GB of disk space is free (0%)');
  });

  it('warns about a failed or stale backup only when a backup exists, and never mentions the path', async () => {
    const { monitor, sample, html, sent } = setup();
    expect(await monitor.check(sample(minutes(1)))).toEqual([]);
    expect(await monitor.check(sample(minutes(2), { backup: { status: 'failed', recordedAt: minutes(-30) } }))).toEqual(['backup_stale:critical']);
    expect(html(0)).toContain('<b>the last backup failed.</b>');
    expect(await monitor.check(sample(minutes(3), { backup: { status: 'ok', recordedAt: minutes(3) } }))).toEqual(['backup_stale:recovered']);
    expect(await monitor.check(sample(hours(40), { backup: { status: 'ok', recordedAt: minutes(0) }, scan: { startedAt: START, lastOkAt: hours(40) } }))).toEqual(['backup_stale:critical']);
    expect(html(2)).toContain('older than 36 h');
    expect(JSON.stringify(sent)).not.toMatch(/status\.json|\/home\//);
  });

  it('warns about undelivered messages, and says they arrive late', async () => {
    const { monitor, sample, html } = setup();
    expect(await monitor.check(sample(minutes(30), { delivery: { failed: 2, oldestFailedAt: minutes(10) } }))).toEqual(['delivery_trouble:open']);
    expect(html(0)).toContain('2 messages did not reach Telegram, the oldest 20 min ago.');
    expect(html(0)).toContain('they can arrive late');
    expect(await monitor.check(sample(minutes(40)))).toEqual(['delivery_trouble:recovered']);
  });

  it('keeps going, and still counts the warning as raised, when Telegram cannot deliver it (the outbox retries)', async () => {
    const { monitor, sample, errors, sent } = setup({ failDelivery: true });
    await expect(monitor.check(sample(minutes(20), { scan: { startedAt: START, lastOkAt: minutes(0) } }))).resolves.toEqual(['scan_stalled:open']);
    expect(errors).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(monitor.openKeys()).toEqual(['scan_stalled']);
  });

  it('runs several troubles side by side, each with its own episode', async () => {
    const { monitor, sample } = setup();
    const both = await monitor.check(sample(minutes(20), { scan: { startedAt: START, lastOkAt: minutes(0) }, disk: { freeBytes: 1024, totalBytes: 1024 ** 3 } }));
    expect(both.sort()).toEqual(['disk_pressure:critical', 'scan_stalled:open']);
    expect(monitor.openKeys().sort()).toEqual(['disk_pressure', 'scan_stalled']);
  });
});

describe('health reminders keep the true start of the trouble (T-030 review)', () => {
  it('a disk or connection reminder counts from when the trouble began, not from the newest sample', async () => {
    const sent: IntelligenceAlertInput[] = [];
    const monitor = new HealthMonitor({ intelligence: async (input) => { sent.push(input); return true; } });
    const sample = (now: Date): HealthSample => ({ now, scan: { startedAt: START, lastOkAt: new Date(now.getTime() - 60_000) }, endpoint: { total: 12, failed: 0 }, delivery: { failed: 0 }, disk: { freeBytes: 1024, totalBytes: 1024 ** 3 } });
    await monitor.check(sample(minutes(0)));
    await monitor.check(sample(hours(6)));
    expect(sent).toHaveLength(2);
    expect(renderSystemCard(sent[1]!.system!, { now: hours(6) }).html).toContain('Sent 14:00:00 UTC, 21600 s (360 min) after the trouble began');
  });
});
