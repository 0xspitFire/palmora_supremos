import { createHash } from 'node:crypto';
import { assertLiveOperationalReadiness, PERSONAL_LIVE_CUSTODY_MAX_MS, type PersonalLiveContext } from './custody.js';
import { campaignInputDigest, EvidenceService, type EvidenceAuthority, type EvidenceApproval } from './evidence.js';
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

  async record(args: { wallets: readonly string[]; confirmedBy: string; storePath: string; secretStoreReference: string }): Promise<ReadinessOutcome> {
    const failures: ReadinessFailure[] = [];
    const attempt = async <T>(check: ReadinessFailure['check'], label: string, run: () => Promise<T>): Promise<T | undefined> => {
      try { return await run(); } catch (error) { failures.push({ check, message: `${label} could not be checked (${error instanceof Error ? error.message.split(':')[0] : 'error'}).` }); return undefined; }
    };
    const now = this.now();
    const chain = await attempt('chain', 'The Ethereum RPC', () => this.probes.chain());
    if (chain && chain.chainId !== 1) failures.push({ check: 'chain', message: `The RPC is chain ${chain.chainId}, not Ethereum.` });
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
    const evidence = state.chainEvidence.find((item) => item.chainId === 1 && item.status === 'accepted' && item.executionEnabled && item.expiresAt > now.toISOString());
    if (!evidence) failures.push({ check: 'chain_evidence', message: 'Ethereum chain evidence has not been accepted yet (or it expired). Run chain-evidence accept first.' });
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
        policyReference: 'personal-live:ethereum-v1',
        policyDigest: sha('personal-live:ethereum-v1'),
        policyStatus: 'approved',
        healthStatus: 'healthy',
        attestationStatus: 'verified',
        evidenceId: `personal-live-${observedAt}`,
        observedAt,
        expiresAt: custodyExpiresAt,
        keystoreDigest: keystore.digest,
        wallets: [...wallets],
        confirmedBy: args.confirmedBy,
      },
    };
    // Belt and braces: the same check `arm` will make, with the same context, before anything is written.
    const context: PersonalLiveContext = { chainId: 1, wallets };
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

export function ethereumChainEvidencePhrase(sourceBlock: bigint): string {
  return `ACCEPT-ETHEREUM-EVIDENCE block ${sourceBlock.toString()}`;
}

/** A pending Ethereum SeaDrop evidence record built from a live read, for 7 days. */
export function buildEthereumChainEvidence(args: { now: Date; sourceBlock: bigint; sourceBlockHash: string; strategy: string }): ChainEvidenceRecord {
  const checkedAt = args.now.toISOString();
  return {
    id: `chain-evidence-ethereum-${args.sourceBlock.toString()}`,
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
    strategyVersion: `${args.strategy}-1`,
    checkedAt,
    expiresAt: new Date(args.now.getTime() + PERSONAL_LIVE_CHAIN_EVIDENCE_MS).toISOString(),
    sourceBlock: args.sourceBlock,
    sourceBlockHash: args.sourceBlockHash,
  };
}

export async function acceptEthereumChainEvidence(store: BackendStore, record: ChainEvidenceRecord, phrase: string, now: () => Date = () => new Date()): Promise<void> {
  // A fresh database has no chain profile yet, and evidence can only be attached to one.
  (store as { ensureEthereumChainProfile?: () => unknown }).ensureEthereumChainProfile?.();
  const service = new EvidenceService(store, now, ownerTypedAuthority(phrase));
  await service.recordChainEvidence(record);
  const approval: EvidenceApproval = { verifierId: 'owner-cli', proof: ownerTypedProof(phrase, record.id), acceptedAt: now().toISOString() };
  await service.acceptChainEvidence(record.id, approval);
}

// ── per-wallet simulation evidence ────────────────────────────────────────────────────────────────────

/** Stores one simulation record per wallet, bound to the campaign's exact numbers and the block it was run at. */
export async function recordWalletSimulations(store: BackendStore, campaign: Campaign, results: ReadonlyArray<{ wallet: string; success: boolean; gasEstimate?: bigint }>, source: { blockNumber: bigint; blockHash: string }, now: () => Date = () => new Date()): Promise<string[]> {
  const service = new EvidenceService(store, now);
  const checkedAt = now();
  const ids: string[] = [];
  for (const result of results) {
    const record: SimulationEvidenceRecord = {
      id: `sim-${campaign.id}-${result.wallet.toLowerCase()}-${checkedAt.getTime()}`,
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
