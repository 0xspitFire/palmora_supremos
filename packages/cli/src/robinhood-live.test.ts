import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BackendStore, Campaign, CampaignInput, ChainEvidenceRecord } from '@mint-bot/backend';
import { buildRobinhoodPlan, currentRobinhoodEvidence, recordRobinhoodSimulationsAction, robinhoodConfirmationPhrase, robinhoodFreeCampaignFields, robinhoodPrepareAction, robinhoodReadyWallets } from './robinhood-live.js';
import type { DryRunReport, DryRunWallet } from './robinhood-readonly.js';

/** T-063 (D-065): planning, recording and test-minting a live FREE Robinhood campaign. */
const CONTRACT = '0xa686fde3299d5451af22382240e0dff62f7b94db';
const A = '0x365952eb1e8209bf2bcc2db5ed213111a87d061e';
const B = '0x81c104dcb898416fd4f81ead091dba5b8f46f37a';
const C = '0x9d8c15fb93b8e2469b1d3d79b569acfdc0022b5b';
const ALLOWANCE = 200_000_000_000_000n;
const NOW = new Date('2026-10-24T12:00:00.000Z');

const wallet = (address: string, overrides: Partial<DryRunWallet> = {}): DryRunWallet => ({ wallet: address, simulation: 'passed', estimatedGas: '120000', estimatedCostEth: '0.0000024', withinPerWalletCap: true, balanceEth: '0.001', hasEnoughForGas: true, ...overrides });
const report = (overrides: Partial<DryRunReport> = {}, wallets: DryRunWallet[] = [wallet(A), wallet(B), wallet(C)]): DryRunReport => ({
  contract: CONTRACT, verdict: 'ok', summary: 'ok', quantity: 1, wallets,
  drop: { priceEth: '0', opensAt: '2026-10-24T11:15:06.000Z', closesAt: '2026-10-24T13:00:06.000Z', maxPerWallet: 5, status: 'open' },
  ...overrides,
});
const plan = (r: DryRunReport, options: { quantity?: number; kill?: boolean | null } = {}) => buildRobinhoodPlan(r, { candidates: [A, B, C], killSwitchPresent: options.kill === undefined ? true : options.kill, quantity: options.quantity ?? 1 });

describe('Robinhood plan', () => {
  it('is ready when the drop is open and free and wallets pass; it sizes the money at risk by the allowance', () => {
    const result = plan(report());
    expect(result).toMatchObject({ verdict: 'ready', quantity: 1, walletsReady: [A, B, C], totalMaxExposureEth: '0.0006', perWalletMaxCostEth: '0.0002', mintStatus: 'open' });
    expect(result.blockers).toEqual([]);
  });

  it('sizes the campaign only for wallets that can mint, and says why the others cannot', () => {
    const result = plan(report({}, [wallet(A), wallet(B, { simulation: 'failed', reason: 'The drop is not active' }), wallet(C, { hasEnoughForGas: false, balanceEth: '0' })]));
    expect(result.walletsReady).toEqual([A]);
    expect(result.walletsNotReady.map((item) => item.wallet)).toEqual([B, C]);
    expect(result.walletsNotReady[1]!.why).toContain('too little ETH');
    expect(result.totalMaxExposureEth).toBe('0.0002');
  });

  it('before the mint opens it can still be recorded, for every candidate, and says the test mints come later', () => {
    const result = plan(report({ verdict: 'blocked', wallets: [], drop: { priceEth: '0', opensAt: '2026-10-24T14:00:00.000Z', closesAt: null, maxPerWallet: 5, status: 'upcoming' } }));
    expect(result).toMatchObject({ verdict: 'ready', walletsReady: [A, B, C], mintStatus: 'upcoming' });
    expect(result.warnings.join(' ')).toContain('test mints can only be recorded once it is open');
  });

  it('is not ready for a paid, ended, sold-out, unreadable or over-quantity drop, or when no wallet can mint (fail closed)', () => {
    const open = report().drop!;
    expect(plan(report({ drop: { ...open, priceEth: '0.001' } })).blockers.join(' ')).toContain('paid');
    expect(plan(report({ drop: { ...open, status: 'ended' } })).blockers.join(' ')).toContain('ended');
    expect(plan(report({ supply: { totalSupply: '10', maxSupply: '10', soldOut: true } })).blockers.join(' ')).toContain('sold out');
    expect(plan(report({ drop: null, wallets: [], verdict: 'blocked', summary: 'No readable SeaDrop public drop here' })).blockers).toEqual(['No readable SeaDrop public drop here']);
    expect(plan(report({ drop: { ...open, maxPerWallet: 1 } }), { quantity: 2 }).blockers.join(' ')).toContain('at most 1 per wallet');
    expect(plan(report({}, [wallet(A, { simulation: 'failed', reason: 'x' })])).verdict).toBe('not_ready');
    expect(plan(report({}, [wallet(A, { withinPerWalletCap: false })])).verdict).toBe('not_ready');
    expect(plan(report({}, [wallet(A, { withinPerWalletCap: false })])).walletsNotReady[0]!.why).toContain('above the 0.0002 ETH');
  });

  it('refuses more wallets than the Robinhood free budget allows', () => {
    const many = Array.from({ length: 11 }, (_, index) => `0x${(index + 1).toString(16).padStart(40, '0')}`);
    const result = buildRobinhoodPlan(report({}, many.map((address) => wallet(address))), { candidates: many, killSwitchPresent: true, quantity: 1 });
    expect(result.verdict).toBe('not_ready');
    expect(result.blockers.join(' ')).toContain('Use fewer wallets');
  });

  it('warns when the kill switch is off or cannot be checked', () => {
    expect(plan(report(), { kill: false }).warnings.join(' ')).toContain('Engage it before');
    expect(plan(report(), { kill: null }).warnings.join(' ')).toContain('could not be checked');
  });

  it('the confirmation phrase names the contract, quantity, wallet count and the most at stake', () => {
    expect(robinhoodConfirmationPhrase(CONTRACT, 1, 3, '0.0006')).toBe('PREPARE-LIVE-ROBINHOOD 2f7b94db QTY-1 3-WALLETS 0.0006');
    expect(robinhoodConfirmationPhrase(CONTRACT, 1, 3, '0.0006')).not.toBe(robinhoodConfirmationPhrase(CONTRACT, 2, 3, '0.0006'));
    expect(robinhoodConfirmationPhrase(CONTRACT, 1, 3, '0.0006')).not.toBe(robinhoodConfirmationPhrase(CONTRACT, 1, 2, '0.0004'));
  });
});

describe('Robinhood campaign numbers', () => {
  it('use the approved allowance as the whole per-wallet fee budget, with a separate small tip', () => {
    const fields = robinhoodFreeCampaignFields({ quantity: 1, wallets: 3, tipWei: 100_000_000n });
    expect(fields).toMatchObject({ quantity: 1, maxRunWei: ALLOWANCE * 3n, dailyCapWei: ALLOWANCE, gasCeilingWei: ALLOWANCE, mintPriceWei: 0n });
    expect(fields.feePolicy).toEqual({ kind: 'free', configuredPriorityFeeWei: 100_000_000n, freeTotalSpendCapWei: ALLOWANCE, l2ExecutionGasBudgetWei: ALLOWANCE - 100_000_000n, l1DataGasBudgetWei: 0n, totalFeeBudgetWei: ALLOWANCE });
  });

  it('refuse a bad quantity, too many wallets, and a tip that is zero, above 2 gwei or not below the allowance (fail closed)', () => {
    expect(() => robinhoodFreeCampaignFields({ quantity: 0, wallets: 1, tipWei: 100_000_000n })).toThrow('LIVE_QUANTITY_INVALID');
    expect(() => robinhoodFreeCampaignFields({ quantity: 1, wallets: 0, tipWei: 100_000_000n })).toThrow('LIVE_WALLET_COUNT_EXCEEDS_DAILY_BUDGET');
    expect(() => robinhoodFreeCampaignFields({ quantity: 1, wallets: 11, tipWei: 100_000_000n })).toThrow('LIVE_WALLET_COUNT_EXCEEDS_DAILY_BUDGET');
    for (const tipWei of [0n, 2_000_000_001n, ALLOWANCE]) expect(() => robinhoodFreeCampaignFields({ quantity: 1, wallets: 1, tipWei }), String(tipWei)).toThrow('LIVE_TIP_OUT_OF_RANGE');
  });
});

describe('recording a Robinhood campaign', () => {
  const evidence = (overrides: Partial<ChainEvidenceRecord> = {}): ChainEvidenceRecord => ({ id: 'verification_abc', chainId: 4663, status: 'accepted', executionEnabled: true, checkedAt: '2026-10-24T11:00:00.000Z', expiresAt: '9999-12-31T23:59:59.999Z', sourceBlock: 1n, sourceBlockHash: 'anchor', endpointIdentity: 'robinhood-sequencer', strategyVersion: 'seadrop-v1-public@1', seaDropCompatible: true, positiveLivePath: true, archiveForkPassed: true, reconciliationPassed: true, finalityPassed: true, negativeCases: {} as never, ...overrides } as ChainEvidenceRecord);

  const setup = async (options: { chainEvidence?: ChainEvidenceRecord[]; killFile?: boolean } = {}) => {
    const directory = await mkdtemp(join(tmpdir(), 'mintbot-rh-prepare-'));
    const killFile = join(directory, 'killswitch');
    if (options.killFile !== false) await writeFile(killFile, 'on\n');
    const created: CampaignInput[] = [];
    const store = { snapshot: () => ({ chainEvidence: options.chainEvidence ?? [evidence()] }), transaction: async () => undefined };
    const ready = plan(report());
    const phrase = robinhoodConfirmationPhrase(CONTRACT, ready.quantity, ready.walletsReady.length, ready.totalMaxExposureEth);
    const run = (overrides: Partial<Parameters<typeof robinhoodPrepareAction>[0]> = {}) => robinhoodPrepareAction({ contract: CONTRACT, priorityFeeGwei: 0.1, confirm: phrase, plan: ready, killFile, store: store as never, createCampaign: async (input) => { created.push(input); return { id: 'cmp_1', ...input } as unknown as Campaign; }, now: NOW, ...overrides });
    return { directory, created, run, phrase, ready };
  };

  it('creates a sequencer campaign from the owner\'s enablement evidence, sized for the ready wallets', async () => {
    const { directory, created, run } = await setup();
    try {
      const result = await run();
      expect(result).toMatchObject({ walletsSized: 3, quantity: 1, maxExposureEth: '0.0006' });
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({ chainId: 4663, contract: CONTRACT, dryRun: false, broadcastMode: 'sequencer', quantity: 1, maxRunWei: ALLOWANCE * 3n, dailyCapWei: ALLOWANCE, gasCeilingWei: ALLOWANCE, mintPriceWei: 0n, chainVerification: { chainId: 4663, status: 'verified', seaDropCompatible: true, evidenceId: 'verification_abc', checkedAt: '2026-10-24T11:00:00.000Z', sourceBlock: 1n, endpointReference: 'robinhood-sequencer' } });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('refuses without the exact phrase, a ready plan, the kill switch on, the owner\'s enablement, or a sane tip, and records nothing (fail closed)', async () => {
    const { directory, created, run, ready } = await setup();
    const notReady = plan(report({}, [wallet(A, { simulation: 'failed', reason: 'x' })]));
    const noEnablement = await setup({ chainEvidence: [] });
    const noKill = await setup({ killFile: false });
    try {
      await expect(run({ confirm: 'PREPARE-LIVE-ROBINHOOD nope' })).rejects.toThrow('CONFIRMATION_PHRASE_MISMATCH');
      await expect(run({ plan: { ...ready, quantity: 2 } })).rejects.toThrow('CONFIRMATION_PHRASE_MISMATCH');
      await expect(run({ plan: notReady })).rejects.toThrow('LIVE_PLAN_NOT_READY');
      await expect(noKill.run()).rejects.toThrow('KILL_SWITCH_REQUIRED_FOR_PREPARATION');
      await expect(noEnablement.run()).rejects.toThrow('ROBINHOOD_NOT_ENABLED');
      for (const priorityFeeGwei of [0, -1, 2.1, Number.NaN]) await expect(run({ priorityFeeGwei }), String(priorityFeeGwei)).rejects.toThrow('PRIORITY_FEE_GWEI_OUT_OF_RANGE');
      expect(created).toEqual([]);
      expect(noEnablement.created).toEqual([]);
      expect(noKill.created).toEqual([]);
    } finally { await Promise.all([directory, noEnablement.directory, noKill.directory].map((path) => rm(path, { recursive: true, force: true }))); }
  });

  it('uses only evidence that is accepted, enabled, unexpired and for Robinhood, newest first', () => {
    const state = (items: ChainEvidenceRecord[]) => ({ chainEvidence: items });
    expect(currentRobinhoodEvidence(state([evidence()]), NOW)?.id).toBe('verification_abc');
    expect(currentRobinhoodEvidence(state([evidence({ chainId: 1 })]), NOW)).toBeUndefined();
    expect(currentRobinhoodEvidence(state([evidence({ status: 'pending' })]), NOW)).toBeUndefined();
    expect(currentRobinhoodEvidence(state([evidence({ executionEnabled: false })]), NOW)).toBeUndefined();
    expect(currentRobinhoodEvidence(state([evidence({ expiresAt: '2026-10-24T11:59:59.000Z' })]), NOW)).toBeUndefined();
    expect(currentRobinhoodEvidence(state([evidence({ id: 'old', checkedAt: '2026-10-20T00:00:00.000Z' }), evidence({ id: 'new' })]), NOW)?.id).toBe('new');
  });
});

describe('recording Robinhood test mints', () => {
  const campaign = (overrides: Partial<Campaign> = {}) => ({ id: 'cmp_1', chainId: 4663, contract: CONTRACT, quantity: 1, dryRun: false, feePolicy: { kind: 'free', configuredPriorityFeeWei: 100_000_000n, totalFeeBudgetWei: ALLOWANCE }, strategy: 'seadrop-v1-public', mintPriceWei: 0n, ...overrides }) as unknown as Campaign;
  const memoryStore = () => {
    const simulations: Array<{ wallet: string; campaignId: string; success: boolean; sourceBlock: bigint; gasEstimate?: bigint; worstCaseFeeWei: bigint }> = [];
    const store = { transaction: async (mutate: (state: { simulations: unknown[] }) => void) => { mutate({ simulations: simulations as unknown[] }); }, snapshot: () => ({ simulations }) } as unknown as BackendStore;
    return { simulations, store };
  };
  const latestBlock = async () => ({ number: 1234n, hash: '0xabc' });

  it('records a passing test mint for each wallet that passed and can pay, and names the ones it skipped', async () => {
    const { simulations, store } = memoryStore();
    const result = await recordRobinhoodSimulationsAction({ store, campaign: campaign(), report: report({}, [wallet(A), wallet(B, { simulation: 'failed', reason: 'sold out' }), wallet(C, { hasEnoughForGas: false })]), latestBlock });
    expect(result.recorded).toEqual([A]);
    expect(result.skipped.map((item) => item.wallet)).toEqual([B, C]);
    expect(simulations).toEqual([expect.objectContaining({ wallet: A, campaignId: 'cmp_1', success: true, sourceBlock: 1234n, gasEstimate: 120000n, worstCaseFeeWei: ALLOWANCE })]);
    expect(robinhoodReadyWallets(report())).toEqual([A, B, C]);
  });

  it('records nothing unless the mint is open, the quantity matches the campaign and at least one wallet passed (fail closed)', async () => {
    const { simulations, store } = memoryStore();
    const open = report().drop!;
    await expect(recordRobinhoodSimulationsAction({ store, campaign: campaign(), report: report({ drop: { ...open, status: 'upcoming' } }), latestBlock })).rejects.toThrow('MINT_NOT_OPEN');
    await expect(recordRobinhoodSimulationsAction({ store, campaign: campaign(), report: report({ drop: null, verdict: 'blocked', summary: 'unreadable' }), latestBlock })).rejects.toThrow('MINT_NOT_OPEN');
    await expect(recordRobinhoodSimulationsAction({ store, campaign: campaign({ quantity: 3 }), report: report(), latestBlock })).rejects.toThrow('QUANTITY_MISMATCH');
    await expect(recordRobinhoodSimulationsAction({ store, campaign: campaign(), report: report({}, [wallet(A, { simulation: 'failed', reason: 'x' })]), latestBlock })).rejects.toThrow('SIMULATION_NOT_PASSED');
    await expect(recordRobinhoodSimulationsAction({ store, campaign: campaign({ chainId: 1 }), report: report(), latestBlock })).rejects.toThrow('LIVE_ROBINHOOD_CAMPAIGN_REQUIRED');
    await expect(recordRobinhoodSimulationsAction({ store, campaign: campaign({ dryRun: true }), report: report(), latestBlock })).rejects.toThrow('LIVE_ROBINHOOD_CAMPAIGN_REQUIRED');
    expect(simulations).toEqual([]);
  });
});
