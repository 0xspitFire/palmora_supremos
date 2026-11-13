import { fundingCostSummary, buildCanonicalAnalyticsReport, readAnalyticsObservations, readAnalyticsWalletScope, personalAnalyticsActivities, readAnalyticsFloorQuotes, formatEth, type BackendState } from '@mint-bot/backend';

/** Only accepted durable observations and canonical costs; never a live decision input. */
export function describeAnalytics(state: BackendState, now = new Date()): string {
  const ingested = readAnalyticsObservations(state.events);
  const ownedWallets = readAnalyticsWalletScope(state.events);
  const report = buildCanonicalAnalyticsReport(state, { activities: ownedWallets?personalAnalyticsActivities(ingested.activities,ownedWallets):ingested.activities, floorQuotes:readAnalyticsFloorQuotes(state.events,now), ownedWallets, now });
  const funding = fundingCostSummary(state.events, ingested.fundingAllocations);
  const amount = (value: string | null) => value === null ? 'unknown' : `${formatEth(BigInt(value))} ETH`;
  return [
    'Analytics · ETH FIFO · shadow only',
    `Canonical executions: ${report.canonical.executionsSeen}; reconciled costs: ${report.canonical.completeCosts}; incomplete: ${report.canonical.incompleteCosts}.`,
    `Recorded mint costs and gas: ${amount(report.canonical.recordedTotalCostWei)}.`,
    `Confirmed observed activities: ${ingested.activities.length}.`,
    `Recorded funding principal moved (not an expense): ${formatEth(funding.principalWei)} ETH.`,
    `Funding gas expense: ${formatEth(funding.gasExpenseWei)} ETH; already allocated in NFT basis: ${formatEth(funding.allocatedGasWei)} ETH; without verified NFT allocation: ${formatEth(funding.unallocatedGasWei)} ETH; unknown operations: ${funding.unknownOperations}.`,
    `Realized PnL: ${amount(report.totals.realizedPnlWei)}.`,
    `Unrealized PnL: ${amount(report.totals.unrealizedPnlWei)}.`,
    `Realized ROI: ${report.totals.realizedRoiBps === null ? 'unknown' : `${report.totals.realizedRoiBps} basis points`}.`,
    'Sale history and fresh market prices are not assumed complete. Missing costs, token identities and sales remain unknown. Floor estimates are not sale proceeds. This report does not change live scores or authorize minting. Adaptive scoring is separately owner-governed.',
  ].join('\n');
}
