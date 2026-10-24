/**
 * T-072: collection floor prices from OpenSea's API v2 (read-only, off the mint path), for the value shown next to `/portfolio`.
 * Routes confirmed by the owner's probe (2026-10-25): GET /api/v2/chain/{chain}/contract/{address} gives the collection slug, then
 * GET /api/v2/collections/{slug}/stats gives total.floor_price in ETH. The key goes in the `x-api-key` header, never in the address.
 * The floor is an estimate of listing prices, not what a sale would fetch.
 */
export const OPENSEA_CHAIN_SLUG: Readonly<Record<number, string>> = { 1: 'ethereum', 8453: 'base', 4663: 'robinhood' };

export interface OpenSeaResponse { ok: boolean; status: number; headers?: { get(name: string): string | null }; text(): Promise<string> }
export type OpenSeaFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal; redirect: 'error' }) => Promise<OpenSeaResponse>;

export interface FloorResult { collection: string; floorEth: number | undefined }
export interface OpenSeaFloors { floor(chainId: number, contract: string): Promise<FloorResult> }

const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;
const BASE = 'https://api.opensea.io';
const TIMEOUT_MS = 10_000;
const MAX_BODY = 500_000;
const MIN_GAP_MS = 500;
const STATS_CACHE_MS = 10 * 60_000;
const SLUG_CACHE_MS = 24 * 3_600_000;
const FAILURE_CACHE_MS = 60_000;

export function createOpenSeaFloors(options: { apiKey: string; fetcher?: OpenSeaFetch; now?: () => Date; sleep?: (ms: number) => Promise<void> }): OpenSeaFloors {
  const fetcher: OpenSeaFetch = options.fetcher ?? ((url, init) => fetch(url, init));
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const slugs = new Map<string, { at: number; slug: string }>();
  const stats = new Map<string, { at: number; value: FloorResult }>();
  const failures = new Map<string, { at: number; code: string }>();
  // Two commands asking for the same collection at once share one lookup.
  const inFlight = new Map<string, Promise<FloorResult>>();
  // One request at a time, at least 500 ms apart (2 a second; the key allows 120 a minute).
  let queue: Promise<unknown> = Promise.resolve();
  let lastAt = 0;
  const spaced = <T,>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(async () => { const wait = lastAt + MIN_GAP_MS - Date.now(); if (wait > 0) await sleep(wait); lastAt = Date.now(); return work(); });
    queue = run.catch(() => undefined);
    return run;
  };
  const call = async (path: string): Promise<Record<string, unknown>> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetcher(`${BASE}${path}`, { headers: { accept: 'application/json', 'x-api-key': options.apiKey }, signal: controller.signal, redirect: 'error' });
      if (response.status === 401 || response.status === 403) throw new Error('OPENSEA_KEY_REJECTED');
      if (response.status === 404) throw new Error('OPENSEA_NOT_FOUND');
      if (response.status === 429) throw new Error('OPENSEA_RATE_LIMITED');
      if (!response.ok) throw new Error('OPENSEA_UNAVAILABLE');
      // A declared size over the cap is refused before the body is read; the length is checked again after reading.
      if (Number(response.headers?.get('content-length') ?? 0) > MAX_BODY) throw new Error('OPENSEA_UNAVAILABLE');
      const body = await response.text();
      if (body.length > MAX_BODY) throw new Error('OPENSEA_UNAVAILABLE');
      const parsed = JSON.parse(body) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('OPENSEA_UNAVAILABLE');
      return parsed as Record<string, unknown>;
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      throw new Error(/^OPENSEA_[A-Z_]+$/.test(code) ? code : 'OPENSEA_UNAVAILABLE');
    } finally { clearTimeout(timer); }
  };
  const lookup = async (chainId: number, contract: string, key: string): Promise<FloorResult> => {
    const chain = OPENSEA_CHAIN_SLUG[chainId];
    if (!chain) throw new Error('OPENSEA_CHAIN_NOT_COVERED');
    let slug = slugs.get(key);
    if (!slug || now().getTime() - slug.at > SLUG_CACHE_MS) {
      const info = await spaced(() => call(`/api/v2/chain/${chain}/contract/${contract}`));
      const found = typeof info['collection'] === 'string' ? info['collection'] : undefined;
      if (!found || !SLUG.test(found)) throw new Error('OPENSEA_NOT_FOUND');
      slug = { at: now().getTime(), slug: found };
      slugs.set(key, slug);
    }
    const body = await spaced(() => call(`/api/v2/collections/${slug!.slug}/stats`));
    const total = body['total'] && typeof body['total'] === 'object' ? body['total'] as Record<string, unknown> : undefined;
    const floor = total?.['floor_price'];
    const symbol = total?.['floor_price_symbol'];
    // Only an ETH floor counts; another currency, a missing or a negative number means "no floor known" (never invented).
    const floorEth = typeof floor === 'number' && Number.isFinite(floor) && floor >= 0 && (symbol === 'ETH' || symbol === 'WETH') ? floor : undefined;
    return { collection: slug.slug, floorEth };
  };
  return {
    async floor(chainId, contract) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(contract)) throw new Error('OPENSEA_CONTRACT_INVALID');
      const key = `${chainId}:${contract.toLowerCase()}`;
      const hit = stats.get(key);
      if (hit && now().getTime() - hit.at < STATS_CACHE_MS) return hit.value;
      const failed = failures.get(key);
      if (failed && now().getTime() - failed.at < FAILURE_CACHE_MS) throw new Error(failed.code);
      const pending = inFlight.get(key);
      if (pending) return pending;
      const work = (async () => {
        try {
          const value = await lookup(chainId, contract.toLowerCase(), key);
          stats.set(key, { at: now().getTime(), value });
          return value;
        } catch (error) {
          const code = error instanceof Error && /^OPENSEA_[A-Z_]+$/.test(error.message) ? error.message : 'OPENSEA_UNAVAILABLE';
          failures.set(key, { at: now().getTime(), code });
          throw new Error(code);
        } finally { inFlight.delete(key); }
      })();
      inFlight.set(key, work);
      return work;
    },
  };
}
