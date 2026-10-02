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

  it('keeps the old rule without an approved policy and for the existing dry-run shape', async () => {
    const value = await fixture(ETHEREUM, false, true, undefined, true, PERSONAL_LIVE_FLEET_POLICY);
    try {
      // No fleet policy passed to the application: the allowance-shaped campaign is judged by the old twice-the-tip rule and refused.
      await expect(new BackendApplication(value.store, new ExecutionCoordinator(value.store, noopEngine)).createCampaign(liveFreeInput())).rejects.toThrow('FREE_TOTAL_SPEND_POLICY_INVALID');
      // The old dry-run shape still passes with the policy present.
      await expect(appWithPolicy(value).createCampaign(campaignInput(ETHEREUM))).resolves.toBeTruthy();
    } finally { await close(value); }
  });
});

describe('Robinhood never takes the per-wallet fee budget shape (D-042)', () => {
  it('judges an allowance-shaped Robinhood campaign by the old twice-the-tip rule and refuses it', async () => {
    const value = await fixture(ROBINHOOD, false, true, undefined, true, PERSONAL_LIVE_FLEET_POLICY);
    try {
      await expect(appWithPolicy(value).createCampaign({ ...campaignInput(ROBINHOOD), maxRunWei: ALLOWANCE, dailyCapWei: ALLOWANCE, gasCeilingWei: ALLOWANCE, feePolicy: liveFreeInput().feePolicy })).rejects.toThrow('FREE_TOTAL_SPEND_POLICY_INVALID');
    } finally { await close(value); }
  });
});

describe('stored Ethereum fee policy (D-042)', () => {
  it('a stale policy from an earlier tiny campaign blocks a live campaign until the owner replaces it with the approved one', async () => {
    const value = await fixture(ETHEREUM, false, true, undefined, true, PERSONAL_LIVE_FLEET_POLICY); // the fixture stores a tiny policy: 34 / 40 wei
    try {
      const store = value.store as CanonicalStoreBridge;
      expect(store.ethereumFeePolicyStatus()).toMatchObject({ fleetPolicyConfigured: true, matchesApproved: false, stored: { freeCapWei: '40', tipWei: '20' }, approved: { freeCapWei: ALLOWANCE.toString(), tipWei: TIP.toString() } });
      const live = await appWithPolicy(value).createCampaign(liveFreeInput());
      const blocked = await armed(value, live, [WALLET_ONE]);
      await expect(value.store.admitExecution(blocked.input)).rejects.toThrow('FREE_TOTAL_SPEND_CAP_EXCEEDED');

      const before = value.db.prepare('SELECT COUNT(*) AS n FROM spend_reservation').get() as { n: number };
      expect(store.applyApprovedEthereumFeePolicy()).toEqual({ replaced: true });
      expect((value.db.prepare('SELECT COUNT(*) AS n FROM spend_reservation').get() as { n: number }).n).toBe(before.n); // apply touches no reservation
      expect(store.ethereumFeePolicyStatus()).toMatchObject({ matchesApproved: true });
      expect(store.applyApprovedEthereumFeePolicy()).toEqual({ replaced: false }); // idempotent
      const admission = await value.store.admitExecution(blocked.input);
      expect(admission.reservations).toHaveLength(1);
      expect(admission.reservations[0]!.amountWei).toBe(ALLOWANCE); // the worst case is reserved up front (D-019)
      expect((value.db.prepare('SELECT COUNT(*) AS n FROM fee_policy WHERE active = 1').get() as { n: number }).n).toBe(1);
      // The reservation made after the replacement points at the new policy; the stale one was never reserved against.
      const reservation = value.db.prepare('SELECT fee_policy_id FROM spend_reservation').get() as { fee_policy_id: string };
      const active = value.db.prepare('SELECT id FROM fee_policy WHERE active = 1').get() as { id: string };
      expect(reservation.fee_policy_id).toBe(active.id);
    } finally { await close(value); }
  });

  it('refuses to apply without an approved policy and changes nothing', async () => {
    const value = await fixture(ETHEREUM, false, true, undefined, true, null);
    try {
      const store = value.store as CanonicalStoreBridge;
      expect(store.ethereumFeePolicyStatus()).toMatchObject({ fleetPolicyConfigured: false, approved: null, matchesApproved: false });
      expect(() => store.applyApprovedEthereumFeePolicy()).toThrow('FLEET_SPEND_POLICY_REQUIRED');
    } finally { await close(value); }
  });

  it('creates a fresh chain\'s stored policy from the approved policy, never from the first campaign; without one it keeps the old rule', async () => {
    for (const withPolicy of [true, false]) {
      const directory = await mkdtemp(join(tmpdir(), 'mint-fee-seed-'));
      const db = openDatabase(join(directory, 'state.sqlite'));
      db.prepare('INSERT INTO chain_profile (id, chain_id, name, rpc_endpoints_json, confirmation_depth, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('profile-ethereum', ETHEREUM, 'Ethereum', '[]', 2, '2026-09-14T14:00:00.000Z');
      const store = new CanonicalStoreBridge(db, { now: () => new Date('2026-09-14T14:00:00.000Z'), ...(withPolicy ? { fleetPolicy: PERSONAL_LIVE_FLEET_POLICY } : {}) });
      await store.open();
      try {
        // The first campaign is a tiny dry-run one: it must not set the chain's caps or tip when an approved policy exists.
        await new BackendApplication(store, new ExecutionCoordinator(store, noopEngine), withPolicy ? { fleetPolicy: PERSONAL_LIVE_FLEET_POLICY } : {}).createCampaign({ ...campaignInput(ETHEREUM), feePolicy: { kind: 'free', configuredPriorityFeeWei: 20n, freeTotalSpendCapWei: 40n, l2ExecutionGasBudgetWei: 10n, l1DataGasBudgetWei: 4n, totalFeeBudgetWei: 34n } });
        const row = db.prepare('SELECT max_total_fee_wei, free_mint_total_fee_cap_wei, free_mint_priority_fee_component_wei AS tip FROM fee_policy WHERE active = 1').get() as { max_total_fee_wei: string; free_mint_total_fee_cap_wei: string; tip: string };
        if (withPolicy) expect(row).toEqual({ max_total_fee_wei: ALLOWANCE.toString(), free_mint_total_fee_cap_wei: ALLOWANCE.toString(), tip: TIP.toString() });
        else expect(row).toEqual({ max_total_fee_wei: '34', free_mint_total_fee_cap_wei: '40', tip: '20' });
      } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
    }
  });

  it('can be applied again after a later change, even to numbers an older row already held', async () => {
    const value = await fixture(ETHEREUM, false, true, undefined, true, PERSONAL_LIVE_FLEET_POLICY);
    try {
      const store = value.store as CanonicalStoreBridge;
      expect(store.applyApprovedEthereumFeePolicy()).toEqual({ replaced: true });
      value.db.prepare('UPDATE fee_policy SET active = 0 WHERE active = 1').run();
      value.db.prepare("INSERT INTO fee_policy (id, chain_profile_id, version, priority_fee_semantics, max_total_fee_wei, free_mint_total_fee_cap_wei, free_mint_priority_fee_component_wei, free_mint_priority_fee_multiplier, paid_mints_enabled, active, created_at, zero_priority_fee_policy) VALUES ('stale-again', 'profile-1', 'stale-again', 'ordering', '34', '40', '20', 2, 0, 1, '2026-09-14T14:00:00.000Z', 'allowed')").run();
      expect(store.ethereumFeePolicyStatus().matchesApproved).toBe(false);
      expect(store.applyApprovedEthereumFeePolicy()).toEqual({ replaced: true });
      expect(store.ethereumFeePolicyStatus().matchesApproved).toBe(true);
    } finally { await close(value); }
  });
});
