import { chainDisplay, checkInCard, parseAlertCard, startCard, type BackendStore, type IntelligenceRepositoryPort, type SystemCard } from '@mint-bot/backend';

/**
 * Owner-facing status messages for the trial (T-005, T-030): the start message and the daily check-in, as
 * structured system cards for Telegram. Plain language, no secrets, no RPC values and no full owner addresses.
 * Delivery never proves anything about execution.
 */
const DAY_MS = 24 * 60 * 60_000;
/** The outbox retries for this long, so a failure older than this is no longer pending. */
const RETRY_WINDOW_MS = 6 * 60 * 60_000;

export function startMessage(input: { watched: number; ownWallets: number; startedAt: Date; startNumber?: number; version?: string }): SystemCard {
  return startCard({
    mode: 'read-only',
    watched: input.watched,
    ownWallets: input.ownWallets,
    ...(input.startNumber !== undefined ? { startNumber: input.startNumber } : {}),
    ...(input.version ? { version: input.version } : {}),
    at: input.startedAt,
  });
}

export interface CheckInCounts {
  opportunities: number;
  upcomingMints: number;
  alerts: number;
  healthWarnings: number;
  lastBlock: string | null;
  failedDeliveries: number;
  /** Deliveries that failed within the retry window and are still being retried. */
  pendingFailures: number;
  latest?: { title: string; name: string; at: Date };
}

/** Counts from durable events over the last 24 hours. */
export function checkInCounts(store: BackendStore, repo: IntelligenceRepositoryPort, now: Date): CheckInCounts {
  const since = now.getTime() - DAY_MS;
  const opportunities = new Set<string>();
  const upcoming = new Set<string>();
  let alerts = 0;
  const healthEpisodes = new Set<string>();
  let latest: CheckInCounts['latest'];
  const state = store.snapshot();
  for (const event of state.events) {
    const at = Date.parse(event.at);
    if (!Number.isFinite(at) || at < since) continue;
    if (event.type.startsWith('opportunity_')) opportunities.add(String(event.data.opportunityId ?? event.id));
    else if (event.type === 'calendar_entry' && typeof event.data.openingAt === 'string' && Date.parse(event.data.openingAt) > now.getTime()) upcoming.add(String(event.data.id ?? event.id));
    else if (event.type === 'alert_health') { const parts = String(event.data.dedupe ?? '').split(':'); /* health:<key>:<episode, an ISO time with colons>:<stage> */ if (parts.length >= 4 && parts.at(-1) !== 'recovered') healthEpisodes.add(parts.slice(1, -1).join(':')); }
    else if (event.type.startsWith('alert_') && event.type !== 'alert_digest' && event.type !== 'alert_status') {
      alerts += 1;
      const card = parseAlertCard(event.data.card);
      if (card && (!latest || at > latest.at.getTime())) latest = { title: card.title.split(' · ')[0] ?? card.title, name: card.collectionName ?? `${chainDisplay(card.chainId).short} MINT`, at: new Date(at) };
    }
  }
  const failed = state.notificationOutbox.filter((item) => item.state === 'failed');
  const cursor = repo.cursor(1, 'seadrop-v1');
  return {
    opportunities: opportunities.size,
    upcomingMints: upcoming.size,
    alerts,
    healthWarnings: healthEpisodes.size,
    lastBlock: cursor === undefined ? null : cursor.toString(),
    failedDeliveries: failed.filter((item) => Date.parse(item.createdAt) >= since).length,
    pendingFailures: failed.filter((item) => now.getTime() - Date.parse(item.createdAt) <= RETRY_WINDOW_MS).length,
    ...(latest ? { latest } : {}),
  };
}

export function checkInMessage(counts: CheckInCounts, facts: { runningSince: Date; now: Date; lastScanAt: Date | null; scanStale: boolean }): SystemCard {
  return checkInCard({
    runningSince: facts.runningSince,
    now: facts.now,
    opportunities: counts.opportunities,
    upcomingMints: counts.upcomingMints,
    alerts: counts.alerts,
    healthWarnings: counts.healthWarnings,
    lastScanAt: facts.lastScanAt,
    lastBlock: counts.lastBlock,
    scanStale: facts.scanStale,
    telegramDelivering: counts.pendingFailures === 0,
    failedDeliveries: counts.failedDeliveries,
    ...(counts.latest ? { latest: counts.latest } : {}),
  });
}
