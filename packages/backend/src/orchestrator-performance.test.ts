import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from '@mint-bot/database';
import { CanonicalStoreBridge } from './canonical-store.js';
import { fixture, close, ETHEREUM, NOW } from './canonical-fixtures.js';
import { Orchestrator } from './orchestrator.js';
import { ExecutionCoordinator } from './coordinator.js';
import type { ScheduledJobRecord } from './types.js';

const job = (id: string): ScheduledJobRecord => ({ id, kind: 'health', state: 'scheduled', scheduledAt: NOW, tMinusMs: 0, chainTimeOffsetMs: 0, idempotencyKey: id, requestDigest: id, payload: {}, attempts: 0, maxAttempts: 1, createdAt: NOW, updatedAt: NOW });

describe('Orchestrator lightweight idle control reads', () => {
  it('avoids history projections and write transactions on ready or killed idle polls', async () => {
    const value = await fixture(ETHEREUM);
    const scheduler = new Orchestrator(value.store, {} as ExecutionCoordinator, { now: () => new Date(NOW) });
    try {
      const snapshot = vi.spyOn(value.store, 'snapshot');
      const transaction = vi.spyOn(value.store, 'transaction');
      const queries = vi.spyOn(value.db, 'prepare');
      for (let index = 0; index < 5; index += 1) await scheduler.tick();
      value.db.prepare("UPDATE runtime_control SET kill_switch_engaged = 1 WHERE id = 'global'").run();
      for (let index = 0; index < 5; index += 1) await scheduler.tick();
      expect(snapshot).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
      expect(queries.mock.calls.some(([sql]) => /\b(?:audit_event|notification|transaction_attempt|receipt)\b/i.test(sql))).toBe(false);
      expect(scheduler.status().startupState).toBe('Blocked');
      expect(scheduler.status().blockingReasons).toContain('KILLED');
    } finally { vi.restoreAllMocks(); await close(value); }
  });

  it('sees jobs from another connection after idle and recovers expired leases before atomic claiming', async () => {
    const value = await fixture(ETHEREUM);
    const otherDb = openDatabase(join(value.directory, 'state.sqlite'));
    const other = new CanonicalStoreBridge(otherDb, { now: () => new Date(NOW) });
    const scheduler = new Orchestrator(value.store, {} as ExecutionCoordinator, { now: () => new Date(NOW) });
    try {
      await other.open();
      expect((await scheduler.tick()).claimed).toEqual([]);
      await other.transaction((state) => {
        state.jobs.push(job('external-due'), job('external-expired'));
      });
      await other.transaction((state) => {
        Object.assign(state.jobs.find((item) => item.id === 'external-expired')!, { state: 'running', attempts: 1, leaseOwner: 'old-process', leaseExpiresAt: '2026-01-01T00:00:00.000Z' });
      });
      const result = await scheduler.tick();
      expect(result.claimed).toEqual(['external-due', 'external-expired']);
      expect(result.completed).toEqual(['external-due', 'external-expired']);
      const events = value.store.snapshot().events;
      expect(events.filter((event) => event.type === 'job_recovered')).toHaveLength(1);
      expect(events.filter((event) => event.type === 'job_claimed')).toHaveLength(2);
    } finally { other.close(); await close(value); }
  });

  it('rechecks a kill engaged after the advisory read inside the atomic claim', async () => {
    const value = await fixture(ETHEREUM);
    const otherDb = openDatabase(join(value.directory, 'state.sqlite'));
    const scheduler = new Orchestrator(value.store, {} as ExecutionCoordinator, { now: () => new Date(NOW) });
    try {
      await value.store.transaction((state) => { state.jobs.push(job('kill-race')); });
      const original = value.store.transaction.bind(value.store);
      vi.spyOn(value.store, 'transaction').mockImplementationOnce((mutate) => {
        otherDb.prepare("UPDATE runtime_control SET kill_switch_engaged = 1 WHERE id = 'global'").run();
        return original(mutate);
      });
      expect((await scheduler.tick()).claimed).toEqual([]);
      expect(value.store.snapshot().jobs.find((item) => item.id === 'kill-race')).toMatchObject({ state: 'scheduled', attempts: 0 });
      expect(value.store.snapshot().events.some((event) => event.type === 'job_claimed')).toBe(false);
    } finally { vi.restoreAllMocks(); otherDb.close(); await close(value); }
  });
});
