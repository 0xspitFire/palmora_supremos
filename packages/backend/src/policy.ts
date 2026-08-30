export const WEI_PER_ETH = 1_000_000_000_000_000_000n;
export const ROBINHOOD_FREE_PER_WALLET_CAP_WEI = 200_000_000_000_000n;
export const ROBINHOOD_FREE_ACTIVE_PERIOD_CAP_WEI = 2_000_000_000_000_000n;
export const ROBINHOOD_PAID_MINTS_ENABLED = false;

export function assertRobinhoodFreePolicy(gasCeilingWei: bigint, activePeriodCapWei: bigint, reservationWei?: bigint): void {
  if (gasCeilingWei > ROBINHOOD_FREE_PER_WALLET_CAP_WEI) throw new Error('ROBINHOOD_PER_WALLET_CAP_EXCEEDED');
  if (activePeriodCapWei > ROBINHOOD_FREE_ACTIVE_PERIOD_CAP_WEI) throw new Error('ROBINHOOD_ACTIVE_PERIOD_CAP_EXCEEDED');
  if (reservationWei !== undefined && reservationWei > ROBINHOOD_FREE_PER_WALLET_CAP_WEI) throw new Error('ROBINHOOD_PER_WALLET_RESERVE_EXCEEDED');
}
