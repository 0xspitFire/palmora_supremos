import { describe, expect, it } from 'vitest';
import type { ReadModelEnvelope } from './contracts.js';
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
});
