DROP VIEW IF EXISTS recovery_unresolved_submissions;

CREATE VIEW recovery_unresolved_submissions AS
WITH attempt_reconciliation AS (
  SELECT candidate.id AS attempt_id,
         (
           SELECT rr.state
             FROM reconciliation_record rr
             JOIN transaction_attempt linked ON linked.id = rr.transaction_attempt_id
            WHERE rr.transaction_attempt_id = candidate.id
               OR (
                 candidate.execution_id IS NOT NULL
                 AND candidate.tx_hash IS NOT NULL
                 AND candidate.nonce IS NOT NULL
                 AND linked.execution_id = candidate.execution_id
                 AND linked.tx_hash IS NOT NULL
                 AND lower(linked.tx_hash) = lower(candidate.tx_hash)
                 AND linked.nonce = candidate.nonce
               )
            ORDER BY rr.checked_at DESC, rr.id DESC
            LIMIT 1
         ) AS state
    FROM transaction_attempt candidate
)
SELECT e.id AS execution_id,
       e.run_id,
       e.campaign_id,
       e.wallet_id,
       e.transaction_intent_id,
       a.id AS attempt_id,
       a.tx_hash,
       a.from_address,
       a.nonce,
       COALESCE(ar.state, 'unresolved') AS reconciliation_state,
       e.state AS execution_state,
       e.updated_at
  FROM execution e
  JOIN transaction_attempt a ON a.transaction_intent_id = e.transaction_intent_id
  LEFT JOIN attempt_reconciliation ar ON ar.attempt_id = a.id
 WHERE e.state NOT IN ('confirmed', 'ethereum_final', 'minted', 'completed', 'failed', 'dropped', 'aborted', 'skipped', 'killed', 'settled')
    OR ar.state IS NULL OR ar.state NOT IN ('matched', 'final');
