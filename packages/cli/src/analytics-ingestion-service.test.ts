import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PublicClient } from 'viem';
import type { BackendStore } from '@mint-bot/backend';
import { canonicalAnalyticsPort, startAnalyticsIngestion } from './analytics-ingestion-service.js';
const state = vi.hoisted(() => ({ ingest: vi.fn(async (_input: unknown): Promise<void> => undefined) }));
vi.mock('@mint-bot/backend', async load => ({ ...await load<typeof import('@mint-bot/backend')>(), ingestCanonicalAnalytics: state.ingest }));
afterEach(() => { vi.useRealTimers(); state.ingest.mockReset(); });
const hash = `0x${'a'.repeat(64)}`;
function reader(changes: { chain?: number; hash?: string } = {}): PublicClient {
  return { getChainId: async () => changes.chain ?? 8453, getBlock: async () => ({ number: 10n, hash: changes.hash ?? hash, timestamp: 100n }) } as PublicClient;
}
describe('shadow analytics chain composition', () => {
  it('requires separate readers, matching chain and matching canonical public facts', async () => {
    const first = reader();
    expect(() => canonicalAnalyticsPort(8453, [first, first])).toThrow('ANALYTICS_INDEPENDENT_READERS_REQUIRED');
    const port = canonicalAnalyticsPort(8453, [first, reader()]);
    expect(await port.chainId()).toBe(8453);
    expect(await port.block(10n)).toMatchObject({ hash, number: 10n });
    await expect(canonicalAnalyticsPort(1, [first, reader()]).chainId()).rejects.toThrow('ANALYTICS_CHAIN_MISMATCH');
    await expect(canonicalAnalyticsPort(8453, [first, reader({ hash: `0x${'b'.repeat(64)}` })]).block(10n)).rejects.toThrow('ANALYTICS_RPC_DISAGREEMENT');
  });
  it('never propagates credential-bearing transport errors', async () => {
    const first = reader(); first.getBlock = vi.fn(async () => { throw new Error('https://rpc.invalid/marker'); });
    await expect(canonicalAnalyticsPort(8453, [first, reader()]).block(10n)).rejects.toThrow(/^ANALYTICS_CHAIN_UNAVAILABLE$/);
  });
  it('bounds each pass, does not overlap, drains shutdown and never reschedules after stop', async () => {
    vi.useFakeTimers();
    let resolve!: () => void;
    state.ingest.mockImplementation(() => new Promise<void>(done => { resolve = done; }));
    const service = startAnalyticsIngestion({ store: {} as BackendStore, port: async () => canonicalAnalyticsPort(8453, [reader(), reader()]), intervalMs: 60_000 });
    await vi.advanceTimersByTimeAsync(0);
    await service.tick();
    expect(state.ingest).toHaveBeenCalledTimes(1);
    expect(state.ingest).toHaveBeenCalledWith(expect.objectContaining({ maxReceipts: 5 }));
    let stopped = false; const stop = service.stop().then(() => { stopped = true; });
    await Promise.resolve(); expect(stopped).toBe(false);
    resolve(); await stop;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(state.ingest).toHaveBeenCalledTimes(1);
  });
});
