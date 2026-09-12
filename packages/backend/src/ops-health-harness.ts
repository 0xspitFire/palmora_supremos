export interface OpsHealthEnvironment {
  mode?: string;
  secretStoreReference?: string;
  storePath?: string;
  probeTtlMs?: string;
}

export interface OpsHealthValidation { valid: boolean; blockingReasons: string[]; references?: { secretStoreReference: string; storePath: string; probeTtlMs: number }; }

const isReference = (value: string | undefined): value is string => Boolean(value && !/[\r\n]/.test(value) && (value.startsWith('Rets/') || /^[A-Z][A-Z0-9_:-]*$/.test(value)));

export function validateOpsHealthEnvironment(environment: OpsHealthEnvironment, now = new Date()): OpsHealthValidation {
  void now;
  const reasons: string[] = [];
  if (environment.mode !== 'phase1' && environment.mode !== 'robinhood') reasons.push('OPS_HEALTH_MODE_REQUIRED');
  if (!isReference(environment.secretStoreReference)) reasons.push('SECRET_STORE_REFERENCE_REQUIRED');
  if (!environment.storePath || /[\r\n]/.test(environment.storePath)) reasons.push('STORE_PATH_REQUIRED');
  const ttl = Number(environment.probeTtlMs ?? '');
  if (!Number.isFinite(ttl) || ttl <= 0) reasons.push('RUNTIME_PROBE_TTL_REQUIRED');
  if (reasons.length > 0) return { valid: false, blockingReasons: [...new Set(reasons)] };
  return { valid: true, blockingReasons: [], references: { secretStoreReference: environment.secretStoreReference!, storePath: environment.storePath!, probeTtlMs: ttl } };
}
