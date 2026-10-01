import { toFunctionSelector, type Address, type Hash, type Hex, type PublicClient } from 'viem';
import { FREE_MINT_PER_WALLET_RESERVE_CAP_WEI, FREE_MINT_ACTIVE_PERIOD_RESERVE_CAP_WEI, RobinhoodFinalityObserver, SEADROP_MINT_TOPIC, SEADROP_V1_ADDRESS, SeaDropV1PublicStrategy, providerErrorDetail, type FinalityObservation, type RobinhoodFinalitySources } from '@mint-bot/engine';
import { classifyMint } from './seadrop-survey.js';

/**
 * Read-only Robinhood checks for steps E3 (finality), E5 (fees) and E6 (dry-run simulation) of D-038.
 * Nothing here signs, sends or spends. Robinhood is an Arbitrum Nitro chain: the node answers `safe` and
 * `finalized` block tags, and the NodeInterface precompile reports whether a block has been posted in a batch.
 */
export const PUBLIC_ROBINHOOD_RPC = 'https://rpc.mainnet.chain.robinhood.com';
const NODE_INTERFACE = '0x00000000000000000000000000000000000000c8' as Address;
const FIND_BATCH = toFunctionSelector('function findBatchContainingBlock(uint64 blockNumber)');
const encodeBlock = (block: bigint): Hex => `${FIND_BATCH}${block.toString(16).padStart(64, '0')}` as Hex;

/** Real finality sources for chain 4663, for the engine's staged `RobinhoodFinalityObserver`. */
export function createNitroFinalitySources(client: PublicClient): RobinhoodFinalitySources {
  return {
    chainId: 4663,
    currentBlockNumber: () => client.getBlockNumber(),
    receiptBlockHash: async (hash: Hash) => { try { return (await client.getTransactionReceipt({ hash })).blockHash; } catch { return null; } },
    canonicalBlockHash: async (blockNumber: bigint) => { try { return (await client.getBlock({ blockNumber })).hash; } catch { return null; } },
    // Posted: a batch containing this block exists on the parent chain (the call reverts until then).
    isPosted: async (_hash: Hash, blockNumber: bigint) => {
      try { await client.call({ to: NODE_INTERFACE, data: encodeBlock(blockNumber) }); return true; } catch { return false; }
    },
    // Ethereum final: at or before the node's `finalized` block, which follows Ethereum's own finality.
    isEthereumFinal: async (_hash: Hash, blockNumber: bigint) => {
      try { const finalized = await client.getBlock({ blockTag: 'finalized' }); return finalized.number !== null && blockNumber <= finalized.number; } catch { return false; }
    },
  };
}

// ── E3: finality observation ──────────────────────────────────────────────────────────────────────────

export interface FinalityObserveOptions {
  /** Fresh transactions to follow (default 5, maximum 20). */
  samples?: number;
  /** Minutes to keep watching (default 20, maximum 60). */
  minutes?: number;
  pollSeconds?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}
export interface TrackedFinality { txHash: string; blockNumber: string; firstSeenSecondsAfterBlock: number; postedAfterSeconds: number | null; finalAfterSeconds: number | null; lastStage: string }
export interface FinalityReport {
  followed: TrackedFinality[];
  historical: { txHash: string; ageMinutes: number; stage: string; ready: boolean } | null;
  stagesInOrder: boolean;
  medianPostedSeconds: number | null;
  medianFinalSeconds: number | null;
  summary: string;
}

const median = (values: number[]): number | null => { if (values.length === 0) return null; const sorted = [...values].sort((a, b) => a - b); return Math.round(sorted[Math.floor(sorted.length / 2)]!); };

export async function observeFinality(client: PublicClient, options: FinalityObserveOptions = {}): Promise<FinalityReport> {
  const samples = options.samples ?? 5;
  const minutes = options.minutes ?? 20;
  const pollMs = (options.pollSeconds ?? 15) * 1_000;
  if (!Number.isSafeInteger(samples) || samples < 1 || samples > 20 || !Number.isFinite(minutes) || minutes <= 0 || minutes > 60 || pollMs < 1_000) throw new Error('FINALITY_OPTIONS_INVALID');
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const sources = createNitroFinalitySources(client);
  const observer = new RobinhoodFinalityObserver(sources, 1);

  // Pick fresh transactions from the newest blocks.
  const head = await client.getBlockNumber();
  const picked: Array<{ hash: Hash; block: bigint; blockTime: number }> = [];
  for (let offset = 0n; offset < 10n && picked.length < samples; offset += 1n) {
    const block = await client.getBlock({ blockNumber: head - offset, includeTransactions: false });
    for (const hash of block.transactions as Hash[]) { if (picked.length < samples) picked.push({ hash, block: block.number!, blockTime: Number(block.timestamp) * 1_000 }); }
  }
  if (picked.length === 0) throw new Error('NO_RECENT_TRANSACTIONS_FOUND');

  const tracked: TrackedFinality[] = picked.map((item) => ({ txHash: item.hash, blockNumber: item.block.toString(), firstSeenSecondsAfterBlock: Math.max(0, Math.round((now() - item.blockTime) / 1_000)), postedAfterSeconds: null, finalAfterSeconds: null, lastStage: 'soft' }));
  let stagesInOrder = true;
  const deadline = now() + minutes * 60_000;
  for (;;) {
    for (const [index, item] of picked.entries()) {
      const entry = tracked[index]!;
      if (entry.finalAfterSeconds !== null) continue;
      const observation: FinalityObservation = await observer.observe({ txHash: item.hash, txBlockNumber: item.block });
      const seconds = Math.round((now() - item.blockTime) / 1_000);
      entry.lastStage = observation.stage;
      if (observation.stage === 'posted' || observation.stage === 'ethereum_final') { if (entry.postedAfterSeconds === null) entry.postedAfterSeconds = seconds; }
      if (observation.stage === 'ethereum_final') {
        // Something Ethereum-final must also be posted; a node that says otherwise is inconsistent.
        if (!(await sources.isPosted(item.hash, item.block))) stagesInOrder = false;
        entry.finalAfterSeconds = seconds;
      }
    }
    if (tracked.every((entry) => entry.finalAfterSeconds !== null) || now() >= deadline) break;
    await sleep(pollMs);
  }

  // An old transaction must already be final: a sanity check that the stage logic matches reality.
  let historical: FinalityReport['historical'] = null;
  try {
    const oldBlock = await client.getBlock({ blockNumber: head - 30_000n, includeTransactions: false });
    const hash = (oldBlock.transactions as Hash[])[0];
    if (hash) {
      const observation = await observer.observe({ txHash: hash, txBlockNumber: oldBlock.number! });
      historical = { txHash: hash, ageMinutes: Math.round((now() - Number(oldBlock.timestamp) * 1_000) / 60_000), stage: observation.stage, ready: observation.ready };
    }
  } catch { historical = null; }
  const medianPosted = median(tracked.flatMap((entry) => entry.postedAfterSeconds === null ? [] : [entry.postedAfterSeconds]));
  const medianFinal = median(tracked.flatMap((entry) => entry.finalAfterSeconds === null ? [] : [entry.finalAfterSeconds]));
  const finalCount = tracked.filter((entry) => entry.finalAfterSeconds !== null).length;
  const summary = `Followed ${tracked.length} fresh transaction(s) for up to ${minutes} minute(s): ${tracked.filter((entry) => entry.postedAfterSeconds !== null).length} reached "posted" (median ${medianPosted ?? 'n/a'} s after their block) and ${finalCount} reached Ethereum-final (median ${medianFinal ?? 'n/a'} s). ${stagesInOrder ? 'Stages always came in order (soft, posted, final).' : 'WARNING: a transaction was seen as final before posted.'} ${historical ? `An older transaction (${historical.ageMinutes} min) was "${historical.stage}"${historical.ready ? ' and ready' : ' and NOT ready'}.` : 'No older transaction could be checked.'}`;
  return { followed: tracked, historical, stagesInOrder, medianPostedSeconds: medianPosted, medianFinalSeconds: medianFinal, summary };
}

// ── E5: fee check on real recent free mints ───────────────────────────────────────────────────────────

export interface FeeCheckReport {
  mintsSampled: number;
  /** Public mints looked at, and how many of those were paid (value above zero). */
  publicMintsLooked: number;
  paidPublicMints: number;
  gasUsed: { median: string | null; max: string | null };
  /** Cost actually paid per mint transaction, in ETH. */
  costEth: { median: string | null; p95: string | null; max: string | null };
  gasUsedForL1Median: string | null;
  caps: { perWalletEth: string; activePeriodEth: string };
  underPerWalletCap: number;
  /** How many wallets of the typical cost fit in the active-period cap. */
  walletsThatFitPeriodCap: number | null;
  summary: string;
}

const ethString = (wei: bigint): string => { const whole = wei / 10n ** 18n; const frac = (wei % 10n ** 18n).toString().padStart(18, '0').slice(0, 8); return `${whole}.${frac}`; };

export async function checkFees(client: PublicClient, options: { blocks?: number; samples?: number } = {}): Promise<FeeCheckReport> {
  const blocks = BigInt(options.blocks ?? 3_000);
  const samples = options.samples ?? 40;
  if (blocks < 1n || blocks > 20_000n || !Number.isSafeInteger(samples) || samples < 1 || samples > 200) throw new Error('FEE_CHECK_OPTIONS_INVALID');
  const head = await client.getBlockNumber();
  let logs: Array<{ transactionHash: Hash | null }> = [];
  let range = blocks;
  let from = head - blocks + 1n;
  while (from <= head) {
    const to = from + range - 1n > head ? head : from + range - 1n;
    try { logs = logs.concat(await client.getLogs({ address: SEADROP_V1_ADDRESS, fromBlock: from, toBlock: to, topics: [SEADROP_MINT_TOPIC] } as never) as never); from = to + 1n; }
    catch (error) { if (range <= 1n) throw new Error(`FEE_CHECK_LOGS_UNAVAILABLE: ${providerErrorDetail(error)}`); range = range / 2n > 1n ? range / 2n : 1n; }
  }
  const hashes = [...new Set(logs.flatMap((log) => log.transactionHash ? [log.transactionHash] : []))];
  const picked = hashes.length > samples ? hashes.filter((_, index) => index % Math.ceil(hashes.length / samples) === 0).slice(0, samples) : hashes;
  const costs: bigint[] = []; const gas: bigint[] = []; const l1: bigint[] = [];
  let publicLooked = 0; let paidPublic = 0;
  for (const hash of picked) {
    try {
      const [tx, receipt] = await Promise.all([client.getTransaction({ hash }), client.getTransactionReceipt({ hash })]);
      // Free public mints only: sent to SeaDrop, mintPublic, no value.
      if (classifyMint(tx.to, tx.input) !== 'public' || receipt.status !== 'success') continue;
      publicLooked += 1;
      if (tx.value !== 0n) { paidPublic += 1; continue; }
      costs.push(receipt.gasUsed * receipt.effectiveGasPrice);
      gas.push(receipt.gasUsed);
      const forL1 = (receipt as unknown as { gasUsedForL1?: Hex | bigint }).gasUsedForL1;
      if (forL1 !== undefined) l1.push(BigInt(forL1));
    } catch { /* skip a transaction that cannot be read */ }
  }
  const sortedCosts = [...costs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const pick = (fraction: number): bigint | null => sortedCosts.length === 0 ? null : sortedCosts[Math.min(sortedCosts.length - 1, Math.floor(fraction * sortedCosts.length))]!;
  const sortedGas = [...gas].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const sortedL1 = [...l1].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const medianCost = pick(0.5);
  const under = costs.filter((cost) => cost <= FREE_MINT_PER_WALLET_RESERVE_CAP_WEI).length;
  const fits = medianCost !== null && medianCost > 0n ? Number(FREE_MINT_ACTIVE_PERIOD_RESERVE_CAP_WEI / medianCost) : null;
  const paidNote = publicLooked > 0 ? ` Of ${publicLooked} public mint(s) looked at, ${paidPublic} were paid (${Math.round((100 * paidPublic) / publicLooked)}%).` : '';
  const summary = costs.length === 0
    ? `No free public mint transactions were found in the window, so the fee check could not be made.${paidNote}`
    : `${costs.length} real free public mint(s): median cost ${ethString(medianCost!)} ETH, 95th percentile ${ethString(pick(0.95)!)} ETH, worst ${ethString(sortedCosts.at(-1)!)} ETH. ${under} of ${costs.length} cost no more than the ${ethString(FREE_MINT_PER_WALLET_RESERVE_CAP_WEI)} ETH per-wallet cap; about ${fits} wallets of the median cost fit the ${ethString(FREE_MINT_ACTIVE_PERIOD_RESERVE_CAP_WEI)} ETH period cap. (Actual cost, not the padded worst case the bot reserves.)${paidNote}`;
  return {
    mintsSampled: costs.length,
    publicMintsLooked: publicLooked,
    paidPublicMints: paidPublic,
    gasUsed: { median: sortedGas.length ? sortedGas[Math.floor(sortedGas.length / 2)]!.toString() : null, max: sortedGas.length ? sortedGas.at(-1)!.toString() : null },
    costEth: { median: medianCost === null ? null : ethString(medianCost), p95: pick(0.95) === null ? null : ethString(pick(0.95)!), max: sortedCosts.length ? ethString(sortedCosts.at(-1)!) : null },
    gasUsedForL1Median: sortedL1.length ? sortedL1[Math.floor(sortedL1.length / 2)]!.toString() : null,
    caps: { perWalletEth: ethString(FREE_MINT_PER_WALLET_RESERVE_CAP_WEI), activePeriodEth: ethString(FREE_MINT_ACTIVE_PERIOD_RESERVE_CAP_WEI) },
    underPerWalletCap: under,
    walletsThatFitPeriodCap: fits,
    summary,
  };
}

// ── E6: live dry run (simulation only) ───────────────────────────────────────────────────────────────

export interface DryRunWallet { wallet: string; simulation: 'passed' | 'failed'; reason?: string; estimatedGas: string | null; estimatedCostEth: string | null; withinPerWalletCap: boolean | null; balanceEth: string | null; hasEnoughForGas: boolean | null }
export interface DryRunReport { contract: string; verdict: 'ok' | 'blocked'; summary: string; drop: { priceEth: string; opensAt: string | null; closesAt: string | null; maxPerWallet: number; status: 'upcoming' | 'open' | 'ended' } | null; quantity: number; wallets: DryRunWallet[] }

/** Reads a Robinhood SeaDrop public drop and simulates the mint for each wallet with eth_call. Never signs or sends. */
export async function dryRunDrop(client: PublicClient, contract: string, wallets: readonly string[], options: { quantity?: number; now?: Date } = {}): Promise<DryRunReport> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(contract)) return { contract, verdict: 'blocked', summary: 'That is not a valid contract address.', drop: null, quantity: 0, wallets: [] };
  const strategy = new SeaDropV1PublicStrategy();
  let drop;
  try { drop = await strategy.readDrop(client, contract as Address, 4663); } catch (error) { return { contract, verdict: 'blocked', summary: `No readable SeaDrop public drop here: ${providerErrorDetail(error)}`, drop: null, quantity: 0, wallets: [] }; }
  const nowMs = (options.now ?? new Date()).getTime();
  const startMs = drop.startTime * 1_000;
  const endMs = drop.endTime === 0 ? Number.POSITIVE_INFINITY : drop.endTime * 1_000;
  const status = nowMs < startMs ? 'upcoming' : nowMs >= endMs ? 'ended' : 'open';
  const quantity = Math.max(1, Math.min(options.quantity ?? 1, drop.maxTotalMintableByWallet || 1));
  const dropView = { priceEth: ethString(drop.mintPrice), opensAt: startMs > 0 ? new Date(startMs).toISOString() : null, closesAt: Number.isFinite(endMs) ? new Date(endMs).toISOString() : null, maxPerWallet: drop.maxTotalMintableByWallet, status } as const;
  if (drop.mintPrice > 0n) return { contract, verdict: 'blocked', summary: 'This drop is paid. Paid Robinhood mints are blocked (D-038), so it is not simulated.', drop: dropView, quantity, wallets: [] };
  if (status !== 'open') return { contract, verdict: 'blocked', summary: `This mint is ${status}, so a simulation would not be meaningful.`, drop: dropView, quantity, wallets: [] };
  const gasPrice = await client.getGasPrice().catch(() => null);
  const results: DryRunWallet[] = [];
  for (const wallet of wallets) {
    const minter = wallet as Address;
    const calldata = strategy.buildCalldata(drop, minter, quantity);
    try {
      await client.call({ account: minter, to: SEADROP_V1_ADDRESS, data: calldata, value: 0n });
      let estimatedGas: bigint | null = null;
      try { estimatedGas = await client.estimateGas({ account: minter, to: SEADROP_V1_ADDRESS, data: calldata, value: 0n }); } catch { estimatedGas = null; }
      const cost = estimatedGas !== null && gasPrice !== null ? estimatedGas * gasPrice : null;
      const balance = await client.getBalance({ address: minter }).catch(() => null);
      results.push({ wallet, simulation: 'passed', estimatedGas: estimatedGas?.toString() ?? null, estimatedCostEth: cost === null ? null : ethString(cost), withinPerWalletCap: cost === null ? null : cost <= FREE_MINT_PER_WALLET_RESERVE_CAP_WEI, balanceEth: balance === null ? null : ethString(balance), hasEnoughForGas: balance === null || cost === null ? null : balance >= cost });
    } catch (error) {
      results.push({ wallet, simulation: 'failed', reason: providerErrorDetail(error), estimatedGas: null, estimatedCostEth: null, withinPerWalletCap: null, balanceEth: null, hasEnoughForGas: null });
    }
  }
  const passed = results.filter((item) => item.simulation === 'passed').length;
  return { contract, verdict: passed > 0 ? 'ok' : 'blocked', summary: `${passed} of ${results.length} wallet(s) simulated a ${quantity}-NFT free mint successfully (simulation only; nothing was sent). ${results.filter((item) => item.hasEnoughForGas === false).length} of them hold too little ETH on Robinhood to pay for the gas.`, drop: dropView, quantity, wallets: results };
}
