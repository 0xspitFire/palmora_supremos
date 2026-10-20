import type { Hash } from 'viem';
import type { FinalityStage, SupportedChainId } from './types.js';

export interface FinalityObservation {
  readonly chainId: SupportedChainId;
  readonly stage: FinalityStage;
  /** Null means canonicality could not be proven from the configured source. */
  readonly canonical: boolean | null;
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
  canonicalBlockHash?(blockNumber: bigint): Promise<Hash | null>;
  readonly expectedBlockHash?: Hash;
}

export class EthereumFinalityObserver implements FinalityObserver {
  constructor(private readonly sources: FinalitySources, private readonly confirmationDepth: number, private readonly now: () => Date = () => new Date()) {
    if (sources.chainId !== 1) throw new Error('EthereumFinalityObserver requires chain ID 1');
  }

  async observe(input: { txHash: Hash; txBlockNumber: bigint }): Promise<FinalityObservation> {
    const canonical = await isCanonical(this.sources, input.txHash, input.txBlockNumber);
    const confirmations = safeConfirmations(await this.sources.currentBlockNumber(), input.txBlockNumber);
    const ready = canonical === true && confirmations >= this.confirmationDepth;
    return {
      chainId: 1,
      stage: 'confirmed',
      canonical,
      ready,
      observedAt: this.now(),
      reason: ready ? undefined : canonical === null ? 'canonicality-unknown' : canonical ? 'confirmation-depth-pending' : 'receipt-not-canonical',
    };
  }
}

export interface RobinhoodFinalitySources extends FinalitySources {
  isPosted(txHash: Hash, txBlockNumber: bigint): Promise<boolean>;
  isEthereumFinal(txHash: Hash, txBlockNumber: bigint): Promise<boolean>;
}

export interface BaseFinalitySources extends FinalitySources {
  safeBlockNumber(): Promise<bigint>;
  finalizedBlockNumber(): Promise<bigint>;
}

/** Base settles only after its canonical block is included in the finalized L2 head (D-057). */
export class BaseFinalityObserver implements FinalityObserver {
  constructor(private readonly sources: BaseFinalitySources, private readonly now: () => Date = () => new Date()) {
    if (sources.chainId !== 8453) throw new Error('BaseFinalityObserver requires chain ID 8453');
  }

  async observe(input: { txHash: Hash; txBlockNumber: bigint }): Promise<FinalityObservation> {
    const canonical = await isCanonical(this.sources, input.txHash, input.txBlockNumber);
    if (canonical === false) return this.observation('soft', false, false, 'receipt-not-canonical');
    if (canonical === null) return this.observation('soft', null, false, 'canonicality-unknown');
    const [safe, finalized] = await Promise.all([this.sources.safeBlockNumber(), this.sources.finalizedBlockNumber()]);
    if (finalized >= input.txBlockNumber) return this.observation('ethereum_final', true, true);
    if (safe >= input.txBlockNumber) return this.observation('posted', true, false, 'ethereum-finality-pending');
    return this.observation('soft', true, false, 'l1-derivation-pending');
  }

  private observation(stage: FinalityStage, canonical: boolean | null, ready: boolean, reason?: string): FinalityObservation {
    return { chainId: 8453, stage, canonical, ready, observedAt: this.now(), reason };
  }
}

/** Requires two independently configured Base observers to report the same canonical stage. */
export class IndependentBaseFinalityObserver implements FinalityObserver {
  constructor(private readonly primary: FinalityObserver, private readonly fallback: FinalityObserver) {}

  async observe(input: { txHash: Hash; txBlockNumber: bigint }): Promise<FinalityObservation> {
    const [left, right] = await Promise.all([this.primary.observe(input), this.fallback.observe(input)]);
    if (left.chainId !== 8453 || right.chainId !== 8453 || left.stage !== right.stage || left.canonical !== right.canonical || left.ready !== right.ready) throw new Error('BASE_PROVIDER_FINALITY_DISAGREEMENT');
    return left;
  }
}

export class RobinhoodFinalityObserver implements FinalityObserver {
  constructor(private readonly sources: RobinhoodFinalitySources, private readonly confirmationDepth: number, private readonly now: () => Date = () => new Date()) {
    if (sources.chainId !== 4663) throw new Error('RobinhoodFinalityObserver requires chain ID 4663');
  }

  async observe(input: { txHash: Hash; txBlockNumber: bigint }): Promise<FinalityObservation> {
    const canonical = await isCanonical(this.sources, input.txHash, input.txBlockNumber);
    if (canonical === false) return this.observation('soft', false, false, 'receipt-not-canonical');
    if (canonical === null) return this.observation('soft', null, false, 'canonicality-unknown');
    const confirmations = safeConfirmations(await this.sources.currentBlockNumber(), input.txBlockNumber);
    if (confirmations < this.confirmationDepth) return this.observation('soft', true, false, 'confirmation-depth-pending');
    if (await this.sources.isEthereumFinal(input.txHash, input.txBlockNumber)) return this.observation('ethereum_final', true, true);
    if (await this.sources.isPosted(input.txHash, input.txBlockNumber)) return this.observation('posted', true, false, 'ethereum-finality-pending');
    return this.observation('soft', true, false, 'l1-posting-pending');
  }

  private observation(stage: FinalityStage, canonical: boolean | null, ready: boolean, reason?: string): FinalityObservation {
    return { chainId: 4663, stage, canonical, ready, observedAt: this.now(), reason };
  }
}

async function isCanonical(sources: FinalitySources, txHash: Hash, txBlockNumber: bigint): Promise<boolean | null> {
  if (!sources.receiptBlockHash) return null;
  const observed = await sources.receiptBlockHash(txHash);
  if (observed === null) return null;
  const expected = sources.expectedBlockHash ?? (sources.canonicalBlockHash ? await sources.canonicalBlockHash(txBlockNumber) : null);
  return expected === null ? null : observed.toLowerCase() === expected.toLowerCase();
}

function safeConfirmations(head: bigint, block: bigint): number {
  if (head < block) return 0;
  const confirmations = head - block + 1n;
  return confirmations > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(confirmations);
}
