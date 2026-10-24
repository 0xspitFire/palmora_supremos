import { describe, expect, it } from 'vitest';
import { DurableStore } from '@mint-bot/backend';
import { createDependencyFlags, type DependencyFlagDeps } from './dependency-flags.js';

/** T-070 (D-068): the service sets its readiness flags from real checks, fails closed, and lifts only when nothing else blocks. */
const NOW = new Date('2026-10-25T12:00:00.000Z');

async function setup(over: Partial<DependencyFlagDeps> = {}, runtime: Record<string, unknown> = {}) {
  const store = new DurableStore();
  await store.open();
  await store.transaction((state) => { state.runtime = { startupState: 'Blocked', blockingReasons: ['DEPLOYMENT_DEPENDENCIES_NOT_READY'], reconciliationCompletedAt: NOW.toISOString(), dependencies: { engine: false, chain: false, backup: true, notifications: false }, ...runtime } as never; });
  const deps: DependencyFlagDeps = {
    store, engineReady: async () => true, notificationsReady: async () => true, chainsToProbe: () => [4663], latestBlockTime: async () => new Date(NOW.getTime() - 5_000),
    killSwitchOn: async () => false, now: () => NOW, ...over,
  };
  return { store, flags: createDependencyFlags(deps), runtime: () => store.snapshot().runtime };
}

describe('deployment readiness flags', () => {
  it('turns engine, chain and notifications on when every check passes, and lifts the block it caused', async () => {
    const t = await setup();
    expect(await t.flags.tick()).toEqual({ engine: true, chain: true, notifications: true });
    expect(t.runtime().dependencies).toEqual({ engine: true, chain: true, backup: true, notifications: true });
    expect(t.runtime().blockingReasons).toEqual([]);
    expect(t.runtime().startupState).toBe('Ready');
  });

  it('turns the flag off and blocks at once when a check fails, throws, or the chain block is stale or in the future', async () => {
    const cases: Array<[Partial<DependencyFlagDeps>, keyof ReturnType<typeof expectFlags>]> = [
      [{ engineReady: async () => false }, 'engine'],
      [{ engineReady: async () => { throw new Error('TURNKEY_SECRET_REQUIRED'); } }, 'engine'],
      [{ notificationsReady: async () => false }, 'notifications'],
      [{ notificationsReady: async () => { throw new Error('down'); } }, 'notifications'],
      [{ latestBlockTime: async () => new Date(NOW.getTime() - 181_000) }, 'chain'],
      [{ latestBlockTime: async () => new Date(NOW.getTime() + 121_000) }, 'chain'],
      [{ latestBlockTime: async () => new Date(Number.NaN) }, 'chain'],
      [{ latestBlockTime: async (chainId) => { if (chainId === 4663) throw new Error('RPC down'); return new Date(NOW.getTime() - 1_000); } }, 'chain'],
    ];
    for (const [over, flag] of cases) {
      const t = await setup(over, { startupState: 'Ready', blockingReasons: [], dependencies: { engine: true, chain: true, backup: true, notifications: true } });
      const result = await t.flags.tick();
      expect(result[flag], flag).toBe(false);
      expect(t.runtime().dependencies[flag]).toBe(false);
      expect(t.runtime().startupState).toBe('Blocked');
      expect(t.runtime().blockingReasons).toContain('DEPLOYMENT_DEPENDENCIES_NOT_READY');
    }
  });

  it('always probes Ethereum, and every enabled chain must pass', async () => {
    const asked: number[] = [];
    const t = await setup({ chainsToProbe: () => [4663, 8453], latestBlockTime: async (chainId) => { asked.push(chainId); return new Date(NOW.getTime() - 1_000); } });
    await t.flags.tick();
    expect(asked.sort()).toEqual([1, 4663, 8453]);
  });

  it('does not lift the block when anything else blocks: another reason, a stored or file kill, no reconciliation, an unresolved run, or backup off', async () => {
    const stuck: Array<[Partial<DependencyFlagDeps>, Record<string, unknown>]> = [
      [{}, { blockingReasons: ['DEPLOYMENT_DEPENDENCIES_NOT_READY', 'RECONCILIATION_IN_PROGRESS'] }],
      [{ killSwitchOn: async () => true }, {}],
      [{ killSwitchOn: async () => { throw new Error('unreadable'); } }, {}],
      [{}, { reconciliationCompletedAt: undefined }],
      [{}, { dependencies: { engine: false, chain: false, backup: false, notifications: false } }],
    ];
    for (const [over, runtime] of stuck) {
      const t = await setup(over, runtime);
      await t.flags.tick();
      expect(t.runtime().startupState).toBe('Blocked');
    }
    const killed = await setup();
    await killed.store.transaction((state) => { state.killed = true; });
    await killed.flags.tick();
    expect(killed.runtime().startupState).toBe('Blocked');
  });

  it('never changes the run state when it was not blocked by readiness and everything is fine', async () => {
    const t = await setup({}, { startupState: 'Ready', blockingReasons: [], dependencies: { engine: true, chain: true, backup: true, notifications: true } });
    await t.flags.tick();
    expect(t.runtime().startupState).toBe('Ready');
  });
});

declare function expectFlags(): { engine: boolean; chain: boolean; notifications: boolean };
