import { createHash, randomBytes } from 'node:crypto';
import { formatEth, type BackendState, type Campaign, type ValidatedCampaign } from '@mint-bot/backend';

/**
 * T-058 (owner-approved 2026-10-24): the owner asks the host service to arm and run one specific live mint.
 *
 * The owner command (`live-request`) writes nothing it could sign with: it records the owner's approval of an exact campaign,
 * wallet list and set of fresh per-wallet simulations (the same approval a live arm always needs) and a short-lived, typed-confirmed
 * request. The host service (host mode only) claims each request once and runs it through `arm` and `run` exactly as the guided
 * live run does, so approval, simulation, admission, caps, reservations, custody readiness, the watcher, enablement and the kill
 * switch all apply unchanged. A request lives at most 30 minutes, the life of a simulation record.
 */
export const LIVE_REQUEST_LIFETIME_MS = 30 * 60 * 1000;

export interface LiveRequestPreview {
  campaignId: string;
  chainId: number;
  contract: string;
  quantityPerWallet: number;
  priceEth: string;
  wallets: string[];
  simulationIds: string[];
  maxExposureWei: string;
  maxExposureEth: string;
  maxFeeGwei: number;
  phrase: string;
  evidenceAt: string;
}

type RequestState = Pick<BackendState, 'campaigns' | 'simulations'>;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** The phrase names the campaign, how many wallets, the most that can be spent and the fee ceiling, so a copied phrase does not match another request. */
export function liveRequestPhrase(campaignId: string, walletCount: number, maxExposureEth: string, maxFeeGwei: number): string {
  return `LIVE-REQUEST ${campaignId.slice(-8)} ${walletCount}-WALLETS ${maxExposureEth} ${maxFeeGwei}-GWEI`;
}

/** How many wallets a campaign was sized for: the most one run may spend, divided by the most one wallet can spend. */
export function sizedWalletCount(campaign: Pick<Campaign, 'mintPriceWei' | 'quantity' | 'feePolicy' | 'spendPolicy'>): number {
  const fee = campaign.feePolicy.totalFeeBudgetWei;
  if (fee === undefined) return 0;
  const perWallet = campaign.mintPriceWei * BigInt(campaign.quantity) + fee;
  return perWallet <= 0n ? 0 : Number(campaign.spendPolicy.maxRunWei / perWallet);
}

export function previewLiveRequest(state: RequestState, campaignId: string, wallets: readonly string[], maxFeeGwei: number, now: Date): LiveRequestPreview {
  if (!Number.isFinite(maxFeeGwei) || maxFeeGwei <= 0 || maxFeeGwei > 500) throw new Error('MAX_FEE_GWEI_REQUIRED: pass --max-fee-gwei (above 0, at most 500)');
  const campaign = state.campaigns.find((item) => item.id === campaignId);
  if (!campaign) throw new Error('CAMPAIGN_NOT_FOUND');
  if (campaign.dryRun) throw new Error('LIVE_REQUIRES_NON_DRY_CAMPAIGN');
  const unique = [...new Set(wallets.map((wallet) => wallet.toLowerCase()))];
  if (unique.length === 0 || unique.length !== wallets.length || unique.some((wallet) => !ADDRESS.test(wallet))) throw new Error('WALLETS_INVALID: give each wallet address once');
  const nowIso = now.toISOString();
  const latest = new Map<string, { id: string; checkedAt: string }>();
  for (const simulation of state.simulations) {
    if (simulation.campaignId !== campaignId || !simulation.success || simulation.expiresAt <= nowIso) continue;
    const key = simulation.wallet.toLowerCase();
    if (!latest.has(key) || simulation.checkedAt > latest.get(key)!.checkedAt) latest.set(key, { id: simulation.id, checkedAt: simulation.checkedAt });
  }
  const missing = unique.filter((wallet) => !latest.has(wallet));
  if (missing.length > 0) throw new Error(`SIMULATION_REQUIRED: record a fresh passing simulation for ${missing.length} wallet(s) first`);
  const fee = campaign.feePolicy.totalFeeBudgetWei;
  if (fee === undefined) throw new Error('TOTAL_FEE_BUDGET_REQUIRED');
  const perWallet = campaign.mintPriceWei * BigInt(campaign.quantity) + fee;
  const total = perWallet * BigInt(unique.length);
  if (perWallet <= 0n || total > campaign.spendPolicy.maxRunWei) throw new Error(`PLANNED_EXPOSURE_INVALID: this campaign was sized for ${sizedWalletCount(campaign)} wallet(s); you chose ${unique.length}. Use ${sizedWalletCount(campaign)} or fewer, or prepare a new campaign sized for more.`);
  const maxExposureEth = formatEth(total);
  return {
    campaignId,
    chainId: campaign.chainId,
    contract: campaign.contract,
    quantityPerWallet: campaign.quantity,
    priceEth: formatEth(campaign.mintPriceWei),
    wallets: unique,
    simulationIds: unique.map((wallet) => latest.get(wallet)!.id),
    maxExposureWei: total.toString(),
    maxExposureEth,
    maxFeeGwei,
    phrase: liveRequestPhrase(campaignId, unique.length, maxExposureEth, maxFeeGwei),
    evidenceAt: nowIso,
  };
}

export function liveRequestConfirmationDigest(phrase: string, preview: Pick<LiveRequestPreview, 'campaignId' | 'wallets' | 'simulationIds'>): string {
  return createHash('sha256').update(`${phrase}\n${preview.campaignId}\n${preview.wallets.join(',')}\n${preview.simulationIds.join(',')}`, 'utf8').digest('hex');
}

export interface LiveRequestStore {
  snapshot(): RequestState & Pick<BackendState, 'events'>;
  recordLiveRunRequest(input: { id: string; campaignId: string; wallets: string[]; simulationIds: string[]; approvalId: string; evidenceAt: string; maxFeeGwei: string; confirmationDigest: string; requestedAt: string; expiresAt: string }): void;
}

/** The owner command. `status` only reads; `create` records the approval and the request after the exact phrase. */
export async function runLiveRequest(input: {
  action: 'status' | 'create';
  campaignId: string;
  wallets: readonly string[];
  maxFeeGwei: number;
  confirm: string | undefined;
  now: Date;
  store: LiveRequestStore;
  approve: (validated: ValidatedCampaign) => Promise<{ id: string }>;
  newId?: () => string;
}): Promise<Record<string, unknown>> {
  const preview = previewLiveRequest(input.store.snapshot(), input.campaignId, input.wallets, input.maxFeeGwei, input.now);
  if (input.action === 'status' || input.confirm === undefined) {
    return {
      state: 'ConfirmToRequest',
      message: `The service will arm and run campaign ${preview.campaignId} (chain ${preview.chainId}, ${preview.quantityPerWallet} NFT(s) per wallet at ${preview.priceEth} ETH) from ${preview.wallets.length} wallet(s). The most that can be spent is ${preview.maxExposureEth} ETH, signing at no more than ${preview.maxFeeGwei} gwei. Every guard still applies. The request lasts 30 minutes.`,
      preview,
      copyThisToRequest: `live-request create --campaign-id ${preview.campaignId} --wallets ${preview.wallets.join(',')} --max-fee-gwei ${preview.maxFeeGwei} --confirm "${preview.phrase}"`,
    };
  }
  if (input.confirm !== preview.phrase) throw new Error('CONFIRMATION_PHRASE_MISMATCH: run live-request status and copy the phrase it prints exactly');
  const validated: ValidatedCampaign = { campaign: input.store.snapshot().campaigns.find((item) => item.id === preview.campaignId) as Campaign, wallets: preview.wallets, simulationIds: preview.simulationIds, evidenceAt: preview.evidenceAt };
  const approval = await input.approve(validated);
  const id = input.newId?.() ?? `live_request_${randomBytes(8).toString('hex')}`;
  const requestedAt = input.now.toISOString();
  input.store.recordLiveRunRequest({ id, campaignId: preview.campaignId, wallets: preview.wallets, simulationIds: preview.simulationIds, approvalId: approval.id, evidenceAt: preview.evidenceAt, maxFeeGwei: String(preview.maxFeeGwei), confirmationDigest: liveRequestConfirmationDigest(preview.phrase, preview), requestedAt, expiresAt: new Date(input.now.getTime() + LIVE_REQUEST_LIFETIME_MS).toISOString() });
  return { state: 'Requested', requestId: id, message: 'The service picks this up within a few seconds when it runs in live (host) mode. Follow it with `summary` or the dashboard; the kill switch stops everything at once.' };
}

/** What the host service needs to process requests. */
export interface LiveRequestProcessorDeps {
  unclaimed(): Array<{ id: string; campaignId: string; wallets: string[]; simulationIds: string[]; approvalId: string; evidenceAt: string; maxFeeGwei: string; requestedAt: string; expiresAt: string }>;
  claim(requestId: string, outcome: 'started' | 'expired'): boolean;
  campaign(campaignId: string): Campaign | undefined;
  /** The service's own application (not read-only), so `arm` and `run` apply every gate exactly as the guided live run does. */
  command(name: 'arm' | 'run', input: Record<string, unknown>): Promise<{ id: string; state?: string }>;
  /** The fee ceiling the engine signs with for this campaign's run. */
  setFeeCeiling(campaignId: string, gwei: number | undefined): void;
  record(event: { requestId: string; runId?: string; state: 'finished' | 'stopped' | 'expired'; code?: string }): Promise<void>;
  now(): Date;
}

/** Only fixed upper-case codes are kept; provider or library text never is. */
const safeCode = (error: unknown): string => {
  const message = error instanceof Error ? error.message : '';
  const code = message.split(':')[0] ?? '';
  return /^[A-Z][A-Z0-9_]{2,80}$/.test(code) ? code : 'LIVE_REQUEST_FAILED';
};

/** One pass of the host service over unclaimed requests. Each request is claimed once, before anything else happens. */
export async function processLiveRunRequests(deps: LiveRequestProcessorDeps): Promise<number> {
  let handled = 0;
  for (const request of deps.unclaimed()) {
    const now = deps.now();
    // Expired, or dated in the future (a clock or a hand-written row): claimed as expired and never armed.
    const requestedAt = Date.parse(request.requestedAt);
    const future = !Number.isFinite(requestedAt) || requestedAt > now.getTime() + 60_000;
    if (future || Date.parse(request.expiresAt) <= now.getTime()) {
      if (deps.claim(request.id, 'expired')) await deps.record({ requestId: request.id, state: 'expired', code: future ? 'LIVE_REQUEST_TIME_INVALID' : 'LIVE_REQUEST_EXPIRED' });
      continue;
    }
    if (!deps.claim(request.id, 'started')) continue;
    handled += 1;
    let runId: string | undefined;
    let result: { state: 'finished' | 'stopped'; code?: string };
    try {
      const campaign = deps.campaign(request.campaignId);
      if (!campaign) throw new Error('CAMPAIGN_NOT_FOUND');
      const maxFeeGwei = Number(request.maxFeeGwei);
      if (!Number.isFinite(maxFeeGwei) || maxFeeGwei <= 0 || maxFeeGwei > 500) throw new Error('MAX_FEE_GWEI_INVALID');
      const validated: ValidatedCampaign = { campaign, wallets: request.wallets, simulationIds: request.simulationIds, evidenceAt: request.evidenceAt };
      const armed = await deps.command('arm', { validated, mode: 'live', approvalId: request.approvalId, idempotencyKey: `live-request:${request.id}` });
      runId = armed.id;
      deps.setFeeCeiling(request.campaignId, maxFeeGwei);
      let ran: { state?: string };
      try { ran = await deps.command('run', { runId, wallets: request.wallets, idempotencyKey: `live-request-run:${request.id}` }); } finally { deps.setFeeCeiling(request.campaignId, undefined); }
      // Only a completed run is finished; a run that ended any other way is stopped under its state name.
      result = ran.state === 'Completed' ? { state: 'finished' } : { state: 'stopped', code: `RUN_${safeCode(new Error(String(ran.state ?? 'UNKNOWN').toUpperCase()))}` };
    } catch (error) {
      result = { state: 'stopped', code: safeCode(error) };
    }
    await deps.record({ requestId: request.id, ...(runId ? { runId } : {}), ...result });
  }
  return handled;
}

/** Host service only: looks for requests every few seconds. One pass at a time, so a long run never overlaps the next pass. */
export function startLiveRequestPoller(deps: LiveRequestProcessorDeps, options: { intervalMs?: number; onError?: (error: unknown) => void } = {}): { stop(): void; tick(): Promise<void> } {
  let busy = false;
  let again = false;
  const tick = async (): Promise<void> => {
    // A nudge that arrives while a pass is running (a `/fire` request) is not lost: the pass runs once more as soon as it ends.
    if (busy) { again = true; return; }
    busy = true;
    try { do { again = false; await processLiveRunRequests(deps); } while (again); } catch (error) { options.onError?.(error); } finally { busy = false; }
  };
  const timer = setInterval(() => { void tick(); }, options.intervalMs ?? 5_000);
  timer.unref?.();
  return { stop: () => clearInterval(timer), tick };
}
