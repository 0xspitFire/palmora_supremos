import { describe, expect, it } from 'vitest';
import type { ReadModelEnvelope } from './contracts.js';
import { ReadModelClient } from './read-model-client.js';

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
      get: async <T>(path: string) => {
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
    const client = new ReadModelClient({ basePath: '/gateway/read-model///', get: async <T>(nextPath: string) => { path = nextPath; return emptyEnvelope<T>(); } });

    await client.getHealth();

    expect(path).toBe('/gateway/read-model/health');
  });
});
