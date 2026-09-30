import type { BackendStore, IntelligenceRepositoryPort } from '@mint-bot/backend';

/**
 * Owner-facing status messages for the trial (T-005). Plain language, no secrets,
 * no RPC values and no full owner addresses. Delivery never proves anything about execution.
 */
export function startMessage(input: { watched: number; ownWallets: number; dashboardUrl: string }): string {
  return `MintBot is running (read-only). Watching Ethereum SeaDrop mints, ${input.watched} watched wallet(s) and ${input.ownWallets} of your wallet(s). Dashboard on this computer: ${input.dashboardUrl}. Nothing will be bought or sent. You will get a short check-in once a day; if it stops arriving, the bot has stopped.`;
}

export interface CheckInCounts { opportunities: number; upcomingMints: number; alerts: number; lastBlock: string | null; }

/** Counts from durable events over the last 24 hours. */
export function checkInCounts(store: BackendStore, repo: IntelligenceRepositoryPort, now: Date): CheckInCounts {
  const since = now.getTime() - 24 * 60 * 60_000;
  const opportunities = new Set<string>();
  const upcoming = new Set<string>();
  let alerts = 0;
  for (const event of store.snapshot().events) {
    const at = Date.parse(event.at);
    if (!Number.isFinite(at) || at < since) continue;
    if (event.type.startsWith('opportunity_')) opportunities.add(String(event.data.opportunityId ?? event.id));
    else if (event.type === 'calendar_entry' && typeof event.data.openingAt === 'string' && Date.parse(event.data.openingAt) > now.getTime()) upcoming.add(String(event.data.id ?? event.id));
    else if (event.type.startsWith('alert_') && event.type !== 'alert_digest' && event.type !== 'alert_status') alerts += 1;
  }
  const cursor = repo.cursor(1, 'seadrop-v1');
  return { opportunities: opportunities.size, upcomingMints: upcoming.size, alerts, lastBlock: cursor === undefined ? null : cursor.toString() };
}

export function checkInMessage(counts: CheckInCounts): string {
  const scan = counts.lastBlock === null ? 'No blocks scanned yet, so the chain connection may need attention.' : `Last Ethereum block checked: ${counts.lastBlock}.`;
  return `Daily check-in: MintBot is still running (read-only). Last 24 hours: ${counts.opportunities} mint(s) scored, ${counts.upcomingMints} upcoming mint(s) on the calendar, ${counts.alerts} alert(s). ${scan}`;
}
