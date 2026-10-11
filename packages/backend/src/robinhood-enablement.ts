/**
 * Robinhood live enablement, the single decision (D-040, D-041, T-032).
 *
 * Robinhood (4663) live execution stays refused unless BOTH keys exist:
 *   Key 1: this reviewed code.
 *   Key 2: a record the owner wrote with a typed confirmation, not expired, showing that every evidence step passed.
 * Every refusal site calls these functions, so there is one place that says yes. With no record, or an invalid, expired or
 * incomplete one, the answer is no, with the same error codes the sites used before. This module reads nothing and writes
 * nothing: it only judges the value it is given. No setting, flag or environment variable can enable Robinhood.
 */
export const ROBINHOOD_EVIDENCE_STEPS = ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7'] as const;
export type RobinhoodEvidenceStep = typeof ROBINHOOD_EVIDENCE_STEPS[number];

/** Key 2, as the engine and the backend receive it. */
export interface RobinhoodEnablement {
  readonly recordId: string;
  readonly approvedBy: 'owner-cli';
  readonly approvedAt: string;
  readonly expiresAt: string;
  /** True only when the paid rehearsal passed and the owner approved the paid policy (D-040 item 4, D-041). */
  readonly paidAllowed: boolean;
  /** Every step must be exactly true. */
  readonly evidence: Readonly<Record<RobinhoodEvidenceStep, true>>;
}

const PLAIN_OBJECT = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const TIME = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

/**
 * Returns the record only if it is complete, well formed, written by the owner command, already approved and not expired.
 * Anything else, including extra fields, returns undefined. Never throws.
 */
export function validRobinhoodEnablement(value: unknown, now: Date): RobinhoodEnablement | undefined {
  try { return judge(value, now); } catch { return undefined; }
}

function judge(value: unknown, now: Date): RobinhoodEnablement | undefined {
  if (!PLAIN_OBJECT(value)) return undefined;
  const allowedKeys = new Set(['recordId', 'approvedBy', 'approvedAt', 'expiresAt', 'paidAllowed', 'evidence']);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return undefined;
  const { recordId, approvedBy, approvedAt, expiresAt, paidAllowed, evidence } = value;
  if (typeof recordId !== 'string' || recordId.length === 0 || recordId.length > 200) return undefined;
  if (approvedBy !== 'owner-cli') return undefined;
  if (!TIME(approvedAt) || !TIME(expiresAt)) return undefined;
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) return undefined;
  if (Date.parse(approvedAt) > nowMs || Date.parse(expiresAt) <= nowMs || Date.parse(expiresAt) <= Date.parse(approvedAt)) return undefined;
  if (typeof paidAllowed !== 'boolean') return undefined;
  if (!PLAIN_OBJECT(evidence)) return undefined;
  if (Object.keys(evidence).length !== ROBINHOOD_EVIDENCE_STEPS.length) return undefined;
  for (const step of ROBINHOOD_EVIDENCE_STEPS) if (evidence[step] !== true) return undefined;
  return { recordId, approvedBy, approvedAt, expiresAt, paidAllowed, evidence: evidence as Record<RobinhoodEvidenceStep, true> };
}

/** The error code each kind of refusal has always used, so callers and tests see no change while Key 2 is absent. */
export const ROBINHOOD_EXECUTION_DISABLED = 'ROBINHOOD_EXECUTION_DISABLED';
export const ROBINHOOD_PAID_MINTS_DISABLED = 'ROBINHOOD_PAID_MINTS_DISABLED';

/** Throws unless Key 2 allows this kind of Robinhood live mint. */
export function assertRobinhoodLiveAllowed(kind: 'free' | 'paid', enablement: unknown, now: Date): void {
  const valid = validRobinhoodEnablement(enablement, now);
  if (!valid) throw new Error(kind === 'paid' ? ROBINHOOD_PAID_MINTS_DISABLED : ROBINHOOD_EXECUTION_DISABLED);
  if (kind === 'paid' && !valid.paidAllowed) throw new Error(ROBINHOOD_PAID_MINTS_DISABLED);
}
