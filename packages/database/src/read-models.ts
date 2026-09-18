import type { SqliteDatabase } from './database.js';

function policyDay(db: SqliteDatabase, walletId: string, asOf: Date): string {
  const row = db.prepare('SELECT timezone FROM spend_policy WHERE wallet_id = ? AND active = 1 ORDER BY rowid DESC LIMIT 1').get(walletId) as { timezone: string } | undefined;
  const timezone = row?.timezone ?? 'UTC';
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(asOf);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get('year')}-${values.get('month')}-${values.get('day')}`;
}

export interface ReadinessRow {
  campaignId: string;
  walletId: string;
  eligibilityStatus: 'eligible' | 'ineligible' | 'unknown' | null;
  simulationOutcome: 'pass' | 'fail' | 'unknown' | null;
  simulationCheckedAt: string | null;
  balanceSufficient?: boolean;
  capacityAvailable?: boolean;
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
  reorgEventId?: string | null;
}

export interface ReplacementExposureRow {
  attemptId: string;
  executionId: string | null;
  transactionIntentId: string;
  txHash: string | null;
  nonce: number | null;
  replacementOfId: string;
  reconciliationState: string;
  attemptedAt: string;
}

export class ReadModels {
  public constructor(private readonly db: SqliteDatabase) {}

  public readiness(campaignId: string, asOf = new Date()): ReadinessRow[] {
    const rows = this.db.prepare(`
      SELECT c.id AS campaign_id, w.id AS wallet_id, c.state AS campaign_state,
        (SELECT CASE COALESCE(e.lifecycle_state, CASE e.status WHEN 'eligible' THEN 'eligible' WHEN 'ineligible' THEN 'failed' ELSE 'unknown' END) WHEN 'eligible' THEN 'eligible' WHEN 'failed' THEN 'ineligible' WHEN 'skipped' THEN 'ineligible' WHEN 'unfunded' THEN 'ineligible' ELSE 'unknown' END FROM eligibility e WHERE e.campaign_id = c.id AND e.wallet_id = w.id AND (e.expires_at IS NULL OR e.expires_at >= ?) ORDER BY e.expires_at DESC, e.id DESC LIMIT 1) AS eligibility_status,
        (SELECT s.outcome FROM simulation s JOIN transaction_intent i ON i.id = s.transaction_intent_id WHERE s.campaign_id = c.id AND s.wallet_id = w.id AND i.id = (SELECT i2.id FROM transaction_intent i2 WHERE i2.campaign_id = c.id AND i2.wallet_id = w.id ORDER BY i2.created_at DESC, i2.id DESC LIMIT 1) ORDER BY s.checked_at DESC, s.id DESC LIMIT 1) AS simulation_outcome,
        (SELECT s.checked_at FROM simulation s JOIN transaction_intent i ON i.id = s.transaction_intent_id WHERE s.campaign_id = c.id AND s.wallet_id = w.id AND i.id = (SELECT i2.id FROM transaction_intent i2 WHERE i2.campaign_id = c.id AND i2.wallet_id = w.id ORDER BY i2.created_at DESC, i2.id DESC LIMIT 1) ORDER BY s.checked_at DESC, s.id DESC LIMIT 1) AS simulation_checked_at,
        (SELECT s.freshness_seconds FROM simulation s JOIN transaction_intent i ON i.id = s.transaction_intent_id WHERE s.campaign_id = c.id AND s.wallet_id = w.id AND i.id = (SELECT i2.id FROM transaction_intent i2 WHERE i2.campaign_id = c.id AND i2.wallet_id = w.id ORDER BY i2.created_at DESC, i2.id DESC LIMIT 1) ORDER BY s.checked_at DESC, s.id DESC LIMIT 1) AS freshness_seconds,
        (SELECT native_balance_wei FROM wallet_balance b WHERE b.wallet_id = w.id) AS native_balance_wei,
        (SELECT daily_cap_wei FROM spend_policy p WHERE p.wallet_id = w.id AND p.active = 1 ORDER BY p.rowid DESC LIMIT 1) AS daily_cap_wei
      FROM campaign c
      JOIN "drop" d ON d.id = c.drop_id
      JOIN collection col ON col.id = d.collection_id
      JOIN contract ct ON ct.id = col.contract_id
      JOIN campaign_wallet cw ON cw.campaign_id = c.id AND cw.enabled = 1
      JOIN wallet w ON w.id = cw.wallet_id AND w.chain_profile_id = ct.chain_profile_id
      WHERE c.id = ? AND c.state IN ('draft', 'validating', 'ready', 'armed', 'prepared')
      ORDER BY w.id
    `).all(asOf.toISOString(), campaignId) as Array<{ campaign_id: string; wallet_id: string; campaign_state: string; eligibility_status: ReadinessRow['eligibilityStatus']; simulation_outcome: ReadinessRow['simulationOutcome']; simulation_checked_at: string | null; freshness_seconds: number | null; native_balance_wei: string | null; daily_cap_wei: string | null }>;
    return rows.map((row) => ({
      campaignId: row.campaign_id,
      walletId: row.wallet_id,
      eligibilityStatus: row.eligibility_status,
      simulationOutcome: row.simulation_outcome,
      simulationCheckedAt: row.simulation_checked_at,
      balanceSufficient: row.native_balance_wei !== null && BigInt(row.native_balance_wei) > 0n,
      capacityAvailable: row.daily_cap_wei !== null && this.reservationExposure(row.wallet_id, row.daily_cap_wei, asOf) >= 0n,
      nextAction: row.eligibility_status !== 'eligible' ? (row.eligibility_status === null || row.eligibility_status === 'unknown' ? 'resolve_eligibility' : 'blocked') : row.native_balance_wei === null || BigInt(row.native_balance_wei) === 0n ? 'blocked' : row.daily_cap_wei === null || this.reservationExposure(row.wallet_id, row.daily_cap_wei, asOf) < 0n ? 'blocked' : row.simulation_outcome !== 'pass' || row.simulation_checked_at === null || row.freshness_seconds === null || asOf.getTime() - Date.parse(row.simulation_checked_at) > row.freshness_seconds * 1000 ? (row.simulation_outcome === 'fail' ? 'blocked' : 'refresh_simulation') : 'ready',
    }));
  }

  private reservationExposure(walletId: string, cap: string, asOf: Date): bigint {
    const rows = this.db.prepare("SELECT status, amount_wei, reserved_amount_wei FROM spend_reservation WHERE wallet_id = ? AND usage_date = ? AND status IN ('reserved', 'settled')").all(walletId, policyDay(this.db, walletId, asOf)) as Array<{ status: string; amount_wei: string; reserved_amount_wei: string | null }>;
    const used = rows.reduce((total, row) => total + BigInt(row.status === 'reserved' ? (row.reserved_amount_wei === null || row.reserved_amount_wei === '0' ? row.amount_wei : row.reserved_amount_wei) : row.amount_wei), 0n);
    return BigInt(cap) - used;
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
    const rows = this.db.prepare(`
      WITH params AS (
        SELECT julianday(?) AS as_of
      ), latest_intent AS (
        SELECT i.*
          FROM transaction_intent i
         WHERE julianday(i.created_at) <= (SELECT as_of FROM params)
           AND i.id = (SELECT i2.id FROM transaction_intent i2 WHERE i2.campaign_id = i.campaign_id AND i2.wallet_id = i.wallet_id AND julianday(i2.created_at) <= (SELECT as_of FROM params) ORDER BY i2.created_at DESC, i2.id DESC LIMIT 1)
      ), latest_simulation AS (
        SELECT s.*
          FROM simulation s
         WHERE julianday(s.checked_at) <= (SELECT as_of FROM params)
           AND s.id = (SELECT s2.id FROM simulation s2 WHERE s2.campaign_id = s.campaign_id AND s2.wallet_id = s.wallet_id AND julianday(s2.checked_at) <= (SELECT as_of FROM params) ORDER BY s2.checked_at DESC, s2.id DESC LIMIT 1)
      )
      SELECT s.id AS simulation_id, s.wallet_id, s.campaign_id, s.transaction_intent_id, s.outcome, s.checked_at, s.freshness_seconds, s.source_block_number
        FROM latest_simulation s
        LEFT JOIN latest_intent i ON i.campaign_id = s.campaign_id AND i.wallet_id = s.wallet_id
       WHERE (i.id IS NULL OR s.transaction_intent_id IS NULL OR s.transaction_intent_id = i.id)
         AND julianday(s.checked_at) + (s.freshness_seconds / 86400.0) < (SELECT as_of FROM params)
       ORDER BY s.checked_at, s.id
    `).all(asOf.toISOString()) as Array<{ simulation_id: string; wallet_id: string; campaign_id: string; transaction_intent_id: string | null; outcome: StaleSimulationRow['outcome']; checked_at: string; freshness_seconds: number; source_block_number: number }>;
    return rows.map((row) => ({ simulationId: row.simulation_id, walletId: row.wallet_id, campaignId: row.campaign_id, transactionIntentId: row.transaction_intent_id, outcome: row.outcome, checkedAt: row.checked_at, freshnessSeconds: row.freshness_seconds, sourceBlockNumber: row.source_block_number }));
  }

  public reorgExposure(): ReorgExposureRow[] {
    const rows = this.db.prepare('SELECT execution_id, campaign_id, wallet_id, transaction_intent_id AS intent_id, attempt_id, tx_hash, receipt_status, finality_stage, reconciliation_state, observed_at, reorg_event_id FROM recovery_reorg_exposure ORDER BY observed_at, execution_id, attempt_id').all() as Array<{ execution_id: string; campaign_id: string; wallet_id: string; intent_id: string; attempt_id: string; tx_hash: string | null; receipt_status: string | null; finality_stage: string | null; reconciliation_state: string; observed_at: string | null; reorg_event_id: string | null }>;
    return rows.map((row) => ({ executionId: row.execution_id, campaignId: row.campaign_id, walletId: row.wallet_id, intentId: row.intent_id, attemptId: row.attempt_id, txHash: row.tx_hash, receiptStatus: row.receipt_status, finalityStage: row.finality_stage, reconciliationState: row.reconciliation_state, observedAt: row.observed_at, reorgEventId: row.reorg_event_id }));
  }

  public replacementExposure(): ReplacementExposureRow[] {
    const rows = this.db.prepare('SELECT attempt_id, execution_id, transaction_intent_id, tx_hash, nonce, replacement_of_id, reconciliation_state, attempted_at FROM recovery_replacement_exposure ORDER BY attempted_at, attempt_id').all() as Array<{ attempt_id: string; execution_id: string | null; transaction_intent_id: string; tx_hash: string | null; nonce: number | null; replacement_of_id: string; reconciliation_state: string; attempted_at: string }>;
    return rows.map((row) => ({ attemptId: row.attempt_id, executionId: row.execution_id, transactionIntentId: row.transaction_intent_id, txHash: row.tx_hash, nonce: row.nonce, replacementOfId: row.replacement_of_id, reconciliationState: row.reconciliation_state, attemptedAt: row.attempted_at }));
  }

  public opportunityEvidence(limit = 100): OpportunityEvidenceRow[] {
    const rows = this.db.prepare('SELECT o.id AS opportunity_id, o.fingerprint, o.disposition, o.score, o.freshness_at, COUNT(s.id) AS signal_count FROM opportunity o LEFT JOIN signal s ON s.opportunity_id = o.id GROUP BY o.id ORDER BY o.score DESC LIMIT ?').all(limit) as Array<{ opportunity_id: string; fingerprint: string; disposition: string; score: number | null; freshness_at: string | null; signal_count: number }>;
    return rows.map((row) => ({ opportunityId: row.opportunity_id, fingerprint: row.fingerprint, disposition: row.disposition, score: row.score, freshnessAt: row.freshness_at, signalCount: row.signal_count }));
  }
}
