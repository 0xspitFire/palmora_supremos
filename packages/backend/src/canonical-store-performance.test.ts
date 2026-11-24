import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { campaign, close, ETHEREUM, fixture, NOW } from './canonical-fixtures.js';
import type { SqliteDatabase } from '@mint-bot/database';

function insertEvent(db: SqliteDatabase, id: string, at = NOW): void {
  db.prepare('INSERT INTO audit_event (id, entity_type, entity_id, actor, reason, policy_snapshot_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, 'state_transition', 'global', 'test', 'performance', JSON.stringify({ kind: 'event', eventType: 'performance', eventData: { nested: { value: 1 } } }), at);
}

describe('canonical persistence and incremental event projection', () => {
  it('appends discovery observations without rebuilding history, deduplicates and rolls back invalid batches', async () => {
    const value = await fixture(ETHEREUM);
    try {
      insertEvent(value.db, 'retained-discovery-fixture');
      const event = { id: 'range-observation', type: 'watched_wallet_mint', at: NOW, data: { fixture: 1 } };
      value.store.eventSnapshot();
      const snapshot = vi.spyOn(value.store, 'snapshot');
      const statements = vi.spyOn(value.db, 'prepare');
      await value.store.appendDiscoveryEvents([event, { ...event, data: { fixture: 2 } }]);
      expect(snapshot).not.toHaveBeenCalled();
      expect(statements.mock.calls.map(([sql]) => sql).every(sql =>
        sql.startsWith('SELECT entity_type, policy_snapshot_json FROM audit_event WHERE id = ?')
          || sql.startsWith('INSERT INTO audit_event'))).toBe(true);
      expect(value.store.eventSnapshot().filter(row => row.id === event.id)).toEqual([event]);
      await expect(value.store.appendDiscoveryEvents([
        { ...event, id: 'rolled-back' }, { ...event, id: 'forbidden', type: 'replication_prepared' },
      ])).rejects.toThrow('DISCOVERY_EVENT_TYPE_NOT_ALLOWED');
      expect(value.store.eventSnapshot().some(row => row.id === 'rolled-back' || row.id === 'forbidden')).toBe(false);
      value.db.prepare("INSERT INTO audit_event (id, entity_type, entity_id, actor, reason, occurred_at) VALUES ('ordinary-audit', 'state_transition', 'global', 'fixture', 'fixture', ?)").run(NOW);
      await expect(value.store.appendDiscoveryEvents([{ ...event, id: 'ordinary-audit' }])).rejects.toThrow(/UNIQUE/);
    } finally { vi.restoreAllMocks(); await close(value); }
  });

  it('projects only the ordered replication inputs and retains newly persisted downgrades', async () => {
    const value = await fixture(ETHEREUM);
    try {
      insertEvent(value.db, 'unrelated');
      const common = { at: NOW, data: {} };
      await value.store.appendDiscoveryEvents([
        { ...common, id: 'score-up', type: 'opportunity_notified' },
        { ...common, id: 'source', type: 'watched_wallet_mint' },
      ]);
      await value.store.transaction(state => {
        state.events.push({ ...common, id: 'claim', type: 'replication_claim' }, { ...common, id: 'decision', type: 'replication_decision' });
      });
      expect(value.store.replicationTickEvents().map(event => event.id)).toEqual(['claim', 'decision', 'score-up', 'source']);
      await value.store.appendDiscoveryEvents([{ ...common, at: '2026-11-23T16:00:00.000Z', id: 'score-down', type: 'opportunity_scored', data: { blocked: true } }]);
      const view = value.store.replicationTickEvents();
      expect(view.at(-1)).toMatchObject({ id: 'score-down', data: { blocked: true } });
      view.at(-1)!.data.blocked = false;
      expect(value.store.replicationTickEvents().at(-1)?.data.blocked).toBe(true);
    } finally { await close(value); }
  });

  it('preserves readiness, monitor and skip-journal inputs without reading a full snapshot', async () => {
    const value = await fixture(ETHEREUM);
    try {
      await value.store.transaction(state => {
        state.events.push({ id: 'legacy-health', type: 'alert_health', at: NOW, data: { dedupe: 'legacy-custom-key' } });
        state.events.push({ id: 'skip-plan', type: 'discovery_skip_notice_plan', at: NOW, data: { alertDedupe: 'legacy-custom-key' } });
      });
      insertEvent(value.db, 'unrelated-health-history');
      const full = value.store.snapshot();
      const snapshot = vi.spyOn(value.store, 'snapshot');
      const { campaigns, runs, attempts, reservations, reconciliations, jobs, chainEvidence, notificationOutbox, runtime, killed } = full;
      expect(value.store.readinessSnapshot()).toEqual({
        campaigns, runs, attempts, reservations, reconciliations, jobs, chainEvidence, notificationOutbox, runtime, killed,
      });
      expect(value.store.healthMonitorSnapshot()).toEqual({ reservations, notificationOutbox });
      expect(value.store.discoveryJournal()).toEqual(full.events.filter(event => ['legacy-health', 'skip-plan'].includes(event.id)));
      expect(snapshot).not.toHaveBeenCalled();
    } finally { vi.restoreAllMocks(); await close(value); }
  });

  it('retries a complete batch after an interrupted SQLite iterator without advancing its watermark', async () => {
    const value = await fixture(ETHEREUM);
    try {
      insertEvent(value.db, 'stream-first');
      insertEvent(value.db, 'stream-second');
      const prepare = value.db.prepare.bind(value.db);
      const failure = vi.spyOn(value.db, 'prepare').mockImplementation((sql: string) => {
        const statement = prepare(sql);
        if (sql.startsWith('SELECT rowid AS rid, id, entity_type')) {
          const iterate = statement.iterate.bind(statement);
          vi.spyOn(statement, 'iterate').mockImplementation(function* (...bindings: unknown[]) {
            const iterator = iterate(...bindings);
            try {
              const first = iterator.next();
              if (!first.done) yield first.value;
              throw new Error('SYNTHETIC_READ_INTERRUPTED');
            } finally { iterator.return?.(); }
          });
        }
        return statement;
      });
      expect(() => value.store.eventSnapshot()).toThrow('SYNTHETIC_READ_INTERRUPTED');
      failure.mockRestore();
      expect(value.store.eventSnapshot().filter(event => event.type === 'performance').map(event => event.id)).toEqual(['stream-first', 'stream-second']);
    } finally { vi.restoreAllMocks(); await close(value); }
  });
  it('captures dashboard state inside one SQLite read transaction without persisting changes', async () => {
    const value = await fixture(ETHEREUM);
    try {
      const read = value.store.snapshot.bind(value.store);
      const capture = vi.spyOn(value.store, 'snapshot').mockImplementation(() => {
        expect(value.db.inTransaction).toBe(true);
        return read();
      });
      const before = value.db.prepare('SELECT count(*) AS count FROM audit_event').get();
      expect(value.store.readModelSnapshot().events).toBeDefined();
      expect(capture).toHaveBeenCalledOnce();
      expect(value.db.inTransaction).toBe(false);
      expect(value.db.prepare('SELECT count(*) AS count FROM audit_event').get()).toEqual(before);
    } finally { vi.restoreAllMocks(); await close(value); }
  });
  it('does not revisit campaign graphs or write unchanged records on an unrelated transaction', async () => {
    const value = await fixture(ETHEREUM);
    try {
      const current = await campaign(value, ETHEREUM);
      await value.store.transaction((state) => {
        state.notificationOutbox.push({ id: 'perf-notification', sourceEventId: 'perf-source', type: 'health', text: 'ready', state: 'pending', attempts: 0, createdAt: NOW });
      });
      const statements = vi.spyOn(value.db, 'prepare');
      await value.store.transaction((state) => { state.events.push({ id: 'perf-appended', type: 'performance', at: NOW, data: {} }); });
      const queries = statements.mock.calls.map(([sql]) => sql);
      expect(queries.filter((sql) => sql === 'SELECT id, chain_id FROM chain_profile WHERE chain_id = ?')).toEqual([]);
      expect(queries.filter((sql) => /^(?:UPDATE|INSERT INTO) (?:campaign|contract|collection|"drop"|notification|simulation|orchestrator_job|orchestrator_readiness)\b/.test(sql))).toEqual([]);
      statements.mockRestore();
      // A real campaign lifecycle change must still persist its normalized state and lifecycle audit.
      await value.store.transaction((state) => { state.campaigns.find((item) => item.id === current.id)!.state = 'Validating'; });
      expect(value.db.prepare('SELECT state FROM campaign WHERE id = ?').get(current.id)).toEqual({ state: 'validating' });
      expect(value.store.snapshot().campaigns.find((item) => item.id === current.id)?.state).toBe('Validating');
      // A real outbox change still passes through its normalized delivery state machine.
      await value.store.transaction((state) => { state.notificationOutbox[0]!.state = 'failed'; state.notificationOutbox[0]!.attempts = 1; });
      expect(value.store.snapshot().notificationOutbox[0]).toMatchObject({ state: 'failed', attempts: 1 });
    } finally { vi.restoreAllMocks(); await close(value); }
  });

  it('sorts only new same-time UUID batches and merges them with retained history in canonical order', async () => {
    const value = await fixture(ETHEREUM);
    try {
      for (let index = 0; index < 48; index += 1) insertEvent(value.db, `perf-${randomUUID()}`);
      value.store.snapshot();
      const added = [`perf-${randomUUID()}`, 'perf-00000000-0000-0000-0000-000000000000', 'perf-ffffffff-ffff-ffff-ffff-ffffffffffff'];
      for (const id of added) insertEvent(value.db, id);
      const expected = (value.db.prepare("SELECT id FROM audit_event WHERE reason = 'performance' ORDER BY occurred_at, id").all() as Array<{ id: string }>).map((row) => row.id);
      const sorting = vi.spyOn(Array.prototype, 'sort');
      const actual = value.store.snapshot().events.filter((event) => event.type === 'performance').map((event) => event.id);
      const sortedLengths = sorting.mock.contexts.map((array) => (array as unknown[]).length);
      sorting.mockRestore();
      expect(actual).toEqual(expected);
      expect(sortedLengths).toEqual([added.length]);
      // Earlier timestamps also merge correctly; rowid order is never mistaken for event-time order.
      insertEvent(value.db, 'perf-older', '2026-09-13T00:00:00.000Z');
      expect(value.store.snapshot().events.filter((event) => event.type === 'performance')[0]!.id).toBe('perf-older');
    } finally { vi.restoreAllMocks(); await close(value); }
  });

  it('invalidates rows observed before rollback even when SQLite reuses their rowids', async () => {
    const value = await fixture(ETHEREUM);
    try {
      insertEvent(value.db, 'perf-retained');
      value.store.snapshot();
      value.db.exec('BEGIN IMMEDIATE');
      insertEvent(value.db, 'perf-rolled-back');
      const rowid = (value.db.prepare('SELECT rowid AS rid FROM audit_event WHERE id = ?').get('perf-rolled-back') as { rid: number }).rid;
      expect(value.store.snapshot().events.some((event) => event.id === 'perf-rolled-back')).toBe(true);
      value.db.exec('ROLLBACK');
      insertEvent(value.db, 'perf-replacement');
      expect(value.db.prepare('SELECT rowid AS rid FROM audit_event WHERE id = ?').get('perf-replacement')).toEqual({ rid: rowid });
      const events = value.store.snapshot().events;
      expect(events.some((event) => event.id === 'perf-rolled-back')).toBe(false);
      expect(events.filter((event) => event.type === 'performance').map((event) => event.id)).toEqual(['perf-replacement', 'perf-retained']);
    } finally { if (value.db.inTransaction) value.db.exec('ROLLBACK'); await close(value); }
  });

  it('returns fresh event containers and protects nested cached data from caller mutation', async () => {
    const value = await fixture(ETHEREUM);
    try {
      insertEvent(value.db, 'perf-snapshot');
      const first = value.store.snapshot().events.find((event) => event.id === 'perf-snapshot')!;
      first.type = 'changed';
      first.data.injected = true;
      expect(() => { (first.data.nested as { value: number }).value = 2; }).toThrow();
      expect(value.store.snapshot().events.find((event) => event.id === 'perf-snapshot')).toMatchObject({ type: 'performance', data: { nested: { value: 1 } } });
      expect(value.store.snapshot().events.find((event) => event.id === 'perf-snapshot')!.data.injected).toBeUndefined();
    } finally { await close(value); }
  });
  it('projects fresh events without unrelated history and preserves detached containers', async () => {
    const value = await fixture(ETHEREUM);
    try {
      insertEvent(value.db, 'event-only-first');
      const queries = vi.spyOn(value.db, 'prepare');
      const first = value.store.eventSnapshot();
      expect(first.find((event) => event.id === 'event-only-first')).toBeDefined();
      expect(queries.mock.calls.every(([sql]) => /FROM audit_event/.test(sql))).toBe(true);
      queries.mockRestore();
      first[0]!.data.changed = true;
      insertEvent(value.db, 'event-only-next');
      const next = value.store.eventSnapshot();
      expect(next.some((event) => event.id === 'event-only-next')).toBe(true);
      expect(next.some((event) => event.data.changed === true)).toBe(false);
    } finally { vi.restoreAllMocks(); await close(value); }
  });

});
