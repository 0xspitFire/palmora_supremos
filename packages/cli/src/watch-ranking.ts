/**
 * First watched-wallet ranking (P2 exit assessment, checklist "first watched-wallet ranking").
 *
 * Read-only. It looks at what the trial already recorded: the scored opportunities (which watched wallets minted or received each
 * collection, the best score it reached, whether it triggered an alert, whether it was free) and ranks the watched wallets by that
 * activity. It changes nothing, sends nothing and never needs a key.
 *
 * What it does NOT measure yet (said in the output): profit, win rate and floor performance. Those arrive with analytics
 * (score factor "track_record"). So this is an activity-and-signal ranking over the days the bot has watched, not a verdict on quality.
 */
export interface RankingEvent {
  type: string;
  at: string;
  data: Record<string, unknown>;
}

export interface WatchedWallet {
  address: string;
  label: string | null;
}

export interface RankedWallet {
  rank: number;
  address: string;
  label: string | null;
  /** Distinct collections this wallet minted. */
  collectionsMinted: number;
  /** Distinct collections it received an NFT from (a transfer to it, not a mint it paid for). Shown, but never used for the ranking: anyone can send an NFT to any wallet. */
  collectionsReceived: number;
  /** Of the collections it MINTED, how many reached the alert level (and were not blocked). */
  alertCollections: number;
  /** Mean of the best score each of its MINTED collections reached (0 to 100). The score belongs to the collection and partly counts how many watched wallets minted it. Null when it minted nothing. */
  averageBestScore: number | null;
  /** Share of its minted collections that were free mints, 0 to 1, or null. */
  freeShare: number | null;
  lastActiveAt: string | null;
}

export interface WatchRanking {
  ranked: RankedWallet[];
  /** Watched wallets with no activity in the data. */
  silent: WatchedWallet[];
  meta: { watchedWallets: number; opportunitiesSeen: number; eventsRead: number; dataFrom: string | null; dataTo: string | null; days: number };
}

interface ContractFacts {
  maxScore: number | null;
  notified: boolean;
  free: boolean | null;
  firstAt: string;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const addressList = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && ADDRESS.test(item)).map((item) => item.toLowerCase()) : []);

function isFree(value: unknown): boolean | null {
  if (typeof value === 'bigint') return value === 0n;
  if (typeof value === 'number' && Number.isFinite(value)) return value === 0;
  if (typeof value === 'string' && /^\d+n?$/.test(value)) return BigInt(value.replace(/n$/, '')) === 0n;
  return null;
}

export function rankWatchedWallets(input: { events: readonly RankingEvent[]; watched: readonly WatchedWallet[] }): WatchRanking {
  const facts = new Map<string, ContractFacts>();
  const minted = new Map<string, Set<string>>();
  const received = new Map<string, Set<string>>();
  const lastActive = new Map<string, string>();
  let eventsRead = 0;
  let dataFrom: string | null = null;
  let dataTo: string | null = null;

  const watchedSet = new Set(input.watched.map((wallet) => wallet.address.toLowerCase()));
  for (const event of input.events) {
    if (event.type !== 'opportunity_scored' && event.type !== 'opportunity_notified') continue;
    // The scan is Ethereum-only today; an event that names another chain is not part of this ranking.
    if (event.data.chainId !== undefined && Number(event.data.chainId) !== 1) continue;
    const contract = typeof event.data.contract === 'string' && ADDRESS.test(event.data.contract) ? event.data.contract.toLowerCase() : undefined;
    if (!contract || !Number.isFinite(Date.parse(event.at))) continue;
    eventsRead += 1;
    if (dataFrom === null || event.at < dataFrom) dataFrom = event.at;
    if (dataTo === null || event.at > dataTo) dataTo = event.at;
    const score = typeof event.data.score === 'number' && Number.isFinite(event.data.score) ? event.data.score : null;
    // An alert is raised only for a collection that reached the alert level and is not blocked.
    const notified = (event.type === 'opportunity_notified' || event.data.disposition === 'notified' || event.data.band === 'notify') && event.data.blocked !== true;
    const known = facts.get(contract);
    const next: ContractFacts = known ?? { maxScore: null, notified: false, free: null, firstAt: event.at };
    if (score !== null && (next.maxScore === null || score > next.maxScore)) next.maxScore = score;
    if (notified) next.notified = true;
    const free = isFree(event.data.priceWei);
    if (free !== null) next.free = free;
    if (event.at < next.firstAt) next.firstAt = event.at;
    facts.set(contract, next);
    for (const [list, target] of [[addressList(event.data.watchedMinters), minted], [addressList(event.data.watchedReceivers), received]] as const) {
      for (const wallet of list) {
        if (!watchedSet.has(wallet)) continue;
        (target.get(wallet) ?? target.set(wallet, new Set()).get(wallet))!.add(contract);
        if ((lastActive.get(wallet) ?? '') < event.at) lastActive.set(wallet, event.at);
      }
    }
  }

  const rows: Array<Omit<RankedWallet, 'rank'>> = [];
  const silent: WatchedWallet[] = [];
  const seen = new Set<string>();
  for (const wallet of input.watched) {
    const address = wallet.address.toLowerCase();
    if (seen.has(address)) continue;
    seen.add(address);
    const mintedSet = minted.get(address) ?? new Set<string>();
    const receivedSet = received.get(address) ?? new Set<string>();
    if (mintedSet.size === 0 && receivedSet.size === 0) { silent.push(wallet); continue; }
    // Only what the wallet minted counts toward the figures that rank it (a received NFT can be an airdrop or spam).
    const all = mintedSet;
    const scores = [...all].map((contract) => facts.get(contract)?.maxScore).filter((score): score is number => typeof score === 'number');
    const freeKnown = [...all].map((contract) => facts.get(contract)?.free).filter((value): value is boolean => typeof value === 'boolean');
    rows.push({
      address: wallet.address,
      label: wallet.label,
      collectionsMinted: mintedSet.size,
      collectionsReceived: receivedSet.size,
      alertCollections: [...all].filter((contract) => facts.get(contract)?.notified === true).length,
      averageBestScore: scores.length === 0 ? null : Math.round((scores.reduce((sum, score) => sum + score, 0) / scores.length) * 10) / 10,
      freeShare: freeKnown.length === 0 ? null : Math.round((freeKnown.filter(Boolean).length / freeKnown.length) * 100) / 100,
      lastActiveAt: lastActive.get(address) ?? null,
    });
  }
  rows.sort((left, right) =>
    right.alertCollections - left.alertCollections
    || right.collectionsMinted - left.collectionsMinted
    || (right.averageBestScore ?? -1) - (left.averageBestScore ?? -1)
    || (right.lastActiveAt ?? '').localeCompare(left.lastActiveAt ?? '')
    || left.address.toLowerCase().localeCompare(right.address.toLowerCase()));
  const days = dataFrom && dataTo ? Math.max(0, Math.round(((Date.parse(dataTo) - Date.parse(dataFrom)) / 86_400_000) * 10) / 10) : 0;
  return {
    ranked: rows.map((row, index) => ({ rank: index + 1, ...row })),
    silent,
    meta: { watchedWallets: seen.size, opportunitiesSeen: facts.size, eventsRead, dataFrom, dataTo, days },
  };
}

const shortAddress = (address: string): string => `${address.slice(0, 6)}…${address.slice(-4)}`;

/** Plain-language text for the owner. */
export function renderWatchRanking(result: WatchRanking, top = 15): string {
  const { meta } = result;
  const lines: string[] = [
    'WATCHED-WALLET RANKING (first version)',
    `Based on ${meta.opportunitiesSeen} collections the bot scored over about ${meta.days} day(s)` + (meta.dataFrom && meta.dataTo ? ` (${meta.dataFrom.slice(0, 16).replace('T', ' ')} to ${meta.dataTo.slice(0, 16).replace('T', ' ')} UTC).` : '.'),
    `${result.ranked.length} of your ${meta.watchedWallets} watched wallets were active; ${result.silent.length} were not seen minting or receiving anything.`,
    '',
    'Ranked by: collections it minted that reached the alert level, then collections minted, then average best score, then most recent activity. NFTs a wallet only received are shown but not counted (anyone can send an NFT to any wallet).',
    'A collection\'s score is the collection\'s, and it partly rises with how many watched wallets minted it, so wallets that mint together lift each other.',
    'Not measured yet: profit, win rate and floor performance (they arrive with analytics). This is an activity and signal ranking, not a verdict on quality.',
    '',
  ];
  for (const row of result.ranked.slice(0, top)) {
    const name = row.label ? `${row.label} (${shortAddress(row.address)})` : shortAddress(row.address);
    const free = row.freeShare === null ? 'price unknown' : `${Math.round(row.freeShare * 100)}% free`;
    const score = row.averageBestScore === null ? 'no score' : `average best score ${row.averageBestScore}`;
    lines.push(`${row.rank}. ${name}: minted ${row.collectionsMinted}, received ${row.collectionsReceived}, ${row.alertCollections} of the minted reached the alert level, ${score}, ${free}, last active ${row.lastActiveAt ? row.lastActiveAt.slice(0, 16).replace('T', ' ') + ' UTC' : 'unknown'}.`);
  }
  if (result.ranked.length > top) lines.push(`... and ${result.ranked.length - top} more active wallet(s); use --top ${result.ranked.length} to see all.`);
  if (result.ranked.length === 0) lines.push('No watched wallet has been seen minting or receiving anything yet.');
  return lines.join('\n');
}

/** Pulls the inputs out of the trial database. `db` is a read-only connection. */
export function readRankingInputs(db: { prepare(sql: string): { all(...params: unknown[]): unknown[]; iterate(...params: unknown[]): Iterable<unknown> } }): { events: RankingEvent[]; watched: WatchedWallet[] } {
  // One row at a time, so a large database never has to be held in memory as raw text.
  const rows = db.prepare("SELECT new_state, occurred_at, policy_snapshot_json FROM audit_event WHERE new_state IN ('opportunity_scored', 'opportunity_notified') ORDER BY occurred_at").iterate() as Iterable<{ new_state: string; occurred_at: string; policy_snapshot_json: string | null }>;
  const events: RankingEvent[] = [];
  for (const row of rows) {
    if (!row.policy_snapshot_json) continue;
    try {
      const parsed = JSON.parse(row.policy_snapshot_json) as { eventData?: unknown };
      if (typeof parsed.eventData === 'object' && parsed.eventData !== null && !Array.isArray(parsed.eventData)) events.push({ type: row.new_state, at: row.occurred_at, data: parsed.eventData as Record<string, unknown> });
    } catch { /* one damaged row never stops the report */ }
  }
  const watched = (db.prepare('SELECT address, label FROM observed_address WHERE chain_id = 1 AND enabled = 1 ORDER BY address').all() as Array<{ address: string; label: string | null }>).map((row) => ({ address: row.address, label: row.label }));
  return { events, watched };
}
