import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createCliRuntime, personalLiveLocalCustodyAllowed, type SpendAlertSink } from './runtime.js';
import { PERSONAL_LIVE_FLEET_POLICY, type EngineAdapter } from '@mint-bot/backend';

describe('CLI runtime custody boundaries', () => {
  it('does not read Turnkey files when dry-run explicitly disables custody loading', async () => {
    const root = await mkdtemp(join('/tmp', 'mintbot-runtime-'));
    const priorCustody = process.env.MINT_BOT_CUSTODY;
    const priorSecretRoot = process.env.MINT_BOT_SECRET_ROOT;
    process.env.MINT_BOT_CUSTODY = 'turnkey';
    process.env.MINT_BOT_SECRET_ROOT = join(root, 'missing-turnkey-root');
    try {
      const runtime = await createCliRuntime(root, {} as EngineAdapter, join(root, 'state.sqlite'), {}, { allowTurnkey: false, startCoordinator: false });
      expect(runtime.store.snapshot().runtime.startupState).toBe('Cold');
      (runtime.store as { close?: () => void }).close?.();
    } finally {
      if (priorCustody === undefined) delete process.env.MINT_BOT_CUSTODY; else process.env.MINT_BOT_CUSTODY = priorCustody;
      if (priorSecretRoot === undefined) delete process.env.MINT_BOT_SECRET_ROOT; else process.env.MINT_BOT_SECRET_ROOT = priorSecretRoot;
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('CLI runtime spend limits (T-003)', () => {
  it('installs the Personal Live fleet policy and routes headroom alerts to a durable event, then to the service sink', async () => {
    const root = await mkdtemp(join('/tmp', 'mintbot-runtime-'));
    try {
      const runtime = await createCliRuntime(root, {} as EngineAdapter, join(root, 'state.sqlite'), {}, { allowTurnkey: false, startCoordinator: false });
      expect((runtime.store as unknown as { fleetPolicy?: unknown }).fleetPolicy).toEqual(PERSONAL_LIVE_FLEET_POLICY);
      const coordinatorAlerts = (runtime.coordinator as unknown as { options: { alerts?: SpendAlertSink } }).options.alerts;
      expect(coordinatorAlerts).toBeDefined();
      await coordinatorAlerts!.cap('PAID_DAILY_HEADROOM_USED');
      expect(runtime.store.snapshot().events.some((event) => event.type === 'alert_cap' && event.data.reason === 'PAID_DAILY_HEADROOM_USED')).toBe(true);
      const delivered: Array<[string, string | undefined]> = [];
      runtime.setAlertSink({ cap: async (reason, runId) => { delivered.push([reason, runId]); } });
      await coordinatorAlerts!.cap('PAID_DAILY_HEADROOM_USED', 'run-service');
      expect(delivered).toEqual([['PAID_DAILY_HEADROOM_USED', 'run-service']]);
      expect(runtime.store.snapshot().events.some((event) => event.runId === 'run-service')).toBe(false);
      (runtime.store as { close?: () => void }).close?.();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('local key file custody option (D-043)', () => {
  it('is on only when asked for and Turnkey custody is not in use', () => {
    expect(personalLiveLocalCustodyAllowed(true, false)).toBe(true);
    expect(personalLiveLocalCustodyAllowed(true, true)).toBe(false);
    expect(personalLiveLocalCustodyAllowed(false, false)).toBe(false);
    expect(personalLiveLocalCustodyAllowed(undefined, false)).toBe(false);
    expect(personalLiveLocalCustodyAllowed(undefined, true)).toBe(false);
  });
});
