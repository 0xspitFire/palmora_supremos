import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { formatEth, campaignInputDigest, type BackendStore, type Campaign, type IntelligenceChainPort } from '@mint-bot/backend';
import type { FireScheduleRepository, FireScheduleRecord } from '@mint-bot/database';
import { checkDrop } from './drop-check.js';
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
  walletList(): Promise<string[]>;
  evmPort(chainId: 1 | 8453): Promise<IntelligenceChainPort>;
  evmLatestBlock(chainId: 1 | 8453): Promise<{ number: bigint; hash: string }>;
  robinhoodDryRun(contract: string, wallets: readonly string[], quantity: number | undefined, at: Date): Promise<DryRunReport>;
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
  /** When each campaign was last fired: after the processor claims a request it no longer shows as waiting, so a short memory covers its run. */
  const firedAt = new Map<string, number>();
  const RECENT_FIRE_MS = 10 * 60_000;
  const findCampaign = (campaignId: string): Campaign | undefined => deps.store.snapshot().campaigns.find((item) => item.id === campaignId);

  /** Open schedules and waiting requests. The in-flight guard is separate: the pipeline itself holds it while it runs. */
  const persistentConflict = (campaignId: string, ignoreScheduleId?: string): string | undefined => {
    const last = firedAt.get(campaignId);
    if (last !== undefined && now().getTime() - last < RECENT_FIRE_MS) return 'this campaign was fired in the last 10 minutes; see /requests and /runs';
    const schedule = deps.fireSchedules().open(campaignId).find((item) => item.id !== ignoreScheduleId);
    if (schedule) return `a scheduled mint (${schedule.id.slice(-6)}) is open for this campaign; cancel it first with /cancel ${schedule.id.slice(-6)}`;
    const nowMs = now().getTime();
    if (deps.unclaimedRequests().some((request) => request.campaignId === campaignId && Date.parse(request.expiresAt) > nowMs)) return 'a live request for this campaign is waiting for the service; see /requests';
    return undefined;
  };
  const conflict = (campaignId: string, ignoreScheduleId?: string): string | undefined => (inFlight.has(campaignId) ? 'this campaign is being fired right now' : persistentConflict(campaignId, ignoreScheduleId));

  const mintState = async (campaign: Campaign): Promise<MintState> => {
    try {
      if (campaign.chainId === 4663) {
        const wallet = (await deps.walletList())[0];
        if (!wallet) return 'unknown';
        const report = await deps.robinhoodDryRun(campaign.contract, [wallet], campaign.quantity, now());
        return report.drop?.status ?? 'unknown';
      }
      if (campaign.chainId !== 1 && campaign.chainId !== 8453) return 'unknown';
      const report = await checkDrop(await deps.evmPort(campaign.chainId), campaign.contract, [], { simulate: false, now: now() });
      return report.drop?.status ?? 'unknown';
    } catch { return 'unknown'; }
  };

  const recordSimulations: FireDeps['recordSimulations'] = async (campaign, wallets) => {
    if (campaign.chainId === 4663) {
      const report = await deps.robinhoodDryRun(campaign.contract, wallets, campaign.quantity, now());
      const result = await recordRobinhoodSimulationsAction({ store: deps.store, campaign, report, latestBlock: deps.robinhoodLatestBlock });
      return { recorded: result.recorded, skipped: result.skipped };
    }
    if (campaign.chainId !== 1 && campaign.chainId !== 8453) throw new Error('LIVE_SUPPORTED_CAMPAIGN_REQUIRED');
    const chainId = campaign.chainId;
    const result = await recordPassingSimulationsAction({ store: deps.store, campaign, wallets, port: await deps.evmPort(chainId), latestBlock: () => deps.evmLatestBlock(chainId) });
    return { recorded: result.recorded, skipped: result.skipped };
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
    try { const result = await runFire(fireDeps, input); firedAt.set(input.campaignId, now().getTime()); return result; } finally { inFlight.delete(input.campaignId); }
  };

  return {
    fireDeps,
    mintState,
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
