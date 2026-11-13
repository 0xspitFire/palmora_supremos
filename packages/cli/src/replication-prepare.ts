import { BASE_PERSONAL_LIVE_FLEET_POLICY, PERSONAL_LIVE_FLEET_POLICY, REVIEWED_ERC721_PUBLIC_BASELINE, type BackendStore, type Campaign, type CampaignInput } from '@mint-bot/backend';
import type { Address } from 'viem';
import { liveFreeCampaignFields } from './live-plan.js';
import { robinhoodFreeCampaignFields } from './robinhood-live.js';
import type { QualifiedSource } from './replication-source.js';

/** The same conservative fee envelope preparation uses; this is not admission. */
export function replicationFundingRequirement(source: QualifiedSource, maxQuantity: number): bigint {
  const { drop, plan } = source;
  const quantity = Math.min(maxQuantity, plan.observed.quantity ?? 0, drop.maxTotalMintableByWallet, drop.chainId === 8453 ? 4 : 15);
  if (!Number.isSafeInteger(quantity) || quantity < 1 || drop.mintPrice < 0n) throw new Error('REPLICATION_PLAN_INVALID');
  const policy = drop.chainId === 8453 ? BASE_PERSONAL_LIVE_FLEET_POLICY : PERSONAL_LIVE_FLEET_POLICY;
  const fee = drop.mintPrice > 0n ? policy.paidFeeAllowanceWei : drop.chainId === 4663 ? 200_000_000_000_000n : policy.freeFeeAllowanceWei;
  return drop.mintPrice * BigInt(quantity) + fee;
}

/** Unknown balances exclude that wallet. No wallet is admitted or funded here. */
export async function fundedReplicationWallets(source: QualifiedSource, wallets: readonly Address[], maxQuantity: number, balance: (wallet: Address) => Promise<bigint>): Promise<Address[]> {
  const required = replicationFundingRequirement(source, maxQuantity);
  const targets = new Set(source.plan.targets.map(target => target.wallet.toLowerCase()));
  let unavailable = 0;
  let answered = 0;
  const rows = await Promise.all(wallets.filter(wallet => targets.has(wallet.toLowerCase())).map(async wallet => {
    try { const value = await balance(wallet); if (typeof value !== 'bigint' || value < 0n) throw new Error('INVALID_BALANCE'); answered += 1; return value >= required ? wallet : undefined; }
    catch { unavailable += 1; return undefined; }
  }));
  if (unavailable > 0 && answered === 0) throw new Error('REPLICATION_BALANCE_UNAVAILABLE');
  return rows.filter((wallet): wallet is Address => wallet !== undefined);
}

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
  const reviewed=input.source.reviewedProtocol;
  if((drop.strategyName==='erc721-reviewed-public-v1')!==Boolean(reviewed))throw new Error('REVIEWED_PROTOCOL_SOURCE_REQUIRED');
  const evidence = input.store.snapshot().chainEvidence.filter((e) => e.chainId === chainId && e.status === 'accepted' && e.executionEnabled && Date.parse(e.expiresAt) > input.now.getTime() && (reviewed?e.strategyVersion===REVIEWED_ERC721_PUBLIC_BASELINE&&!e.seaDropCompatible&&e.reviewedProtocol?.family===reviewed.family&&e.reviewedProtocol.registryDigest===reviewed.registryDigest&&e.reviewedProtocol.descriptorDigests.includes(reviewed.descriptorDigest):e.strategyVersion!==REVIEWED_ERC721_PUBLIC_BASELINE&&e.seaDropCompatible)).sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))[0];
  if (!evidence) throw new Error('CHAIN_EVIDENCE_NOT_ACCEPTED');
  const policy = chainId === 8453 ? BASE_PERSONAL_LIVE_FLEET_POLICY : PERSONAL_LIVE_FLEET_POLICY;
  const paid = drop.mintPrice > 0n;
  if (paid && drop.mintPrice > policy.paidMaxPricePerNftWei) throw new Error('PAID_PRICE_PER_NFT_EXCEEDED');
  const fee = paid ? policy.paidFeeAllowanceWei : chainId === 4663 ? 200_000_000_000_000n : policy.freeFeeAllowanceWei;
  const cap = paid ? policy.paidDailyCapWei : chainId === 4663 ? 2_000_000_000_000_000n : policy.freeDailyCapWei;
  const perWallet = replicationFundingRequirement(input.source, input.maxQuantity);
  const maxWallets = Math.min(paid ? policy.paidMaxWalletsPerMint : 10, Number(cap / perWallet));
  const targets = new Set(plan.targets.map((target) => target.wallet.toLowerCase()));
  const wallets = [...new Set(input.wallets.map((wallet) => wallet.toLowerCase()))].filter((wallet) => targets.has(wallet)).slice(0, maxWallets);
  if (!wallets.length || input.tipWei <= 0n || input.tipWei >= fee) throw new Error('REPLICATION_FLEET_OR_FEE_INVALID');
  const fields = paid ? {
    quantity, maxRunWei: perWallet * BigInt(wallets.length), dailyCapWei: perWallet, gasCeilingWei: fee, mintPriceWei: drop.mintPrice,
    feePolicy: { kind: 'paid' as const, configuredPriorityFeeWei: input.tipWei, l2ExecutionGasBudgetWei: fee - input.tipWei, l1DataGasBudgetWei: 0n, totalFeeBudgetWei: fee },
  } : chainId === 4663 ? robinhoodFreeCampaignFields({ quantity, wallets: wallets.length, tipWei: input.tipWei }) : liveFreeCampaignFields({ quantity, wallets: wallets.length, tipWei: input.tipWei, chainId });
  const campaign = await input.createCampaign({ ...fields, ...(reviewed?{reviewedProtocol:reviewed}:{}), walletScope: wallets, chainId, contract: drop.nftContract.toLowerCase(), strategy: drop.strategyName, dryRun: false, broadcastMode: chainId === 4663 ? 'sequencer' : 'public', chainVerification: { chainId, status: 'verified', seaDropCompatible: !reviewed, evidenceId: evidence.id, checkedAt: evidence.checkedAt, sourceBlock: evidence.sourceBlock, endpointReference: evidence.endpointIdentity } });
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

/** Before the one-shot replication claim: a durable mint hold precedes every
 * top-up; unresolved transfers keep the same hold/campaign and never re-sign. */
export function createReplicationAutoFunding(options:{
 store:BackendStore;
 coordinator:Pick<import('@mint-bot/backend').ExecutionCoordinator,'prepareFunding'|'fundHold'|'reconcileFunding'>;
 prepare(source:QualifiedSource,wallets:readonly Address[]):Promise<{campaign:Campaign;wallets:string[];maxFeeGwei:number}|Array<{campaign:Campaign;wallets:string[];maxFeeGwei:number}>>;
 funded(source:QualifiedSource,wallets:readonly Address[]):Promise<Address[]>;
 now?:()=>Date;
}){
 const now=options.now??(()=>new Date());
 return {async ensure(source:QualifiedSource,candidates:readonly Address[],sourceEvent:import('@mint-bot/backend').EventRecord,score:import('@mint-bot/backend').EventRecord):Promise<Array<{campaign:Campaign;wallets:string[];maxFeeGwei:number}>|undefined>{
  if(typeof source.observed.hash!=='string'||!/^0x[a-f0-9]{64}$/i.test(source.observed.hash)||source.drop.mintPrice!==0n||typeof score.data.score!=='number'||score.data.score<70||score.data.blocked===true)throw new Error('FUNDING_WATCHED_SOURCE_REQUIRED');
  const {createHash}=await import('node:crypto');const key=createHash('sha256').update(JSON.stringify({chainId:source.drop.chainId,hash:source.observed.hash.toLowerCase(),wallets:[...candidates].map(wallet=>wallet.toLowerCase()).sort()})).digest('hex');const id=`replication_funding_${key}`;
  const existing = () => options.store.snapshot().events.find(value=>value.type==='replication_funding_prepared' && (value.id===id || value.data.sourceEventId===sourceEvent.id && value.data.sourceTxHash===source.observed.hash));
  let event=existing();
  // A funded balance is not proof that a bot top-up is final. Canonical unknown
  // funding exposure excludes that wallet even when its pending balance is visible.
  if(!event && options.store.fundingExpenseSnapshot){
   const expires=Date.parse(source.mintedAt)+15*60000;
   if(!Number.isFinite(expires)||expires<=+now())throw new Error('FUNDING_SOURCE_EXPIRED');
   const available=await options.funded(source,candidates);
   event=existing();
   if(!event){
    const unknown=new Set(options.store.fundingExpenseSnapshot().filter(row=>row.chainId===source.drop.chainId && row.status!=='known').map(row=>row.wallet.toLowerCase()));
    const selected=[...new Set(available)].filter(wallet=>candidates.some(candidate=>candidate.toLowerCase()===wallet.toLowerCase()) && !unknown.has(wallet.toLowerCase()));
    if(selected.length){
     const created=await options.prepare(source,selected);const prepared=Array.isArray(created)?created:[created];
     event=existing();
     const currentUnknown=new Set(options.store.fundingExpenseSnapshot().filter(row=>row.chainId===source.drop.chainId && row.status!=='known').map(row=>row.wallet.toLowerCase()));
     if(!event && expires>+now() && prepared.length && prepared.every(row=>row.wallets.length>0 && row.wallets.every(wallet=>selected.some(candidate=>candidate.toLowerCase()===wallet.toLowerCase()) && !currentUnknown.has(wallet.toLowerCase()))))return prepared;
     if(!event)throw new Error('FUNDING_FAST_PATH_CHANGED');
    }
   }
  }
  if(!event){const created=await options.prepare(source,candidates);const prepared=Array.isArray(created)?created:[created];const {fundingCampaignDigest}=await import('@mint-bot/backend');const rows=prepared.map(row=>({campaignId:row.campaign.id,digest:fundingCampaignDigest(row.campaign),wallets:row.wallets,maxFeeGwei:row.maxFeeGwei}));
   await options.store.transaction(state=>{if(!state.events.some(value=>value.id===id))state.events.push({id,type:'replication_funding_prepared',at:now().toISOString(),data:{sourceEventId:sourceEvent.id,sourceTxHash:source.observed.hash,scoreEventId:score.id,prepared:rows,expiresAt:new Date(Date.parse(source.mintedAt)+15*60000).toISOString()}});});event=options.store.snapshot().events.find(value=>value.id===id);
  }
  if(!event||!Array.isArray(event.data.prepared)||!Number.isFinite(Date.parse(String(event.data.expiresAt)))||Date.parse(String(event.data.expiresAt))<=+now())throw new Error('FUNDING_SOURCE_EXPIRED');
  const fundingKey=/^replication_funding_[a-f0-9]{64}$/.test(event.id)?event.id.slice('replication_funding_'.length):key;
  const {fundingCampaignDigest}=await import('@mint-bot/backend');const result:Array<{campaign:Campaign;wallets:string[];maxFeeGwei:number}>=[];
  for(const item of event.data.prepared as Array<{campaignId:string;digest:string;wallets:string[];maxFeeGwei:number}>){
   const campaign=options.store.snapshot().campaigns.find(row=>row.id===item.campaignId);if(!campaign||fundingCampaignDigest(campaign)!==item.digest||campaign.chainId!==source.drop.chainId||campaign.contract.toLowerCase()!==source.drop.nftContract.toLowerCase()||campaign.strategy!==source.drop.strategyName||campaign.mintPriceWei!==0n||campaign.quantity>source.drop.maxTotalMintableByWallet||!item.wallets.length||item.wallets.some(wallet=>!candidates.some(candidate=>candidate.toLowerCase()===wallet.toLowerCase())))throw new Error('FUNDING_PREPARED_CAMPAIGN_CHANGED');
   const hold=await options.coordinator.prepareFunding({campaignId:campaign.id,wallets:item.wallets,idempotencyKey:`auto-fund:${fundingKey}:${campaign.id}`,expiresAt:String(event.data.expiresAt)});
   await options.coordinator.fundHold(hold.id);const funded=await options.coordinator.reconcileFunding(hold.id);if(funded.some(row=>row.state!=='settled'))return undefined;
   const healthy=await options.funded(source,item.wallets as Address[]);if(healthy.length!==item.wallets.length||item.wallets.some(wallet=>!healthy.some(candidate=>candidate.toLowerCase()===wallet.toLowerCase())))return undefined;
   result.push({campaign,wallets:[...item.wallets],maxFeeGwei:item.maxFeeGwei});
  }
  return result;
 }};
}
