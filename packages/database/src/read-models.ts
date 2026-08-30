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

export class ReadModels {
  public constructor(private readonly db: SqliteDatabase) {}

  public readiness(campaignId: string, asOf = new Date()): ReadinessRow[] {
    const rows = this.db.prepare(`
      SELECT c.id AS campaign_id, w.id AS wallet_id,
        (SELECT status FROM eligibility e WHERE e.campaign_id = c.id AND e.wallet_id = w.id ORDER BY e.expires_at DESC LIMIT 1) AS eligibility_status,
        (SELECT outcome FROM simulation s WHERE s.campaign_id = c.id AND s.wallet_id = w.id ORDER BY s.checked_at DESC LIMIT 1) AS simulation_outcome,
        (SELECT checked_at FROM simulation s WHERE s.campaign_id = c.id AND s.wallet_id = w.id ORDER BY s.checked_at DESC LIMIT 1) AS simulation_checked_at,
        (SELECT freshness_seconds FROM simulation s WHERE s.campaign_id = c.id AND s.wallet_id = w.id ORDER BY s.checked_at DESC LIMIT 1) AS freshness_seconds
      FROM campaign c CROSS JOIN wallet w WHERE c.id = ? ORDER BY w.id
    `).all(campaignId) as Array<{ campaign_id: string; wallet_id: string; eligibility_status: ReadinessRow['eligibilityStatus']; simulation_outcome: ReadinessRow['simulationOutcome']; simulation_checked_at: string | null; freshness_seconds: number | null }>;
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
    const rows = this.db.prepare("SELECT id AS execution_id, campaign_id, wallet_id, state, updated_at, transaction_intent_id AS intent_id FROM execution WHERE state NOT IN ('confirmed', 'failed', 'skipped', 'killed') ORDER BY updated_at").all() as Array<{ execution_id: string; campaign_id: string; wallet_id: string; state: string; updated_at: string; intent_id: string }>;
    return rows.map((row) => ({ executionId: row.execution_id, campaignId: row.campaign_id, walletId: row.wallet_id, state: row.state, updatedAt: row.updated_at, intentId: row.intent_id }));
  }

  public chainVerification(chainProfileId: string): ChainVerificationRow | null {
    const row = this.db.prepare('SELECT chain_profile_id, chain_id, status, sequencer_endpoint_reference, archive_endpoint_reference, checked_at FROM chain_verification WHERE chain_profile_id = ? ORDER BY checked_at DESC LIMIT 1').get(chainProfileId) as { chain_profile_id: string; chain_id: number; status: ChainVerificationRow['status']; sequencer_endpoint_reference: string | null; archive_endpoint_reference: string | null; checked_at: string } | undefined;
    return row === undefined ? null : { chainProfileId: row.chain_profile_id, chainId: row.chain_id, status: row.status, sequencerEndpointReference: row.sequencer_endpoint_reference, archiveEndpointReference: row.archive_endpoint_reference, checkedAt: row.checked_at };
  }

  public pendingReconciliation(): PendingReconciliationRow[] {
    const rows = this.db.prepare(`
      SELECT e.id AS execution_id, e.campaign_id, e.wallet_id, e.transaction_intent_id AS intent_id,
        (SELECT a.id FROM transaction_attempt a WHERE a.transaction_intent_id = e.transaction_intent_id ORDER BY a.attempted_at DESC LIMIT 1) AS attempt_id,
        (SELECT a.tx_hash FROM transaction_attempt a WHERE a.transaction_intent_id = e.transaction_intent_id ORDER BY a.attempted_at DESC LIMIT 1) AS tx_hash,
        (SELECT a.nonce FROM transaction_attempt a WHERE a.transaction_intent_id = e.transaction_intent_id ORDER BY a.attempted_at DESC LIMIT 1) AS nonce,
        (SELECT r.state FROM reconciliation_record r WHERE r.transaction_attempt_id = (SELECT a.id FROM transaction_attempt a WHERE a.transaction_intent_id = e.transaction_intent_id ORDER BY a.attempted_at DESC LIMIT 1) ORDER BY r.checked_at DESC LIMIT 1) AS reconciliation_state
      FROM execution e
      WHERE e.state NOT IN ('confirmed', 'failed', 'skipped', 'killed')
        OR EXISTS (SELECT 1 FROM transaction_attempt a WHERE a.transaction_intent_id = e.transaction_intent_id)
      ORDER BY e.updated_at
    `).all() as Array<{ execution_id: string; campaign_id: string; wallet_id: string; intent_id: string; attempt_id: string | null; tx_hash: string | null; nonce: number | null; reconciliation_state: string | null }>;
    return rows.filter((row) => row.reconciliation_state !== 'final').map((row) => ({ executionId: row.execution_id, campaignId: row.campaign_id, walletId: row.wallet_id, intentId: row.intent_id, attemptId: row.attempt_id, txHash: row.tx_hash, nonce: row.nonce, reconciliationState: row.reconciliation_state }));
  }

  public opportunityEvidence(limit = 100): OpportunityEvidenceRow[] {
    return this.db.prepare('SELECT o.id AS opportunity_id, o.fingerprint, o.disposition, o.score, o.freshness_at, COUNT(s.id) AS signal_count FROM opportunity o LEFT JOIN signal s ON s.opportunity_id = o.id GROUP BY o.id ORDER BY o.score DESC LIMIT ?').all(limit) as OpportunityEvidenceRow[];
  }
}
