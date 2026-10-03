import { afterEach, describe, expect, it, vi } from 'vitest';
import { AlertManager, DurableStore, type ChainScanOutcome, type DropSnapshot, type IntelligenceChainPort, type IntelligenceRepositoryPort, type SimulationOutcome } from '@mint-bot/backend';
import { startIntelligence } from './intelligence-service.js';

/** A port whose scans can be switched between working, failing with a provider message, and throwing. */
class SwitchPort implements IntelligenceChainPort {
  public readonly chainId = 1 as const;
  public mode: 'ok' | 'rate' | 'throw' = 'ok';
  // The chain moves on at every look, so a scan always has new blocks to read (a caught-up bot makes no scan call).
  private head = 100n;
  public async safeHead(): Promise<bigint | null> {
    if (this.mode === 'throw') throw new Error('socket hang up at https://user:pw@node.example/v2/SECRETKEY');
    this.head += 1n;
    return this.head;
  }
  public async scan(from: bigint, to: bigint): Promise<ChainScanOutcome> {
    if (this.mode === 'rate') return { ok: false, reason: 'RATE_LIMITED: https://user:pw@node.example/v2/SECRETKEY' };
    return { ok: true, scan: { fromBlock: from, toBlock: to, mints: [], dropUpdates: [], watchedMints: [] } };
  }
  public async readDrop(): Promise<DropSnapshot | null> { return null; }
  public async hasCode(): Promise<boolean | null> { return null; }
  public async balance(): Promise<bigint | null> { return null; }
  public async simulateMint(): Promise<SimulationOutcome> { return { outcome: 'unknown', reason: 'unused' }; }
}

class Repo implements IntelligenceRepositoryPort {
  private block: bigint | undefined;
  public observedAddresses() { return [{ address: `0x${'1'.repeat(40)}` }]; }
  public cursor() { return this.block; }
  public advanceCursor(_chainId: number, _source: string, block: bigint): void { this.block = block; }
}

function harness(start: Date, failDelivery = false) {
  let clock = start.getTime();
  const now = () => new Date(clock);
  const store = new DurableStore();
  const sent: string[] = [];
  const dispatcher = { dispatch: async (_id: string, text?: string) => { if (failDelivery) throw new Error('TELEGRAM_DELIVERY_FAILED:500'); sent.push(text ?? ''); } };
  const alerts = new AlertManager(store, dispatcher as never, undefined, { now });
  const port = new SwitchPort();
  const service = startIntelligence({ store, repo: new Repo(), port, alerts, wallets: [], discoveryIntervalMs: 3_600_000, readinessIntervalMs: 3_600_000, digestIntervalMs: 3_600_000, healthIntervalMs: 3_600_000, now });
  return { store, sent, port, service, advance: (minutes: number) => { clock += minutes * 60_000; } };
}

afterEach(() => { vi.useRealTimers(); });

describe('health warnings from the running service (T-030)', () => {
  it('sends nothing while scans work, and the check-in then shows the last good scan with its block', async () => {
    const h = harness(new Date('2026-10-03T08:00:00.000Z'));
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    await h.service.runOnce();
    h.advance(70);
    await h.service.runOnce();
    h.service.stop();
    expect(h.sent.filter((text) => text.includes('CHAIN SCAN'))).toEqual([]);
    const checkIn = h.sent.find((text) => text.includes('DAILY CHECK-IN'))!;
    expect(checkIn).toContain('DAILY CHECK-IN · INFO');
    expect(checkIn).toMatch(/Chain scan: last successful scan 0 s ago, block \d+/);
    expect(checkIn).toContain('Health warnings: none in 24 h');
  });

  it('warns when scans keep failing, in words, without any provider text, then says it recovered', async () => {
    const h = harness(new Date('2026-10-03T08:00:00.000Z'));
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    await h.service.runOnce();
    h.port.mode = 'rate';
    h.advance(20);
    await h.service.runOnce();
    const warning = h.sent.find((text) => text.includes('CHAIN SCAN STALLED'))!;
    expect(warning).toContain('CHAIN SCAN STALLED · ATTENTION');
    expect(warning).toContain('Likely cause: the chain provider is limiting requests');
    expect(warning).toContain('Last good scan: 08:00 UTC');
    expect(JSON.stringify(h.sent)).not.toMatch(/SECRETKEY|node\.example|pw@/);
    h.port.mode = 'ok';
    h.advance(5);
    await h.service.runOnce();
    h.service.stop();
    expect(h.sent.some((text) => text.includes('RECOVERED · CHAIN SCAN STALLED'))).toBe(true);
    expect(h.store.snapshot().events.filter((event) => event.type === 'alert_health')).toHaveLength(2);
  });

  it('treats a scan that throws as a failure without leaking its message, and keeps the service running', async () => {
    const h = harness(new Date('2026-10-03T08:00:00.000Z'));
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    await h.service.runOnce();
    h.port.mode = 'throw';
    h.advance(20);
    await expect(h.service.runOnce()).resolves.toBeUndefined();
    h.service.stop();
    const warning = h.sent.find((text) => text.includes('CHAIN SCAN STALLED'))!;
    expect(warning).toContain('the scan failed for a reason that is only in the log');
    expect(JSON.stringify(h.sent)).not.toMatch(/SECRETKEY|node\.example|pw@/);
  });

  it('keeps the warning recorded when Telegram is down, so the outbox can deliver it later', async () => {
    const h = harness(new Date('2026-10-03T08:00:00.000Z'), true);
    await h.service.runOnce();
    h.port.mode = 'rate';
    h.advance(20);
    await expect(h.service.runOnce()).resolves.toBeUndefined();
    h.service.stop();
    expect(h.store.snapshot().events.some((event) => event.type === 'alert_health')).toBe(true);
  });

  it('uses the host facts for disk and backup, and ignores a sampler that fails', async () => {
    let clock = new Date('2026-10-03T08:00:00.000Z').getTime();
    const now = () => new Date(clock);
    const store = new DurableStore();
    const sent: string[] = [];
    const alerts = new AlertManager(store, { dispatch: async (_id: string, text?: string) => { sent.push(text ?? ''); } } as never, undefined, { now });
    let sample: () => Promise<never> | Promise<{ disk: { freeBytes: number; totalBytes: number } }> = async () => ({ disk: { freeBytes: 100 * 1024 ** 2, totalBytes: 100 * 1024 ** 3 } });
    const service = startIntelligence({ store, repo: new Repo(), port: new SwitchPort(), alerts, wallets: [], discoveryIntervalMs: 3_600_000, readinessIntervalMs: 3_600_000, digestIntervalMs: 3_600_000, healthIntervalMs: 3_600_000, sampleHost: () => sample(), now });
    await service.runOnce();
    expect(sent.some((text) => text.includes('DISK SPACE LOW · CRITICAL'))).toBe(true);
    clock += 60_000;
    sample = async () => { throw new Error('statfs failed'); };
    await expect(service.runOnce()).resolves.toBeUndefined();
    service.stop();
  });
});
