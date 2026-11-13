import { createHash } from 'node:crypto';
import type { BackendStore } from './store.js';
import type { Campaign, ChainEvidenceRecord, RobinhoodNegativeCase, SimulationEvidenceRecord, ValidatedCampaign } from './types.js';

/** New owner-reviewed baseline only; legacy public evidence never acquires allowlist scope implicitly. */
export const REVIEWED_ERC721_PUBLIC_BASELINE = 'erc721-reviewed-public-v1-baseline@1';
export const SEADROP_PUBLIC_FREE_ALLOWLIST_BASELINE = 'seadrop-v1-baseline-public-free-allowlist@1';
/** Separate owner-reviewed extension; existing public/allowlist approvals never authorize signed mints. */
export const SEADROP_PUBLIC_FREE_ALLOWLIST_SIGNED_BASELINE = 'seadrop-v1-baseline-public-free-allowlist-free-signed@1';

/** Evidence references are opaque artifact identifiers, never endpoint URLs or credentials. */
export function validFreeSignedRehearsalReference(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9 ._:/@#-]{4,299}$/.test(value)
    && !/https?:|wss?:|bearer|authorization|password|private[ _-]?key|\.env\b|:\/\//i.test(value);
}

/** Family scope is independent from the chain-wide operational enablement. */
export function chainEvidenceMatchesCampaign(evidence:ChainEvidenceRecord,campaign:Campaign):boolean {
 if(evidence.chainId!==campaign.chainId)return false;
 if(campaign.strategy==='erc721-reviewed-public-v1'){
  const approved=evidence.reviewedProtocol,selected=campaign.custodyPolicy?.reviewedProtocol;
  return evidence.strategyVersion===REVIEWED_ERC721_PUBLIC_BASELINE && !evidence.seaDropCompatible && !campaign.chainVerification.seaDropCompatible && approved?.family==='erc721-reviewed-public-v1' && selected?.family===approved.family && /^sha256:[0-9a-f]{64}$/.test(selected.registryDigest) && /^sha256:[0-9a-f]{64}$/.test(selected.descriptorDigest) && approved.registryDigest===selected.registryDigest && Array.isArray(approved.descriptorDigests) && approved.descriptorDigests.includes(selected.descriptorDigest) && campaign.custodyPolicy?.provider==='turnkey' && /^sha256:[0-9a-f]{64}$/.test(campaign.custodyPolicy.recordDigest) && campaign.mintPriceWei===0n && campaign.feePolicy.kind==='free' && Number.isSafeInteger(campaign.quantity) && campaign.quantity>=1 && campaign.quantity<=(campaign.chainId===8453?4:10);
 }
 if(evidence.reviewedProtocol || evidence.strategyVersion===REVIEWED_ERC721_PUBLIC_BASELINE || !evidence.seaDropCompatible)return false;
 const signed=evidence.strategyVersion===SEADROP_PUBLIC_FREE_ALLOWLIST_SIGNED_BASELINE;
 const allowlist=signed||evidence.strategyVersion===SEADROP_PUBLIC_FREE_ALLOWLIST_BASELINE;
 if(campaign.strategy==='seadrop-v1-public')return allowlist||['seadrop-v1-public','seadrop-v1-public@1','seadrop-v1-public-1'].includes(evidence.strategyVersion);
 return allowlist && (campaign.strategy==='seadrop-v1-allowlist'||signed&&campaign.strategy==='seadrop-v1-signed') && campaign.mintPriceWei===0n && campaign.feePolicy.kind==='free';
}

function strategyCompatible(evidence: ChainEvidenceRecord, campaign: Campaign, state: ReturnType<BackendStore['snapshot']>, now: Date): boolean {
  if(!chainEvidenceMatchesCampaign(evidence,campaign))return false;
  if(evidence.strategyVersion===REVIEWED_ERC721_PUBLIC_BASELINE){
    const approved=evidence.reviewedProtocol;const selected=campaign.custodyPolicy?.reviewedProtocol;
    if(!approved || !selected || campaign.strategy!=='erc721-reviewed-public-v1' || approved.family!==selected.family || approved.registryDigest!==selected.registryDigest || !approved.descriptorDigests.includes(selected.descriptorDigest) || campaign.quantity>(campaign.chainId===8453?4:10) || campaign.mintPriceWei!==0n || campaign.feePolicy.kind!=='free')return false;
    return currentCustody(campaign,state,now);
  }
  const signedScope = evidence.strategyVersion === SEADROP_PUBLIC_FREE_ALLOWLIST_SIGNED_BASELINE;
  if (evidence.strategyVersion !== SEADROP_PUBLIC_FREE_ALLOWLIST_BASELINE && !signedScope) {
    return ['seadrop-v1-public', 'seadrop-v1-public@1', 'seadrop-v1-public-1'].includes(evidence.strategyVersion) && campaign.strategy === 'seadrop-v1-public';
  }
  if (campaign.strategy === 'seadrop-v1-public') return true;
  if ((campaign.strategy !== 'seadrop-v1-allowlist' && !(signedScope && campaign.strategy === 'seadrop-v1-signed')) || campaign.mintPriceWei !== 0n || campaign.feePolicy.kind !== 'free') return false;
  // Chain compatibility does not supply custody authority. The actual owner-signed
  // record is selected/verified by preparation and freshly checked before arm/run;
  // own-wallet simulation digests below bind this exact policy selection.
  return currentCustody(campaign,state,now);
}
function currentCustody(campaign:Campaign,state:ReturnType<BackendStore['snapshot']>,now:Date):boolean {
  const binding = campaign.custodyPolicy;
  const operational = state.runtime.operational;
  const custody = operational?.custody;
  return binding?.provider === 'turnkey' && /^sha256:[0-9a-f]{64}$/.test(binding.recordDigest)
    && custody?.provider === 'turnkey' && custody.policyStatus === 'approved' && custody.healthStatus === 'healthy'
    && Number.isFinite(Date.parse(custody.observedAt)) && Date.parse(custody.observedAt) <= now.getTime()
    && Number.isFinite(Date.parse(custody.expiresAt)) && Date.parse(custody.expiresAt) > now.getTime()
    && custody.policyReference === binding.policyReference && custody.policyDigest === binding.policyDigest && custody.recordDigest === binding.recordDigest
    && operational?.signerReady === true && Number.isFinite(Date.parse(operational.expiresAt)) && Date.parse(operational.expiresAt) > now.getTime();
}

const ROBINHOOD_CASES: readonly RobinhoodNegativeCase[] = ['revert', 'sold_out', 'price_drift', 'insufficient_funds', 'quantity_limit', 'stale_phase', 'fee_recipient', 'kill', 'cap'];
export interface EvidenceApproval { verifierId: string; proof: string; acceptedAt: string; }
export interface EvidenceAuthority { verify(record: ChainEvidenceRecord, approval: EvidenceApproval): boolean; }

export class EvidenceService {
  constructor(private readonly store: BackendStore, private readonly now: () => Date = () => new Date(), private readonly authority?: EvidenceAuthority) {}
  async recordChainEvidence(record: ChainEvidenceRecord): Promise<void> {
    if (!Number.isFinite(Date.parse(record.checkedAt)) || !Number.isFinite(Date.parse(record.expiresAt)) || record.expiresAt <= record.checkedAt || record.sourceBlock < 0n || !record.sourceBlockHash || !record.endpointIdentity || !record.strategyVersion) throw new Error('INVALID_CHAIN_EVIDENCE');
    if(record.strategyVersion===REVIEWED_ERC721_PUBLIC_BASELINE && (Object.keys(record).some(key=>!['id','chainId','status','executionEnabled','seaDropCompatible','positiveLivePath','archiveForkPassed','negativeCases','reconciliationPassed','finalityPassed','endpointIdentity','archiveEndpointIdentity','strategyVersion','checkedAt','expiresAt','sourceBlock','sourceBlockHash','reviewedProtocol'].includes(key)) || Object.keys(record.reviewedProtocol??{}).sort().join(',')!=='descriptorDigests,family,registryDigest'))throw new Error('REVIEWED_PROTOCOL_EVIDENCE_INCOMPLETE');
    if(record.strategyVersion===REVIEWED_ERC721_PUBLIC_BASELINE && (!record.reviewedProtocol || record.reviewedProtocol.family!=='erc721-reviewed-public-v1' || !/^sha256:[0-9a-f]{64}$/.test(record.reviewedProtocol.registryDigest) || !Array.isArray(record.reviewedProtocol.descriptorDigests) || !record.reviewedProtocol.descriptorDigests.length || record.reviewedProtocol.descriptorDigests.length>100 || record.reviewedProtocol.descriptorDigests.some(digest=>!/^sha256:[0-9a-f]{64}$/.test(digest)) || record.seaDropCompatible || !record.archiveForkPassed || !record.reconciliationPassed || !record.finalityPassed || ROBINHOOD_CASES.some(name=>!record.negativeCases[name])))throw new Error('REVIEWED_PROTOCOL_EVIDENCE_INCOMPLETE');
    if(record.strategyVersion!==REVIEWED_ERC721_PUBLIC_BASELINE && record.reviewedProtocol)throw new Error('REVIEWED_PROTOCOL_EVIDENCE_MISLABELED');
    if (record.status !== 'pending' || record.executionEnabled || record.acceptedAt || record.acceptedBy || record.approvalProof) throw new Error('EVIDENCE_MUST_BE_SUBMITTED_PENDING');
    await this.store.transaction(state => {
      if (state.chainEvidence.some(item => item.id === record.id)) throw new Error('CHAIN_EVIDENCE_ALREADY_EXISTS');
      state.chainEvidence.push(structuredClone(record));
    });
  }
  async acceptChainEvidence(id: string, approval: EvidenceApproval): Promise<void> {
    if (!this.authority) throw new Error('EVIDENCE_AUTHORITY_REQUIRED');
    await this.store.transaction(state => {
      const record = state.chainEvidence.find(item => item.id === id); if (!record) throw new Error('CHAIN_EVIDENCE_NOT_FOUND');
      if (record.status !== 'pending') throw new Error('CHAIN_EVIDENCE_ALREADY_DECIDED');
      if (!this.authority!.verify(structuredClone(record), approval)) throw new Error('EVIDENCE_APPROVAL_REJECTED');
      if (record.chainId === 1) for (const previous of state.chainEvidence) if (previous.chainId === 1 && previous.id !== id && (previous.strategyVersion===REVIEWED_ERC721_PUBLIC_BASELINE)===(record.strategyVersion===REVIEWED_ERC721_PUBLIC_BASELINE)) previous.executionEnabled = false;
      record.status = 'accepted'; record.executionEnabled = true; record.acceptedAt = approval.acceptedAt; record.acceptedBy = approval.verifierId; record.approvalProof = approval.proof;
    });
  }
  async recordSimulation(record: SimulationEvidenceRecord): Promise<void> {
    if (!Number.isFinite(Date.parse(record.checkedAt)) || !Number.isFinite(Date.parse(record.expiresAt)) || record.expiresAt <= record.checkedAt || record.sourceBlock < 0n || record.worstCaseFeeWei < 0n || !record.sourceBlockHash || !record.inputDigest) throw new Error('INVALID_SIMULATION_EVIDENCE');
    await this.store.transaction(state => {
      if (state.simulations.some(item => item.id === record.id)) throw new Error('SIMULATION_EVIDENCE_ALREADY_EXISTS');
      state.simulations.push(structuredClone(record));
    });
  }
  assertLiveEvidence(input: ValidatedCampaign): readonly string[] {
    const state = this.store.snapshot(); const verification = input.campaign.chainVerification;
    const evidence = verification.evidenceId ? state.chainEvidence.find(item => item.id === verification.evidenceId) : undefined;
    if (!evidence || evidence.chainId !== input.campaign.chainId) throw new Error('CHAIN_VERIFICATION_EVIDENCE_NOT_FOUND');
    if (evidence.status !== 'accepted' || !evidence.executionEnabled || !evidence.acceptedAt || !evidence.acceptedBy || !evidence.approvalProof) throw new Error('CHAIN_VERIFICATION_NOT_ACCEPTED');
    if (evidence.expiresAt <= this.now().toISOString()) throw new Error('CHAIN_VERIFICATION_EVIDENCE_STALE');
    if (!evidence.endpointIdentity || !evidence.strategyVersion || !evidence.sourceBlockHash || evidence.endpointIdentity !== verification.endpointReference || !strategyCompatible(evidence, input.campaign, state, this.now())) throw new Error('CHAIN_VERIFICATION_PROVENANCE_REQUIRED');
    if (verification.sourceBlock !== evidence.sourceBlock || verification.checkedAt !== evidence.checkedAt) throw new Error('CHAIN_VERIFICATION_SNAPSHOT_MISMATCH');
    if(evidence.strategyVersion===REVIEWED_ERC721_PUBLIC_BASELINE && (!evidence.archiveForkPassed || !evidence.reconciliationPassed || !evidence.finalityPassed || ROBINHOOD_CASES.some(name=>!evidence.negativeCases[name])))throw new Error('REVIEWED_PROTOCOL_EVIDENCE_INCOMPLETE');
    if ((!evidence.seaDropCompatible && evidence.strategyVersion!==REVIEWED_ERC721_PUBLIC_BASELINE) || !evidence.positiveLivePath) throw new Error('SEADROP_EVIDENCE_REQUIRED');
    if (input.campaign.chainId === 4663) {
      if (!evidence.archiveForkPassed || !evidence.reconciliationPassed || !evidence.finalityPassed) throw new Error('ROBINHOOD_SAFETY_EVIDENCE_INCOMPLETE');
      if (ROBINHOOD_CASES.some(name => !evidence.negativeCases[name])) throw new Error('ROBINHOOD_NEGATIVE_EVIDENCE_INCOMPLETE');
    }
    return this.assertWalletSimulations(input.campaign, evidence, input.wallets ?? [], input.simulationIds ?? []);
  }
  private assertWalletSimulations(campaign: Campaign, evidence: ChainEvidenceRecord, wallets: readonly string[], simulationIds: readonly string[]): readonly string[] {
    if (wallets.length === 0 || simulationIds.length !== wallets.length) throw new Error('PER_WALLET_SIMULATION_REQUIRED');
    const state = this.store.snapshot(); const now = this.now().toISOString(); const uniqueWallets = new Set(wallets.map(wallet => wallet.toLowerCase()));
    if (uniqueWallets.size !== wallets.length) throw new Error('DUPLICATE_WALLET');
    if (new Set(simulationIds).size !== simulationIds.length) throw new Error('DUPLICATE_SIMULATION_EVIDENCE');
    for (const wallet of wallets) {
      const simulation = state.simulations.find(item => simulationIds.includes(item.id) && item.campaignId === campaign.id && item.wallet.toLowerCase() === wallet.toLowerCase());
      if (!simulation) throw new Error('WALLET_SIMULATION_NOT_FOUND');
      if (!simulation.inputDigest || !simulation.sourceBlockHash) throw new Error('WALLET_SIMULATION_PROVENANCE_REQUIRED');
      if (simulation.inputDigest !== campaignInputDigest(campaign) || simulation.sourceBlock < evidence.sourceBlock) throw new Error('WALLET_SIMULATION_SNAPSHOT_MISMATCH');
      if (!simulation.success) throw new Error('WALLET_SIMULATION_FAILED');
      if (simulation.expiresAt <= now) throw new Error('WALLET_SIMULATION_STALE');
      if (simulation.worstCaseFeeWei > campaign.spendPolicy.gasCeilingWei) throw new Error('GAS_CEILING_EXCEEDED');
    }
    return [...simulationIds];
  }
}

export function campaignInputDigest(campaign: Campaign): string {
  const value = JSON.stringify({ chainId: campaign.chainId, contract: campaign.contract.toLowerCase(), strategy: campaign.strategy, quantity: campaign.quantity, mintPriceWei: campaign.mintPriceWei.toString(), feePolicy: campaign.feePolicy, custodyPolicy: campaign.custodyPolicy }, (_, item) => typeof item === 'bigint' ? item.toString() : item);
  return createHash('sha256').update(value).digest('hex');
}

export function liveRequestDigest(campaign: Campaign, mode: 'dry-run' | 'live', wallets: readonly string[], simulationIds: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify({ campaign: campaignInputDigest(campaign), mode, wallets: wallets.map(item => item.toLowerCase()).sort(), simulationIds: [...simulationIds].sort() })).digest('hex');
}
