import { describe, expect, it } from 'vitest';
import { BASE, BASE_NOW, WALLET_ONE, WALLET_TWO, armed, campaignInput, close, fixture } from './canonical-fixtures.js';
import { BASE_PERSONAL_LIVE_FLEET_POLICY } from './fleet-policy.js';

/** D-062 item 3 at the canonical store: paid Base needs the owner's paid record, then the D-057 paid limits apply. */
const paidEvidence = { reviewedCode: true, forkRehearsal: true, finality: true, endpointAgreement: true, feeObservation: true, liveSimulation: true, custodyReadiness: true, paidRehearsal: true, paidPolicyApproved: true } as const;
const later = new Date(Date.parse(BASE_NOW) + 60_000).toISOString();
const ALLOWANCE = 200_000_000_000_000n; // D-057: 0.0002 ETH fee allowance per wallet
const paidInput = (mintPriceWei = 1_000_000_000_000_000n) => ({
  ...campaignInput(BASE, true),
  mintPriceWei,
  feePolicy: { kind: 'paid' as const, configuredPriorityFeeWei: 100_000_000n, l2ExecutionGasBudgetWei: ALLOWANCE - 100_000_000n, l1DataGasBudgetWei: 0n, totalFeeBudgetWei: ALLOWANCE },
  maxRunWei: 10n ** 18n,
  dailyCapWei: BASE_PERSONAL_LIVE_FLEET_POLICY.paidDailyCapWei,
});

describe('paid Base admission (D-062)', () => {
  it('is refused with only the free record, admitted after the paid record, and keeps the per-NFT price and two-wallet limits', async () => {
    const value = await fixture(BASE, false, true, '2099-01-01T00:00:00.000Z', true, BASE_PERSONAL_LIVE_FLEET_POLICY, () => new Date(later));
    try {
      // With only the free record, a paid Base campaign is refused.
      await expect(value.application.createCampaign(paidInput())).rejects.toThrow('BASE_PAID_MINTS_DISABLED');
      value.store.enableBase({ id: 'base-paid', approvedAt: later, expiresAt: '9999-12-31T23:59:59.999Z', paidAllowed: true, evidence: { ...paidEvidence }, evidenceDigest: 'a'.repeat(64), confirmationDigest: 'b'.repeat(64), strategyVersion: 'seadrop-v1-public@1', feePolicyVersion: 'base-free-d057-v1', primaryEndpointReference: 'BASE_RPC_URL', fallbackEndpointReference: 'BASE_RPC_FBACK', custodyMode: 'local-personal-live' });
      const prepared = await armed(value, await value.application.createCampaign(paidInput()), [WALLET_ONE]);
      expect((await value.store.admitExecution(prepared.input)).reservations).toHaveLength(1);

      const tooExpensive = await value.application.createCampaign(paidInput(BASE_PERSONAL_LIVE_FLEET_POLICY.paidMaxPricePerNftWei + 1n));
      const expensive = await armed(value, tooExpensive, [WALLET_ONE], [], '-expensive');
      await expect(value.store.admitExecution(expensive.input)).rejects.toThrow('PAID_PRICE_PER_NFT_EXCEEDED');
      const third = '0x3333333333333333333333333333333333333333';
      const threeWallets = await armed(value, await value.application.createCampaign(paidInput()), [WALLET_ONE, WALLET_TWO, third], [], '-three');
      await expect(value.store.admitExecution(threeWallets.input)).rejects.toThrow('PAID_WALLET_LIMIT_EXCEEDED');

      // Revoking the paid record stops paid Base at admission, and the fee policy no longer allows paid mints either.
      value.store.revokeBase({ id: 'rev-paid', confirmationDigest: 'c'.repeat(64), expectedEnablementId: 'base-paid' });
      await expect(value.application.createCampaign(paidInput())).rejects.toThrow(/BASE_EXECUTION_DISABLED|BASE_PAID_MINTS_DISABLED/);
      expect(value.db.prepare("SELECT paid_mints_enabled AS paid FROM fee_policy WHERE active = 1 AND chain_profile_id = (SELECT id FROM chain_profile WHERE chain_id = 8453)").get()).toEqual({ paid: 0 });
    } finally { await close(value); }
  });
});
