import { parseAbi, toFunctionSelector, type Address, type Hex, type PublicClient } from 'viem';
import { providerErrorDetail, SEADROP_V1_ADDRESS, SEADROP_MINT_TOPIC } from '@mint-bot/engine';

/**
 * Read-only SeaDrop mint-method survey (T-013, Robinhood step E1, D-038).
 * Counts how SeaDrop mints were actually made over a block window, so we can tell whether public mints
 * (the only method the bot supports) are common on a chain. It reads logs and transactions only.
 */
const MINT_PARAMS = '(uint256 mintPrice, uint256 maxTotalMintableByWallet, uint256 startTime, uint256 endTime, uint256 dropStageIndex, uint256 maxTokenSupplyForStage, uint256 feeBps, bool restrictFeeRecipients)';
const SEADROP_MINT_ABI = parseAbi([
  'function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity)',
  `function mintSigned(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity, ${MINT_PARAMS} mintParams, uint256 salt, bytes signature)`,
  `function mintAllowList(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity, ${MINT_PARAMS} mintParams, bytes32[] proof)`,
]);

export type MintMethod = 'public' | 'signed' | 'allowlist' | 'other';
const SELECTORS: Record<string, MintMethod> = Object.fromEntries(SEADROP_MINT_ABI.map((item) => [toFunctionSelector(item), item.name === 'mintPublic' ? 'public' : item.name === 'mintSigned' ? 'signed' : 'allowlist'] as const));

/** Classifies a transaction by where it was sent and its function selector. A call through another contract is `other`. */
export function classifyMint(to: string | null | undefined, input: string | null | undefined, seaDrop: string = SEADROP_V1_ADDRESS): MintMethod {
  if (!to || to.toLowerCase() !== seaDrop.toLowerCase() || !input || input.length < 10) return 'other';
  return SELECTORS[input.slice(0, 10).toLowerCase()] ?? 'other';
}

export interface SurveyOptions {
  fromBlock: bigint;
  toBlock: bigint;
  /** Most distinct mint transactions to look up (default 300). */
  maxTransactions?: number;
  /** Starting blocks per log request; halves on rejection (default 2,000). */
  initialRange?: bigint;
  seaDrop?: Address;
}

export interface ContractMethodCounts { nft: string; public: number; signed: number; allowlist: number; other: number; }
export interface SurveyResult {
  fromBlock: string;
  toBlock: string;
  mintEvents: number;
  transactionsSampled: number;
  /** True when more mint transactions existed than the sample cap. */
  sampleCapped: boolean;
  byMethod: Record<MintMethod, number>;
  publicShare: number | null;
  contracts: number;
  contractsWithPublic: number;
  topContracts: ContractMethodCounts[];
  /** Block ranges a provider refused even at one block; results exclude them. */
  skippedRanges: number;
  /** Mint transactions whose method could not be looked up; they are left out of the method counts. */
  lookupFailures: number;
  summary: string;
}

type LogLike = { transactionHash: Hex | null; topics: readonly Hex[]; address: Address };

export async function surveySeaDropMints(client: PublicClient, options: SurveyOptions): Promise<SurveyResult> {
  const seaDrop = options.seaDrop ?? SEADROP_V1_ADDRESS;
  const cap = options.maxTransactions ?? 300;
  let range = options.initialRange ?? 2_000n;
  if (options.toBlock < options.fromBlock || range < 1n || cap < 1) throw new Error('SURVEY_OPTIONS_INVALID');
  const txToNft = new Map<string, string>();
  let mintEvents = 0;
  let skippedRanges = 0;
  let consecutiveSkips = 0;
  let cursor = options.fromBlock;
  while (cursor <= options.toBlock) {
    const end = cursor + range - 1n > options.toBlock ? options.toBlock : cursor + range - 1n;
    let logs: readonly LogLike[] | null = null;
    try {
      logs = await client.getLogs({ address: seaDrop, fromBlock: cursor, toBlock: end, topics: [SEADROP_MINT_TOPIC] } as never) as unknown as readonly LogLike[];
    } catch (error) {
      if (/rate.?limit|429|too many/i.test(providerErrorDetail(error))) throw new Error(`SURVEY_RATE_LIMITED: ${providerErrorDetail(error)}`);
      if (range > 1n) { range = range / 2n > 1n ? range / 2n : 1n; continue; }
      skippedRanges += 1;
      consecutiveSkips += 1;
      // A provider that refuses single blocks over and over is rate-limiting or broken: stop rather than return misleading counts.
      if (consecutiveSkips >= 5) throw new Error(`SURVEY_PROVIDER_KEEPS_REJECTING: ${skippedRanges} block range(s) were refused even one block at a time; try again later or use a different RPC`);
    }
    if (logs) {
      consecutiveSkips = 0;
      for (const log of logs) {
        mintEvents += 1;
        const nft = (log.topics[1] ? `0x${log.topics[1].slice(26)}` : 'unknown').toLowerCase();
        if (log.transactionHash && !txToNft.has(log.transactionHash)) txToNft.set(log.transactionHash, nft);
      }
    }
    cursor = end + 1n;
  }
  const allTransactions = [...txToNft.entries()];
  const sample = allTransactions.length > cap ? spread(allTransactions, cap) : allTransactions;
  const byMethod: Record<MintMethod, number> = { public: 0, signed: 0, allowlist: 0, other: 0 };
  const perContract = new Map<string, ContractMethodCounts>();
  let lookupFailures = 0;
  for (const [hash, nft] of sample) {
    let method: MintMethod;
    try {
      const transaction = await client.getTransaction({ hash: hash as Hex });
      method = classifyMint(transaction.to, transaction.input, seaDrop);
    } catch (error) {
      if (/rate.?limit|429|too many/i.test(providerErrorDetail(error))) throw new Error(`SURVEY_RATE_LIMITED: ${providerErrorDetail(error)}`);
      lookupFailures += 1;
      continue;
    }
    byMethod[method] += 1;
    const row = perContract.get(nft) ?? { nft, public: 0, signed: 0, allowlist: 0, other: 0 };
    row[method] += 1;
    perContract.set(nft, row);
  }
  const total = sample.length - lookupFailures;
  const publicShare = total === 0 ? null : byMethod.public / total;
  const contractRows = [...perContract.values()];
  const topContracts = contractRows.sort((left, right) => (right.public + right.signed + right.allowlist + right.other) - (left.public + left.signed + left.allowlist + left.other)).slice(0, 20);
  const contractsWithPublic = contractRows.filter((row) => row.public > 0).length;
  const pct = (count: number): string => total === 0 ? '0%' : `${Math.round((100 * count) / total)}%`;
  const summary = total === 0
    ? `${skippedRanges > 0 || lookupFailures > 0 ? `WARNING: ${skippedRanges} block range(s) and ${lookupFailures} transaction lookup(s) failed. ` : ''}No SeaDrop mints were found in blocks ${options.fromBlock}-${options.toBlock}.`
    : `${skippedRanges > 0 || lookupFailures > 0 ? `WARNING: ${skippedRanges} block range(s) and ${lookupFailures} transaction lookup(s) failed, so these counts are partial. ` : ''}${mintEvents} SeaDrop mint events in ${total} sampled transaction(s): ${pct(byMethod.public)} public, ${pct(byMethod.signed)} signed, ${pct(byMethod.allowlist)} allowlist, ${pct(byMethod.other)} other. ${contractsWithPublic} of ${contractRows.length} contract(s) had public mints.${sample.length < allTransactions.length ? ` Sample capped at ${cap} of ${allTransactions.length} transactions.` : ''}`;
  return { fromBlock: options.fromBlock.toString(), toBlock: options.toBlock.toString(), mintEvents, transactionsSampled: total, sampleCapped: sample.length < allTransactions.length, byMethod, publicShare, contracts: contractRows.length, contractsWithPublic, topContracts, skippedRanges, lookupFailures, summary };
}

/** Evenly spread sample across the window, so a cap does not only see the start. */
function spread<T>(items: readonly T[], count: number): T[] {
  const out: T[] = [];
  for (let index = 0; index < count; index += 1) out.push(items[Math.floor((index * items.length) / count)]!);
  return out;
}

/** The only text the survey command may print for a failure: known survey codes as-is, anything else cleaned, because provider errors can contain the RPC URL and key. */
export function surveyErrorMessage(error: unknown): string {
  if (error instanceof Error && /^[A-Z][A-Z0-9_]+(:|$)/.test(error.message) && !/:\/\/|0x[0-9a-f]{20,}|[A-Za-z0-9_-]{32,}/i.test(error.message)) return error.message;
  return `SURVEY_FAILED: ${providerErrorDetail(error)}`;
}
