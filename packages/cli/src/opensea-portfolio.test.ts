import { describe, expect, it, vi } from 'vitest';
import { createBlockscoutPortfolio, type PortfolioProvider } from './portfolio-provider.js';
import { combinePortfolioProviders, createOpenSeaPortfolio, parseOpenSeaPortfolioItem, type OpenSeaPortfolioFetch } from './opensea-portfolio.js';
const KEY = ['portfolio', 'synthetic', 'marker'].join('-');
const WALLET = `0x${'1'.repeat(40)}`;
const CONTRACT = `0x${'2'.repeat(40)}`;
const nft = (identifier = '1', extra: Record<string, unknown> = {}) => ({ contract: CONTRACT, identifier, name: 'Example', token_standard: 'erc721', quantity: 1, quantity_string: '1', ...extra });
function response(body: unknown, status = 200) { return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(body) }; }
function fixture(pages: Array<ReturnType<typeof response> | Error>) {
  let clock = new Date('2026-11-13T00:00:00Z');
  const sleeps: number[] = [];
  const fetcher: OpenSeaPortfolioFetch = vi.fn(async () => { const value = pages.shift() ?? response({ nfts: [], next: null }); if (value instanceof Error) throw value; return value; });
  const provider = createOpenSeaPortfolio({ apiKey: KEY, fetcher, now: () => clock, sleep: async ms => { sleeps.push(ms); } });
  return { provider, fetcher: vi.mocked(fetcher), sleeps, advance: (ms: number) => { clock = new Date(clock.getTime() + ms); } };
}
describe('OpenSea bounded portfolio index', () => {
  it('reads Base at the fixed official account endpoint, preserves exact quantities and caches', async () => {
    const t = fixture([response({ nfts: [nft('1'), nft('2', { token_standard: 'erc1155', quantity: 2147483647, quantity_string: '9007199254740993' })], next: 'opaque cursor=1&more=yes' }), response({ nfts: [nft('3')], next: null })]);
    const result = await t.provider.list(8453, WALLET.toUpperCase().replace('0X', '0x'));
    expect(result.items.map(row => row.tokenId)).toEqual(['1', '2', '3']);
    expect(result.items[1]?.amount).toBe(9007199254740993n);
    expect(result.truncated).toBe(false);
    expect(t.fetcher).toHaveBeenCalledWith(`https://api.opensea.io/api/v2/chain/base/account/${WALLET}/nfts?limit=200&include_auto_hidden=true`, expect.objectContaining({ headers: { accept: 'application/json', 'x-api-key': KEY }, redirect: 'error' }));
    const secondUrl = t.fetcher.mock.calls[1]?.[0];
    expect(new URL(secondUrl!).searchParams.get('next')).toBe('opaque cursor=1&more=yes');
    expect(secondUrl).not.toContain(KEY);
    expect((await t.provider.list(8453, WALLET)).cached).toBe(true);
    expect(t.fetcher).toHaveBeenCalledTimes(2);
    t.advance(300001); await t.provider.list(8453, WALLET);
    expect(t.fetcher).toHaveBeenCalledTimes(3);
  });
  it('deduplicates concurrent requests and same-chain items while keeping chains independent', async () => {
    const t = fixture([response({ nfts: [nft(), nft()], next: null }), response({ nfts: [], next: null })]);
    const [one, two] = await Promise.all([t.provider.list(8453, WALLET), t.provider.list(8453, WALLET)]);
    expect(one.items).toHaveLength(1); expect(two.items).toHaveLength(1);
    expect(t.fetcher).toHaveBeenCalledTimes(1);
    await t.provider.list(1, WALLET); expect(t.fetcher).toHaveBeenCalledTimes(2);
    expect(t.sleeps.some(ms => ms >= 500)).toBe(true);
  });
  it('stops at five pages, detects repeated cursors and marks malformed rows incomplete', async () => {
    const t = fixture(Array.from({ length: 6 }, (_, i) => response({ nfts: [nft(String(i))], next: String(i) })));
    const result = await t.provider.list(8453, WALLET); expect(result.truncated).toBe(true); expect(t.fetcher).toHaveBeenCalledTimes(5);
    const repeated = fixture([response({ nfts: [nft()], next: 'repeat' }), response({ nfts: [nft()], next: 'repeat' })]);
    expect((await repeated.provider.list(8453, WALLET)).truncated).toBe(true); expect(repeated.fetcher).toHaveBeenCalledTimes(2);
    const partial = fixture([response({ nfts: [nft(), nft('2', { quantity_string: 'bad' })], next: null })]);
    expect(await partial.provider.list(8453, WALLET)).toMatchObject({ truncated: true, items: [expect.objectContaining({ tokenId: '1' })] });
  });
  it.each([[401, 'PORTFOLIO_KEY_REJECTED'], [403, 'PORTFOLIO_KEY_REJECTED'], [402, 'PORTFOLIO_CHAIN_NOT_COVERED'], [404, 'PORTFOLIO_CHAIN_NOT_COVERED'], [429, 'PORTFOLIO_RATE_LIMITED'], [500, 'PORTFOLIO_UNAVAILABLE']] as const)('returns only a fixed code for status %s and backs off failures', async (status, code) => {
    const t = fixture([response({ error: KEY }, status)]);
    await expect(t.provider.list(8453, WALLET)).rejects.toThrow(code);
    await expect(t.provider.list(8453, WALLET)).rejects.toThrow(code);
    expect(t.fetcher).toHaveBeenCalledTimes(1);
  });
  it('refuses invalid scope and malformed/oversized responses without forwarding provider text', async () => {
    const t = fixture([new Error(`provider https://api.opensea.io/${KEY}`)]);
    await expect(t.provider.list(8453, WALLET)).rejects.toThrow(/^PORTFOLIO_UNAVAILABLE$/);
    const invalid = fixture([]);
    await expect(invalid.provider.list(8453, 'no-wallet')).rejects.toThrow('PORTFOLIO_WALLET_INVALID');
    await expect(invalid.provider.list(999 as 8453, WALLET)).rejects.toThrow('PORTFOLIO_CHAIN_NOT_COVERED');
    expect(invalid.fetcher).not.toHaveBeenCalled();
    for (const body of [{ wrong: [] }, { nfts: [], next: { url: 'https://elsewhere.invalid' } }, { nfts: [], next: '\n' }, { nfts: Array.from({ length: 201 }, () => nft()) }]) {
      await expect(fixture([response(body)]).provider.list(8453, WALLET)).rejects.toThrow('PORTFOLIO_UNAVAILABLE');
    }
    const huge = createOpenSeaPortfolio({ apiKey: KEY, fetcher: async () => ({ ...response(null), headers: { get: () => '1048577' } }), sleep: async () => undefined });
    await expect(huge.list(8453, WALLET)).rejects.toThrow('PORTFOLIO_UNAVAILABLE');
  });
  it('parses known NFT standards only and never substitutes a truncated numeric amount for malformed exact quantity', () => {
    expect(parseOpenSeaPortfolioItem(nft('5', { name: null }))).toMatchObject({ contract: CONTRACT, tokenId: '5', amount: 1n, name: undefined });
    for (const value of [null, 'bad', nft('5', { contract: 'bad' }), nft('-1'), nft('2', { token_standard: 'erc20' }), nft('2', { quantity_string: '0' }), nft('2', { quantity_string: '2' }), nft('2', { quantity_string: 'bad', quantity: 1 })]) expect(parseOpenSeaPortfolioItem(value)).toBeUndefined();
  });
});
describe('explicit portfolio coverage routing', () => {
  const result = { items: [], truncated: false, asOf: new Date(), cached: false };
  const provider = () => ({ list: vi.fn(async () => result) });
  it('routes Base only to OpenSea, retains configured Blockscout elsewhere and never silently fails over after a rejection', async () => {
    const blockscout = provider(); const openSea = provider();
    const combined = combinePortfolioProviders({ blockscout, openSea })!;
    expect(combined.supportedChains).toEqual([1, 8453, 4663]);
    await combined.list(8453, WALLET); expect(openSea.list).toHaveBeenCalledTimes(1); expect(blockscout.list).not.toHaveBeenCalled();
    await combined.list(1, WALLET); await combined.list(4663, WALLET); expect(blockscout.list).toHaveBeenCalledTimes(2);
    blockscout.list.mockRejectedValueOnce(new Error('PORTFOLIO_RATE_LIMITED'));
    await expect(combined.list(1, WALLET)).rejects.toThrow('PORTFOLIO_RATE_LIMITED'); expect(openSea.list).toHaveBeenCalledTimes(1);
  });
  it('declares unavailable coverage with no configured route, and uses OpenSea only when Blockscout was not configured', async () => {
    expect(combinePortfolioProviders({})).toBeUndefined();
    const blockscout = provider(); const onlyBlockscout = combinePortfolioProviders({ blockscout })!;
    expect(onlyBlockscout.supportedChains).toEqual([1, 4663]);
    await expect(onlyBlockscout.list(8453, WALLET)).rejects.toThrow('PORTFOLIO_CHAIN_NOT_COVERED'); expect(blockscout.list).not.toHaveBeenCalled();
    const openSea = provider(); await combinePortfolioProviders({ openSea })!.list(1, WALLET); expect(openSea.list).toHaveBeenCalledOnce();
  });
  it('refuses Base in the free Blockscout adapter before any paid-plan call', async () => {
    const fetcher = vi.fn(async () => response({ items: [] }));
    const blockscout: PortfolioProvider = createBlockscoutPortfolio({ apiKey: KEY, fetcher });
    await expect(blockscout.list(8453, WALLET)).rejects.toThrow('PORTFOLIO_CHAIN_NOT_COVERED');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
