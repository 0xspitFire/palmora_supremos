/** Owner-approved 2026-11-04: free replication uses score plus a verified watched-wallet self-mint. */
export interface QualifiedAutomationGateInput {
  readonly score: number;
  readonly confidence: number;
  readonly replicationVerdict: 'replicable' | 'not_replicable';
  readonly simulationPassed: boolean;
  readonly chainVerified: boolean;
  readonly spendWithinCaps: boolean;
  readonly killSwitchClear: boolean;
  readonly operatorApproved: boolean;
  /** Omission cannot accidentally activate autonomous execution. */
  readonly mintPriceWei?: bigint;
  readonly watchedWalletMintVerified?: boolean;
  readonly unattendedReady?: boolean;
}
export type QualifiedAutomationBlocker =
  | 'SCORE_BELOW_THRESHOLD' | 'WATCHED_WALLET_MINT_REQUIRED'
  | 'REPLICATION_NOT_QUALIFIED' | 'SIMULATION_FAILED' | 'CHAIN_NOT_VERIFIED'
  | 'SPEND_CAP_NOT_AVAILABLE' | 'KILL_SWITCH_ENGAGED'
  | 'OPERATOR_APPROVAL_REQUIRED' | 'UNATTENDED_EVIDENCE_REQUIRED';
export interface QualifiedAutomationGateResult {
  readonly allowed: boolean;
  readonly blockers: readonly QualifiedAutomationBlocker[];
  readonly threshold: 70;
  readonly mode: 'autonomous-free' | 'operator-approved';
}
export function evaluateQualifiedAutomationGate(input: QualifiedAutomationGateInput): QualifiedAutomationGateResult {
  const blockers: QualifiedAutomationBlocker[] = [];
  if (!Number.isFinite(input.score) || input.score < 70 || input.score > 100) blockers.push('SCORE_BELOW_THRESHOLD');
  if (input.replicationVerdict !== 'replicable') blockers.push('REPLICATION_NOT_QUALIFIED');
  if (!input.simulationPassed) blockers.push('SIMULATION_FAILED');
  if (!input.chainVerified) blockers.push('CHAIN_NOT_VERIFIED');
  if (!input.spendWithinCaps) blockers.push('SPEND_CAP_NOT_AVAILABLE');
  if (!input.killSwitchClear) blockers.push('KILL_SWITCH_ENGAGED');
  const autonomous = input.mintPriceWei === 0n && !input.operatorApproved;
  if (autonomous) {
    if (!input.watchedWalletMintVerified) blockers.push('WATCHED_WALLET_MINT_REQUIRED');
    if (!input.unattendedReady) blockers.push('UNATTENDED_EVIDENCE_REQUIRED');
  } else if (!input.operatorApproved) blockers.push('OPERATOR_APPROVAL_REQUIRED');
  return { allowed: blockers.length === 0, blockers, threshold: 70, mode: autonomous ? 'autonomous-free' : 'operator-approved' };
}
