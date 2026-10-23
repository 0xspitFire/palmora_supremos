export const BASE_EVIDENCE_STEPS = ['reviewedCode', 'forkRehearsal', 'finality', 'endpointAgreement', 'feeObservation', 'liveSimulation', 'custodyReadiness'] as const;
export type BaseEvidenceStep = typeof BASE_EVIDENCE_STEPS[number];
/** D-062 item 3: the two extra keys a paid Base record must carry. */
export const BASE_PAID_EVIDENCE_STEPS = ['paidRehearsal', 'paidPolicyApproved'] as const;
export type BasePaidEvidenceStep = typeof BASE_PAID_EVIDENCE_STEPS[number];

export interface BaseEnablement {
  readonly recordId: string;
  readonly approvedBy: 'owner-cli';
  readonly approvedAt: string;
  readonly expiresAt: string;
  readonly freeAllowed: true;
  readonly paidAllowed: boolean;
  readonly evidence: Readonly<Record<BaseEvidenceStep, true> & Partial<Record<BasePaidEvidenceStep, true>>>;
  readonly evidenceDigest: string;
  readonly strategyVersion: string;
  readonly feePolicyVersion: string;
  readonly primaryEndpointReference: string;
  readonly fallbackEndpointReference: string;
  readonly custodyMode: 'local-personal-live';
}

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const time = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

export function validBaseEnablement(value: unknown, now: Date): BaseEnablement | undefined {
  if (!object(value)) return undefined;
  const allowed = new Set(['recordId', 'approvedBy', 'approvedAt', 'expiresAt', 'freeAllowed', 'paidAllowed', 'evidence', 'evidenceDigest', 'strategyVersion', 'feePolicyVersion', 'primaryEndpointReference', 'fallbackEndpointReference', 'custodyMode']);
  if (Object.keys(value).some((key) => !allowed.has(key))) return undefined;
  if (typeof value['recordId'] !== 'string' || value['approvedBy'] !== 'owner-cli' || value['freeAllowed'] !== true || typeof value['paidAllowed'] !== 'boolean') return undefined;
  if (!time(value['approvedAt']) || !time(value['expiresAt']) || Date.parse(value['approvedAt']) > now.getTime() || Date.parse(value['expiresAt']) <= now.getTime()) return undefined;
  const steps: readonly string[] = value['paidAllowed'] === true ? [...BASE_EVIDENCE_STEPS, ...BASE_PAID_EVIDENCE_STEPS] : BASE_EVIDENCE_STEPS;
  if (!object(value['evidence']) || Object.keys(value['evidence']).length !== steps.length || steps.some((step) => !Object.hasOwn(value['evidence'] as object, step) || (value['evidence'] as Record<string, unknown>)[step] !== true)) return undefined;
  if (typeof value['evidenceDigest'] !== 'string' || !/^[0-9a-f]{64}$/.test(value['evidenceDigest'])) return undefined;
  if (typeof value['strategyVersion'] !== 'string' || typeof value['feePolicyVersion'] !== 'string' || !value['strategyVersion'] || !value['feePolicyVersion']) return undefined;
  if (typeof value['primaryEndpointReference'] !== 'string' || typeof value['fallbackEndpointReference'] !== 'string' || value['primaryEndpointReference'] === value['fallbackEndpointReference']) return undefined;
  if (value['custodyMode'] !== 'local-personal-live') return undefined;
  return value as unknown as BaseEnablement;
}

export function assertBaseLiveAllowed(kind: 'free' | 'paid', enablement: unknown, now: Date): void {
  const valid = validBaseEnablement(enablement, now);
  if (!valid || (kind === 'paid' && !valid.paidAllowed)) throw new Error(kind === 'paid' ? 'BASE_PAID_MINTS_DISABLED' : 'BASE_EXECUTION_DISABLED');
}

/** Canonical boundary for D-057's first one-wallet/one-NFT proof. */
export function assertBaseFirstRehearsal(input: { completed: boolean; outstanding: boolean; walletCount: number; quantity: number }): void {
  if (input.completed) return;
  if (input.outstanding) throw new Error('BASE_FIRST_REHEARSAL_PENDING_FINALIZATION');
  if (input.walletCount !== 1) throw new Error('BASE_FIRST_REHEARSAL_REQUIRES_ONE_WALLET');
  if (input.quantity !== 1) throw new Error('BASE_FIRST_REHEARSAL_REQUIRES_ONE_NFT');
}
