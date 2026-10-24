import { describe, expect, it } from 'vitest';
import { createEthPriceProvider, readChainlink, readCoinbase, usdText, type ChainlinkReader, type PriceFetch } from './price-provider.js';

/** T-072: the dollar price is display only; it is checked, falls back from Chainlink to Coinbase, and is left out when neither is trustworthy. */
const NOW = new Date('2026-10-25T12:00:00.000Z');
const chainlink = (over: Partial<{ description: string; decimals: number; answer: bigint; ageMs: number }> = {}): ChainlinkReader => ({
  description: async () => over.description ?? 'ETH / USD',
  decimals: async () => over.decimals ?? 8,
  latestRoundData: async () => ({ answer: over.answer ?? 250_000_000_000n, updatedAt: new Date(NOW.getTime() - (over.ageMs ?? 600_000)) }),
});
const coinbase = (body: unknown, status = 200): PriceFetch => async () => ({ ok: status === 200, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const spot = (amount: unknown) => ({ data: { base: 'ETH', currency: 'USD', amount } });

describe('Chainlink', () => {
  it('reads a good ETH / USD answer', async () => {
    expect(await readChainlink(chainlink(), NOW)).toEqual({ usd: 2500, source: 'chainlink', asOf: new Date(NOW.getTime() - 600_000) });
  });
  it('refuses the wrong feed, the wrong decimals, a stale, future, zero, negative or absurd answer', async () => {
    for (const bad of [{ description: 'BTC / USD' }, { decimals: 18 }, { ageMs: 3 * 3_600_000 + 1 }, { ageMs: -10 * 60_000 }, { answer: 0n }, { answer: -5n }, { answer: 100_000_000n }, { answer: 10n ** 18n }]) {
      expect(await readChainlink(chainlink(bad), NOW), String(Object.entries(bad))).toBeUndefined();
    }
    expect(await readChainlink({ ...chainlink(), latestRoundData: async () => { throw new Error('rpc down'); } }, NOW)).toBeUndefined();
  });
});

describe('Coinbase', () => {
  it('reads the public spot price and refuses anything malformed', async () => {
    expect(await readCoinbase(coinbase(spot('2501.23')), NOW)).toEqual({ usd: 2501.23, source: 'coinbase', asOf: NOW });
    for (const bad of [spot('abc'), spot('-1'), spot('5'), spot('2e3'), spot(2500), { data: { base: 'BTC', currency: 'USD', amount: '2500' } }, 'not json', { data: null }, spot('2'.repeat(30))]) {
      expect(await readCoinbase(coinbase(bad), NOW), JSON.stringify(bad)).toBeUndefined();
    }
    expect(await readCoinbase(coinbase(spot('2500'), 500), NOW)).toBeUndefined();
    expect(await readCoinbase(coinbase('x'.repeat(10_001)), NOW)).toBeUndefined();
    expect(await readCoinbase(async () => { throw new Error('offline'); }, NOW)).toBeUndefined();
  });
});

describe('the provider', () => {
  it('prefers Chainlink, falls back to Coinbase, and shows nothing when neither answers', async () => {
    expect((await createEthPriceProvider({ chainlink: chainlink(), fetcher: coinbase(spot('2400')), now: () => NOW }).price())?.source).toBe('chainlink');
    expect((await createEthPriceProvider({ chainlink: chainlink({ description: 'wrong' }), fetcher: coinbase(spot('2400')), now: () => NOW }).price())?.source).toBe('coinbase');
    expect((await createEthPriceProvider({ fetcher: coinbase(spot('2400')), now: () => NOW }).price())?.source).toBe('coinbase');
    expect(await createEthPriceProvider({ chainlink: chainlink({ answer: 0n }), fetcher: coinbase('nope'), now: () => NOW }).price()).toBeUndefined();
  });
  it('keeps an answer for a minute, then asks again', async () => {
    let clock = NOW; let calls = 0;
    const provider = createEthPriceProvider({ fetcher: async () => { calls += 1; return { ok: true, status: 200, text: async () => JSON.stringify(spot('2400')) }; }, now: () => clock });
    await provider.price(); await provider.price();
    expect(calls).toBe(1);
    clock = new Date(clock.getTime() + 61_000);
    await provider.price();
    expect(calls).toBe(2);
  });
});

describe('dollar text', () => {
  it('is cut to whole cents, never rounded up, with thousands separators and a "<$0.01" floor', () => {
    const price = { usd: 2500, source: 'chainlink' as const, asOf: NOW };
    expect(usdText(0.000389, price)).toBe('$0.97');
    expect(usdText(1.5328, price)).toBe('$3,832.00');
    expect(usdText(0.0000001, price)).toBe('<$0.01');
    expect(usdText(0, price)).toBe('$0.00');
    expect(usdText(0.0004, price)).toBe('$1.00');
  });
});
