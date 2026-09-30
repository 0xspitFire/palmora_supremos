/**
 * @module seadrop-observer
 *
 * Read-only SeaDrop v1 discovery source (T-004, P2-02). Decodes public mint and
 * drop-configuration logs from the SeaDrop singleton, plus ERC-721 mints to
 * watched addresses. It never signs, sends, or builds transactions.
 */
import { decodeEventLog, encodeEventTopics, pad, parseAbi, zeroAddress, type Address, type Hex } from 'viem';
import type { ChainFact, ChainHead, ChainLog, ChainLogFilter } from './chain-facts.js';
import { SEADROP_V1_ADDRESS } from './chains.js';

export const SEADROP_EVENTS_ABI = parseAbi([
  'event SeaDropMint(address indexed nftContract, address indexed minter, address indexed feeRecipient, address payer, uint256 quantityMinted, uint256 unitMintPrice, uint256 feeBps, uint256 dropStageIndex)',
  'event PublicDropUpdated(address indexed nftContract, (uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients) publicDrop)',
]);
const ERC721_TRANSFER_ABI = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)']);

export const SEADROP_MINT_TOPIC: Hex = encodeEventTopics({ abi: SEADROP_EVENTS_ABI, eventName: 'SeaDropMint' })[0]!;
export const PUBLIC_DROP_UPDATED_TOPIC: Hex = encodeEventTopics({ abi: SEADROP_EVENTS_ABI, eventName: 'PublicDropUpdated' })[0]!;
export const ERC721_TRANSFER_TOPIC: Hex = encodeEventTopics({ abi: ERC721_TRANSFER_ABI, eventName: 'Transfer' })[0]!;

/** The subset of ChainFactsReader the observer needs; lets tests supply fixed logs. */
export interface LogSource {
  readHead(): Promise<ChainFact<ChainHead>>;
  readLogs(filter: ChainLogFilter): Promise<ChainFact<readonly ChainLog[]>>;
}

export interface LogPosition { blockNumber: bigint; logIndex: number; transactionHash: Hex | null; }
export interface SeaDropMintObservation extends LogPosition { nftContract: Address; minter: Address; payer: Address; quantity: bigint; unitMintPriceWei: bigint; dropStageIndex: bigint; }
export interface PublicDropUpdateObservation extends LogPosition { nftContract: Address; mintPriceWei: bigint; startTime: number; endTime: number; maxTotalMintableByWallet: number; feeBps: number; restrictFeeRecipients: boolean; }
export interface WatchedMintObservation extends LogPosition { nftContract: Address; recipient: Address; tokenId: bigint; }

export interface ScanResult {
  fromBlock: bigint;
  toBlock: bigint;
  mints: SeaDropMintObservation[];
  dropUpdates: PublicDropUpdateObservation[];
  watchedMints: WatchedMintObservation[];
  /** Logs that could not be decoded; skipped, never guessed. */
  undecodable: number;
  /** Logs the node returned outside the requested filter; dropped. */
  ignored: number;
  /** True when at least one watched-wallet chunk could not be read; SeaDrop results are still complete. */
  watchedUnavailable: boolean;
}

export type ScanOutcome = { ok: true; result: ScanResult } | { ok: false; reason: 'HEAD_UNAVAILABLE' | 'LOGS_UNAVAILABLE' | 'REORGED_LOG' | 'INVALID_RANGE'; detail?: string };

export interface SeaDropObserverOptions {
  seaDropAddress?: Address;
  /** Blocks behind head treated as settled enough to scan. */
  confirmations?: bigint;
  /** Most blocks scanned in one call. */
  maxRange?: bigint;
  /** Most watched addresses per watched-wallet query. */
  watchedChunk?: number;
}

export class SeaDropObserver {
  private readonly seaDrop: Address;
  public readonly confirmations: bigint;
  public readonly maxRange: bigint;
  public readonly watchedChunk: number;

  public constructor(private readonly source: LogSource, options: SeaDropObserverOptions = {}) {
    this.seaDrop = options.seaDropAddress ?? SEADROP_V1_ADDRESS;
    this.confirmations = options.confirmations ?? 2n;
    this.maxRange = options.maxRange ?? 500n;
    this.watchedChunk = options.watchedChunk ?? 20;
    if (this.confirmations < 0n || this.maxRange < 1n || !Number.isSafeInteger(this.watchedChunk) || this.watchedChunk < 1) throw new Error('SEADROP_OBSERVER_OPTIONS_INVALID');
  }

  /** Highest block considered settled, or null when the head is unknown. */
  public async safeHead(): Promise<bigint | null> {
    const head = await this.source.readHead();
    const number = head.value?.number;
    if (number === undefined || head.availability === 'unavailable') return null;
    return number > this.confirmations ? number - this.confirmations : 0n;
  }

  /** Scans [fromBlock, min(toBlock, fromBlock + maxRange - 1)]. Fails whole rather than returning partial data. */
  public async scan(fromBlock: bigint, toBlock: bigint, watched: readonly Address[] = []): Promise<ScanOutcome> {
    if (fromBlock < 0n || toBlock < fromBlock) return { ok: false, reason: 'INVALID_RANGE' };
    const end = toBlock - fromBlock + 1n > this.maxRange ? fromBlock + this.maxRange - 1n : toBlock;
    const seaDropLogs = await this.source.readLogs({ address: this.seaDrop, fromBlock, toBlock: end, topics: [[SEADROP_MINT_TOPIC, PUBLIC_DROP_UPDATED_TOPIC]] });
    if (seaDropLogs.availability === 'unavailable' || seaDropLogs.value === null) return { ok: false, reason: 'LOGS_UNAVAILABLE', ...(seaDropLogs.errorDetail ? { detail: seaDropLogs.errorDetail } : {}) };
    // Watched-wallet mints are best-effort evidence: providers often reject large address-less topic
    // queries, so they are asked in small chunks and a rejected chunk never fails the SeaDrop scan.
    const watchedLogs: ChainLog[] = [];
    let watchedUnavailable = false;
    for (let start = 0; start < watched.length; start += this.watchedChunk) {
      const chunk = watched.slice(start, start + this.watchedChunk);
      const fact = await this.source.readLogs({ fromBlock, toBlock: end, topics: [ERC721_TRANSFER_TOPIC, pad(zeroAddress), chunk.map((address) => pad(address.toLowerCase() as Address))] });
      if (fact.availability === 'unavailable' || fact.value === null) { watchedUnavailable = true; continue; }
      watchedLogs.push(...fact.value);
    }
    if ([...seaDropLogs.value, ...watchedLogs].some((log) => log.removed)) return { ok: false, reason: 'REORGED_LOG' };
    const result: ScanResult = { fromBlock, toBlock: end, mints: [], dropUpdates: [], watchedMints: [], undecodable: 0, ignored: 0, watchedUnavailable };
    const inRange = (log: ChainLog): boolean => log.blockNumber !== null && log.blockNumber >= fromBlock && log.blockNumber <= end;
    for (const log of seaDropLogs.value) {
      if (!inRange(log)) { result.ignored += 1; continue; }
      const topic0 = log.topics[0]?.toLowerCase();
      if (topic0 !== SEADROP_MINT_TOPIC.toLowerCase() && topic0 !== PUBLIC_DROP_UPDATED_TOPIC.toLowerCase()) { result.ignored += 1; continue; }
      if (log.address.toLowerCase() !== this.seaDrop.toLowerCase()) { result.undecodable += 1; continue; }
      const position = positionOf(log);
      if (!position) { result.undecodable += 1; continue; }
      try {
        const decoded = decodeEventLog({ abi: SEADROP_EVENTS_ABI, topics: log.topics as [Hex, ...Hex[]], data: log.data });
        if (decoded.eventName === 'SeaDropMint') {
          const args = decoded.args;
          result.mints.push({ ...position, nftContract: lower(args.nftContract), minter: lower(args.minter), payer: lower(args.payer), quantity: args.quantityMinted, unitMintPriceWei: args.unitMintPrice, dropStageIndex: args.dropStageIndex });
        } else {
          const drop = decoded.args.publicDrop;
          result.dropUpdates.push({ ...position, nftContract: lower(decoded.args.nftContract), mintPriceWei: drop.mintPrice, startTime: drop.startTime, endTime: drop.endTime, maxTotalMintableByWallet: drop.maxTotalMintableByWallet, feeBps: drop.feeBps, restrictFeeRecipients: drop.restrictFeeRecipients });
        }
      } catch { result.undecodable += 1; }
    }
    const zeroTopic = pad(zeroAddress).toLowerCase();
    const watchedTopics = new Set(watched.map((address) => pad(address.toLowerCase() as Address).toLowerCase()));
    for (const log of watchedLogs) {
      // Re-check the filter locally: some nodes over-return logs that match only part of a topic filter.
      if (!inRange(log) || log.topics[0]?.toLowerCase() !== ERC721_TRANSFER_TOPIC.toLowerCase() || log.topics[1]?.toLowerCase() !== zeroTopic || !watchedTopics.has(log.topics[2]?.toLowerCase() ?? '')) { result.ignored += 1; continue; }
      const position = positionOf(log);
      // ERC-721 Transfer has exactly four topics; ERC-20 Transfer (three topics) is excluded.
      if (!position || log.topics.length !== 4) { result.undecodable += 1; continue; }
      try {
        const decoded = decodeEventLog({ abi: ERC721_TRANSFER_ABI, topics: log.topics as [Hex, ...Hex[]], data: log.data });
        result.watchedMints.push({ ...position, nftContract: lower(log.address), recipient: lower(decoded.args.to), tokenId: decoded.args.tokenId });
      } catch { result.undecodable += 1; }
    }
    return { ok: true, result };
  }
}

function positionOf(log: ChainLog): LogPosition | null {
  if (log.blockNumber === null || log.logIndex === null) return null;
  return { blockNumber: log.blockNumber, logIndex: log.logIndex, transactionHash: log.transactionHash };
}

function lower(address: Address): Address { return address.toLowerCase() as Address; }
