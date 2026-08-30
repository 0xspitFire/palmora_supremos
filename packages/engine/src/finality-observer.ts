import type { Hash } from 'viem';
import type { FinalityStage, SupportedChainId } from './types.js';

export interface FinalityObservation {
  readonly chainId: SupportedChainId;
  readonly stage: FinalityStage;
  readonly canonical: boolean;
  readonly ready: boolean;
  readonly observedAt: Date;
  readonly reason?: string;
}

export interface FinalityObserver {
  observe(input: { txHash: Hash; txBlockNumber: bigint }): Promise<FinalityObservation>;
}

export interface FinalitySources {
  readonly chainId: SupportedChainId;
  currentBlockNumber(): Promise<bigint>;
  receiptBlockHash?(txHash: Hash): Promise<Hash | null>;
  readonly expectedBlockHash?: Hash;
}

export class EthereumFinalityObserver implements FinalityObserver {
  constructor(private readonly sources: FinalitySources, private readonly confirmationDepth: number) {
    if (sources.chainId !== 1) throw new Error('EthereumFinalityObserver requires chain ID 1');
  }

  async observe(input: { txHash: Hash; txBlockNumber: bigint }): Promise<FinalityObservation> {
    const canonical = await isCanonical(this.sources, input.txHash);
    const confirmations = Number(await this.sources.currentBlockNumber() - input.txBlockNumber) + 1;
    const ready = canonical && confirmations >= this.confirmationDepth;
    return {
      chainId: 1,
      stage: 'confirmed',
      canonical,
      ready,
      observedAt: new Date(),
      reason: ready ? undefined : canonical ? 'confirmation-depth-pending' : 'receipt-not-canonical',
    };
  }
}

export interface RobinhoodFinalitySources extends FinalitySources {
  isPosted(txHash: Hash, txBlockNumber: bigint): Promise<boolean>;
  isEthereumFinal(txHash: Hash, txBlockNumber: bigint): Promise<boolean>;
}

export class RobinhoodFinalityObserver implements FinalityObserver {
  constructor(private readonly sources: RobinhoodFinalitySources, private readonly confirmationDepth: number) {
    if (sources.chainId !== 4663) throw new Error('RobinhoodFinalityObserver requires chain ID 4663');
  }

  async observe(input: { txHash: Hash; txBlockNumber: bigint }): Promise<FinalityObservation> {
    const canonical = await isCanonical(this.sources, input.txHash);
    if (!canonical) return observation('soft', false, false, 'receipt-not-canonical');
    const confirmations = Number(await this.sources.currentBlockNumber() - input.txBlockNumber) + 1;
    if (confirmations < this.confirmationDepth) return observation('soft', true, false, 'confirmation-depth-pending');
    if (await this.sources.isEthereumFinal(input.txHash, input.txBlockNumber)) return observation('ethereum_final', true, true);
    if (await this.sources.isPosted(input.txHash, input.txBlockNumber)) return observation('posted', true, false, 'ethereum-finality-pending');
    return observation('soft', true, false, 'l1-posting-pending');
  }
}

async function isCanonical(sources: FinalitySources, txHash: Hash): Promise<boolean> {
  if (!sources.receiptBlockHash || !sources.expectedBlockHash) return true;
  const observed = await sources.receiptBlockHash(txHash);
  return observed?.toLowerCase() === sources.expectedBlockHash.toLowerCase();
}

function observation(stage: FinalityStage, canonical: boolean, ready: boolean, reason?: string): FinalityObservation {
  return { chainId: 4663, stage, canonical, ready, observedAt: new Date(), reason };
}
