import { existsSync } from 'node:fs';
import { parseGwei } from 'viem';
import { MAX_FREE_TIP_WEI, PERSONAL_LIVE_FLEET_POLICY, ROBINHOOD_FREE_ACTIVE_PERIOD_CAP_WEI, ROBINHOOD_FREE_PER_WALLET_CAP_WEI, formatEth, recordWalletSimulations, type BackendState, type BackendStore, type Campaign, type CampaignInput } from '@mint-bot/backend';
import type { DryRunReport, DryRunWallet } from './robinhood-readonly.js';

/**
 * T-063 (D-065): planning, recording and simulating a live FREE Robinhood mint, the Robinhood counterpart of `live-plan`,
 * `live-prepare` and `record-simulation`. Everything here is read-only or records a campaign / test-mint result; nothing signs or
 * sends. The guards (admission, caps, reservations, kill switch, simulation, enablement, Turnkey policy) are untouched and still
 * decide at run time. The per-wallet fee allowance is the approved 0.0002 ETH of D-041, and a campaign never exceeds it.
 */
export const ROBINHOOD_DEFAULT_TIP_GWEI = 0.1;

export interface RobinhoodPlan {
  contract: string;
  verdict: 'ready' | 'not_ready';
  summary: string;
  blockers: string[];
  warnings: string[];
  quantity: number;
  /** Wallets the campaign is sized for: all that passed the test mint, or (before the mint opens) every candidate. */
  walletsReady: string[];
  walletsNotReady: Array<{ wallet: string; why: string }>;
  mintStatus: 'upcoming' | 'open' | 'ended' | null;
  opensAt: string | null;
  closesAt: string | null;
  perWalletMaxCostEth: string;
  totalMaxExposureEth: string;
  nextSteps: string[];
}

const walletReady = (wallet: DryRunWallet): { ok: boolean; why: string } => {
  if (wallet.simulation !== 'passed') return { ok: false, why: wallet.reason ?? 'the test mint failed' };
  if (wallet.hasEnoughForGas === false) return { ok: false, why: `it holds too little ETH on Robinhood (${wallet.balanceEth ?? '?'} ETH)` };
  if (wallet.withinPerWalletCap === false) return { ok: false, why: `its gas cost (${wallet.estimatedCostEth ?? '?'} ETH) is above the 0.0002 ETH per-wallet cap` };
  return { ok: true, why: '' };
};

/** The wallets that passed a test mint, can pay for the gas and stay inside the per-wallet cap. */
export function robinhoodReadyWallets(report: DryRunReport): string[] { return report.wallets.filter((wallet) => walletReady(wallet).ok).map((wallet) => wallet.wallet.toLowerCase()); }

/**
 * Turns a Robinhood dry run into a plain verdict, the money at risk and what blocks a live mint. `candidates` are the wallets the
 * dry run was asked about; before the mint opens nothing can be simulated, so every candidate counts and the test mints come later.
 */
export function buildRobinhoodPlan(report: DryRunReport, context: { candidates: readonly string[]; killSwitchPresent: boolean | null; quantity: number }): RobinhoodPlan {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const drop = report.drop;
  if (drop === null) blockers.push(report.summary);
  else {
    if (Number(drop.priceEth) > 0) blockers.push('This drop is paid. Paid Robinhood mints are blocked, so only free drops can be prepared.');
    if (drop.status === 'ended') blockers.push('This mint has ended.');
    if (context.quantity > drop.maxPerWallet && drop.maxPerWallet > 0) blockers.push(`The drop allows at most ${drop.maxPerWallet} per wallet; ${context.quantity} was asked for.`);
  }
  const open = drop?.status === 'open';
  const notReady: Array<{ wallet: string; why: string }> = [];
  let ready: string[];
  if (open) {
    ready = robinhoodReadyWallets(report);
    for (const wallet of report.wallets) { const check = walletReady(wallet); if (!check.ok) notReady.push({ wallet: wallet.wallet.toLowerCase(), why: check.why }); }
    if (drop && blockers.length === 0 && ready.length === 0) blockers.push(report.verdict === 'blocked' && report.wallets.length === 0 ? report.summary : 'No wallet is ready: each failed the test mint or lacks ETH on Robinhood.');
  } else {
    ready = drop && blockers.length === 0 ? context.candidates.map((wallet) => wallet.toLowerCase()) : [];
    if (drop?.status === 'upcoming' && blockers.length === 0) warnings.push(`The mint opens at ${drop.opensAt ?? 'an unknown time'}. The campaign can be recorded now; the test mints can only be recorded once it is open (they are good for 30 minutes).`);
  }
  if (report.supply?.soldOut) blockers.push(`This collection is sold out (${report.supply.totalSupply} of ${report.supply.maxSupply}).`);
  if (context.killSwitchPresent === true) warnings.push('The kill switch is engaged, as required while preparing. Release it only close to the mint.');
  if (context.killSwitchPresent === false) warnings.push('The kill switch is off. Engage it before recording a live campaign.');
  if (context.killSwitchPresent === null) warnings.push('The kill-switch file could not be checked.');
  warnings.push('The quantity must match your Turnkey policy exactly (it pins the mint call); the fee ceiling of a request must stay at or below the policy fee limit.');
  const totalWei = ROBINHOOD_FREE_PER_WALLET_CAP_WEI * BigInt(ready.length);
  const dailyBudgetWei = ROBINHOOD_FREE_ACTIVE_PERIOD_CAP_WEI < PERSONAL_LIVE_FLEET_POLICY.freeDailyCapWei ? ROBINHOOD_FREE_ACTIVE_PERIOD_CAP_WEI : PERSONAL_LIVE_FLEET_POLICY.freeDailyCapWei;
  if (ready.length > 0 && totalWei > dailyBudgetWei) blockers.push(`The most these wallets could spend (${formatEth(totalWei)} ETH) is above the Robinhood free budget of ${formatEth(dailyBudgetWei)} ETH. Use fewer wallets.`);
  const verdict = blockers.length === 0 ? 'ready' : 'not_ready';
  const summary = verdict === 'ready'
    ? `${open ? 'Drop and wallets are ready' : 'The drop is readable and free'}: up to ${ready.length} wallet(s) would each mint ${context.quantity} NFT(s) and could spend at most ${formatEth(totalWex(ready))} ETH in total. Nothing has been sent.`
    : `Not ready: ${blockers.length} thing(s) to fix before a live Robinhood mint. Nothing has been sent.`;
  return {
    contract: report.contract,
    verdict,
    summary,
    blockers,
    warnings,
    quantity: context.quantity,
    walletsReady: ready,
    walletsNotReady: notReady,
    mintStatus: drop?.status ?? null,
    opensAt: drop?.opensAt ?? null,
    closesAt: drop?.closesAt ?? null,
    perWalletMaxCostEth: formatEth(ROBINHOOD_FREE_PER_WALLET_CAP_WEI),
    totalMaxExposureEth: formatEth(totalWex(ready)),
    nextSteps: verdict === 'ready'
      ? ['1. Make sure the Robinhood enablement is recorded (robinhood-enable status).', '2. Record the campaign with the confirmation phrase this plan printed (nothing is spent).', '3. When the mint is open, record the test mints for the wallets (good for 30 minutes).', '4. Send the live request with a fee ceiling at or below your Turnkey policy limit.']
      : ['Fix the items under blockers, then plan again.'],
  };
}

function totalWex(ready: readonly string[]): bigint { return ROBINHOOD_FREE_PER_WALLET_CAP_WEI * BigInt(ready.length); }

/** The phrase the owner must repeat to record a live Robinhood campaign. It binds the contract, quantity, wallets count and the most at stake. */
export function robinhoodConfirmationPhrase(contract: string, quantity: number, walletCount: number, totalMaxExposureEth: string): string {
  return `PREPARE-LIVE-ROBINHOOD ${contract.slice(-8).toLowerCase()} QTY-${quantity} ${walletCount}-WALLETS ${totalMaxExposureEth}`;
}

export interface RobinhoodCampaignFields {
  quantity: number;
  maxRunWei: bigint;
  dailyCapWei: bigint;
  gasCeilingWei: bigint;
  mintPriceWei: bigint;
  feePolicy: { kind: 'free'; configuredPriorityFeeWei: bigint; freeTotalSpendCapWei: bigint; l2ExecutionGasBudgetWei: bigint; l1DataGasBudgetWei: bigint; totalFeeBudgetWei: bigint };
}

/**
 * Numbers for a FREE Robinhood campaign (D-041, D-065): the whole per-wallet fee budget is the approved 0.0002 ETH allowance and the
 * per-gas tip is separate and small. No mint value; the allowance is the only exposure. A wallet may mint once a day under it.
 */
export function robinhoodFreeCampaignFields(args: { quantity: number; wallets: number; tipWei: bigint }): RobinhoodCampaignFields {
  const allowance = ROBINHOOD_FREE_PER_WALLET_CAP_WEI;
  if (!Number.isSafeInteger(args.quantity) || args.quantity < 1) throw new Error('LIVE_QUANTITY_INVALID');
  if (!Number.isSafeInteger(args.wallets) || args.wallets < 1 || BigInt(args.wallets) * allowance > ROBINHOOD_FREE_ACTIVE_PERIOD_CAP_WEI || BigInt(args.wallets) * allowance > PERSONAL_LIVE_FLEET_POLICY.freeDailyCapWei) throw new Error('LIVE_WALLET_COUNT_EXCEEDS_DAILY_BUDGET');
  if (args.tipWei <= 0n || args.tipWei > MAX_FREE_TIP_WEI || args.tipWei >= allowance) throw new Error('LIVE_TIP_OUT_OF_RANGE');
  return {
    quantity: args.quantity,
    maxRunWei: BigInt(args.wallets) * allowance,
    dailyCapWei: allowance,
    gasCeilingWei: allowance,
    mintPriceWei: 0n,
    feePolicy: { kind: 'free', configuredPriorityFeeWei: args.tipWei, freeTotalSpendCapWei: allowance, l2ExecutionGasBudgetWei: allowance - args.tipWei, l1DataGasBudgetWei: 0n, totalFeeBudgetWei: allowance },
  };
}

/** The newest accepted, enabled, unexpired chain evidence for Robinhood (the owner's enablement), or undefined. */
export function currentRobinhoodEvidence(state: Pick<BackendState, 'chainEvidence'>, now: Date): BackendState['chainEvidence'][number] | undefined {
  return state.chainEvidence.filter((item) => item.chainId === 4663 && item.status === 'accepted' && item.executionEnabled && item.expiresAt > now.toISOString()).sort((left, right) => right.checkedAt.localeCompare(left.checkedAt)).at(0);
}

export interface RobinhoodPrepareStore { snapshot(): Pick<BackendState, 'chainEvidence'>; transaction: BackendStore['transaction'] }

/** `live-prepare --chain robinhood`: records a live FREE Robinhood campaign from a ready plan and the exact phrase. Spends nothing. */
export async function robinhoodPrepareAction(input: {
  contract: string; priorityFeeGwei: number; confirm: string; plan: RobinhoodPlan; killFile: string;
  store: RobinhoodPrepareStore; createCampaign(input: CampaignInput): Promise<Campaign>; now: Date;
}): Promise<{ campaign: Campaign; walletsSized: number; quantity: number; maxExposureEth: string }> {
  const { plan } = input;
  if (!Number.isFinite(input.priorityFeeGwei) || !(input.priorityFeeGwei > 0 && input.priorityFeeGwei <= 2)) throw new Error('PRIORITY_FEE_GWEI_OUT_OF_RANGE: use more than 0 and at most 2');
  if (plan.verdict !== 'ready') throw new Error(`LIVE_PLAN_NOT_READY: ${plan.blockers[0] ?? 'see the plan'}`);
  if (!existsSync(input.killFile)) throw new Error('KILL_SWITCH_REQUIRED_FOR_PREPARATION: engage the kill switch before recording a live campaign');
  if (input.confirm !== robinhoodConfirmationPhrase(input.contract, plan.quantity, plan.walletsReady.length, plan.totalMaxExposureEth)) throw new Error('CONFIRMATION_PHRASE_MISMATCH: plan again and copy the phrase it prints exactly');
  const evidence = currentRobinhoodEvidence(input.store.snapshot(), input.now);
  if (!evidence) throw new Error('ROBINHOOD_NOT_ENABLED: record the Robinhood enablement first (robinhood-enable status, then record)');
  const fields = robinhoodFreeCampaignFields({ quantity: plan.quantity, wallets: plan.walletsReady.length, tipWei: parseGwei(input.priorityFeeGwei.toString()) });
  const campaign = await input.createCampaign({
    chainId: 4663,
    contract: input.contract,
    strategy: 'seadrop-v1-public',
    quantity: fields.quantity,
    dryRun: false,
    maxRunWei: fields.maxRunWei,
    dailyCapWei: fields.dailyCapWei,
    gasCeilingWei: fields.gasCeilingWei,
    broadcastMode: 'sequencer',
    chainVerification: { chainId: 4663, status: 'verified', seaDropCompatible: true, evidenceId: evidence.id, checkedAt: evidence.checkedAt, sourceBlock: evidence.sourceBlock, endpointReference: evidence.endpointIdentity },
    mintPriceWei: fields.mintPriceWei,
    feePolicy: fields.feePolicy,
  });
  return { campaign, walletsSized: plan.walletsReady.length, quantity: fields.quantity, maxExposureEth: plan.totalMaxExposureEth };
}

/**
 * `record-simulation` for a Robinhood campaign: from a fresh dry run of the campaign's own quantity, records a passing test mint for
 * every wallet that passed and can pay for gas. Wallets that did not pass are returned with the reason and get no record.
 */
export async function recordRobinhoodSimulationsAction(input: {
  store: BackendStore; campaign: Campaign; report: DryRunReport; latestBlock(): Promise<{ number: bigint; hash: string }>;
}): Promise<{ ids: string[]; recorded: string[]; skipped: Array<{ wallet: string; why: string }> }> {
  const { campaign, report } = input;
  if (campaign.chainId !== 4663 || campaign.dryRun) throw new Error('LIVE_ROBINHOOD_CAMPAIGN_REQUIRED');
  if (!report.drop || report.drop.status !== 'open') throw new Error(`MINT_NOT_OPEN: ${report.drop ? `the mint is ${report.drop.status}` : report.summary}; test mints can only be recorded while it is open`);
  if (report.quantity !== campaign.quantity) throw new Error(`QUANTITY_MISMATCH: the drop allows ${report.drop.maxPerWallet} per wallet, so the test used ${report.quantity}, not the campaign's ${campaign.quantity}`);
  const ready = new Set(robinhoodReadyWallets(report));
  const skipped = report.wallets.filter((wallet) => !ready.has(wallet.wallet.toLowerCase())).map((wallet) => ({ wallet: wallet.wallet.toLowerCase(), why: walletReady(wallet).why }));
  if (ready.size === 0) throw new Error(`SIMULATION_NOT_PASSED: ${report.summary}`);
  const block = await input.latestBlock();
  const results = [...ready].map((wallet) => ({ wallet, success: true, ...(report.wallets.find((item) => item.wallet.toLowerCase() === wallet)?.estimatedGas ? { gasEstimate: BigInt(report.wallets.find((item) => item.wallet.toLowerCase() === wallet)!.estimatedGas!) } : {}) }));
  const ids = await recordWalletSimulations(input.store, campaign, results, { blockNumber: block.number, blockHash: block.hash });
  return { ids, recorded: [...ready], skipped };
}
