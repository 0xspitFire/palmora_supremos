import { afterEach, describe, expect, it, vi } from 'vitest';
import { DurableStore, calendarId, type IntelligenceChainPort, type SimulationOutcome } from '@mint-bot/backend';
import { chainReadinessAdvice, startChainReadiness } from './chain-readiness-service.js';

const NFT = '0x3333333333333333333333333333333333333333';
const wallets = Array.from({ length: 12 }, (_, index) => `0x${(index + 1).toString(16).padStart(40, '0')}`);
const AT = new Date('2026-11-07T10:00:00.000Z');
afterEach(() => { vi.useRealTimers(); });

function port(chainId: 8453 | 4663): IntelligenceChainPort {
  return {
    chainId, safeHead: async () => null, scan: async () => ({ ok: false, reason: 'unused' }), readDrop: async () => null, hasCode: async () => true,
    balance: vi.fn(async () => 10n ** 18n), simulateMint: vi.fn(async (): Promise<SimulationOutcome> => ({ outcome: 'pass' })),
  };
}

async function storeWithDrop(chainId: 8453 | 4663, priceWei = '0'): Promise<DurableStore> {
  const store = new DurableStore();
  await store.transaction(state => { state.events.push({ id: `drop-${chainId}`, type: 'calendar_entry', at: AT.toISOString(), data: { id: calendarId(chainId, NFT), chainId, contract: NFT, openingAt: new Date(AT.getTime() - 60_000).toISOString(), closingAt: new Date(AT.getTime() + 3_600_000).toISOString(), priceWei, maxPerWallet: 15, expiresAt: new Date(AT.getTime() + 600_000).toISOString() } }); });
  return store;
}

function lastSweep(store: DurableStore) { return store.snapshot().events.filter(e => e.type === 'readiness_sweep').at(-1); }

describe('supported-chain readiness advice', () => {
  it.each([[8453, 6, 4], [4663, 10, 10]] as const)('checks all wallets on %s and limits aggregate advice and quantity', async (chainId, readyCount, quantity) => {
    vi.useFakeTimers();
    const store = await storeWithDrop(chainId);
    const reader = port(chainId);
    const service = startChainReadiness({ store, port: reader, wallets: async () => wallets, enabled: () => true, intervalMs: 120_000, now: () => AT });
    await service.runOnce();
    const event = lastSweep(store);
    const rows = event?.data.rows as Array<{ state: string; reason: string; topUpWei: string | null }>;
    expect(event?.data.quantity).toBe(quantity);
    expect(event?.data.requiredWei).toBe('200000000000000');
    expect(rows).toHaveLength(12);
    expect(rows.filter(row => row.state === 'ready')).toHaveLength(readyCount);
    expect(rows.filter(row => row.reason === 'FREE_FLEET_LIMIT')).toHaveLength(12 - readyCount);
    expect(rows.filter(row => row.reason === 'FREE_FLEET_LIMIT').every(row => row.topUpWei === null)).toBe(true);
    expect(reader.simulateMint).toHaveBeenCalledWith(expect.any(String), NFT, quantity, 0n);
    expect(store.snapshot()).toMatchObject({ reservations: [], attempts: [], runs: [], intents: [] });
    await service.stop();
  });

  it('refreshes custody addresses for each pass and does not retain a retired wallet', async () => {
    vi.useFakeTimers();
    const store = await storeWithDrop(4663);
    let selected = [wallets[0]!];
    const getWallets = vi.fn(async () => selected);
    const service = startChainReadiness({ store, port: port(4663), wallets: getWallets, enabled: () => true, intervalMs: 120_000, now: () => AT });
    await service.runOnce();
    selected = [wallets[1]!];
    await service.runOnce();
    expect(getWallets).toHaveBeenCalledTimes(2);
    expect(lastSweep(store)?.data.rows).toEqual([expect.objectContaining({ wallet: wallets[1] })]);
    await service.stop();
  });

  it('does no readiness work after enablement is revoked and keeps paid advice blocked', async () => {
    vi.useFakeTimers();
    const store = await storeWithDrop(8453, '1');
    const reader = port(8453);
    const getWallets = vi.fn(async () => wallets);
    let enabled = false;
    const service = startChainReadiness({ store, port: reader, wallets: getWallets, enabled: () => enabled, intervalMs: 120_000, now: () => AT });
    await service.runOnce();
    expect(getWallets).not.toHaveBeenCalled();
    enabled = true;
    await service.runOnce();
    expect((lastSweep(store)?.data.rows as Array<{ reason: string }>).every(row => row.reason === 'PAID_CHAIN_NOT_ENABLED')).toBe(true);
    expect(reader.balance).not.toHaveBeenCalled();
    expect(reader.simulateMint).not.toHaveBeenCalled();
    enabled = false;
    await service.runOnce();
    expect(getWallets).toHaveBeenCalledTimes(1);
    await service.stop();
  });

  it('isolates a slow chain, never overlaps its passes, and drains before stopping', async () => {
    vi.useFakeTimers();
    const baseStore = await storeWithDrop(8453);
    const rhStore = await storeWithDrop(4663);
    const slow = port(8453);
    let finish!: (balance: bigint) => void;
    slow.balance = vi.fn(() => new Promise<bigint>(resolve => { finish = resolve; }));
    const fast = port(4663);
    const base = startChainReadiness({ store: baseStore, port: slow, wallets: async () => [wallets[0]!], enabled: () => true, intervalMs: 15_000, now: () => AT });
    const rh = startChainReadiness({ store: rhStore, port: fast, wallets: async () => [wallets[1]!], enabled: () => true, intervalMs: 15_000, now: () => AT });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(slow.balance).toHaveBeenCalledTimes(1);
    expect(fast.balance).toHaveBeenCalledTimes(5);
    let stopped = false;
    const drained = base.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finish(10n ** 18n);
    await drained;
    await rh.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(slow.balance).toHaveBeenCalledTimes(1);
    expect(fast.balance).toHaveBeenCalledTimes(5);
  });

  it('recovers after provider and logger failures without persisting raw errors', async () => {
    vi.useFakeTimers();
    const store = await storeWithDrop(4663);
    const reader = port(4663);
    reader.balance = vi.fn().mockRejectedValueOnce(new Error('https://credential.example/private')).mockResolvedValue(10n ** 18n);
    const logger = { info: vi.fn(() => { throw new Error('disk full'); }), warn: vi.fn(() => { throw new Error('disk full'); }) };
    const service = startChainReadiness({ store, port: reader, wallets: async () => [wallets[0]!], enabled: () => true, intervalMs: 15_000, logger, now: () => AT });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(reader.balance).toHaveBeenCalledTimes(2);
    expect(lastSweep(store)).toBeDefined();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('credential.example');
    expect(JSON.stringify(store.snapshot().events)).not.toContain('credential.example');
    await service.stop();
  });

  it('refuses unsupported chains and unsafe polling intervals', () => {
    expect(() => chainReadinessAdvice(1 as 8453)).toThrow('READINESS_CHAIN_UNSUPPORTED');
    expect(() => startChainReadiness({ store: new DurableStore(), port: port(4663), wallets: async () => [], enabled: () => true, intervalMs: 1 })).toThrow('READINESS_INTERVAL_INVALID');
  });
});
