import { buildCanonicalAnalyticsReport, readCanonicalAnalyticsActivities, formatEth, type BackendState } from '@mint-bot/backend';

/** Only accepted durable observations and canonical costs; never a live decision input. */
export function describeAnalytics(state: BackendState, now = new Date()): string {
  const ingested = readCanonicalAnalyticsActivities(state.events);
  const report = buildCanonicalAnalyticsReport(state, { activities: ingested.activities, now });
  const amount = (value: string | null) => value === null ? 'unknown' : `${formatEth(BigInt(value))} ETH`;
  return [
    'Analytics · ETH FIFO · shadow only',
    `Canonical executions: ${report.canonical.executionsSeen}; reconciled costs: ${report.canonical.completeCosts}; incomplete: ${report.canonical.incompleteCosts}.`,
    `Recorded mint costs and gas: ${amount(report.canonical.recordedTotalCostWei)}.`,
    `Confirmed acquisition observations: ${ingested.activities.length}.`,
    `Realized PnL: ${amount(report.totals.realizedPnlWei)}.`,
    `Unrealized PnL: ${amount(report.totals.unrealizedPnlWei)}.`,
    `Realized ROI: ${report.totals.realizedRoiBps === null ? 'unknown' : `${report.totals.realizedRoiBps} basis points`}.`,
    'Sale history and fresh market prices are not assumed complete. Missing costs, token identities and sales remain unknown. Floor estimates are not sale proceeds. Feedback does not change live scores or authorize minting.',
  ].join('\n');
}
