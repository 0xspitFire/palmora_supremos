import type { ReadinessCheck, WalletReadiness } from './types.js';
export interface ReadinessInput { wallet: string; funded: boolean; eligible: boolean; constructible: boolean; simulated: boolean; gasPolicy: boolean; sourceBlock?: bigint; now?: Date; freshnessMs?: number; }
export class ReadinessService {
  evaluate(input: ReadinessInput): ReadinessCheck {
    const now = input.now ?? new Date(); const freshUntil = new Date(now.getTime() + (input.freshnessMs ?? 30_000));
    const checks = { funded: input.funded, eligible: input.eligible, constructible: input.constructible, simulated: input.simulated, gasPolicy: input.gasPolicy };
    const blockingReasons = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
    let state: WalletReadiness = blockingReasons.length ? (input.funded ? 'Funded' : 'Unfunded') : 'Ready';
    if (input.funded && input.eligible && !input.constructible) state = 'Eligible';
    return { wallet: input.wallet, state, freshUntil: freshUntil.toISOString(), ...(input.sourceBlock === undefined ? {} : { sourceBlock: input.sourceBlock }), blockingReasons, checks };
  }
}
