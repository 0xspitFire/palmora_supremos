import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { killReleasePhrase, type KillSwitchStatus } from '@mint-bot/backend';
import { killReleaseAction } from './owner-actions.js';

/**
 * The owner-run kill release (T-028), shared by `kill-release` on the host and `/release` in Telegram (T-061). The rules
 * themselves (which runs block a release, the phrase, the store method) are tested in the backend; these check the order:
 * nothing is released without the exact phrase, nothing while a run is unresolved, and the stored flag before the file.
 */
const STATUS: KillSwitchStatus = { engaged: true, changedBy: 'owner-cli', changedAt: '2026-10-24T10:00:00.000Z' };

function fakeStore(options: { unresolved?: boolean } = {}) {
  const calls: string[] = [];
  const store = {
    killSwitchStatus: () => STATUS,
    snapshot: () => ({ killed: true, runs: options.unresolved ? [{ id: 'run_open', state: 'Active', campaignId: 'cmp' }] : [], attempts: [], reconciliations: [], campaigns: [] }) as never,
    releaseKillSwitch: async (actor: string) => { calls.push(`release:${actor}`); return { released: true }; },
  };
  return { store, calls };
}

async function withKillFile<T>(run: (file: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'mintbot-kill-release-'));
  const file = join(dir, 'killswitch');
  await writeFile(file, 'engaged\n');
  try { return await run(file); } finally { await rm(dir, { recursive: true, force: true }); }
}

describe('kill release (shared by the host command and Telegram)', () => {
  it('without the phrase only reports and prints the phrase; nothing is released', async () => withKillFile(async (file) => {
    const { store, calls } = fakeStore();
    const outcome = await killReleaseAction({ store, killFile: file, confirm: undefined, actor: 'owner-cli' });
    expect(outcome).toMatchObject({ state: 'On', phrase: killReleasePhrase(STATUS), unresolvedRuns: [] });
    expect(calls).toEqual([]);
    expect(existsSync(file)).toBe(true);
  }));

  it('a wrong phrase is refused and nothing is released (fail closed)', async () => withKillFile(async (file) => {
    const { store, calls } = fakeStore();
    await expect(killReleaseAction({ store, killFile: file, confirm: 'RELEASE-KILL wrong', actor: 'owner-cli' })).rejects.toThrow(/CONFIRMATION_PHRASE_MISMATCH/);
    expect(calls).toEqual([]);
    expect(existsSync(file)).toBe(true);
  }));

  it('an unresolved run blocks the release and no phrase is offered (fail closed)', async () => withKillFile(async (file) => {
    const { store, calls } = fakeStore({ unresolved: true });
    const preview = await killReleaseAction({ store, killFile: file, confirm: undefined, actor: 'owner-cli' });
    expect(preview).toMatchObject({ state: 'On', unresolvedRuns: ['run_open'] });
    expect('phrase' in preview && preview.phrase).toBeFalsy();
    await expect(killReleaseAction({ store, killFile: file, confirm: killReleasePhrase(STATUS), actor: 'owner-cli' })).rejects.toThrow(/KILL_RELEASE_BLOCKED_UNRESOLVED_RUNS/);
    expect(calls).toEqual([]);
    expect(existsSync(file)).toBe(true);
  }));

  it('the exact phrase clears the stored flag first, then removes the file, naming who released it', async () => withKillFile(async (file) => {
    const { store, calls } = fakeStore();
    const outcome = await killReleaseAction({ store, killFile: file, confirm: killReleasePhrase(STATUS), actor: 'owner-telegram' });
    expect(outcome.state).toBe('Released');
    expect(calls).toEqual(['release:owner-telegram']);
    expect(existsSync(file)).toBe(false);
  }));
});

describe('kill-release command wiring', () => {
  async function commandBody(): Promise<string> {
    const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
    const start = source.indexOf(".command('kill-release'");
    const end = source.indexOf(".command('chain-evidence <action>'");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
  }

  it('uses the shared release, does not start the coordinator, and reports a missing Telegram note instead of failing the release', async () => {
    const body = await commandBody();
    expect(body).toContain("killReleaseAction({ store: asKillStore(runtime.store), killFile: args.file, confirm: args.confirm, actor: 'owner-cli' })");
    expect(body).toContain('{ startCoordinator: false }');
    expect(body).toContain('noticeSent = false');
    expect(body).toContain('telegramNoticeSent: noticeSent');
  });

  it('on the host the default kill file is the service\'s KILL_SWITCH_PATH', async () => {
    const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
    expect(source).toContain("const DEFAULT_KILL_FILE = process.env.KILL_SWITCH_PATH ? resolve(runtimeRoot, process.env.KILL_SWITCH_PATH) : join(runtimeRoot, 'Rets', 'state', 'killswitch');");
  });

  it('leaves the old kill --clear refusal in place, pointing nowhere else', async () => {
    const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
    expect(source).toContain("throw new Error('KILL_SWITCH_RESET_REQUIRES_RECOVERY_APPROVAL')");
  });
});
