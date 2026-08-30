ALTER TABLE fee_policy ADD COLUMN zero_priority_fee_policy TEXT NOT NULL DEFAULT 'requires_po_resolution' CHECK (zero_priority_fee_policy IN ('requires_po_resolution', 'blocked', 'allowed'));
CREATE INDEX idx_fee_policy_active_chain ON fee_policy(chain_profile_id, active, created_at);
