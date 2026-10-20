import { describe, expect, it } from 'vitest';
import { BASE_PERSONAL_LIVE_FLEET_POLICY, ethToWei, validateFleetSpendPolicy } from './fleet-policy.js';

describe('Base Personal Live policy (D-057)', () => {
  it('pins the approved free and paid limits exactly', () => {
    expect(BASE_PERSONAL_LIVE_FLEET_POLICY).toEqual({
      freeDailyCapWei: ethToWei('0.0012'),
      paidDailyCapWei: ethToWei('0.0082'),
      paidHeadroomAlertWei: ethToWei('0.0075'),
      paidMaxPricePerNftWei: ethToWei('0.0037'),
      paidMaxWalletsPerMint: 2,
      freeFeeAllowanceWei: ethToWei('0.0002'),
      paidFeeAllowanceWei: ethToWei('0.0002'),
    });
    expect(Object.isFrozen(BASE_PERSONAL_LIVE_FLEET_POLICY)).toBe(true);
    expect(validateFleetSpendPolicy(BASE_PERSONAL_LIVE_FLEET_POLICY)).toBe(BASE_PERSONAL_LIVE_FLEET_POLICY);
  });

  it('keeps the free fleet cap equal to six complete wallet allowances', () => {
    expect(BASE_PERSONAL_LIVE_FLEET_POLICY.freeDailyCapWei).toBe(6n * BASE_PERSONAL_LIVE_FLEET_POLICY.freeFeeAllowanceWei);
  });
});
