import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { formatEth, campaignInputDigest, type BackendStore, type Campaign, type IntelligenceChainPort } from '@mint-bot/backend';
import type { FireScheduleRepository, FireScheduleRecord } from '@mint-bot/database';
import { checkDrop } from './drop-check.js';
import { roundUpEth, shortEth } from './display.js';
import { requiredPerWallet } from './fleet-funding-cli.js';
import { assertScheduleWindow, parseWhen, runFire, type FireDeps, type FireResult, type MintState } from './fire.js';
import { previewLiveRequest, runLiveRequest, sizedWalletCount } from './live-request.js';
import { recordPassingSimulationsAction } from './owner-actions.js';
import { recordRobinhoodSimulationsAction } from './robinhood-live.js';
import type { DryRunReport } from './robinhood-readonly.js';

/**
 * T-067 (D-067): the parts `/fire` and `/schedule` share, built once per service. The Telegram actions use `preview`/`fireNow` and the
 * schedule store; the scheduler uses `mintState` and `fireSchedule`. Both end in `runFire`, so they cannot drift apart.
 */
export interface FireWiringDeps {
  mode: 'dry-run' | 'host';
  store: BackendStore;
  /** The service's own application: `approve` records the owner's approval exactly as `live-request create` does. */
  approve(validated: never): Promise<{ id: string }>;
  killSwitchPath: string;
  fireSchedules(): FireScheduleRepository;
  /** Unclaimed live requests (the same ones the request processor works through). */
  unclaimedRequests(): Array<{ campaignId: string; expiresAt: string }>;
  /** Requests the service has picked up (claimed as started), newest first, with when. */
  startedRequests(): Array<{ id: string; campaignId: string; claimedAt?: string }>;
  walletList(): Promise<string[]>;
  evmPort(chainId: 1 | 8453): Promise<IntelligenceChainPort>;
  evmLatestBlock(chainId: 1 | 8453): Promise<{ number: bigint; hash: string }>;
  robinhoodDryRun(contract: string, wallets: readonly string[], quantity: number | undefined, at: Date): Promise<DryRunReport>;
  /** A wallet's balance on a chain (used to check the funding a run needs before anything is tapped). */
  balanceOf(chainId: number, address: string): Promise<bigint>;
  robinhoodLatestBlock(): Promise<{ number: bigint; hash: string }>;
  /** Asks the request processor to look now. */
  kick(): void;
  now?: () => Date;
}

export interface FireWiring {
  fireDeps: FireDeps;
  mintState(campaign: Campaign): Promise<MintState>;
  /** The wallets the owner typed (`all` = the whole fleet), each once. */
  wallets(text: string): Promise<string[]>;
  /** Which wallets hold what one run needs (mint value plus the fee budget), and the exact top-up for the others. An unreadable balance counts as short. */
  fundingSplit(campaign: Campaign, wallets: readonly string[]): Promise<{ funded: string[]; short: Array<{ wallet: string; why: string }> }>;
  /** Text for a preview: what would be minted, from how many wallets, and the most that can be spent. */
  describe(campaign: Campaign, wallets: readonly string[], maxFeeGwei: number): string;
  fireNow(campaignId: string, wallets: readonly string[], maxFeeGwei: number): Promise<FireResult>;
  fireSchedule(schedule: FireScheduleRecord): Promise<FireResult>;
  schedulePhrase(campaign: Campaign, wallets: readonly string[], maxFeeGwei: number, from: Date, until: Date): string;
  parseWindow(from: string, until: string): { from: Date; until: Date };
  campaignDigest(campaign: Campaign): string;
  conflict(campaignId: string, ignoreScheduleId?: string): string | undefined;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const compact = (date: Date): string => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

export function createFireWiring(deps: FireWiringDeps): FireWiring {
  const now = deps.now ?? (() => new Date());
  const inFlight = new Set<string>();
  /** A read from a chain provider is given 20 seconds; after that the step fails by name and nothing is sent (so a slow provider never leaves a fire hanging). */
  const read = <T,>(work: () => Promise<T>): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('READ_TIMED_OUT: the chain provider did not answer in time; nothing was sent')), 20_000); timer.unref?.(); });
    return Promise.race([work(), timeout]).finally(() => clearTimeout(timer));
  };
  const findCampaign = (campaignId: string): Campaign | undefined => deps.store.snapshot().campaigns.find((item) => item.id === campaignId);

  /** Open schedules and waiting requests. The in-flight guard is separate: the pipeline itself holds it while it runs. */
  const persistentConflict = (campaignId: string, ignoreScheduleId?: string): string | undefined => {
    // A run that is armed or running for this campaign, by what the store says (not a timer): a request that stopped at arm leaves no run, so a retry is never held back for it.
    const running = deps.store.snapshot().runs.find((run) => run.campaignId === campaignId && (run.state === 'Armed' || run.state === 'Active'));
    if (running) return `a run for this campaign is still in progress (${running.id}); see /runs`;
    const schedule = deps.fireSchedules().open(campaignId).find((item) => item.id !== ignoreScheduleId);
    if (schedule) return `a scheduled mint (${schedule.id.slice(-6)}) is open for this campaign; cancel it first (send /cancel and tap it)`;
    const nowMs = now().getTime();
    if (deps.unclaimedRequests().some((request) => request.campaignId === campaignId && Date.parse(request.expiresAt) > nowMs)) return 'a live request for this campaign is waiting for the service; see /requests';
    // Picked up by the service but not armed yet: no run exists and it is no longer "waiting", so without this a second fire would pass. Held until the request reports a result, for at most 10 minutes (a crashed service never writes one).
    const resulted = new Set(deps.store.snapshot().events.filter((event) => event.type === 'live_request_result').map((event) => String(event.data['requestId'])));
    const arming = deps.startedRequests().find((request) => request.campaignId === campaignId && !resulted.has(request.id) && request.claimedAt !== undefined && Date.parse(request.claimedAt) + 600_000 > nowMs);
    if (arming) return `a live request for this campaign (${arming.id.slice(-6)}) is being started by the service; see /requests`;
    return undefined;
  };
  const conflict = (campaignId: string, ignoreScheduleId?: string): string | undefined => (inFlight.has(campaignId) ? 'this campaign is being fired right now' : persistentConflict(campaignId, ignoreScheduleId));

  const mintState = async (campaign: Campaign): Promise<MintState> => {
    try {
      if (campaign.chainId === 4663) {
        const wallet = (await deps.walletList())[0];
        if (!wallet) return 'unknown';
        const report = await read(() => deps.robinhoodDryRun(campaign.contract, [wallet], campaign.quantity, now()));
        return report.drop?.status ?? 'unknown';
      }
      if (campaign.chainId !== 1 && campaign.chainId !== 8453) return 'unknown';
      const report = await read(async () => checkDrop(await deps.evmPort(campaign.chainId as 1 | 8453), campaign.contract, [], { simulate: false, now: now() }));
      return report.drop?.status ?? 'unknown';
    } catch { return 'unknown'; }
  };

  const fundingSplit: FireWiring['fundingSplit'] = async (campaign, wallets) => {
    // The very function the arm check uses, so the two can never disagree (it throws TOTAL_FEE_BUDGET_REQUIRED without a fee budget).
    const required = requiredPerWallet(campaign);
    const funded: string[] = [];
    const short: Array<{ wallet: string; why: string }> = [];
    for (const wallet of wallets) {
      let balance: bigint | undefined;
      try { balance = await read(() => deps.balanceOf(campaign.chainId, wallet)); } catch { balance = undefined; }
      if (balance === undefined) short.push({ wallet, why: 'its balance could not be read' });
      else if (balance < required) short.push({ wallet, why: `it holds ${shortEth(balance)} ETH and a run needs at least ${formatEth(required)} ETH: send ${roundUpEth(required - balance)} ETH more first (see /funding)` });
      else funded.push(wallet);
    }
    return { funded, short };
  };

  const recordSimulations: FireDeps['recordSimulations'] = async (campaign, wallets) => {
    if (campaign.chainId === 4663) {
      const report = await read(() => deps.robinhoodDryRun(campaign.contract, wallets, campaign.quantity, now()));
      const result = await recordRobinhoodSimulationsAction({ store: deps.store, campaign, report, latestBlock: () => read(() => deps.robinhoodLatestBlock()) });
      return withFunding(campaign, result);
    }
    if (campaign.chainId !== 1 && campaign.chainId !== 8453) throw new Error('LIVE_SUPPORTED_CAMPAIGN_REQUIRED');
    const chainId = campaign.chainId;
    const result = await recordPassingSimulationsAction({ store: deps.store, campaign, wallets, port: await read(() => deps.evmPort(chainId)), latestBlock: () => read(() => deps.evmLatestBlock(chainId)) });
    return withFunding(campaign, result);
  };

  /** A wallet that passed its test mint but does not hold what a run needs is left out and told exactly what to send; if none is funded, nothing is requested. */
  // (The test mints are already recorded when this refuses; that is harmless, they only record that a wallet passed.)
  const withFunding = async (campaign: Campaign, result: { recorded: string[]; skipped: Array<{ wallet: string; why: string }> }): Promise<{ recorded: string[]; skipped: Array<{ wallet: string; why: string }> }> => {
    const split = await fundingSplit(campaign, result.recorded);
    if (split.funded.length === 0) throw new Error(`FUNDING_NOT_ARRIVED: no wallet holds what a run needs. ${split.short.map((item) => `${item.wallet.slice(0, 6)}…${item.wallet.slice(-4)}: ${item.why}.`).join(' ')}`);
    return { recorded: split.funded, skipped: [...result.skipped, ...split.short] };
  };

  const fireDeps: FireDeps = {
    now,
    killSwitchOn: () => existsSync(deps.killSwitchPath) || deps.store.snapshot().killed,
    campaign: findCampaign,
    conflict: persistentConflict,
    recordSimulations,
    createRequest: async (campaign, wallets, maxFeeGwei) => {
      // A campaign sized for N wallets covers at most N: the others that passed are left out and said so, never refused as an error.
      const sized = Math.max(1, sizedWalletCount(campaign));
      const used = wallets.slice(0, sized);
      const leftOut = wallets.slice(sized);
      const preview = previewLiveRequest(deps.store.snapshot(), campaign.id, used, maxFeeGwei, now());
      const result = await runLiveRequest({ action: 'create', campaignId: campaign.id, wallets: preview.wallets, maxFeeGwei, confirm: preview.phrase, now: now(), store: deps.store as never, approve: (validated) => deps.approve(validated as never) });
      return { requestId: String(result.requestId), wallets: preview.wallets, leftOut };
    },
    kick: deps.kick,
  };

  const run = async (input: { campaignId: string; wallets: readonly string[]; maxFeeGwei: number; scheduleId?: string }): Promise<FireResult> => {
    // Held for the whole pipeline, so a second tap or a scheduler pass cannot start the same campaign twice.
    if (inFlight.has(input.campaignId)) throw new Error('FIRE_CONFLICT: this campaign is being fired right now');
    inFlight.add(input.campaignId);
    try { return await runFire(fireDeps, input); } finally { inFlight.delete(input.campaignId); }
  };

  return {
    fireDeps,
    mintState,
    fundingSplit,
    async wallets(text) {
      const raw = text.toLowerCase() === 'all' ? await deps.walletList() : text.split(',').map((item) => item.trim()).filter(Boolean);
      const unique = [...new Set(raw.map((wallet) => wallet.toLowerCase()))];
      if (unique.length === 0 || unique.length !== raw.length || unique.some((wallet) => !ADDRESS.test(wallet))) throw new Error('WALLETS_INVALID: give each wallet address once, or all');
      return unique;
    },
    describe(campaign, wallets, maxFeeGwei) {
      const fee = campaign.feePolicy.totalFeeBudgetWei ?? 0n;
      // A campaign sized for N wallets spends for at most N, however many are listed.
      const used = Math.min(wallets.length, Math.max(1, sizedWalletCount(campaign)));
      const total = (campaign.mintPriceWei * BigInt(campaign.quantity) + fee) * BigInt(used);
      return `${campaign.quantity} NFT(s) per wallet at ${formatEth(campaign.mintPriceWei)} ETH from ${used} wallet(s) on chain ${campaign.chainId}, contract ${campaign.contract.slice(0, 6)}…${campaign.contract.slice(-4)}. The most that can be spent is ${formatEth(total)} ETH, signing at no more than ${maxFeeGwei} gwei. Every guard still applies.`;
    },
    fireNow: (campaignId, wallets, maxFeeGwei) => run({ campaignId, wallets, maxFeeGwei }),
    fireSchedule: (schedule) => run({ campaignId: schedule.campaignId, wallets: schedule.wallets, maxFeeGwei: Number(schedule.maxFeeGwei), scheduleId: schedule.id }),
    schedulePhrase(campaign, wallets, maxFeeGwei, from, until) {
      const fee = campaign.feePolicy.totalFeeBudgetWei ?? 0n;
      const used = Math.min(wallets.length, Math.max(1, sizedWalletCount(campaign)));
      const total = (campaign.mintPriceWei * BigInt(campaign.quantity) + fee) * BigInt(used);
      return `SCHEDULE ${campaign.id.slice(-8)} ${used}-WALLETS ${formatEth(total)} ${maxFeeGwei}-GWEI ${compact(from)}-${compact(until)}`;
    },
    parseWindow(fromText, untilText) {
      const at = now();
      const from = parseWhen(fromText, at);
      const until = parseWhen(untilText, at);
      if (!from || !until) throw new Error('WINDOW_INVALID: write times as 2026-10-25T18:00 (UTC), +90m, +2h or now');
      assertScheduleWindow(from, until, at);
      return { from, until };
    },
    campaignDigest: campaignInputDigest,
    conflict,
  };
}

/** The digest stored with a confirmation: the phrase, the campaign and the exact wallets, so a copied phrase cannot be reused for others. */
export function scheduleConfirmationDigest(phrase: string, campaignId: string, wallets: readonly string[], from: Date, until: Date): string {
  return createHash('sha256').update(`${phrase}\n${campaignId}\n${wallets.join(',')}\n${from.toISOString()}\n${until.toISOString()}`, 'utf8').digest('hex');
}
