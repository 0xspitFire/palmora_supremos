import { describe, expect, it } from 'vitest';
import { assertKillReleaseAllowed, killReleasePhrase, unresolvedRunIds } from './kill-switch-release.js';
import { ETHEREUM, WALLET_ONE, armed, campaign, close, fixture } from './canonical-fixtures.js';
import type { CanonicalStoreBridge } from './canonical-store.js';

const status = { engaged: true, changedBy: 'operator', changedAt: '2026-10-02T12:00:00.000Z' };
const run = (id: string, state: string, campaignId = 'c1') => ({ id, state, campaignId }) as never;
const attempt = (runId: string, hash?: string) => ({ runId, hash }) as never;
const rec = (runId: string, result: string) => ({ runId, result }) as never;
const base = { campaigns: [{ id: 'c1', chainId: 1 }, { id: 'c4663', chainId: 4663 }] as never, attempts: [] as never[], reconciliations: [] as never[] };

describe('which runs must settle before the kill switch can be released', () => {
  it('counts armed and active runs, and aborted runs that already sent a transaction without a final result', () => {
    const runs = [run('armed', 'Armed'), run('active', 'Active'), run('aborted-sent', 'Aborted'), run('aborted-clean', 'Aborted'), run('done', 'Completed')];
    const attempts = [attempt('aborted-sent', '0xabc')];
    expect(unresolvedRunIds({ ...base, runs, attempts })).toEqual(['armed', 'active', 'aborted-sent']);
  });

  it('treats failed, final and (on Ethereum) confirmed results as settled, but a Robinhood confirmed result as not final', () => {
    const runs = [run('failed', 'Aborted'), run('final', 'Aborted'), run('eth-confirmed', 'Aborted'), run('rh-confirmed', 'Aborted', 'c4663'), run('unknown', 'Aborted')];
    const attempts = runs.map((item) => attempt((item as { id: string }).id, '0x1'));
    const reconciliations = [rec('failed', 'failed'), rec('final', 'final'), rec('eth-confirmed', 'confirmed'), rec('rh-confirmed', 'confirmed'), rec('unknown', 'unknown')];
    expect(unresolvedRunIds({ ...base, runs, attempts, reconciliations })).toEqual(['rh-confirmed', 'unknown']);
  });
});

describe('the release gate and phrase', () => {
  it('names when the switch was turned on, so an older phrase does not match', () => {
    expect(killReleasePhrase(status)).toBe('RELEASE-KILL-SWITCH engaged 2026-10-02T12:00:00.000Z');
    expect(killReleasePhrase({ ...status, changedAt: '2026-10-03T12:00:00.000Z' })).not.toBe(killReleasePhrase(status));
    expect(killReleasePhrase({ ...status, engaged: false })).toBe('RELEASE-KILL-SWITCH file-only');
  });

  it('passes only with nothing unresolved and the exact phrase', () => {
    expect(() => assertKillReleaseAllowed({ status, confirm: killReleasePhrase(status), unresolved: [] })).not.toThrow();
    for (const confirm of [undefined, '', 'yes', killReleasePhrase(status).toLowerCase(), `${killReleasePhrase(status)} `, 'RELEASE-KILL-SWITCH file-only']) {
      expect(() => assertKillReleaseAllowed({ status, confirm, unresolved: [] })).toThrow('CONFIRMATION_PHRASE_MISMATCH');
    }
  });

  it('refuses while any run is unresolved, even with the right phrase, and names them', () => {
    expect(() => assertKillReleaseAllowed({ status, confirm: killReleasePhrase(status), unresolved: ['run-1', 'run-2'] })).toThrow('KILL_RELEASE_BLOCKED_UNRESOLVED_RUNS: 2 run(s)');
    expect(() => assertKillReleaseAllowed({ status, confirm: 'wrong', unresolved: ['run-1'] })).toThrow('KILL_RELEASE_BLOCKED_UNRESOLVED_RUNS');
  });
});

describe('releasing the stored kill switch', () => {
  it('turns off the stored flag and the in-memory state together, removes the KILLED reason, and records who released it', async () => {
    const value = await fixture(ETHEREUM);
    try {
      const store = value.store as CanonicalStoreBridge;
      expect(store.killSwitchStatus().engaged).toBe(false);
      expect(await store.releaseKillSwitch('owner-cli', 'x')).toEqual({ released: false }); // nothing to release
      await store.transaction((state) => { state.runtime.operational = { signerReady: true, killSwitchEngaged: false, notificationReady: true, chainVerification: 'verified', lastReconciliationAt: new Date().toISOString(), observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 900_000).toISOString() }; });
      expect(store.snapshot().runtime.operational).toBeDefined();
      await value.application.command('kill', { reason: 'test stop' });
      expect(store.killSwitchStatus()).toMatchObject({ engaged: true });
      expect(store.snapshot().killed).toBe(true);
      expect(store.snapshot().runtime.blockingReasons).toContain('KILLED');
      expect(await store.releaseKillSwitch('owner-cli', 'operator release')).toEqual({ released: true });
      expect(store.killSwitchStatus()).toMatchObject({ engaged: false, changedBy: 'owner-cli' });
      expect(store.snapshot().killed).toBe(false);
      expect(store.snapshot().runtime.blockingReasons).not.toContain('KILLED');
      expect(store.snapshot().runtime.operational).toBeUndefined(); // readiness must be recorded again after a stop
      expect(store.snapshot().events.some((event) => event.type === 'kill_released' && event.data.actor === 'owner-cli')).toBe(true);
    } finally { await close(value); }
  });

  it('refuses to release while a run is still armed, and changes nothing (the kill command itself aborts armed runs, so none is left in flight)', async () => {
    const value = await fixture(ETHEREUM);
    try {
      const store = value.store as CanonicalStoreBridge;
      const created = await campaign(value, ETHEREUM);
      const prepared = await armed(value, created, [WALLET_ONE]);
      expect(prepared.run.state).toBe('Armed');
      // Turn the stored flag on without the abort that the kill command performs, so the run stays armed.
      await store.transaction((state) => { state.killed = true; });
      expect(store.snapshot().runs.find((item) => item.id === prepared.run.id)?.state).toBe('Armed');
      await expect(store.releaseKillSwitch('owner-cli', 'x')).rejects.toThrow('KILL_RELEASE_BLOCKED_UNRESOLVED_RUNS');
      expect(store.killSwitchStatus().engaged).toBe(true);
      expect(store.snapshot().killed).toBe(true);
    } finally { await close(value); }
  });
});
