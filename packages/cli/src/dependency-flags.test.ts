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

describe('failure paths and hysteresis (review fixes)', () => {
  const allOn = { startupState: 'Ready', blockingReasons: [], dependencies: { engine: true, chain: true, backup: true, notifications: true } };

  it('a probe that throws forces every flag it controls off and blocks (fail closed)', async () => {
    const t = await setup({ chainsToProbe: () => { throw new Error('evidence unreadable'); } }, allOn);
    const result = await t.flags.tick();
    expect(result.chain).toBe(false);
    expect(t.runtime().startupState).toBe('Blocked');
    const broken = await setup({ killSwitchOn: async () => { throw new Error('x'); }, latestBlockTime: async () => { throw new Error('y'); } }, allOn);
    await broken.flags.tick();
    expect(broken.runtime().dependencies.chain).toBe(false);
  });

  it('a check that never answers is given up after 10 seconds', async () => {
    const { vi } = await import('vitest');
    vi.useFakeTimers();
    try {
      const t = await setup({ engineReady: () => new Promise<boolean>(() => undefined) }, allOn);
      const pending = t.flags.tick();
      await vi.advanceTimersByTimeAsync(10_100);
      expect((await pending).engine).toBe(false);
      expect(t.runtime().startupState).toBe('Blocked');
    } finally { vi.useRealTimers(); }
  });

  it('notifications turn off only after three failed checks in a row; a pass resets the count; engine and chain are never delayed', async () => {
    let ok = true;
    const t = await setup({ notificationsReady: async () => ok }, allOn);
    ok = false;
    await t.flags.tick(); await t.flags.tick();
    expect(t.runtime().dependencies.notifications).toBe(true);
    expect(t.runtime().startupState).toBe('Ready');
    ok = true;
    await t.flags.tick();
    ok = false;
    await t.flags.tick(); await t.flags.tick();
    expect(t.runtime().dependencies.notifications).toBe(true);
    await t.flags.tick();
    expect(t.runtime().dependencies.notifications).toBe(false);
    expect(t.runtime().startupState).toBe('Blocked');
  });

  it('keeps its reason while an unresolved run or a kill still blocks, and lifts only a block it caused', async () => {
    const withKill = await setup({ killSwitchOn: async () => true });
    await withKill.flags.tick();
    expect(withKill.runtime().blockingReasons).toContain('DEPLOYMENT_DEPENDENCIES_NOT_READY');
    expect(withKill.runtime().startupState).toBe('Blocked');
    const notOurs = await setup({}, { blockingReasons: [] });
    await notOurs.flags.tick();
    expect(notOurs.runtime().startupState).toBe('Blocked');
  });

  it('re-blocks when the kill file appears during the pass, after a lift', async () => {
    let reads = 0;
    const t = await setup({ killSwitchOn: async () => { reads += 1; return reads > 1; } });
    await t.flags.tick();
    expect(t.runtime().startupState).toBe('Blocked');
    expect(t.runtime().blockingReasons).toContain('KILL_SWITCH_ENGAGED');
  });

  it('gives a quiet chain (Robinhood) a longer block age than Ethereum', async () => {
    const t = await setup({ latestBlockTime: async (chainId) => new Date(NOW.getTime() - (chainId === 4663 ? 600_000 : 1_000)) });
    expect((await t.flags.tick()).chain).toBe(true);
    const eth = await setup({ latestBlockTime: async () => new Date(NOW.getTime() - 600_000) });
    expect((await eth.flags.tick()).chain).toBe(false);
  });
});

declare function expectFlags(): { engine: boolean; chain: boolean; notifications: boolean };
