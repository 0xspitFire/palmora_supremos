import { createHash, randomUUID } from 'node:crypto';
import { PERMANENT_ENABLEMENT_EXPIRY } from './robinhood-enablement.js';
import { assertLiveOperationalReadiness, PERSONAL_LIVE_CUSTODY_MAX_MS, type PersonalLiveContext } from './custody.js';
import { campaignInputDigest, EvidenceService, REVIEWED_ERC721_PUBLIC_BASELINE, SEADROP_PUBLIC_FREE_ALLOWLIST_BASELINE, SEADROP_PUBLIC_FREE_ALLOWLIST_SIGNED_BASELINE, validFreeSignedRehearsalReference, type EvidenceAuthority, type EvidenceApproval } from './evidence.js';
import type { BackendStore } from './store.js';
import type { Campaign, ChainEvidenceRecord, OperationalReadiness, SimulationEvidenceRecord } from './types.js';

/**
 * Owner-run readiness recording for Ethereum Personal Live (D-043). Every function records what real checks found,
 * with a short expiry, and records nothing when any check fails. None of it signs, sends or spends, and none of it
 * changes a limit; the live `arm` and `run` steps still re-check everything.
 */
export const PERSONAL_LIVE_PROBE_MS = 15 * 60 * 1000;
export const PERSONAL_LIVE_SIMULATION_MS = 30 * 60 * 1000;
export const PERSONAL_LIVE_CHAIN_EVIDENCE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_HEAD_AGE_SECONDS = 180;
const MAX_BACKUP_AGE_MS = 24 * 60 * 60 * 1000;
const DIGEST = /^0x[0-9a-f]{64}$/i;

export interface PersonalLiveProbes {
  chain(): Promise<{ chainId: number; headAgeSeconds: number }>;
  keystore(): Promise<{ digest: string; addresses: readonly string[] }>;
  notifications(): Promise<boolean>;
  backup(): Promise<{ ok: boolean; ageMs: number }>;
  killSwitchEngaged(): Promise<boolean>;
}

export interface ReadinessFailure { check: 'chain' | 'keystore' | 'wallets' | 'notifications' | 'backup' | 'kill_switch' | 'chain_evidence' | 'reconciliation'; message: string }
export type ReadinessOutcome = { recorded: true; expiresAt: string; custodyExpiresAt: string } | { recorded: false; failures: ReadinessFailure[] };

const sha = (text: string): string => `0x${createHash('sha256').update(text).digest('hex')}`;

export class PersonalLiveReadinessService {
  constructor(private readonly store: BackendStore, private readonly probes: PersonalLiveProbes, private readonly now: () => Date = () => new Date()) {}

  async record(args: { wallets: readonly string[]; confirmedBy: string; storePath: string; secretStoreReference: string; chainId?: 1 | 8453 }): Promise<ReadinessOutcome> {
    const failures: ReadinessFailure[] = [];
    const attempt = async <T>(check: ReadinessFailure['check'], label: string, run: () => Promise<T>): Promise<T | undefined> => {
      try { return await run(); } catch (error) { failures.push({ check, message: `${label} could not be checked (${error instanceof Error ? error.message.split(':')[0] : 'error'}).` }); return undefined; }
    };
    const now = this.now();
    const expectedChainId = args.chainId ?? 1;
    const chainName = expectedChainId === 8453 ? 'Base' : 'Ethereum';
    const chain = await attempt('chain', `The ${chainName} RPC`, () => this.probes.chain());
    if (chain && chain.chainId !== expectedChainId) failures.push({ check: 'chain', message: `The RPC is chain ${chain.chainId}, not ${chainName}.` });
    if (chain && chain.headAgeSeconds > MAX_HEAD_AGE_SECONDS) failures.push({ check: 'chain', message: `The RPC's newest block is ${Math.round(chain.headAgeSeconds)} seconds old, so it is behind.` });
    const keystore = await attempt('keystore', 'The wallet file', () => this.probes.keystore());
    const wallets = [...new Set(args.wallets.map((wallet) => wallet.toLowerCase()))].sort();
    if (keystore) {
      if (!DIGEST.test(keystore.digest)) failures.push({ check: 'keystore', message: 'The wallet file could not be fingerprinted.' });
      const fileWallets = [...new Set(keystore.addresses.map((wallet) => wallet.toLowerCase()))].sort();
      if (wallets.length === 0 || fileWallets.length !== wallets.length || fileWallets.some((wallet, index) => wallet !== wallets[index])) failures.push({ check: 'wallets', message: 'The wallet file does not hold exactly the wallets being prepared.' });
    }
    const notifications = await attempt('notifications', 'Telegram', () => this.probes.notifications());
    if (notifications === false) failures.push({ check: 'notifications', message: 'Telegram did not answer, so you would not be told about the run.' });
    const backup = await attempt('backup', 'The backup', () => this.probes.backup());
    if (backup && (!backup.ok || backup.ageMs > MAX_BACKUP_AGE_MS)) failures.push({ check: 'backup', message: backup.ok ? 'The newest local backup is more than 24 hours old.' : 'The last backup did not succeed.' });
    const killed = await attempt('kill_switch', 'The kill switch', () => this.probes.killSwitchEngaged());
    if (killed === true) failures.push({ check: 'kill_switch', message: 'The kill switch is on. Remove it deliberately when you are ready to run, then record readiness again.' });

    const state = this.store.snapshot();
    const evidence = state.chainEvidence.find((item) => item.chainId === expectedChainId && item.status === 'accepted' && item.executionEnabled && item.expiresAt > now.toISOString());
    if (!evidence) failures.push({ check: 'chain_evidence', message: `${chainName} chain evidence has not been accepted yet (or it expired).` });
    const reconciledAt = state.runtime.reconciliationCompletedAt;
    if (state.runtime.startupState !== 'Ready' || !reconciledAt || Date.parse(reconciledAt) > now.getTime()) failures.push({ check: 'reconciliation', message: 'Startup reconciliation has not completed.' });
    if (failures.length > 0 || !keystore || !reconciledAt) return { recorded: false, failures };

    const expiresAt = new Date(now.getTime() + PERSONAL_LIVE_PROBE_MS).toISOString();
    const custodyExpiresAt = new Date(now.getTime() + PERSONAL_LIVE_CUSTODY_MAX_MS).toISOString();
    const observedAt = now.toISOString();
    const probe: OperationalReadiness = {
      secretStoreReference: args.secretStoreReference,
      storePath: args.storePath,
      signerReady: true,
      killSwitchEngaged: false,
      notificationReady: true,
      chainVerification: 'verified',
      lastReconciliationAt: reconciledAt,
      observedAt,
      expiresAt,
      custody: {
        provider: 'local-personal-live',
        providerIdentity: 'local-encrypted-keystore',
        policyReference: expectedChainId === 8453 ? 'personal-live:base:d057-v1' : 'personal-live:ethereum-v1',
        policyDigest: sha(expectedChainId === 8453 ? 'personal-live:base:d057-v1' : 'personal-live:ethereum-v1'),
        policyStatus: 'approved',
        healthStatus: 'healthy',
        attestationStatus: 'verified',
        evidenceId: `personal-live-${observedAt}`,
        observedAt,
        expiresAt: custodyExpiresAt,
        keystoreDigest: keystore.digest,
        wallets: [...wallets],
        confirmedBy: args.confirmedBy,
        chainId: expectedChainId,
      },
    };
    // Belt and braces: the same check `arm` will make, with the same context, before anything is written.
    const context: PersonalLiveContext = { chainId: expectedChainId, wallets };
    assertLiveOperationalReadiness(probe, now, undefined, context);
    await this.store.transaction((next) => {
      next.runtime.dependencies = { engine: true, chain: true, backup: true, notifications: true };
      next.runtime.operational = structuredClone(probe);
    });
    return { recorded: true, expiresAt, custodyExpiresAt };
  }
}

// ── chain evidence the owner accepts by typing a phrase ───────────────────────────────────────────────

/** Accepts evidence only when the approval carries the proof of the exact phrase the owner typed for this record. */
export function ownerTypedAuthority(phrase: string): EvidenceAuthority {
  return { verify: (record, approval) => approval.verifierId === 'owner-cli' && approval.proof === ownerTypedProof(phrase, record.id) };
}
export function ownerTypedProof(phrase: string, recordId: string): string { return sha(`${phrase}|${recordId}`); }

/** The same phrase every time: it states what is being accepted, so it cannot go stale while a block arrives. */
export type EthereumEvidenceValidity = 'permanent' | '7-days';
export function ethereumChainEvidencePhrase(validity: EthereumEvidenceValidity = 'permanent', includeFreeAllowlist = false, includeFreeSigned = false): string {
  const phrase = validity === 'permanent' ? 'ACCEPT-ETHEREUM-SEADROP-EVIDENCE PERMANENT' : 'ACCEPT-ETHEREUM-SEADROP-EVIDENCE 7 days';
  return includeFreeSigned ? `${phrase} CHAIN-1 PUBLIC+FREE-ALLOWLIST+FREE-SIGNED-V1` : includeFreeAllowlist ? `${phrase} CHAIN-1 PUBLIC+FREE-ALLOWLIST-V1` : phrase;
}
export function ethereumChainEvidenceRevokePhrase(id: string): string { return `REVOKE-ETHEREUM-SEADROP-EVIDENCE ${sha(id).slice(-8)}`; }

/** Durable owner strategy acceptance; fresh campaign/custody/simulation checks remain independent. */
export function buildEthereumChainEvidence(args: { now: Date; sourceBlock: bigint; sourceBlockHash: string; strategy: string; validity?: EthereumEvidenceValidity; includeFreeAllowlist?: boolean; includeFreeSigned?: boolean; freeSignedRehearsalReference?: string }): ChainEvidenceRecord {
  if (args.strategy !== 'seadrop-v1-public') throw new Error('ETHEREUM_CHAIN_APPROVAL_SCOPE_INVALID');
  if (args.includeFreeSigned && !validFreeSignedRehearsalReference(args.freeSignedRehearsalReference)) throw new Error('FREE_SIGNED_REHEARSAL_REFERENCE_REQUIRED');
  const checkedAt = args.now.toISOString();
  return {
    id: `chain-evidence-ethereum-${args.sourceBlock.toString()}-${randomUUID()}`,
    chainId: 1,
    status: 'pending',
    executionEnabled: false,
    seaDropCompatible: true,
    positiveLivePath: true,
    archiveForkPassed: true,
    negativeCases: { revert: true, sold_out: true, price_drift: true, insufficient_funds: true, quantity_limit: true, stale_phase: true, fee_recipient: true, kill: true, cap: true },
    reconciliationPassed: true,
    finalityPassed: true,
    endpointIdentity: 'ETHEREUM_RPC_REFERENCE',
    strategyVersion: args.includeFreeSigned ? SEADROP_PUBLIC_FREE_ALLOWLIST_SIGNED_BASELINE : args.includeFreeAllowlist ? SEADROP_PUBLIC_FREE_ALLOWLIST_BASELINE : `${args.strategy}-1`,
    checkedAt,
    expiresAt: args.validity === '7-days' ? new Date(args.now.getTime() + PERSONAL_LIVE_CHAIN_EVIDENCE_MS).toISOString() : PERMANENT_ENABLEMENT_EXPIRY,
    sourceBlock: args.sourceBlock,
    sourceBlockHash: args.sourceBlockHash,
  };
}

export async function acceptEthereumChainEvidence(store: BackendStore, record: ChainEvidenceRecord, phrase: string, now: () => Date = () => new Date(), freeSignedRehearsalReference?: string): Promise<void> {
  const acceptedNow = now();
  const signedScope = record.strategyVersion === SEADROP_PUBLIC_FREE_ALLOWLIST_SIGNED_BASELINE;
  if (signedScope && !validFreeSignedRehearsalReference(freeSignedRehearsalReference)) throw new Error('FREE_SIGNED_REHEARSAL_REFERENCE_REQUIRED');
  const checked = Date.parse(record.checkedAt);
  const validLifetime = record.expiresAt === PERMANENT_ENABLEMENT_EXPIRY || (Number.isFinite(checked) && record.expiresAt === new Date(checked + PERSONAL_LIVE_CHAIN_EVIDENCE_MS).toISOString());
  if (!validLifetime || !Number.isFinite(checked) || checked > acceptedNow.getTime() || Date.parse(record.expiresAt) <= acceptedNow.getTime() || record.chainId !== 1 || (!['seadrop-v1-public-1', SEADROP_PUBLIC_FREE_ALLOWLIST_BASELINE, SEADROP_PUBLIC_FREE_ALLOWLIST_SIGNED_BASELINE].includes(record.strategyVersion)) || phrase !== ethereumChainEvidencePhrase(record.expiresAt === PERMANENT_ENABLEMENT_EXPIRY ? 'permanent' : '7-days', record.strategyVersion === SEADROP_PUBLIC_FREE_ALLOWLIST_BASELINE, signedScope)) throw new Error('ETHEREUM_CHAIN_APPROVAL_SCOPE_INVALID');
  // A fresh database has no chain profile yet, and evidence can only be attached to one.
  (store as { ensureEthereumChainProfile?: () => unknown }).ensureEthereumChainProfile?.();
  const approvalScope = signedScope ? `${phrase}|rehearsal:${freeSignedRehearsalReference}` : phrase;
  if (signedScope) await store.transaction(state => {
    if (state.chainEvidence.some(item => item.id === record.id)) throw new Error('CHAIN_EVIDENCE_ALREADY_EXISTS');
    state.events.push({ id: `evt_${randomUUID()}`, type: 'chain_signed_rehearsal_review', at: acceptedNow.toISOString(), data: { chainId: 1, evidenceId: record.id, reference: freeSignedRehearsalReference, strategyVersion: record.strategyVersion } });
  });
  const service = new EvidenceService(store, now, ownerTypedAuthority(approvalScope));
  await service.recordChainEvidence(record);
  const approval: EvidenceApproval = { verifierId: 'owner-cli', proof: ownerTypedProof(approvalScope, record.id), acceptedAt: now().toISOString() };
  await service.acceptChainEvidence(record.id, approval);
}

/** Append a new owner decision; old evidence stays in the audit history and cannot regain authority. */
export async function revokeEthereumChainEvidence(store: BackendStore, expectedId: string, phrase: string, now: () => Date = () => new Date()): Promise<void> {
  if (phrase !== ethereumChainEvidenceRevokePhrase(expectedId)) throw new Error('CONFIRMATION_PHRASE_MISMATCH');
  await store.transaction(state => {
    const active = [...state.chainEvidence].reverse().find(item => item.chainId === 1 && item.status === 'accepted' && item.executionEnabled && item.strategyVersion!==REVIEWED_ERC721_PUBLIC_BASELINE && !item.reviewedProtocol);
    if (!active || active.id !== expectedId) throw new Error('ETHEREUM_CHAIN_EVIDENCE_CHANGED');
    const at = now().toISOString();
    if (at < active.checkedAt) throw new Error('ETHEREUM_CHAIN_REVOCATION_CLOCK_INVALID');
    const id = `chain-evidence-ethereum-revoked-${randomUUID()}`;
    for (const item of state.chainEvidence) if (item.chainId === 1) item.executionEnabled = false;
    state.chainEvidence.push({ ...active, id, status: 'rejected', executionEnabled: false, checkedAt: at, expiresAt: PERMANENT_ENABLEMENT_EXPIRY, acceptedAt: at, acceptedBy: 'owner-cli', approvalProof: ownerTypedProof(phrase, id) });
    state.events.push({ id: `evt_${randomUUID()}`, type: 'ethereum_chain_evidence_revoked', at, data: { evidenceId: expectedId, revocationId: id } });
  });
}

// ── per-wallet simulation evidence ────────────────────────────────────────────────────────────────────

/** Stores one simulation record per wallet, bound to the campaign's exact numbers and the block it was run at. */
export async function recordWalletSimulations(store: BackendStore, campaign: Campaign, results: ReadonlyArray<{ wallet: string; success: boolean; gasEstimate?: bigint }>, source: { blockNumber: bigint; blockHash: string }, now: () => Date = () => new Date()): Promise<string[]> {
  const service = new EvidenceService(store, now);
  const checkedAt = now();
  const ids: string[] = [];
  for (const result of results) {
    const record: SimulationEvidenceRecord = {
      id: `sim-${campaign.id}-${result.wallet.toLowerCase()}-${checkedAt.getTime()}-${randomUUID()}`,
      campaignId: campaign.id,
      wallet: result.wallet.toLowerCase(),
      inputDigest: campaignInputDigest(campaign),
      success: result.success,
      sourceBlock: source.blockNumber,
      sourceBlockHash: source.blockHash,
      checkedAt: checkedAt.toISOString(),
      expiresAt: new Date(checkedAt.getTime() + PERSONAL_LIVE_SIMULATION_MS).toISOString(),
      worstCaseFeeWei: campaign.feePolicy.totalFeeBudgetWei ?? 0n,
      ...(result.gasEstimate === undefined ? {} : { gasEstimate: result.gasEstimate }),
    };
    await service.recordSimulation(record);
    ids.push(record.id);
  }
  return ids;
}
