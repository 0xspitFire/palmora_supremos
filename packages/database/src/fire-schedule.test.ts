import { describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import { FireScheduleRepository } from './fire-schedule.js';

/** T-067 (D-067): a scheduled mint is complete, short-windowed, claimed once, and never changed or deleted. */
const WALLET = '0x1111111111111111111111111111111111111111';
function fixture(start = '2026-10-24T12:00:00.000Z') {
  const db = openDatabase();
  db.prepare("INSERT INTO chain_profile (id, chain_id, name, rpc_endpoints_json, confirmation_depth, created_at) VALUES ('chain', 1, 'Ethereum', '[]', 2, '2026-01-01T00:00:00.000Z')").run();
  db.prepare("INSERT INTO contract (id, chain_profile_id, address, kind) VALUES ('contract', 'chain', '0xc', 'nft')").run();
  db.prepare("INSERT INTO collection (id, contract_id, name) VALUES ('collection', 'contract', 'c')").run();
  db.prepare("INSERT INTO \"drop\" (id, collection_id, strategy, mint_price_wei, observed_at) VALUES ('drop', 'collection', 'test', '0', '2026-01-01T00:00:00.000Z')").run();
  db.prepare("INSERT INTO campaign (id, drop_id, state, created_at) VALUES ('campaign', 'drop', 'draft', '2026-01-01T00:00:00.000Z')").run();
  let now = new Date(start);
  const repository = new FireScheduleRepository(db, () => now);
  const input = (overrides: Partial<Parameters<FireScheduleRepository['create']>[0]> = {}) => ({ campaignId: 'campaign', campaignDigest: 'a'.repeat(64), wallets: [WALLET], maxFeeGwei: '0.2', windowFrom: '2026-10-24T18:00:00.000Z', windowUntil: '2026-10-24T20:00:00.000Z', confirmationDigest: 'b'.repeat(64), ...overrides });
  return { db, repository, input, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

describe('scheduled mints', () => {
  it('creates a complete schedule, lists it as open, and claims it exactly once', () => {
    const { repository, input } = fixture();
    const schedule = repository.create(input());
    expect(repository.open('campaign').map((row) => row.id)).toEqual([schedule.id]);
    expect(repository.open('other')).toEqual([]);
    expect(repository.claim(schedule.id, 'started')).toBe(true);
    expect(repository.claim(schedule.id, 'started')).toBe(false);
    expect(repository.claim(schedule.id, 'cancelled')).toBe(false);
    expect(repository.unclaimed()).toEqual([]);
    expect(repository.recent(5)).toEqual([expect.objectContaining({ id: schedule.id, outcome: 'started', wallets: [WALLET] })]);
    expect(repository.claim('fire_schedule_missing', 'started')).toBe(false);
  });

  it('refuses a window over 6 hours, one that is over, a bad order, a bad fee, bad wallets or a bad digest (fail closed)', () => {
    const { repository, input } = fixture();
    const bad = [
      input({ windowUntil: '2026-10-25T00:30:00.000Z' }),
      input({ windowFrom: '2026-10-24T20:00:00.000Z', windowUntil: '2026-10-24T18:00:00.000Z' }),
      input({ windowFrom: '2026-10-24T10:00:00.000Z', windowUntil: '2026-10-24T11:00:00.000Z' }),
      input({ windowFrom: '2026-11-10T10:00:00.000Z', windowUntil: '2026-11-10T11:00:00.000Z' }),
      input({ windowFrom: 'soon', windowUntil: 'later' }),
      input({ maxFeeGwei: '0' }), input({ maxFeeGwei: '501' }), input({ maxFeeGwei: '1e2' }), input({ maxFeeGwei: '1.2.3' }),
      input({ wallets: [] }), input({ wallets: Array.from({ length: 11 }, (_, index) => `0x${(index + 1).toString(16).padStart(40, '0')}`) }),
      input({ campaignDigest: 'nope' }), input({ confirmationDigest: 'z'.repeat(64) }), input({ campaignId: 'no-such-campaign' }),
    ];
    for (const item of bad) expect(() => repository.create(item), JSON.stringify(item).slice(0, 80)).toThrow();
    expect(repository.unclaimed()).toEqual([]);
  });

  it('at most five can be open at once; a claimed or ended one frees a place', () => {
    const { repository, input, advance } = fixture();
    const made = Array.from({ length: 5 }, () => repository.create(input()));
    expect(() => repository.create(input())).toThrow(/too many/);
    repository.claim(made[0]!.id, 'cancelled');
    expect(() => repository.create(input())).not.toThrow();
    expect(() => repository.create(input())).toThrow(/too many/);
    advance(9 * 3_600_000);
    expect(repository.open()).toEqual([]);
    expect(() => repository.create(input({ windowFrom: '2026-10-25T00:00:00.000Z', windowUntil: '2026-10-25T02:00:00.000Z' }))).not.toThrow();
  });

  it('cancels one open schedule by its short id, or all of them at a kill', () => {
    const { repository, input } = fixture();
    const first = repository.create(input());
    const second = repository.create(input());
    repository.create(input());
    expect(repository.cancel(first.id.slice(-6))).toBe(true);
    expect(repository.cancel(first.id.slice(-6))).toBe(false);
    expect(repository.cancel('xx')).toBe(false);
    expect(repository.cancelAllOpen()).toBe(2);
    expect(repository.open()).toEqual([]);
    expect(repository.recent(5).filter((row) => row.outcome === 'cancelled')).toHaveLength(3);
    expect(repository.claim(second.id, 'started')).toBe(false);
  });

  it('a schedule and its outcome can never be changed or deleted, and a replacing insert cannot rewrite a claim', () => {
    const { db, repository, input } = fixture();
    const schedule = repository.create(input());
    repository.claim(schedule.id, 'started');
    expect(() => db.prepare("UPDATE fire_schedule SET max_fee_gwei = '400'").run()).toThrow(/immutable/);
    expect(() => db.prepare('DELETE FROM fire_schedule').run()).toThrow(/immutable/);
    expect(() => db.prepare("UPDATE fire_schedule_outcome SET outcome = 'expired'").run()).toThrow(/immutable/);
    expect(() => db.prepare('DELETE FROM fire_schedule_outcome').run()).toThrow(/immutable/);
    db.prepare("INSERT OR REPLACE INTO fire_schedule_outcome (schedule_id, outcome, claimed_at) VALUES (?, 'expired', '2026-10-24T12:01:00.000Z')").run(schedule.id);
    expect(db.prepare('SELECT outcome FROM fire_schedule_outcome').all()).toEqual([{ outcome: 'started' }]);
  });
});
