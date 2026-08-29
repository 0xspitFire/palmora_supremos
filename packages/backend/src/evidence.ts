import { createHash } from 'node:crypto';
import type { BackendStore } from './store.js';
import type { Campaign, ChainEvidenceRecord, RobinhoodNegativeCase, SimulationEvidenceRecord, ValidatedCampaign } from './types.js';

const ROBINHOOD_CASES: readonly RobinhoodNegativeCase[] = ['revert', 'sold_out', 'price_drift', 'insufficient_funds', 'quantity_limit', 'stale_phase', 'fee_recipient', 'kill', 'cap'];
export interface EvidenceApproval { verifierId: string; proof: string; acceptedAt: string; }
export interface EvidenceAuthority { verify(record: ChainEvidenceRecord, approval: EvidenceApproval): boolean; }

export class EvidenceService {
  constructor(private readonly store: BackendStore, private readonly now: () => Date = () => new Date(), private readonly authority?: EvidenceAuthority) {}
  async recordChainEvidence(record: ChainEvidenceRecord): Promise<void> {
    if (!Number.isFinite(Date.parse(record.checkedAt)) || !Number.isFinite(Date.parse(record.expiresAt)) || record.expiresAt <= record.checkedAt || record.sourceBlock < 0n || !record.sourceBlockHash || !record.endpointIdentity || !record.strategyVersion) throw new Error('INVALID_CHAIN_EVIDENCE');
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
    if (!evidence.endpointIdentity || !evidence.strategyVersion || !evidence.sourceBlockHash || evidence.endpointIdentity !== verification.endpointReference || !evidence.strategyVersion.startsWith(input.campaign.strategy)) throw new Error('CHAIN_VERIFICATION_PROVENANCE_REQUIRED');
    if (verification.sourceBlock !== evidence.sourceBlock || verification.checkedAt !== evidence.checkedAt) throw new Error('CHAIN_VERIFICATION_SNAPSHOT_MISMATCH');
    if (!evidence.seaDropCompatible || !evidence.positiveLivePath) throw new Error('SEADROP_EVIDENCE_REQUIRED');
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
  const value = JSON.stringify({ chainId: campaign.chainId, contract: campaign.contract.toLowerCase(), strategy: campaign.strategy, quantity: campaign.quantity, mintPriceWei: campaign.mintPriceWei.toString(), feePolicy: campaign.feePolicy }, (_, item) => typeof item === 'bigint' ? item.toString() : item);
  return createHash('sha256').update(value).digest('hex');
}

export function liveRequestDigest(campaign: Campaign, mode: 'dry-run' | 'live', wallets: readonly string[], simulationIds: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify({ campaign: campaignInputDigest(campaign), mode, wallets: wallets.map(item => item.toLowerCase()).sort(), simulationIds: [...simulationIds].sort() })).digest('hex');
}
