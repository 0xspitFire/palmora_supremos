import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNFTDiscoveryReader, startContractMonitorService } from './contract-monitor-service.js';
afterEach(() => vi.useRealTimers());
const idle = { status: 'ok' as const, pending: 0, captured: 0, published: 0 };
describe('contract monitor lifecycle', () => {
  it('is inert by default explicit disabled input and fairly rotates selected chains after completion', async () => {
    vi.useFakeTimers(); const order: number[] = [];
    const chains = [1, 8453, 4663].map(chainId => ({ chainId, monitor: { tick: vi.fn(async () => { order.push(chainId); return idle; }) } }));
    const off = startContractMonitorService({ enabled: false, chains }); await vi.advanceTimersByTimeAsync(60_000); expect(order).toEqual([]); off.stop();
    const service = startContractMonitorService({ enabled: true, chains });
    await vi.advanceTimersByTimeAsync(30_000); expect(order).toEqual([1, 8453, 4663]);
    service.stop(); await service.drain(); await vi.advanceTimersByTimeAsync(60_000); expect(order).toHaveLength(3);
  });
  it('does not overlap slow selected ticks; stop aborts the active tick and drain waits', async () => {
    vi.useFakeTimers(); let release!: () => void; let active: AbortSignal | undefined;
    const tick = vi.fn(async (signal?: AbortSignal) => { active = signal; await new Promise<void>(resolve => { release = resolve; }); return idle; });
    const service = startContractMonitorService({ enabled: true, chains: [{ chainId: 1, monitor: { tick } }], tickTimeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(10_000); await vi.advanceTimersByTimeAsync(60_000); expect(tick).toHaveBeenCalledTimes(1); expect(active?.aborted).toBe(true);
    service.stop(); release(); await service.drain(); expect(active?.aborted).toBe(true);
  });
});
describe('bounded read-only NFT RPC adapter', () => {
  const reply = (value: unknown, id = 1) => new Response(JSON.stringify({ jsonrpc: '2.0', id, result: value }), { status: 200 });
  it('sends exactly one fixed-origin read with redirects disabled and no retry', async () => {
    const fetcher = vi.fn(async () => reply('0x1')); const reader = createNFTDiscoveryReader('https://rpc.example/approved', fetcher as typeof fetch);
    expect(await reader.chainId(new AbortController().signal)).toBe(1); expect(fetcher).toHaveBeenCalledTimes(1);
    const request = fetcher.mock.calls[0] as unknown as [URL, RequestInit]; expect(request[0].origin).toBe('https://rpc.example'); expect(request[1].redirect).toBe('error'); expect(JSON.parse(request[1].body as string).method).toBe('eth_chainId');
  });
  it('rejects credential URLs and malformed interfaces', async () => {
    expect(() => createNFTDiscoveryReader('https://user:pass@rpc.example')).toThrow('ENDPOINT_INVALID');
    const fetcher = vi.fn(async () => reply('0x01')); const reader = createNFTDiscoveryReader('https://rpc.example', fetcher as typeof fetch);
    await expect(reader.supportsInterface(`0x${'1'.repeat(40)}`, '0x01ffc9a7', 1n, new AbortController().signal)).rejects.toThrow('RPC_INVALID');
  });
  it('limits streamed and declared response sizes and redacts transport errors', async () => {
    const excessive = vi.fn(async () => new Response('x', { headers: { 'content-length': '3000000' } }));
    await expect(createNFTDiscoveryReader('https://rpc.example', excessive as typeof fetch).head(new AbortController().signal)).rejects.toThrow('NFT_MONITOR_RPC_UNAVAILABLE');
    const streamed = vi.fn(async () => new Response('x'.repeat(2_097_153)));
    await expect(createNFTDiscoveryReader('https://rpc.example', streamed as typeof fetch).head(new AbortController().signal)).rejects.toThrow('RESPONSE_LIMIT');
    const fails = vi.fn(async () => { throw new Error('https://rpc.example/private-credential'); });
    await expect(createNFTDiscoveryReader('https://rpc.example', fails as typeof fetch).head(new AbortController().signal)).rejects.toThrow(/^NFT_MONITOR_RPC_UNAVAILABLE$/); expect(fails).toHaveBeenCalledTimes(1);
  });
  it('recognizes only a finite provider log range limit without retaining provider message', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'secret provider payload' } })));
    const reader = createNFTDiscoveryReader('https://rpc.example', fetcher as typeof fetch);
    await expect(reader.logs({ fromBlock: 0n, toBlock: 100n, topics: [] }, new AbortController().signal)).rejects.toThrow(/^NFT_MONITOR_RANGE_LIMIT$/);
  });
});
