import { describe, expect, it } from 'vitest';
import type { Campaign } from '@mint-bot/backend';
import type { FireScheduleRecord } from '@mint-bot/database';
import { assertScheduleWindow, createFireScheduler, parseWhen, runFire, type FireDeps, type MintState, type SchedulerDeps } from './fire.js';

/** T-067 (D-067): the shared fire pipeline and the scheduler. Every refusal stops before anything is recorded or requested. */
const WALLET = '0x1111111111111111111111111111111111111111';
const NOW = new Date('2026-10-25T18:00:00.000Z');
const campaign = { id: 'campaign-1', dryRun: false } as unknown as Campaign;

function pipeline(overrides: Partial<FireDeps> = {}) {
  const calls: string[] = [];
  const deps: FireDeps = {
    now: () => NOW,
    killSwitchOn: () => false,
    campaign: (id) => (id === 'campaign-1' ? campaign : undefined),
    conflict: () => undefined,
    recordSimulations: async (_c, wallets) => { calls.push('record'); return { recorded: [...wallets], skipped: [] }; },
    createRequest: async () => { calls.push('request'); return { requestId: 'live_request_1' }; },
    kick: () => { calls.push('kick'); },
    ...overrides,
  };
  return { deps, calls };
}
const input = { campaignId: 'campaign-1', wallets: [WALLET], maxFeeGwei: 0.2 };

describe('the fire pipeline', () => {
  it('records the passing test mints, creates the request and nudges the processor, in that order', async () => {
    const { deps, calls } = pipeline();
    expect(await runFire(deps, input)).toEqual({ requestId: 'live_request_1', wallets: [WALLET], skipped: [] });
    expect(calls).toEqual(['record', 'request', 'kick']);
  });

  it('asks for the request with only the wallets that passed', async () => {
    let asked: readonly string[] = [];
    const { deps } = pipeline({ recordSimulations: async () => ({ recorded: [WALLET], skipped: [{ wallet: '0x2', why: 'it needs ETH' }] }), createRequest: async (_c, wallets) => { asked = wallets; return { requestId: 'r' }; } });
    const result = await runFire(deps, { ...input, wallets: [WALLET, '0x2'] });
    expect(asked).toEqual([WALLET]);
    expect(result.skipped).toHaveLength(1);
  });

  it('refuses, fail closed and before recording anything, for a bad fee, an unknown or dry-run campaign, the kill switch, a conflict', async () => {
    const cases: Array<[Partial<FireDeps>, Partial<typeof input>, RegExp]> = [
      [{}, { maxFeeGwei: 0 }, /MAX_FEE_GWEI_INVALID/],
      [{}, { maxFeeGwei: 501 }, /MAX_FEE_GWEI_INVALID/],
      [{}, { maxFeeGwei: Number.NaN }, /MAX_FEE_GWEI_INVALID/],
      [{}, { campaignId: 'nope' }, /CAMPAIGN_NOT_FOUND/],
      [{ campaign: () => ({ ...campaign, dryRun: true }) as Campaign }, {}, /LIVE_REQUIRES_NON_DRY_CAMPAIGN/],
      [{ killSwitchOn: () => true }, {}, /KILL_SWITCH_ON/],
      [{ conflict: () => 'a scheduled mint is open' }, {}, /FIRE_CONFLICT/],
    ];
    for (const [overrides, changes, expected] of cases) {
      const { deps, calls } = pipeline(overrides);
      await expect(runFire(deps, { ...input, ...changes })).rejects.toThrow(expected);
      expect(calls).toEqual([]);
    }
  });

  it('stops without a request or a nudge when no wallet passes or the test mints cannot be recorded', async () => {
    const none = pipeline({ recordSimulations: async () => ({ recorded: [], skipped: [{ wallet: WALLET, why: 'x' }] }) });
    await expect(runFire(none.deps, input)).rejects.toThrow(/SIMULATION_NOT_PASSED/);
    expect(none.calls).toEqual([]);
    const closed = pipeline({ recordSimulations: async () => { throw new Error('MINT_NOT_OPEN: the mint is upcoming'); } });
    await expect(runFire(closed.deps, input)).rejects.toThrow(/MINT_NOT_OPEN/);
    expect(closed.calls).toEqual([]);
  });
});

describe('typed times and windows', () => {
  it('reads now, +90m, +2h and a UTC date-time, and nothing else', () => {
    expect(parseWhen('now', NOW)?.toISOString()).toBe(NOW.toISOString());
    expect(parseWhen('+90m', NOW)?.toISOString()).toBe('2026-10-25T19:30:00.000Z');
    expect(parseWhen('+2H', NOW)?.toISOString()).toBe('2026-10-25T20:00:00.000Z');
    expect(parseWhen('2026-10-26T09:30', NOW)?.toISOString()).toBe('2026-10-26T09:30:00.000Z');
    for (const bad of ['soon', '', '+5', '+5d', '2026-13-01T10:00', '2026-02-31T10:00', '25/10/2026 18:00', '+99999m']) expect(parseWhen(bad, NOW), bad).toBeUndefined();
  });

  it('refuses windows in the past, reversed, over 6 hours, or more than 7 days away', () => {
    const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);
    const hour = 3_600_000;
    expect(() => assertScheduleWindow(at(0), at(2 * hour), NOW)).not.toThrow();
    expect(() => assertScheduleWindow(at(-2 * hour), at(-hour), NOW)).toThrow(/WINDOW_IN_THE_PAST/);
    expect(() => assertScheduleWindow(at(2 * hour), at(hour), NOW)).toThrow(/WINDOW_ORDER_INVALID/);
    expect(() => assertScheduleWindow(at(0), at(6 * hour + 1), NOW)).toThrow(/WINDOW_TOO_LONG/);
    expect(() => assertScheduleWindow(at(8 * 24 * hour), at(8 * 24 * hour + hour), NOW)).toThrow(/WINDOW_TOO_FAR/);
  });
});

function schedulerSetup(overrides: Partial<SchedulerDeps> = {}, scheduleOverrides: Partial<FireScheduleRecord> = {}) {
  let clock = NOW.getTime();
  let state: MintState = 'upcoming';
  let kill = false;
  const claimed = new Map<string, string>();
  const events: string[] = [];
  const alerts: string[] = [];
  const schedule: FireScheduleRecord = { id: 'fire_schedule_abc123', campaignId: 'campaign-1', campaignDigest: 'd'.repeat(64), wallets: [WALLET], maxFeeGwei: '0.2', windowFrom: '2026-10-25T17:00:00.000Z', windowUntil: '2026-10-25T20:00:00.000Z', confirmationDigest: 'c'.repeat(64), createdAt: '2026-10-25T10:00:00.000Z', ...scheduleOverrides };
  const deps: SchedulerDeps = {
    schedules: () => [schedule].filter((item) => !claimed.has(item.id)),
    claim: (id, outcome) => { if (claimed.has(id)) return false; claimed.set(id, outcome); return true; },
    campaign: () => campaign,
    campaignDigest: () => 'd'.repeat(64),
    killSwitchOn: () => kill,
    mintState: async () => state,
    fire: async () => { events.push('fire'); },
    record: async (event) => { events.push(`${event.state}${event.code ? `:${event.code}` : ''}`); },
    alert: async (text) => { alerts.push(text); },
    now: () => new Date(clock),
    ...overrides,
  };
  return { scheduler: createFireScheduler(deps), claimed, events, alerts, setState: (value: MintState) => { state = value; }, setKill: (value: boolean) => { kill = value; }, setClock: (iso: string) => { clock = Date.parse(iso); } };
}

describe('the scheduler', () => {
  it('waits while the mint is not open, then claims first and fires once when it opens', async () => {
    const t = schedulerSetup();
    expect(await t.scheduler.tick()).toBe(0);
    expect(t.claimed.size).toBe(0);
    t.setState('open');
    expect(await t.scheduler.tick()).toBe(1);
    expect(t.claimed.get('fire_schedule_abc123')).toBe('started');
    expect(await t.scheduler.tick()).toBe(0);
    expect(t.events).toEqual(['fire', 'fired']);
  });

  it('does nothing before the window starts', async () => {
    const t = schedulerSetup({}, { windowFrom: '2026-10-25T19:00:00.000Z' });
    t.setState('open');
    expect(await t.scheduler.tick()).toBe(0);
    expect(t.claimed.size).toBe(0);
  });

  it('expires when the window ends, the campaign changed, or the mint is over, each told to the owner once', async () => {
    const late = schedulerSetup();
    late.setClock('2026-10-25T20:00:01.000Z');
    late.setState('open');
    await late.scheduler.tick();
    expect(late.claimed.get('fire_schedule_abc123')).toBe('expired');
    expect(late.events).toEqual(['expired:SCHEDULE_WINDOW_ENDED']);
    expect(late.alerts).toHaveLength(1);

    const changed = schedulerSetup({ campaignDigest: () => 'e'.repeat(64) });
    changed.setState('open');
    await changed.scheduler.tick();
    expect(changed.events).toEqual(['expired:CAMPAIGN_CHANGED']);

    const gone = schedulerSetup({ campaign: () => undefined });
    await gone.scheduler.tick();
    expect(gone.events).toEqual(['expired:CAMPAIGN_CHANGED']);

    const over = schedulerSetup();
    over.setState('ended');
    await over.scheduler.tick();
    expect(over.events).toEqual(['expired:MINT_ENDED']);
  });

  it('never releases or overrides the kill switch: it waits, tells the owner once, and fires only after the owner releases it', async () => {
    const t = schedulerSetup();
    t.setState('open');
    t.setKill(true);
    await t.scheduler.tick();
    await t.scheduler.tick();
    expect(t.claimed.size).toBe(0);
    expect(t.alerts).toHaveLength(1);
    expect(t.events.every((event) => event === 'waiting:KILL_SWITCH_ON')).toBe(true);
    t.setKill(false);
    await t.scheduler.tick();
    expect(t.events.at(-1)).toBe('fired');
  });

  it('an unreadable mint state is waited out; a failing fire is claimed, recorded with a fixed code, told once, and never retried', async () => {
    const unreadable = schedulerSetup({ mintState: async () => { throw new Error('https://secret.example/rpc failed'); } });
    await unreadable.scheduler.tick();
    expect(unreadable.claimed.size).toBe(0);

    const failing = schedulerSetup({ fire: async () => { throw new Error('SIMULATION_NOT_PASSED: no wallet passed https://x.example'); } });
    failing.setState('open');
    await failing.scheduler.tick();
    await failing.scheduler.tick();
    expect(failing.events).toEqual(['failed:SIMULATION_NOT_PASSED']);
    expect(failing.alerts).toHaveLength(1);
    expect(failing.alerts[0]).not.toContain('example');

    const odd = schedulerSetup({ fire: async () => { throw new Error('boom with words'); } });
    odd.setState('open');
    await odd.scheduler.tick();
    expect(odd.events).toEqual(['failed:SCHEDULED_FIRE_FAILED']);
  });

  it('a second scheduler over the same store (a restart) cannot fire a claimed schedule again', async () => {
    const t = schedulerSetup();
    t.setState('open');
    await t.scheduler.tick();
    expect(t.events.filter((event) => event === 'fire')).toHaveLength(1);
    t.claimed.set('fire_schedule_abc123', 'started');
    await t.scheduler.tick();
    expect(t.events.filter((event) => event === 'fire')).toHaveLength(1);
  });
});
