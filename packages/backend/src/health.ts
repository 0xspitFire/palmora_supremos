import type { BackendStore } from './store.js';
import type { BackendState, OperationalReadiness } from './types.js';
import { ROBINHOOD_FREE_ACTIVE_PERIOD_CAP_WEI, ROBINHOOD_FREE_PER_WALLET_CAP_WEI } from './policy.js';
import { validRobinhoodEnablement } from './robinhood-enablement.js';
import { assertLiveOperationalReadiness, type CustodyPolicyBinding } from './custody.js';
import { COMPENSATING_ASSURANCE_KIND, COMPENSATING_OBSERVATION_MAX_AGE_MS, type CompensatingAssuranceConfig } from './compensating-controls.js';
import { unresolvedRunIds } from './kill-switch-release.js';

export interface LiveReadinessHealth {
  required: boolean;
  state: 'NotChecked' | 'Ready' | 'NotReady';
  message: string;
}
export interface HealthReport { live: true; ready: boolean; state: 'Ready' | 'NotReady' | 'Killed'; blockingReasons: string[]; policy: { robinhoodFreePerWalletCapWei: string; robinhoodFreeActivePeriodCapWei: string; robinhoodPaidMintsEnabled: boolean; }; liveReadiness: LiveReadinessHealth; operational?: OperationalReadiness; checkedAt: string; }

/** Presentation scope only. Live arm/run independently refresh and enforce all existing gates. */
export function requiresLiveRuntimeProbe(state: BackendState): boolean {
  const campaigns = new Map(state.campaigns.map(campaign => [campaign.id, campaign]));
  const runs = new Map(state.runs.map(run => [run.id, run]));
  if (state.campaigns.some(campaign => !campaign.dryRun && ['Armed', 'Active', 'Paused'].includes(campaign.state))) return true;
  if (state.runs.some(run => run.mode !== 'dry-run' && ['Armed', 'Active', 'Paused'].includes(run.state))) return true;
  if (state.reservations.some(item => ['reserved', 'reorged'].includes(item.status) && runs.get(item.runId)?.mode !== 'dry-run')) return true;
  if (unresolvedRunIds(state).some(id => runs.get(id)?.mode !== 'dry-run')) return true;
  return state.jobs.some(job => {
    if (job.kind !== 'execute' || !['scheduled', 'running'].includes(job.state)) return false;
    const run = job.runId ? runs.get(job.runId) : undefined;
    const campaign = campaigns.get(job.campaignId ?? run?.campaignId ?? '');
    // Missing or contradictory execution context cannot establish a practice job.
    return run?.mode === 'live' || campaign?.dryRun === false || !(run?.mode === 'dry-run' || campaign?.dryRun === true);
  });
}

/** Current service facts, independent of a historical campaign-specific probe. */
export function serviceHealthBlockingReasons(state: BackendState, now: Date): string[] {
  const reasons = [...state.runtime.blockingReasons];
  const reconciledAt = Date.parse(state.runtime.reconciliationCompletedAt ?? '');
  if (!Number.isFinite(reconciledAt) || reconciledAt > now.getTime() || ['Cold', 'Reconciling'].includes(state.runtime.startupState)) reasons.push('STARTUP_RECONCILIATION_REQUIRED');
  else if (state.runtime.startupState !== 'Ready' && reasons.length === 0) reasons.push('DEPLOYMENT_NOT_READY');
  for (const [name, ready] of Object.entries(state.runtime.dependencies)) if (!ready) reasons.push(`${name.toUpperCase()}_NOT_READY`);
  if (state.runs.some(run => ['Armed', 'Active'].includes(run.state) && state.reconciliations.filter(item => item.runId === run.id).at(-1)?.result === 'unknown')) reasons.push('UNRESOLVED_EXECUTIONS');
  if (state.chainEvidence.some(item => item.status === 'accepted' && item.executionEnabled && item.expiresAt <= now.toISOString())) reasons.push('STALE_CHAIN_EVIDENCE');
  if (state.notificationOutbox.some(item => item.state !== 'delivered' && item.attempts > 0)) reasons.push('NOTIFICATION_DELIVERY_DEGRADED');
  if (state.killed) reasons.push('KILLED');
  return [...new Set(reasons)];
}

/** Observable fields only: no expected policy, balance ceiling or acceptance is inferred from evidence. */
function unassessedCompensatedCustodyReasons(operational: OperationalReadiness, now: Date): string[] {
  const custody = operational.custody;
  if (!custody) return ['CUSTODY_EVIDENCE_REQUIRED'];
  const reasons: string[] = [];
  const reference = (value: unknown): boolean => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\r\n]|private|secret|credential|token|password|mnemonic|seed|api[_-]?key/i.test(value);
  const digest = (value: unknown): boolean => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/i.test(value);
  const current = (observed: unknown, expires?: unknown, expiryOptional = false): boolean => {
    const at = typeof observed === 'string' ? Date.parse(observed) : NaN;
    const until = expires === undefined && expiryOptional ? Infinity : typeof expires === 'string' ? Date.parse(expires) : NaN;
    return Number.isFinite(at) && at <= now.getTime() && until > now.getTime() && until > at;
  };
  if (custody.provider !== 'turnkey') reasons.push('CUSTODY_COMPENSATING_ASSURANCE_PROVIDER_MISMATCH');
  if (!reference(custody.providerIdentity)) reasons.push('CUSTODY_PROVIDER_IDENTITY_REQUIRED');
  if (!reference(custody.policyReference)) reasons.push('CUSTODY_POLICY_REFERENCE_REQUIRED');
  else if (!/^turnkey[:\/-]/i.test(custody.policyReference)) reasons.push('CUSTODY_POLICY_PROVIDER_MISMATCH');
  if (!/^0x[0-9a-f]{64}$/i.test(custody.policyDigest ?? '')) reasons.push('CUSTODY_POLICY_DIGEST_REQUIRED');
  if (!digest(custody.recordDigest)) reasons.push('CUSTODY_POLICY_RECORD_DIGEST_REQUIRED');
  if (custody.policyStatus !== 'approved') reasons.push('CUSTODY_POLICY_NOT_APPROVED');
  if (custody.healthStatus !== 'healthy') reasons.push('CUSTODY_HEALTH_NOT_READY');
  if (custody.attestationStatus === 'verified') reasons.push('CUSTODY_COMPENSATED_MUST_NOT_CLAIM_TVC');
  else if (!['unknown', 'failed'].includes(custody.attestationStatus)) reasons.push('CUSTODY_ATTESTATION_REQUIRED');
  if (!reference(custody.evidenceId)) reasons.push('CUSTODY_EVIDENCE_ID_REQUIRED');
  if (!current(custody.observedAt, custody.expiresAt)) reasons.push('CUSTODY_EVIDENCE_STALE');
  const controls = custody.compensatingControls;
  if (!controls || controls.version !== 1 || ![1, 8453, 4663].includes(controls.chainId)
    || !digest(controls.recordDigest) || controls.recordDigest !== custody.recordDigest || !digest(controls.walletSetDigest) || !digest(controls.lockfileDigest)) {
    reasons.push('CUSTODY_COMPENSATING_OBSERVATION_INVALID');
  } else {
    // Check observable omissions, contradictions and time bounds, without
    // asserting the six controls against any untrusted/self-derived settings.
    if (!controls.balances || !Array.isArray(controls.balances.wallets) || controls.balances.wallets.length === 0
      || controls.balances.wallets.some(wallet => !wallet || typeof wallet.address !== 'string' || !/^0x[0-9a-f]{40}$/i.test(wallet.address) || typeof wallet.balanceWei !== 'string' || !/^\d{1,40}$/.test(wallet.balanceWei))
      || !current(controls.balances.observedAt, controls.balances.expiresAt)
      || now.getTime() - Date.parse(controls.balances.observedAt) > COMPENSATING_OBSERVATION_MAX_AGE_MS) reasons.push('COMPENSATING_CONTROL_BOUNDED_BALANCES_STALE');
    if (!controls.policyRecord || controls.policyRecord.digest !== custody.recordDigest || !current(controls.policyRecord.issuedAt, controls.policyRecord.expiresAt)) reasons.push('COMPENSATING_CONTROL_POLICY_RECORD_INVALID');
    if (!controls.providerProbe || controls.providerProbe.status !== 'ok' || controls.providerProbe.policyRecordDigest !== custody.recordDigest
      || !current(controls.providerProbe.observedAt, undefined, true) || now.getTime() - Date.parse(controls.providerProbe.observedAt) > COMPENSATING_OBSERVATION_MAX_AGE_MS) reasons.push('COMPENSATING_CONTROL_PROVIDER_PROBE_STALE');
    if (controls.signatureChecks?.transactionMatch !== true || controls.signatureChecks.signerRecovery !== true) reasons.push('COMPENSATING_CONTROL_SIGNATURE_VERIFICATION_NOT_ENFORCED');
    if (!controls.rehearsal || controls.rehearsal.broadcastAttempted !== false || !current(controls.rehearsal.recordedAt, undefined, true)
      || controls.rehearsal.policyRecordDigest !== custody.recordDigest || controls.rehearsal.walletSetDigest !== controls.walletSetDigest || controls.rehearsal.lockfileDigest !== controls.lockfileDigest
      || Date.parse(controls.rehearsal.recordedAt) < Date.parse(controls.policyRecord?.issuedAt ?? '')) reasons.push('COMPENSATING_CONTROL_REHEARSAL_INVALID');
    if (controls.driftResponse?.killSwitchOnDrift !== true) reasons.push('COMPENSATING_CONTROL_DRIFT_RESPONSE_NOT_ENFORCED');
  }
  return reasons;
}

export interface LiveProbeAssessment { reasons: string[]; custodyAssessed: boolean; }
export function assessLiveRuntimeProbe(operational: OperationalReadiness | undefined, now: Date, expected?: CustodyPolicyBinding, assurance?: CompensatingAssuranceConfig): LiveProbeAssessment {
  if (!operational) return { reasons: ['RUNTIME_PROBE_REQUIRED'], custodyAssessed: false };
  const reasons: string[] = [];
  if (!operational.secretStoreReference) reasons.push('SECRET_STORE_REFERENCE_REQUIRED');
  if (!operational.storePath) reasons.push('STORE_PATH_REQUIRED');
  if (operational.signerReady !== true) reasons.push('SIGNER_NOT_READY');
  if (operational.killSwitchEngaged) reasons.push('KILL_SWITCH_ENGAGED');
  if (!operational.notificationReady) reasons.push('NOTIFICATION_NOT_READY');
  if (operational.chainVerification !== 'verified') reasons.push('CHAIN_VERIFICATION_REQUIRED');
  const expiresAt = Date.parse(operational.expiresAt);
  const observedAt = Date.parse(operational.observedAt);
  if (!Number.isFinite(expiresAt) || !Number.isFinite(observedAt) || expiresAt <= now.getTime() || observedAt > now.getTime()) reasons.push('RUNTIME_PROBE_STALE');
  const reconciledAt = Date.parse(operational.lastReconciliationAt);
  if (!Number.isFinite(reconciledAt) || reconciledAt > now.getTime()) reasons.push('RECONCILIATION_REQUIRED');
  const custodyAssessed = !(operational.custody?.assuranceKind === COMPENSATING_ASSURANCE_KIND && expected === undefined);
  if (!custodyAssessed) reasons.push(...unassessedCompensatedCustodyReasons(operational, now));
  else try { assertLiveOperationalReadiness(operational, now, expected, undefined, assurance ? { config: assurance, ...(operational.custody?.compensatingControls ? { chainId: operational.custody.compensatingControls.chainId } : {}) } : undefined); }
  catch (error) { reasons.push(error instanceof Error ? error.message : 'CUSTODY_READINESS_REQUIRED'); }
  return { reasons: [...new Set(reasons)], custodyAssessed };
}

export function liveProbeBlockingReasons(operational: OperationalReadiness | undefined, now: Date, expected?: CustodyPolicyBinding, assurance?: CompensatingAssuranceConfig): string[] {
  return assessLiveRuntimeProbe(operational, now, expected, assurance).reasons;
}

export function liveReadinessHealth(required: boolean, reasons: readonly string[], custodyAssessed = true): LiveReadinessHealth {
  if (required && reasons.length === 0 && !custodyAssessed) return { required, state: 'NotChecked', message: 'Service and probe checks passed; custody authorization is not assessed by this endpoint without trusted policy and assurance configuration. Live arm and execution still require full verification.' };
  return required
    ? { required, state: reasons.length === 0 ? 'Ready' : 'NotReady', message: reasons.length === 0 ? 'Current live context has operational evidence; arm and execution still enforce their full checks.' : 'Live work requires current operational evidence before arming or execution.' }
    : { required, state: 'NotChecked', message: 'Idle service readiness does not authorize a mint. Fresh campaign, custody, simulation and spending checks run during preparation and arming.' };
}

export class HealthService {
  constructor(private readonly store: BackendStore, private readonly now: () => Date = () => new Date(), private readonly compensatingAssurance?: CompensatingAssuranceConfig, private readonly expectedCustodyPolicy?: CustodyPolicyBinding) {}
  check(): HealthReport {
    const state = this.store.snapshot(); const capabilities = this.store.capabilities(); const now = this.now();
    const reasons = serviceHealthBlockingReasons(state, now);
    if (!capabilities.durable) reasons.push('DURABLE_STORE_REQUIRED');
    if (!capabilities.atomicAcrossProcesses) reasons.push('ATOMIC_STORE_REQUIRED');
    const operational = state.runtime.operational;
    const required = requiresLiveRuntimeProbe(state);
    const assessment = required ? assessLiveRuntimeProbe(operational, now, this.expectedCustodyPolicy, this.compensatingAssurance) : { reasons: [], custodyAssessed: false };
    const probeReasons = assessment.reasons;
    reasons.push(...probeReasons);
    const blockingReasons = [...new Set(reasons)];
    const killed = blockingReasons.some(reason => reason === 'KILL_SWITCH_ENGAGED' || reason === 'KILLED');
    const robinhood = validRobinhoodEnablement((this.store as BackendStore & { robinhoodEnablement?: () => unknown }).robinhoodEnablement?.(), now);
    return { live: true, ready: blockingReasons.length === 0, state: killed ? 'Killed' : blockingReasons.length === 0 ? 'Ready' : 'NotReady', blockingReasons, liveReadiness: liveReadinessHealth(required, probeReasons, assessment.custodyAssessed), policy: { robinhoodFreePerWalletCapWei: ROBINHOOD_FREE_PER_WALLET_CAP_WEI.toString(), robinhoodFreeActivePeriodCapWei: ROBINHOOD_FREE_ACTIVE_PERIOD_CAP_WEI.toString(), robinhoodPaidMintsEnabled: robinhood?.paidAllowed === true }, ...(operational ? { operational: { ...operational } } : {}), checkedAt: now.toISOString() };
  }
}
