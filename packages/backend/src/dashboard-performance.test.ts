import { performance } from 'node:perf_hooks';
import { describe, expect, it, vi } from 'vitest';
import { Phase2ReadOnlyApi } from './api.js';
import { Phase2ReadModelService } from './read-model-v1.js';
import { close, ETHEREUM, fixture, NOW } from './canonical-fixtures.js';

describe('retained-history dashboard workload', () => {
  it('projects 80,000 retained SQLite events through one capture with identical source freshness', async () => {
    const value = await fixture(ETHEREUM);
    try {
      const insert = value.db.prepare('INSERT INTO audit_event (id, entity_type, entity_id, actor, reason, policy_snapshot_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
      value.db.transaction(() => {
        for (let i = 0; i < 80_000; i++) {
          const eventType = i < 37472 ? 'calendar_entry' : i < 68277 ? 'opportunity_scored' : i < 75963 ? 'readiness_sweep' : 'operational_sample';
          const identity = eventType === 'opportunity_scored' ? (i - 37472) % 747 : i % 803;
          const collection = `0x${(identity + 1).toString(16).padStart(40, '0')}`;
          const eventData = eventType === 'calendar_entry' ? { id: `calendar:1:${collection}`, chainId: 1, contract: collection, priceWei: '0', openingAt: NOW, expiresAt: '2026-09-15T12:15:00.000Z' }
            : eventType === 'opportunity_scored' ? { opportunityId: `seadrop:1:${collection}`, chainId: 1, contract: collection, score: 72, factors: [], expiresAt: '2026-09-15T12:15:00.000Z' }
            : eventType === 'readiness_sweep' ? { calendarId: `calendar:1:${collection}`, rows: Array.from({ length: 10 }, (_, n) => ({ wallet: `0x${(n + 1).toString(16).padStart(40, '0')}`, state: 'unknown', reason: 'BALANCE_UNAVAILABLE' })), expiresAt: '2026-09-15T12:15:00.000Z' }
            : { chainId: 1, status: 'ok', sourceBlock: i.toString(), measured: { durationMs: i % 300 } };
          const observedAt = new Date(Date.parse(NOW) - (80_000 - i) * 1000).toISOString();
          insert.run(`dashboard-benchmark-${i}`, 'state_transition', 'global', 'synthetic-test', 'retained-workload', JSON.stringify({ kind: 'event', eventType, eventData }), observedAt);
        }
      })();
      await value.store.transaction(state => {
        for (let i = 0; i < 607; i++) state.notificationOutbox.push({ id: `benchmark-notification-${i}`, sourceEventId: `dashboard-benchmark-${i}`, type: 'health', text: 'Synthetic retained notification', state: 'delivered', attempts: 1, createdAt: NOW, deliveredAt: NOW });
      });
      const api = new Phase2ReadOnlyApi(new Phase2ReadModelService(() => new Date(NOW)), value.store);
      const routes = ['home', 'calendar', 'alerts', 'health', 'analytics'];
      value.store.readModelSnapshot(); // Compare warmed retained-event caches on both paths.
      const capture = vi.spyOn(value.store, 'readModelSnapshot');
      const start = performance.now();
      const separate = routes.map(route => api.handle({ method: 'GET', path: `/api/v1/read-model/${route}` }));
      const separateMs = performance.now() - start;
      expect(capture).toHaveBeenCalledTimes(5);
      capture.mockClear();
      const batchStart = performance.now();
      const batch = api.handle({ method: 'GET', path: '/api/v1/read-model/dashboard' });
      const batchMs = performance.now() - batchStart;
      expect(capture).toHaveBeenCalledOnce();
      expect(batch.status).toBe(200);
      const surfaces = (batch.body.data as ReturnType<Phase2ReadModelService['dashboard']>['data'])!;
      for (const [index, route] of routes.entries()) {
        expect(surfaces[route as keyof typeof surfaces]?.freshness).toEqual(separate[index]!.body.freshness);
      }
      expect(surfaces.pagination.data?.totals).toEqual({ opportunities: 747, calendar: 803, alerts: 607 });
      expect(surfaces.home.data?.opportunities).toHaveLength(50);
      expect(surfaces.calendar.data).toHaveLength(50);
      expect(surfaces.alerts.data).toHaveLength(50);
      const next = api.handle({ method: 'GET', path: '/api/v1/read-model/dashboard?page=2' }).body.data as typeof surfaces;
      expect(next.pagination.data?.page).toBe(2);
      expect(next.calendar.data?.some(item => surfaces.calendar.data?.some(previous => previous.id === item.id))).toBe(false);
      const bytes = Buffer.byteLength(JSON.stringify(batch.body));
      expect(bytes).toBeLessThan(2 * 1024 * 1024);
      console.info('DASHBOARD_BENCHMARK', JSON.stringify({ workload: 'synthetic SQLite matching observed proportions:80000 events,747 opportunities,803 calendars,607 notifications,10-wallet sweeps; warmed caches', separateCaptures: 5, batchCaptures: 1, separateMs: Math.round(separateMs), batchMs: Math.round(batchMs), responseBytes: bytes, liveHostBenchmark: false }));
    } finally { vi.restoreAllMocks(); await close(value); }
  });
});
