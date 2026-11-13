import { describe, expect, it, vi } from 'vitest';
import { DurableStore } from '../store.js';
import { ReadinessSweep, D033_READINESS_LIMITS } from './readiness.js';
import type { IntelligenceChainPort } from './port.js';

const NFT = '0x3333333333333333333333333333333333333333';
const WALLET = '0x1111111111111111111111111111111111111111';
const NOW = new Date('2026-11-07T10:00:00.000Z');
const reader: IntelligenceChainPort = { chainId: 8453, safeHead: async () => null, scan: async () => ({ ok: false, reason: 'unused' }), readDrop: async () => null, hasCode: async () => true, balance: async () => 10n ** 18n, simulateMint: vi.fn(async () => ({ outcome: 'pass' as const })) };

describe('readiness advisory boundaries', () => {
  it('retains a skipped row and no top-up request when no aggregate headroom exists', async () => {
    const store = new DurableStore();
    await store.transaction(state => { state.events.push({ id: 'calendar', type: 'calendar_entry', at: NOW.toISOString(), data: { id: `calendar:8453:${NFT}`, chainId: 8453, contract: NFT, openingAt: new Date(NOW.getTime() - 1000).toISOString(), closingAt: new Date(NOW.getTime() + 60000).toISOString(), priceWei: '0', maxPerWallet: 20, expiresAt: new Date(NOW.getTime() + 60000).toISOString() } }); });
    await new ReadinessSweep(store, reader, async () => [WALLET], { limits: D033_READINESS_LIMITS, freeMaxQuantity: 4, freeActivePeriodCapWei: 0n, now: () => NOW }).tick();
    const event = store.snapshot().events.find(e => e.type === 'readiness_sweep');
    expect(event?.data.quantity).toBe(4);
    expect(event?.data.rows).toEqual([expect.objectContaining({ wallet: WALLET, state: 'skipped', reason: 'FREE_FLEET_LIMIT', topUpWei: null })]);
    expect(store.snapshot()).toMatchObject({ reservations: [], attempts: [], runs: [], intents: [] });
  });

  it.each([-1, 0, 16, 1.5, Number.NaN])('rejects invalid configured advisory quantity %s', freeMaxQuantity => {
    expect(() => new ReadinessSweep(new DurableStore(), reader, async () => [], { limits: D033_READINESS_LIMITS, freeMaxQuantity })).toThrow('READINESS_ADVISORY_LIMIT_INVALID');
  });

  it('rejects negative aggregate advice rather than widening a limit', () => {
    expect(() => new ReadinessSweep(new DurableStore(), reader, async () => [], { limits: D033_READINESS_LIMITS, freeActivePeriodCapWei: -1n })).toThrow('READINESS_ADVISORY_LIMIT_INVALID');
  });
});
