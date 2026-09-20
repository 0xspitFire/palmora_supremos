/**
 * Read-only chain facts used by the Phase 2 projections.
 *
 * This module deliberately has no signer, broadcaster, or mutation dependency.
 * A strategy remains the only owner of protocol-specific contract reads; this
 * adapter adds source, freshness, canonicality, and finality evidence around
 * that strategy result.
 */

import type { Address, Hash, Hex, PublicClient } from 'viem';
import type { FinalityObserver, FinalityObservation } from './finality-observer.js';
import { getStrategy } from './drop-reader.js';
import type {
  DropConfig,
  FinalityPolicy,
  FinalityStage,
  MintStrategy,
  SupportedChainId,
} from './types.js';

export type ChainFactKind = 'head' | 'logs' | 'drop' | 'wallet' | 'receipt' | 'finality' | 'reorg';
export type ChainFactAvailability = 'available' | 'partial' | 'unavailable';
export type FreshnessStatus = 'fresh' | 'stale' | 'unknown';

export type ChainFactErrorCode =
  | 'HEAD_UNAVAILABLE'
  | 'LOGS_UNAVAILABLE'
  | 'DROP_UNAVAILABLE'
  | 'WALLET_UNAVAILABLE'
  | 'RECEIPT_NOT_FOUND'
  | 'RECEIPT_UNAVAILABLE'
  | 'RECEIPT_MALFORMED'
  | 'FINALITY_UNAVAILABLE'
  | 'REORG_NOT_PROVEN'
  | 'INVALID_BLOCK_RANGE';

/** Freshness is calculated by the server/reader, never by a consumer clock. */
export interface FactFreshness {
  readonly status: FreshnessStatus;
  readonly observedAt: string | null;
  readonly expiresAt: string | null;
  readonly ageSeconds: string | null;
  readonly policyVersion: string | null;
}

/** Opaque, non-secret source metadata suitable for a read-model projection. */
export interface ChainFactProvenance {
  readonly kind: 'chain_observation' | 'strategy' | 'receipt' | 'finality' | 'reconciliation' | 'fixture';
  readonly recordId: string;
  readonly observedAt: string;
  readonly sourceBlockNumber?: bigint;
  readonly sourceBlockHash?: Hash;
  readonly sourceRef?: string;
  readonly evidenceId?: string;
  readonly policyVersion?: string;
}

export interface ChainFact<T> {
  readonly kind: ChainFactKind;
  /** A stale value may remain available; unknown/unavailable values are null. */
  readonly value: T | null;
  readonly availability: ChainFactAvailability;
  readonly freshness: FactFreshness;
  readonly provenance: readonly ChainFactProvenance[];
  readonly sourceBlockNumber?: bigint;
  readonly sourceBlockHash?: Hash;
  readonly errorCode?: ChainFactErrorCode;
}

export interface ChainHead {
  readonly number: bigint;
  readonly hash?: Hash;
  readonly timestamp?: bigint;
}

export interface ChainLog {
  readonly address: Address;
  readonly topics: readonly Hex[];
  readonly data: Hex;
  readonly blockNumber: bigint | null;
  readonly blockHash: Hash | null;
  readonly transactionHash: Hash | null;
  readonly logIndex: number | null;
  readonly removed: boolean;
}

export interface ChainLogFilter {
  readonly address?: Address | readonly Address[];
  readonly fromBlock: bigint;
  readonly toBlock?: bigint;
  readonly topics?: readonly (Hex | readonly Hex[] | null)[];
}

export type DropPhase = 'upcoming' | 'active' | 'ended' | 'unknown';

export interface DropSupplyFact {
  readonly totalMinted: bigint | null;
  readonly maxSupply: bigint | null;
  readonly totalMintedKnown: boolean;
  readonly maxSupplyKnown: boolean;
  readonly status: 'known' | 'partial' | 'unknown';
}

export interface ChainDropFact {
  readonly nftContract: Address;
  readonly strategyName: string;
  readonly drop: DropConfig;
  readonly phase: DropPhase;
  readonly supply: DropSupplyFact;
}

export interface WalletChainFact {
  readonly address: Address;
  readonly balanceWei: bigint | null;
  readonly nonce: number | null;
  /** `0x` means an EOA when `codeKnown` is true; null means the code read failed. */
  readonly code: Hex | null;
  readonly codeKnown: boolean;
  readonly isContract: boolean | null;
}

export type ReceiptFactStatus = 'pending' | 'confirmed' | 'reverted' | 'reorged' | 'dropped' | 'unknown';

export interface ChainReceiptFact {
  readonly transactionHash: Hash;
  readonly status: ReceiptFactStatus;
  /** The receipt status before canonicality was evaluated. */
  readonly receiptStatus: 'success' | 'reverted';
  readonly blockNumber: bigint;
  readonly blockHash: Hash;
  readonly confirmations: number;
  readonly gasUsed: bigint;
  readonly effectiveGasPrice: bigint;
  readonly canonical: boolean | null;
  readonly finality: ChainFinalityFact;
}

export interface ChainFinalityFact {
  readonly chainId: SupportedChainId;
  readonly stage: FinalityStage;
  readonly requiredStage: FinalityStage;
  readonly canonical: boolean | null;
  readonly settlementReached: boolean;
  readonly ready: boolean;
  readonly confirmations: number | null;
  readonly observedAt: string | null;
  readonly reason?: string;
  readonly freshness: FactFreshness;
  readonly provenance: readonly ChainFactProvenance[];
}

export interface ReorgFact {
  readonly transactionHash: Hash;
  readonly previousBlockHash: Hash;
  readonly replacementBlockHash?: Hash;
  readonly previousStage: FinalityStage;
  readonly newStage: 'unknown';
  readonly detectedAt: string;
  readonly reason: 'receipt-block-noncanonical';
}

export interface ReceiptObservationHistory {
  readonly observations: readonly ChainFact<ChainReceiptFact>[];
  readonly reorgs: readonly ChainFact<ReorgFact>[];
}

export interface ReceiptReadResult {
  readonly receipt: ChainFact<ChainReceiptFact>;
  readonly reorg: ChainFact<ReorgFact> | null;
}

export interface ChainFactsFreshnessPolicy {
  readonly version: string;
  readonly headMs: number;
  readonly logsMs: number;
  readonly dropMs: number;
  readonly walletMs: number;
  readonly receiptMs: number;
  readonly finalityMs: number;
  readonly reorgMs: number;
}

export const DEFAULT_CHAIN_FACT_FRESHNESS: ChainFactsFreshnessPolicy = Object.freeze({
  version: 'chain-facts-v1',
  headMs: 15_000,
  logsMs: 30_000,
  dropMs: 300_000,
  walletMs: 30_000,
  receiptMs: 15_000,
  finalityMs: 15_000,
  reorgMs: 300_000,
});

export const ETHEREUM_CHAIN_FINALITY: FinalityPolicy = Object.freeze({
  stages: ['confirmed'] as const,
  settlementStage: 'confirmed',
  notes: 'Receipt confirmation depth is required before settlement.',
});

export const L2_CHAIN_FINALITY: FinalityPolicy = Object.freeze({
  stages: ['soft', 'posted', 'ethereum_final'] as const,
  settlementStage: 'ethereum_final',
  notes: 'Soft inclusion and L1 posting are operational milestones; Ethereum finality is settlement.',
});

export interface ChainFactsReaderOptions {
  readonly chainId: SupportedChainId;
  /** Opaque source label, never an RPC URL or credentialed endpoint. */
  readonly sourceRef?: string;
  readonly now?: () => Date;
  readonly freshness?: Partial<ChainFactsFreshnessPolicy>;
  readonly finalityPolicy?: FinalityPolicy;
  readonly confirmationDepth?: number;
  readonly finalityObserver?: FinalityObserver;
}

interface SourceObservation {
  readonly blockNumber?: bigint;
  readonly blockHash?: Hash;
  readonly timestamp?: bigint;
}

interface RawReceipt {
  readonly transactionHash?: Hash;
  readonly blockNumber?: bigint;
  readonly blockHash?: Hash;
  readonly status?: 'success' | 'reverted';
  readonly gasUsed?: bigint;
  readonly effectiveGasPrice?: bigint;
}

interface RawLog {
  readonly address: Address;
  readonly topics: readonly Hex[];
  readonly data: Hex;
  readonly blockNumber?: bigint;
  readonly blockHash?: Hash;
  readonly transactionHash?: Hash;
  readonly logIndex?: number;
  readonly removed?: boolean;
}

/**
 * Classify a timestamp pair using an explicit server time. Invalid or future
 * observations are unknown, and expiry is inclusive (at expiry = stale).
 */
export function classifyFreshness(
  observedAt: string | Date | null | undefined,
  expiresAt: string | Date | null | undefined,
  asOf: string | Date,
  policyVersion: string | null = null,
): FactFreshness {
  const observedMs = dateMs(observedAt);
  const expiresMs = dateMs(expiresAt);
  const asOfMs = dateMs(asOf);
  if (observedMs === null || expiresMs === null || asOfMs === null || expiresMs < observedMs || asOfMs < observedMs) {
    return { status: 'unknown', observedAt: isoOrNull(observedAt), expiresAt: isoOrNull(expiresAt), ageSeconds: null, policyVersion };
  }
  const ageSeconds = Math.floor((asOfMs - observedMs) / 1000).toString();
  return {
    status: asOfMs >= expiresMs ? 'stale' : 'fresh',
    observedAt: new Date(observedMs).toISOString(),
    expiresAt: new Date(expiresMs).toISOString(),
    ageSeconds,
    policyVersion,
  };
}

/** A pure reorg transition detector suitable for durable history appenders. */
export function detectReorg(
  previous: ChainFact<ChainReceiptFact> | null | undefined,
  current: ChainFact<ChainReceiptFact> | null | undefined,
  detectedAt: string | Date,
): ChainFact<ReorgFact> | null {
  const prior = previous?.value;
  const next = current?.value;
  if (!prior || !next || prior.canonical !== true || next.canonical !== false || prior.transactionHash.toLowerCase() !== next.transactionHash.toLowerCase()) return null;
  const observedAt = isoOrNull(detectedAt);
  if (!observedAt) return null;
  const source = current?.provenance?.[0];
  const reorg: ReorgFact = {
    transactionHash: next.transactionHash,
    previousBlockHash: prior.blockHash,
    ...(next.blockHash.toLowerCase() === prior.blockHash.toLowerCase() ? {} : { replacementBlockHash: next.blockHash }),
    previousStage: prior.finality.stage,
    newStage: 'unknown',
    detectedAt: observedAt,
    reason: 'receipt-block-noncanonical',
  };
  const provenance: ChainFactProvenance[] = [{
    kind: 'reconciliation',
    recordId: `reorg:${next.transactionHash.toLowerCase()}:${observedAt}`,
    observedAt,
    ...(source?.sourceBlockNumber === undefined ? {} : { sourceBlockNumber: source.sourceBlockNumber }),
    ...(source?.sourceBlockHash === undefined ? {} : { sourceBlockHash: source.sourceBlockHash }),
    ...(source?.sourceRef === undefined ? {} : { sourceRef: source.sourceRef }),
  }];
  const freshness = unknownFreshness(null);
  return {
    kind: 'reorg',
    value: reorg,
    availability: 'available',
    freshness,
    provenance,
    ...(source?.sourceBlockNumber === undefined ? {} : { sourceBlockNumber: source.sourceBlockNumber }),
    ...(source?.sourceBlockHash === undefined ? {} : { sourceBlockHash: source.sourceBlockHash }),
  };
}

/** Append an observation without mutating or erasing prior receipt history. */
export function appendReceiptObservation(
  history: ReceiptObservationHistory,
  next: ChainFact<ChainReceiptFact>,
  detectedAt: string | Date,
): ReceiptObservationHistory {
  const previous = history.observations[history.observations.length - 1];
  const reorg = detectReorg(previous, next, detectedAt);
  return {
    observations: [...history.observations, next],
    reorgs: reorg ? [...history.reorgs, reorg] : history.reorgs,
  };
}

/**
 * Read-only chain adapter. It never calls `sendTransaction`, `sign*`, or a
 * broadcaster. Protocol reads are delegated to the supplied MintStrategy.
 */
export class ChainFactsReader {
  private readonly freshness: ChainFactsFreshnessPolicy;
  private readonly now: () => Date;
  private readonly sourceRef: string;
  private readonly finalityPolicy: FinalityPolicy;
  private readonly confirmationDepth: number;

  public constructor(private readonly client: PublicClient, options: ChainFactsReaderOptions) {
    this.freshness = resolveFreshness(options.freshness);
    this.now = options.now ?? (() => new Date());
    this.sourceRef = validateSourceRef(options.sourceRef ?? 'configured-rpc');
    this.finalityPolicy = validateFinalityPolicy(options.finalityPolicy ?? (options.chainId === 1 ? ETHEREUM_CHAIN_FINALITY : L2_CHAIN_FINALITY));
    this.confirmationDepth = validateConfirmationDepth(options.confirmationDepth ?? 1);
    this.chainId = options.chainId;
    this.finalityObserver = options.finalityObserver;
  }

  private readonly chainId: SupportedChainId;
  private readonly finalityObserver?: FinalityObserver;

  public async readHead(): Promise<ChainFact<ChainHead>> {
    const observedAt = this.readNow();
    try {
      const number = await this.client.getBlockNumber();
      const block = await this.readBlock(number);
      const value: ChainHead = {
        number,
        ...(block?.hash === undefined ? {} : { hash: block.hash }),
        ...(block?.timestamp === undefined ? {} : { timestamp: block.timestamp }),
      };
      return this.fact('head', value, observedAt, this.freshness.headMs, sourceRecord('head', number), 'chain_observation');
    } catch {
      return this.unavailable('head', 'HEAD_UNAVAILABLE', observedAt);
    }
  }

  public async readLogs(filter: ChainLogFilter): Promise<ChainFact<readonly ChainLog[]>> {
    const observedAt = this.readNow();
    const toBlock = filter.toBlock ?? (await this.readHead()).value?.number;
    if (toBlock === undefined || filter.fromBlock < 0n || toBlock < filter.fromBlock) {
      return this.unavailable('logs', 'INVALID_BLOCK_RANGE', observedAt);
    }
    try {
      const request: Record<string, unknown> = { fromBlock: filter.fromBlock, toBlock };
      if (filter.address !== undefined) request.address = filter.address;
      if (filter.topics !== undefined) request.topics = filter.topics;
      const logs = await this.client.getLogs(request as never) as unknown as readonly RawLog[];
      const value = logs.map(normalizeLog);
      return this.fact('logs', value, observedAt, this.freshness.logsMs, sourceRecord('logs', toBlock), 'chain_observation');
    } catch {
      return this.unavailable('logs', 'LOGS_UNAVAILABLE', observedAt);
    }
  }

  public async readDrop(nftContract: Address, strategy: MintStrategy | string = 'seadrop-v1-public'): Promise<ChainFact<ChainDropFact>> {
    const observedAt = this.readNow();
    const source = await this.captureSource();
    try {
      const implementation = typeof strategy === 'string' ? getStrategy(strategy) : strategy;
      const drop = await implementation.readDrop(this.client, nftContract, this.chainId);
      const phase = dropPhase(drop, observedAt);
      const supply = supplyFact(drop);
      const value: ChainDropFact = { nftContract, strategyName: implementation.name, drop, phase, supply };
      return this.fact('drop', value, observedAt, this.freshness.dropMs, sourceRecord('drop', `${nftContract.toLowerCase()}:${implementation.name}`, source), 'strategy', source);
    } catch {
      return this.unavailable('drop', 'DROP_UNAVAILABLE', observedAt, source);
    }
  }

  public async readWallet(address: Address): Promise<ChainFact<WalletChainFact>> {
    const observedAt = this.readNow();
    const source = await this.captureSource();
    let balanceWei: bigint | null = null;
    let nonce: number | null = null;
    let code: Hex | null = null;
    let codeKnown = false;
    try {
      balanceWei = await this.client.getBalance({ address });
    } catch {
      balanceWei = null;
    }
    try {
      const value = await this.client.getTransactionCount({ address });
      nonce = Number.isSafeInteger(value) && value >= 0 ? value : null;
    } catch {
      nonce = null;
    }
    try {
      const codeReader = this.client as PublicClient & { getCode?: (args: { address: Address }) => Promise<Hex | undefined> };
      if (typeof codeReader.getCode === 'function') {
        code = (await codeReader.getCode({ address })) ?? '0x';
        codeKnown = true;
      }
    } catch {
      code = null;
      codeKnown = false;
    }
    const value: WalletChainFact = {
      address,
      balanceWei,
      nonce,
      code,
      codeKnown,
      isContract: codeKnown ? code !== '0x' : null,
    };
    const availability: ChainFactAvailability = balanceWei !== null && nonce !== null ? 'available' : balanceWei !== null || nonce !== null || codeKnown ? 'partial' : 'unavailable';
    return this.fact('wallet', availability === 'unavailable' ? null : value, observedAt, this.freshness.walletMs, sourceRecord('wallet', address.toLowerCase(), source), 'chain_observation', source, availability, availability === 'unavailable' ? 'WALLET_UNAVAILABLE' : undefined);
  }

  public async readReceipt(txHash: Hash): Promise<ChainFact<ChainReceiptFact>> {
    return (await this.readReceiptWithHistory(txHash)).receipt;
  }

  public async readReceiptWithHistory(txHash: Hash, previous?: ChainFact<ChainReceiptFact>): Promise<ReceiptReadResult> {
    const observedAt = this.readNow();
    const source = await this.captureSource();
    let raw: RawReceipt | null;
    try {
      raw = await this.client.getTransactionReceipt({ hash: txHash }) as unknown as RawReceipt | null;
    } catch {
      const receipt = this.unavailable<ChainReceiptFact>('receipt', 'RECEIPT_UNAVAILABLE', observedAt, source);
      return { receipt, reorg: null };
    }
    if (!raw) {
      const receipt = this.fact<ChainReceiptFact>('receipt', null, observedAt, this.freshness.receiptMs, sourceRecord('receipt', txHash.toLowerCase(), source), 'receipt', source, 'unavailable', 'RECEIPT_NOT_FOUND');
      return { receipt, reorg: null };
    }
    if (raw.blockNumber === undefined || !raw.blockHash || !raw.status || raw.gasUsed === undefined || raw.effectiveGasPrice === undefined || !raw.transactionHash || raw.transactionHash.toLowerCase() !== txHash.toLowerCase()) {
      const receipt = this.unavailable<ChainReceiptFact>('receipt', 'RECEIPT_MALFORMED', observedAt, source);
      return { receipt, reorg: null };
    }
    const canonical = await this.isCanonical(raw.blockNumber, raw.blockHash);
    const confirmations = source.blockNumber !== undefined && source.blockNumber >= raw.blockNumber
      ? safeConfirmations(source.blockNumber - raw.blockNumber + 1n)
      : 0;
    const finality = await this.observeFinality(raw.transactionHash, raw.blockNumber, canonical, raw.status === 'success', confirmations, observedAt, source);
    const value: ChainReceiptFact = {
      transactionHash: raw.transactionHash,
      status: canonical === true ? raw.status === 'success' ? 'confirmed' : 'reverted' : canonical === false ? 'reorged' : 'unknown',
      receiptStatus: raw.status,
      blockNumber: raw.blockNumber,
      blockHash: raw.blockHash,
      confirmations,
      gasUsed: raw.gasUsed,
      effectiveGasPrice: raw.effectiveGasPrice,
      canonical,
      finality,
    };
    const receipt = this.fact('receipt', value, observedAt, this.freshness.receiptMs, sourceRecord('receipt', txHash.toLowerCase(), source), 'receipt', source);
    const reorg = detectReorg(previous, receipt, observedAt);
    return { receipt, reorg };
  }

  private async observeFinality(
    txHash: Hash,
    blockNumber: bigint,
    canonical: boolean | null,
    receiptSucceeded: boolean,
    confirmations: number,
    observedAt: Date,
    source: SourceObservation,
  ): Promise<ChainFinalityFact> {
    const provenance = [this.provenance('finality', `finality:${txHash.toLowerCase()}`, observedAt, source)];
    if (canonical === false) return this.finalityFact('unknown', false, false, confirmations, observedAt, 'receipt-not-canonical', provenance, source);
    if (canonical === null) return this.finalityFact('unknown', null, false, confirmations, observedAt, 'canonicality-unknown', provenance, source);
    if (this.finalityObserver) {
      try {
        const observation = await this.finalityObserver.observe({ txHash, txBlockNumber: blockNumber });
        return this.finalityFromObserver(observation, receiptSucceeded, confirmations, observedAt, provenance, source);
      } catch {
        return this.finalityFact('unknown', true, false, confirmations, observedAt, 'finality-observer-unavailable', provenance, source);
      }
    }
    const firstStage = this.finalityPolicy.stages[0] ?? 'unknown';
    const stage = this.finalityPolicy.stages.includes('confirmed')
      ? 'confirmed'
      : confirmations >= this.confirmationDepth ? firstStage : 'unknown';
    const ready = receiptSucceeded && stage === this.finalityPolicy.settlementStage && confirmations >= this.confirmationDepth;
    return this.finalityFact(stage, true, ready, confirmations, observedAt, ready ? undefined : 'finality-observation-pending', provenance, source);
  }

  private finalityFromObserver(
    observation: FinalityObservation,
    receiptSucceeded: boolean,
    confirmations: number,
    observedAt: Date,
    provenance: readonly ChainFactProvenance[],
    source: SourceObservation,
  ): ChainFinalityFact {
    const canonical = observation.canonical;
    const settlementReached = receiptSucceeded && canonical === true && observation.ready && observation.stage === this.finalityPolicy.settlementStage;
    return this.finalityFact(observation.stage, canonical, settlementReached, confirmations, observedAt, observation.reason, provenance, source);
  }

  private finalityFact(
    stage: FinalityStage,
    canonical: boolean | null,
    ready: boolean,
    confirmations: number | null,
    observedAt: Date,
    reason: string | undefined,
    provenance: readonly ChainFactProvenance[],
    source: SourceObservation,
  ): ChainFinalityFact {
    return {
      chainId: this.chainId,
      stage,
      requiredStage: this.finalityPolicy.settlementStage,
      canonical,
      settlementReached: ready,
      ready,
      confirmations,
      observedAt: observedAt.toISOString(),
      ...(reason === undefined ? {} : { reason }),
      freshness: this.freshnessFor(observedAt, this.freshness.finalityMs),
      provenance,
      ...(source.blockNumber === undefined ? {} : { sourceBlockNumber: source.blockNumber }),
      ...(source.blockHash === undefined ? {} : { sourceBlockHash: source.blockHash }),
    };
  }

  private async isCanonical(blockNumber: bigint, expectedHash: Hash): Promise<boolean | null> {
    const block = await this.readBlock(blockNumber);
    if (block === null || block.hash === undefined) return null;
    return block.hash.toLowerCase() === expectedHash.toLowerCase();
  }

  private async captureSource(): Promise<SourceObservation> {
    try {
      const blockNumber = await this.client.getBlockNumber();
      const block = await this.readBlock(blockNumber);
      return {
        blockNumber,
        ...(block?.hash === undefined ? {} : { blockHash: block.hash }),
        ...(block?.timestamp === undefined ? {} : { timestamp: block.timestamp }),
      };
    } catch {
      return {};
    }
  }

  private async readBlock(blockNumber: bigint): Promise<{ hash?: Hash; timestamp?: bigint } | null> {
    try {
      const block = await this.client.getBlock({ blockNumber });
      return { hash: block.hash ?? undefined, timestamp: block.timestamp };
    } catch {
      return null;
    }
  }

  private fact<T>(
    kind: ChainFactKind,
    value: T | null,
    observedAt: Date,
    ttlMs: number,
    recordId: string,
    provenanceKind: ChainFactProvenance['kind'],
    source: SourceObservation = {},
    availability: ChainFactAvailability = value === null ? 'unavailable' : 'available',
    errorCode?: ChainFactErrorCode,
  ): ChainFact<T> {
    const provenance = [this.provenance(provenanceKind, recordId, observedAt, source)];
    return {
      kind,
      value,
      availability,
      freshness: this.freshnessFor(observedAt, ttlMs),
      provenance,
      ...(source.blockNumber === undefined ? {} : { sourceBlockNumber: source.blockNumber }),
      ...(source.blockHash === undefined ? {} : { sourceBlockHash: source.blockHash }),
      ...(errorCode === undefined ? {} : { errorCode }),
    };
  }

  private unavailable<T>(kind: ChainFactKind, errorCode: ChainFactErrorCode, observedAt: Date, source: SourceObservation = {}): ChainFact<T> {
    const ttl = kind === 'head' ? this.freshness.headMs : kind === 'logs' ? this.freshness.logsMs : kind === 'drop' ? this.freshness.dropMs : kind === 'wallet' ? this.freshness.walletMs : kind === 'receipt' ? this.freshness.receiptMs : kind === 'finality' ? this.freshness.finalityMs : this.freshness.reorgMs;
    const provenance = errorCode === 'RECEIPT_NOT_FOUND' ? 'receipt' : kind === 'drop' ? 'strategy' : kind === 'finality' ? 'finality' : 'chain_observation';
    const fact = this.fact<T>(kind, null, observedAt, ttl, `${kind}:${this.chainId}:unavailable`, provenance, source, 'unavailable', errorCode);
    if (errorCode === 'RECEIPT_NOT_FOUND') return { ...fact, freshness: this.freshnessFor(observedAt, ttl) };
    return { ...fact, freshness: unknownFreshness(this.freshness.version) };
  }

  private provenance(kind: ChainFactProvenance['kind'], recordId: string, observedAt: Date, source: SourceObservation): ChainFactProvenance {
    return {
      kind,
      recordId,
      observedAt: observedAt.toISOString(),
      sourceRef: this.sourceRef,
      policyVersion: this.freshness.version,
      ...(source.blockNumber === undefined ? {} : { sourceBlockNumber: source.blockNumber }),
      ...(source.blockHash === undefined ? {} : { sourceBlockHash: source.blockHash }),
    };
  }

  private freshnessFor(observedAt: Date, ttlMs: number): FactFreshness {
    const expiresAt = new Date(observedAt.getTime() + ttlMs);
    return classifyFreshness(observedAt, expiresAt, this.readNow(), this.freshness.version);
  }

  private readNow(): Date {
    const value = this.now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Error('INVALID_CHAIN_FACT_TIME');
    return value;
  }
}

function sourceRecord(kind: string, identity: string | bigint, source?: SourceObservation): string {
  const block = source?.blockNumber === undefined ? '' : `:${source.blockNumber.toString()}`;
  return `chain:${kind}:${String(identity).toLowerCase()}${block}`;
}

function normalizeLog(log: RawLog): ChainLog {
  return {
    address: log.address,
    topics: [...log.topics],
    data: log.data,
    blockNumber: log.blockNumber ?? null,
    blockHash: log.blockHash ?? null,
    transactionHash: log.transactionHash ?? null,
    logIndex: log.logIndex ?? null,
    removed: log.removed ?? false,
  };
}

function dropPhase(drop: DropConfig, now: Date): DropPhase {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (drop.startTime <= 0 && drop.endTime <= 0) return 'unknown';
  if (drop.startTime > 0 && nowSeconds < drop.startTime) return 'upcoming';
  if (drop.endTime > 0 && nowSeconds > drop.endTime) return 'ended';
  return 'active';
}

function supplyFact(drop: DropConfig): DropSupplyFact {
  const extra = drop.extra ?? {};
  const totalMintedKnown = extra['totalSupplyKnown'] === true || drop.totalMinted > 0n;
  const maxSupplyKnown = extra['maxSupplyKnown'] === true || drop.maxTokenSupply > 0n;
  return {
    totalMinted: totalMintedKnown ? drop.totalMinted : null,
    maxSupply: maxSupplyKnown ? drop.maxTokenSupply : null,
    totalMintedKnown,
    maxSupplyKnown,
    status: totalMintedKnown && maxSupplyKnown ? 'known' : totalMintedKnown || maxSupplyKnown ? 'partial' : 'unknown',
  };
}

function safeConfirmations(value: bigint): number {
  if (value <= 0n) return 0;
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value);
}

function resolveFreshness(input?: Partial<ChainFactsFreshnessPolicy>): ChainFactsFreshnessPolicy {
  const value = { ...DEFAULT_CHAIN_FACT_FRESHNESS, ...input };
  const ttls = [value.headMs, value.logsMs, value.dropMs, value.walletMs, value.receiptMs, value.finalityMs, value.reorgMs];
  for (const ttl of ttls) {
    if (!Number.isFinite(ttl) || ttl < 0) throw new Error('INVALID_CHAIN_FACT_FRESHNESS_POLICY');
  }
  if (typeof value.version !== 'string' || value.version.length === 0) throw new Error('INVALID_CHAIN_FACT_FRESHNESS_POLICY');
  return value;
}

function validateSourceRef(value: string): string {
  if (value.length === 0 || value.length > 200 || /(?:https?:\/\/|wss?:\/\/|@|[\r\n])/i.test(value)) throw new Error('INVALID_CHAIN_FACT_SOURCE_REFERENCE');
  return value;
}

function validateConfirmationDepth(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('INVALID_CONFIRMATION_DEPTH');
  return value;
}

function validateFinalityPolicy(value: FinalityPolicy): FinalityPolicy {
  if (value.stages.length === 0 || !value.stages.includes(value.settlementStage)) throw new Error('INVALID_FINALITY_POLICY');
  return value;
}

function unknownFreshness(policyVersion: string | null): FactFreshness {
  return { status: 'unknown', observedAt: null, expiresAt: null, ageSeconds: null, policyVersion };
}

function dateMs(value: string | Date | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const result = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(result) ? result : null;
}

function isoOrNull(value: string | Date | null | undefined): string | null {
  const ms = dateMs(value);
  return ms === null ? null : new Date(ms).toISOString();
}
