import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

/**
 * Wiring checks for the owner-run `kill-release` command (T-028). The rules themselves (which runs block a release, the
 * phrase, the store method) are tested in the backend; this pins that the command uses them in the safe order.
 */
describe('kill-release command wiring', () => {
  async function commandBody(): Promise<string> {
    const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
    const start = source.indexOf(".command('kill-release'");
    const end = source.indexOf(".command('chain-evidence <action>'");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
  }

  it('looks at the stored state and the unresolved runs first, and only prints a phrase when nothing is unresolved', async () => {
    const body = await commandBody();
    expect(body).toContain('unresolvedRunIds(runtime.store.snapshot())');
    expect(body).toContain('killReleasePhrase(status)');
    expect(body).toMatch(/\.\.\.\(unresolved\.length === 0 \? \{ copyThisToRelease/);
  });

  it('runs the gate before it releases anything, and clears the stored flag before it removes the file', async () => {
    const body = await commandBody();
    const gate = body.indexOf('assertKillReleaseAllowed({ status, confirm: args.confirm, unresolved })');
    const release = body.indexOf('store.releaseKillSwitch(');
    const remove = body.indexOf('unlink(args.file)');
    expect(gate).toBeGreaterThan(0);
    expect(release).toBeGreaterThan(gate);
    expect(remove).toBeGreaterThan(release);
  });

  it('does not start the coordinator, never releases without --confirm, and reports a missing Telegram note instead of failing the release', async () => {
    const body = await commandBody();
    expect(body).toContain('{ startCoordinator: false }');
    expect(body.indexOf('if (args.confirm === undefined)')).toBeLessThan(body.indexOf('assertKillReleaseAllowed('));
    expect(body).toContain('noticeSent = false');
    expect(body).toContain('telegramNoticeSent: noticeSent');
  });

  it('leaves the old kill --clear refusal in place, pointing nowhere else', async () => {
    const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
    expect(source).toContain("throw new Error('KILL_SWITCH_RESET_REQUIRES_RECOVERY_APPROVAL')");
  });
});
