import { describe, expect, it } from 'vitest';
import type { AnalyticsReadModel, ReadModelEnvelope } from './contracts.js';
import { renderAnalytics } from './surfaces.js';
import { renderDocument } from './server.js';
import { formatSignedWei, formatBasisPoints } from './format.js';

const summary = (): AnalyticsReadModel => ({ mode: 'shadow-only', method: 'FIFO', currency: 'ETH', coverage: { scope: 'canonical-finalized-mints-only', canonicalExecutions: 1, completeCosts: 1, incompleteCosts: 0, confirmedActivities: 0, pendingExcluded: 0, reorgedExcluded: 0, unavailableObservations: 0, acquisitionHistory: 'no_samples', externalTransfersAndSalesComplete: false, providerCoverageAsserted: false, groupsOmitted: 0 }, totals: { recordedCanonicalCostWei: '1000000000000000', realizedPnlWei: null, realizedRoiBps: null, unrealizedPnlWei: null, transactionAndMarketplaceFeesWei: null }, groups: [], shadow: [] });
const envelope = (data = summary()): ReadModelEnvelope<AnalyticsReadModel> => ({ contract: 'mintbot.read-model', version: '1', requestId: 'accounting', generatedAt: '2026-11-13T10:00:00.000Z', snapshot: { id: 'snapshot', capturedAt: '2026-11-13T10:00:00.000Z', consistency: 'snapshot' }, availability: 'partial', freshness: { status: 'fresh', observedAt: '2026-11-13T10:00:00.000Z', expiresAt: null, ageSeconds: '0', policyVersion: 'read-model-v1' }, data, issues: [] });

describe('read-only accounting surface', () => {
  it('shows recorded costs, unknown sale outcomes and coverage without execution controls', () => {
    const html = renderDocument({ analytics: envelope() });
    expect(html).toContain('0.001 ETH');
    expect(html).toContain('Realized PnL from supplied facts');
    expect(html).toContain('Unknown');
    expect(html).toContain('External sale and transfer history is incomplete');
    expect(html).toContain('Shadow only.');
    expect(html).toContain('href="#analytics"');
    expect(html).not.toMatch(/<script|<form|<button/i);
    expect(html).not.toContain('0.00%');
  });

  it('renders exact signed accounting values and never promotes a shadow policy', () => {
    const data = summary();
    const result = { ...data, totals: { ...data.totals, realizedPnlWei: '-1234567890123456789', realizedRoiBps: '-1234' } };
    const html = renderAnalytics(envelope(result));
    expect(html).toContain('-1.234567890123456789 ETH');
    expect(html).toContain('-12.34%');
    expect(html).toContain('No replay evaluation samples have been supplied. No strategy change is recommended.');
  });

  it('redacts unsafe group identifiers and rejects malformed monetary text', () => {
    const data = summary();
    const row = { dimension: 'wallet' as const, key: 'api_key:SYNTHETIC_SECRET_MARKER', executions: 1, dispositions: 1, recordedCostWei: '<script>unsafe</script>', realizedPnlWei: null, unknownBasisQuantity: '0' };
    const html = renderAnalytics(envelope({ ...data, groups: [row] }));
    expect(html).not.toContain('SYNTHETIC_SECRET_MARKER');
    expect(html).not.toContain('<script>');
    expect(formatSignedWei(null)).toBe('Unknown');
    expect(formatBasisPoints('not-a-percent')).toBe('Unknown');
  });
});

it('labels partial external scope and funding overhead without adding it twice to PnL',()=>{
 const data=summary();const html=renderAnalytics(envelope({...data,coverage:{...data.coverage,scope:'verified-observed-transactions'},funding:{principalWei:'1000000000000000',gasExpenseWei:'11000000000000',allocatedGasWei:'7000000000000',unallocatedGasWei:'4000000000000',unknownOperations:2,principalIsExpense:false,allocatedGasAlreadyInAcquisitionBasis:true}}));
 expect(html).toContain('verified observed transactions (partial history)');expect(html).toContain('not expense');expect(html).toContain('already in NFT basis');expect(html).toContain('without verified NFT allocation');expect(html).toContain('Unknown funding operations: 2');
});
