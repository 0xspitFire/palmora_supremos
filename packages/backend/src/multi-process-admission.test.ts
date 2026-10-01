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

/** Starts one OS process that admits `runId` against the shared database file at `startAt`. */
function admitInChildProcess(dbPath: string, runId: string, startAt: number): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, dbPath, runId, String(startAt), serializablePolicy, NOW], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += String(chunk); });
    child.stderr.on('data', (chunk) => { err += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => {
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
        const startAt = Date.now() + 1_500;
        const outcomes = await Promise.all([admitInChildProcess(dbPathOf(value), first.run.id, startAt), admitInChildProcess(dbPathOf(value), second.run.id, startAt)]);
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
      const startAt = Date.now() + 1_500;
      const outcomes = await Promise.all([admitInChildProcess(dbPathOf(value), prepared.run.id, startAt), admitInChildProcess(dbPathOf(value), prepared.run.id, startAt)]);
      expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
      const [left, right] = outcomes as Array<{ ok: true; reservations: string[] }>;
      expect(left!.reservations).toEqual(right!.reservations);
      expect(reservationCount(value)).toBe(2);
    } finally { await close(value); }
  }, 60_000);
});
