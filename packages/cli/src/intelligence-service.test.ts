import { afterEach, describe, expect, it, vi } from 'vitest';
import { AlertManager, DurableStore, plainSystemText, type ChainScanOutcome, type DropSnapshot, type IntelligenceChainPort, type IntelligenceRepositoryPort, type SimulationOutcome } from '@mint-bot/backend';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeHeartbeat } from './heartbeat.js';
import { startIntelligence } from './intelligence-service.js';
import { checkInCounts, checkInMessage, startMessage } from './status-messages.js';

const OWN = ['0x365952eb1e8209bf2bcc2db5ed213111a87d061e', '0x81c104dcb898416fd4f81ead091dba5b8f46f37a'];

class IdlePort implements IntelligenceChainPort {
  public readonly chainId = 1 as const;
  public async safeHead(): Promise<bigint | null> { return null; }
  public async scan(): Promise<ChainScanOutcome> { return { ok: false, reason: 'unused' }; }
  public async readDrop(): Promise<DropSnapshot | null> { return null; }
  public async hasCode(): Promise<boolean | null> { return null; }
  public async balance(): Promise<bigint | null> { return null; }
  public async simulateMint(): Promise<SimulationOutcome> { return { outcome: 'unknown', reason: 'unused' }; }
}

class Repo implements IntelligenceRepositoryPort {
  public constructor(private readonly count: number, private readonly last?: bigint) {}
  public observedAddresses() { return Array.from({ length: this.count }, (_, index) => ({ address: `0x${index.toString(16).padStart(40, '0')}` })); }
  public cursor() { return this.last; }
  public advanceCursor(): void { /* unused */ }
}

function harness(now: () => Date, repo = new Repo(90, 21_000_000n)) {
  const store = new DurableStore();
  const sent: string[] = [];
  const dispatcher = { dispatch: async (_id: string, text?: string) => { sent.push(text ?? ''); } };
  const alerts = new AlertManager(store, dispatcher as never, undefined, { now });
  return { store, sent, alerts, repo };
}

afterEach(() => { vi.useRealTimers(); });

describe('trial status messages (T-005)', () => {
  it('sends one plain-language start message with counts and the dashboard, and no owner addresses', async () => {
    const now = () => new Date('2026-09-30T08:00:00.000Z');
    const h = harness(now);
    const service = startIntelligence({ store: h.store, repo: h.repo, port: new IdlePort(), alerts: h.alerts, wallets: OWN, discoveryIntervalMs: 3_600_000, readinessIntervalMs: 3_600_000, digestIntervalMs: 3_600_000, startNumber: 1, version: 'a1b2c3d4', now });
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    service.stop();
    expect(h.sent[0]).toBe(plainSystemText(startMessage({ watched: 90, ownWallets: 2, startedAt: now(), startNumber: 1, version: 'a1b2c3d4' })));
    expect(h.sent[0]).toContain('MINTBOT STARTED · INFO');
    expect(h.sent[0]).toContain('Watching: 90 watched wallets on ETHEREUM SeaDrop mints');
    expect(h.sent[0]).toContain('Your wallets checked: 2 wallets for mint readiness');
    expect(h.sent[0]).toContain('Version: a1b2c3d4');
    expect(h.sent[0]).not.toMatch(/0x[0-9a-f]{40}/i);
    expect(h.store.snapshot().events.filter((event) => event.type === 'alert_status')).toHaveLength(1);
  });

  it('sends the daily check-in once per UTC day, only after 09:00 UTC and at least an hour after start', async () => {
    let clock = new Date('2026-09-30T08:30:00.000Z').getTime();
    const now = () => new Date(clock);
    const h = harness(now);
    const service = startIntelligence({ store: h.store, repo: h.repo, port: new IdlePort(), alerts: h.alerts, wallets: OWN, discoveryIntervalMs: 3_600_000, readinessIntervalMs: 3_600_000, digestIntervalMs: 3_600_000, now });
    const checkIns = () => h.sent.filter((text) => text.includes('DAILY CHECK-IN'));
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    await service.runOnce();
    expect(h.sent).toHaveLength(1);
    clock += 60 * 60_000;
    await service.runOnce();
    await service.runOnce();
    expect(checkIns()).toHaveLength(1);
    // No scan has worked in this test (the port never answers), so the check-in says so and asks for attention.
    expect(checkIns()[0]).toContain('DAILY CHECK-IN · ATTENTION');
    expect(checkIns()[0]).toContain('Chain scan: no successful scan yet');
    clock += 24 * 60 * 60_000;
    await service.runOnce();
    expect(checkIns()).toHaveLength(2);
    service.stop();
  });

  // The three health events below are one trouble that opened, escalated and recovered: one health warning, not three.
  it('counts the last 24 hours of scored mints, upcoming calendar entries and alerts', async () => {
    const at = new Date('2026-09-30T12:00:00.000Z');
    const store = new DurableStore();
    await store.transaction((state) => {
      state.events.push(
        { id: 'o1', type: 'opportunity_scored', at: '2026-09-30T10:00:00.000Z', data: { opportunityId: 'a' } },
        { id: 'o2', type: 'opportunity_notified', at: '2026-09-30T11:00:00.000Z', data: { opportunityId: 'a' } },
        { id: 'o3', type: 'opportunity_scored', at: '2026-09-28T11:00:00.000Z', data: { opportunityId: 'old' } },
        { id: 'c1', type: 'calendar_entry', at: '2026-09-30T11:00:00.000Z', data: { id: 'cal', openingAt: '2026-10-01T00:00:00.000Z' } },
        { id: 'c2', type: 'calendar_entry', at: '2026-09-30T11:00:00.000Z', data: { id: 'past', openingAt: '2026-09-29T00:00:00.000Z' } },
        { id: 'a1', type: 'alert_opportunity', at: '2026-09-30T11:00:00.000Z', data: {} },
        { id: 'a2', type: 'alert_digest', at: '2026-09-30T11:00:00.000Z', data: {} },
        { id: 'a3', type: 'alert_status', at: '2026-09-30T11:00:00.000Z', data: {} },
        { id: 'h1', type: 'alert_health', at: '2026-09-30T11:00:00.000Z', data: { dedupe: 'health:scan_stalled:2026-09-30T11:00:00.000Z:open' } },
        { id: 'h2', type: 'alert_health', at: '2026-09-30T11:30:00.000Z', data: { dedupe: 'health:scan_stalled:2026-09-30T11:00:00.000Z:critical' } },
        { id: 'h3', type: 'alert_health', at: '2026-09-30T11:40:00.000Z', data: { dedupe: 'health:scan_stalled:2026-09-30T11:00:00.000Z:recovered' } },
      );
    });
    const counts = checkInCounts(store, new Repo(1), at);
    expect(counts).toEqual({ opportunities: 1, upcomingMints: 1, alerts: 1, healthWarnings: 1, lastBlock: null, failedDeliveries: 0, pendingFailures: 0 });
    expect(plainSystemText(checkInMessage(counts, { runningSince: new Date('2026-09-29T00:00:00.000Z'), now: at, lastScanAt: null, scanStale: true }))).toContain('Chain scan: no successful scan yet');
  });

  it('keeps running when a status message cannot be delivered', async () => {
    const now = () => new Date('2026-09-30T10:00:00.000Z');
    const store = new DurableStore();
    const alerts = new AlertManager(store, { dispatch: async () => { throw new Error('telegram down'); } } as never, undefined, { now });
    const service = startIntelligence({ store, repo: new Repo(1), port: new IdlePort(), alerts, wallets: OWN, discoveryIntervalMs: 3_600_000, readinessIntervalMs: 3_600_000, digestIntervalMs: 3_600_000, now });
    await expect(service.runOnce()).resolves.toBeUndefined();
    service.stop();
  });
});

describe('pause notice', () => {
  const options = (h: ReturnType<typeof harness>, now: () => Date, heartbeatPath?: string) => ({ store: h.store, repo: h.repo, port: new IdlePort(), alerts: h.alerts, wallets: OWN, discoveryIntervalMs: 3_600_000, readinessIntervalMs: 3_600_000, digestIntervalMs: 3_600_000, now, ...(heartbeatPath ? { heartbeatPath } : {}) });

  it('tells the owner, once, that the bot was paused when the saved heartbeat is old, with the time window', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mint-pause-'));
    try {
      const path = join(directory, 'heartbeat');
      await writeHeartbeat(path, new Date('2026-10-11T08:00:00.000Z'));
      const now = () => new Date('2026-10-11T15:00:00.000Z');
      const h = harness(now);
      const service = startIntelligence(options(h, now, path));
      await vi.waitFor(() => expect(h.sent.some((text) => text.includes('BOT WAS PAUSED'))).toBe(true));
      service.stop();
      const message = h.sent.find((text) => text.includes('BOT WAS PAUSED')) ?? '';
      expect(message).toContain('2026-10-11 08:00 UTC to 2026-10-11 15:00 UTC (7 h 0 min)');
      expect(message).toContain('block 21,000,000');
      // A second start with the same saved heartbeat is the same pause: the durable dedupe sends nothing new.
      await writeHeartbeat(path, new Date('2026-10-11T08:00:00.000Z'));
      const again = startIntelligence(options(h, now, path));
      await new Promise((resolve) => setTimeout(resolve, 50));
      again.stop();
      expect(h.sent.filter((text) => text.includes('BOT WAS PAUSED'))).toHaveLength(1);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('logs what it loaded at start, so a missing pause notice can be explained', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mint-pause-'));
    try {
      const path = join(directory, 'heartbeat');
      await writeHeartbeat(path, new Date('2026-10-11T14:40:00.000Z'));
      const now = () => new Date('2026-10-11T15:00:00.000Z');
      const h = harness(now);
      const events: Array<Record<string, unknown>> = [];
      const logger = { info: (entry: Record<string, unknown>) => events.push(entry), warn: (entry: Record<string, unknown>) => events.push(entry), error: () => undefined } as never;
      const service = startIntelligence({ ...options(h, now, path), logger });
      await vi.waitFor(() => expect(events.some((entry) => entry.event === 'heartbeat_loaded')).toBe(true));
      service.stop();
      expect(events.find((entry) => entry.event === 'heartbeat_loaded')).toMatchObject({ savedAt: '2026-10-11T14:40:00.000Z', gapMinutes: 20 });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('says nothing after a short restart, with no heartbeat file, or when no path is given', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mint-pause-'));
    try {
      const path = join(directory, 'heartbeat');
      await writeHeartbeat(path, new Date('2026-10-11T14:58:00.000Z'));
      const now = () => new Date('2026-10-11T15:00:00.000Z');
      for (const heartbeatPath of [path, join(directory, 'missing'), undefined]) {
        const h = harness(now);
        const service = startIntelligence(options(h, now, heartbeatPath));
        await vi.waitFor(() => expect(h.sent.length).toBeGreaterThan(0));
        await new Promise((resolve) => setTimeout(resolve, 30));
        service.stop();
        expect(h.sent.some((text) => text.includes('PAUSED'))).toBe(false);
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

describe('scan jump and tick timing (T-034)', () => {
  class LaggingPort extends IdlePort {
    public override async safeHead(): Promise<bigint | null> { return 50_000n; }
    public override async scan(fromBlock: bigint, toBlock: bigint): Promise<ChainScanOutcome> { return { ok: true, scan: { fromBlock, toBlock: fromBlock + 7n > toBlock ? toBlock : fromBlock + 7n, mints: [], dropUpdates: [], watchedMints: [] } }; }
  }

  it('tells the owner once that the scan jumped ahead, without paths or addresses, and logs how long each tick took', async () => {
    const now = () => new Date('2026-10-15T12:00:00.000Z');
    const h = harness(now, new Repo(1, 100n));
    const logs: Array<Record<string, unknown>> = [];
    const logger = { info: (entry: Record<string, unknown>) => logs.push(entry), warn: (entry: Record<string, unknown>) => logs.push(entry), error: () => undefined } as never;
    const service = startIntelligence({ store: h.store, repo: h.repo, port: new LaggingPort(), alerts: h.alerts, wallets: OWN, logger, discoveryIntervalMs: 3_600_000, readinessIntervalMs: 3_600_000, digestIntervalMs: 3_600_000, now });
    await vi.waitFor(() => expect(h.sent.some((text) => text.includes('SCAN JUMPED AHEAD'))).toBe(true));
    service.stop();
    const message = h.sent.find((text) => text.includes('SCAN JUMPED AHEAD')) ?? '';
    expect(message).toContain('blocks 101 to 49,699 were not read');
    expect(message).not.toMatch(/0x[0-9a-f]{40}|\/home|https?:/i);
    expect(h.sent.filter((text) => text.includes('SCAN JUMPED AHEAD'))).toHaveLength(1);
    expect(logs.some((entry) => entry.event === 'discovery_skipped')).toBe(true);
    const tick = logs.find((entry) => entry.event === 'intelligence_discovery');
    expect(typeof tick?.durationMs).toBe('number');
  });
});

describe('jump notice is never lost (T-034 review)', () => {
  class FailingAfterJumpPort extends IdlePort {
    public override async safeHead(): Promise<bigint | null> { return 50_000n; }
    public override async scan(): Promise<ChainScanOutcome> { return { ok: false, reason: 'LOGS_UNAVAILABLE' }; }
  }

  it('sends the card even when the scan fails right after the jump, and not twice on the next tick', async () => {
    const now = () => new Date('2026-10-15T12:00:00.000Z');
    const h = harness(now, new Repo(1, 100n));
    const service = startIntelligence({ store: h.store, repo: h.repo, port: new FailingAfterJumpPort(), alerts: h.alerts, wallets: OWN, discoveryIntervalMs: 3_600_000, readinessIntervalMs: 3_600_000, digestIntervalMs: 3_600_000, now });
    await vi.waitFor(() => expect(h.sent.some((text) => text.includes('SCAN JUMPED AHEAD'))).toBe(true));
    await service.runOnce();
    service.stop();
    expect(h.sent.filter((text) => text.includes('SCAN JUMPED AHEAD'))).toHaveLength(1);
  });

  it('announces a recorded jump that never got its card, once, when the service starts', async () => {
    const now = () => new Date('2026-10-15T12:00:00.000Z');
    const h = harness(now);
    await h.store.transaction((state) => { state.events.push({ id: 'evt_old_skip', type: 'discovery_skipped', at: '2026-10-15T11:00:00.000Z', data: { fromBlock: '1000', toBlock: '9999', blocks: '9000', headBlock: '10299' } }, { id: 'evt_ancient_skip', type: 'discovery_skipped', at: '2026-10-10T11:00:00.000Z', data: { fromBlock: '1', toBlock: '2', blocks: '2', headBlock: '3' } }); });
    const service = startIntelligence({ store: h.store, repo: h.repo, port: new IdlePort(), alerts: h.alerts, wallets: OWN, discoveryIntervalMs: 3_600_000, readinessIntervalMs: 3_600_000, digestIntervalMs: 3_600_000, now });
    await vi.waitFor(() => expect(h.sent.some((text) => text.includes('SCAN JUMPED AHEAD'))).toBe(true));
    await service.runOnce();
    service.stop();
    const cards = h.sent.filter((text) => text.includes('SCAN JUMPED AHEAD'));
    expect(cards).toHaveLength(1);
    expect(cards[0]).toContain('blocks 1,000 to 9,999 were not read');
  });

  it('logs how long a failed tick took', async () => {
    const now = () => new Date('2026-10-15T12:00:00.000Z');
    const h = harness(now);
    const logs: Array<Record<string, unknown>> = [];
    const logger = { info: (entry: Record<string, unknown>) => logs.push(entry), warn: (entry: Record<string, unknown>) => logs.push(entry), error: () => undefined } as never;
    class ThrowingPort extends IdlePort { public override async safeHead(): Promise<bigint | null> { throw new Error('boom'); } }
    const service = startIntelligence({ store: h.store, repo: h.repo, port: new ThrowingPort(), alerts: h.alerts, wallets: OWN, logger, discoveryIntervalMs: 3_600_000, readinessIntervalMs: 3_600_000, digestIntervalMs: 3_600_000, now });
    await vi.waitFor(() => expect(logs.some((entry) => entry.event === 'intelligence_discovery_failed')).toBe(true));
    service.stop();
    expect(typeof logs.find((entry) => entry.event === 'intelligence_discovery_failed')?.durationMs).toBe('number');
  });
});
