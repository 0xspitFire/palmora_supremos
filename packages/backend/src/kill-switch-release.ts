import type { BackendState } from './types.js';

/**
 * Releasing the kill switch (T-028, T-024 finding 4). The switch stops everything, so letting it go is deliberate: the
 * owner types a phrase, nothing may be in flight or unresolved, and the release is recorded and reported.
 */

/**
 * Runs that must be settled before the kill switch can be released: armed or active runs, and aborted runs that already
 * sent a transaction without a final result. This is the same rule the coordinator applies when it starts up.
 */
export function unresolvedRunIds(state: Pick<BackendState, 'runs' | 'attempts' | 'reconciliations' | 'campaigns'>): string[] {
  return state.runs
    .filter((run) => ['Armed', 'Active'].includes(run.state) || (run.state === 'Aborted' && state.attempts.some((attempt) => attempt.runId === run.id && attempt.hash)))
    .filter((run) => {
      const result = state.reconciliations.filter((item) => item.runId === run.id).at(-1)?.result;
      const chainId = state.campaigns.find((campaign) => campaign.id === run.campaignId)?.chainId;
      const terminal = result === 'failed' || result === 'final' || (result === 'confirmed' && chainId === 1);
      return !terminal;
    })
    .map((run) => run.id);
}

export interface KillSwitchStatus { engaged: boolean; changedBy: string; changedAt: string }

/** The phrase names when the switch was turned on, so a phrase copied from an earlier time does not match. */
export function killReleasePhrase(status: KillSwitchStatus): string {
  return status.engaged ? `RELEASE-KILL-SWITCH engaged ${status.changedAt}` : 'RELEASE-KILL-SWITCH file-only';
}

/** Every gate on releasing, in one place so each refusal can be tested. Throws a plain error. */
export function assertKillReleaseAllowed(args: { status: KillSwitchStatus; confirm: string | undefined; unresolved: readonly string[] }): void {
  if (args.unresolved.length > 0) throw new Error(`KILL_RELEASE_BLOCKED_UNRESOLVED_RUNS: ${args.unresolved.length} run(s) are still in flight or unresolved (${args.unresolved.slice(0, 3).join(', ')}); run reconcile and wait until they settle`);
  if (typeof args.confirm !== 'string' || args.confirm !== killReleasePhrase(args.status)) throw new Error('CONFIRMATION_PHRASE_MISMATCH: run kill-release without --confirm and copy the phrase it prints exactly');
}
