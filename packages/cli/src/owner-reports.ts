import { BASE_PERSONAL_LIVE_FLEET_POLICY, PERSONAL_LIVE_FLEET_POLICY, ROBINHOOD_FREE_ACTIVE_PERIOD_CAP_WEI, ROBINHOOD_FREE_PER_WALLET_CAP_WEI, formatEth, type BackendState } from '@mint-bot/backend';

/**
 * T-066: plain-text reports for the owner's Telegram commands (/limits, /history, /activity). Pure and read-only: they only describe
 * what the database already holds, and never write, sign or change a limit.
 */
const CHAINS: ReadonlyArray<{ id: 1 | 8453 | 4663; name: string }> = [{ id: 1, name: 'Ethereum' }, { id: 8453, name: 'Base' }, { id: 4663, name: 'Robinhood' }];
const DAY_MS = 86_400_000;
const when = (iso: string): string => iso.slice(0, 16).replace('T', ' ');
const short = (address: string): string => `${address.slice(0, 6)}…${address.slice(-4)}`;

/** The rolling-day caps the guards enforce at admission (D-033, D-057, D-041, D-066). */
export function dailyCaps(chainId: 1 | 8453 | 4663): { free: bigint; paid: bigint } {
  if (chainId === 8453) return { free: BASE_PERSONAL_LIVE_FLEET_POLICY.freeDailyCapWei, paid: BASE_PERSONAL_LIVE_FLEET_POLICY.paidDailyCapWei };
  const free = chainId === 4663 && PERSONAL_LIVE_FLEET_POLICY.freeDailyCapWei > ROBINHOOD_FREE_ACTIVE_PERIOD_CAP_WEI ? ROBINHOOD_FREE_ACTIVE_PERIOD_CAP_WEI : PERSONAL_LIVE_FLEET_POLICY.freeDailyCapWei;
  return { free, paid: PERSONAL_LIVE_FLEET_POLICY.paidDailyCapWei };
}

/** How much of each rolling-day limit is used (pending plus settled reservations of the last 24 hours) and what is left. */
export function describeLimits(state: Pick<BackendState, 'reservations' | 'campaigns' | 'killed'>, now: Date, killFileEngaged: boolean): string {
  const cutoff = now.getTime() - DAY_MS;
  const classOf = new Map(state.campaigns.map((campaign) => [campaign.id, campaign.mintPriceWei === 0n ? 'free' as const : 'paid' as const]));
  const lines = [`Kill switch: ${killFileEngaged || state.killed ? 'ON (nothing can be spent)' : 'off'}`, 'Used in the last 24 hours (pending and settled), against each daily limit:'];
  let openReservations = 0;
  for (const chain of CHAINS) {
    const caps = dailyCaps(chain.id);
    const used = { free: 0n, paid: 0n };
    for (const reservation of state.reservations) {
      if (reservation.chainId !== chain.id) continue;
      if (reservation.status === 'reserved') openReservations += 1;
      const counts = reservation.status === 'reserved' || (reservation.status === 'settled' && Date.parse(reservation.updatedAt) >= cutoff);
      if (counts) used[classOf.get(reservation.campaignId) ?? 'free'] += reservation.amountWei;
    }
    const left = (cap: bigint, spent: bigint): string => formatEth(cap > spent ? cap - spent : 0n);
    lines.push(`${chain.name}: free ${formatEth(used.free)} of ${formatEth(caps.free)} ETH (${left(caps.free, used.free)} left)${caps.paid > 0n ? `, paid ${formatEth(used.paid)} of ${formatEth(caps.paid)} ETH (${left(caps.paid, used.paid)} left)` : ''}`);
  }
  lines.push(`Per wallet, per free mint: Robinhood ${formatEth(ROBINHOOD_FREE_PER_WALLET_CAP_WEI)} ETH, Base ${formatEth(BASE_PERSONAL_LIVE_FLEET_POLICY.freeFeeAllowanceWei)} ETH, Ethereum ${formatEth(PERSONAL_LIVE_FLEET_POLICY.freeFeeAllowanceWei)} ETH (the fee allowance).`);
  lines.push(`Reservations still open: ${openReservations}.`);
  return lines.join('\n');
}

/** Past live mints: totals per chain, then the newest runs. */
export function describeHistory(state: Pick<BackendState, 'runs' | 'campaigns' | 'receipts' | 'reservations'>, limit = 8): string {
  const campaigns = new Map(state.campaigns.map((campaign) => [campaign.id, campaign]));
  const liveRuns = state.runs.filter((run) => run.mode === 'live').sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  if (liveRuns.length === 0) return 'No live mints yet.';
  const perRun = liveRuns.map((run) => {
    const campaign = campaigns.get(run.campaignId);
    const receipts = state.receipts.filter((receipt) => receipt.runId === run.id);
    const confirmed = receipts.filter((receipt) => receipt.state === 'Confirmed');
    const wallets = state.reservations.filter((reservation) => reservation.runId === run.id).length;
    const spent = receipts.reduce((total, receipt) => total + (receipt.actualSpendWei ?? 0n), 0n);
    return { run, campaign, wallets, minted: confirmed.length, nfts: confirmed.length * (campaign?.quantity ?? 0), spent };
  });
  const lines = ['Totals by chain:'];
  for (const chain of CHAINS) {
    const rows = perRun.filter((row) => row.campaign?.chainId === chain.id);
    if (rows.length === 0) continue;
    lines.push(`${chain.name}: ${rows.length} run(s), ${rows.reduce((total, row) => total + row.minted, 0)} wallet mint(s), ${rows.reduce((total, row) => total + row.nfts, 0)} NFT(s), spent ${formatEth(rows.reduce((total, row) => total + row.spent, 0n))} ETH in fees and prices`);
  }
  lines.push('', `Newest ${Math.min(limit, perRun.length)} run(s):`);
  for (const row of perRun.slice(0, limit)) lines.push(`• ${when(row.run.createdAt)} UTC — ${row.campaign ? (CHAINS.find((chain) => chain.id === row.campaign!.chainId)?.name ?? 'chain') : 'campaign unknown'} ${row.campaign ? short(row.campaign.contract) : ''} — ${row.run.state}, ${row.minted} of ${row.wallets} wallet(s) minted, ${formatEth(row.spent)} ETH (${row.run.id})`);
  lines.push('', 'Details of one run: /run <id>');
  return lines.join('\n');
}

/** The newest mints by wallets you track, from what discovery recorded. */
export function describeActivity(events: BackendState['events'], labels: ReadonlyMap<string, string | null>, limit = 10): string {
  const rows = events
    .filter((event) => event.type.startsWith('opportunity_') && Array.isArray(event.data.watchedMinters) && (event.data.watchedMinters as unknown[]).length > 0)
    .sort((left, right) => right.at.localeCompare(left.at));
  if (rows.length === 0) return 'No mints by tracked wallets have been recorded yet. Track wallets with /track.';
  const seen = new Set<string>();
  const lines = ['Recent mints by wallets you track (newest first):'];
  for (const event of rows) {
    const contract = String(event.data.contract ?? '');
    if (seen.has(contract)) continue;
    seen.add(contract);
    const minters = (event.data.watchedMinters as unknown[]).map((address) => { const key = String(address).toLowerCase(); return labels.get(key) ?? short(key); });
    const name = typeof event.data.collectionName === 'string' ? event.data.collectionName : 'unnamed';
    lines.push(`• ${when(event.at)} UTC — ${name} ${contract ? short(contract) : ''} — ${[...new Set(minters)].slice(0, 4).join(', ')}${typeof event.data.score === 'number' ? ` (score ${event.data.score})` : ''}${contract ? `\n  ${contract}` : ''}`);
    if (lines.length > limit) break;
  }
  return lines.join('\n');
}
