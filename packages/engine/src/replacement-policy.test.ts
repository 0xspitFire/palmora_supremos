import { describe, expect, it } from 'vitest';
import { ceilingWithinPolicy, planReplacement, requiredCeiling, reservedGasCostWei, type Fees } from './replacement-policy.js';

const gwei = (value: number): bigint => BigInt(Math.round(value * 1e9));
const fees = (max: number, tip: number): Fees => ({ maxFeePerGas: gwei(max), maxPriorityFeePerGas: gwei(tip) });

describe('D-080 planReplacement', () => {
  it('is disabled by default (zero bumps) and refuses', () => {
    expect(planReplacement({ current: fees(1, 0.1), ceiling: fees(2, 0.5), bumpsUsed: 0, maxBumps: 0, mayHaveMined: 'no' })).toEqual({ ok: false, reason: 'REPLACEMENT_DISABLED' });
  });

  it('raises both fees by at least 10 percent and stays under the ceiling', () => {
    const decision = planReplacement({ current: fees(1, 0.1), ceiling: fees(2, 0.5), bumpsUsed: 0, maxBumps: 2, mayHaveMined: 'no' });
    expect(decision).toEqual({ ok: true, next: { maxFeePerGas: gwei(1.1), maxPriorityFeePerGas: gwei(0.11) }, bumpsUsed: 1 });
  });

  it('never exceeds the number of allowed replacements', () => {
    expect(planReplacement({ current: fees(1, 0.1), ceiling: fees(2, 0.5), bumpsUsed: 2, maxBumps: 2, mayHaveMined: 'no' })).toEqual({ ok: false, reason: 'REPLACEMENT_LIMIT_REACHED' });
  });

  it('refuses when any earlier attempt may have been mined', () => {
    expect(planReplacement({ current: fees(1, 0.1), ceiling: fees(2, 0.5), bumpsUsed: 0, maxBumps: 2, mayHaveMined: 'yes' })).toEqual({ ok: false, reason: 'REPLACEMENT_MAY_HAVE_MINED' });
  });

  it('refuses when it is not PROVEN that nothing mined (unknown, or any unexpected value)', () => {
    const input = { current: fees(1, 0.1), ceiling: fees(2, 0.5), bumpsUsed: 0, maxBumps: 2 };
    expect(planReplacement({ ...input, mayHaveMined: 'unknown' })).toEqual({ ok: false, reason: 'REPLACEMENT_MINED_STATUS_UNKNOWN' });
    expect(planReplacement({ ...input, mayHaveMined: undefined as never })).toEqual({ ok: false, reason: 'REPLACEMENT_MINED_STATUS_UNKNOWN' });
  });

  it('refuses rather than clamp when the required rise would pass the ceiling, on either fee', () => {
    expect(planReplacement({ current: fees(1, 0.1), ceiling: fees(1, 0.5), bumpsUsed: 0, maxBumps: 2, mayHaveMined: 'no' })).toEqual({ ok: false, reason: 'REPLACEMENT_CEILING_REACHED' });
    expect(planReplacement({ current: fees(1, 0.1), ceiling: fees(2, 0.1), bumpsUsed: 0, maxBumps: 2, mayHaveMined: 'no' })).toEqual({ ok: false, reason: 'REPLACEMENT_CEILING_REACHED' });
  });

  it('can raise a zero tip by one unit and never lets the tip exceed the max fee', () => {
    const decision = planReplacement({ current: { maxFeePerGas: 10n, maxPriorityFeePerGas: 0n }, ceiling: { maxFeePerGas: 100n, maxPriorityFeePerGas: 100n }, bumpsUsed: 0, maxBumps: 1, mayHaveMined: 'no' });
    expect(decision).toEqual({ ok: true, next: { maxFeePerGas: 11n, maxPriorityFeePerGas: 1n }, bumpsUsed: 1 });
    if (decision.ok) expect(decision.next.maxPriorityFeePerGas <= decision.next.maxFeePerGas).toBe(true);
  });

  it('rejects invalid inputs and absurd bump counts', () => {
    const bad = (overrides: Partial<Parameters<typeof planReplacement>[0]>) => planReplacement({ current: fees(1, 0.1), ceiling: fees(2, 0.5), bumpsUsed: 0, maxBumps: 2, mayHaveMined: 'no', ...overrides });
    expect(bad({ maxBumps: 6 })).toEqual({ ok: false, reason: 'REPLACEMENT_CONFIG_INVALID' });
    expect(bad({ maxBumps: -1 })).toEqual({ ok: false, reason: 'REPLACEMENT_CONFIG_INVALID' });
    expect(bad({ maxBumps: 1.5 })).toEqual({ ok: false, reason: 'REPLACEMENT_CONFIG_INVALID' });
    expect(bad({ bumpsUsed: -1 })).toEqual({ ok: false, reason: 'REPLACEMENT_CONFIG_INVALID' });
    expect(bad({ current: { maxFeePerGas: 1n, maxPriorityFeePerGas: 2n } })).toEqual({ ok: false, reason: 'REPLACEMENT_FEES_INVALID' });
    expect(bad({ ceiling: { maxFeePerGas: 0n, maxPriorityFeePerGas: 0n } })).toEqual({ ok: false, reason: 'REPLACEMENT_FEES_INVALID' });
  });

  it('walks the whole ladder to exactly the ceiling that requiredCeiling predicts, then stops', () => {
    const initial = fees(1, 0.1);
    const ceiling = requiredCeiling(initial, 2);
    let current = initial;
    for (let used = 0; used < 2; used += 1) {
      const decision = planReplacement({ current, ceiling, bumpsUsed: used, maxBumps: 2, mayHaveMined: 'no' });
      expect(decision.ok).toBe(true);
      if (decision.ok) current = decision.next;
    }
    expect(current).toEqual(ceiling);
    expect(planReplacement({ current, ceiling, bumpsUsed: 2, maxBumps: 3, mayHaveMined: 'no' })).toEqual({ ok: false, reason: 'REPLACEMENT_CEILING_REACHED' });
  });
});

describe('D-080 rounding and limits', () => {
  it('always rounds the 10 percent rise up, so a value that is not a multiple of 10 still rises by at least 10 percent', () => {
    for (const fee of [1n, 7n, 9n, 11n, 99n, 101n, 12_345_678_901n]) {
      const decision = planReplacement({ current: { maxFeePerGas: fee + 5n, maxPriorityFeePerGas: fee }, ceiling: { maxFeePerGas: fee * 10n + 100n, maxPriorityFeePerGas: fee * 10n + 100n }, bumpsUsed: 0, maxBumps: 1, mayHaveMined: 'no' });
      expect(decision.ok).toBe(true);
      if (!decision.ok) continue;
      expect(decision.next.maxPriorityFeePerGas * 10_000n).toBeGreaterThanOrEqual(fee * 11_000n);
      expect(decision.next.maxFeePerGas * 10_000n).toBeGreaterThanOrEqual((fee + 5n) * 11_000n);
      expect(decision.next.maxPriorityFeePerGas).toBeGreaterThan(fee);
      expect(decision.next.maxPriorityFeePerGas <= decision.next.maxFeePerGas).toBe(true);
    }
  });

  it('allows the largest bump count and refuses one more; a tip equal to the max fee stays valid after a bump', () => {
    const initial = { maxFeePerGas: 1_000n, maxPriorityFeePerGas: 1_000n };
    const ceiling = requiredCeiling(initial, 5);
    let current = initial;
    for (let used = 0; used < 5; used += 1) {
      const decision = planReplacement({ current, ceiling, bumpsUsed: used, maxBumps: 5, mayHaveMined: 'no' });
      expect(decision.ok).toBe(true);
      if (decision.ok) { current = decision.next; expect(current.maxPriorityFeePerGas <= current.maxFeePerGas).toBe(true); }
    }
    expect(current).toEqual(ceiling);
    expect(planReplacement({ current, ceiling, bumpsUsed: 5, maxBumps: 5, mayHaveMined: 'no' })).toEqual({ ok: false, reason: 'REPLACEMENT_LIMIT_REACHED' });
    expect(() => requiredCeiling(initial, 6)).toThrow('REPLACEMENT_CONFIG_INVALID');
    expect(() => requiredCeiling({ maxFeePerGas: 0n, maxPriorityFeePerGas: 0n }, 1)).toThrow('REPLACEMENT_FEES_INVALID');
  });

  it('refuses a policy comparison with an impossible ceiling or policy (tip above max fee)', () => {
    expect(ceilingWithinPolicy({ maxFeePerGas: 5n, maxPriorityFeePerGas: 9n }, { maxFeePerGas: 100n, maxPriorityFeePerGas: 100n })).toBe(false);
    expect(ceilingWithinPolicy({ maxFeePerGas: 5n, maxPriorityFeePerGas: 1n }, { maxFeePerGas: 4n, maxPriorityFeePerGas: 9n })).toBe(false);
  });
});

describe('D-080 exposure and policy limits', () => {
  it('reserves the gas limit at the ceiling fee, which is larger than at the first fee', () => {
    const initial = fees(1, 0.1);
    const ceiling = requiredCeiling(initial, 2);
    expect(reservedGasCostWei(200_000n, ceiling)).toBeGreaterThan(reservedGasCostWei(200_000n, initial));
    expect(reservedGasCostWei(200_000n, ceiling)).toBe(200_000n * ceiling.maxFeePerGas);
    expect(() => reservedGasCostWei(0n, ceiling)).toThrow('REPLACEMENT_FEES_INVALID');
  });

  it('accepts a ceiling only inside the signed provider policy limits', () => {
    expect(ceilingWithinPolicy(fees(0.2, 0.1), fees(0.2, 0.1))).toBe(true);
    expect(ceilingWithinPolicy(fees(0.21, 0.1), fees(0.2, 0.1))).toBe(false);
    expect(ceilingWithinPolicy(fees(0.2, 0.11), fees(0.2, 0.1))).toBe(false);
  });

  it('requiredCeiling with the current policy defaults shows why replacement is inert until the first fee is set below the policy cap', () => {
    const policy = fees(0.2, 0.1);
    expect(ceilingWithinPolicy(requiredCeiling(policy, 2), policy)).toBe(false);
    expect(ceilingWithinPolicy(requiredCeiling(fees(0.165, 0.08), 2), policy)).toBe(true);
  });
});
