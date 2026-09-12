import type { BackendStore } from './store.js';
import type { OperationalReadiness } from './types.js';
import { ROBINHOOD_FREE_ACTIVE_PERIOD_CAP_WEI, ROBINHOOD_FREE_PER_WALLET_CAP_WEI, ROBINHOOD_PAID_MINTS_ENABLED } from './policy.js';

export interface HealthReport { live: true; ready: boolean; state: 'Ready' | 'NotReady' | 'Killed'; blockingReasons: string[]; policy: { robinhoodFreePerWalletCapWei: string; robinhoodFreeActivePeriodCapWei: string; robinhoodPaidMintsEnabled: false; }; operational?: OperationalReadiness; checkedAt: string; }
export class HealthService {
  constructor(private readonly store: BackendStore, private readonly now: () => Date = () => new Date()) {}
  check(): HealthReport {
    const state = this.store.snapshot(); const capabilities = this.store.capabilities(); const reasons = [...state.runtime.blockingReasons];
    if (!capabilities.durable) reasons.push('DURABLE_STORE_REQUIRED');
    if (!capabilities.atomicAcrossProcesses) reasons.push('ATOMIC_STORE_REQUIRED');
    if (state.runtime.startupState !== 'Ready') reasons.push('STARTUP_RECONCILIATION_REQUIRED');
    if (!state.runtime.dependencies.engine) reasons.push('ENGINE_NOT_READY');
    if (!state.runtime.dependencies.chain) reasons.push('CHAIN_NOT_READY');
    if (!state.runtime.dependencies.backup) reasons.push('BACKUP_NOT_READY');
    if (!state.runtime.dependencies.notifications) reasons.push('NOTIFICATIONS_NOT_READY');
    const operational = state.runtime.operational;
    if (!operational) reasons.push('RUNTIME_PROBE_REQUIRED');
    else {
      if (!operational.secretStoreReference) reasons.push('SECRET_STORE_REFERENCE_REQUIRED');
      if (!operational.storePath) reasons.push('STORE_PATH_REQUIRED');
      if (!operational.signerReady) reasons.push('SIGNER_NOT_READY');
      if (operational.killSwitchEngaged) reasons.push('KILL_SWITCH_ENGAGED');
      if (!operational.notificationReady) reasons.push('NOTIFICATION_NOT_READY');
      if (operational.chainVerification !== 'verified') reasons.push('CHAIN_VERIFICATION_REQUIRED');
      if (operational.expiresAt <= this.now().toISOString()) reasons.push('RUNTIME_PROBE_STALE');
      if (!operational.lastReconciliationAt || operational.lastReconciliationAt > this.now().toISOString()) reasons.push('RECONCILIATION_REQUIRED');
    }
    if (state.runs.some(run => ['Armed', 'Active'].includes(run.state) && state.reconciliations.filter(item => item.runId === run.id).at(-1)?.result === 'unknown')) reasons.push('UNRESOLVED_EXECUTIONS');
    if (state.chainEvidence.some(item => item.status === 'accepted' && item.expiresAt <= this.now().toISOString())) reasons.push('STALE_CHAIN_EVIDENCE');
    if (state.notificationOutbox.some(item => item.state !== 'delivered' && item.attempts > 0)) reasons.push('NOTIFICATION_DELIVERY_DEGRADED');
    if (state.killed) reasons.push('KILLED');
    const blockingReasons = [...new Set(reasons)];
    return { live: true, ready: blockingReasons.length === 0, state: state.killed ? 'Killed' : blockingReasons.length === 0 ? 'Ready' : 'NotReady', blockingReasons, policy: { robinhoodFreePerWalletCapWei: ROBINHOOD_FREE_PER_WALLET_CAP_WEI.toString(), robinhoodFreeActivePeriodCapWei: ROBINHOOD_FREE_ACTIVE_PERIOD_CAP_WEI.toString(), robinhoodPaidMintsEnabled: ROBINHOOD_PAID_MINTS_ENABLED }, ...(operational ? { operational: { ...operational } } : {}), checkedAt: this.now().toISOString() };
  }
}
