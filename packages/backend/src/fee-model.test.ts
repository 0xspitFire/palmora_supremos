import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '@mint-bot/database';
import { BackendApplication } from './application.js';
import { ExecutionCoordinator } from './coordinator.js';
import { CanonicalStoreBridge } from './canonical-store.js';
import { ETHEREUM, ROBINHOOD, WALLET_ONE, armed, campaignInput, close, fixture, noopEngine, type Fixture } from './canonical-fixtures.js';
import { PERSONAL_LIVE_FLEET_POLICY } from './fleet-policy.js';

const ALLOWANCE = PERSONAL_LIVE_FLEET_POLICY.freeFeeAllowanceWei; // 0.0004 ETH, D-037
const TIP = 100_000_000n; // 0.1 gwei per gas

/** A live free Ethereum campaign carrying the approved per-wallet fee allowance, with the tip kept separate (D-042). */
const liveFreeInput = (overrides: Record<string, unknown> = {}, fee: Record<string, unknown> = {}) => ({
  ...campaignInput(ETHEREUM),
  maxRunWei: ALLOWANCE,
  dailyCapWei: ALLOWANCE,
  gasCeilingWei: ALLOWANCE,
  feePolicy: { kind: 'free' as const, configuredPriorityFeeWei: TIP, freeTotalSpendCapWei: ALLOWANCE, l2ExecutionGasBudgetWei: ALLOWANCE - TIP, l1DataGasBudgetWei: 0n, totalFeeBudgetWei: ALLOWANCE, ...fee },
  ...overrides,
});
const appWithPolicy = (value: Fixture): BackendApplication => new BackendApplication(value.store, new ExecutionCoordinator(value.store, noopEngine), { fleetPolicy: PERSONAL_LIVE_FLEET_POLICY });

describe('free Ethereum campaign fee budget (D-042)', () => {
  it('accepts the approved per-wallet fee allowance with a small separate tip', async () => {
    const value = await fixture(ETHEREUM, false, true, undefined, true, PERSONAL_LIVE_FLEET_POLICY);
    try {
      const created = await appWithPolicy(value).createCampaign(liveFreeInput());
      expect(created.feePolicy).toMatchObject({ configuredPriorityFeeWei: TIP });
    } finally { await close(value); }
  });

  it('refuses a budget over the allowance, a zero tip, a tip over 2 gwei, and a cap that is not the allowance', async () => {
    const value = await fixture(ETHEREUM, false, true, undefined, true, PERSONAL_LIVE_FLEET_POLICY);
    try {
      const app = appWithPolicy(value);
      await expect(app.createCampaign(liveFreeInput({ gasCeilingWei: ALLOWANCE + 1n }, { l2ExecutionGasBudgetWei: ALLOWANCE - TIP + 1n, totalFeeBudgetWei: ALLOWANCE + 1n }))).rejects.toThrow('FREE_TOTAL_SPEND_CAP_EXCEEDED');
      await expect(app.createCampaign(liveFreeInput({}, { configuredPriorityFeeWei: 0n, l2ExecutionGasBudgetWei: ALLOWANCE }))).rejects.toThrow('FREE_TIP_OUT_OF_RANGE');
      await expect(app.createCampaign(liveFreeInput({}, { configuredPriorityFeeWei: 2_000_000_001n, l2ExecutionGasBudgetWei: ALLOWANCE - 2_000_000_001n }))).rejects.toThrow('FREE_TIP_OUT_OF_RANGE');
      await expect(app.createCampaign(liveFreeInput({}, { freeTotalSpendCapWei: ALLOWANCE - 1n }))).rejects.toThrow('FREE_TOTAL_SPEND_POLICY_INVALID');
    } finally { await close(value); }
  });

  it('keeps the old rule without an approved policy, on Robinhood, and for the existing dry-run shape', async () => {
    const value = await fixture(ETHEREUM, false, true, undefined, true, PERSONAL_LIVE_FLEET_POLICY);
    try {
      // No fleet policy passed to the application: the allowance-shaped campaign is judged by the old twice-the-tip rule and refused.
      await expect(new BackendApplication(value.store, new ExecutionCoordinator(value.store, noopEngine)).createCampaign(liveFreeInput())).rejects.toThrow('FREE_TOTAL_SPEND_POLICY_INVALID');
      // The old dry-run shape still passes with the policy present.
      await expect(appWithPolicy(value).createCampaign(campaignInput(ETHEREUM))).resolves.toBeTruthy();
      // Robinhood never takes the new shape.
      await expect(appWithPolicy(value).createCampaign({ ...liveFreeInput(), ...campaignInput(ROBINHOOD), feePolicy: liveFreeInput().feePolicy, gasCeilingWei: ALLOWANCE })).rejects.toThrow();
    } finally { await close(value); }
  });
});

describe('stored Ethereum fee policy (D-042)', () => {
  it('a stale policy from an earlier tiny campaign blocks a live campaign until the owner replaces it with the approved one', async () => {
    const value = await fixture(ETHEREUM, false, true, undefined, true, PERSONAL_LIVE_FLEET_POLICY); // the fixture stores a tiny policy: 34 / 40 wei
    try {
      const store = value.store as CanonicalStoreBridge;
      expect(store.ethereumFeePolicyStatus()).toMatchObject({ fleetPolicyConfigured: true, matchesApproved: false, stored: { freeCapWei: '40' }, approved: { freeCapWei: ALLOWANCE.toString() } });
      const live = await appWithPolicy(value).createCampaign(liveFreeInput());
      const blocked = await armed(value, live, [WALLET_ONE]);
      await expect(value.store.admitExecution(blocked.input)).rejects.toThrow(/FREE_TOTAL_SPEND_CAP_EXCEEDED|FEE_POLICY_CAP_EXCEEDED/);

      expect(store.applyApprovedEthereumFeePolicy(TIP)).toEqual({ replaced: true });
      expect(store.ethereumFeePolicyStatus()).toMatchObject({ matchesApproved: true });
      expect(store.applyApprovedEthereumFeePolicy(TIP)).toEqual({ replaced: false }); // idempotent
      const admission = await value.store.admitExecution(blocked.input);
      expect(admission.reservations).toHaveLength(1);
      expect(admission.reservations[0]!.amountWei).toBe(ALLOWANCE); // the worst case is reserved up front (D-019)
      expect((value.db.prepare('SELECT COUNT(*) AS n FROM fee_policy WHERE active = 1').get() as { n: number }).n).toBe(1);
    } finally { await close(value); }
  });

  it('refuses to apply without an approved policy or with a zero tip, and changes nothing', async () => {
    const value = await fixture(ETHEREUM, false, true, undefined, true, null);
    try {
      const store = value.store as CanonicalStoreBridge;
      expect(store.ethereumFeePolicyStatus()).toMatchObject({ fleetPolicyConfigured: false, approved: null, matchesApproved: false });
      expect(() => store.applyApprovedEthereumFeePolicy(TIP)).toThrow('FLEET_SPEND_POLICY_REQUIRED');
    } finally { await close(value); }
    const withPolicy = await fixture(ETHEREUM, false, true, undefined, true, PERSONAL_LIVE_FLEET_POLICY);
    try {
      expect(() => (withPolicy.store as CanonicalStoreBridge).applyApprovedEthereumFeePolicy(0n)).toThrow('FEE_POLICY_PRIORITY_COMPONENT_INVALID');
      expect((withPolicy.store as CanonicalStoreBridge).ethereumFeePolicyStatus().stored).toMatchObject({ freeCapWei: '40' });
    } finally { await close(withPolicy); }
  });

  it('creates a fresh chain\'s stored policy from the approved policy, never from the first campaign; without one it keeps the old rule', async () => {
    for (const withPolicy of [true, false]) {
      const directory = await mkdtemp(join(tmpdir(), 'mint-fee-seed-'));
      const db = openDatabase(join(directory, 'state.sqlite'));
      db.prepare('INSERT INTO chain_profile (id, chain_id, name, rpc_endpoints_json, confirmation_depth, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('profile-ethereum', ETHEREUM, 'Ethereum', '[]', 2, '2026-09-14T14:00:00.000Z');
      const store = new CanonicalStoreBridge(db, { now: () => new Date('2026-09-14T14:00:00.000Z'), ...(withPolicy ? { fleetPolicy: PERSONAL_LIVE_FLEET_POLICY } : {}) });
      await store.open();
      try {
        // The first campaign is a tiny dry-run one: it must not set the chain's caps when an approved policy exists.
        await new BackendApplication(store, new ExecutionCoordinator(store, noopEngine), withPolicy ? { fleetPolicy: PERSONAL_LIVE_FLEET_POLICY } : {}).createCampaign({ ...campaignInput(ETHEREUM), feePolicy: { kind: 'free', configuredPriorityFeeWei: 20n, freeTotalSpendCapWei: 40n, l2ExecutionGasBudgetWei: 10n, l1DataGasBudgetWei: 4n, totalFeeBudgetWei: 34n } });
        const row = db.prepare('SELECT max_total_fee_wei, free_mint_total_fee_cap_wei FROM fee_policy WHERE active = 1').get() as { max_total_fee_wei: string; free_mint_total_fee_cap_wei: string };
        if (withPolicy) expect(row).toEqual({ max_total_fee_wei: ALLOWANCE.toString(), free_mint_total_fee_cap_wei: ALLOWANCE.toString() });
        else expect(row).toEqual({ max_total_fee_wei: '34', free_mint_total_fee_cap_wei: '40' });
      } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
    }
  });
});
