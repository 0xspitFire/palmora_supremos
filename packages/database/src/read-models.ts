import type { SqliteDatabase } from './database.js';

export interface ReadinessRow {
  campaignId: string;
  walletId: string;
  eligibilityStatus: 'eligible' | 'ineligible' | 'unknown' | null;
  simulationOutcome: 'pass' | 'fail' | 'unknown' | null;
  simulationCheckedAt: string | null;
  nextAction: 'ready' | 'refresh_simulation' | 'resolve_eligibility' | 'blocked';
}

export interface ActiveExecutionRow {
  executionId: string;
  campaignId: string;
  walletId: string;
  state: string;
  updatedAt: string;
  intentId: string;
}

export interface OpportunityEvidenceRow {
  opportunityId: string;
  fingerprint: string;
  disposition: string;
  score: number | null;
  freshnessAt: string | null;
  signalCount: number;
}

export interface ChainVerificationRow {
  chainProfileId: string;
  chainId: number;
  status: 'unverified' | 'characterization_pending' | 'verified' | 'execution_blocked';
  sequencerEndpointReference: string | null;
  archiveEndpointReference: string | null;
  checkedAt: string;
}

export interface PendingReconciliationRow {
  executionId: string;
  campaignId: string;
  walletId: string;
  intentId: string;
  attemptId: string | null;
  txHash: string | null;
  nonce: number | null;
  reconciliationState: string | null;
}

export interface OrphanReservationRow {
  reservationId: string;
  walletId: string;
  executionId: string | null;
  transactionIntentId: string | null;
  idempotencyKey: string;
  status: string;
  amountWei: string;
  reservedAmountWei: string;
  createdAt: string;
}

export interface DuplicateNonceIdentityRow {
  fromAddress: string;
  nonce: number;
  intentCount: number;
  intentIds: string;
}

export interface StaleSimulationRow {
  simulationId: string;
  walletId: string;
  campaignId: string;
  transactionIntentId: string | null;
  outcome: 'pass' | 'fail' | 'unknown';
  checkedAt: string;
  freshnessSeconds: number;
  sourceBlockNumber: number;
}

export interface ReorgExposureRow {
  executionId: string;
  campaignId: string;
  walletId: string;
  intentId: string;
  attemptId: string;
  txHash: string | null;
  receiptStatus: string | null;
  finalityStage: string | null;
  reconciliationState: string;
  observedAt: string | null;
}

export class ReadModels {
  public constructor(private readonly db: SqliteDatabase) {}

  public readiness(campaignId: string, asOf = new Date()): ReadinessRow[] {
    const rows = this.db.prepare(`
      SELECT c.id AS campaign_id, w.id AS wallet_id,
        (SELECT status FROM eligibility e WHERE e.campaign_id = c.id AND e.wallet_id = w.id AND (e.expires_at IS NULL OR e.expires_at >= ?) ORDER BY e.expires_at DESC LIMIT 1) AS eligibility_status,
        (SELECT outcome FROM simulation s WHERE s.campaign_id = c.id AND s.wallet_id = w.id ORDER BY s.checked_at DESC LIMIT 1) AS simulation_outcome,
        (SELECT checked_at FROM simulation s WHERE s.campaign_id = c.id AND s.wallet_id = w.id ORDER BY s.checked_at DESC LIMIT 1) AS simulation_checked_at,
        (SELECT freshness_seconds FROM simulation s WHERE s.campaign_id = c.id AND s.wallet_id = w.id ORDER BY s.checked_at DESC LIMIT 1) AS freshness_seconds
      FROM campaign c CROSS JOIN wallet w WHERE c.id = ? ORDER BY w.id
    `).all(asOf.toISOString(), campaignId) as Array<{ campaign_id: string; wallet_id: string; eligibility_status: ReadinessRow['eligibilityStatus']; simulation_outcome: ReadinessRow['simulationOutcome']; simulation_checked_at: string | null; freshness_seconds: number | null }>;
    return rows.map((row) => ({
      campaignId: row.campaign_id,
      walletId: row.wallet_id,
      eligibilityStatus: row.eligibility_status,
      simulationOutcome: row.simulation_outcome,
      simulationCheckedAt: row.simulation_checked_at,
      nextAction: row.eligibility_status !== 'eligible' ? (row.eligibility_status === null || row.eligibility_status === 'unknown' ? 'resolve_eligibility' : 'blocked') : row.simulation_outcome !== 'pass' || row.simulation_checked_at === null || row.freshness_seconds === null || asOf.getTime() - Date.parse(row.simulation_checked_at) > row.freshness_seconds * 1000 ? (row.simulation_outcome === 'fail' ? 'blocked' : 'refresh_simulation') : 'ready',
    }));
  }

  public activeExecutions(): ActiveExecutionRow[] {
    const rows = this.db.prepare("SELECT id AS execution_id, campaign_id, wallet_id, state, updated_at, transaction_intent_id AS intent_id FROM execution WHERE state NOT IN ('confirmed', 'ethereum_final', 'minted', 'completed', 'failed', 'dropped', 'aborted', 'skipped', 'killed', 'settled') ORDER BY updated_at").all() as Array<{ execution_id: string; campaign_id: string; wallet_id: string; state: string; updated_at: string; intent_id: string }>;
    return rows.map((row) => ({ executionId: row.execution_id, campaignId: row.campaign_id, walletId: row.wallet_id, state: row.state, updatedAt: row.updated_at, intentId: row.intent_id }));
  }

  public chainVerification(chainProfileId: string): ChainVerificationRow | null {
    const row = this.db.prepare('SELECT chain_profile_id, chain_id, status, sequencer_endpoint_reference, archive_endpoint_reference, checked_at FROM chain_verification WHERE chain_profile_id = ? ORDER BY checked_at DESC, id DESC LIMIT 1').get(chainProfileId) as { chain_profile_id: string; chain_id: number; status: ChainVerificationRow['status']; sequencer_endpoint_reference: string | null; archive_endpoint_reference: string | null; checked_at: string } | undefined;
    return row === undefined ? null : { chainProfileId: row.chain_profile_id, chainId: row.chain_id, status: row.status, sequencerEndpointReference: row.sequencer_endpoint_reference, archiveEndpointReference: row.archive_endpoint_reference, checkedAt: row.checked_at };
  }

  public pendingReconciliation(): PendingReconciliationRow[] {
    const rows = this.db.prepare('SELECT execution_id, campaign_id, wallet_id, transaction_intent_id, attempt_id, tx_hash, nonce, reconciliation_state FROM recovery_unresolved_submissions ORDER BY updated_at, execution_id').all() as Array<{ execution_id: string; campaign_id: string; wallet_id: string; transaction_intent_id: string; attempt_id: string | null; tx_hash: string | null; nonce: number | null; reconciliation_state: string | null }>;
    return rows.map((row) => ({ executionId: row.execution_id, campaignId: row.campaign_id, walletId: row.wallet_id, intentId: row.transaction_intent_id, attemptId: row.attempt_id, txHash: row.tx_hash, nonce: row.nonce, reconciliationState: row.reconciliation_state }));
  }

  public orphanReservations(): OrphanReservationRow[] {
    const rows = this.db.prepare('SELECT reservation_id, wallet_id, execution_id, transaction_intent_id, idempotency_key, status, amount_wei, reserved_amount_wei, created_at FROM recovery_orphan_reservations ORDER BY created_at, reservation_id').all() as Array<{ reservation_id: string; wallet_id: string; execution_id: string | null; transaction_intent_id: string | null; idempotency_key: string; status: string; amount_wei: string; reserved_amount_wei: string; created_at: string }>;
    return rows.map((row) => ({ reservationId: row.reservation_id, walletId: row.wallet_id, executionId: row.execution_id, transactionIntentId: row.transaction_intent_id, idempotencyKey: row.idempotency_key, status: row.status, amountWei: row.amount_wei, reservedAmountWei: row.reserved_amount_wei, createdAt: row.created_at }));
  }

  public duplicateNonceIdentities(): DuplicateNonceIdentityRow[] {
    const rows = this.db.prepare('SELECT from_address, nonce, intent_count, intent_ids FROM recovery_duplicate_nonce_identities ORDER BY lower(from_address), nonce').all() as Array<{ from_address: string; nonce: number; intent_count: number; intent_ids: string }>;
    return rows.map((row) => ({ fromAddress: row.from_address, nonce: row.nonce, intentCount: row.intent_count, intentIds: row.intent_ids }));
  }

  public staleSimulations(asOf = new Date()): StaleSimulationRow[] {
    const rows = this.db.prepare('SELECT id AS simulation_id, wallet_id, campaign_id, transaction_intent_id, outcome, checked_at, freshness_seconds, source_block_number FROM simulation WHERE julianday(checked_at) + (freshness_seconds / 86400.0) < julianday(?) ORDER BY checked_at, id').all(asOf.toISOString()) as Array<{ simulation_id: string; wallet_id: string; campaign_id: string; transaction_intent_id: string | null; outcome: StaleSimulationRow['outcome']; checked_at: string; freshness_seconds: number; source_block_number: number }>;
    return rows.map((row) => ({ simulationId: row.simulation_id, walletId: row.wallet_id, campaignId: row.campaign_id, transactionIntentId: row.transaction_intent_id, outcome: row.outcome, checkedAt: row.checked_at, freshnessSeconds: row.freshness_seconds, sourceBlockNumber: row.source_block_number }));
  }

  public reorgExposure(): ReorgExposureRow[] {
    const rows = this.db.prepare('SELECT execution_id, campaign_id, wallet_id, transaction_intent_id AS intent_id, attempt_id, tx_hash, receipt_status, finality_stage, reconciliation_state, observed_at FROM recovery_reorg_exposure ORDER BY observed_at, execution_id, attempt_id').all() as Array<{ execution_id: string; campaign_id: string; wallet_id: string; intent_id: string; attempt_id: string; tx_hash: string | null; receipt_status: string | null; finality_stage: string | null; reconciliation_state: string; observed_at: string | null }>;
    return rows.map((row) => ({ executionId: row.execution_id, campaignId: row.campaign_id, walletId: row.wallet_id, intentId: row.intent_id, attemptId: row.attempt_id, txHash: row.tx_hash, receiptStatus: row.receipt_status, finalityStage: row.finality_stage, reconciliationState: row.reconciliation_state, observedAt: row.observed_at }));
  }

  public opportunityEvidence(limit = 100): OpportunityEvidenceRow[] {
    return this.db.prepare('SELECT o.id AS opportunity_id, o.fingerprint, o.disposition, o.score, o.freshness_at, COUNT(s.id) AS signal_count FROM opportunity o LEFT JOIN signal s ON s.opportunity_id = o.id GROUP BY o.id ORDER BY o.score DESC LIMIT ?').all(limit) as OpportunityEvidenceRow[];
  }
}
