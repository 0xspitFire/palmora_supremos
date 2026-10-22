import { describe, expect, it } from 'vitest';
import { DEFAULT_IDLE_BALANCE_CEILINGS, EXCESS_REMINDER_AFTER_MS, FUNDING_ROUNDING_MARGIN_WEI, describeTopUps, planRunFunding, roundUpToDisplay, stepExcessTracker } from './fleet-funding.js';
import type { BalanceCeiling } from './compensating-controls.js';

const W1 = '0x1111111111111111111111111111111111111111';
const W2 = '0x2222222222222222222222222222222222222222';
const CEILING: BalanceCeiling = { walletMaxWei: 400_000_000_000_000n, fleetMaxWei: 2_000_000_000_000_000n, runEnvelopeMaxWei: 1_000_000_000_000_000n, runEnvelopeFleetMaxWei: 3_000_000_000_000_000n };
const NOW = new Date('2026-10-22T12:00:00.000Z');
const HOUR = 3_600_000;

describe('run-time funding plan (D-059 item 3)', () => {
  it('asks only for the shortfall and builds the envelope and minimum from the run itself', () => {
    const plan = planRunFunding({ chainId: 1, ceiling: CEILING, wallets: [{ address: W1, balanceWei: 100_000_000_000_000n, requiredWei: 600_000_000_000_000n }, { address: W2, balanceWei: 600_000_000_000_000n, requiredWei: 600_000_000_000_000n }] });
    expect(plan.blockers).toEqual([]);
    expect(plan.ready).toBe(false);
    expect(plan.items.map((item) => item.topUpWei)).toEqual(['500000000000000', '0']);
    expect(plan.totalTopUpWei).toBe('500000000000000');
    expect(plan.runEnvelopeWei[W1]).toBe('601000000000000'); // required + the 0.000001 ETH rounding margin
    expect(plan.minimumBalanceWei[W2]).toBe('600000000000000');
    expect(describeTopUps(plan)).toEqual([{ wallet: W1, topUpWei: '500000000000000' }]);
  });

  it('is ready only when every wallet already holds its requirement', () => {
    const plan = planRunFunding({ chainId: 1, ceiling: CEILING, wallets: [{ address: W1, balanceWei: 600_000_000_000_000n, requiredWei: 600_000_000_000_000n }] });
    expect(plan.ready).toBe(true);
    expect(plan.totalTopUpWei).toBe('0');
  });

  it('refuses a requirement above the chain bound, and carried surplus never raises the envelope', () => {
    expect(planRunFunding({ chainId: 1, ceiling: CEILING, wallets: [{ address: W1, balanceWei: 0n, requiredWei: 1_000_000_000_000_001n }] }).blockers).toEqual([`RUN_ENVELOPE_ABOVE_CHAIN_BOUND:${W1}`]);
    const surplus = planRunFunding({ chainId: 1, ceiling: CEILING, wallets: [{ address: W1, balanceWei: 700_000_000_000_000n, requiredWei: 500_000_000_000_000n }] });
    expect(surplus.blockers).toEqual([`WALLET_ABOVE_RUN_ENVELOPE:${W1}`]);
    expect(surplus.ready).toBe(false);
    // a small run still lets the idle ceiling stand: a wallet at the ceiling is not surplus
    expect(planRunFunding({ chainId: 1, ceiling: CEILING, wallets: [{ address: W1, balanceWei: 400_000_000_000_000n, requiredWei: 100_000_000_000_000n }] }).blockers).toEqual([]);
  });

  it('refuses a fleet envelope above the fleet bound', () => {
    const wallets = Array.from({ length: 4 }, (_, index) => ({ address: `0x${String(index + 1).repeat(40)}`, balanceWei: 0n, requiredWei: 900_000_000_000_000n }));
    expect(planRunFunding({ chainId: 1, ceiling: CEILING, wallets }).blockers).toEqual(['RUN_ENVELOPE_ABOVE_FLEET_BOUND']);
    // without a fleet envelope bound the idle fleet ceiling cannot be raised: three wallets at 0.0009 exceed 0.002
    expect(planRunFunding({ chainId: 1, ceiling: { ...CEILING, runEnvelopeFleetMaxWei: undefined }, wallets: wallets.slice(0, 3) }).blockers).toEqual(['RUN_ENVELOPE_ABOVE_FLEET_BOUND']);
    expect(planRunFunding({ chainId: 1, ceiling: CEILING, wallets: wallets.slice(0, 3) }).blockers).toEqual([]);
  });

  it('fails closed without a ceiling, without wallets, on duplicates, invalid addresses and invalid requirements', () => {
    expect(planRunFunding({ chainId: 8453, ceiling: undefined, wallets: [{ address: W1, balanceWei: 0n, requiredWei: 1n }] }).blockers).toEqual(['NO_BALANCE_CEILING_FOR_CHAIN']);
    expect(planRunFunding({ chainId: 1, ceiling: CEILING, wallets: [] }).blockers).toEqual(['NO_WALLETS']);
    expect(planRunFunding({ chainId: 1, ceiling: CEILING, wallets: [{ address: W1, balanceWei: 0n, requiredWei: 1n }, { address: W1.toUpperCase().replace('0X', '0x'), balanceWei: 0n, requiredWei: 1n }] }).blockers).toEqual([`DUPLICATE_WALLET:${W1}`]);
    expect(planRunFunding({ chainId: 1, ceiling: CEILING, wallets: [{ address: 'nope', balanceWei: 0n, requiredWei: 1n }] }).blockers).toContain('WALLET_ADDRESS_INVALID');
    expect(planRunFunding({ chainId: 1, ceiling: CEILING, wallets: [{ address: W1, balanceWei: 0n, requiredWei: 0n }] }).blockers).toEqual([`REQUIREMENT_INVALID:${W1}`]);
    expect(planRunFunding({ chainId: 1, ceiling: CEILING, wallets: [{ address: W1, balanceWei: 0n, requiredWei: 1n }], marginWei: -1n }).blockers).toEqual(['MARGIN_INVALID']);
  });

  it('adds the fixed margin to the envelope but not to the amount requested', () => {
    const plan = planRunFunding({ chainId: 1, ceiling: CEILING, wallets: [{ address: W1, balanceWei: 0n, requiredWei: 500_000_000_000_000n }], marginWei: 10_000_000_000_000n });
    expect(plan.runEnvelopeWei[W1]).toBe('510000000000000');
    expect(plan.minimumBalanceWei[W1]).toBe('500000000000000');
    expect(plan.items[0]?.topUpWei).toBe('500000000000000');
  });
});

describe('a run that needs exactly the idle ceiling', () => {
  it('is fundable without any run limit, and rounding never pushes the wallet above its own limit', () => {
    const idleOnly: BalanceCeiling = { walletMaxWei: 400_000_000_000_000n, fleetMaxWei: 2_000_000_000_000_000n };
    const plan = planRunFunding({ chainId: 1, ceiling: idleOnly, wallets: [{ address: W1, balanceWei: 0n, requiredWei: 400_000_000_000_000n }, { address: W2, balanceWei: 100_000_000_000_000n, requiredWei: 399_999_999_999_999n }] });
    expect(plan.blockers).toEqual([]);
    expect(plan.items.map((item) => item.topUpWei)).toEqual(['400000000000000', '300000000000000']);
    // one unit above the idle ceiling needs a run limit that is not configured
    expect(planRunFunding({ chainId: 1, ceiling: idleOnly, wallets: [{ address: W1, balanceWei: 0n, requiredWei: 400_000_000_000_001n }] }).blockers).toEqual([`RUN_ENVELOPE_ABOVE_CHAIN_BOUND:${W1}`]);
    // the top-up is capped so the funded balance stays within the wallet's limit even when display rounding would overshoot
    const tight = planRunFunding({ chainId: 1, ceiling: { ...idleOnly, walletMaxWei: 400_000_000_000_001n }, wallets: [{ address: W1, balanceWei: 1n, requiredWei: 400_000_000_000_001n }] });
    expect(BigInt(tight.items[0]!.balanceWei) + BigInt(tight.items[0]!.topUpWei)).toBeLessThanOrEqual(400_000_000_000_001n);
  });
});

describe('amount rounding', () => {
  it('rounds the amount to send up to 0.000001 ETH, which the envelope margin covers, so the funded wallet is never short or over the envelope', () => {
    expect(roundUpToDisplay(1n)).toBe(FUNDING_ROUNDING_MARGIN_WEI);
    expect(roundUpToDisplay(FUNDING_ROUNDING_MARGIN_WEI)).toBe(FUNDING_ROUNDING_MARGIN_WEI);
    expect(roundUpToDisplay(0n)).toBe(0n);
    const plan = planRunFunding({ chainId: 1, ceiling: CEILING, wallets: [{ address: W1, balanceWei: 0n, requiredWei: 600_000_000_000_001n }] });
    expect(plan.items[0]?.topUpWei).toBe('601000000000000');
    expect(BigInt(plan.items[0]!.topUpWei)).toBeLessThanOrEqual(BigInt(plan.runEnvelopeWei[W1]!));
    expect(BigInt(plan.items[0]!.topUpWei)).toBeGreaterThanOrEqual(600_000_000_000_001n);
  });
});

describe('left-over balance reminder (D-059 item 3)', () => {
  const base = { walletMaxWei: 400_000_000_000_000n, runActive: false };
  const above = (nonce = 5, balanceWei = 700_000_000_000_000n) => [{ address: W1, balanceWei, nonce }];

  it('starts a clock when first seen above the ceiling and reminds nothing yet', () => {
    const first = stepExcessTracker({ ...base, previous: {}, observations: above(), now: NOW });
    expect(first.reminders).toEqual([]);
    expect(first.next[W1]).toMatchObject({ firstAboveAt: NOW.toISOString(), activityKey: '5' });
  });

  it('reminds after 24 hours with no activity and repeats every 24 hours', () => {
    const t0 = stepExcessTracker({ ...base, previous: {}, observations: above(), now: NOW }).next;
    const early = stepExcessTracker({ ...base, previous: t0, observations: above(), now: new Date(NOW.getTime() + 23 * HOUR) });
    expect(early.reminders).toEqual([]);
    const due = stepExcessTracker({ ...base, previous: early.next, observations: above(), now: new Date(NOW.getTime() + 24 * HOUR) });
    expect(due.reminders).toHaveLength(1);
    expect(due.reminders[0]).toMatchObject({ wallet: W1, excessWei: '300000000000000' });
    const sameDay = stepExcessTracker({ ...base, previous: due.next, observations: above(), now: new Date(NOW.getTime() + 30 * HOUR) });
    expect(sameDay.reminders).toEqual([]);
    const repeat = stepExcessTracker({ ...base, previous: sameDay.next, observations: above(), now: new Date(NOW.getTime() + 48 * HOUR) });
    expect(repeat.reminders).toHaveLength(1);
  });

  it('restarts the clock on any on-chain activity from the wallet', () => {
    const t0 = stepExcessTracker({ ...base, previous: {}, observations: above(5), now: NOW }).next;
    const active = stepExcessTracker({ ...base, previous: t0, observations: above(6), now: new Date(NOW.getTime() + 20 * HOUR) });
    expect(active.next[W1]?.firstAboveAt).toBe(new Date(NOW.getTime() + 20 * HOUR).toISOString());
    expect(stepExcessTracker({ ...base, previous: active.next, observations: above(6), now: new Date(NOW.getTime() + 25 * HOUR) }).reminders).toEqual([]);
    expect(stepExcessTracker({ ...base, previous: active.next, observations: above(6), now: new Date(NOW.getTime() + 44 * HOUR) }).reminders).toHaveLength(1);
  });

  it('forgets a wallet that is back within the ceiling or while a run is armed or active', () => {
    const t0 = stepExcessTracker({ ...base, previous: {}, observations: above(), now: NOW }).next;
    expect(stepExcessTracker({ ...base, previous: t0, observations: above(5, 400_000_000_000_000n), now: new Date(NOW.getTime() + 30 * HOUR) })).toEqual({ next: {}, reminders: [] });
    expect(stepExcessTracker({ ...base, runActive: true, previous: t0, observations: above(), now: new Date(NOW.getTime() + 30 * HOUR) })).toEqual({ next: {}, reminders: [] });
  });

  it('uses 24 hours and ignores bad addresses', () => {
    expect(EXCESS_REMINDER_AFTER_MS).toBe(24 * HOUR);
    expect(stepExcessTracker({ ...base, previous: {}, observations: [{ address: 'nope', balanceWei: 10n ** 18n, nonce: 1 }], now: NOW }).next).toEqual({});
  });
});

describe('D-060 run-time funding limits (balance limits only)', () => {
  const wallet = (index: number, requiredWei: bigint, balanceWei = 0n) => ({ address: `0x${String(index).repeat(40)}`, balanceWei, requiredWei });

  it('are 0.0041 per wallet and 0.0085 for the fleet on Ethereum, Base and Robinhood, beside the 0.0004 / 0.002 idle limits', () => {
    for (const chainId of [1, 8453, 4663]) {
      expect(DEFAULT_IDLE_BALANCE_CEILINGS[chainId]).toEqual({ walletMaxWei: 400_000_000_000_000n, fleetMaxWei: 2_000_000_000_000_000n, runEnvelopeMaxWei: 4_100_000_000_000_000n, runEnvelopeFleetMaxWei: 8_500_000_000_000_000n });
    }
  });

  it('fails closed for a chain with no ceiling', () => {
    expect(planRunFunding({ chainId: 10, ceiling: DEFAULT_IDLE_BALANCE_CEILINGS[10], wallets: [wallet(1, 100_000_000_000_000n)] }).blockers).toEqual(['NO_BALANCE_CEILING_FOR_CHAIN']);
  });

  it('funds one paid mint (0.0037 price + 0.00037 fee allowance) and two paid wallets, but not a wallet above 0.0041 or a fleet above 0.0085', () => {
    const ceiling = DEFAULT_IDLE_BALANCE_CEILINGS[1];
    const paid = 4_070_000_000_000_000n;
    const one = planRunFunding({ chainId: 1, ceiling, wallets: [wallet(1, paid)] });
    expect(one.blockers).toEqual([]);
    expect(BigInt(one.items[0]?.envelopeWei ?? '0')).toBeLessThanOrEqual(4_100_000_000_000_000n);
    expect(planRunFunding({ chainId: 1, ceiling, wallets: [wallet(1, paid), wallet(2, paid)] }).blockers).toEqual([]);
    expect(planRunFunding({ chainId: 1, ceiling, wallets: [wallet(1, 4_100_000_000_000_001n)] }).blockers).toEqual([`RUN_ENVELOPE_ABOVE_CHAIN_BOUND:${'0x' + '1'.repeat(40)}`]);
    expect(planRunFunding({ chainId: 1, ceiling, wallets: [wallet(1, paid), wallet(2, paid), wallet(3, paid)] }).blockers).toEqual(['RUN_ENVELOPE_ABOVE_FLEET_BOUND']);
  });

  it('funds the proven six-wallet free Ethereum run (0.0004 reserved per wallet, 0.0024 for the fleet) that the idle fleet limit alone would block', () => {
    const six = Array.from({ length: 6 }, (_, index) => wallet(index + 1, 400_000_000_000_000n));
    expect(planRunFunding({ chainId: 1, ceiling: DEFAULT_IDLE_BALANCE_CEILINGS[1], wallets: six }).blockers).toEqual([]);
    expect(planRunFunding({ chainId: 1, ceiling: { walletMaxWei: 400_000_000_000_000n, fleetMaxWei: 2_000_000_000_000_000n }, wallets: six }).blockers).toEqual(['RUN_ENVELOPE_ABOVE_FLEET_BOUND']);
  });

  it('are balance fields only: the ceiling carries no spend limit, so funding can never raise a cap', () => {
    for (const ceiling of Object.values(DEFAULT_IDLE_BALANCE_CEILINGS)) {
      expect(Object.keys(ceiling).sort()).toEqual(['fleetMaxWei', 'runEnvelopeFleetMaxWei', 'runEnvelopeMaxWei', 'walletMaxWei']);
    }
  });
});

describe('D-060 exact boundaries', () => {
  const wallet = (index: number, requiredWei: bigint) => ({ address: `0x${String(index).repeat(40)}`, balanceWei: 0n, requiredWei });
  it('a wallet needing exactly 0.0041 is allowed and one wei more is refused', () => {
    const ceiling = DEFAULT_IDLE_BALANCE_CEILINGS[1];
    expect(planRunFunding({ chainId: 1, ceiling, wallets: [wallet(1, 4_100_000_000_000_000n)] }).blockers).toEqual([]);
    expect(planRunFunding({ chainId: 1, ceiling, wallets: [wallet(1, 4_100_000_000_000_001n)] }).blockers).toEqual([`RUN_ENVELOPE_ABOVE_CHAIN_BOUND:${'0x' + '1'.repeat(40)}`]);
  });
  it('a fleet whose envelopes add up to exactly 0.0085 is allowed and one wei more is refused', () => {
    // envelopes: 4.1e15 (the wallet bound) + (required + 1e12 rounding margin) + 0.4e15 (a small run still gets the idle ceiling)
    const ceiling = DEFAULT_IDLE_BALANCE_CEILINGS[8453];
    const small = wallet(3, 300_000_000_000_000n);
    expect(planRunFunding({ chainId: 8453, ceiling, wallets: [wallet(1, 4_100_000_000_000_000n), wallet(2, 3_999_000_000_000_000n), small] }).blockers).toEqual([]);
    expect(planRunFunding({ chainId: 8453, ceiling, wallets: [wallet(1, 4_100_000_000_000_000n), wallet(2, 3_999_000_000_000_001n), small] }).blockers).toEqual(['RUN_ENVELOPE_ABOVE_FLEET_BOUND']);
  });
});
