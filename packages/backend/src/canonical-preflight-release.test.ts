import { afterEach, describe, expect, it, vi } from 'vitest';
import { rebindExecutionResult } from './canonical-store.js';
import type { TransactionIntentRecord } from '@mint-bot/database';
import { ExecutionCoordinator } from './coordinator.js';
import { campaignInputDigest } from './evidence.js';
import { ETHEREUM, NOW, WALLET_ONE, WALLET_TWO, fixture, campaign, armed, close } from './canonical-fixtures.js';
import type { EngineAdapter, ExecutionResult, NeverStartedWalletEvidence } from './types.js';

afterEach(() => vi.useRealTimers());
const proof = (runId: string, wallet = WALLET_ONE): NeverStartedWalletEvidence => ({ runId, wallet, proof: 'engine-preflight-v1' });

describe('explicit engine preflight reservation cleanup', () => {
  it('releases all positively stopped wallets, records why and is idempotent', async () => {
    const value = await fixture(ETHEREUM);
    try {
      const prep = await armed(value, await campaign(value, ETHEREUM), [WALLET_ONE, WALLET_TWO]);
      await value.store.admitExecution(prep.input);
      const evidence = [proof(prep.run.id), proof(prep.run.id, WALLET_TWO)];
      expect(await value.store.releaseNeverStartedWallets(prep.run.id, evidence)).toEqual({ released: [WALLET_ONE, WALLET_TWO], retained: [] });
      expect(value.store.snapshot().reservations.every((item) => item.status === 'released')).toBe(true);
      expect(value.db.prepare('SELECT DISTINCT state FROM execution WHERE run_id = ?').all(prep.run.id)).toEqual([{ state: 'aborted' }]);
      const audits = value.store.snapshot().events.filter((event) => event.type === 'wallet_preflight_reservation_released').length;
      expect(audits).toBe(2);
      await value.store.releaseNeverStartedWallets(prep.run.id, evidence);
      expect(value.store.snapshot().events.filter((event) => event.type === 'wallet_preflight_reservation_released')).toHaveLength(audits);
    } finally { await close(value); }
  });
  it.each(['signed', 'nonce', 'calldata', 'intent-state', 'attempt-no-hash', 'attempt-with-hash', 'intent-only-attempt'] as const)('retains ambiguous %s exposure while releasing only the proven other wallet', async (kind) => {
    const value = await fixture(ETHEREUM);
    try {
      if (kind === 'nonce' || kind === 'calldata') {
        // Create an already-built immutable intent fixture; never disable the
        // production immutable-intent trigger to manufacture this test state.
        const databaseStore = (value.store as unknown as { databaseStore: { saveIntent(record: TransactionIntentRecord): void } }).databaseStore;
        const save = databaseStore.saveIntent.bind(databaseStore);
        vi.spyOn(databaseStore, 'saveIntent').mockImplementation((record) => save(record.fromAddress === WALLET_ONE ? { ...record, ...(kind === 'nonce' ? { nonce: 7 } : { calldata: '0x1234' }) } : record));
      }
      const prep = await armed(value, await campaign(value, ETHEREUM), [WALLET_ONE, WALLET_TWO]);
      const admission = await value.store.admitExecution(prep.input);
      const first = admission.executions.find((item) => item.wallet === WALLET_ONE)!;
      if (kind === 'signed') value.db.prepare("UPDATE execution SET state = 'signed' WHERE id = ?").run(first.executionId);
      else if (kind === 'intent-state') value.db.prepare("INSERT INTO state_transition (id,entity_type,entity_id,prior_state,new_state,actor,source,reason,occurred_at) VALUES ('advanced-intent','transaction_intent',?,'prepared','signed','test','test','advanced intent',?)").run(first.intentId, NOW);
      else if (kind !== 'nonce' && kind !== 'calldata') {
        const row = value.db.prepare('SELECT chain_profile_id FROM transaction_intent WHERE id = ?').get(first.intentId) as { chain_profile_id: string };
        value.db.prepare('INSERT INTO transaction_attempt (id,transaction_intent_id,execution_id,endpoint,response_class,tx_hash,attempted_at,chain_profile_id) VALUES (?,?,?,?,?,?,?,?)').run(`attempt-${kind}`, first.intentId, kind === 'intent-only-attempt' ? null : first.executionId, 'fixture', 'unknown', kind === 'attempt-with-hash' ? `0x${'a'.repeat(64)}` : null, NOW, row.chain_profile_id);
      }
      expect(await value.store.releaseNeverStartedWallets(prep.run.id, [proof(prep.run.id), proof(prep.run.id, WALLET_TWO)])).toEqual({ released: [WALLET_TWO], retained: [WALLET_ONE] });
      const reservations = value.store.snapshot().reservations;
      expect(reservations.find((item) => item.wallet === WALLET_ONE)?.status).toBe('reserved');
      expect(reservations.find((item) => item.wallet === WALLET_TWO)?.status).toBe('released');
    } finally { await close(value); }
  });
  it('does nothing without positive evidence and rejects foreign/duplicate claims atomically', async () => {
    const value = await fixture(ETHEREUM);
    try {
      const one = await armed(value, await campaign(value, ETHEREUM), [WALLET_ONE]);
      const two = await armed(value, await campaign(value, ETHEREUM), [WALLET_TWO]);
      await value.store.admitExecution(one.input); await value.store.admitExecution(two.input);
      expect(await value.store.releaseNeverStartedWallets(one.run.id, [])).toEqual({ released: [], retained: [] });
      await expect(value.store.releaseNeverStartedWallets(one.run.id, [proof(one.run.id), proof(one.run.id, WALLET_TWO)])).rejects.toThrow('UNADMITTED_NEVER_STARTED_WALLET');
      await expect(value.store.releaseNeverStartedWallets(one.run.id, [proof(two.run.id)])).rejects.toThrow('INVALID_NEVER_STARTED_WALLET_EVIDENCE');
      await expect(value.store.releaseNeverStartedWallets(one.run.id, [proof(one.run.id), proof(one.run.id)])).rejects.toThrow('INVALID_NEVER_STARTED_WALLET_EVIDENCE');
      expect(value.store.snapshot().reservations.every((item) => item.status === 'reserved')).toBe(true);
    } finally { await close(value); }
  });
  it('does not accept a never-started claim conflicting with returned engine attempts', () => {
    const result: ExecutionResult = { state: 'Pending', executionIds: ['source-exec'], attempts: [{ id: 'a', executionId: 'source-exec', runId: 'r', wallet: WALLET_ONE, state: 'Signed', createdAt: NOW, updatedAt: NOW }], receipts: [], neverStartedWallets: [proof('r')] };
    expect(() => rebindExecutionResult(result, [{ wallet: WALLET_ONE, intentId: 'i', executionId: 'canonical-exec' }])).toThrow('INVALID_NEVER_STARTED_WALLET_EVIDENCE');
  });
  it.each([false, true])('coordinator closes preprocessing reservations while preserving other-wallet pending=%s', async (pending) => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
    const value = await fixture(ETHEREUM);
    try {
      const currentCampaign = await campaign(value, ETHEREUM);
      const wallets = pending ? [WALLET_ONE, WALLET_TWO] : [WALLET_ONE];
      const simulations = wallets.map((_, index) => `sim-preflight-${index}`);
      const prep = await armed(value, currentCampaign, wallets, simulations);
      await value.store.transaction((state) => {
        state.simulations.push(...wallets.map((wallet, index) => ({ id: simulations[index]!, campaignId: currentCampaign.id, wallet, inputDigest: campaignInputDigest(currentCampaign), success: true, sourceBlock: 1n, sourceBlockHash: '0xblock', checkedAt: NOW, expiresAt: new Date(Date.parse(NOW) + 300_000).toISOString(), worstCaseFeeWei: 34n })));
        state.runtime = { startupState: 'Ready', blockingReasons: [], dependencies: { engine: true, chain: true, backup: true, notifications: true }, operational: { secretStoreReference: 'TEST_OPERATOR', storePath: 'state.sqlite', signerReady: true, custody: { provider: 'turnkey', providerIdentity: 'turnkey-test-org', policyReference: 'turnkey-test-policy', policyDigest: `0x${'1'.repeat(64)}`, policyStatus: 'approved', healthStatus: 'healthy', attestationStatus: 'verified', evidenceId: 'custody-evidence-1', observedAt: NOW, expiresAt: '2099-01-01T00:00:00.000Z' }, killSwitchEngaged: false, notificationReady: true, chainVerification: 'verified', lastReconciliationAt: NOW, observedAt: NOW, expiresAt: '2099-01-01T00:00:00.000Z' } };
      });
      const engine: EngineAdapter = { prepare: async () => ({ executionIds: [], attempts: [], receipts: [], state: 'Prepared' }), reconcile: async () => ({ result: 'unknown', attempts: [], receipts: [] }), execute: async () => ({ executionIds: pending ? ['pending-wallet'] : [], attempts: pending ? [{ id: 'pending-attempt', executionId: 'pending-wallet', runId: prep.run.id, wallet: WALLET_TWO, nonce: 3, hash: `0x${'a'.repeat(64)}`, state: 'Pending', createdAt: NOW, updatedAt: NOW }] : [], receipts: [], state: pending ? 'Pending' : 'Failed', neverStartedWallets: [proof(prep.run.id)] }) };
      await new ExecutionCoordinator(value.store, engine).execute(prep.run.id, wallets);
      const state = value.store.snapshot();
      expect(state.reservations.find((item) => item.wallet === WALLET_ONE)?.status).toBe('released');
      if (pending) {
        expect(state.reservations.find((item) => item.wallet === WALLET_TWO)?.status).toBe('reserved');
        expect(state.runs.find((item) => item.id === prep.run.id)?.state).toBe('Active');
      } else expect(state.runs.find((item) => item.id === prep.run.id)?.state).toBe('Failed');
    } finally { await close(value); }
  });
});
