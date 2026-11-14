import { describe, expect, it, vi } from 'vitest';
import { ReadModelClient } from '@mint-bot/web';
import { Phase2ReadOnlyApi, Phase2ReadModelService, DurableStore } from '@mint-bot/backend';
import { renderDocument } from '@mint-bot/web/server';

const at = '2026-11-14T12:00:00.000Z';
const id = `calendar:1:0x${'1'.repeat(40)}`;

describe('consistent dashboard snapshot', () => {
  it.each([false, true])('orders opportunity observations by source time with older chain authority present=%s', async olderEvidence => {
    const store = new DurableStore();
    await store.transaction(state => {
      if (olderEvidence) state.chainEvidence.push({ id: 'old-evidence', chainId: 1, status: 'accepted', executionEnabled: true, seaDropCompatible: true, positiveLivePath: true, archiveForkPassed: true, negativeCases: { revert: true, sold_out: true, price_drift: true, insufficient_funds: true, quantity_limit: true, stale_phase: true, fee_recipient: true, kill: true, cap: true }, reconciliationPassed: true, finalityPassed: true, endpointIdentity: 'synthetic-reader', strategyVersion: 'seadrop-v1-public@1', checkedAt: '2026-11-14T10:00:00.000Z', expiresAt: '2026-11-15T12:00:00.000Z', sourceBlock: 1n, sourceBlockHash: `0x${'1'.repeat(64)}` });
      for (let n = 0; n < 51; n++) state.events.push({ id: `event-${n}`, type: 'opportunity_scored', at: new Date(Date.parse(at) - 60_000 + n * 1000).toISOString(), data: { opportunityId: `opportunity-${n.toString().padStart(2, '0')}`, chainId: 1, contract: `0x${(n + 1).toString(16).padStart(40, '0')}`, score: 72, factors: [], expiresAt: '2026-11-14T12:15:00.000Z' } });
    });
    const api = new Phase2ReadOnlyApi(new Phase2ReadModelService(() => new Date(at)), store);
    const client = new ReadModelClient({ get: async request => api.handle(request).body });
    const first = await client.getDashboard();
    const second = await client.getDashboard(undefined, 2);
    expect(first.home?.data?.opportunities[0]?.id).toBe('opportunity-50');
    expect(first.home?.data?.opportunities).toHaveLength(50);
    expect(second.home?.data?.opportunities.map(row => row.id)).toEqual(['opportunity-00']);
    expect(first.home?.data?.opportunities[0]?.score.freshness.observedAt).toBe('2026-11-14T11:59:50.000Z');
    if (!olderEvidence) expect(first.home?.data?.opportunities[0]?.freshness.status).toBe('unknown');
  });
  it('offers newest-first bounded pages with full totals and preserves readiness in navigation', async () => {
    const store = new DurableStore();
    await store.transaction(state => {
      for (let n = 0; n < 51; n++) state.events.push({ id: `page-${n}`, type: 'calendar_entry', at: new Date(Date.parse(at) - n * 1000).toISOString(), data: { id: `calendar-${n}`, chainId: 1, contract: `0x${n.toString(16).padStart(40, '0')}`, openingAt: at, expiresAt: '2026-11-14T12:15:00.000Z' } });
    });
    const api = new Phase2ReadOnlyApi(new Phase2ReadModelService(() => new Date(at)), store);
    const client = new ReadModelClient({ get: async request => api.handle(request).body });
    const first = await client.getDashboard(id);
    const second = await client.getDashboard(id, 2);
    expect(first.pagination?.data).toMatchObject({ page: 1, pages: 2, pageSize: 50, totals: { calendar: 51 }, readinessId: id });
    expect(first.calendar?.data).toHaveLength(50);
    expect(first.calendar?.data?.[0]?.id).toBe('calendar-0');
    expect(second.calendar?.data?.map(row => row.id)).toEqual(['calendar-50']);
    expect(renderDocument(first)).toContain('Next page');
    const html = renderDocument(second);
    expect(html).toContain('Previous page');
    expect(html).toContain('51 calendar entries');
    expect(html).toContain(encodeURIComponent(id));
  });
  it('captures once with a shared time and digest, preserves stale observations and reports stalled discovery on home and health', async () => {
    const store = new DurableStore();
    await store.transaction(state => {
      state.events.push({ id: 'old-calendar', type: 'calendar_entry', at: '2026-11-13T12:00:00.000Z', data: { id, chainId: 1, contract: `0x${'1'.repeat(40)}`, expiresAt: '2026-11-13T12:15:00.000Z', priceWei: '0' } });
    });
    const capture = vi.spyOn(store, 'snapshot');
    const models = new Phase2ReadModelService(() => new Date(at));
    const api = new Phase2ReadOnlyApi(models, store, { discovery: () => ({ status: 'degraded', chains: [{ chainId: 1, state: 'stalled', lastSuccessAt: '2026-11-13T12:00:00.000Z' }] }) });
    const requests: string[] = [];
    const client = new ReadModelClient({ get: async request => { requests.push(request.path); return api.handle(request).body; } });
    const result = await client.getDashboard(id);
    expect(requests).toEqual([`/api/v1/read-model/dashboard?readiness=${encodeURIComponent(id)}`]);
    expect(capture).toHaveBeenCalledOnce();
    const surfaces = Object.values(result);
    expect(new Set(surfaces.map(surface => surface.snapshot.id)).size).toBe(1);
    expect(surfaces.every(surface => surface.generatedAt === at && surface.snapshot.capturedAt === at)).toBe(true);
    expect(result.calendar?.data?.[0]?.freshness.status).toBe('stale');
    expect(result.calendar?.data?.[0]?.freshness.observedAt).toBe('2026-11-13T12:00:00.000Z');
    expect(result.home?.data?.system.discovery?.status).toBe('degraded');
    expect(result.health?.data?.discovery?.chains[0]?.state).toBe('stalled');
    expect(result.health?.issues.some(issue => issue.code === 'DISCOVERY_DEGRADED')).toBe(true);
  });

  it('refuses invalid/duplicate queries and mutations before reading state', () => {
    const store = new DurableStore();
    const capture = vi.spyOn(store, 'snapshot');
    const api = new Phase2ReadOnlyApi(new Phase2ReadModelService(), store);
    for (const query of ['?readiness=../metrics', '?readiness=a&readiness=b', '?url=https://example.invalid', '?readiness=', '?page=0', '?page=2&page=3', '?page=10000']) {
      expect(api.handle({ method: 'GET', path: `/api/v1/read-model/dashboard${query}` }).status).toBe(400);
    }
    expect(api.handle({ method: 'POST', path: '/api/v1/read-model/dashboard' }).status).toBe(405);
    expect(capture).not.toHaveBeenCalled();
  });

  it('refuses a mixed snapshot and malformed health rather than silently omitting the failing surface', async () => {
    const store = new DurableStore();
    const models = new Phase2ReadModelService(() => new Date(at));
    const batch = models.dashboard(store.snapshot());
    const mixed = structuredClone(batch);
    Object.assign(mixed.data!, { health: { ...mixed.data!.health, snapshot: { ...mixed.data!.health.snapshot, id: 'different' } } });
    const rejected = await new ReadModelClient({ get: async () => mixed }).getDashboard();
    expect(Object.values(rejected).every(surface => surface.availability === 'unavailable')).toBe(true);
    const malformed = structuredClone(batch);
    Object.assign(malformed.data!.health, { availability: 'available' });
    Object.assign(malformed.data!.health.data!, { discovery: { status: 'healthy', chains: [{ chainId: 1, state: 'stalled' }] } });
    const health = await new ReadModelClient({ get: async () => malformed }).getDashboard();
    expect(health.health?.availability).toBe('unavailable');
    expect(health.health?.issues.some(issue => issue.code === 'READ_MODEL_SCHEMA_MISMATCH')).toBe(true);
    const invalidAvailability = structuredClone(batch);
    Object.assign(invalidAvailability.data!.calendar, { availability: 'bogus' });
    const invalid = await new ReadModelClient({ get: async () => invalidAvailability }).getDashboard();
    expect(Object.values(invalid).every(surface => surface.availability === 'unavailable')).toBe(true);
  });
});
