/**
 * Fleet-wide spend limits for live admission (D-032, D-033).
 *
 * Daily caps apply to all wallets together, per UTC day and per mint class.
 * They count pending (`reserved`) and `settled` exposure, so a cap is never
 * checked only at confirmation (D-019).
 */
export interface FleetSpendPolicy {
  /** Most worst-case exposure across all wallets per day for free mints. */
  freeDailyCapWei: bigint;
  /** Most worst-case exposure across all wallets per day for paid mints. */
  paidDailyCapWei: bigint;
  /** Paid daily exposure above this raises a PAID_DAILY_HEADROOM_USED notice. */
  paidHeadroomAlertWei: bigint;
  /** Highest mint price accepted per NFT. */
  paidMaxPricePerNftWei: bigint;
  /** Most wallets holding exposure on one paid mint (campaign), across all its runs. */
  paidMaxWalletsPerMint: number;
  /** Highest per-wallet network-fee allowance for a free mint. */
  freeFeeAllowanceWei: bigint;
  /** Highest per-wallet network-fee allowance for a paid mint. */
  paidFeeAllowanceWei: bigint;
}

const ETH = 10n ** 18n;
/** Parses a decimal ETH string into wei without floating point. */
export function ethToWei(value: string): bigint {
  if (!/^\d+(\.\d{1,18})?$/.test(value)) throw new Error('ETH_AMOUNT_INVALID');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole!) * ETH + BigInt(fraction.padEnd(18, '0'));
}

/** Owner-approved Personal Live limits, 2026-09-29 (D-033). */
export const PERSONAL_LIVE_FLEET_POLICY: Readonly<FleetSpendPolicy> = Object.freeze({
  freeDailyCapWei: ethToWei('0.0024'),
  paidDailyCapWei: ethToWei('0.0082'),
  paidHeadroomAlertWei: ethToWei('0.0075'),
  paidMaxPricePerNftWei: ethToWei('0.0037'),
  paidMaxWalletsPerMint: 2,
  freeFeeAllowanceWei: ethToWei('0.0004'),
  paidFeeAllowanceWei: ethToWei('0.00037'),
});

export function validateFleetSpendPolicy(policy: FleetSpendPolicy): FleetSpendPolicy {
  const amounts = [policy.freeDailyCapWei, policy.paidDailyCapWei, policy.paidHeadroomAlertWei, policy.paidMaxPricePerNftWei, policy.freeFeeAllowanceWei, policy.paidFeeAllowanceWei];
  if (amounts.some((amount) => typeof amount !== 'bigint' || amount <= 0n)) throw new Error('FLEET_SPEND_POLICY_INVALID');
  if (policy.paidHeadroomAlertWei > policy.paidDailyCapWei) throw new Error('FLEET_SPEND_POLICY_INVALID');
  if (!Number.isSafeInteger(policy.paidMaxWalletsPerMint) || policy.paidMaxWalletsPerMint < 1) throw new Error('FLEET_SPEND_POLICY_INVALID');
  return policy;
}

export type FleetNotice = 'PAID_DAILY_HEADROOM_USED';
