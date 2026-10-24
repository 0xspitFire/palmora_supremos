import { describe, expect, it } from 'vitest';
import { createOpenSeaFloors, type OpenSeaFetch } from './opensea-client.js';

/** T-072: OpenSea floor prices: the key stays in a header, answers are checked, failures are fixed codes and are remembered briefly. */
const KEY = ['os', 'key', '1234567890abcdef'].join('_');
const A = '0x23581767a106ae21c074b2276d25e5c3e136a68b';
const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const stats = (floor: unknown, symbol: unknown = 'ETH') => ({ total: { floor_price: floor, floor_price_symbol: symbol, volume: 1 } });

function client(responses: Array<ReturnType<typeof reply> | Error>) {
  const calls: Array<{ url: string; headers: Record<string, string>; redirect: string }> = [];
  let clock = new Date('2026-10-25T12:00:00.000Z');
  const fetcher: OpenSeaFetch = async (url, init) => { calls.push({ url, headers: init.headers, redirect: init.redirect }); const next = responses.shift() ?? reply(500, {}); if (next instanceof Error) throw next; return next; };
  return { floors: createOpenSeaFloors({ apiKey: KEY, fetcher, now: () => clock, sleep: async () => undefined }), calls, advance: (ms: number) => { clock = new Date(clock.getTime() + ms); } };
}

describe('OpenSea floors', () => {
  it('finds the collection, then its floor in ETH, with the key only in the header and no redirects', async () => {
    const t = client([reply(200, { collection: 'moonbirds', chain: 'ethereum' }), reply(200, stats(0.484))]);
    expect(await t.floors.floor(1, A)).toEqual({ collection: 'moonbirds', floorEth: 0.484 });
    expect(t.calls[0]!.url).toBe(`https://api.opensea.io/api/v2/chain/ethereum/contract/${A}`);
    expect(t.calls[1]!.url).toBe('https://api.opensea.io/api/v2/collections/moonbirds/stats');
    for (const call of t.calls) { expect(call.url).not.toContain(KEY); expect(call.headers['x-api-key']).toBe(KEY); expect(call.redirect).toBe('error'); }
  });

  it('uses the Robinhood and Base chain names, and refuses a chain it does not know', async () => {
    const t = client([reply(200, { collection: 'rekt-tradooor' }), reply(200, stats(0.0468878)), reply(200, { collection: 'based' }), reply(200, stats(0.01))]);
    await t.floors.floor(4663, A);
    await t.floors.floor(8453, '0x1111111111111111111111111111111111111111');
    expect(t.calls[0]!.url).toContain('/chain/robinhood/');
    expect(t.calls[2]!.url).toContain('/chain/base/');
    await expect(t.floors.floor(10, A)).rejects.toThrow('OPENSEA_CHAIN_NOT_COVERED');
    await expect(t.floors.floor(1, 'nope')).rejects.toThrow('OPENSEA_CONTRACT_INVALID');
  });

  it('keeps an answer for 10 minutes and the collection for a day', async () => {
    const t = client([reply(200, { collection: 'moonbirds' }), reply(200, stats(0.5)), reply(200, stats(0.6))]);
    await t.floors.floor(1, A); await t.floors.floor(1, A);
    expect(t.calls).toHaveLength(2);
    t.advance(10 * 60_000 + 1);
    expect((await t.floors.floor(1, A)).floorEth).toBe(0.6);
    expect(t.calls).toHaveLength(3);
    expect(t.calls[2]!.url).toContain('/collections/moonbirds/stats');
  });

  it('never invents a floor: another currency, a missing, negative or text value means "no floor known"', async () => {
    for (const body of [stats(0.5, 'USDC'), stats(null), stats(-1), stats('0.5'), { total: {} }, {}]) {
      const t = client([reply(200, { collection: 'x' }), reply(200, body)]);
      expect((await t.floors.floor(1, A)).floorEth, JSON.stringify(body)).toBeUndefined();
    }
  });

  it('turns each failure into a fixed code, never shows the key, and remembers a failure for a minute', async () => {
    for (const [response, code] of [[reply(401, {}), 'OPENSEA_KEY_REJECTED'], [reply(403, {}), 'OPENSEA_KEY_REJECTED'], [reply(404, {}), 'OPENSEA_NOT_FOUND'], [reply(429, {}), 'OPENSEA_RATE_LIMITED'], [reply(500, {}), 'OPENSEA_UNAVAILABLE'], [reply(200, 'not json'), 'OPENSEA_UNAVAILABLE'], [reply(200, { collection: 'Bad Slug!' }), 'OPENSEA_NOT_FOUND'], [new Error(`connect failed ${KEY}`), 'OPENSEA_UNAVAILABLE']] as const) {
      const t = client([response]);
      const error = await t.floors.floor(1, A).then(() => undefined, (caught: Error) => caught);
      expect(error?.message).toBe(code);
      expect(error?.message).not.toContain(KEY);
      await expect(t.floors.floor(1, A)).rejects.toThrow(code);
      expect(t.calls).toHaveLength(1);
    }
  });
});
