import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { campaign, close, ETHEREUM, fixture, NOW } from './canonical-fixtures.js';
import type { SqliteDatabase } from '@mint-bot/database';

function insertEvent(db: SqliteDatabase, id: string, at = NOW): void {
  db.prepare('INSERT INTO audit_event (id, entity_type, entity_id, actor, reason, policy_snapshot_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, 'state_transition', 'global', 'test', 'performance', JSON.stringify({ kind: 'event', eventType: 'performance', eventData: { nested: { value: 1 } } }), at);
}

describe('canonical persistence and incremental event projection', () => {
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
