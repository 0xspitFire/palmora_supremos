import { describe, expect, it } from 'vitest';
import type { AnalyticsReadModel, ReadModelEnvelope } from './contracts.js';
import { ReadModelClient, type ReadModelGetRequest } from './read-model-client.js';

function emptyEnvelope<T>(): ReadModelEnvelope<T> {
  return {
    contract: 'mintbot.read-model',
    version: '1',
    requestId: 'request-1',
    generatedAt: '2026-09-17T22:00:00.000Z',
    snapshot: { id: 'snapshot-1', capturedAt: '2026-09-17T22:00:00.000Z', consistency: 'snapshot' },
    availability: 'unavailable',
    freshness: { status: 'unknown', observedAt: null, expiresAt: null, ageSeconds: null, policyVersion: 'read-model-v1' },
    data: null,
    issues: [],
  };
}

function analytics(): AnalyticsReadModel {
  return { mode: 'shadow-only', method: 'FIFO', currency: 'ETH', coverage: { scope: 'canonical-finalized-mints-only', canonicalExecutions: 0, completeCosts: 0, incompleteCosts: 0, confirmedActivities: 0, pendingExcluded: 0, reorgedExcluded: 0, unavailableObservations: 0, acquisitionHistory: 'no_samples', externalTransfersAndSalesComplete: false, providerCoverageAsserted: false, groupsOmitted: 0 }, totals: { recordedCanonicalCostWei: null, realizedPnlWei: null, realizedRoiBps: null, unrealizedPnlWei: null, transactionAndMarketplaceFeesWei: null }, groups: [], shadow: [] };
}

describe('ReadModelClient', () => {
  it('uses only the Backend GET read-model routes and encodes opaque identifiers/cursors', async () => {
    const paths: string[] = [];
    const client = new ReadModelClient({
      basePath: '/api/v1/read-model/',
      get: async <T>({ path, method }: ReadModelGetRequest) => {
        expect(method).toBe('GET');
        paths.push(path);
        return emptyEnvelope<T>();
      },
    });

    await client.getHome();
    await client.getOpportunities();
    await client.getCalendar('next page');
    await client.getReadiness('campaign/one');
    await client.getRun('run/one');
    await client.getAlerts('opaque cursor');
    await client.getHealth();

    expect(paths).toEqual([
      '/api/v1/read-model/home',
      '/api/v1/read-model/opportunities',
      '/api/v1/read-model/calendar?cursor=next%20page',
      '/api/v1/read-model/campaigns/campaign%2Fone/readiness',
      '/api/v1/read-model/runs/run%2Fone',
      '/api/v1/read-model/alerts?cursor=opaque%20cursor',
      '/api/v1/read-model/health',
    ]);
    expect(paths.every((path) => !/POST|PATCH|DELETE|execute|mint|arm/i.test(path))).toBe(true);
  });

  it('normalizes a trailing base path without exposing a second transport boundary', async () => {
    let path = '';
    const client = new ReadModelClient({ basePath: '/gateway/read-model///', get: async <T>({ path: nextPath }: ReadModelGetRequest) => { path = nextPath; return emptyEnvelope<T>(); } });

    await client.getHealth();

    expect(path).toBe('/gateway/read-model/health');
  });

  it('rejects legacy object wrappers where v1 requires arrays without coercing or dropping data', async () => {
    const legacyCalendar = { ...emptyEnvelope<unknown>(), availability: 'available' as const, data: { entries: [] } };
    const client = new ReadModelClient({ get: async () => legacyCalendar });

    const result = await client.getCalendar();

    expect(result.data).toBeNull();
    expect(result.availability).toBe('unavailable');
    expect(result.issues.at(-1)?.code).toBe('READ_MODEL_SCHEMA_MISMATCH');
    expect(result.issues.at(-1)?.message).toContain('legacy data was not coerced');
  });

  it('accepts a v1 readiness array and rejects malformed staged finality', async () => {
    const readiness = { ...emptyEnvelope<unknown>(), availability: 'available' as const, data: [{ campaignId: 'campaign-1', wallet: {}, decision: 'unknown', cost: {} }] };
    const client = new ReadModelClient({ get: async () => readiness });
    const accepted = await client.getReadiness('campaign-1');

    expect(accepted.data).toHaveLength(1);

    const malformedRun = {
      ...emptyEnvelope<unknown>(),
      availability: 'available' as const,
      data: { run: {}, campaign: {}, walletResults: [{ finality: { stage: 'soft', requiredStage: 'ethereum_final', settlementReached: 'yes' } }], attempts: [], receipts: [], reconciliations: [], events: [] },
    };
    const runClient = new ReadModelClient({ get: async () => malformedRun });
    const rejected = await runClient.getRun('run-1');

    expect(rejected.data).toBeNull();
    expect(rejected.issues.at(-1)?.code).toBe('READ_MODEL_SCHEMA_MISMATCH');
  });

  it('returns an unavailable envelope on transport failure and freezes the GET request', async () => {
    let frozen = false;
    const client = new ReadModelClient({ get: async (request) => { frozen = Object.isFrozen(request); throw new Error('network'); } });

    const result = await client.getHealth();

    expect(frozen).toBe(true);
    expect(result.data).toBeNull();
    expect(result.issues[0]?.code).toBe('READ_MODEL_TRANSPORT_ERROR');
  });
  it('accepts mixed known and unknown opening times without discarding backend warnings', async () => {
    const response = {
      ...emptyEnvelope<unknown>(),
      availability: 'partial' as const,
      data: [
        { id: 'known', project: {}, chain: {}, openingAt: '2026-11-07T00:00:00.000Z', verification: {} },
        { id: 'unknown', project: {}, chain: {}, openingAt: null, verification: {} },
      ],
      issues: [{ code: 'CALENDAR_TIME_UNKNOWN', severity: 'warning', message: 'Opening time is unknown.', retryable: false, safeAction: 'Inspect' }],
    };
    const result = await new ReadModelClient({ get: async () => response }).getCalendar();
    expect(result.availability).toBe('partial');
    expect(result.data?.map(entry => entry.openingAt)).toEqual(['2026-11-07T00:00:00.000Z', null]);
    expect(result.issues).toEqual(response.issues);
  });

  it.each([undefined, 123, {}, '', 'tomorrow', '2026-02-30T00:00:00.000Z', '2026-11-07T25:00:00.000Z'])('rejects malformed calendar opening time %s', async (openingAt) => {
    const response = { ...emptyEnvelope<unknown>(), availability: 'available' as const, data: [{ id: 'bad', project: {}, chain: {}, openingAt, verification: {} }] };
    const result = await new ReadModelClient({ get: async () => response }).getCalendar();
    expect(result.data).toBeNull();
    expect(result.issues.at(-1)?.code).toBe('READ_MODEL_SCHEMA_MISMATCH');
  });

});


describe('analytics read-model transport', () => {
  it('uses only the allowlisted GET route and preserves unknown financial outcomes', async () => {
    const get = async ({ method, path }: ReadModelGetRequest) => {
      expect(method).toBe('GET'); expect(path).toBe('/api/v1/read-model/analytics');
      return { ...emptyEnvelope<unknown>(), availability: 'partial', data: analytics() };
    };
    const result = await new ReadModelClient({ get }).getAnalytics();
    expect(result.availability).toBe('partial');
    expect(result.data?.totals.realizedPnlWei).toBeNull();
    expect(result.data?.coverage.providerCoverageAsserted).toBe(false);
  });

  it.each(['live-mode', 'claimed-complete-provider', 'numeric-pnl', 'bad-count', 'too-many-groups', 'malformed-money', 'negative-cost'] as const)('rejects malformed or overclaiming analytics: %s', async change => {
    const data: Record<string, unknown> = structuredClone(analytics()) as unknown as Record<string, unknown>;
    if (change === 'live-mode') data.mode = 'live';
    if (change === 'claimed-complete-provider') (data.coverage as Record<string, unknown>).providerCoverageAsserted = true;
    if (change === 'negative-cost') (data.totals as Record<string, unknown>).recordedCanonicalCostWei = '-12';
    if (change === 'numeric-pnl') (data.totals as Record<string, unknown>).realizedPnlWei = 12;
    if (change === 'malformed-money') (data.totals as Record<string, unknown>).realizedPnlWei = '1.2 ETH';
    if (change === 'bad-count') (data.coverage as Record<string, unknown>).canonicalExecutions = -1;
    if (change === 'too-many-groups') data.groups = Array.from({ length: 21 }, () => ({}));
    const result = await new ReadModelClient({ get: async () => ({ ...emptyEnvelope<unknown>(), availability: 'partial', data }) }).getAnalytics();
    expect(result.data).toBeNull();
    expect(result.issues.at(-1)?.code).toBe('READ_MODEL_SCHEMA_MISMATCH');
  });
});

it('accepts bounded verified external observations and conserves funding gas without pricing principal as expense',async()=>{
 const data=analytics();const value={...data,coverage:{...data.coverage,scope:'verified-observed-transactions' as const},funding:{principalWei:'1000',gasExpenseWei:'11',allocatedGasWei:'7',unallocatedGasWei:'4',unknownOperations:1,principalIsExpense:false as const,allocatedGasAlreadyInAcquisitionBasis:true as const}};
 const result=await new ReadModelClient({get:async()=>({...emptyEnvelope<unknown>(),availability:'partial',data:value})}).getAnalytics();
 expect(result.data?.coverage.scope).toBe('verified-observed-transactions');expect(result.data?.funding?.principalIsExpense).toBe(false);expect(result.data?.funding?.gasExpenseWei).toBe('11');
 for(const funding of [{...value.funding,principalWei:'-1'},{...value.funding,gasExpenseWei:12},{...value.funding,allocatedGasWei:'8'},{...value.funding,principalIsExpense:true}]){
  const rejected=await new ReadModelClient({get:async()=>({...emptyEnvelope<unknown>(),availability:'partial',data:{...value,funding}})}).getAnalytics();expect(rejected.data).toBeNull();
 }
});
