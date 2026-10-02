import { PERSONAL_LIVE_FLEET_POLICY, formatEth } from '@mint-bot/backend';
import { parseEther } from 'viem';
import type { DropCheckReport } from './drop-check.js';

/**
 * Personal Live planning (Phase 3, D-028, D-033, D-037). `buildLivePlan` is read-only: it turns a drop check into
 * a plain verdict, the exact money at risk, what blocks going live, and the next commands. `liveFreeCampaignInput`
 * only builds the numbers for a campaign record; it spends nothing and the guards (admission, caps, reservations,
 * kill switch, simulation) are untouched and still decide at run time.
 */
export interface LivePlanContext {
  /** Is the kill-switch file present? Present means live runs are refused. null when it could not be checked. */
  killSwitchPresent: boolean | null;
  custody: 'local' | 'turnkey';
}

export interface LivePlan {
  contract: string;
  verdict: 'ready' | 'not_ready';
  summary: string;
  blockers: string[];
  warnings: string[];
  quantity: number;
  quantityNote: string | null;
  walletsReady: string[];
  walletsNeedingEth: Array<{ wallet: string; topUpEth: string }>;
  /** Most one wallet can lose: mint value plus the fee allowance. */
  perWalletMaxCostEth: string | null;
  totalMaxExposureEth: string;
  dailyBudgetEth: string;
  withinDailyBudget: boolean | null;
  nextSteps: string[];
}

const toWei = (eth: string): bigint => parseEther(eth);

export function buildLivePlan(report: DropCheckReport, context: LivePlanContext): LivePlan {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const free = report.drop !== null && toWei(report.drop.priceEth) === 0n;
  if (report.drop === null || report.wallets.length === 0) blockers.push(report.summary);
  else {
    if (!free) blockers.push('This drop is paid. The first live mint is limited to free drops, so preparing a paid one is not built yet.');
    if (report.drop.status !== 'open') blockers.push(`The mint is ${report.drop.status}; a live run only makes sense while it is open.`);
  }
  if (report.verdict === 'blocked' && blockers.length === 0) blockers.push(report.summary);
  if (context.killSwitchPresent === true) blockers.push('The kill switch is on, which refuses every live run. Remove it deliberately only when you are ready to mint.');
  if (context.killSwitchPresent === null) warnings.push('The kill-switch file could not be checked.');
  warnings.push('Known limit (T-024 finding 1): the engine itself refuses a free mint whose padded gas cost is above 0.0002 ETH per wallet, or above 0.002 ETH across the run, which is lower than the approved 0.0004 / 0.0024 ETH policy. At today\'s fees a run can be refused at the last step. The owner decision on this is open.');
  if (context.custody === 'local') warnings.push('Wallets are signed from the local encrypted keystore (accepted for Personal Live, D-028).');

  const walletsReady = report.wallets.filter((row) => row.verdict === 'ready').map((row) => row.wallet);
  const needing = report.wallets.flatMap((row) => row.verdict === 'needs ETH' && row.topUpEth ? [{ wallet: row.wallet, topUpEth: row.topUpEth }] : []);
  const failed = report.wallets.filter((row) => row.verdict === 'blocked').map((row) => row.wallet);
  if (failed.length > 0) blockers.push(`${failed.length} wallet(s) failed the test mint call and must not mint: ${failed.join(', ')}.`);
  if (needing.length > 0) blockers.push(`${needing.length} wallet(s) need ETH first: ${needing.map((item) => `${item.wallet} needs ${item.topUpEth} ETH`).join('; ')}.`);
  const unknown = report.wallets.filter((row) => row.verdict === 'unknown' || row.verdict === 'funded').length;
  if (unknown > 0) blockers.push(`${unknown} wallet(s) have not passed a test mint call yet. Run the simulate command while the mint is open.`);
  if (walletsReady.length === 0 && blockers.length === 0) blockers.push('No wallet is ready.');

  const perWalletWei = report.wallets.length > 0 && report.wallets[0]!.requiredEth ? toWei(report.wallets[0]!.requiredEth) : null;
  const totalWei = perWalletWei === null ? 0n : perWalletWei * BigInt(walletsReady.length);
  const dailyBudgetWei = free ? PERSONAL_LIVE_FLEET_POLICY.freeDailyCapWei : PERSONAL_LIVE_FLEET_POLICY.paidDailyCapWei;
  const within = perWalletWei === null ? null : totalWei <= dailyBudgetWei;
  if (within === false) blockers.push(`The most these wallets could spend (${formatEth(totalWei)} ETH) is above today's ${free ? 'free' : 'paid'} budget of ${formatEth(dailyBudgetWei)} ETH. Use fewer wallets.`);

  const ready = blockers.length === 0;
  const total = formatEth(totalWei);
  const summary = ready
    ? `Drop and wallets are ready: ${walletsReady.length} wallet(s) would each mint ${report.quantity} NFT(s) and could spend at most ${total} ETH in total (budget ${formatEth(dailyBudgetWei)} ETH). Going live itself is not available yet (open decisions, see nextSteps). Nothing has been sent.`
    : `Not ready: ${blockers.length} thing(s) to fix before a live mint. Nothing has been sent.`;
  const nextSteps = ready
    ? [
        'The drop and the wallets are ready. Recording and running a live campaign is NOT available yet: it waits for open owner decisions (the live fee model and the engine free-mint caps, task T-024).',
        'Keep the wallets funded (see walletsNeedingEth when it is not empty) and run live-plan again before any live step.',
      ]
    : ['Fix the items under blockers, then run live-plan again.'];
  return {
    contract: report.contract,
    verdict: ready ? 'ready' : 'not_ready',
    summary,
    blockers,
    warnings,
    quantity: report.quantity,
    quantityNote: report.quantityPlan?.reduced ? report.quantityPlan.message : null,
    walletsReady,
    walletsNeedingEth: needing,
    perWalletMaxCostEth: perWalletWei === null ? null : formatEth(perWalletWei),
    totalMaxExposureEth: total,
    dailyBudgetEth: formatEth(dailyBudgetWei),
    withinDailyBudget: within,
    nextSteps,
  };
}

/** The phrase the owner must type to record a live campaign. It names the contract and the most that can be spent. */
export function liveConfirmationPhrase(contract: string, totalMaxExposureEth: string): string {
  return `PREPARE-LIVE ${contract.slice(-8).toLowerCase()} ${totalMaxExposureEth}`;
}

/**
 * Every gate for recording a live campaign, in one place so each refusal can be tested. Throws a plain error
 * when anything is off; returns the ready wallets (lower case) that the campaign will use.
 */
export function assertLivePrepareAllowed(args: { plan: LivePlan; contract: string; confirm: string; priorityFeeGwei: number; walletFileAddresses: readonly string[] }): string[] {
  const { plan, contract, confirm, priorityFeeGwei, walletFileAddresses } = args;
  if (!Number.isFinite(priorityFeeGwei) || !(priorityFeeGwei > 0 && priorityFeeGwei <= 2)) throw new Error('PRIORITY_FEE_GWEI_OUT_OF_RANGE: use more than 0 and at most 2');
  if (plan.verdict !== 'ready') throw new Error(`LIVE_PLAN_NOT_READY: ${plan.blockers[0] ?? 'see live-plan'}`);
  if (typeof confirm !== 'string' || confirm !== liveConfirmationPhrase(contract, plan.totalMaxExposureEth)) throw new Error('CONFIRMATION_PHRASE_MISMATCH: run live-plan again and copy the phrase it prints exactly');
  // Approve, arm and run take their wallets from the wallet file, not from this campaign record, so the file must
  // hold exactly the wallets that passed the test mint. Anything else could let an untested wallet mint.
  const ready = plan.walletsReady.map((wallet) => wallet.toLowerCase()).sort();
  const file = walletFileAddresses.map((wallet) => wallet.toLowerCase()).sort();
  if (ready.length === 0 || ready.length !== file.length || ready.some((wallet, index) => wallet !== file[index])) {
    throw new Error('WALLET_FILE_DOES_NOT_MATCH_READY_WALLETS: the wallet file must hold exactly the wallets that passed the test mint; make it match, then run live-plan again');
  }
  return ready;
}
