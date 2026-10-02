import { formatEth } from '@mint-bot/backend';

/**
 * Owner-run replacement of Ethereum's stored fee policy with the approved fleet policy (D-042). The phrase names both
 * numbers being installed, so it cannot be copied from an earlier run or a different policy.
 */
export interface FeePolicyStatusView {
  fleetPolicyConfigured: boolean;
  stored: { maxTotalFeeWei: string; freeCapWei: string } | null;
  approved: { maxTotalFeeWei: string; freeCapWei: string } | null;
  matchesApproved: boolean;
}

export function feePolicyConfirmationPhrase(approved: { maxTotalFeeWei: string; freeCapWei: string }): string {
  return `APPLY-FEE-POLICY free ${formatEth(BigInt(approved.freeCapWei))} max ${formatEth(BigInt(approved.maxTotalFeeWei))}`;
}

/** Plain-language view of the stored policy against the approved one, for the owner. */
export function describeFeePolicy(status: FeePolicyStatusView): { state: 'ok' | 'differs' | 'missing' | 'no_approved_policy'; message: string; confirmation?: string } {
  if (!status.fleetPolicyConfigured || status.approved === null) return { state: 'no_approved_policy', message: 'No approved fleet policy is configured, so there is nothing to compare against.' };
  if (status.stored === null) return { state: 'missing', message: 'No fee policy is stored for Ethereum yet. It will be created from the approved policy with the first campaign, or now with apply.', confirmation: feePolicyConfirmationPhrase(status.approved) };
  if (status.matchesApproved) return { state: 'ok', message: `The stored fee policy matches the approved one (free fee allowance ${formatEth(BigInt(status.approved.freeCapWei))} ETH per wallet).` };
  return {
    state: 'differs',
    message: `The stored fee policy (free ${formatEth(BigInt(status.stored.freeCapWei))} ETH, max ${formatEth(BigInt(status.stored.maxTotalFeeWei))} ETH) differs from the approved one (free ${formatEth(BigInt(status.approved.freeCapWei))} ETH, max ${formatEth(BigInt(status.approved.maxTotalFeeWei))} ETH). A live campaign can be refused until it is replaced. Reservations already made are not changed.`,
    confirmation: feePolicyConfirmationPhrase(status.approved),
  };
}
