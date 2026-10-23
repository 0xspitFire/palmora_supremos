import { describe, expect, it, vi } from 'vitest';
import { AlertManager, DurableStore, type ChainScanOutcome, type DropSnapshot, type IntelligenceChainPort, type IntelligenceRepositoryPort, type SimulationOutcome } from '@mint-bot/backend';
import { startIntelligence } from './intelligence-service.js';
import { createMonitorPing, startLivenessPing, validMonitorUrl } from './monitor-ping.js';

const URL_OK = 'https://hc-ping.com/11111111-2222-3333-4444-555555555555';

describe('outside monitor address', () => {
  it('accepts a plain https address and refuses everything else', () => {
    expect(validMonitorUrl(URL_OK)).toBe(URL_OK);
    expect(validMonitorUrl(`${URL_OK}/`)).toBe(URL_OK);
    for (const bad of [undefined, '', 'http://hc-ping.com/x', 'ftp://hc-ping.com/x', 'https://user:pass@hc-ping.com/x', 'not a url', 'https://']) expect(validMonitorUrl(bad)).toBeUndefined();
    expect(() => createMonitorPing('http://insecure.example/x')).toThrow('MONITOR_URL_INVALID');
  });
});

describe('createMonitorPing', () => {
  it('pings the address for ok and the /fail address for fail, and never follows a redirect', async () => {
    const fetchImpl = vi.fn(async () => new Response('OK', { status: 200 }));
    const ping = createMonitorPing(URL_OK, { fetchImpl: fetchImpl as never });
    await ping('ok');
    await ping('fail');
    expect(fetchImpl.mock.calls.map((call) => (call as unknown as [string])[0])).toEqual([URL_OK, `${URL_OK}/fail`]);
    expect((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].redirect).toBe('error');
  });

  it('fails with a message that does not contain the address', async () => {
    const down = createMonitorPing(URL_OK, { fetchImpl: (async () => { throw new TypeError(`fetch failed ${URL_OK}`); }) as never });
    await expect(down('ok')).rejects.toThrow('MONITOR_PING_FAILED');
    await expect(down('ok')).rejects.not.toThrow(/hc-ping|11111111/);
    const refused = createMonitorPing(URL_OK, { fetchImpl: (async () => new Response('no', { status: 404 })) as never });
    await expect(refused('ok')).rejects.toThrow('MONITOR_PING_FAILED_404');
  });
});

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
  public observedAddresses() { return []; }
  public cursor() { return 1n; }
  public advanceCursor(): void { /* unused */ }
}

describe('monitor signal from the service', () => {
  const run = async (now: () => Date, ping: (status: string) => Promise<void>, logs: unknown[] = []) => {
    const store = new DurableStore();
    const alerts = new AlertManager(store, { dispatch: async () => undefined } as never, undefined, { now });
    const service = startIntelligence({ store, repo: new Repo(), port: new IdlePort(), alerts, wallets: [], discoveryIntervalMs: 3_600_000, readinessIntervalMs: 3_600_000, digestIntervalMs: 3_600_000, monitorPing: ping as never, now, logger: { info: (...a: unknown[]) => logs.push(a), warn: (...a: unknown[]) => logs.push(a), error: () => undefined } as never });
    await new Promise((resolve) => setTimeout(resolve, 40));
    service.stop();
  };

  it('sends ok in the first minutes after start, fail once scans have been stalled for 15 minutes', async () => {
    const calls: string[] = [];
    const ping = async (status: string) => { calls.push(status); };
    await run(() => new Date('2026-10-11T10:00:00.000Z'), ping);
    expect(calls).toEqual(['ok']);
    // Same service start time but 20 minutes later with no good scan: the first signal is fail.
    calls.length = 0;
    const store = new DurableStore();
    let clock = new Date('2026-10-11T10:00:00.000Z');
    const alerts = new AlertManager(store, { dispatch: async () => undefined } as never, undefined, { now: () => clock });
    const service = startIntelligence({ store, repo: new Repo(), port: new IdlePort(), alerts, wallets: [], discoveryIntervalMs: 3_600_000, readinessIntervalMs: 3_600_000, digestIntervalMs: 3_600_000, monitorPing: ping as never, monitorIntervalMs: 20, now: () => clock });
    await new Promise((resolve) => setTimeout(resolve, 60));
    clock = new Date('2026-10-11T10:20:00.000Z');
    await new Promise((resolve) => setTimeout(resolve, 80));
    service.stop();
    expect(calls[0]).toBe('ok');
    expect(calls.at(-1)).toBe('fail');
  });

  it('keeps running and logs only a reason code when the monitor cannot be reached', async () => {
    const logs: unknown[] = [];
    await run(() => new Date('2026-10-11T10:00:00.000Z'), async () => { throw new Error('MONITOR_PING_FAILED'); }, logs);
    expect(JSON.stringify(logs)).toContain('MONITOR_PING_FAILED');
    expect(JSON.stringify(logs)).not.toContain('hc-ping');
  });
});

describe('service liveness signal (production service without chain scanning)', () => {
  it('sends ok while the service can read its database, fail when it cannot, and keeps going after a send failure', async () => {
    const sent: string[] = [];
    let healthy = true;
    let failNext = false;
    const errors: string[] = [];
    const running = startLivenessPing(async (status) => { if (failNext) { failNext = false; throw new Error('MONITOR_PING_FAILED_503'); } sent.push(status); }, { healthy: () => { if (!healthy) throw new Error('database gone'); return true; }, intervalMs: 3_600_000, onError: (code) => errors.push(code) });
    await running.tick();
    healthy = false;
    await running.tick();
    failNext = true;
    healthy = true;
    await running.tick();
    await running.tick();
    running.stop();
    expect(sent.slice(-3)).toEqual(['ok', 'fail', 'ok']);
    expect(errors).toEqual(['MONITOR_PING_FAILED_503']);
  });
});
