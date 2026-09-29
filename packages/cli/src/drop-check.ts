import { D033_READINESS_LIMITS, formatEth, paidQuantityForScore, type IntelligenceChainPort, type ReadinessLimits } from '@mint-bot/backend';

const MAX_TIME_SECONDS = 7_258_118_400;

/**
 * Read-only drop check behind CLI `validate` and `simulate` (T-004, P2-08).
 * It reads the drop from chain and never signs or sends anything.
 */
export interface DropCheckWallet { wallet: string; balanceEth: string | null; requiredEth: string; topUpEth: string | null; simulation: 'passed' | 'failed' | 'not run' | 'unavailable'; verdict: 'ready' | 'needs ETH' | 'blocked' | 'unknown' | 'funded'; note: string; }
export interface DropCheckReport {
  contract: string;
  verdict: 'ok' | 'blocked' | 'unknown';
  summary: string;
  drop: { priceEth: string; opensAt: string | null; closesAt: string | null; maxPerWallet: number; status: 'upcoming' | 'open' | 'ended' } | null;
  quantity: number;
  wallets: DropCheckWallet[];
}

export async function checkDrop(port: IntelligenceChainPort, contract: string, wallets: readonly string[], options: { quantity?: number; score?: number | null; simulate: boolean; now?: Date; limits?: ReadinessLimits }): Promise<DropCheckReport> {
  const limits = options.limits ?? D033_READINESS_LIMITS;
  const now = (options.now ?? new Date()).getTime();
  if (!/^0x[0-9a-fA-F]{40}$/.test(contract)) return { contract, verdict: 'blocked', summary: 'That is not a valid contract address.', drop: null, quantity: 0, wallets: [] };
  const hasCode = await port.hasCode(contract);
  if (hasCode === false) return { contract, verdict: 'blocked', summary: 'There is no contract at this address on Ethereum.', drop: null, quantity: 0, wallets: [] };
  const drop = await port.readDrop(contract);
  if (!drop) return { contract, verdict: hasCode === null ? 'unknown' : 'blocked', summary: hasCode === null ? 'The chain could not be read. Try again shortly.' : 'This contract has no SeaDrop public mint the bot supports.', drop: null, quantity: 0, wallets: [] };
  if (!Number.isSafeInteger(drop.startTime) || drop.startTime < 0 || drop.startTime > MAX_TIME_SECONDS) return { contract, verdict: 'blocked', summary: 'The drop has an invalid opening time.', drop: null, quantity: 0, wallets: [] };
  const startMs = drop.startTime * 1000;
  const endMs = drop.endTime === 0 || drop.endTime > MAX_TIME_SECONDS ? Number.POSITIVE_INFINITY : drop.endTime * 1000;
  const status = now < startMs ? 'upcoming' : now >= endMs ? 'ended' : 'open';
  const dropView = { priceEth: formatEth(drop.priceWei), opensAt: startMs > 0 ? new Date(startMs).toISOString() : null, closesAt: Number.isFinite(endMs) ? new Date(endMs).toISOString() : null, maxPerWallet: drop.maxPerWallet, status } as const;
  if (status === 'ended') return { contract, verdict: 'blocked', summary: 'This mint has ended.', drop: dropView, quantity: 0, wallets: [] };
  if (drop.priceWei > limits.paidMaxPricePerNftWei) return { contract, verdict: 'blocked', summary: `Price ${formatEth(drop.priceWei)} ETH is above your ${formatEth(limits.paidMaxPricePerNftWei)} ETH per-NFT limit.`, drop: dropView, quantity: 0, wallets: [] };
  const free = drop.priceWei === 0n;
  const planned = options.quantity ?? (free ? drop.maxPerWallet : Math.max(1, paidQuantityForScore(options.score ?? null)));
  const quantity = drop.maxPerWallet > 0 ? Math.min(planned, drop.maxPerWallet) : planned;
  if (quantity < 1) return { contract, verdict: 'blocked', summary: 'The drop allows no mints per wallet.', drop: dropView, quantity: 0, wallets: [] };
  const selected = free ? [...wallets] : wallets.slice(0, limits.paidMaxWalletsPerMint);
  const required = drop.priceWei * BigInt(quantity) + (free ? limits.freeFeeAllowanceWei : limits.paidFeeAllowanceWei);
  const rows: DropCheckWallet[] = [];
  for (const wallet of selected) {
    const balance = await port.balance(wallet);
    const base = { wallet, balanceEth: balance === null ? null : formatEth(balance), requiredEth: formatEth(required) };
    if (balance === null) { rows.push({ ...base, topUpEth: null, simulation: 'not run', verdict: 'unknown', note: 'Balance could not be read.' }); continue; }
    if (balance < required) { rows.push({ ...base, topUpEth: formatEth(required - balance), simulation: 'not run', verdict: 'needs ETH', note: `Send ${formatEth(required - balance)} ETH to this wallet on Ethereum.` }); continue; }
    if (!options.simulate || status !== 'open') { rows.push({ ...base, topUpEth: null, simulation: 'not run', verdict: 'funded', note: status === 'open' ? 'Funded. Run `simulate` to test the mint call.' : 'Funded. The test mint call can run once the mint opens.' }); continue; }
    const result = await port.simulateMint(wallet, contract, quantity, drop.priceWei * BigInt(quantity));
    if (result.outcome === 'pass') rows.push({ ...base, topUpEth: null, simulation: 'passed', verdict: 'ready', note: 'A test mint call succeeded. Minting still needs your approval.' });
    else if (result.outcome === 'fail') rows.push({ ...base, topUpEth: null, simulation: 'failed', verdict: 'blocked', note: `The test mint call failed (${result.reason}). This wallet must not mint.` });
    else rows.push({ ...base, topUpEth: null, simulation: 'unavailable', verdict: 'unknown', note: 'The test mint call could not run.' });
  }
  const ready = rows.filter((row) => row.verdict === 'ready' || row.verdict === 'funded').length;
  const skipped = wallets.length - selected.length;
  const summary = `${ready} of ${selected.length} wallets are funded for ${quantity} NFT(s) each at ${free ? 'no mint cost' : `${formatEth(drop.priceWei)} ETH`} (mint is ${status}).${skipped > 0 ? ` ${skipped} wallet(s) left out: paid mints use at most ${limits.paidMaxWalletsPerMint}.` : ''}${free && selected.length < limits.freeMinWallets ? ` You asked for at least ${limits.freeMinWallets} wallets on free mints.` : ''}`;
  return { contract, verdict: rows.some((row) => row.verdict === 'blocked') ? 'blocked' : rows.every((row) => row.verdict === 'ready' || row.verdict === 'funded') ? 'ok' : 'unknown', summary, drop: dropView, quantity, wallets: rows };
}
