import { describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import { DurableRepository } from './repositories.js';
import { ReadModels } from './read-models.js';

function fixture() {
  const db = openDatabase();
  db.prepare("INSERT INTO chain_profile (id, chain_id, name, rpc_endpoints_json, confirmation_depth, verification_status, verification_evidence_json, verification_approved_by, verification_approved_at, execution_enabled, created_at) VALUES ('chain', 1, 'Ethereum', '[]', 2, 'verified', '{\"fixture\":\"approved\",\"finalityPassed\":true}', 'fixture', '2025-12-31T00:00:00.000Z', 1, '2026-01-01T00:00:00.000Z')").run();
  db.prepare("INSERT INTO wallet (id, chain_profile_id, address, key_reference, created_at) VALUES ('wallet', 'chain', '0xabc', 'kms://wallet', '2026-01-01T00:00:00.000Z')").run();
  db.prepare("INSERT INTO spend_policy (id, wallet_id, daily_cap_wei, version, active) VALUES ('policy', 'wallet', '1000000000000000000', 'v1', 1)").run();
  db.prepare("INSERT INTO contract (id, chain_profile_id, address, kind) VALUES ('contract', 'chain', '0xcontract', 'nft')").run();
  db.prepare("INSERT INTO collection (id, contract_id, name) VALUES ('collection', 'contract', 'Collection')").run();
  db.prepare("INSERT INTO \"drop\" (id, collection_id, strategy, mint_price_wei, observed_at) VALUES ('drop', 'collection', 'fcfs', '0', '2026-01-01T00:00:00.000Z')").run();
  db.prepare("INSERT INTO campaign (id, drop_id, state, created_at) VALUES ('campaign', 'drop', 'draft', '2026-01-01T00:00:00.000Z')").run();
  db.prepare("INSERT INTO campaign_wallet (campaign_id, wallet_id, enabled, selected_at) VALUES ('campaign', 'wallet', 1, '2026-01-01T00:00:00.000Z')").run();
  return db;
}

describe('Phase 2 durable read model', () => {
  it('persists the Product Owner freshness and retention defaults', () => {
    const db = fixture();
    expect(db.prepare("SELECT subject_type, max_age_seconds FROM freshness_policy WHERE id IN ('readiness-v1', 'discovery-v1', 'calendar-v1') ORDER BY id").all()).toEqual([
      { subject_type: 'calendar', max_age_seconds: 900 },
      { subject_type: 'discovery', max_age_seconds: 900 },
      { subject_type: 'readiness', max_age_seconds: 300 },
    ]);
    expect(db.prepare("SELECT entity_type, retention_days FROM retention_policy WHERE id IN ('read-model-30d', 'alert-30d', 'phase2-event-90d') ORDER BY id").all()).toEqual([
      { entity_type: 'alert', retention_days: 30 },
      { entity_type: 'event', retention_days: 90 },
      { entity_type: 'read_model_snapshot', retention_days: 30 },
    ]);
    db.close();
  });

  it('deduplicates jobs and recovers an expired lease after restart', () => {
    const db = fixture();
    const repository = new DurableRepository(db);
    const job = { id: 'job-1', type: 'refresh-read-model', entityType: 'campaign', entityId: 'campaign', idempotencyKey: 'job-key', payload: { campaignId: 'campaign' }, scheduledAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
    repository.saveJob(job);
    repository.saveJob(job);
    expect(db.prepare('SELECT COUNT(*) AS count FROM job').get()).toEqual({ count: 1 });
    expect(() => repository.saveJob({ ...job, payload: { campaignId: 'other' } })).toThrow('idempotency');
    expect(repository.claimJob('job-1', 'operator', '2026-01-01T00:05:00.000Z', new Date('2026-01-01T00:00:01.000Z'))?.state).toBe('running');
    expect(repository.recoverExpiredJobs(new Date('2026-01-01T00:10:00.000Z'))).toBe(1);
    expect(repository.claimJob('job-1', 'operator-restarted', '2026-01-01T00:15:00.000Z', new Date('2026-01-01T00:10:01.000Z'))?.attemptCount).toBe(2);
    db.close();
  });

  it('fails closed on unapproved chains, stale simulation bounds, and disabled membership', () => {
    const db = fixture();
    const repository = new DurableRepository(db);
    db.prepare("INSERT INTO chain_profile (id, chain_id, name, rpc_endpoints_json, confirmation_depth, created_at) VALUES ('unapproved-chain', 2, 'Test', '[]', 1, '2026-01-01T00:00:00.000Z')").run();
    expect(() => repository.recordChainVerification({ id: 'unapproved-check', chainProfileId: 'unapproved-chain', status: 'verified', chainId: 2, executionEnabled: true, checkedAt: '2026-01-01T00:00:00.000Z' })).toThrow('approved finality evidence');
    expect(() => db.prepare("UPDATE chain_profile SET verification_status = 'verified', execution_enabled = 1 WHERE id = 'unapproved-chain'").run()).toThrow('substantive finality evidence');
    expect(() => repository.recordSimulation({ id: 'too-fresh', walletId: 'wallet', campaignId: 'campaign', sourceBlockNumber: 1, checkedAt: '2026-01-01T00:00:00.000Z', freshnessSeconds: 60, outcome: 'pass', toolVersion: 'test' })).toThrow('between five minutes');
    expect(() => repository.recordSimulation({ id: 'future-simulation', walletId: 'wallet', campaignId: 'campaign', sourceBlockNumber: 1, checkedAt: '2099-01-01T00:00:00.000Z', freshnessSeconds: 300, outcome: 'pass', toolVersion: 'test' })).toThrow('future');
    db.prepare("UPDATE campaign_wallet SET enabled = 0 WHERE campaign_id = 'campaign' AND wallet_id = 'wallet'").run();
    expect(() => repository.recordReadiness({ id: 'disabled-readiness', campaignId: 'campaign', walletId: 'wallet', state: 'failed', decision: 'blocked', nextAction: 'Inspect', checkedAt: '2026-01-01T00:00:00.000Z' })).toThrow('enabled campaign wallet membership');
    db.close();
  });

  it('rejects secret-like metadata and redacts custody references from reads', () => {
    const db = fixture();
    const repository = new DurableRepository(db);
    expect(() => repository.saveWalletMetadata({ id: 'wallet', label: 'privateKey: do-not-store', updatedAt: '2026-01-01T00:00:01.000Z' })).toThrow('secret-like');
    repository.recordProvenance({ id: 'wallet-prov', kind: 'backend_store', recordType: 'wallet', recordId: 'wallet', observedAt: '2026-01-01T00:00:01.000Z', sourceRef: 'operator:wallet-import', createdAt: '2026-01-01T00:00:01.000Z' });
    repository.saveWalletMetadata({ id: 'wallet', label: 'Primary', updatedAt: '2026-01-01T00:00:01.000Z', metadataProvenanceId: 'wallet-prov' });
    repository.recordWalletBalance({ walletId: 'wallet', nativeBalanceWei: '123456789012345678901234567890', observedAt: '2026-01-01T00:00:01.000Z', expiresAt: '2026-01-01T00:05:01.000Z', freshnessPolicyId: 'wallet-balance-v1', provenanceId: 'wallet-prov' });
    const wallet = new ReadModels(db).wallet('wallet', new Date('2026-01-01T00:00:02.000Z'))!;
    expect(wallet.balance.amount?.value).toBe('123456789012345678901234567890');
    expect(JSON.stringify(wallet)).not.toContain('key_reference');
    expect(() => repository.recordProvenance({ id: 'url-prov', kind: 'chain_observation', recordType: 'wallet', recordId: 'wallet', observedAt: '2026-01-01T00:00:01.000Z', sourceRef: 'https://provider.invalid', createdAt: '2026-01-01T00:00:01.000Z' })).toThrow('opaque');
    db.close();
  });

  it('keeps readiness, provenance, evidence, and finality history append-only', () => {
    const db = fixture();
    const repository = new DurableRepository(db);
    repository.recordProvenance({ id: 'ready-prov', kind: 'eligibility_check', recordType: 'readiness_snapshot', recordId: 'ready-1', observedAt: '2026-01-01T00:00:00.000Z', policyVersion: 'v1', createdAt: '2026-01-01T00:00:00.000Z' });
    repository.recordReadiness({ id: 'ready-1', campaignId: 'campaign', walletId: 'wallet', state: 'ready', decision: 'ready', nextAction: 'Inspect', checkedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-01T00:05:00.000Z', policyVersion: 'v1', provenanceId: 'ready-prov', checks: [{ id: 'check-funded', code: 'funded', outcome: 'pass', required: true, message: 'Wallet balance observed', provenanceId: 'ready-prov' }] });
    const readiness = new ReadModels(db).readinessSnapshots('campaign', 'wallet');
    expect(readiness[0]?.decision).toBe('ready');
    expect(readiness[0]?.checks[0]?.outcome).toBe('pass');
    expect(() => db.prepare("UPDATE readiness_snapshot SET decision = 'blocked' WHERE id = 'ready-1'").run()).toThrow('append-only');

    db.prepare("INSERT INTO transaction_intent (id, campaign_id, wallet_id, intent_class, to_address, value_wei, calldata, chain_profile_id, created_at) VALUES ('intent-finality', 'campaign', 'wallet', 'mint', '0xcontract', '0', '0x', 'chain', '2026-01-01T00:00:00.000Z')").run();
    db.prepare("INSERT INTO execution (id, campaign_id, wallet_id, transaction_intent_id, state, created_at, updated_at) VALUES ('execution-finality', 'campaign', 'wallet', 'intent-finality', 'prepared', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')").run();
    db.prepare("INSERT INTO chain_profile (id, chain_id, name, rpc_endpoints_json, confirmation_depth, created_at) VALUES ('other-chain', 2, 'Other', '[]', 1, '2026-01-01T00:00:00.000Z')").run();
    expect(() => repository.recordFinalityObservation({ id: 'wrong-finality-chain', executionId: 'execution-finality', chainProfileId: 'other-chain', stage: 'soft', settlementReached: false, observedAt: '2026-01-01T00:00:30.000Z' })).toThrow('identity');
    repository.recordFinalityObservation({ id: 'finality-soft', executionId: 'execution-finality', chainProfileId: 'chain', stage: 'soft', settlementReached: false, observedAt: '2026-01-01T00:01:00.000Z' });
    repository.recordFinalityObservation({ id: 'finality-final', executionId: 'execution-finality', chainProfileId: 'chain', stage: 'ethereum_final', settlementReached: true, observedAt: '2026-01-01T00:02:00.000Z' });
    expect(new ReadModels(db).finalityHistory('execution-finality').map((item) => item.stage)).toEqual(['soft', 'ethereum_final']);
    db.close();
  });

  it('requires reconciliation identity, policy version, and source evidence', () => {
    const db = fixture();
    const repository = new DurableRepository(db);
    repository.saveIntent({ id: 'intent-reconcile', campaignId: 'campaign', walletId: 'wallet', intentClass: 'mint', toAddress: '0xcontract', valueWei: 0n, calldata: '0x', chainProfileId: 'chain', createdAt: '2026-01-01T00:00:00.000Z' });
    repository.saveExecution({ id: 'execution-reconcile', campaignId: 'campaign', walletId: 'wallet', transactionIntentId: 'intent-reconcile', state: 'prepared', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
    repository.recordAttempt({ id: 'attempt-reconcile', transactionIntentId: 'intent-reconcile', executionId: 'execution-reconcile', endpoint: 'test', responseClass: 'accepted', txHash: '0xreconcile', nonce: 1, attemptedAt: '2026-01-01T00:00:01.000Z' });
    expect(() => repository.recordReconciliation({ id: 'missing-evidence', chainProfileId: 'chain', transactionAttemptId: 'attempt-reconcile', txHash: '0xreconcile', fromAddress: '0xabc', nonce: 1, state: 'matched', source: 'test', checkedAt: '2026-01-01T00:00:02.000Z' })).toThrow('policy version and source evidence');
    expect(() => repository.recordReconciliation({ id: 'wrong-identity', chainProfileId: 'chain', transactionAttemptId: 'attempt-reconcile', txHash: '0xother', fromAddress: '0xabc', nonce: 1, state: 'matched', source: 'test', policyVersion: 'reconciliation-v1', details: { sourceEvidence: 'attempt' }, checkedAt: '2026-01-01T00:00:02.000Z' })).toThrow('identity does not match');
    repository.recordReconciliation({ id: 'valid-reconciliation', chainProfileId: 'chain', transactionAttemptId: 'attempt-reconcile', executionId: 'execution-reconcile', txHash: '0xreconcile', fromAddress: '0xabc', nonce: 1, state: 'matched', source: 'test', policyVersion: 'reconciliation-v1', details: { sourceEvidence: 'attempt' }, checkedAt: '2026-01-01T00:00:02.000Z' });
    expect(db.prepare('SELECT policy_version, state FROM reconciliation_record WHERE id = ?').get('valid-reconciliation')).toEqual({ policy_version: 'reconciliation-v1', state: 'matched' });
    db.close();
  });

  it('persists alert delivery state and exact decimal-string spend summaries', () => {
    const db = fixture();
    const repository = new DurableRepository(db);
    repository.appendEvent({ id: 'event-alert', type: 'readiness.updated', entityType: 'campaign', entityId: 'campaign', idempotencyKey: 'event-alert-key', payload: { state: 'ready' }, occurredAt: '2026-01-01T00:00:00.000Z' });
    const delivery = repository.enqueueAlert({ id: 'alert-1', eventId: 'event-alert', idempotencyKey: 'alert-key', alertType: 'readiness', severity: 'info', subjectType: 'campaign', subjectId: 'campaign', payload: { message: 'ready' }, canonicalRef: '/campaigns/campaign/readiness', createdAt: '2026-01-01T00:00:00.000Z', channel: 'operator' });
    expect(repository.claimAlertDelivery(delivery.id, new Date('2026-01-01T00:00:01.000Z'))?.deliveryState).toBe('delivering');
    repository.completeAlertDelivery(delivery.id, new Date('2026-01-01T00:00:02.000Z'));
    expect(new ReadModels(db).alerts()[0]?.deliveryState).toBe('delivered');
    repository.saveOpportunity({ id: 'opportunity-1', chainProfileId: 'chain', fingerprint: 'fingerprint-1', createdAt: '2026-01-01T00:00:00.000Z' });
    repository.recordOpportunityEvidence({ id: 'evidence-1', opportunityId: 'opportunity-1', evidenceType: 'calendar', label: 'Opening', summary: 'Observed opening', observedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-01T00:15:00.000Z' });
    repository.recordOpportunityScore({ id: 'score-1', opportunityId: 'opportunity-1', score: 72.5, modelVersion: 'model-v1', confidenceSampleSize: '12', calculatedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-01T00:15:00.000Z' });
    repository.recordOpportunityRisk({ id: 'risk-1', opportunityId: 'opportunity-1', code: 'unverified', severity: 'warning', message: 'Verification is pending', observedAt: '2026-01-01T00:00:00.000Z' });
    repository.recordOpportunityGateCheck({ id: 'gate-1', opportunityId: 'opportunity-1', code: 'chain_verified', outcome: 'unknown', required: true, message: 'Verification is pending', evaluatedAt: '2026-01-01T00:00:00.000Z' });
    const opportunity = new ReadModels(db).opportunityDetails('opportunity-1', new Date('2026-01-01T00:00:01.000Z'))!;
    expect(opportunity.score?.value).toBe(72.5);
    expect(opportunity.evidence).toHaveLength(1);
    expect(opportunity.risks[0]?.severity).toBe('warning');
    db.prepare("INSERT INTO spend_reservation (id, wallet_id, idempotency_key, policy_id, amount_wei, reserved_amount_wei, usage_date, status, created_at) VALUES ('spend-phase2', 'wallet', 'phase2-spend', 'policy', '123456789012345678901234567890', '123456789012345678901234567890', '2026-01-01', 'reserved', '2026-01-01T00:00:00.000Z')").run();
    const summary = repository.refreshSpendSummary('wallet', 'wallet', { asOf: '2026-01-01T00:00:03.000Z' });
    expect(summary.reservedAmountWei).toBe('123456789012345678901234567890');
    expect(new ReadModels(db).spendSummaries('wallet', 'wallet')[0]?.reservedAmount.amount?.value).toBe('123456789012345678901234567890');
    expect(() => db.prepare("UPDATE spend_summary SET as_of = '2026-01-02T00:00:00.000Z' WHERE id = ?").run(summary.id)).toThrow('append-only snapshots');
    db.close();
  });

  it('uses canonical job/readiness tables behind compatibility views', () => {
    const db = fixture();
    expect(db.prepare("SELECT type FROM sqlite_master WHERE name = 'orchestrator_job'").get()).toEqual({ type: 'view' });
    expect(db.prepare("SELECT type FROM sqlite_master WHERE name = 'orchestrator_readiness'").get()).toEqual({ type: 'view' });
    expect(db.prepare("SELECT type FROM sqlite_master WHERE type = 'table' AND name IN ('orchestrator_job', 'orchestrator_readiness')").all()).toEqual([]);
    db.close();
  });

  it('allows final reconciliation evidence to settle without a receipt', () => {
    const db = fixture();
    const repository = new DurableRepository(db);
    repository.saveIntent({ id: 'intent-reconcile-settle', campaignId: 'campaign', walletId: 'wallet', intentClass: 'mint', toAddress: '0xcontract', valueWei: 0n, calldata: '0x', chainProfileId: 'chain', createdAt: '2026-01-01T00:00:00.000Z' });
    repository.saveExecution({ id: 'execution-reconcile-settle', campaignId: 'campaign', walletId: 'wallet', transactionIntentId: 'intent-reconcile-settle', state: 'prepared', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
    repository.recordAttempt({ id: 'attempt-reconcile-settle', transactionIntentId: 'intent-reconcile-settle', executionId: 'execution-reconcile-settle', endpoint: 'test', responseClass: 'accepted', txHash: '0xsettle', nonce: 2, attemptedAt: '2026-01-01T00:00:01.000Z' });
    db.prepare("INSERT INTO spend_reservation (id, wallet_id, campaign_id, chain_profile_id, execution_id, transaction_intent_id, idempotency_key, policy_id, amount_wei, reserved_amount_wei, usage_date, status, created_at) VALUES ('reservation-reconcile-settle', 'wallet', 'campaign', 'chain', 'execution-reconcile-settle', 'intent-reconcile-settle', 'reconcile-settle-key', 'policy', '10', '10', '2026-01-01', 'reserved', '2026-01-01T00:00:00.000Z')").run();
    repository.recordReconciliation({ id: 'reconciliation-final-settle', chainProfileId: 'chain', transactionAttemptId: 'attempt-reconcile-settle', executionId: 'execution-reconcile-settle', txHash: '0xsettle', fromAddress: '0xabc', nonce: 2, state: 'final', source: 'test', policyVersion: 'phase2-reconciliation-v1', details: { sourceEvidence: 'authoritative reconciliation' }, checkedAt: '2026-01-01T00:00:02.000Z' });
    db.prepare("UPDATE spend_reservation SET status = 'settled', settled_amount_wei = '10', settled_at = '2026-01-01T00:00:03.000Z' WHERE id = 'reservation-reconcile-settle'").run();
    expect(db.prepare("SELECT status FROM spend_reservation WHERE id = 'reservation-reconcile-settle'").get()).toEqual({ status: 'settled' });
    db.close();
  });

  it('does not let older reconciliation override a later pending receipt', () => {
    const db = fixture();
    const repository = new DurableRepository(db);
    repository.saveIntent({ id: 'intent-evidence-order', campaignId: 'campaign', walletId: 'wallet', intentClass: 'mint', toAddress: '0xcontract', valueWei: 0n, calldata: '0x', chainProfileId: 'chain', createdAt: '2026-01-01T00:00:00.000Z' });
    repository.saveExecution({ id: 'execution-evidence-order', campaignId: 'campaign', walletId: 'wallet', transactionIntentId: 'intent-evidence-order', state: 'prepared', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
    repository.recordAttempt({ id: 'attempt-evidence-order', transactionIntentId: 'intent-evidence-order', executionId: 'execution-evidence-order', endpoint: 'test', responseClass: 'accepted', txHash: '0xevidence', nonce: 3, attemptedAt: '2026-01-01T00:00:01.000Z' });
    db.prepare("INSERT INTO spend_reservation (id, wallet_id, campaign_id, chain_profile_id, execution_id, transaction_intent_id, idempotency_key, policy_id, amount_wei, reserved_amount_wei, usage_date, status, created_at) VALUES ('reservation-evidence-order', 'wallet', 'campaign', 'chain', 'execution-evidence-order', 'intent-evidence-order', 'evidence-order-key', 'policy', '10', '10', '2026-01-01', 'reserved', '2026-01-01T00:00:00.000Z')").run();
    repository.recordReconciliation({ id: 'reconciliation-evidence-order', chainProfileId: 'chain', transactionAttemptId: 'attempt-evidence-order', executionId: 'execution-evidence-order', txHash: '0xevidence', fromAddress: '0xabc', nonce: 3, state: 'final', source: 'test', policyVersion: 'phase2-reconciliation-v1', details: { sourceEvidence: 'older final evidence' }, checkedAt: '2026-01-01T00:00:02.000Z' });
    repository.recordReceipt({ id: 'pending-evidence-order', transactionAttemptId: 'attempt-evidence-order', executionId: 'execution-evidence-order', txHash: '0xevidence', status: 'pending', blockNumber: 3, blockHash: '0xblock', confirmations: 1, finalityStage: 'posted', observedAt: '2026-01-01T00:00:03.000Z' });
    expect(() => db.prepare("UPDATE spend_reservation SET status = 'settled', settled_amount_wei = '10', settled_at = '2026-01-01T00:00:04.000Z' WHERE id = 'reservation-evidence-order'").run()).toThrow('latest authoritative');
    expect(() => repository.refreshSpendSummary('wallet', 'wallet')).not.toThrow();
    db.close();
  });

  it('writes compatibility readiness append-only and protects raw SQL evidence boundaries', () => {
    const db = fixture();
    db.prepare("INSERT INTO orchestrator_readiness (id, campaign_id, wallet, state, fresh_until, source_block, observed_at, blocking_reasons_json, checks_json) VALUES ('compat-readiness', 'campaign', '0xabc', 'Ready', '2026-01-01T00:05:00.000Z', '1', '2026-01-01T00:00:00.000Z', '[]', '{}')").run();
    expect(db.prepare("SELECT wallet_id, state, decision FROM readiness_snapshot WHERE id = 'compat-readiness'").get()).toEqual({ wallet_id: 'wallet', state: 'ready', decision: 'ready' });
    db.prepare("UPDATE orchestrator_readiness SET state = 'Blocked', observed_at = '2026-01-01T00:01:00.000Z' WHERE id = 'compat-readiness'").run();
    expect(db.prepare("SELECT COUNT(*) AS count FROM readiness_snapshot WHERE campaign_id = 'campaign'").get()).toEqual({ count: 2 });
    expect(db.prepare("SELECT state FROM orchestrator_readiness WHERE campaign_id = 'campaign' AND wallet = '0xabc'").get()).toEqual({ state: 'blocked' });
    db.prepare("DELETE FROM orchestrator_readiness WHERE id = 'compat-readiness'").run();
    expect(db.prepare("SELECT COUNT(*) AS count FROM orchestrator_readiness WHERE campaign_id = 'campaign' AND wallet = '0xabc'").get()).toEqual({ count: 0 });
    db.prepare("INSERT INTO chain_profile (id, chain_id, name, rpc_endpoints_json, confirmation_depth, created_at) VALUES ('raw-chain', 3, 'Raw', '[]', 1, '2026-01-01T00:00:00.000Z')").run();
    expect(() => db.prepare("UPDATE chain_profile SET verification_status = 'verified', verification_evidence_json = '\"x\"', verification_approved_by = 'operator', verification_approved_at = '2026-01-01T00:00:00.000Z', execution_enabled = 1 WHERE id = 'raw-chain'").run()).toThrow('substantive finality evidence');
    expect(() => db.prepare("INSERT INTO backup_restore_evidence (id, store_reference, backup_reference, sha256, schema_version, operation, outcome, kill_switch_engaged, evidence_json, recorded_at, encryption_verified, integrity_check) VALUES ('raw-forged-backup', 'store', 'backup', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 19, 'verification', 'passed', 0, '{}', '2026-01-01T00:00:00.000Z', 0, 'not_recorded')").run()).toThrow('incomplete');
    db.prepare("INSERT INTO chain_profile (id, chain_id, name, rpc_endpoints_json, confirmation_depth, created_at) VALUES ('chain-two', 2, 'Other', '[]', 1, '2026-01-01T00:00:00.000Z')").run();
    db.prepare("INSERT INTO wallet (id, chain_profile_id, address, key_reference, created_at) VALUES ('wallet-two', 'chain-two', '0xdef', 'kms://wallet-two', '2026-01-01T00:00:00.000Z')").run();
    expect(() => db.prepare("UPDATE campaign_wallet SET wallet_id = 'wallet-two' WHERE campaign_id = 'campaign' AND wallet_id = 'wallet'").run()).toThrow('chain identity mismatch');
    db.close();
  });
});
