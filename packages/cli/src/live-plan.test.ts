import { describe, expect, it } from 'vitest';
import type { DropCheckReport, DropCheckWallet } from './drop-check.js';
import { BackendApplication, DurableStore, ExecutionCoordinator, PERSONAL_LIVE_FLEET_POLICY } from '@mint-bot/backend';
import { assertLivePrepareAllowed, buildLivePlan, liveConfirmationPhrase, liveFreeCampaignFields } from './live-plan.js';

const CONTRACT = '0x21d90c1ea94b7f8b0bea50df540bac9f04ada760';
const row = (index: number, verdict: DropCheckWallet['verdict'], extra: Partial<DropCheckWallet> = {}): DropCheckWallet => ({ wallet: `0x${String(index).repeat(40)}`, balanceEth: '0.0006', requiredEth: '0.0004', topUpEth: null, simulation: verdict === 'ready' ? 'passed' : 'not run', verdict, note: '', ...extra }) as DropCheckWallet;
const report = (wallets: DropCheckWallet[], overrides: Partial<DropCheckReport> = {}): DropCheckReport => ({ contract: CONTRACT, verdict: 'ok', summary: 'ok', drop: { priceEth: '0', opensAt: null, closesAt: null, maxPerWallet: 5, status: 'open' }, quantity: 3, wallets, ...overrides });
const context = { killSwitchPresent: true, custody: 'local' as const };

describe('Personal Live plan (read-only)', () => {
  it('is ready only when the drop is free and open, every wallet passed the test mint, and the exposure fits the daily budget', () => {
    const plan = buildLivePlan(report([row(1, 'ready'), row(2, 'ready'), row(3, 'ready')]), context);
    expect(plan).toMatchObject({ verdict: 'ready', blockers: [], quantity: 3, perWalletMaxCostEth: '0.0004', totalMaxExposureEth: '0.0012', dailyBudgetEth: '0.0024', withinDailyBudget: true });
    expect(plan.walletsReady).toHaveLength(3);
    expect(plan.summary).toContain('Nothing has been sent');
    expect(plan.nextSteps.join(' ')).toContain('live-prepare');
    expect(plan.warnings.join(' ')).toContain('local encrypted keystore');
  });

  it('plans while the kill switch is on and warns when it is off', () => {
    const engaged = buildLivePlan(report([row(1, 'ready')]), context);
    expect(engaged.verdict).toBe('ready');
    expect(engaged.warnings.join(' ')).toContain('required during preparation');
    const released = buildLivePlan(report([row(1, 'ready')]), { ...context, killSwitchPresent: false });
    expect(released.verdict).toBe('ready');
    expect(released.warnings.join(' ')).toContain('Engage it before recording');
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

  it('uses the Base policy and owner enablement procedure without permanently forcing first-proof quantity', () => {
    const plan = buildLivePlan(report([row(1, 'ready')], { quantity: 4 }), { ...context, chainId: 8453 });
    expect(plan).toMatchObject({ verdict: 'ready', quantity: 4, dailyBudgetEth: '0.0012' });
    expect(plan.nextSteps.join(' ')).toContain('base-enable status');
    expect(plan.nextSteps.join(' ')).toContain('--chain base');
    expect(liveFreeCampaignFields({ quantity: 4, wallets: 1, tipWei: 100_000_000n, chainId: 8453 }).quantity).toBe(4);
  });
});

describe('typed confirmation', () => {
  it('names the contract and the most that can be spent, so a stale or copied phrase does not match', () => {
    expect(liveConfirmationPhrase(CONTRACT, 3, '0.0012')).toBe('PREPARE-LIVE 04ada760 QTY-3 0.0012');
    expect(liveConfirmationPhrase(CONTRACT, 3, '0.0012')).not.toBe(liveConfirmationPhrase(CONTRACT, 4, '0.0012'));
    expect(liveConfirmationPhrase(CONTRACT, 3, '0.0012')).not.toBe(liveConfirmationPhrase(CONTRACT, 3, '0.0016'));
    expect(liveConfirmationPhrase(CONTRACT, 3, '0.0012')).not.toBe(liveConfirmationPhrase('0x1111111111111111111111111111111111111111', 3, '0.0012'));
  });
});

describe('every gate on recording a live campaign (live-prepare)', () => {
  const wallets = [row(1, 'ready'), row(2, 'ready'), row(3, 'ready')];
  const plan = buildLivePlan(report(wallets), context);
  const phrase = liveConfirmationPhrase(CONTRACT, plan.quantity, plan.totalMaxExposureEth);
  const good = { plan, contract: CONTRACT, confirm: phrase, priorityFeeGwei: 0.1, walletFileAddresses: wallets.map((item) => item.wallet), killSwitchPresent: true };

  it('passes only with the exact phrase, a ready plan, a sane tip and a wallet file holding exactly the ready wallets', () => {
    expect(assertLivePrepareAllowed(good)).toEqual(wallets.map((item) => item.wallet).sort());
    expect(assertLivePrepareAllowed({ ...good, walletFileAddresses: [...good.walletFileAddresses].reverse().map((address) => address.toUpperCase().replace('0X', '0x')) })).toHaveLength(3);
  });

  it('refuses a wrong, empty, stale or other-contract phrase', () => {
    for (const confirm of ['', 'yes', phrase.toUpperCase(), `${phrase} `, liveConfirmationPhrase(CONTRACT, plan.quantity + 1, plan.totalMaxExposureEth), liveConfirmationPhrase(CONTRACT, plan.quantity, '0.0016'), liveConfirmationPhrase('0x1111111111111111111111111111111111111111', plan.quantity, plan.totalMaxExposureEth)]) {
      expect(() => assertLivePrepareAllowed({ ...good, confirm })).toThrow('CONFIRMATION_PHRASE_MISMATCH');
    }
  });

  it('refuses a plan that is not ready, before looking at the phrase', () => {
    const notReady = buildLivePlan(report([row(1, 'ready'), row(2, 'needs ETH', { topUpEth: '0.0001' })], { verdict: 'unknown' }), context);
    expect(() => assertLivePrepareAllowed({ ...good, plan: notReady })).toThrow('LIVE_PLAN_NOT_READY');
  });

  it('refuses to record the campaign after the kill switch has already been released', () => {
    expect(() => assertLivePrepareAllowed({ ...good, killSwitchPresent: false })).toThrow('KILL_SWITCH_REQUIRED_FOR_PREPARATION');
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


describe('live free campaign numbers (D-042)', () => {
  const ALLOWANCE = PERSONAL_LIVE_FLEET_POLICY.freeFeeAllowanceWei;
  const engine = { prepare: async () => ({ executionIds: [], attempts: [], receipts: [], state: 'Prepared' as const }), execute: async () => ({ executionIds: [], attempts: [], receipts: [], state: 'Confirmed' as const }), reconcile: async () => ({ result: 'unknown' as const, attempts: [], receipts: [] }) };

  it('are accepted by the real campaign-creation rules, which is what the first version of live-prepare missed', async () => {
    const store = new DurableStore();
    await store.open();
    const app = new BackendApplication(store, new ExecutionCoordinator(store, engine as never), { fleetPolicy: PERSONAL_LIVE_FLEET_POLICY });
    const fields = liveFreeCampaignFields({ quantity: 3, wallets: 3, tipWei: 100_000_000n });
    expect(fields).toMatchObject({ maxRunWei: 3n * ALLOWANCE, dailyCapWei: ALLOWANCE, gasCeilingWei: ALLOWANCE, mintPriceWei: 0n });
    const campaign = await app.createCampaign({ chainId: 1, contract: CONTRACT, strategy: 'seadrop-v1-public', quantity: fields.quantity, dryRun: false, maxRunWei: fields.maxRunWei, dailyCapWei: fields.dailyCapWei, gasCeilingWei: fields.gasCeilingWei, broadcastMode: 'public', chainVerification: { chainId: 1, status: 'verified', seaDropCompatible: true, endpointReference: 'ETHEREUM_RPC_REFERENCE' }, mintPriceWei: fields.mintPriceWei, feePolicy: fields.feePolicy });
    expect(campaign.feePolicy.totalFeeBudgetWei).toBe(ALLOWANCE);
    expect(campaign.feePolicy.configuredPriorityFeeWei).toBe(100_000_000n);
  });

  it('refuse a bad tip, too many wallets for the daily budget, and a zero quantity or wallet count', () => {
    expect(() => liveFreeCampaignFields({ quantity: 1, wallets: 1, tipWei: 0n })).toThrow('LIVE_TIP_OUT_OF_RANGE');
    expect(() => liveFreeCampaignFields({ quantity: 1, wallets: 1, tipWei: 2_000_000_001n })).toThrow('LIVE_TIP_OUT_OF_RANGE');
    expect(() => liveFreeCampaignFields({ quantity: 1, wallets: 7, tipWei: 1n })).toThrow('LIVE_WALLET_COUNT_EXCEEDS_DAILY_BUDGET');
    expect(() => liveFreeCampaignFields({ quantity: 1, wallets: 0, tipWei: 1n })).toThrow('LIVE_WALLET_COUNT_EXCEEDS_DAILY_BUDGET');
    expect(() => liveFreeCampaignFields({ quantity: 0, wallets: 1, tipWei: 1n })).toThrow('LIVE_QUANTITY_INVALID');
  });
});

describe('live quantity-limit command wiring (D-055)', () => {
  it('passes the same owner ceiling through both live-plan and live-prepare', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
    const planStart = source.indexOf(".command('live-plan'");
    const prepareStart = source.indexOf(".command('live-prepare'", planStart);
    const nextStart = source.indexOf(".command('survey-seadrop'", prepareStart);
    const planBody = source.slice(planStart, prepareStart);
    const prepareBody = source.slice(prepareStart, nextStart);
    for (const body of [planBody, prepareBody]) {
      expect(body).toContain(".option('quantity-limit'");
      expect(body).toContain('{ maxQuantity: args.quantityLimit }');
    }
  });
});

describe('Personal Live wallet-file wiring', () => {
  it('passes the validated configured wallet file into both execution commands', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
    const runStart = source.indexOf(".command('run'");
    const liveRunStart = source.indexOf(".command('live-run'", runStart);
    const executeStart = source.indexOf(".command('execute'", liveRunStart);
    for (const body of [source.slice(runStart, liveRunStart), source.slice(liveRunStart, executeStart)]) {
      expect(body).toContain('const file = walletFile(args.walletFile)');
      expect(body).toContain('walletFile: file');
      expect(body).toContain('publicWallets(file)');
    }
  });
});
