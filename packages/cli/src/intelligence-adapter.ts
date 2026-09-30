import { createPublicClient, http, type Address, type PublicClient } from 'viem';
import { mainnet } from 'viem/chains';
import { ChainFactsReader, SeaDropObserver, SeaDropV1PublicStrategy, simulateMint, type DropConfig } from '@mint-bot/engine';
import type { ChainScanOutcome, DropSnapshot, IntelligenceChainPort, SimulationOutcome } from '@mint-bot/backend';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function isRateLimit(detail: string | undefined): boolean {
  return detail !== undefined && /HTTP 429|rate.?limit|too many requests|throttl|exceeded.*(?:capacity|quota|compute units)/i.test(detail);
}

/**
 * Engine-backed, read-only chain port for Phase 2 intelligence (T-004). It reads
 * logs, drop configuration, code and balances, and runs eth_call simulations.
 * It has no signer and cannot send a transaction.
 */
export class EngineIntelligencePort implements IntelligenceChainPort {
  public readonly chainId = 1 as const;
  private readonly observer: SeaDropObserver;
  private readonly strategy = new SeaDropV1PublicStrategy();
  /** Blocks per request; adapts to the provider's getLogs limits (halves on rejection, grows after steady success). */
  private range: bigint;
  private readonly maxRange: bigint;
  private successes = 0;

  public constructor(private readonly client: PublicClient, options: { confirmations?: bigint; maxRange?: bigint; initialRange?: bigint } = {}) {
    const reader = new ChainFactsReader(client, { chainId: 1, sourceRef: 'intelligence-rpc' });
    this.maxRange = options.maxRange ?? 500n;
    this.range = options.initialRange ?? 100n;
    if (this.maxRange < 1n || this.range < 1n || this.range > this.maxRange) throw new Error('INTELLIGENCE_RANGE_INVALID');
    this.observer = new SeaDropObserver(reader, { confirmations: options.confirmations ?? 2n, maxRange: this.maxRange });
  }

  /** Current blocks-per-request, for diagnostics and tests. */
  public currentRange(): bigint { return this.range; }

  /** Builds the port from an RPC URL held only in memory; the URL is never logged or persisted. */
  public static fromRpcUrl(rpcUrl: string): EngineIntelligencePort {
    let parsed: URL;
    try { parsed = new URL(rpcUrl); } catch { throw new Error('INTELLIGENCE_RPC_URL_INVALID'); }
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname))) throw new Error('INTELLIGENCE_RPC_MUST_BE_HTTPS');
    return new EngineIntelligencePort(createPublicClient({ chain: mainnet, transport: http(rpcUrl, { timeout: 15_000, retryCount: 1 }) }) as PublicClient);
  }

  public async safeHead(): Promise<bigint | null> { return this.observer.safeHead(); }

  public async scan(fromBlock: bigint, toBlock: bigint, watched: readonly string[]): Promise<ChainScanOutcome> {
    const addresses = watched.filter((address) => ADDRESS.test(address)) as Address[];
    let outcome = await this.observer.scan(fromBlock, this.clamp(fromBlock, toBlock), addresses);
    // A rejected request usually means the range is above the provider's limit: halve and retry.
    // Rate limiting is different: shrinking would only add requests, so wait for the next tick instead.
    while (!outcome.ok && outcome.reason === 'LOGS_UNAVAILABLE' && !isRateLimit(outcome.detail) && this.range > 1n) {
      this.range = this.range / 2n > 1n ? this.range / 2n : 1n;
      this.successes = 0;
      outcome = await this.observer.scan(fromBlock, this.clamp(fromBlock, toBlock), addresses);
    }
    if (!outcome.ok) return { ok: false, reason: isRateLimit(outcome.detail) ? `RATE_LIMITED: ${outcome.detail ?? ''}` : `${outcome.reason}${outcome.detail ? `: ${outcome.detail}` : ''}` };
    this.successes += 1;
    if (this.successes >= 10 && this.range < this.maxRange) { this.range = this.range * 2n < this.maxRange ? this.range * 2n : this.maxRange; this.successes = 0; }
    const { result } = outcome;
    return { ok: true, scan: {
      watchedUnavailable: result.watchedUnavailable,
      fromBlock: result.fromBlock,
      toBlock: result.toBlock,
      mints: result.mints.map((mint) => ({ nftContract: mint.nftContract, minter: mint.minter, payer: mint.payer, quantity: mint.quantity, unitPriceWei: mint.unitMintPriceWei, blockNumber: mint.blockNumber, txHash: mint.transactionHash, logIndex: mint.logIndex })),
      dropUpdates: result.dropUpdates.map((update) => ({ nftContract: update.nftContract, mintPriceWei: update.mintPriceWei, startTime: update.startTime, endTime: update.endTime, maxPerWallet: update.maxTotalMintableByWallet, blockNumber: update.blockNumber })),
      watchedMints: result.watchedMints.map((mint) => ({ nftContract: mint.nftContract, recipient: mint.recipient, blockNumber: mint.blockNumber, txHash: mint.transactionHash, logIndex: mint.logIndex })),
    } };
  }

  public async readDrop(nftContract: string): Promise<DropSnapshot | null> {
    const drop = await this.drop(nftContract);
    if (!drop) return null;
    const extra = drop.extra ?? {};
    return { nftContract: nftContract.toLowerCase(), priceWei: drop.mintPrice, startTime: drop.startTime, endTime: drop.endTime, maxPerWallet: drop.maxTotalMintableByWallet, maxSupply: extra.maxSupplyKnown === false ? null : drop.maxTokenSupply, totalMinted: extra.totalSupplyKnown === false ? null : drop.totalMinted };
  }

  public async hasCode(address: string): Promise<boolean | null> {
    if (!ADDRESS.test(address)) return null;
    try { const code = await this.client.getCode({ address: address as Address }); return code !== undefined && code !== '0x'; } catch { return null; }
  }

  public async balance(address: string): Promise<bigint | null> {
    if (!ADDRESS.test(address)) return null;
    try { return await this.client.getBalance({ address: address as Address }); } catch { return null; }
  }

  /** Read-only gas estimate for minting `quantity` NFTs from `wallet` (eth_estimateGas; nothing is sent). */
  public async estimateMintGas(wallet: string, nftContract: string, quantity: number, valueWei: bigint): Promise<bigint | null> {
    if (!ADDRESS.test(wallet) || !Number.isSafeInteger(quantity) || quantity < 1 || valueWei < 0n) return null;
    const drop = await this.cachedDrop(nftContract);
    if (!drop) return null;
    try {
      const to = (drop.extra?.['seaDropAddress'] as Address | undefined) ?? drop.nftContract;
      return await this.client.estimateGas({ account: wallet as Address, to, data: this.strategy.buildCalldata(drop, wallet as Address, quantity), value: valueWei });
    } catch { return null; }
  }

  /** Current base fee per gas in wei, or null when the node does not report one. */
  public async baseFeePerGasWei(): Promise<bigint | null> {
    try { const block = await this.client.getBlock(); return block.baseFeePerGas ?? null; } catch { return null; }
  }

  public async simulateMint(wallet: string, nftContract: string, quantity: number, valueWei: bigint): Promise<SimulationOutcome> {
    if (!ADDRESS.test(wallet) || !Number.isSafeInteger(quantity) || quantity < 1) return { outcome: 'unknown', reason: 'INVALID_INPUT' };
    const drop = await this.drop(nftContract);
    if (!drop) return { outcome: 'unknown', reason: 'DROP_UNAVAILABLE' };
    try {
      const evidence = await simulateMint(this.client, this.strategy, drop, wallet as Address, quantity, valueWei);
      return evidence.success ? { outcome: 'pass' } : { outcome: 'fail', reason: evidence.revertType ?? 'REVERTED' };
    } catch { return { outcome: 'unknown', reason: 'SIMULATION_UNAVAILABLE' }; }
  }

  /** Drop configuration cached for 60 seconds, so quantity planning does not re-read it for every estimate. */
  private readonly dropCache = new Map<string, { at: number; drop: DropConfig }>();
  private async cachedDrop(nftContract: string): Promise<DropConfig | null> {
    const key = nftContract.toLowerCase();
    const hit = this.dropCache.get(key);
    if (hit && Date.now() - hit.at < 60_000) return hit.drop;
    const drop = await this.drop(nftContract);
    if (drop) { this.dropCache.set(key, { at: Date.now(), drop }); if (this.dropCache.size > 100) this.dropCache.delete(this.dropCache.keys().next().value as string); }
    return drop;
  }

  private clamp(fromBlock: bigint, toBlock: bigint): bigint {
    return toBlock - fromBlock + 1n > this.range ? fromBlock + this.range - 1n : toBlock;
  }

  private async drop(nftContract: string): Promise<DropConfig | null> {
    if (!ADDRESS.test(nftContract)) return null;
    try { return await this.strategy.readDrop(this.client, nftContract as Address, 1); } catch { return null; }
  }
}
