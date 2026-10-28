import { describe, expect, it } from 'vitest';
import type { Hash } from 'viem';
import { runReplacementLadder, type LadderAttempt, type LadderDeps, type SendOutcome } from './replacement-ladder.js';
import type { Fees } from './replacement-policy.js';

const gwei = (value: number): bigint => BigInt(Math.round(value * 1e9));
const fees = (max: number, tip: number): Fees => ({ maxFeePerGas: gwei(max), maxPriorityFeePerGas: gwei(tip) });
const h = (n: number): Hash => `0x${n.toString(16).padStart(64, '0')}`;
const original: LadderAttempt = { hash: h(1), attemptId: 'exec:attempt:signed', fees: fees(1, 0.1) };
const ceiling = fees(2, 0.5);

/** A fake world: a clock that only moves when the ladder sleeps, and scripted chain answers. */
function world(script: {
  mineAt?: Record<string, number>;          // hash -> time (ms) at which a receipt exists
  nonce?: (t: number) => 'consumed' | 'free' | Error;
  preCheck?: () => string | undefined;
  prepareError?: boolean;
  send?: (bump: number) => SendOutcome | Error;
  findError?: boolean;
} = {}) {
  let t = 0;
  const log: string[] = [];
  const prepared: Array<{ fees: Fees; bump: number; replaces: string }> = [];
  const deps: LadderDeps = {
    now: () => t,
    sleep: async (ms) => { t += ms; },
    findMinedHash: async (hashes) => {
      if (script.findError) throw new Error('rpc');
      return hashes.find((hash) => script.mineAt?.[hash] !== undefined && script.mineAt[hash]! <= t);
    },
    nonceState: async () => {
      const answer = script.nonce?.(t) ?? 'free';
      if (answer instanceof Error) throw answer;
      return answer;
    },
    preChecks: async () => script.preCheck?.(),
    prepare: async (next, bump, replaces) => {
      log.push('prepare');
      if (script.prepareError) throw new Error('signer denied');
      prepared.push({ fees: next, bump, replaces });
      return { signedTx: '0x02', hash: h(100 + bump), attemptId: `exec:attempt:replacement-${bump}:signed` };
    },
    send: async (_p, bump) => {
      log.push('send');
      const outcome = script.send?.(bump) ?? 'accepted';
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
  return { deps, log, prepared, clock: () => t };
}
const base = { attempts: [original], maxBumps: 2, ceiling, stuckAfterMs: 6_000, pollMs: 1_000, lastSentAt: 0 };

describe('T-094 replacement ladder', () => {
  it('never replaces when the original mines before it is stuck', async () => {
    const w = world({ mineAt: { [h(1)]: 3_000 } });
    const result = await runReplacementLadder(base, w.deps);
    expect(result).toMatchObject({ winner: h(1), stop: 'MINED' });
    expect(w.log).toEqual([]);
  });

  it('sends one 10 percent replacement when stuck, persisting before sending, and the replacement can win', async () => {
    const w = world({ mineAt: { [h(101)]: 9_000 } });
    const result = await runReplacementLadder(base, w.deps);
    expect(w.log).toEqual(['prepare', 'send']);
    expect(w.prepared).toEqual([{ fees: { maxFeePerGas: gwei(1.1), maxPriorityFeePerGas: gwei(0.11) }, bump: 1, replaces: 'exec:attempt:signed' }]);
    expect(result.winner).toBe(h(101));
    expect(result.attempts.map((attempt) => attempt.hash)).toEqual([h(1), h(101)]);
  });

  it('still recognises the ORIGINAL as the winner if it mines after a replacement was sent', async () => {
    const w = world({ mineAt: { [h(1)]: 7_000 } });
    const result = await runReplacementLadder(base, w.deps);
    expect(result).toMatchObject({ winner: h(1), stop: 'MINED' });
    expect(result.attempts).toHaveLength(2);
  });

  it('stops replacing the moment the sender nonce is consumed on chain', async () => {
    const w = world({ nonce: () => 'consumed' });
    const result = await runReplacementLadder(base, w.deps);
    expect(result.stop).toBe('NONCE_CONSUMED');
    expect(w.log).toEqual([]);
  });

  it('fails closed when the nonce or the receipt status cannot be read', async () => {
    const unreadableNonce = world({ nonce: () => new Error('rpc') });
    expect((await runReplacementLadder(base, unreadableNonce.deps)).stop).toBe('MINED_STATUS_UNKNOWN');
    expect(unreadableNonce.log).toEqual([]);
    const unreadableReceipt = world({ findError: true });
    expect((await runReplacementLadder(base, unreadableReceipt.deps)).stop).toBe('MINED_STATUS_UNKNOWN');
    expect(unreadableReceipt.log).toEqual([]);
  });

  it('stops without signing when the pre-checks refuse (kill switch, grant, changed drop, failed simulation)', async () => {
    const w = world({ preCheck: () => 'CAMPAIGN_CHANGED_MID_RUN: price' });
    const result = await runReplacementLadder(base, w.deps);
    expect(result).toMatchObject({ stop: 'PRE_CHECK_REFUSED', detail: 'CAMPAIGN_CHANGED_MID_RUN: price' });
    expect(w.log).toEqual([]);
  });

  it('a signer refusal ends replacing and leaves the set untouched', async () => {
    const w = world({ prepareError: true });
    const result = await runReplacementLadder(base, w.deps);
    expect(result).toMatchObject({ stop: 'SIGNER_REFUSED' });
    expect(result.attempts).toEqual([original]);
    expect(w.log).toEqual(['prepare']);
  });

  it('a rejected replacement ends replacing but its hash stays in the watched set', async () => {
    const w = world({ send: () => 'rejected' });
    const result = await runReplacementLadder(base, w.deps);
    expect(result.stop).toBe('REPLACEMENT_REJECTED');
    expect(result.attempts.map((attempt) => attempt.hash)).toEqual([h(1), h(101)]);
  });

  it('a send that throws counts as ambiguous: the hash is watched and the ladder goes on', async () => {
    const w = world({ send: (bump) => (bump === 1 ? new Error('connection lost') : 'accepted'), mineAt: { [h(102)]: 13_000 } });
    const result = await runReplacementLadder(base, w.deps);
    expect(result.attempts.map((attempt) => attempt.hash)).toEqual([h(1), h(101), h(102)]);
    expect(result.winner).toBe(h(102));
  });

  it('never exceeds the allowed number of replacements', async () => {
    const w = world();
    const result = await runReplacementLadder({ ...base, maxBumps: 1 }, w.deps);
    expect(result.stop).toBe('REPLACEMENT_LIMIT_REACHED');
    expect(result.attempts).toHaveLength(2);
    expect(w.prepared).toHaveLength(1);
  });

  it('a restart in the middle of the ladder cannot reset it: used replacements come from the persisted attempts', async () => {
    const persisted: LadderAttempt[] = [original, { hash: h(101), attemptId: 'r1', fees: fees(1.1, 0.11) }, { hash: h(102), attemptId: 'r2', fees: fees(1.21, 0.121) }];
    const w = world();
    const result = await runReplacementLadder({ ...base, attempts: persisted, maxBumps: 2 }, w.deps);
    expect(result.stop).toBe('REPLACEMENT_LIMIT_REACHED');
    expect(w.log).toEqual([]);
  });

  it('refuses a step that would pass the ceiling and never signs it', async () => {
    const w = world();
    const result = await runReplacementLadder({ ...base, ceiling: fees(1, 0.5) }, w.deps);
    expect(result.stop).toBe('REPLACEMENT_CEILING_REACHED');
    expect(w.log).toEqual([]);
  });

  it('does nothing when replacement is disabled or there is no original attempt', async () => {
    expect((await runReplacementLadder({ ...base, maxBumps: 0 }, world().deps)).stop).toBe('REPLACEMENT_DISABLED');
    expect((await runReplacementLadder({ ...base, attempts: [] }, world().deps)).stop).toBe('REPLACEMENT_CONFIG_INVALID');
  });

  it('waits the full stuck period after each send before replacing again', async () => {
    const w = world();
    await runReplacementLadder(base, w.deps);
    // first replacement at 6 s, second no earlier than 12 s, then the limit is reached at 18 s
    expect(w.clock()).toBe(18_000);
    expect(w.prepared.map((entry) => entry.bump)).toEqual([1, 2]);
  });
});
