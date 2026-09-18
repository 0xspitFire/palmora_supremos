import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { openDatabase, type SqliteDatabase } from '@mint-bot/database';
import { BackendApplication } from './application.js';
import { canonicalReceiptFinalityStage, CanonicalStoreBridge, type CanonicalAdmissionInput } from './canonical-store.js';
import { ExecutionCoordinator } from './coordinator.js';
import { campaignInputDigest } from './evidence.js';
import { DurableStore } from './store.js';
import type { AttemptRecord, Campaign, ChainEvidenceRecord, EngineAdapter, FeePolicy, IntentRecord, RunRecord } from './types.js';

const ETHEREUM = 1 as const;
const ROBINHOOD = 4663 as const;
const NOW = '2026-09-14T14:00:00.000Z';
const WALLET_ONE = '0x1111111111111111111111111111111111111111';
const WALLET_TWO = '0x2222222222222222222222222222222222222222';
const CONTRACT = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const noopEngine: EngineAdapter = {
  prepare: async () => ({ executionIds: [], attempts: [], receipts: [], state: 'Prepared' }),
  execute: async () => ({ executionIds: [], attempts: [], receipts: [], state: 'Confirmed' }),
  reconcile: async () => ({ result: 'unknown', attempts: [], receipts: [] }),
};

interface Fixture {
  directory: string;
  db: SqliteDatabase;
  store: CanonicalStoreBridge;
  application: BackendApplication;
}

async function fixture(chainId: typeof ETHEREUM | typeof ROBINHOOD, paid = false, executionEnabled = true, evidenceExpiresAt = '2099-01-01T00:00:00.000Z', includeVerification = true): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'mint-backend-'));
  const db = openDatabase(join(directory, 'state.sqlite'));
  const profileId = `profile-${chainId}`;
  db.prepare('INSERT INTO chain_profile (id, chain_id, name, rpc_endpoints_json, confirmation_depth, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(profileId, chainId, chainId === ETHEREUM ? 'Ethereum' : 'Robinhood', '[]', 2, NOW);
  db.prepare('UPDATE chain_profile SET execution_enabled = ?, verification_status = ? WHERE id = ?').run(chainId === ROBINHOOD ? 0 : executionEnabled ? 1 : 0, chainId === ROBINHOOD ? 'execution_blocked' : 'verified', profileId);
  if (includeVerification) db.prepare('INSERT INTO chain_verification (id, chain_profile_id, status, chain_id, sequencer_endpoint_reference, archive_endpoint_reference, feed_endpoint_reference, evidence_json, checked_at, approved_by, approved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(`verification-${chainId}`, profileId, chainId === ROBINHOOD ? 'execution_blocked' : 'verified', chainId, chainId === ROBINHOOD ? 'RH_SEQUENCER_REFERENCE' : null, chainId === ROBINHOOD ? 'RH_ARCHIVE_REFERENCE' : 'ETH_ARCHIVE_REFERENCE', chainId === ETHEREUM ? 'ETH_FEED_REFERENCE' : null, JSON.stringify({ seaDropCompatible: true, positiveLivePath: true, archiveForkPassed: true, reconciliationPassed: true, finalityPassed: true, endpointIdentity: chainId === ROBINHOOD ? 'RH_SEQUENCER_REFERENCE' : 'ETH_FEED_REFERENCE', sourceBlock: 1, sourceBlockHash: '0xblock', expiresAt: evidenceExpiresAt, acceptedAt: NOW, acceptedBy: 'test-operator', approvalProof: 'test-proof', strategyVersion: 'seadrop-v1-public@1' }), NOW, 'test-operator', NOW);
  db.prepare('INSERT INTO fee_policy (id, chain_profile_id, version, priority_fee_semantics, max_total_fee_wei, free_mint_total_fee_cap_wei, free_mint_priority_fee_component_wei, free_mint_priority_fee_multiplier, paid_mints_enabled, active, created_at, zero_priority_fee_policy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(`fee-${chainId}`, profileId, `test-${chainId}-${paid ? 'paid' : 'free'}`, chainId === ETHEREUM ? 'ordering' : 'fee_only', '34', '40', '20', 2, paid ? 1 : 0, 1, NOW, 'allowed');
  const store = new CanonicalStoreBridge(db, { now: () => new Date(NOW) });
  await store.open();
  return { directory, db, store, application: new BackendApplication(store, new ExecutionCoordinator(store, noopEngine)) };
}

async function close(fixtureValue: Fixture): Promise<void> {
  fixtureValue.store.close();
  await rm(fixtureValue.directory, { recursive: true, force: true });
}

function campaignInput(chainId: typeof ETHEREUM | typeof ROBINHOOD, paid = false) {
  const fee: FeePolicy = paid ? { kind: 'paid', configuredPriorityFeeWei: 20n, l2ExecutionGasBudgetWei: 10n, l1DataGasBudgetWei: 4n, totalFeeBudgetWei: 34n } : { kind: 'free', configuredPriorityFeeWei: 20n, freeTotalSpendCapWei: 40n, l2ExecutionGasBudgetWei: 10n, l1DataGasBudgetWei: 4n, totalFeeBudgetWei: 34n };
  return { chainId, contract: CONTRACT, strategy: 'seadrop-v1-public', quantity: 1, dryRun: false, maxRunWei: 1_000n, dailyCapWei: 1_000n, gasCeilingWei: 100n, broadcastMode: chainId === ETHEREUM ? 'public' as const : 'sequencer' as const, chainVerification: { chainId, status: 'verified' as const, seaDropCompatible: true, evidenceId: `verification-${chainId}`, checkedAt: NOW, sourceBlock: 1n, endpointReference: chainId === ETHEREUM ? 'ETH_FEED_REFERENCE' : 'RH_SEQUENCER_REFERENCE' }, mintPriceWei: paid ? 100n : 0n, feePolicy: fee };
}

async function campaign(fixtureValue: Fixture, chainId: typeof ETHEREUM | typeof ROBINHOOD, paid = false): Promise<Campaign> {
  const campaignValue = await fixtureValue.application.createCampaign(campaignInput(chainId, paid));
  for (const [index, address] of [WALLET_ONE, WALLET_TWO].entries()) {
    const walletId = `wallet-${chainId}-${index}`;
    fixtureValue.db.prepare('INSERT OR IGNORE INTO wallet (id, chain_profile_id, address, key_reference, created_at) VALUES (?, ?, ?, ?, ?)').run(walletId, `profile-${chainId}`, address, `test-key-${index}`, NOW);
    fixtureValue.db.prepare('INSERT OR IGNORE INTO campaign_wallet (campaign_id, wallet_id, enabled, selected_at) VALUES (?, ?, 1, ?)').run(campaignValue.id, walletId, NOW);
  }
  return campaignValue;
}

async function armed(fixtureValue: Fixture, campaignValue: Campaign, wallets: readonly string[] = [WALLET_ONE], simulationIds: readonly string[] = []): Promise<{ run: RunRecord; intent: IntentRecord; input: CanonicalAdmissionInput }> {
  const run: RunRecord = { id: `run-${campaignValue.id}`, intentId: `intent-${campaignValue.id}`, campaignId: campaignValue.id, mode: 'live', requestDigest: `fingerprint-${campaignValue.id}`, state: 'Armed', createdAt: NOW, updatedAt: NOW };
  const intent: IntentRecord = { id: run.intentId, runId: run.id, campaignId: campaignValue.id, campaignSnapshot: structuredClone(campaignValue), wallets: [...wallets], policy: structuredClone(campaignValue.spendPolicy), feePolicy: structuredClone(campaignValue.feePolicy), chainVerification: structuredClone(campaignValue.chainVerification), simulationIds: [...simulationIds], evidenceAt: NOW, createdAt: NOW };
  for (const [index, address] of wallets.entries()) {
    const walletId = `wallet-${campaignValue.chainId}-${index}`;
    fixtureValue.db.prepare('INSERT OR IGNORE INTO wallet (id, chain_profile_id, address, key_reference, created_at) VALUES (?, ?, ?, ?, ?)').run(walletId, `profile-${campaignValue.chainId}`, address, `test-key-${index}`, NOW);
    fixtureValue.db.prepare('INSERT OR IGNORE INTO campaign_wallet (campaign_id, wallet_id, enabled, selected_at) VALUES (?, ?, 1, ?)').run(campaignValue.id, walletId, NOW);
  }
  await fixtureValue.store.transaction((state) => { state.runs.push(run); state.intents.push(intent); });
  const persistedRun = fixtureValue.store.snapshot().runs.find((item) => item.id === run.id);
  if (!persistedRun) throw new Error('run missing');
  return { run: persistedRun, intent, input: { run: persistedRun, intent, campaign: campaignValue, wallets } };
}

describe('CanonicalStoreBridge', () => {
  it('does not infer Robinhood Ethereum-finality from an L2 confirmation', () => {
    expect(canonicalReceiptFinalityStage(ROBINHOOD, 'Confirmed')).toBe('unknown');
    expect(canonicalReceiptFinalityStage(ROBINHOOD, 'Confirmed', 'soft')).toBe('soft');
    expect(canonicalReceiptFinalityStage(ROBINHOOD, 'Confirmed', 'posted')).toBe('posted');
    expect(canonicalReceiptFinalityStage(ROBINHOOD, 'Confirmed', 'final')).toBe('ethereum_final');
    expect(canonicalReceiptFinalityStage(ETHEREUM, 'Confirmed')).toBe('ethereum_final');
  });

  it('rejects the JSON backend_state table as a live store', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mint-backend-schema-'));
    const db = openDatabase(join(directory, 'state.sqlite'));
    db.exec('CREATE TABLE backend_state (id TEXT PRIMARY KEY, state_json TEXT NOT NULL)');
    const store = new CanonicalStoreBridge(db);
    await expect(store.open()).rejects.toThrow('JSON_BACKEND_STATE_MUST_NOT_BE_LIVE');
    db.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('creates a canonical fee policy for a fresh chain profile', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mint-backend-fee-'));
    const db = openDatabase(join(directory, 'state.sqlite'));
    db.prepare('INSERT INTO chain_profile (id, chain_id, name, rpc_endpoints_json, confirmation_depth, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('profile-ethereum', ETHEREUM, 'Ethereum', '[]', 2, NOW);
    const store = new CanonicalStoreBridge(db, { now: () => new Date(NOW) });
    await store.open();
    try {
      await new BackendApplication(store, new ExecutionCoordinator(store, noopEngine)).createCampaign(campaignInput(ETHEREUM));
      expect(db.prepare('SELECT COUNT(*) AS count FROM fee_policy WHERE chain_profile_id = ?').get('profile-ethereum')).toEqual({ count: 1 });
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not bind an orphaned run to the first campaign', async () => {
    const value = await fixture(ETHEREUM);
    try {
      await value.application.createCampaign(campaignInput(ETHEREUM));
      value.db.prepare('INSERT INTO execution_run (id, request_id, request_fingerprint, campaign_id, state, actor, source, reason, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)').run('orphan-run', 'orphan-request', 'orphan-fingerprint', 'active', 'test', 'test', 'orphaned', NOW, NOW);
      expect(value.store.snapshot().runs.some((run) => run.id === 'orphan-run')).toBe(false);
      expect(value.store.snapshot().runtime.blockingReasons).toContain('ORPHANED_EXECUTION_RUN');
    } finally { await close(value); }
  });

  it('does not project verified status without a normalized chain-verification row', async () => {
    const value = await fixture(ETHEREUM, false, true, '2099-01-01T00:00:00.000Z', false);
    try {
      const campaignValue = await campaign(value, ETHEREUM);
      expect(value.store.snapshot().campaigns.find((item) => item.id === campaignValue.id)?.chainVerification.status).toBe('unverified');
    } finally { await close(value); }
  });

  it('rejects receipts whose execution graph has no canonical chain identity', async () => {
    const value = await fixture(ETHEREUM);
    try {
      await expect(value.store.transaction((state) => { state.receipts.push({ id: 'orphan-receipt', executionId: 'orphan-execution', runId: 'orphan-run', state: 'Confirmed', blockNumber: 1n, blockHash: '0xblock', actualSpendWei: 1n, observedAt: NOW }); })).rejects.toThrow('EXECUTION_CHAIN_REQUIRED');
    } finally { await close(value); }
  });

  it('persists first admission with intent, reservation, execution, and run linkage', async () => {
    const value = await fixture(ETHEREUM);
    try {
      const campaignValue = await campaign(value, ETHEREUM);
      const prepared = await armed(value, campaignValue);
      const admission = await value.store.admitExecution(prepared.input);
      const row = value.db.prepare('SELECT r.id AS reservation_id, r.execution_id AS reservation_execution_id, r.transaction_intent_id, e.id AS execution_id, e.reservation_id AS execution_reservation_id, e.run_id, ti.run_id AS intent_run_id, w.address FROM spend_reservation r JOIN execution e ON e.id = r.execution_id JOIN transaction_intent ti ON ti.id = r.transaction_intent_id JOIN wallet w ON w.id = ti.wallet_id WHERE r.id = ?').get(admission.reservations[0]!.id) as { reservation_id: string; reservation_execution_id: string; transaction_intent_id: string; execution_id: string; execution_reservation_id: string; run_id: string; intent_run_id: string; address: string };
      expect(row.reservation_execution_id).toBe(row.execution_id);
      expect(row.execution_reservation_id).toBe(row.reservation_id);
      expect(row.run_id).toBe(prepared.run.id);
      expect(row.intent_run_id).toBe(prepared.run.id);
      expect(row.address).toBe(WALLET_ONE);
      expect(admission.executions[0]!.executionId).toBe(row.execution_id);
    } finally { await close(value); }
  });

  it('preserves the Backend request digest across canonical arm replay', async () => {
    const value = await fixture(ETHEREUM);
    try {
      const campaignValue = await campaign(value, ETHEREUM);
      const validated = { campaign: campaignValue, wallets: [], simulationIds: [], evidenceAt: NOW };
      const first = await value.application.command('arm', { validated, mode: 'dry-run', idempotencyKey: 'canonical-arm-once' });
      const replay = await value.application.command('arm', { validated, mode: 'dry-run', idempotencyKey: 'canonical-arm-once' });
      expect(replay.id).toBe(first.id);
      expect(value.store.snapshot().runs.find((run) => run.id === first.id)?.requestDigest).toMatch(/^[a-f0-9]{64}$/);
    } finally { await close(value); }
  });

  it('admits multiple wallets exactly at the run and daily caps', async () => {
    const value = await fixture(ETHEREUM);
    try {
      const campaignValue = await value.application.createCampaign({ ...campaignInput(ETHEREUM), maxRunWei: 68n, dailyCapWei: 68n });
      const prepared = await armed(value, campaignValue, [WALLET_ONE, WALLET_TWO]);
      const admission = await value.store.admitExecution(prepared.input);
      expect(admission.reservations).toHaveLength(2);
      expect(admission.reservations.reduce((total, reservation) => total + reservation.amountWei, 0n)).toBe(68n);
      const rows = value.db.prepare('SELECT r.wallet_id, r.request_id, r.request_fingerprint, r.mint_class, r.fee_policy_id, r.fee_policy_version, r.fee_policy_snapshot_json, r.policy_snapshot_json, r.mint_period_id, e.request_id AS execution_request_id, e.request_fingerprint AS execution_request_fingerprint, ti.request_id AS intent_request_id, ti.request_fingerprint AS intent_request_fingerprint FROM spend_reservation r JOIN execution e ON e.id = r.execution_id JOIN transaction_intent ti ON ti.id = r.transaction_intent_id WHERE r.request_id = ? ORDER BY r.wallet_id').all(prepared.run.id) as Array<{ wallet_id: string; request_id: string; request_fingerprint: string; mint_class: string; fee_policy_id: string | null; fee_policy_version: string | null; fee_policy_snapshot_json: string; policy_snapshot_json: string; mint_period_id: string; execution_request_id: string | null; execution_request_fingerprint: string | null; intent_request_id: string | null; intent_request_fingerprint: string | null }>;
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((row) => row.wallet_id)).size).toBe(2);
      expect(new Set(rows.map((row) => row.request_id))).toEqual(new Set([prepared.run.id]));
      expect(new Set(rows.map((row) => row.request_fingerprint))).toEqual(new Set([value.store.snapshot().runs.find((run) => run.id === prepared.run.id)?.requestDigest]));
      for (const row of rows) {
        expect(row.mint_class).toBe('free');
        expect(row.fee_policy_id).toBeTruthy();
        expect(row.fee_policy_version).toBeTruthy();
        expect(JSON.parse(row.fee_policy_snapshot_json)).toMatchObject({ id: row.fee_policy_id, version: row.fee_policy_version });
        expect(row.mint_period_id).toBe(`campaign:${campaignValue.id}`);
        expect(JSON.parse(row.policy_snapshot_json)).toMatchObject({ mintClass: 'free', feePolicyId: row.fee_policy_id, feePolicyVersion: row.fee_policy_version, mintPeriodId: row.mint_period_id });
        expect(row.execution_request_id).toBe(row.intent_request_id);
        expect(row.execution_request_fingerprint).toBe(row.intent_request_fingerprint);
        expect(row.execution_request_id).toBe(prepared.intent.id);
      }
    } finally { await close(value); }
  });

  it('classifies paid Ethereum reservations with the active fee-policy snapshot', async () => {
    const value = await fixture(ETHEREUM, true);
    try {
      const campaignValue = await campaign(value, ETHEREUM, true);
      const prepared = await armed(value, campaignValue, [WALLET_ONE, WALLET_TWO]);
      const admission = await value.store.admitExecution(prepared.input);
      const rows = value.db.prepare('SELECT mint_class, fee_policy_id, fee_policy_version, fee_policy_snapshot_json, mint_period_id FROM spend_reservation WHERE request_id = ? ORDER BY id').all(prepared.run.id) as Array<{ mint_class: string; fee_policy_id: string | null; fee_policy_version: string | null; fee_policy_snapshot_json: string; mint_period_id: string }>;
      expect(admission.reservations).toHaveLength(2);
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.mint_class).toBe('paid');
        expect(row.fee_policy_id).toBeTruthy();
        expect(row.fee_policy_version).toBeTruthy();
        expect(JSON.parse(row.fee_policy_snapshot_json)).toMatchObject({ id: row.fee_policy_id, version: row.fee_policy_version, paidMintsEnabled: 1 });
        expect(row.mint_period_id).toBe(`campaign:${campaignValue.id}`);
      }
    } finally { await close(value); }
  });

  it('does not double-count an idempotent wallet when a later request adds a wallet', async () => {
    const value = await fixture(ETHEREUM);
    try {
      const campaignValue = await value.application.createCampaign({ ...campaignInput(ETHEREUM), maxRunWei: 68n, dailyCapWei: 68n });
      const prepared = await armed(value, campaignValue, [WALLET_ONE, WALLET_TWO]);
      await value.store.admitExecution({ ...prepared.input, wallets: [WALLET_ONE] });
      const admission = await value.store.admitExecution(prepared.input);
      expect(admission.reservations).toHaveLength(2);
      expect(admission.reservations.reduce((total, reservation) => total + reservation.amountWei, 0n)).toBe(68n);
    } finally { await close(value); }
  });

  it('replays an idempotent admission and rejects a changed fingerprint', async () => {
    const value = await fixture(ETHEREUM);
    try {
      const campaignValue = await campaign(value, ETHEREUM);
      const prepared = await armed(value, campaignValue);
      const first = await value.store.admitExecution(prepared.input);
      const second = await value.store.admitExecution(prepared.input);
      expect(second.reservations.map((item) => item.id)).toEqual(first.reservations.map((item) => item.id));
      await expect(value.store.admitExecution({ ...prepared.input, run: { ...prepared.run, requestDigest: 'different-fingerprint' } })).rejects.toThrow('IDEMPOTENCY_KEY_CONFLICT');
    } finally { await close(value); }
  });

  it('allows paid public Ethereum and blocks paid Robinhood', async () => {
    const ethereum = await fixture(ETHEREUM, true);
    const robinhood = await fixture(ROBINHOOD, true);
    try {
      const paidEthereum = await campaign(ethereum, ETHEREUM, true);
      expect(paidEthereum.mintPriceWei).toBe(100n);
      const freeOnPaidCapableEthereum = await ethereum.application.createCampaign(campaignInput(ETHEREUM, false));
      expect(ethereum.store.snapshot().campaigns.find((item) => item.id === freeOnPaidCapableEthereum.id)?.feePolicy.kind).toBe('free');
      await expect(robinhood.application.createCampaign(campaignInput(ROBINHOOD, true))).rejects.toThrow('ROBINHOOD_PAID_MINTS_DISABLED');
    } finally { await close(ethereum); await close(robinhood); }
  });

  it('rejects paid Ethereum at arm when daily all-in cap is lower than run cap', async () => {
    const value = await fixture(ETHEREUM, true);
    try {
      const input = campaignInput(ETHEREUM, true);
      const campaignValue: Campaign = { id: 'cmp-daily-arm', state: 'Draft', chainId: input.chainId, contract: input.contract, strategy: input.strategy, quantity: input.quantity, dryRun: false, spendPolicy: { maxRunWei: 1_000n, dailyCapWei: 50n, gasCeilingWei: input.gasCeilingWei }, chainVerification: input.chainVerification, mintPriceWei: input.mintPriceWei, feePolicy: input.feePolicy, broadcastMode: input.broadcastMode, createdAt: NOW, updatedAt: NOW };
      await value.store.transaction((state) => {
        state.campaigns.push(campaignValue);
        state.runtime = { startupState: 'Ready', blockingReasons: [], dependencies: { engine: true, chain: true, backup: true, notifications: true }, operational: { secretStoreReference: 'TEST_OPERATOR', storePath: 'state.sqlite', signerReady: true, killSwitchEngaged: false, notificationReady: true, chainVerification: 'verified', lastReconciliationAt: NOW, observedAt: NOW, expiresAt: '2099-01-01T00:00:00.000Z' } };
      });
      const walletId = `wallet-${ETHEREUM}-0`;
      value.db.prepare('INSERT OR IGNORE INTO wallet (id, chain_profile_id, address, key_reference, created_at) VALUES (?, ?, ?, ?, ?)').run(walletId, `profile-${ETHEREUM}`, WALLET_ONE, 'test-key-0', NOW);
      value.db.prepare('INSERT OR IGNORE INTO campaign_wallet (campaign_id, wallet_id, enabled, selected_at) VALUES (?, ?, 1, ?)').run(campaignValue.id, walletId, NOW);
      const persisted = value.store.snapshot().campaigns.find((item) => item.id === campaignValue.id);
      if (!persisted) throw new Error('campaign missing');
      await value.store.transaction((state) => { state.simulations.push({ id: 'simulation-daily-arm', campaignId: campaignValue.id, wallet: WALLET_ONE, inputDigest: campaignInputDigest(persisted), success: true, sourceBlock: 1n, sourceBlockHash: '0xblock', checkedAt: NOW, expiresAt: '2099-01-01T00:00:00.000Z', worstCaseFeeWei: 34n }); });
      const coordinator = new ExecutionCoordinator(value.store, noopEngine);
      await expect(coordinator.arm({ campaign: campaignValue, wallets: [WALLET_ONE], simulationIds: ['simulation-daily-arm'], evidenceAt: NOW }, 'live')).rejects.toThrow('PAID_ETHEREUM_CAP_REQUIRED');
    } finally { await close(value); }
  });

  it('blocks Robinhood admission even when mutable profile flags say enabled', async () => {
    const value = await fixture(ROBINHOOD, false, true);
    try {
      const campaignValue = await campaign(value, ROBINHOOD);
      const prepared = await armed(value, campaignValue);
      await expect(value.store.admitExecution(prepared.input)).rejects.toThrow('ROBINHOOD_EXECUTION_DISABLED');
    } finally { await close(value); }
  });

  it('preserves submitted work and aborts unsent work after a shared kill', async () => {
    const value = await fixture(ETHEREUM);
    try {
      const campaignValue = await campaign(value, ETHEREUM);
      const prepared = await armed(value, campaignValue, [WALLET_ONE, WALLET_TWO]);
      const admission = await value.store.admitExecution(prepared.input);
      const submitted: AttemptRecord = { id: 'attempt-submitted', executionId: admission.executions[0]!.executionId, runId: prepared.run.id, wallet: WALLET_ONE, hash: `0x${'b'.repeat(64)}`, nonce: 1, state: 'Submitted', createdAt: NOW, updatedAt: NOW };
      await value.store.transaction((state) => { state.attempts.push(submitted); state.killed = true; state.killReason = 'operator'; });
      await value.store.abortRemaining('operator');
      const executions = value.db.prepare('SELECT e.id, e.state, r.status FROM execution e JOIN spend_reservation r ON r.execution_id = e.id ORDER BY e.id').all() as Array<{ id: string; state: string; status: string }>;
      expect(executions.some((row) => row.id === admission.executions[0]!.executionId && row.state === 'submitted' && row.status === 'reserved')).toBe(true);
      expect(executions.some((row) => row.id === admission.executions[1]!.executionId && row.state === 'aborted' && row.status === 'released')).toBe(true);
      expect(value.store.snapshot().runs.find((run) => run.id === prepared.run.id)?.state).toBe('Aborted');
      await new ExecutionCoordinator(value.store, noopEngine).start();
      expect(value.store.snapshot().runtime.startupState).toBe('Blocked');
    } finally { await close(value); }
  });

  it('keeps startup blocked when an armed run has no authoritative reconciliation', async () => {
    const value = await fixture(ETHEREUM);
    try {
      const campaignValue = await campaign(value, ETHEREUM);
      await armed(value, campaignValue);
      await new ExecutionCoordinator(value.store, noopEngine).start();
      expect(value.store.snapshot().runtime.startupState).toBe('Blocked');
      expect(value.store.snapshot().runtime.blockingReasons).toContain('UNRESOLVED_EXECUTIONS');
    } finally { await close(value); }
  });

  it('blocks live admission and projects stale verified evidence as blocked', async () => {
    const value = await fixture(ETHEREUM, false, true, '2020-01-01T00:00:00.000Z');
    try {
      const campaignValue = await campaign(value, ETHEREUM);
      expect(value.store.snapshot().campaigns.find((item) => item.id === campaignValue.id)?.chainVerification.status).toBe('blocked');
      const prepared = await armed(value, campaignValue);
      await expect(value.store.admitExecution(prepared.input)).rejects.toThrow('CHAIN_VERIFICATION_REQUIRED');
    } finally { await close(value); }
  });

  it('reads total-only settlement without fabricating an L1 component', async () => {
    const value = await fixture(ETHEREUM);
    try {
      const campaignValue = await campaign(value, ETHEREUM);
      const prepared = await armed(value, campaignValue);
      const admission = await value.store.admitExecution(prepared.input);
      const executionId = admission.executions[0]!.executionId;
      await value.store.transaction((state) => {
        state.attempts.push({ id: 'attempt-success', executionId, runId: prepared.run.id, wallet: WALLET_ONE, hash: `0x${'c'.repeat(64)}`, nonce: 2, state: 'Submitted', createdAt: NOW, updatedAt: NOW });
        state.receipts.push({ id: 'receipt-success', executionId, runId: prepared.run.id, state: 'Confirmed', blockNumber: 12n, blockHash: `0x${'d'.repeat(64)}`, actualSpendWei: 17n, observedAt: NOW });
      });
      await value.store.transaction((state) => { const reservation = state.reservations.find((item) => item.id === admission.reservations[0]!.id); if (!reservation) throw new Error('reservation missing'); reservation.status = 'settled'; reservation.actualAmountWei = 17n; });
      const receipt = value.store.snapshot().receipts.find((item) => item.id === 'receipt-success');
      expect(receipt?.actualSpendWei).toBe(17n);
      const components = value.db.prepare('SELECT l2_execution_gas_wei, l1_data_gas_wei, priority_fee_component_wei FROM spend_reservation WHERE id = ?').get(admission.reservations[0]!.id) as { l2_execution_gas_wei: string; l1_data_gas_wei: string; priority_fee_component_wei: string };
      expect(components.l1_data_gas_wei).toBe('4');
      expect(components.priority_fee_component_wei).toBe('20');
    } finally { await close(value); }
  });

  it('does not charge mint value for a reverted lifecycle receipt', async () => {
    const value = await fixture(ETHEREUM, true);
    try {
      const campaignValue = await campaign(value, ETHEREUM, true);
      const prepared = await armed(value, campaignValue);
      const admission = await value.store.admitExecution(prepared.input);
      const execution = admission.executions[0]!;
      const txHash = `0x${'c'.repeat(64)}`;
      await value.store.persistEngineAttempt({ id: 'reverted-attempt', executionId: execution.executionId, transactionIntentId: execution.intentId, endpoint: 'public', responseClass: 'submitted', txHash, nonce: 7, attemptedAt: NOW });
      await value.store.persistEngineReceipt({ id: 'reverted-receipt', executionId: execution.executionId, transactionAttemptId: 'reverted-attempt', txHash, status: 'reverted', blockNumber: 18n, blockHash: `0x${'d'.repeat(64)}`, confirmations: 2, gasUsed: 2n, effectiveGasPrice: 4n, l1DataFeeWei: 4n, finalityStage: 'ethereum_final', finalitySource: 'receipt-watcher', observedAt: NOW });
      const accounting = value.db.prepare("SELECT policy_snapshot_json FROM audit_event WHERE entity_type = 'execution' AND entity_id = ? AND reason = 'lifecycle receipt accounting components'").get(execution.executionId) as { policy_snapshot_json: string } | undefined;
      expect(accounting ? JSON.parse(accounting.policy_snapshot_json) : undefined).toMatchObject({ actualMintValueWei: '0', actualL2ExecutionGasWei: '8', actualL1DataGasWei: '4', actualSpendWei: '12' });
      await value.store.settleExecutionComponents(admission.reservations[0]!.id, { actualMintValueWei: 0n, actualL2ExecutionGasWei: 8n, actualL1DataGasWei: 4n, actualPriorityFeeComponentWei: 0n, actualReplacementBudgetWei: 0n });
      const receipt = value.store.snapshot().receipts.find((item) => item.id === 'reverted-receipt');
      expect(receipt?.state).toBe('Failed');
      expect(receipt?.actualSpendWei).toBe(12n);
    } finally { await close(value); }
  });

  it('does not overwrite a provider-settled reservation during coordinator post-processing', async () => {
    const value = await fixture(ETHEREUM);
    try {
      const campaignValue = await campaign(value, ETHEREUM);
      const prepared = await armed(value, campaignValue, [WALLET_ONE], ['settlement-simulation']);
      await value.store.transaction((state) => {
        state.simulations.push({ id: 'settlement-simulation', campaignId: campaignValue.id, wallet: WALLET_ONE, inputDigest: campaignInputDigest(campaignValue), success: true, sourceBlock: 1n, sourceBlockHash: '0xblock', checkedAt: NOW, expiresAt: '2099-01-01T00:00:00.000Z', worstCaseFeeWei: 34n });
        state.runtime = { startupState: 'Ready', blockingReasons: [], dependencies: { engine: true, chain: true, backup: true, notifications: true }, operational: { secretStoreReference: 'TEST_OPERATOR', storePath: 'state.sqlite', signerReady: true, killSwitchEngaged: false, notificationReady: true, chainVerification: 'verified', lastReconciliationAt: NOW, observedAt: NOW, expiresAt: '2099-01-01T00:00:00.000Z' } };
      });
      const engine: EngineAdapter = {
        prepare: async () => ({ executionIds: [], attempts: [], receipts: [], state: 'Prepared' }),
        execute: async ({ reservationIds }) => {
          await value.store.transaction((state) => { const reservation = state.reservations.find((item) => item.id === reservationIds[0]); if (!reservation) throw new Error('reservation missing'); reservation.status = 'settled'; reservation.actualAmountWei = 17n; });
          return { executionIds: ['engine-generated'], attempts: [{ id: 'provider-attempt', executionId: 'engine-generated', runId: prepared.run.id, wallet: WALLET_ONE, hash: `0x${'e'.repeat(64)}`, nonce: 3, state: 'Submitted', createdAt: NOW, updatedAt: NOW }], receipts: [{ id: 'provider-receipt', executionId: 'engine-generated', runId: prepared.run.id, state: 'Confirmed', blockNumber: 15n, blockHash: `0x${'f'.repeat(64)}`, actualSpendWei: 5n, observedAt: NOW }], state: 'Confirmed' };
        },
        reconcile: async () => ({ result: 'unknown', attempts: [], receipts: [] }),
      };
      await new ExecutionCoordinator(value.store, engine).execute(prepared.run.id, [WALLET_ONE]);
      const snapshot = value.store.snapshot();
      const reservation = snapshot.reservations.find((item) => item.runId === prepared.run.id);
      expect(reservation?.status).toBe('settled');
      expect(reservation?.actualAmountWei).toBe(17n);
      expect(snapshot.receipts.find((item) => item.id === 'provider-receipt')?.actualSpendWei).toBe(17n);
    } finally { await close(value); }
  });

  it('binds lifecycle receipts to the exact Engine attempt across endpoints', async () => {
    const value = await fixture(ETHEREUM);
    try {
      const campaignValue = await campaign(value, ETHEREUM);
      const prepared = await armed(value, campaignValue);
      const admission = await value.store.admitExecution(prepared.input);
      const executionId = admission.executions[0]!.executionId;
      const transactionIntentId = admission.executions[0]!.intentId;
      await value.store.persistEngineAttempt({ id: 'endpoint-attempt-a', executionId, transactionIntentId, endpoint: 'provider-a', responseClass: 'accepted', txHash: `0x${'a'.repeat(64)}`, nonce: 4, attemptedAt: NOW });
      await value.store.persistEngineAttempt({ id: 'endpoint-attempt-b', executionId, transactionIntentId, endpoint: 'provider-b', responseClass: 'accepted', txHash: `0x${'b'.repeat(64)}`, nonce: 4, attemptedAt: NOW });
      await value.store.persistEngineReceipt({ id: 'endpoint-receipt', executionId, transactionAttemptId: 'endpoint-attempt-b', txHash: `0x${'b'.repeat(64)}`, status: 'confirmed', blockNumber: 16n, blockHash: `0x${'c'.repeat(64)}`, confirmations: 2, gasUsed: 3n, effectiveGasPrice: 2n, finalityStage: 'ethereum_final', observedAt: NOW });
      const row = value.db.prepare('SELECT transaction_attempt_id FROM transaction_receipt WHERE id = ?').get('endpoint-receipt') as { transaction_attempt_id: string };
      expect(row.transaction_attempt_id).toBe('endpoint-attempt-b');
      expect(value.store.snapshot().receipts.find((receipt) => receipt.id === 'endpoint-receipt')?.transactionAttemptId).toBe('endpoint-attempt-b');
    } finally { await close(value); }
  });

  it('does not charge mint value for a reverted lifecycle receipt', async () => {
    const value = await fixture(ETHEREUM, true);
    try {
      const campaignValue = await campaign(value, ETHEREUM, true);
      const prepared = await armed(value, campaignValue);
      const admission = await value.store.admitExecution(prepared.input);
      const executionId = admission.executions[0]!.executionId;
      const transactionIntentId = admission.executions[0]!.intentId;
      await value.store.persistEngineAttempt({ id: 'reverted-attempt', executionId, transactionIntentId, endpoint: 'provider', responseClass: 'accepted', txHash: `0x${'d'.repeat(64)}`, nonce: 5, attemptedAt: NOW });
      await value.store.persistEngineReceipt({ id: 'reverted-receipt', executionId, transactionAttemptId: 'reverted-attempt', txHash: `0x${'d'.repeat(64)}`, status: 'reverted', blockNumber: 17n, blockHash: `0x${'e'.repeat(64)}`, confirmations: 1, gasUsed: 3n, effectiveGasPrice: 2n, l1DataFeeWei: 4n, finalityStage: 'unknown', observedAt: NOW });
      const receipt = value.store.snapshot().receipts.find((item) => item.id === 'reverted-receipt');
      expect(receipt?.state).toBe('Failed');
      expect(receipt?.actualSpendWei).toBe(10n);
      expect(value.store.snapshot().attempts.find((item) => item.id === 'reverted-attempt')?.endpoint).toBe('provider');
    } finally { await close(value); }
  });

  it('persists an unresolved Robinhood receipt without inventing Ethereum finality', async () => {
    const store = new DurableStore();
    const campaignValue: Campaign = { id: 'rh-campaign', state: 'Armed', chainId: ROBINHOOD, contract: CONTRACT, strategy: 'seadrop-v1-public', quantity: 1, dryRun: false, broadcastMode: 'sequencer', spendPolicy: { maxRunWei: 1_000n, dailyCapWei: 1_000n, gasCeilingWei: 100n }, chainVerification: { chainId: ROBINHOOD, status: 'verified', seaDropCompatible: true, sourceBlock: 1n, endpointReference: 'RH_SEQUENCER_REFERENCE' }, mintPriceWei: 0n, feePolicy: { kind: 'free', configuredPriorityFeeWei: 20n, freeTotalSpendCapWei: 40n, l2ExecutionGasBudgetWei: 10n, l1DataGasBudgetWei: 4n, totalFeeBudgetWei: 34n }, createdAt: NOW, updatedAt: NOW };
    const run: RunRecord = { id: 'rh-run', intentId: 'rh-intent', campaignId: campaignValue.id, mode: 'live', requestDigest: 'rh-request', state: 'Armed', createdAt: NOW, updatedAt: NOW };
    const intent: IntentRecord = { id: run.intentId, runId: run.id, campaignId: campaignValue.id, campaignSnapshot: campaignValue, wallets: [WALLET_ONE], policy: campaignValue.spendPolicy, feePolicy: campaignValue.feePolicy, chainVerification: campaignValue.chainVerification, simulationIds: [], evidenceAt: NOW, createdAt: NOW };
    const executionId = 'rh-execution';
    await store.transaction((state) => { state.campaigns.push(campaignValue); state.runs.push(run); state.intents.push(intent); state.attempts.push({ id: 'rh-attempt', executionId, runId: run.id, wallet: WALLET_ONE, hash: `0x${'a'.repeat(64)}`, nonce: 3, state: 'Submitted', createdAt: NOW, updatedAt: NOW }); state.reservations.push({ id: 'rh-reservation', runId: run.id, campaignId: campaignValue.id, chainId: ROBINHOOD, wallet: WALLET_ONE, amountWei: 100n, accountingDate: '2026-09-14', status: 'reserved', createdAt: NOW, updatedAt: NOW }); });
    const engine: EngineAdapter = {
      prepare: async () => ({ executionIds: [], attempts: [], receipts: [], state: 'Prepared' }),
      execute: async () => ({ executionIds: [], attempts: [], receipts: [], state: 'Prepared' }),
      reconcile: async (currentRun) => ({ result: 'unknown', attempts: [{ id: 'rh-reconciled-attempt', executionId, runId: currentRun.id, wallet: WALLET_ONE, hash: `0x${'a'.repeat(64)}`, nonce: 3, state: 'Confirmed', createdAt: NOW, updatedAt: NOW }], receipts: [{ id: 'rh-reconciled-receipt', executionId, runId: currentRun.id, state: 'Confirmed', blockNumber: 15n, blockHash: `0x${'b'.repeat(64)}`, actualSpendWei: 12n, observedAt: NOW }], reason: 'Robinhood L2 receipt requires an authoritative Ethereum-final observer' }),
    };
    await new ExecutionCoordinator(store, engine).reconcile();
    const receipt = store.snapshot().receipts.find((item) => item.id === 'rh-reconciled-receipt');
    expect(receipt?.robinhoodFinality).toBeUndefined();
    expect(store.snapshot().reservations.find((item) => item.runId === run.id)?.status).toBe('reserved');
  });

  it('fails closed for unsupported new reservation mutations and persists normalized notification/simulation facts', async () => {
    const value = await fixture(ETHEREUM);
    try {
      const campaignValue = await campaign(value, ETHEREUM);
      await expect(value.store.transaction((state) => { state.reservations.push({ id: 'unadmitted', runId: 'run', campaignId: campaignValue.id, chainId: ETHEREUM, wallet: WALLET_ONE, amountWei: 1n, accountingDate: '2026-09-14', status: 'reserved', createdAt: NOW, updatedAt: NOW }); })).rejects.toThrow('CANONICAL_RESERVATION_ADMISSION_REQUIRED');
      await value.store.transaction((state) => { state.notificationOutbox.push({ id: 'notification-1', sourceEventId: 'event-1', type: 'health', text: 'blocked', state: 'pending', attempts: 0, createdAt: NOW }); });
      await value.store.transaction((state) => { state.simulations.push({ id: 'simulation-1', campaignId: campaignValue.id, wallet: WALLET_ONE, inputDigest: 'input', success: true, sourceBlock: 1n, sourceBlockHash: '0xblock', checkedAt: NOW, expiresAt: '2026-09-14T15:00:00.000Z', worstCaseFeeWei: 34n }); });
      expect(value.store.snapshot().notificationOutbox[0]?.id).toBe('notification-1');
      expect(value.store.snapshot().simulations[0]?.id).toBe('simulation-1');
    } finally { await close(value); }
  });

  it('rejects Robinhood evidence without a distinct archive reference', async () => {
    const value = await fixture(ROBINHOOD);
    try {
      const evidence: ChainEvidenceRecord = { id: 'rh-evidence', chainId: ROBINHOOD, status: 'accepted', executionEnabled: false, seaDropCompatible: true, positiveLivePath: true, archiveForkPassed: true, negativeCases: { revert: true, sold_out: true, price_drift: true, insufficient_funds: true, quantity_limit: true, stale_phase: true, fee_recipient: true, kill: true, cap: true }, reconciliationPassed: true, finalityPassed: true, endpointIdentity: 'RH_SEQUENCER_REFERENCE', strategyVersion: 'test', checkedAt: NOW, expiresAt: '2026-09-15T00:00:00.000Z', sourceBlock: 1n, sourceBlockHash: '0xblock' };
      await expect(value.store.transaction((state) => { state.chainEvidence.push(evidence); })).rejects.toThrow('ROBINHOOD_ARCHIVE_REFERENCE_REQUIRED');
    } finally { await close(value); }
  });
});
