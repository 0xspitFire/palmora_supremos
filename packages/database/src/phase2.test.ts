import { describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import { DurableRepository } from './repositories.js';
import { ReadModels } from './read-models.js';

function fixture() {
  const db = openDatabase();
  db.prepare("INSERT INTO chain_profile (id, chain_id, name, rpc_endpoints_json, confirmation_depth, verification_status, execution_enabled, created_at) VALUES ('chain', 1, 'Ethereum', '[]', 2, 'verified', 1, '2026-01-01T00:00:00.000Z')").run();
  db.prepare("INSERT INTO wallet (id, chain_profile_id, address, key_reference, created_at) VALUES ('wallet', 'chain', '0xabc', 'kms://wallet', '2026-01-01T00:00:00.000Z')").run();
  db.prepare("INSERT INTO spend_policy (id, wallet_id, daily_cap_wei, version, active) VALUES ('policy', 'wallet', '1000000000000000000', 'v1', 1)").run();
  db.prepare("INSERT INTO contract (id, chain_profile_id, address, kind) VALUES ('contract', 'chain', '0xcontract', 'nft')").run();
  db.prepare("INSERT INTO collection (id, contract_id, name) VALUES ('collection', 'contract', 'Collection')").run();
  db.prepare("INSERT INTO \"drop\" (id, collection_id, strategy, mint_price_wei, observed_at) VALUES ('drop', 'collection', 'fcfs', '0', '2026-01-01T00:00:00.000Z')").run();
  db.prepare("INSERT INTO campaign (id, drop_id, state, created_at) VALUES ('campaign', 'drop', 'draft', '2026-01-01T00:00:00.000Z')").run();
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
    repository.recordFinalityObservation({ id: 'finality-soft', executionId: 'execution-finality', chainProfileId: 'chain', stage: 'soft', settlementReached: false, observedAt: '2026-01-01T00:01:00.000Z' });
    repository.recordFinalityObservation({ id: 'finality-final', executionId: 'execution-finality', chainProfileId: 'chain', stage: 'ethereum_final', settlementReached: true, observedAt: '2026-01-01T00:02:00.000Z' });
    expect(new ReadModels(db).finalityHistory('execution-finality').map((item) => item.stage)).toEqual(['soft', 'ethereum_final']);
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
    db.close();
  });
});
