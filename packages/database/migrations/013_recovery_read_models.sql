CREATE INDEX idx_recovery_execution_state ON execution(state, updated_at, run_id);
CREATE INDEX idx_recovery_attempt_hash_nonce ON transaction_attempt(from_address, nonce, attempted_at);
CREATE INDEX idx_recovery_receipt_attempt_observed ON transaction_receipt(transaction_attempt_id, observed_at);
CREATE INDEX idx_recovery_reconciliation_state ON reconciliation_record(state, checked_at);
CREATE INDEX idx_recovery_simulation_freshness ON simulation(campaign_id, wallet_id, checked_at, freshness_seconds);
CREATE INDEX idx_recovery_raw_dedup_time ON raw_observation(deduplication_key, observed_at);

CREATE VIEW recovery_unresolved_submissions AS
SELECT e.id AS execution_id,
       e.run_id,
       e.campaign_id,
       e.wallet_id,
       e.transaction_intent_id,
       a.id AS attempt_id,
       a.tx_hash,
       a.from_address,
       a.nonce,
       COALESCE((SELECT rr.state FROM reconciliation_record rr WHERE rr.transaction_attempt_id = a.id ORDER BY rr.checked_at DESC LIMIT 1), 'unresolved') AS reconciliation_state,
       e.state AS execution_state,
       e.updated_at
  FROM execution e
  LEFT JOIN transaction_attempt a
    ON a.id = (SELECT aa.id FROM transaction_attempt aa WHERE aa.transaction_intent_id = e.transaction_intent_id ORDER BY aa.attempted_at DESC, aa.id DESC LIMIT 1)
 WHERE e.state NOT IN ('confirmed', 'ethereum_final', 'minted', 'completed', 'failed', 'dropped', 'aborted', 'skipped', 'killed', 'settled')
    OR EXISTS (
      SELECT 1 FROM transaction_attempt ax
       WHERE ax.transaction_intent_id = e.transaction_intent_id
         AND NOT EXISTS (
           SELECT 1 FROM reconciliation_record rx
            WHERE rx.transaction_attempt_id = ax.id
              AND rx.state IN ('matched', 'final')
         )
    );

CREATE VIEW recovery_orphan_reservations AS
SELECT r.id AS reservation_id,
       r.wallet_id,
       r.execution_id,
       r.transaction_intent_id,
       r.idempotency_key,
       r.status,
       r.amount_wei,
       r.reserved_amount_wei,
       r.created_at
  FROM spend_reservation r
  LEFT JOIN execution e ON e.id = r.execution_id
  LEFT JOIN transaction_intent i ON i.id = r.transaction_intent_id
 WHERE r.status = 'reserved'
   AND (r.execution_id IS NULL OR e.id IS NULL OR (r.transaction_intent_id IS NOT NULL AND i.id IS NULL));

CREATE VIEW recovery_duplicate_nonce_identities AS
SELECT COALESCE(a.from_address, w.address) AS from_address,
       COALESCE(a.nonce, i.nonce) AS nonce,
       COUNT(DISTINCT i.id) AS intent_count,
       GROUP_CONCAT(DISTINCT i.id) AS intent_ids
  FROM transaction_intent i
  JOIN wallet w ON w.id = i.wallet_id
  LEFT JOIN transaction_attempt a ON a.transaction_intent_id = i.id
 WHERE COALESCE(a.nonce, i.nonce) IS NOT NULL
 GROUP BY lower(COALESCE(a.from_address, w.address)), COALESCE(a.nonce, i.nonce)
HAVING COUNT(DISTINCT i.id) > 1;

CREATE VIEW recovery_reorg_exposure AS
SELECT e.id AS execution_id,
       e.campaign_id,
       e.wallet_id,
       e.transaction_intent_id,
       a.id AS attempt_id,
       a.tx_hash,
       r.status AS receipt_status,
       r.finality_stage,
       COALESCE((SELECT rr.state FROM reconciliation_record rr WHERE rr.transaction_attempt_id = a.id ORDER BY rr.checked_at DESC LIMIT 1), 'unresolved') AS reconciliation_state,
       r.observed_at
  FROM execution e
  JOIN transaction_attempt a ON a.transaction_intent_id = e.transaction_intent_id
  LEFT JOIN transaction_receipt r ON r.id = (SELECT rx.id FROM transaction_receipt rx WHERE rx.transaction_attempt_id = a.id ORDER BY rx.observed_at DESC, rx.id DESC LIMIT 1)
 WHERE r.status = 'reorged'
    OR EXISTS (SELECT 1 FROM reconciliation_record rr WHERE rr.transaction_attempt_id = a.id AND rr.state = 'reorged');

CREATE VIEW recovery_stale_simulations AS
SELECT s.id AS simulation_id,
       s.wallet_id,
       s.campaign_id,
       s.transaction_intent_id,
       s.outcome,
       s.checked_at,
       s.freshness_seconds,
       s.source_block_number
  FROM simulation s
 WHERE julianday(s.checked_at) + (s.freshness_seconds / 86400.0) < julianday('now');
