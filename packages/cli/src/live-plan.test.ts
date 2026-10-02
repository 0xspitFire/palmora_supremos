import { describe, expect, it } from 'vitest';
import type { DropCheckReport, DropCheckWallet } from './drop-check.js';
import { assertLivePrepareAllowed, buildLivePlan, liveConfirmationPhrase } from './live-plan.js';

const CONTRACT = '0x21d90c1ea94b7f8b0bea50df540bac9f04ada760';
const row = (index: number, verdict: DropCheckWallet['verdict'], extra: Partial<DropCheckWallet> = {}): DropCheckWallet => ({ wallet: `0x${String(index).repeat(40)}`, balanceEth: '0.0006', requiredEth: '0.0004', topUpEth: null, simulation: verdict === 'ready' ? 'passed' : 'not run', verdict, note: '', ...extra }) as DropCheckWallet;
const report = (wallets: DropCheckWallet[], overrides: Partial<DropCheckReport> = {}): DropCheckReport => ({ contract: CONTRACT, verdict: 'ok', summary: 'ok', drop: { priceEth: '0', opensAt: null, closesAt: null, maxPerWallet: 5, status: 'open' }, quantity: 3, wallets, ...overrides });
const context = { killSwitchPresent: false, custody: 'local' as const };

describe('Personal Live plan (read-only)', () => {
  it('is ready only when the drop is free and open, every wallet passed the test mint, and the exposure fits the daily budget', () => {
    const plan = buildLivePlan(report([row(1, 'ready'), row(2, 'ready'), row(3, 'ready')]), context);
    expect(plan).toMatchObject({ verdict: 'ready', blockers: [], quantity: 3, perWalletMaxCostEth: '0.0004', totalMaxExposureEth: '0.0012', dailyBudgetEth: '0.0024', withinDailyBudget: true });
    expect(plan.walletsReady).toHaveLength(3);
    expect(plan.summary).toContain('Nothing has been sent');
    expect(plan.summary).toContain('not available yet');
    expect(plan.nextSteps.join(' ')).toContain('NOT available yet');
    expect(plan.warnings.join(' ')).toContain('local encrypted keystore');
  });

  it('refuses while the kill switch is on, and says how it is released', () => {
    const plan = buildLivePlan(report([row(1, 'ready')]), { ...context, killSwitchPresent: true });
    expect(plan.verdict).toBe('not_ready');
    expect(plan.blockers.join(' ')).toContain('kill switch is on');
  });

  it('refuses a paid drop, a drop that is not open, and a plan with no usable drop', () => {
    expect(buildLivePlan(report([row(1, 'ready', { requiredEth: '0.0041' })], { drop: { priceEth: '0.0037', opensAt: null, closesAt: null, maxPerWallet: 5, status: 'open' } }), context).blockers.join(' ')).toContain('paid');
    expect(buildLivePlan(report([row(1, 'ready')], { drop: { priceEth: '0', opensAt: null, closesAt: null, maxPerWallet: 5, status: 'upcoming' } }), context).blockers.join(' ')).toContain('upcoming');
    expect(buildLivePlan(report([], { drop: null, verdict: 'blocked', summary: 'There is no contract at this address.' }), context)).toMatchObject({ verdict: 'not_ready', blockers: ['There is no contract at this address.'] });
  });

  it('lists wallets that need ETH, wallets whose test mint failed, and wallets not simulated yet, each as a blocker', () => {
    const plan = buildLivePlan(report([row(1, 'ready'), row(2, 'needs ETH', { topUpEth: '0.0003' }), row(3, 'blocked'), row(4, 'funded')], { verdict: 'blocked' }), context);
    expect(plan.verdict).toBe('not_ready');
    expect(plan.walletsNeedingEth).toEqual([{ wallet: `0x${'2'.repeat(40)}`, topUpEth: '0.0003' }]);
    expect(plan.blockers.join(' ')).toMatch(/need ETH first: 0x2+ needs 0\.0003 ETH/);
    expect(plan.blockers.join(' ')).toMatch(/failed the test mint/);
    expect(plan.blockers.join(' ')).toMatch(/not passed a test mint/);
  });

  it('refuses when the most the wallets could spend is above the daily free budget', () => {
    const many = Array.from({ length: 7 }, (_, index) => row(index + 1, 'ready'));
    const plan = buildLivePlan(report(many), context);
    expect(plan.withinDailyBudget).toBe(false);
    expect(plan.blockers.join(' ')).toContain('above today');
  });

  it('carries the fee-reduced quantity explanation through (D-037)', () => {
    const plan = buildLivePlan(report([row(1, 'ready')], { quantityPlan: { desired: 5, planned: 3, reduced: true, reason: 'reduced_for_fees', maxFeeGwei: '1.1', message: 'Planned 3 of 5 NFTs per wallet because fees are high.' } }), context);
    expect(plan.quantityNote).toContain('Planned 3 of 5');
  });
});

describe('typed confirmation', () => {
  it('names the contract and the most that can be spent, so a stale or copied phrase does not match', () => {
    expect(liveConfirmationPhrase(CONTRACT, '0.0012')).toBe('PREPARE-LIVE 04ada760 0.0012');
    expect(liveConfirmationPhrase(CONTRACT, '0.0012')).not.toBe(liveConfirmationPhrase(CONTRACT, '0.0016'));
    expect(liveConfirmationPhrase(CONTRACT, '0.0012')).not.toBe(liveConfirmationPhrase('0x1111111111111111111111111111111111111111', '0.0012'));
  });
});

describe('every gate on recording a live campaign (live-prepare)', () => {
  const wallets = [row(1, 'ready'), row(2, 'ready'), row(3, 'ready')];
  const plan = buildLivePlan(report(wallets), context);
  const phrase = liveConfirmationPhrase(CONTRACT, plan.totalMaxExposureEth);
  const good = { plan, contract: CONTRACT, confirm: phrase, priorityFeeGwei: 0.1, walletFileAddresses: wallets.map((item) => item.wallet) };

  it('passes only with the exact phrase, a ready plan, a sane tip and a wallet file holding exactly the ready wallets', () => {
    expect(assertLivePrepareAllowed(good)).toEqual(wallets.map((item) => item.wallet).sort());
    expect(assertLivePrepareAllowed({ ...good, walletFileAddresses: [...good.walletFileAddresses].reverse().map((address) => address.toUpperCase().replace('0X', '0x')) })).toHaveLength(3);
  });

  it('refuses a wrong, empty, stale or other-contract phrase', () => {
    for (const confirm of ['', 'yes', phrase.toUpperCase(), `${phrase} `, liveConfirmationPhrase(CONTRACT, '0.0016'), liveConfirmationPhrase('0x1111111111111111111111111111111111111111', plan.totalMaxExposureEth)]) {
      expect(() => assertLivePrepareAllowed({ ...good, confirm })).toThrow('CONFIRMATION_PHRASE_MISMATCH');
    }
  });

  it('refuses a plan that is not ready, before looking at the phrase', () => {
    const notReady = buildLivePlan(report([row(1, 'ready'), row(2, 'needs ETH', { topUpEth: '0.0001' })], { verdict: 'unknown' }), context);
    expect(() => assertLivePrepareAllowed({ ...good, plan: notReady })).toThrow('LIVE_PLAN_NOT_READY');
  });

  it('refuses tips of zero, negative, above 2 gwei, NaN or infinite', () => {
    for (const priorityFeeGwei of [0, -1, 2.01, 100, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => assertLivePrepareAllowed({ ...good, priorityFeeGwei })).toThrow('PRIORITY_FEE_GWEI_OUT_OF_RANGE');
    }
  });

  it('refuses a wallet file that holds more, fewer or different wallets than the ready ones, so an untested wallet can never mint', () => {
    const extra = `0x${'9'.repeat(40)}`;
    for (const walletFileAddresses of [[...good.walletFileAddresses, extra], good.walletFileAddresses.slice(1), [...good.walletFileAddresses.slice(1), extra], []]) {
      expect(() => assertLivePrepareAllowed({ ...good, walletFileAddresses })).toThrow('WALLET_FILE_DOES_NOT_MATCH_READY_WALLETS');
    }
  });
});
