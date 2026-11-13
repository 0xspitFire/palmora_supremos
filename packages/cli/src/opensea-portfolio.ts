import { OPENSEA_CHAIN_SLUG } from './opensea-client.js';
import { PORTFOLIO_CHAINS, type PortfolioChain, type PortfolioItem, type PortfolioProvider } from './portfolio-provider.js';

/** Official account NFT index: https://docs.opensea.io/reference/get_nfts_by_account.
 * Includes auto-hidden items, but owner-hidden/policy-removed NFTs may still be
 * absent. This is an indexer view, not ownership/finality or spending authority.
 */
export interface OpenSeaPortfolioResponse {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  body?: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}
export type OpenSeaPortfolioFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal; redirect: 'error' }) => Promise<OpenSeaPortfolioResponse>;
const MAX_BODY = 1_048_576;
const MAX_PAGES = 5;
const PAGE_SIZE = 200;
const CACHE_MS = 300_000;
const MAX_CACHE = 64;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^(0|[1-9][0-9]{0,77})$/;
const MAX_UINT256 = (1n << 256n) - 1n;
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const uint = (value: unknown): value is string => typeof value === 'string' && UINT.test(value) && BigInt(value) <= MAX_UINT256;
const SAFE_CODES = new Set(['PORTFOLIO_KEY_REJECTED', 'PORTFOLIO_CHAIN_NOT_COVERED', 'PORTFOLIO_RATE_LIMITED', 'PORTFOLIO_UNAVAILABLE', 'PORTFOLIO_WALLET_INVALID']);
const codeOf = (error: unknown): string => error instanceof Error && SAFE_CODES.has(error.message) ? error.message : 'PORTFOLIO_UNAVAILABLE';

export function parseOpenSeaPortfolioItem(value: unknown): PortfolioItem | undefined {
  const row = object(value);
  if (!row || typeof row['contract'] !== 'string' || !ADDRESS.test(row['contract']) || !uint(row['identifier'])) return undefined;
  const standard = row['token_standard'];
  if (standard !== 'erc721' && standard !== 'erc1155') return undefined;
  // quantity_string is the exact value. The numeric field is only a backwards
  // compatible fallback when no string was supplied and is itself a safe int.
  const quantity = row['quantity_string'] === undefined
    ? typeof row['quantity'] === 'number' && Number.isSafeInteger(row['quantity']) && row['quantity'] > 0 ? String(row['quantity']) : undefined
    : row['quantity_string'];
  if (!uint(quantity) || quantity === '0' || standard === 'erc721' && quantity !== '1') return undefined;
  const name = typeof row['name'] === 'string' && row['name'].length > 0 ? row['name'].slice(0, 256) : undefined;
  return { contract: row['contract'].toLowerCase(), tokenId: row['identifier'], name, type: standard === 'erc721' ? 'ERC-721' : 'ERC-1155', amount: BigInt(quantity) };
}

export function createOpenSeaPortfolio(options: { apiKey: string; fetcher?: OpenSeaPortfolioFetch; now?: () => Date; sleep?: (ms: number) => Promise<void> }): PortfolioProvider {
  if (!options.apiKey || /[\r\n]/.test(options.apiKey)) throw new Error('PORTFOLIO_KEY_REJECTED');
  const fetcher: OpenSeaPortfolioFetch = options.fetcher ?? ((url, init) => fetch(url, init));
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  type Result = Awaited<ReturnType<PortfolioProvider['list']>>;
  const cache = new Map<string, { expiresAt: number; value: Result }>();
  const failures = new Map<string, { expiresAt: number; code: string }>();
  const flights = new Map<string, Promise<Result>>();
  let nextRequestAt = 0;
  let unavailableUntil = 0;
  let queue: Promise<unknown> = Promise.resolve();
  const readBody = async (response: OpenSeaPortfolioResponse): Promise<string> => {
    if (Number(response.headers?.get('content-length') ?? 0) > MAX_BODY) throw new Error('PORTFOLIO_UNAVAILABLE');
    if (!response.body) {
      const text = await response.text();
      if (Buffer.byteLength(text) > MAX_BODY) throw new Error('PORTFOLIO_UNAVAILABLE');
      return text;
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_BODY) { await reader.cancel(); throw new Error('PORTFOLIO_UNAVAILABLE'); }
        chunks.push(chunk.value);
      }
      return Buffer.concat(chunks).toString('utf8');
    } finally { reader.releaseLock(); }
  };
  const request = (chain: string, wallet: string, cursor?: string): Promise<Record<string, unknown>> => {
    const work = queue.then(async () => {
      if (now().getTime() < unavailableUntil) throw new Error('PORTFOLIO_RATE_LIMITED');
      const wait = nextRequestAt - now().getTime();
      if (wait > 0) await sleep(wait);
      nextRequestAt = now().getTime() + 500;
      const query = new URLSearchParams({ limit: String(PAGE_SIZE), include_auto_hidden: 'true', ...(cursor ? { next: cursor } : {}) });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await fetcher(`https://api.opensea.io/api/v2/chain/${chain}/account/${wallet}/nfts?${query.toString()}`, { headers: { accept: 'application/json', 'x-api-key': options.apiKey }, signal: controller.signal, redirect: 'error' });
        if (response.status === 401 || response.status === 403) throw new Error('PORTFOLIO_KEY_REJECTED');
        if (response.status === 404 || response.status === 402) throw new Error('PORTFOLIO_CHAIN_NOT_COVERED');
        if (response.status === 429) {
          const retry = Number(response.headers?.get('retry-after'));
          unavailableUntil = now().getTime() + Math.max(1_000, Math.min(Number.isFinite(retry) && retry > 0 ? retry * 1_000 : 60_000, 300_000));
          throw new Error('PORTFOLIO_RATE_LIMITED');
        }
        if (!response.ok) throw new Error('PORTFOLIO_UNAVAILABLE');
        const result = object(JSON.parse(await readBody(response)));
        if (!result) throw new Error('PORTFOLIO_UNAVAILABLE');
        return result;
      } catch (error) { throw new Error(codeOf(error)); }
      finally { controller.abort(); clearTimeout(timer); }
    });
    queue = work.catch(() => undefined);
    return work;
  };
  return {
    supportedChains: PORTFOLIO_CHAINS,
    async list(chainId, wallet) {
      if (!PORTFOLIO_CHAINS.includes(chainId)) throw new Error('PORTFOLIO_CHAIN_NOT_COVERED');
      if (!ADDRESS.test(wallet)) throw new Error('PORTFOLIO_WALLET_INVALID');
      const address = wallet.toLowerCase();
      const key = `${chainId}:${address}`;
      const hit = cache.get(key);
      if (hit && hit.expiresAt > now().getTime()) return { ...hit.value, cached: true };
      const failed = failures.get(key);
      if (failed && failed.expiresAt > now().getTime()) throw new Error(failed.code);
      const flight = flights.get(key);
      if (flight) return flight;
      const work = (async (): Promise<Result> => {
        const items = new Map<string, PortfolioItem>();
        let cursor: string | undefined;
        let truncated = false;
        const cursors = new Set<string>();
        for (let page = 0; page < MAX_PAGES; page++) {
          const body = await request(OPENSEA_CHAIN_SLUG[chainId]!, address, cursor);
          if (!Array.isArray(body['nfts']) || body['nfts'].length > PAGE_SIZE) throw new Error('PORTFOLIO_UNAVAILABLE');
          for (const raw of body['nfts']) {
            const parsed = parseOpenSeaPortfolioItem(raw);
            if (!parsed) { truncated = true; continue; }
            const identity = `${parsed.contract}:${parsed.tokenId}`;
            const prior = items.get(identity);
            if (prior && prior.amount !== parsed.amount) { truncated = true; continue; }
            items.set(identity, parsed);
          }
          const next = body['next'];
          if (next === null || next === undefined) break;
          if (typeof next !== 'string' || next.length < 1 || next.length > 2_048 || /[\u0000-\u001f\u007f]/.test(next)) throw new Error('PORTFOLIO_UNAVAILABLE');
          if (cursors.has(next) || page === MAX_PAGES - 1) { truncated = true; break; }
          cursors.add(next); cursor = next;
        }
        const value: Result = { items: [...items.values()], truncated, asOf: now(), cached: false };
        cache.set(key, { expiresAt: now().getTime() + CACHE_MS, value });
        if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value!);
        return value;
      })();
      flights.set(key, work);
      try { return await work; }
      catch (error) {
        const code = codeOf(error); failures.set(key, { expiresAt: now().getTime() + 60_000, code });
        if (failures.size > MAX_CACHE) failures.delete(failures.keys().next().value!);
        throw new Error(code);
      } finally { flights.delete(key); }
    },
  };
}

/** Configuration fallback only: provider failures never trigger hidden credit use
 * at a second provider. Base cannot accidentally call a paid Blockscout endpoint.
 */
export function combinePortfolioProviders(options: { blockscout?: PortfolioProvider; openSea?: PortfolioProvider }): PortfolioProvider | undefined {
  if (!options.blockscout && !options.openSea) return undefined;
  const supportedChains = PORTFOLIO_CHAINS.filter(chain => chain === 8453 ? Boolean(options.openSea) : Boolean(options.blockscout || options.openSea));
  return {
    supportedChains,
    async list(chainId: PortfolioChain, wallet: string) {
      if (!supportedChains.includes(chainId)) throw new Error('PORTFOLIO_CHAIN_NOT_COVERED');
      const provider = chainId === 8453 ? options.openSea : options.blockscout ?? options.openSea;
      if (!provider) throw new Error('PORTFOLIO_CHAIN_NOT_COVERED');
      return provider.list(chainId, wallet);
    },
  };
}
