import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from '@mint-bot/database';
import { fixture, close, ETHEREUM, NOW } from './canonical-fixtures.js';
import { CanonicalJobStore } from './canonical-job-store.js';
import { OrchestratorService, pathKillSwitchProbe } from './service-orchestrator.js';
import { AlertManager } from './alerts.js';
import { NotificationDispatcher } from './notifications.js';

const coordinator = { start: async () => undefined, reconcile: async () => undefined };

describe('fresh lightweight scheduler control reads', () => {
  it('does no full-history projection, write or alert work on repeated idle killed ticks', async () => {
    const value = await fixture(ETHEREUM);
    const kill = vi.fn(async () => undefined);
    const service = new OrchestratorService(value.store, value.application, coordinator, {
      jobs: new CanonicalJobStore(value.store), killSwitchProbe: async () => true,
      alerts: { kill } as unknown as AlertManager,
      schedulerIntervalMs: 3_600_000, reconciliationIntervalMs: 3_600_000,
    });
    try {
      await service.start();
      const snapshot = vi.spyOn(value.store, 'snapshot');
      const transaction = vi.spyOn(value.store, 'transaction');
      const queries = vi.spyOn(value.db, 'prepare');
      for (let index = 0; index < 5; index += 1) await service.tick();
      expect(snapshot).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
      expect(kill).toHaveBeenCalledTimes(1);
      expect(queries.mock.calls.some(([sql]) => /\b(?:audit_event|transaction_attempt|receipt|notification)\b/i.test(sql))).toBe(false);
      expect(service.status().blockingReasons).toContain('KILL_SWITCH_ENGAGED');
    } finally { await service.stop(); vi.restoreAllMocks(); await close(value); }
  });

  it('reads external control changes freshly and keeps ready idle ticks free of write transactions', async () => {
    const value = await fixture(ETHEREUM);
    const second = openDatabase(join(value.directory, 'state.sqlite'));
    const jobs = new CanonicalJobStore(value.store);
    const service = new OrchestratorService(value.store, value.application, coordinator, {
      jobs, schedulerIntervalMs: 3_600_000, reconciliationIntervalMs: 3_600_000,
    });
    try {
      await value.store.transaction((state) => { state.runtime = { startupState: 'Ready', blockingReasons: [], dependencies: { engine: true, chain: true, notifications: true, backup: true } }; });
      await service.start();
      const transaction = vi.spyOn(value.store, 'transaction');
      const snapshot = vi.spyOn(value.store, 'snapshot');
      await service.tick();
      expect(transaction).not.toHaveBeenCalled();
      expect(snapshot).not.toHaveBeenCalled();
      second.prepare("UPDATE runtime_control SET kill_switch_engaged = 1 WHERE id = 'global'").run();
      expect(value.store.controlSnapshot().killed).toBe(true);
      await service.tick();
      expect(service.status().blockingReasons).toContain('KILLED');
      expect(service.status().blockingReasons).toContain('KILL_SWITCH_ENGAGED');
      const detached = value.store.controlSnapshot();
      detached.runtime.blockingReasons.length = 0;
      expect(value.store.controlSnapshot().runtime.blockingReasons).toContain('KILLED');
    } finally { await service.stop(); second.close(); vi.restoreAllMocks(); await close(value); }
  });

  it('retries failed kill alert recording and records one per release/reengagement episode', async () => {
    const value = await fixture(ETHEREUM);
    let engaged = true;
    const kill = vi.fn().mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue(undefined);
    const service = new OrchestratorService(value.store, value.application, coordinator, {
      jobs: new CanonicalJobStore(value.store), killSwitchProbe: async () => engaged,
      alerts: { kill } as unknown as AlertManager,
      schedulerIntervalMs: 3_600_000, reconciliationIntervalMs: 3_600_000,
    });
    try {
      await service.start(); await service.tick(); await service.tick();
      expect(kill).toHaveBeenCalledTimes(2);
      engaged = false; await service.tick();
      engaged = true; await service.tick();
      expect(kill).toHaveBeenCalledTimes(3);
    } finally { await service.stop(); await close(value); }
  });

  it('durably records distinct kill episodes and retries failed delivery without duplicating an episode', async () => {
    const value = await fixture(ETHEREUM);
    let clock = Date.parse(NOW);
    let engaged = true;
    const send = vi.fn().mockRejectedValueOnce(new Error('delivery unavailable')).mockResolvedValue(undefined);
    const dispatcher = new NotificationDispatcher(value.store, { send }, { now: () => new Date(clock), retryBaseMs: 1 });
    const alerts = new AlertManager(value.store, dispatcher, undefined, { now: () => new Date(clock) });
    const service = new OrchestratorService(value.store, value.application, coordinator, {
      jobs: new CanonicalJobStore(value.store), alerts, killSwitchProbe: async () => engaged,
      schedulerIntervalMs: 3_600_000, reconciliationIntervalMs: 3_600_000,
    });
    try {
      await service.start();
      await service.tick(); // Existing source/outbox remain the single durable occurrence after delivery failed.
      expect(value.store.eventSnapshot().filter((event) => event.type === 'alert_kill')).toHaveLength(1);
      expect(value.store.snapshot().notificationOutbox).toHaveLength(1);
      expect(value.store.snapshot().notificationOutbox[0]!.state).toBe('failed');
      clock += 1_000;
      await alerts.retryUndelivered();
      expect(value.store.snapshot().notificationOutbox[0]!.state).toBe('delivered');
      engaged = false; await service.tick();
      engaged = true; await service.tick(); await service.tick();
      const events = value.store.eventSnapshot().filter((event) => event.type === 'alert_kill');
      expect(events).toHaveLength(2);
      expect(new Set(events.map((event) => event.data.occurrence)).size).toBe(2);
      expect(value.store.snapshot().notificationOutbox.map((item) => item.state)).toEqual(['delivered', 'delivered']);
      expect(send).toHaveBeenCalledTimes(3);
    } finally { await service.stop(); await close(value); }
  });

  it('claims newly scheduled due jobs through the atomic store even after an idle tick', async () => {
    const value = await fixture(ETHEREUM);
    const jobs = new CanonicalJobStore(value.store);
    const service = new OrchestratorService(value.store, value.application, coordinator, {
      jobs, now: () => new Date(NOW), schedulerIntervalMs: 3_600_000, reconciliationIntervalMs: 3_600_000,
    });
    try {
      await value.store.transaction((state) => { state.runtime = { startupState: 'Ready', blockingReasons: [], dependencies: { engine: true, chain: true, notifications: true, backup: true } }; });
      await service.start();
      const claim = vi.spyOn(jobs, 'claimDue');
      await jobs.put({ id: 'new-due', runId: 'new-run', wallets: ['wallet'], executeAt: NOW, mode: 'live' });
      await service.tick();
      expect(claim).toHaveBeenCalledTimes(1);
      // The Phase 2 lane still refuses live execution; this optimization grants no live authority.
      expect((await jobs.list())[0]).toMatchObject({ state: 'blocked', lastError: 'PHASE2_LIVE_MODE_DISABLED' });
    } finally { await service.stop(); vi.restoreAllMocks(); await close(value); }
  });

  it('treats only a missing kill file as released; unknown filesystem errors remain killed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mintbot-kill-probe-'));
    try {
      const file = join(directory, 'killswitch');
      expect(await pathKillSwitchProbe(file)).toBe(false);
      await writeFile(file, 'engaged');
      expect(await pathKillSwitchProbe(file)).toBe(true);
      expect(await pathKillSwitchProbe(join(file, 'not-a-directory'))).toBe(true);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
