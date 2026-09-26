-- CTO correction pass: enforce admission identity and evidence boundaries in
-- SQLite as well as in the repository methods.

ALTER TABLE chain_profile ADD COLUMN verification_approved_by TEXT;
ALTER TABLE chain_profile ADD COLUMN verification_approved_at TEXT;
ALTER TABLE reconciliation_record ADD COLUMN policy_version TEXT;

CREATE TRIGGER chain_profile_verified_evidence_insert
BEFORE INSERT ON chain_profile
WHEN NEW.execution_enabled = 1
 AND (NEW.verification_status <> 'verified'
   OR NEW.verification_evidence_json IS NULL
   OR length(trim(NEW.verification_evidence_json)) <= 2
   OR NEW.verification_approved_by IS NULL
   OR length(trim(NEW.verification_approved_by)) = 0
   OR NEW.verification_approved_at IS NULL
   OR julianday(NEW.verification_approved_at) IS NULL)
BEGIN SELECT RAISE(ABORT, 'execution requires chain approval evidence'); END;

CREATE TRIGGER chain_profile_verified_evidence_update
BEFORE UPDATE OF execution_enabled, verification_status, verification_evidence_json, verification_approved_by, verification_approved_at ON chain_profile
WHEN NEW.execution_enabled = 1
 AND (NEW.verification_status <> 'verified'
   OR NEW.verification_evidence_json IS NULL
   OR length(trim(NEW.verification_evidence_json)) <= 2
   OR NEW.verification_approved_by IS NULL
   OR length(trim(NEW.verification_approved_by)) = 0
   OR NEW.verification_approved_at IS NULL
   OR julianday(NEW.verification_approved_at) IS NULL)
BEGIN SELECT RAISE(ABORT, 'execution requires chain approval evidence'); END;

CREATE TRIGGER chain_verification_evidence_guard
BEFORE INSERT ON chain_verification
WHEN NEW.status = 'verified'
 AND (NEW.evidence_json IS NULL
   OR length(trim(NEW.evidence_json)) <= 2
   OR NEW.approved_by IS NULL
   OR length(trim(NEW.approved_by)) = 0
   OR NEW.approved_at IS NULL
   OR julianday(NEW.approved_at) IS NULL)
BEGIN SELECT RAISE(ABORT, 'verified chain requires approval evidence'); END;

CREATE TRIGGER campaign_wallet_identity_guard
BEFORE INSERT ON campaign_wallet
WHEN NOT EXISTS (
  SELECT 1
    FROM campaign c
    JOIN "drop" d ON d.id = c.drop_id
    JOIN collection col ON col.id = d.collection_id
    JOIN contract ct ON ct.id = col.contract_id
    JOIN wallet w ON w.id = NEW.wallet_id
   WHERE c.id = NEW.campaign_id
     AND ct.chain_profile_id = w.chain_profile_id
)
BEGIN SELECT RAISE(ABORT, 'campaign wallet chain identity mismatch'); END;

CREATE TRIGGER transaction_intent_membership_guard
BEFORE INSERT ON transaction_intent
WHEN NOT EXISTS (
  SELECT 1
    FROM campaign_wallet cw
    JOIN wallet w ON w.id = cw.wallet_id
    JOIN campaign c ON c.id = cw.campaign_id
    JOIN "drop" d ON d.id = c.drop_id
    JOIN collection col ON col.id = d.collection_id
    JOIN contract ct ON ct.id = col.contract_id
   WHERE cw.campaign_id = NEW.campaign_id
     AND cw.wallet_id = NEW.wallet_id
     AND cw.enabled = 1
     AND w.chain_profile_id = ct.chain_profile_id
     AND (NEW.chain_profile_id IS NULL OR NEW.chain_profile_id = ct.chain_profile_id)
)
BEGIN SELECT RAISE(ABORT, 'transaction intent requires enabled campaign wallet membership'); END;

CREATE TRIGGER execution_membership_guard
BEFORE INSERT ON execution
WHEN NOT EXISTS (
  SELECT 1
    FROM transaction_intent i
    JOIN campaign_wallet cw ON cw.campaign_id = i.campaign_id AND cw.wallet_id = i.wallet_id AND cw.enabled = 1
   WHERE i.id = NEW.transaction_intent_id
     AND i.campaign_id = NEW.campaign_id
     AND i.wallet_id = NEW.wallet_id
)
BEGIN SELECT RAISE(ABORT, 'execution requires enabled campaign wallet membership'); END;

CREATE TRIGGER simulation_identity_guard
BEFORE INSERT ON simulation
WHEN NOT EXISTS (
  SELECT 1
    FROM campaign_wallet cw
   WHERE cw.campaign_id = NEW.campaign_id
     AND cw.wallet_id = NEW.wallet_id
     AND cw.enabled = 1
)
 OR (NEW.transaction_intent_id IS NOT NULL AND NOT EXISTS (
   SELECT 1 FROM transaction_intent i
    WHERE i.id = NEW.transaction_intent_id
      AND i.campaign_id = NEW.campaign_id
      AND i.wallet_id = NEW.wallet_id
 ))
BEGIN SELECT RAISE(ABORT, 'simulation identity requires enabled campaign wallet membership'); END;

CREATE TRIGGER simulation_time_domain_guard
BEFORE INSERT ON simulation
WHEN NEW.freshness_seconds < 300
  OR NEW.freshness_seconds > 86400
  OR julianday(NEW.checked_at) IS NULL
  OR julianday(NEW.checked_at) > julianday('now')
BEGIN SELECT RAISE(ABORT, 'simulation freshness must be between five minutes and 24 hours and checked_at cannot be future'); END;

CREATE TRIGGER readiness_membership_guard
BEFORE INSERT ON readiness_snapshot
WHEN NOT EXISTS (
  SELECT 1 FROM campaign_wallet
   WHERE campaign_id = NEW.campaign_id AND wallet_id = NEW.wallet_id AND enabled = 1
)
BEGIN SELECT RAISE(ABORT, 'readiness requires enabled campaign wallet membership'); END;

CREATE TRIGGER reconciliation_identity_guard
BEFORE INSERT ON reconciliation_record
WHEN trim(COALESCE(NEW.tx_hash, '')) = ''
  OR trim(COALESCE(NEW.from_address, '')) = ''
  OR NEW.nonce IS NULL
  OR (NEW.transaction_attempt_id IS NULL AND NEW.execution_id IS NULL)
  OR (NEW.transaction_attempt_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM transaction_attempt a
     WHERE a.id = NEW.transaction_attempt_id
       AND a.chain_profile_id = NEW.chain_profile_id
       AND lower(COALESCE(a.tx_hash, '')) = lower(NEW.tx_hash)
       AND lower(COALESCE(a.from_address, '')) = lower(NEW.from_address)
       AND a.nonce = NEW.nonce
  ))
  OR (NEW.execution_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM execution e
      JOIN wallet w ON w.id = e.wallet_id
     WHERE e.id = NEW.execution_id
       AND w.chain_profile_id = NEW.chain_profile_id
  ))
  OR (NEW.transaction_attempt_id IS NOT NULL AND NEW.execution_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM transaction_attempt a
     WHERE a.id = NEW.transaction_attempt_id
       AND (a.execution_id IS NULL OR a.execution_id = NEW.execution_id)
  ))
BEGIN SELECT RAISE(ABORT, 'reconciliation requires matching transaction identity'); END;
