import type { CheckOutcome, ReadinessCheck, WalletReadiness } from './types.js';
import { PHASE2_DEFAULTS } from './phase2-defaults.js';
export interface ReadinessInput {
  wallet: string;
  campaignId?: string;
  funded?: boolean;
  eligible?: boolean;
  constructible?: boolean;
  simulated?: boolean;
  gasPolicy?: boolean;
  chainVerified?: boolean;
  evidenceCurrent?: boolean;
  runtimeReady?: boolean;
  reconciliationClear?: boolean;
  sourceBlock?: bigint;
  sourceBlockHash?: string;
  now?: Date;
  freshnessMs?: number;
  observedAt?: Date;
}
export class ReadinessService {
  evaluate(input: ReadinessInput): ReadinessCheck {
    const now = input.now ?? new Date();
    const freshnessMs = input.freshnessMs ?? PHASE2_DEFAULTS.readinessFreshnessMs;
    if (!Number.isFinite(freshnessMs) || freshnessMs < 0) throw new Error('INVALID_READINESS_FRESHNESS');
    const observedAt = input.observedAt ?? now;
    const freshUntil = new Date(observedAt.getTime() + freshnessMs);
    const checks: Record<string, boolean> = { funded: input.funded === true, eligible: input.eligible === true, constructible: input.constructible === true, simulated: input.simulated === true, gasPolicy: input.gasPolicy === true };
    const checkStates: Record<string, CheckOutcome> = {};
    const values: Array<[string, boolean | undefined]> = [['funded', input.funded], ['eligible', input.eligible], ['constructible', input.constructible], ['simulated', input.simulated], ['gasPolicy', input.gasPolicy]];
    for (const [name, value] of [['chain_verified', input.chainVerified], ['evidence_current', input.evidenceCurrent], ['runtime_ready', input.runtimeReady], ['reconciliation_clear', input.reconciliationClear]] as Array<[string, boolean | undefined]>) {
      if (value !== undefined) { checks[name] = value; values.push([name, value]); }
    }
    for (const [name, value] of values) checkStates[name] = value === undefined ? 'unknown' : value ? 'pass' : 'fail';
    const stale = now.getTime() >= freshUntil.getTime();
    if (stale) for (const [name, value] of values) if (value === true) checkStates[name] = 'stale';
    const blockingReasons = values.filter(([, value]) => value !== true).map(([name]) => name);
    let state: WalletReadiness = input.funded === undefined ? 'Unknown' : !input.funded ? 'Unfunded' : 'Funded';
    if (input.funded === true && input.eligible === true && input.constructible !== true) state = 'Eligible';
    if (values.every(([, value]) => value === true) && !stale) state = 'Ready';
    return { wallet: input.wallet, ...(input.campaignId ? { campaignId: input.campaignId } : {}), state, freshUntil: freshUntil.toISOString(), ...(input.sourceBlock === undefined ? {} : { sourceBlock: input.sourceBlock }), ...(input.sourceBlockHash ? { sourceBlockHash: input.sourceBlockHash } : {}), observedAt: observedAt.toISOString(), blockingReasons, checks, checkStates };
  }
}
