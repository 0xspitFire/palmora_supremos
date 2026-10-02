import { formatEth } from '@mint-bot/backend';
import { formatGwei } from 'viem';

/**
 * Owner-run replacement of Ethereum's stored fee policy with the approved fleet policy (D-042). The phrase names both
 * numbers being installed, so it cannot be copied from an earlier run or a different policy.
 */
export interface FeePolicyNumbers { maxTotalFeeWei: string; freeCapWei: string; tipWei: string }
export interface FeePolicyStatusView {
  fleetPolicyConfigured: boolean;
  stored: FeePolicyNumbers | null;
  approved: FeePolicyNumbers | null;
  matchesApproved: boolean;
}

const gwei = (wei: string): string => formatGwei(BigInt(wei));

export function feePolicyConfirmationPhrase(approved: FeePolicyNumbers): string {
  return `APPLY-FEE-POLICY free ${formatEth(BigInt(approved.freeCapWei))} max ${formatEth(BigInt(approved.maxTotalFeeWei))} tip ${gwei(approved.tipWei)}`;
}

/** Every gate on replacing the stored policy, in one place so each refusal can be tested. Throws a plain error. */
export function assertFeePolicyApplyAllowed(args: { status: FeePolicyStatusView; confirm: string | undefined }): void {
  if (!args.status.fleetPolicyConfigured || args.status.approved === null) throw new Error('FLEET_SPEND_POLICY_REQUIRED');
  if (typeof args.confirm !== 'string' || args.confirm !== feePolicyConfirmationPhrase(args.status.approved)) throw new Error('CONFIRMATION_PHRASE_MISMATCH: run fee-policy status and copy the phrase it prints exactly');
}

const PLAIN: Record<string, string> = {
  FLEET_SPEND_POLICY_REQUIRED: 'No approved spending policy is configured here, so there is nothing to compare or apply.',
  CANONICAL_STORE_REQUIRED: 'This command needs the normal database store, which is not in use.',
  KILL_RELEASE_BLOCKED_UNRESOLVED_RUNS: 'The kill switch cannot be released while runs are still in flight or unresolved. Run reconcile, wait until they settle, then try again.',
  CONFIRMATION_PHRASE_MISMATCH: 'The confirmation phrase did not match. Run the command again without --confirm and copy the line it prints exactly.',
  CANONICAL_CHAIN_PROFILE_REQUIRED: 'Ethereum has not been set up in this database yet, so there is no stored fee policy to replace.',
};

/** Turns a known error code into a plain sentence for the owner; other messages pass through unchanged. */
export function plainFeePolicyMessage(message: string): string {
  const code = /^[A-Z][A-Z0-9_]+/.exec(message)?.[0];
  return code && PLAIN[code] ? `${PLAIN[code]} (${code})` : message;
}

/** A live campaign's tip must be the one stored with the policy; later campaigns read the stored tip, not their own. */
export function assertTipMatchesStoredPolicy(status: FeePolicyStatusView, chosenTipWei: bigint): void {
  // With nothing stored yet, the first campaign installs the approved tip, so the chosen tip must equal that one.
  const expected = status.stored?.tipWei ?? status.approved?.tipWei;
  if (expected !== undefined && BigInt(expected) !== chosenTipWei) throw new Error(`TIP_DIFFERS_FROM_STORED_POLICY: the policy uses ${gwei(expected)} gwei, so ask for ${gwei(expected)} (run fee-policy status)`);
}

/** Plain-language view of the stored policy against the approved one, for the owner. */
export function describeFeePolicy(status: FeePolicyStatusView): { state: 'ok' | 'differs' | 'missing' | 'no_approved_policy'; message: string; confirmation?: string } {
  if (!status.fleetPolicyConfigured || status.approved === null) return { state: 'no_approved_policy', message: 'No approved fleet policy is configured, so there is nothing to compare against.' };
  if (status.stored === null) return { state: 'missing', message: 'No fee policy is stored for Ethereum yet. It will be created from the approved policy with the first campaign, or now with apply.', confirmation: feePolicyConfirmationPhrase(status.approved) };
  if (status.matchesApproved) return { state: 'ok', message: `The stored fee policy matches the approved one (free fee allowance ${formatEth(BigInt(status.approved.freeCapWei))} ETH per wallet).` };
  return {
    state: 'differs',
    message: `The stored fee policy (free ${formatEth(BigInt(status.stored.freeCapWei))} ETH, max ${formatEth(BigInt(status.stored.maxTotalFeeWei))} ETH, tip ${gwei(status.stored.tipWei)} gwei) differs from the approved one (free ${formatEth(BigInt(status.approved.freeCapWei))} ETH, max ${formatEth(BigInt(status.approved.maxTotalFeeWei))} ETH, tip ${gwei(status.approved.tipWei)} gwei). A live campaign can be refused, or sent with the wrong tip, until it is replaced. Reservations already made are not changed.`,
    confirmation: feePolicyConfirmationPhrase(status.approved),
  };
}
