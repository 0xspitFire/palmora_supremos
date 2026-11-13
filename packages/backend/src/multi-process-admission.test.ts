import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ETHEREUM, NOW, OPEN_FLEET_POLICY, WALLET_ONE, WALLET_TWO, armed, campaign, campaignInput, close, fixture, type Fixture } from './canonical-fixtures.js';

const CHILD = fileURLToPath(new URL('../test-support/admit-child.mjs', import.meta.url));
// Each wallet reserves 34 wei of free exposure in these fixtures, so 68 wei fits exactly one two-wallet run.
const ONE_RUN_POLICY = { ...OPEN_FLEET_POLICY, freeDailyCapWei: 68n };
const serializablePolicy = JSON.stringify(Object.fromEntries(Object.entries(ONE_RUN_POLICY).map(([key, value]) => [key, typeof value === 'bigint' ? value.toString() : value])));

type Outcome = { ok: true; reservations: string[] } | { ok: false; error: string };

/** Both children load the armed snapshot before either admission starts. A wall
 * clock delay cannot guarantee that barrier under full-suite CPU contention. */
function admissionBarrier(): (release:()=>void)=>void {
  const waiting:Array<()=>void>=[];
  return release=>{waiting.push(release);if(waiting.length===2)waiting.forEach(start=>start());};
}
function admitInChildProcess(dbPath: string, runId: string, nowIso = NOW, ready:(release:()=>void)=>void=release=>release()): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, dbPath, runId, serializablePolicy, nowIso], { stdio: ['ignore', 'pipe', 'pipe','ipc'] });
    const deadline=setTimeout(()=>{child.kill('SIGTERM');reject(new Error('ADMISSION_CHILD_TIMEOUT'));},25000);
    child.once('message',message=>{if(message==='ready')ready(()=>{if(child.connected)child.send('admit');});});
    let out = '';
    let err = '';
    child.stdout!.on('data', (chunk) => { out += String(chunk); });
    child.stderr!.on('data', (chunk) => { err += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(deadline);
      if (code !== 0) return reject(new Error(`child exited ${code}: ${err.slice(0, 400)}`));
      try { resolve(JSON.parse(out.trim().split('\n').at(-1) ?? '') as Outcome); } catch { reject(new Error(`unreadable child output: ${out.slice(0, 200)}`)); }
    });
  });
}

const dbPathOf = (value: Fixture): string => join(value.directory, 'state.sqlite');
const reservationCount = (value: Fixture): number => (value.db.prepare('SELECT COUNT(*) AS n FROM spend_reservation').get() as { n: number }).n;

describe('multi-process concurrent admission (checklist: two OS processes, one SQLite file)', () => {
  it('lets only one of two processes admit when the fleet cap fits one run, and never over-reserves', async () => {
    for (let round = 0; round < 3; round += 1) {
      const value = await fixture(ETHEREUM, false, true, undefined, true, ONE_RUN_POLICY);
      try {
        const first = await armed(value, await value.application.createCampaign({ ...campaignInput(ETHEREUM), maxRunWei: 1_000n, dailyCapWei: 1_000n }), [WALLET_ONE, WALLET_TWO]);
        const second = await armed(value, await campaign(value, ETHEREUM), [WALLET_ONE, WALLET_TWO]);
        const ready=admissionBarrier();
        const outcomes = await Promise.all([admitInChildProcess(dbPathOf(value), first.run.id,NOW,ready), admitInChildProcess(dbPathOf(value), second.run.id,NOW,ready)]);
        const admitted = outcomes.filter((outcome) => outcome.ok);
        const refused = outcomes.filter((outcome) => !outcome.ok);
        expect(admitted).toHaveLength(1);
        expect(refused).toHaveLength(1);
        expect((refused[0] as { error: string }).error).toContain('FLEET_DAILY_CAP_EXCEEDED');
        expect(reservationCount(value)).toBe(2);
        const reservedWei = (value.db.prepare("SELECT COALESCE(SUM(CAST(amount_wei AS INTEGER)), 0) AS total FROM spend_reservation WHERE status = 'reserved'").get() as { total: number }).total;
        expect(reservedWei).toBeLessThanOrEqual(Number(ONE_RUN_POLICY.freeDailyCapWei));
      } finally { await close(value); }
    }
  }, 60_000);

  it('gives two processes admitting the same run the same reservations, without duplicating them', async () => {
    const value = await fixture(ETHEREUM, false, true, undefined, true, ONE_RUN_POLICY);
    try {
      const prepared = await armed(value, await value.application.createCampaign({ ...campaignInput(ETHEREUM), maxRunWei: 1_000n, dailyCapWei: 1_000n }), [WALLET_ONE, WALLET_TWO]);
      const ready=admissionBarrier();
      const outcomes = await Promise.all([admitInChildProcess(dbPathOf(value), prepared.run.id,NOW,ready), admitInChildProcess(dbPathOf(value), prepared.run.id,NOW,ready)]);
      expect(outcomes.every((outcome) => outcome.ok),JSON.stringify(outcomes)).toBe(true);
      const [left, right] = outcomes as Array<{ ok: true; reservations: string[] }>;
      expect(left!.reservations).toEqual(right!.reservations);
      expect(reservationCount(value)).toBe(2);
    } finally { await close(value); }
  }, 60_000);

  it('does not grant a fresh fleet allowance to a second process after midnight', async () => {
    const value = await fixture(ETHEREUM, false, true, undefined, true, ONE_RUN_POLICY);
    try {
      const first = await armed(value, await value.application.createCampaign({ ...campaignInput(ETHEREUM), maxRunWei: 1_000n, dailyCapWei: 1_000n }), [WALLET_ONE, WALLET_TWO], [], '-rollover-first');
      const second = await armed(value, await campaign(value, ETHEREUM), [WALLET_ONE, WALLET_TWO], [], '-rollover-second');
      const before = await admitInChildProcess(dbPathOf(value), first.run.id, '2026-10-19T23:59:59.900Z');
      expect(before.ok).toBe(true);
      const after = await admitInChildProcess(dbPathOf(value), second.run.id, '2026-10-20T00:00:00.100Z');
      expect(after).toEqual({ ok: false, error: 'FLEET_DAILY_CAP_EXCEEDED' });
      expect(reservationCount(value)).toBe(2);
    } finally { await close(value); }
  }, 60_000);
});
