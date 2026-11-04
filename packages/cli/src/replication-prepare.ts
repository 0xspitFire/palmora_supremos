import { BASE_PERSONAL_LIVE_FLEET_POLICY, PERSONAL_LIVE_FLEET_POLICY, type BackendStore, type Campaign, type CampaignInput } from '@mint-bot/backend';
import type { Address } from 'viem';
import { liveFreeCampaignFields } from './live-plan.js';
import { robinhoodFreeCampaignFields } from './robinhood-live.js';
import type { QualifiedSource } from './replication-source.js';

/** Conservative preflight only; SQLite admission remains the atomic cap authority. */
export function replicationWithinCaps(store: BackendStore, campaign: Campaign, wallets: readonly string[], now: Date): boolean {
  const state = store.snapshot();
  const policy = campaign.chainId === 8453 ? BASE_PERSONAL_LIVE_FLEET_POLICY : PERSONAL_LIVE_FLEET_POLICY;
  const cap = campaign.chainId === 4663 ? 2_000_000_000_000_000n : policy.freeDailyCapWei;
  const exposure = campaign.mintPriceWei * BigInt(campaign.quantity) + (campaign.feePolicy.totalFeeBudgetWei ?? 0n);
  let fleet = 0n;
  const byWallet = new Map<string, bigint>();
  for (const r of state.reservations) {
    if (r.status === 'released') continue;
    const prior = state.campaigns.find((c) => c.id === r.campaignId);
    if (!prior) return false;
    if (prior.chainId !== campaign.chainId || prior.feePolicy.kind !== 'free') continue;
    const pending = r.status === 'reserved' || r.status === 'reorged';
    if (pending && (!Number.isFinite(Date.parse(r.createdAt)) || now.getTime() - Date.parse(r.createdAt) >= 24 * 3_600_000)) return false;
    if (!pending && Number.isFinite(Date.parse(r.updatedAt)) && now.getTime() - Date.parse(r.updatedAt) >= 24 * 3_600_000) continue;
    const value = pending ? r.amountWei : r.actualAmountWei ?? r.amountWei;
    fleet += value;
    byWallet.set(r.wallet.toLowerCase(), (byWallet.get(r.wallet.toLowerCase()) ?? 0n) + value);
  }
  return exposure > 0n && new Set(wallets).size === wallets.length && exposure * BigInt(wallets.length) <= campaign.spendPolicy.maxRunWei && fleet + exposure * BigInt(wallets.length) <= cap && wallets.every((wallet) => (byWallet.get(wallet.toLowerCase()) ?? 0n) + exposure <= campaign.spendPolicy.dailyCapWei);
}

/** Uses the approved fee envelope. Canonical admission still reserves actual pending exposure before signing. */
export async function prepareReplication(input: {
  source: QualifiedSource;
  wallets: readonly Address[];
  maxQuantity: number;
  maxFeeGwei: number;
  tipWei: bigint;
  store: BackendStore;
  createCampaign(input: CampaignInput): Promise<Campaign>;
  now: Date;
}): Promise<{ campaign: Campaign; wallets: string[]; maxFeeGwei: number }> {
  const { drop, plan } = input.source;
  const chainId = drop.chainId;
  const quantity = Math.min(input.maxQuantity, plan.observed.quantity ?? 0, drop.maxTotalMintableByWallet, chainId === 8453 ? 4 : 15);
  if (plan.verdict !== 'replicable' || !Number.isSafeInteger(quantity) || quantity < 1 || !Number.isFinite(input.maxFeeGwei) || input.maxFeeGwei <= 0 || input.maxFeeGwei > 500) throw new Error('REPLICATION_PLAN_INVALID');
  const evidence = input.store.snapshot().chainEvidence.filter((e) => e.chainId === chainId && e.status === 'accepted' && e.executionEnabled && Date.parse(e.expiresAt) > input.now.getTime()).sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))[0];
  if (!evidence) throw new Error('CHAIN_EVIDENCE_NOT_ACCEPTED');
  const policy = chainId === 8453 ? BASE_PERSONAL_LIVE_FLEET_POLICY : PERSONAL_LIVE_FLEET_POLICY;
  const paid = drop.mintPrice > 0n;
  if (paid && drop.mintPrice > policy.paidMaxPricePerNftWei) throw new Error('PAID_PRICE_PER_NFT_EXCEEDED');
  const fee = paid ? policy.paidFeeAllowanceWei : chainId === 4663 ? 200_000_000_000_000n : policy.freeFeeAllowanceWei;
  const cap = paid ? policy.paidDailyCapWei : chainId === 4663 ? 2_000_000_000_000_000n : policy.freeDailyCapWei;
  const perWallet = drop.mintPrice * BigInt(quantity) + fee;
  const maxWallets = Math.min(paid ? policy.paidMaxWalletsPerMint : 10, Number(cap / perWallet));
  const targets = new Set(plan.targets.map((target) => target.wallet.toLowerCase()));
  const wallets = [...new Set(input.wallets.map((wallet) => wallet.toLowerCase()))].filter((wallet) => targets.has(wallet)).slice(0, maxWallets);
  if (!wallets.length || input.tipWei <= 0n || input.tipWei >= fee) throw new Error('REPLICATION_FLEET_OR_FEE_INVALID');
  const fields = paid ? {
    quantity, maxRunWei: perWallet * BigInt(wallets.length), dailyCapWei: perWallet, gasCeilingWei: fee, mintPriceWei: drop.mintPrice,
    feePolicy: { kind: 'paid' as const, configuredPriorityFeeWei: input.tipWei, l2ExecutionGasBudgetWei: fee - input.tipWei, l1DataGasBudgetWei: 0n, totalFeeBudgetWei: fee },
  } : chainId === 4663 ? robinhoodFreeCampaignFields({ quantity, wallets: wallets.length, tipWei: input.tipWei }) : liveFreeCampaignFields({ quantity, wallets: wallets.length, tipWei: input.tipWei, chainId });
  const campaign = await input.createCampaign({ ...fields, walletScope: wallets, chainId, contract: drop.nftContract.toLowerCase(), strategy: drop.strategyName, dryRun: false, broadcastMode: chainId === 4663 ? 'sequencer' : 'public', chainVerification: { chainId, status: 'verified', seaDropCompatible: true, evidenceId: evidence.id, checkedAt: evidence.checkedAt, sourceBlock: evidence.sourceBlock, endpointReference: evidence.endpointIdentity } });
  return { campaign, wallets, maxFeeGwei: input.maxFeeGwei };
}


/** A shared signed free family permits one fleet campaign; exact policies and paid mints remain wallet-specific. */
export function allowlistPreparationGroups(input: { wallets: readonly Address[]; targets: readonly string[]; paid: boolean; sharedFamily: boolean; paidMaxWallets: number }): Address[][] {
  const targets = new Set(input.targets.map((wallet) => wallet.toLowerCase()));
  const seen = new Set<string>();
  const selected = input.wallets.filter((wallet) => { const key = wallet.toLowerCase(); if (seen.has(key) || !targets.has(key)) return false; seen.add(key); return true; }).slice(0, input.paid ? input.paidMaxWallets : 10);
  if (!selected.length) return [];
  return !input.paid && input.sharedFamily ? [selected] : selected.map((wallet) => [wallet]);
}
