import { unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { formatEther, parseGwei, type Address } from 'viem';
import { assertKillReleaseAllowed, killReleasePhrase, recordWalletSimulations, unresolvedRunIds, type BackendState, type BackendStore, type Campaign, type CampaignInput, type IntelligenceChainPort, type KillSwitchStatus } from '@mint-bot/backend';
import { checkDrop, type DropCheckReport } from './drop-check.js';
import { assertLivePrepareAllowed, buildLivePlan, liveConfirmationPhrase, liveFreeCampaignFields, type LivePlan } from './live-plan.js';
import { acceptPhrase } from './fleet-funding-cli.js';
import { assertTipMatchesStoredPolicy, type describeFeePolicy } from './fee-policy.js';

/**
 * T-061 (D-063 item 9): the owner actions that both the host CLI and the Telegram commands perform. Each one is the single
 * implementation, so a Telegram command runs exactly the checks the host command runs. Nothing here signs or sends.
 */

type KillStore = Pick<BackendStore, 'snapshot'> & { killSwitchStatus(): KillSwitchStatus; releaseKillSwitch(actor: string, reason: string): Promise<{ released: boolean }> };

export function asKillStore(store: BackendStore): KillStore {
  const candidate = store as unknown as Partial<KillStore>;
  if (typeof candidate.killSwitchStatus !== 'function' || typeof candidate.releaseKillSwitch !== 'function') throw new Error('CANONICAL_STORE_REQUIRED');
  return candidate as KillStore;
}

export type KillReleaseOutcome =
  | { state: 'Off'; message: string }
  | { state: 'On'; message: string; engagedAt: string | null; fileExists: boolean; unresolvedRuns: string[]; phrase?: string }
  | { state: 'Released'; message: string; released: boolean };

/** `kill-release`: without the phrase it only reports; with the exact phrase and nothing unresolved it turns the switch off. */
export async function killReleaseAction(input: { store: KillStore; killFile: string; confirm: string | undefined; actor: string }): Promise<KillReleaseOutcome> {
  const status = input.store.killSwitchStatus();
  const fileExists = existsSync(input.killFile);
  const engaged = status.engaged || input.store.snapshot().killed || fileExists;
  if (!engaged) return { state: 'Off', message: 'The kill switch is already off (no file and no stored flag).' };
  const unresolved = unresolvedRunIds(input.store.snapshot());
  const phrase = killReleasePhrase(status);
  if (input.confirm === undefined) {
    return { state: 'On', message: unresolved.length > 0 ? `The kill switch is on, and ${unresolved.length} run(s) are still in flight or unresolved, so it cannot be released yet. Run reconcile and wait until they settle.` : 'The kill switch is on. Releasing it lets live runs happen again once everything else is ready. Only do this when you mean to.', engagedAt: status.engaged ? status.changedAt : null, fileExists, unresolvedRuns: unresolved, ...(unresolved.length === 0 ? { phrase } : {}) };
  }
  assertKillReleaseAllowed({ status, confirm: input.confirm, unresolved });
  const result = await input.store.releaseKillSwitch(input.actor, 'operator release');
  await unlink(input.killFile).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  return { state: 'Released', released: result.released, message: `The kill switch is off${result.released ? '' : ' (only the file was left)'}.` };
}

export interface WalletChainReader {
  getBlockNumber(): Promise<bigint>;
  getTransactionCount(args: { address: Address; blockNumber: bigint }): Promise<number>;
  getBalance(args: { address: Address; blockNumber: bigint }): Promise<bigint>;
}

export type WatchAcceptOutcome = { state: 'Preview'; message: string; phrase: string } | { state: 'Accepted'; message: string };

/** `fleet-watch-accept`: shows the wallet's on-chain state and, with the exact phrase, records it as the watcher's new baseline. */
export async function watchAcceptAction(input: { chainId: 1 | 8453 | 4663; address: string; confirm: string | undefined; client: WalletChainReader; store: Pick<BackendStore, 'transaction'>; newId(): string; now: Date }): Promise<WatchAcceptOutcome> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.address)) throw new Error('FLEET_WATCH_ADDRESS_INVALID');
  const address = input.address.toLowerCase();
  const blockNumber = await input.client.getBlockNumber();
  const [nonce, balanceWei] = await Promise.all([input.client.getTransactionCount({ address: address as Address, blockNumber }), input.client.getBalance({ address: address as Address, blockNumber })]);
  const phrase = acceptPhrase(address, nonce, balanceWei);
  const seen = `The wallet ${address} on chain ${input.chainId} now has ${nonce} sent transactions and ${formatEther(balanceWei)} ETH.`;
  if (input.confirm !== phrase) return { state: 'Preview', message: `${seen} Only accept this after you have looked up the wallet's history and understand every transaction.`, phrase };
  await input.store.transaction((state) => { state.events.push({ id: input.newId(), type: 'fleet_watch_accept', at: input.now.toISOString(), data: { chainId: input.chainId, address, nonce, balanceWei: balanceWei.toString() } }); });
  return { state: 'Accepted', message: `${seen} Accepted. The running watcher adopts it on its next check. This does not release the kill switch; do that separately once you are sure.` };
}

export interface LivePlanResult { report: DropCheckReport; plan: LivePlan; phrase?: string; planningMaxFeeGwei: string | null }

/** `live-plan`: read-only. A test mint call per wallet, the money at risk and what blocks a live mint. */
export async function livePlanAction(input: { chainId: 1 | 8453; contract: string; wallets: readonly string[]; quantityLimit?: number; port: IntelligenceChainPort; killFile: string; custody: 'local' | 'turnkey' }): Promise<LivePlanResult> {
  const report = await checkDrop(input.port, input.contract, input.wallets, { simulate: true, ...(input.quantityLimit === undefined ? {} : { maxQuantity: input.quantityLimit }) });
  const plan = buildLivePlan(report, { killSwitchPresent: existsSync(input.killFile), custody: input.custody, chainId: input.chainId });
  return { report, plan, ...(plan.verdict === 'ready' ? { phrase: liveConfirmationPhrase(input.contract, plan.quantity, plan.totalMaxExposureEth) } : {}), planningMaxFeeGwei: report.quantityPlan?.maxFeeGwei ?? null };
}

export interface PrepareStore {
  snapshot(): Pick<BackendState, 'chainEvidence'>;
  transaction: BackendStore['transaction'];
  ethereumFeePolicyStatus?: () => Parameters<typeof describeFeePolicy>[0];
}

/** `live-prepare`: records a live FREE campaign from a ready plan and the exact phrase. Spends nothing. */
export async function livePrepareAction(input: {
  chainId: 1 | 8453; contract: string; quantityLimit?: number; priorityFeeGwei: number; confirm: string;
  planned: LivePlanResult; killFile: string; walletFileAddresses: readonly string[];
  store: PrepareStore; createCampaign(input: CampaignInput): Promise<Campaign>; newId(): string; now: Date;
}): Promise<{ campaign: Campaign; wallets: string[]; quantity: number; maxExposureEth: string; planningMaxFeeGwei: string | null }> {
  const { plan, report } = input.planned;
  const readyWallets = assertLivePrepareAllowed({ plan, contract: input.contract, confirm: input.confirm, priorityFeeGwei: input.priorityFeeGwei, walletFileAddresses: input.walletFileAddresses, killSwitchPresent: existsSync(input.killFile) });
  const fields = liveFreeCampaignFields({ quantity: plan.quantity, wallets: readyWallets.length, tipWei: parseGwei(input.priorityFeeGwei.toString()), chainId: input.chainId });
  if (input.chainId === 1) {
    if (typeof input.store.ethereumFeePolicyStatus !== 'function') throw new Error('CANONICAL_STORE_REQUIRED');
    const policy = input.store.ethereumFeePolicyStatus();
    if (policy.stored !== null && !policy.matchesApproved) throw new Error('FEE_POLICY_DIFFERS_FROM_APPROVED: run fee-policy status, then fee-policy apply with its confirmation phrase');
    assertTipMatchesStoredPolicy(policy, parseGwei(input.priorityFeeGwei.toString()));
  }
  const evidence = input.store.snapshot().chainEvidence.find((item) => item.chainId === input.chainId && item.status === 'accepted' && item.executionEnabled && item.expiresAt > input.now.toISOString());
  if (!evidence) throw new Error('CHAIN_EVIDENCE_NOT_ACCEPTED: run chain-evidence status, then chain-evidence accept with its phrase, before live-prepare');
  const campaign = await input.createCampaign({
    chainId: input.chainId,
    contract: input.contract,
    strategy: 'seadrop-v1-public',
    quantity: fields.quantity,
    dryRun: false,
    maxRunWei: fields.maxRunWei,
    dailyCapWei: fields.dailyCapWei,
    gasCeilingWei: fields.gasCeilingWei,
    broadcastMode: 'public',
    chainVerification: { chainId: input.chainId, status: 'verified', seaDropCompatible: true, evidenceId: evidence.id, checkedAt: evidence.checkedAt, sourceBlock: evidence.sourceBlock, endpointReference: evidence.endpointIdentity },
    mintPriceWei: fields.mintPriceWei,
    feePolicy: fields.feePolicy,
  });
  // Record why the quantity is what it is (D-037); live-run copies this onto the run so the summary can explain it.
  if (report.quantityPlan) {
    const planData = { campaignId: campaign.id, desired: report.quantityPlan.desired, planned: report.quantityPlan.planned, reduced: report.quantityPlan.reduced, reason: report.quantityPlan.reason, maxFeeGwei: report.quantityPlan.maxFeeGwei, message: report.quantityPlan.message };
    await input.store.transaction((state) => { state.events.push({ id: input.newId(), type: 'quantity_plan', at: input.now.toISOString(), data: planData }); });
  }
  return { campaign, wallets: readyWallets, quantity: fields.quantity, maxExposureEth: plan.totalMaxExposureEth, planningMaxFeeGwei: report.quantityPlan?.maxFeeGwei ?? null };
}

/** `record-simulation`: a test mint call for every wallet of a prepared live campaign; records the result only when all pass. */
export async function recordSimulationAction(input: { store: BackendStore; campaign: Campaign; wallets: readonly string[]; port: IntelligenceChainPort; latestBlock(): Promise<{ number: bigint; hash: string }> }): Promise<string[]> {
  if (input.campaign.dryRun || (input.campaign.chainId !== 1 && input.campaign.chainId !== 8453)) throw new Error('LIVE_SUPPORTED_CAMPAIGN_REQUIRED');
  const report = await checkDrop(input.port, input.campaign.contract, input.wallets, { simulate: true, quantity: input.campaign.quantity });
  const results = report.wallets.map((row) => ({ wallet: row.wallet, success: row.verdict === 'ready' }));
  if (results.length !== input.wallets.length || results.some((item) => !item.success)) throw new Error(`SIMULATION_NOT_PASSED: ${report.summary}`);
  const block = await input.latestBlock();
  return recordWalletSimulations(input.store, input.campaign, results, { blockNumber: block.number, blockHash: block.hash });
}
