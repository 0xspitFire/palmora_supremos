import { formatEth, type BackendState } from '@mint-bot/backend';

/**
 * Guided live run (T-024 stage 2). `previewLiveRun` turns an armed run into plain words and the exact money at stake;
 * `assertLiveRunAllowed` is the second typed confirmation before anything is sent; `describeLiveRunResult` explains
 * afterwards, in plain language, what happened, what it cost, and why fewer NFTs were minted when that applies (D-037).
 * None of this changes a guard: `run` still applies admission, caps, reservations, the kill switch and simulation.
 */
export interface LiveRunPreview {
  runId: string;
  campaignId: string;
  contract: string;
  wallets: string[];
  quantityPerWallet: number;
  /** The most that can be spent: the sum of what was reserved at arming. */
  maxExposureWei: string;
  maxExposureEth: string;
  /** The fee per gas the plan was made at, or null when no plan was recorded. */
  planningMaxFeeGwei: string | null;
  quantityNote: string | null;
  phrase: string;
}

type RunState = Pick<BackendState, 'runs' | 'campaigns' | 'intents' | 'reservations' | 'events' | 'receipts' | 'attempts'>;

/** The phrase names the run and the most that can be spent, so a stale or copied phrase does not match. */
export function liveRunPhrase(runId: string, maxExposureEth: string): string {
  return `RUN-LIVE ${runId.slice(-8)} ${maxExposureEth}`;
}

/** The quantity explanation recorded for this campaign at preparation, or for this run once it has been copied across. */
export function quantityPlanForRun(events: BackendState['events'], runId: string, campaignId: string): { message?: string; reduced?: boolean; maxFeeGwei?: string; planned?: number; desired?: number } | null {
  const matching = events.filter((event) => event.type === 'quantity_plan' && (event.runId === runId || event.data.campaignId === campaignId));
  const latest = matching.at(-1);
  return latest ? (latest.data as never) : null;
}

export function previewLiveRun(state: RunState, runId: string): LiveRunPreview {
  const run = state.runs.find((item) => item.id === runId);
  if (!run) throw new Error('RUN_NOT_FOUND');
  if (run.mode !== 'live') throw new Error('LIVE_RUN_REQUIRED: this run is a dry run');
  if (run.state !== 'Armed') throw new Error(`RUN_NOT_ARMED: this run is ${run.state}, not armed`);
  const campaign = state.campaigns.find((item) => item.id === run.campaignId);
  const intent = state.intents.find((item) => item.id === run.intentId);
  if (!campaign || !intent) throw new Error('RUN_RECORDS_INCOMPLETE');
  const reservations = state.reservations.filter((item) => item.runId === runId);
  if (reservations.length === 0 || reservations.length !== intent.wallets.length || reservations.some((item) => item.status !== 'reserved')) throw new Error('RESERVATIONS_NOT_READY: every wallet needs its own reservation in the reserved state');
  const total = reservations.reduce((sum, item) => sum + item.amountWei, 0n);
  const plan = quantityPlanForRun(state.events, runId, campaign.id);
  const maxExposureEth = formatEth(total);
  return {
    runId,
    campaignId: campaign.id,
    contract: campaign.contract,
    wallets: [...intent.wallets],
    quantityPerWallet: campaign.quantity,
    maxExposureWei: total.toString(),
    maxExposureEth,
    planningMaxFeeGwei: plan?.maxFeeGwei ?? null,
    quantityNote: plan?.reduced ? (plan.message ?? null) : null,
    phrase: liveRunPhrase(runId, maxExposureEth),
  };
}

/** The second confirmation. Throws a plain error; nothing is sent unless it returns. */
export function assertLiveRunAllowed(args: { preview: LiveRunPreview; confirm: string | undefined; maxFeeGwei: number | undefined }): void {
  const { preview, confirm, maxFeeGwei } = args;
  if (typeof maxFeeGwei !== 'number' || !Number.isFinite(maxFeeGwei) || maxFeeGwei <= 0 || maxFeeGwei > 500) throw new Error('MAX_FEE_GWEI_REQUIRED: pass --max-fee-gwei with the planning fee live-plan showed (more than 0, at most 500)');
  // The plan sized the quantity for a particular fee; signing with a higher one could exceed the fee allowance.
  if (preview.planningMaxFeeGwei === null) throw new Error('PLANNING_FEE_UNKNOWN: no quantity plan was recorded for this campaign, so there is no fee to check --max-fee-gwei against; run live-prepare again');
  if (maxFeeGwei > Number(preview.planningMaxFeeGwei)) throw new Error(`MAX_FEE_ABOVE_PLAN: the plan was made at ${preview.planningMaxFeeGwei} gwei; use that or lower`);
  if (typeof confirm !== 'string' || confirm !== preview.phrase) throw new Error('CONFIRMATION_PHRASE_MISMATCH: run live-run without --confirm and copy the phrase it prints exactly');
}

/** The wallet file must hold exactly the wallets this run was admitted for (T-024 finding 7). */
export function assertWalletFileMatchesRun(preview: Pick<LiveRunPreview, 'wallets'>, fileWallets: readonly string[]): void {
  const expected = new Set(preview.wallets.map((wallet) => wallet.toLowerCase()));
  const actual = new Set(fileWallets.map((wallet) => wallet.toLowerCase()));
  if (expected.size !== actual.size || [...expected].some((wallet) => !actual.has(wallet))) throw new Error('WALLET_FILE_DIFFERS_FROM_RUN: the wallet file does not hold exactly the wallets this run was admitted for');
}

export interface LiveRunReport {
  runId: string;
  runState: string;
  walletsMinted: number;
  walletsNotMinted: number;
  nftsMinted: number;
  spentWei: string;
  spentEth: string;
  reservedWei: string;
  settledReservations: number;
  releasedReservations: number;
  stillReserved: number;
  /** True when the receipts' actual spend equals what was settled in the ledger. */
  ledgerMatchesReceipts: boolean;
  quantityNote: string | null;
  summary: string;
}

export function describeLiveRunResult(state: RunState, runId: string): LiveRunReport {
  const run = state.runs.find((item) => item.id === runId);
  if (!run) throw new Error('RUN_NOT_FOUND');
  const campaign = state.campaigns.find((item) => item.id === run.campaignId);
  const reservations = state.reservations.filter((item) => item.runId === runId);
  const receipts = state.receipts.filter((item) => item.runId === runId);
  const confirmed = receipts.filter((item) => item.state === 'Confirmed');
  const spent = receipts.reduce((sum, item) => sum + (item.actualSpendWei ?? 0n), 0n);
  const settled = reservations.filter((item) => item.status === 'settled');
  const released = reservations.filter((item) => item.status === 'released');
  const stillReserved = reservations.filter((item) => item.status === 'reserved');
  const settledTotal = settled.reduce((sum, item) => sum + (item.actualAmountWei ?? 0n), 0n);
  const reserved = reservations.reduce((sum, item) => sum + item.amountWei, 0n);
  const quantity = campaign?.quantity ?? 0;
  const plan = quantityPlanForRun(state.events, runId, campaign?.id ?? '');
  const note = plan?.reduced ? (plan.message ?? null) : null;
  const wallets = reservations.length;
  const minted = confirmed.length;
  const matches = settledTotal === spent || (settled.length === 0 && spent === 0n);
  const parts = [
    `${minted} of ${wallets} wallet(s) minted ${quantity} NFT(s) each (${minted * quantity} in total); run is ${run.state}.`,
    `It cost ${formatEth(spent)} ETH in fees against ${formatEth(reserved)} ETH reserved.`,
    stillReserved.length > 0 ? `${stillReserved.length} reservation(s) are still open and settle once the chain confirms.` : `${settled.length} reservation(s) settled, ${released.length} released.`,
    matches ? 'The ledger matches the receipts.' : 'WARNING: the ledger does not match the receipts; run reconcile and check the summary command.',
    note ?? '',
  ].filter((part) => part !== '');
  return {
    runId,
    runState: run.state,
    walletsMinted: minted,
    walletsNotMinted: Math.max(0, wallets - minted),
    nftsMinted: minted * quantity,
    spentWei: spent.toString(),
    spentEth: formatEth(spent),
    reservedWei: reserved.toString(),
    settledReservations: settled.length,
    releasedReservations: released.length,
    stillReserved: stillReserved.length,
    ledgerMatchesReceipts: matches,
    quantityNote: note,
    summary: parts.join(' '),
  };
}
