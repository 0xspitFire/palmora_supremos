/**
 * Read-only chain port for Phase 2 intelligence (T-004). Backend owns scoring,
 * aggregation and persistence; the CLI composition root implements this port with
 * the engine's SeaDropObserver and ChainFactsReader. Nothing here signs or sends.
 */
/** Log identity (txHash, logIndex) lets discovery count each log once even if a range is rescanned. */
export interface LogIdentity { txHash?: string | null; logIndex?: number | null; }
export interface ObservedMint extends LogIdentity { nftContract: string; minter: string; payer: string; quantity: bigint; unitPriceWei: bigint; blockNumber: bigint; }
export interface ObservedDropUpdate { nftContract: string; mintPriceWei: bigint; startTime: number; endTime: number; maxPerWallet: number; blockNumber: bigint; }
export interface ObservedWatchedMint extends LogIdentity { nftContract: string; recipient: string; blockNumber: bigint; }
export interface ChainScan { fromBlock: bigint; toBlock: bigint; mints: ObservedMint[]; dropUpdates: ObservedDropUpdate[]; watchedMints: ObservedWatchedMint[]; /** Watched-wallet evidence could not be read for part of this range. */ watchedUnavailable?: boolean; }
export type ChainScanOutcome = { ok: true; scan: ChainScan } | { ok: false; reason: string };

/** A public SeaDrop drop as read from chain; null fields are unknown, never zero. */
export interface DropSnapshot { nftContract: string; priceWei: bigint; startTime: number; endTime: number; maxPerWallet: number; maxSupply: bigint | null; totalMinted: bigint | null; }
export type SimulationOutcome = { outcome: 'pass' } | { outcome: 'fail'; reason: string } | { outcome: 'unknown'; reason: string };

export interface IntelligenceChainPort {
  readonly chainId: 1;
  /** Highest block considered settled, or null when the chain head is unavailable. */
  safeHead(): Promise<bigint | null>;
  scan(fromBlock: bigint, toBlock: bigint, watched: readonly string[]): Promise<ChainScanOutcome>;
  /** Public SeaDrop drop for a contract, or null when it has none or it cannot be read. */
  readDrop(nftContract: string): Promise<DropSnapshot | null>;
  hasCode(address: string): Promise<boolean | null>;
  balance(address: string): Promise<bigint | null>;
  /** eth_call of the SeaDrop public mint for one wallet; read-only. */
  simulateMint(wallet: string, nftContract: string, quantity: number, valueWei: bigint): Promise<SimulationOutcome>;
  /** Gas estimate for minting `quantity` NFTs from `wallet`, or null when it cannot be estimated (optional: T-012). */
  estimateMintGas?(wallet: string, nftContract: string, quantity: number, valueWei: bigint): Promise<bigint | null>;
  /** Current base fee per gas in wei, or null when unknown (optional: T-012). */
  baseFeePerGasWei?(): Promise<bigint | null>;
}

export interface IntelligenceRepositoryPort {
  observedAddresses(chainId: number): ReadonlyArray<{ address: string }>;
  cursor(chainId: number, source: string): bigint | undefined;
  advanceCursor(chainId: number, source: string, lastBlock: bigint): void;
}

export interface IntelligenceAlertSink {
  intelligence(input: { kind: 'opportunity' | 'opening_soon' | 'eligible_ready' | 'underfunded' | 'price_above_limit' | 'status' | 'quantity_reduced'; dedupe: string; text: string; priority: 'immediate' | 'grouped' }): Promise<boolean>;
}

/** D-015 freshness windows. */
export const DISCOVERY_FRESHNESS_MS = 15 * 60_000;
export const READINESS_FRESHNESS_MS = 5 * 60_000;

/** Latest timestamp accepted from chain data (2200-01-01). uint48 values beyond it are treated as untrusted. */
export const MAX_CHAIN_TIME_SECONDS = 7_258_118_400;
export function validChainTime(seconds: number): boolean { return Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= MAX_CHAIN_TIME_SECONDS; }

export function opportunityId(chainId: number, contract: string): string { return `seadrop:${chainId}:${contract.toLowerCase()}`; }
export function calendarId(chainId: number, contract: string): string { return `calendar:${chainId}:${contract.toLowerCase()}`; }
export function shortAddress(address: string): string { return `${address.slice(0, 6)}…${address.slice(-4)}`; }
