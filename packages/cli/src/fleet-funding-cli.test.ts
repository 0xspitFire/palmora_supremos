import { describe, expect, it } from 'vitest';
import { DEFAULT_IDLE_BALANCE_CEILINGS } from '@mint-bot/backend';
import { fundingRequestEvent, planCampaignFunding, renderFundingPlan, requiredPerWallet } from './fleet-funding-cli.js';

const W1 = '0x1111111111111111111111111111111111111111';
const W2 = '0x2222222222222222222222222222222222222222';
const TREASURY = '0x6AAcC4d916541F99477b2f31EfFf7B08a372A8Df';
const campaign = (over: Record<string, unknown> = {}) => ({ chainId: 1 as const, mintPriceWei: 0n, quantity: 4, feePolicy: { totalFeeBudgetWei: 400_000_000_000_000n } as never, ...over });

describe('funding request for one run (D-059 item 5, option 1)', () => {
  it('a run that fits the idle limit needs no extra room, only the shortfall', () => {
    expect(requiredPerWallet(campaign())).toBe(400_000_000_000_000n);
    const plan = planCampaignFunding({ campaign: campaign(), balances: [{ address: W1, balanceWei: 100_000_000_000_000n }, { address: W2, balanceWei: 400_000_000_000_000n }], ceilings: DEFAULT_IDLE_BALANCE_CEILINGS });
    expect(plan.blockers).toEqual([]);
    expect(plan.items.map((item) => item.topUpWei)).toEqual(['300000000000000', '0']);
    const text = renderFundingPlan(plan, TREASURY);
    expect(text).toContain('send 0.0003 ETH');
    expect(text).toContain('nothing to send');
    expect(text).toContain('MintBot never sends funds');
  });

  it('a run above the idle limit is blocked in plain words until the owner decides a higher run limit (none is configured)', () => {
    const plan = planCampaignFunding({ campaign: campaign({ mintPriceWei: 3_700_000_000_000_000n, quantity: 1 }), balances: [{ address: W1, balanceWei: 0n }], ceilings: DEFAULT_IDLE_BALANCE_CEILINGS });
    expect(plan.blockers[0]).toContain('RUN_ENVELOPE_ABOVE_CHAIN_BOUND');
    const text = renderFundingPlan(plan, TREASURY);
    expect(text).toContain('cannot be funded as asked');
    expect(text).toContain('decide a higher run limit');
    expect(() => fundingRequestEvent(plan, 'c1', new Date())).toThrow('FUNDING_PLAN_BLOCKED');
  });

  it('surplus is never absorbed into the run, and an unknown chain or missing fee budget fails closed', () => {
    const plan = planCampaignFunding({ campaign: campaign({ quantity: 1, feePolicy: { totalFeeBudgetWei: 100_000_000_000_000n } }), balances: [{ address: W1, balanceWei: 700_000_000_000_000n }], ceilings: DEFAULT_IDLE_BALANCE_CEILINGS });
    expect(renderFundingPlan(plan, TREASURY)).toContain('Return the extra to your treasury wallet first');
    expect(planCampaignFunding({ campaign: campaign({ chainId: 137 as never }), balances: [{ address: W1, balanceWei: 0n }], ceilings: DEFAULT_IDLE_BALANCE_CEILINGS }).blockers).toEqual(['NO_BALANCE_CEILING_FOR_CHAIN']);
    expect(() => requiredPerWallet(campaign({ feePolicy: {} as never }))).toThrow('TOTAL_FEE_BUDGET_REQUIRED');
  });

  it('records a request only when there is something to send, carrying amounts and public addresses only', () => {
    const plan = planCampaignFunding({ campaign: campaign(), balances: [{ address: W1, balanceWei: 100_000_000_000_000n }, { address: W2, balanceWei: 400_000_000_000_000n }], ceilings: DEFAULT_IDLE_BALANCE_CEILINGS });
    const event = fundingRequestEvent(plan, 'camp1', new Date('2026-10-22T12:00:00.000Z'));
    expect(event.type).toBe('fleet_funding_requested');
    expect(event.data).toMatchObject({ campaignId: 'camp1', chainId: 1, items: [{ wallet: W1, topUpWei: '300000000000000' }] });
    expect(String(event.data.requestId)).toMatch(/^fund_/);
    const ready = planCampaignFunding({ campaign: campaign(), balances: [{ address: W1, balanceWei: 400_000_000_000_000n }], ceilings: DEFAULT_IDLE_BALANCE_CEILINGS });
    expect(ready.ready).toBe(true);
    expect(() => fundingRequestEvent(ready, 'camp1', new Date())).toThrow('FUNDING_NOT_NEEDED');
  });
});
