import { createPublicClient, http, type Address, type PublicClient } from 'viem';
import { mainnet } from 'viem/chains';
import { ChainFactsReader, SeaDropObserver, SeaDropV1PublicStrategy, simulateMint, type DropConfig } from '@mint-bot/engine';
import type { ChainScanOutcome, DropSnapshot, IntelligenceChainPort, SimulationOutcome } from '@mint-bot/backend';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Engine-backed, read-only chain port for Phase 2 intelligence (T-004). It reads
 * logs, drop configuration, code and balances, and runs eth_call simulations.
 * It has no signer and cannot send a transaction.
 */
export class EngineIntelligencePort implements IntelligenceChainPort {
  public readonly chainId = 1 as const;
  private readonly observer: SeaDropObserver;
  private readonly strategy = new SeaDropV1PublicStrategy();

  public constructor(private readonly client: PublicClient, options: { confirmations?: bigint; maxRange?: bigint } = {}) {
    const reader = new ChainFactsReader(client, { chainId: 1, sourceRef: 'intelligence-rpc' });
    this.observer = new SeaDropObserver(reader, { confirmations: options.confirmations ?? 2n, maxRange: options.maxRange ?? 500n });
  }

  /** Builds the port from an RPC URL held only in memory; the URL is never logged or persisted. */
  public static fromRpcUrl(rpcUrl: string): EngineIntelligencePort {
    let parsed: URL;
    try { parsed = new URL(rpcUrl); } catch { throw new Error('INTELLIGENCE_RPC_URL_INVALID'); }
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname))) throw new Error('INTELLIGENCE_RPC_MUST_BE_HTTPS');
    return new EngineIntelligencePort(createPublicClient({ chain: mainnet, transport: http(rpcUrl, { timeout: 15_000, retryCount: 1 }) }) as PublicClient);
  }

  public async safeHead(): Promise<bigint | null> { return this.observer.safeHead(); }

  public async scan(fromBlock: bigint, toBlock: bigint, watched: readonly string[]): Promise<ChainScanOutcome> {
    const outcome = await this.observer.scan(fromBlock, toBlock, watched.filter((address) => ADDRESS.test(address)) as Address[]);
    if (!outcome.ok) return { ok: false, reason: outcome.reason };
    const { result } = outcome;
    return { ok: true, scan: {
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

  public async simulateMint(wallet: string, nftContract: string, quantity: number, valueWei: bigint): Promise<SimulationOutcome> {
    if (!ADDRESS.test(wallet) || !Number.isSafeInteger(quantity) || quantity < 1) return { outcome: 'unknown', reason: 'INVALID_INPUT' };
    const drop = await this.drop(nftContract);
    if (!drop) return { outcome: 'unknown', reason: 'DROP_UNAVAILABLE' };
    try {
      const evidence = await simulateMint(this.client, this.strategy, drop, wallet as Address, quantity, valueWei);
      return evidence.success ? { outcome: 'pass' } : { outcome: 'fail', reason: evidence.revertType ?? 'REVERTED' };
    } catch { return { outcome: 'unknown', reason: 'SIMULATION_UNAVAILABLE' }; }
  }

  private async drop(nftContract: string): Promise<DropConfig | null> {
    if (!ADDRESS.test(nftContract)) return null;
    try { return await this.strategy.readDrop(this.client, nftContract as Address, 1); } catch { return null; }
  }
}
