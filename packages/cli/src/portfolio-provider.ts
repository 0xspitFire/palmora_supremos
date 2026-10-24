/**
 * T-068: the owner's full NFT list per wallet from Blockscout's PRO API (read-only, off the mint path; D-068 pending).
 * Free key (dev.blockscout.com): 5 requests a second, 100,000 credits a day, 20 credits a call. Covers Ethereum and Robinhood; Base needs a paid plan
 * (HTTP 402 on the free plan), so Base is reported as not covered and `/holdings` (exact chain reads) stays the source for MintBot's own mints.
 */
export type PortfolioChain = 1 | 4663;
export const PORTFOLIO_CHAINS: readonly PortfolioChain[] = [1, 4663];

export interface PortfolioItem { contract: string | undefined; name: string | undefined; tokenId: string | undefined; type: string; amount: bigint }
export interface PortfolioFetchResponse { ok: boolean; status: number; json(): Promise<unknown> }
export type PortfolioFetch = (url: string, init: { signal: AbortSignal }) => Promise<PortfolioFetchResponse>;

export interface PortfolioProvider {
  /** All NFTs a wallet holds on one chain (at most 5 pages). Throws a fixed code when the provider cannot answer. */
  list(chainId: PortfolioChain, wallet: string): Promise<{ items: PortfolioItem[]; truncated: boolean; asOf: Date; cached: boolean }>;
}

const MAX_PAGES = 5;
const CACHE_MS = 5 * 60_000;
const MIN_GAP_MS = 250;
const TIMEOUT_MS = 10_000;
const BASE_URL = 'https://api.blockscout.com';

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined);
const record = (value: unknown): Record<string, unknown> | undefined => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined);

/** Reads one Blockscout item. Fields the provider does not give stay undefined; nothing is invented. */
export function parseItem(raw: unknown): PortfolioItem | undefined {
  const item = record(raw);
  if (!item) return undefined;
  const token = record(item['token']);
  const contract = text(token?.['address_hash']) ?? text(token?.['address']);
  const type = text(item['token_type']) ?? text(token?.['type']) ?? 'unknown';
  const value = text(item['value']);
  const amount = value && /^\d{1,30}$/.test(value) ? BigInt(value) : 1n;
  return { contract: contract && /^0x[0-9a-fA-F]{40}$/.test(contract) ? contract.toLowerCase() : undefined, name: text(token?.['name']), tokenId: text(item['id']), type, amount };
}

export function createBlockscoutPortfolio(options: { apiKey: string; fetcher?: PortfolioFetch; now?: () => Date; sleep?: (ms: number) => Promise<void> }): PortfolioProvider {
  const fetcher: PortfolioFetch = options.fetcher ?? ((url, init) => fetch(url, init));
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const cache = new Map<string, { at: number; value: { items: PortfolioItem[]; truncated: boolean; asOf: Date } }>();
  // One request at a time leaves the provider, at least 250 ms apart (4 a second, under its 5).
  let queue: Promise<unknown> = Promise.resolve();
  let lastAt = 0;
  const spaced = <T,>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(async () => { const wait = lastAt + MIN_GAP_MS - Date.now(); if (wait > 0) await sleep(wait); lastAt = Date.now(); return work(); });
    queue = run.catch(() => undefined);
    return run;
  };
  const call = async (url: string): Promise<unknown> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetcher(url, { signal: controller.signal });
      if (response.status === 402) throw new Error('PORTFOLIO_CHAIN_NOT_COVERED');
      if (response.status === 429) throw new Error('PORTFOLIO_RATE_LIMITED');
      if (response.status === 401 || response.status === 403) throw new Error('PORTFOLIO_KEY_REJECTED');
      if (!response.ok) throw new Error('PORTFOLIO_UNAVAILABLE');
      return await response.json();
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      throw new Error(/^PORTFOLIO_[A-Z_]+$/.test(code) ? code : 'PORTFOLIO_UNAVAILABLE');
    } finally { clearTimeout(timer); }
  };
  return {
    async list(chainId, wallet) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) throw new Error('PORTFOLIO_WALLET_INVALID');
      const key = `${chainId}:${wallet.toLowerCase()}`;
      const hit = cache.get(key);
      if (hit && now().getTime() - hit.at < CACHE_MS) return { ...hit.value, cached: true };
      const items: PortfolioItem[] = [];
      let params: Record<string, unknown> | undefined;
      let truncated = false;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const query = new URLSearchParams({ apikey: options.apiKey });
        for (const [name, value] of Object.entries(params ?? {})) if (typeof value === 'string' || typeof value === 'number') query.set(name, String(value));
        const body = record(await spaced(() => call(`${BASE_URL}/${chainId}/api/v2/addresses/${wallet.toLowerCase()}/nft?${query.toString()}`)));
        if (!body || !Array.isArray(body['items'])) throw new Error('PORTFOLIO_UNAVAILABLE');
        for (const raw of body['items']) { const parsed = parseItem(raw); if (parsed) items.push(parsed); }
        params = record(body['next_page_params']);
        if (!params) break;
        if (page === MAX_PAGES - 1) truncated = true;
      }
      const value = { items, truncated, asOf: now() };
      cache.set(key, { at: now().getTime(), value });
      return { ...value, cached: false };
    },
  };
}
