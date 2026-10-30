/**
 * The final permission boundary for Phase 4 qualified automation.
 *
 * A score is a recommendation, never authorization. This gate keeps the
 * replication checklist, simulation, chain verification, spend controls and
 * explicit operator approval separate from scoring so a future scheduler
 * cannot accidentally turn a high score into an autonomous spend.
 */
export interface QualifiedAutomationGateInput {
  readonly score: number;
  readonly confidence: number;
  readonly replicationVerdict: 'replicable' | 'not_replicable';
  readonly simulationPassed: boolean;
  readonly chainVerified: boolean;
  readonly spendWithinCaps: boolean;
  readonly killSwitchClear: boolean;
  readonly operatorApproved: boolean;
}

export type QualifiedAutomationBlocker =
  | 'SCORE_BELOW_THRESHOLD'
  | 'CONFIDENCE_TOO_LOW'
  | 'REPLICATION_NOT_QUALIFIED'
  | 'SIMULATION_FAILED'
  | 'CHAIN_NOT_VERIFIED'
  | 'SPEND_CAP_NOT_AVAILABLE'
  | 'KILL_SWITCH_ENGAGED'
  | 'OPERATOR_APPROVAL_REQUIRED';

export interface QualifiedAutomationGateResult {
  readonly allowed: boolean;
  readonly blockers: readonly QualifiedAutomationBlocker[];
  readonly threshold: 70;
  readonly minimumConfidence: 0.8;
}

/**
 * Evaluate whether a qualified replication may be promoted for execution.
 * The function remains deliberately strict: even a fully qualified plan
 * still requires explicit operator approval in the current Phase 4 release.
 */
export function evaluateQualifiedAutomationGate(input: QualifiedAutomationGateInput): QualifiedAutomationGateResult {
  const blockers: QualifiedAutomationBlocker[] = [];
  if (!Number.isFinite(input.score) || input.score < 70) blockers.push('SCORE_BELOW_THRESHOLD');
  if (!Number.isFinite(input.confidence) || input.confidence < 0.8) blockers.push('CONFIDENCE_TOO_LOW');
  if (input.replicationVerdict !== 'replicable') blockers.push('REPLICATION_NOT_QUALIFIED');
  if (!input.simulationPassed) blockers.push('SIMULATION_FAILED');
  if (!input.chainVerified) blockers.push('CHAIN_NOT_VERIFIED');
  if (!input.spendWithinCaps) blockers.push('SPEND_CAP_NOT_AVAILABLE');
  if (!input.killSwitchClear) blockers.push('KILL_SWITCH_ENGAGED');
  if (!input.operatorApproved) blockers.push('OPERATOR_APPROVAL_REQUIRED');
  return { allowed: blockers.length === 0, blockers, threshold: 70, minimumConfidence: 0.8 };
}
