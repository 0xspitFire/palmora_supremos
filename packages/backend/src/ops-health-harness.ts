import type { ChainVerificationStatus, OperationalReadiness } from './types.js';

export interface OpsHealthEnvironment {
  mode?: string;
  secretStoreReference?: string;
  storePath?: string;
  signerReady?: string;
  killSwitchEngaged?: string;
  notificationReady?: string;
  chainVerification?: string;
  lastReconciliationAt?: string;
  probeTtlMs?: string;
  engineReady?: string;
  chainReady?: string;
  backupReady?: string;
  atomicStoreReady?: string;
}

export interface OpsHealthValidation { valid: boolean; blockingReasons: string[]; probe?: OperationalReadiness; }

const isBoolean = (value: string | undefined, expected: 'true' | 'false'): boolean => value === expected;
const isReference = (value: string | undefined): value is string => Boolean(value && /^[A-Z][A-Z0-9_:-]*$/.test(value));

export function validateOpsHealthEnvironment(environment: OpsHealthEnvironment, now = new Date()): OpsHealthValidation {
  const reasons: string[] = [];
  if (environment.mode !== 'non-production') reasons.push('OPS_HEALTH_MODE_REQUIRED');
  if (!isReference(environment.secretStoreReference)) reasons.push('SECRET_STORE_REFERENCE_REQUIRED');
  if (!environment.storePath || /[\r\n]/.test(environment.storePath)) reasons.push('STORE_PATH_REQUIRED');
  if (!isBoolean(environment.signerReady, 'true')) reasons.push('SIGNER_NOT_READY');
  if (!isBoolean(environment.killSwitchEngaged, 'false')) reasons.push('KILL_SWITCH_ENGAGED');
  if (!isBoolean(environment.notificationReady, 'true')) reasons.push('NOTIFICATION_NOT_READY');
  if (environment.chainVerification !== 'verified') reasons.push('CHAIN_VERIFICATION_REQUIRED');
  if (!isBoolean(environment.engineReady, 'true')) reasons.push('ENGINE_NOT_READY');
  if (!isBoolean(environment.chainReady, 'true')) reasons.push('CHAIN_NOT_READY');
  if (!isBoolean(environment.backupReady, 'true')) reasons.push('BACKUP_NOT_READY');
  if (!isBoolean(environment.atomicStoreReady, 'true')) reasons.push('ATOMIC_STORE_NOT_READY');
  const ttl = Number(environment.probeTtlMs ?? '');
  const reconciliation = environment.lastReconciliationAt ? Date.parse(environment.lastReconciliationAt) : NaN;
  if (!Number.isFinite(ttl) || ttl <= 0) reasons.push('RUNTIME_PROBE_TTL_REQUIRED');
  if (!Number.isFinite(reconciliation) || now.getTime() - reconciliation < 0 || now.getTime() - reconciliation > ttl) reasons.push('RECONCILIATION_STALE');
  if (reasons.length > 0) return { valid: false, blockingReasons: [...new Set(reasons)] };
  const observedAt = now.toISOString();
  return {
    valid: true,
    blockingReasons: [],
    probe: {
      secretStoreReference: environment.secretStoreReference!,
      storePath: environment.storePath!,
      signerReady: true,
      killSwitchEngaged: false,
      notificationReady: true,
      chainVerification: environment.chainVerification as ChainVerificationStatus,
      lastReconciliationAt: environment.lastReconciliationAt!,
      observedAt,
      expiresAt: new Date(now.getTime() + ttl).toISOString(),
    },
  };
}
