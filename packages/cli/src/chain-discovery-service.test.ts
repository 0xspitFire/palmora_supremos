import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiscoveryService, DurableStore, type DiscoveryTickResult, type IntelligenceChainPort } from '@mint-bot/backend';
import { startChainDiscovery } from './chain-discovery-service.js';

const ok = (extra: Partial<DiscoveryTickResult> = {}): DiscoveryTickResult => ({ status: 'ok', mintsObserved: 0, opportunitiesWritten: 0, calendarWritten: 0, alertsRaised: 0, headBlock: '500', caughtUp: true, ...extra });
const logger = () => ({ info: vi.fn(), warn: vi.fn() });
afterEach(() => { vi.useRealTimers(); });

describe('secondary-chain scan scheduling', () => {
  it('scans immediately and polls Robinhood within fifteen seconds, preserving the Base interval', async () => {
    vi.useFakeTimers();
    const rh = vi.fn(async () => ok());
    const base = vi.fn(async () => ok());
    const a = startChainDiscovery({ chainId: 4663, intervalMs: 120_000, tick: rh, logger: logger() });
    const b = startChainDiscovery({ chainId: 8453, intervalMs: 120_000, tick: base, logger: logger() });
    await vi.advanceTimersByTimeAsync(0);
    expect(rh).toHaveBeenCalledTimes(1);
    expect(base).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(rh).toHaveBeenCalledTimes(2);
    expect(base).toHaveBeenCalledTimes(1);
    a.stop(); b.stop();
  });

  it('never overlaps slow requests, and stop during an in-flight scan prevents rescheduling or reporting success', async () => {
    vi.useFakeTimers();
    let finish!: (value: DiscoveryTickResult) => void;
    const tick = vi.fn(() => new Promise<DiscoveryTickResult>(resolve => { finish = resolve; }));
    const logs = logger();
    const service = startChainDiscovery({ chainId: 4663, intervalMs: 120_000, tick, logger: logs });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(tick).toHaveBeenCalledTimes(1);
    service.stop(); finish(ok());
    await vi.advanceTimersByTimeAsync(120_000);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(logs.info).not.toHaveBeenCalled();
  });

  it('reports returned unavailable outcomes without exposing reasons or rapidly retrying jump-only cursor changes', async () => {
    vi.useFakeTimers();
    const logs = logger();
    const tick = vi.fn(async () => ok({ status: 'unavailable', reason: 'secret-provider-text', caughtUp: false, skipped: { fromBlock: '1', toBlock: '199', blocks: '199' } }));
    const service = startChainDiscovery({ chainId: 4663, intervalMs: 120_000, tick, logger: logs });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(logs.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'replication_discovery_unavailable', chainId: 4663, code: 'SCAN_FAILED', scannedThrough: null }), expect.any(String));
    expect(logs.info).not.toHaveBeenCalled();
    expect(JSON.stringify(logs.warn.mock.calls)).not.toContain('secret-provider-text');
    await vi.advanceTimersByTimeAsync(14_000);
    expect(tick).toHaveBeenCalledTimes(2);
    service.stop();
  });

  it('surfaces prolonged failures once per fifteen minutes and recovers without poisoning the next scan', async () => {
    vi.useFakeTimers();
    const logs = logger();
    const notify = vi.fn(async () => undefined);
    let failing = true;
    const tick = vi.fn(async () => { if (failing) throw new Error('secret failure'); return ok(); });
    const service = startChainDiscovery({ chainId: 4663, intervalMs: 120_000, tick, logger: logs, notify });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(notify).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(899_000);
    expect(notify).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(logs.warn.mock.calls)).not.toContain('secret failure');
    failing = false;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(logs.info).toHaveBeenCalledWith(expect.objectContaining({ caughtUp: true }), expect.any(String));
    service.stop();
  });

  it('continues both successful and failed scans when the diagnostic logger throws', async () => {
    vi.useFakeTimers();
    let failing = false;
    const tick = vi.fn(async () => { if (failing) throw new Error('provider failure'); return ok(); });
    const broken = { info: vi.fn(() => { throw new Error('log disk full'); }), warn: vi.fn(() => { throw new Error('log permission denied'); }) };
    const notify = vi.fn(async () => undefined);
    const service = startChainDiscovery({ chainId: 4663, intervalMs: 120_000, tick, logger: broken, notify });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(tick).toHaveBeenCalledTimes(21);
    expect(broken.info).toHaveBeenCalledTimes(21);
    expect(notify).not.toHaveBeenCalled(); // logging failure did not misclassify successful reads
    failing = true;
    await vi.advanceTimersByTimeAsync(315_000);
    expect(tick).toHaveBeenCalledTimes(42);
    expect(broken.warn).toHaveBeenCalledTimes(21);
    expect(notify).toHaveBeenCalledTimes(1);
    failing = false;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(broken.info).toHaveBeenCalledTimes(22);
    service.stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(tick).toHaveBeenCalledTimes(43);
  });

  it('does not fast-retry incomplete results without actual scanned range metadata', async () => {
    vi.useFakeTimers();
    const tick = vi.fn(async () => ok({ caughtUp: false }));
    const service = startChainDiscovery({ chainId: 4663, intervalMs: 120_000, tick, logger: logger() });
    await vi.advanceTimersByTimeAsync(14_000);
    expect(tick).toHaveBeenCalledTimes(1);
    service.stop();
  });

  it('keeps contiguous coverage at ten Robinhood blocks per second even with six-block slices', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const store = new DurableStore();
    let cursor: bigint | undefined;
    const ranges: Array<[bigint, bigint]> = [];
    const port: IntelligenceChainPort = {
      chainId: 4663,
      safeHead: async () => 10_000n + BigInt(Math.floor(Date.now() / 100)),
      scan: async (from, head) => {
        await new Promise(resolve => setTimeout(resolve, 100));
        const to = from + 5n < head ? from + 5n : head;
        ranges.push([from, to]);
        return { ok: true, scan: { fromBlock: from, toBlock: to, mints: [], watchedMints: [], dropUpdates: [] } };
      },
      readDrop: async () => null, hasCode: async () => null, balance: async () => null,
      simulateMint: async () => ({ outcome: 'unknown', reason: 'unused' }),
    };
    const discovery = new DiscoveryService(store, { observedAddresses: () => [], cursor: () => cursor, advanceCursor: (_chain, _source, value) => { cursor = value; } }, port, { budgetPerNftWei: 1n });
    const logs = logger();
    const service = startChainDiscovery({ chainId: 4663, intervalMs: 120_000, tick: () => discovery.tick(), logger: logs });
    await vi.advanceTimersByTimeAsync(180_000);
    service.stop();
    expect(store.snapshot().events.filter(event => event.type === 'discovery_skipped')).toHaveLength(0);
    expect(cursor).toBeGreaterThanOrEqual(11_650n); // at most one normal poll interval behind
    for (let i = 1; i < ranges.length; i++) expect(ranges[i]![0]).toBe(ranges[i - 1]![1] + 1n);
    expect(logs.info.mock.calls.some(([entry]) => entry.caughtUp === false)).toBe(true);
    expect(logs.info.mock.calls.some(([entry]) => entry.caughtUp === true)).toBe(true);
  });
});
