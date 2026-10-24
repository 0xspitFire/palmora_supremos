import { parseAbi } from 'viem';

/**
 * T-072: the ETH price in dollars, for display only (never used by a cap, limit, reservation or guard; those stay in ETH and wei).
 * Primary: Chainlink's ETH / USD price on Ethereum, read through the service's own Ethereum RPC (no account, no key). It is checked
 * (the feed says "ETH / USD", 8 decimals, a positive answer, updated within 3 hours) and refused otherwise.
 * Fallback: Coinbase's public spot price (no key). If neither answers, no dollar value is shown.
 */
export const CHAINLINK_ETH_USD_FEED = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419' as const;
export const CHAINLINK_ABI = parseAbi([
  'function description() view returns (string)',
  'function decimals() view returns (uint8)',
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
]);

export interface EthPrice { usd: number; source: 'chainlink' | 'coinbase'; asOf: Date }
export interface EthPriceProvider { price(): Promise<EthPrice | undefined> }

export interface ChainlinkReader {
  description(): Promise<string>;
  decimals(): Promise<number>;
  latestRoundData(): Promise<{ answer: bigint; updatedAt: Date }>;
}
export interface PriceFetchResponse { ok: boolean; status: number; text(): Promise<string> }
export type PriceFetch = (url: string, init: { signal: AbortSignal; redirect: 'error' }) => Promise<PriceFetchResponse>;

const MAX_AGE_MS = 3 * 3_600_000;
const MAX_FUTURE_MS = 5 * 60_000;
const CACHE_MS = 60_000;
const MIN_USD = 10;
const MAX_USD = 1_000_000;
const MAX_BODY = 10_000;
const COINBASE_URL = 'https://api.coinbase.com/v2/prices/ETH-USD/spot';

export async function readChainlink(reader: ChainlinkReader, now: Date): Promise<EthPrice | undefined> {
  try {
    if ((await reader.description()).trim() !== 'ETH / USD') return undefined;
    const decimals = await reader.decimals();
    if (decimals !== 8) return undefined;
    const round = await reader.latestRoundData();
    const age = now.getTime() - round.updatedAt.getTime();
    if (round.answer <= 0n || !Number.isFinite(age) || age > MAX_AGE_MS || -age > MAX_FUTURE_MS) return undefined;
    const usd = Number(round.answer) / 10 ** decimals;
    return usd >= MIN_USD && usd <= MAX_USD ? { usd, source: 'chainlink', asOf: round.updatedAt } : undefined;
  } catch { return undefined; }
}

export async function readCoinbase(fetcher: PriceFetch, now: Date): Promise<EthPrice | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetcher(COINBASE_URL, { signal: controller.signal, redirect: 'error' });
    if (!response.ok) return undefined;
    const body = await response.text();
    if (body.length > MAX_BODY) return undefined;
    const amount = (JSON.parse(body) as { data?: { amount?: unknown; base?: unknown; currency?: unknown } }).data;
    if (!amount || amount.base !== 'ETH' || amount.currency !== 'USD' || typeof amount.amount !== 'string' || !/^\d{1,9}(\.\d{1,8})?$/.test(amount.amount)) return undefined;
    const usd = Number(amount.amount);
    return usd >= MIN_USD && usd <= MAX_USD ? { usd, source: 'coinbase', asOf: now } : undefined;
  } catch { return undefined; } finally { clearTimeout(timer); }
}

export function createEthPriceProvider(options: { chainlink?: ChainlinkReader; fetcher?: PriceFetch; now?: () => Date }): EthPriceProvider {
  const now = options.now ?? (() => new Date());
  const fetcher: PriceFetch = options.fetcher ?? ((url, init) => fetch(url, init));
  let cached: { at: number; value: EthPrice | undefined } | undefined;
  return {
    async price() {
      if (cached && now().getTime() - cached.at < CACHE_MS) return cached.value;
      const at = now();
      const value = (options.chainlink ? await readChainlink(options.chainlink, at) : undefined) ?? await readCoinbase(fetcher, at);
      cached = { at: at.getTime(), value };
      return value;
    },
  };
}

/** "$1.23": cut to whole cents, never rounded up; under one cent it says so. */
export function usdText(ethAmount: number, price: EthPrice): string {
  const cents = Math.floor(ethAmount * price.usd * 100 + 1e-9);
  if (cents <= 0) return ethAmount > 0 ? '<$0.01' : '$0.00';
  return `$${Math.floor(cents / 100).toLocaleString('en-US')}.${String(cents % 100).padStart(2, '0')}`;
}
