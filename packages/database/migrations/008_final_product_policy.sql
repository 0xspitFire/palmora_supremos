ALTER TABLE spend_policy ADD COLUMN free_mint_wallet_cap_wei TEXT NOT NULL DEFAULT '200000000000000' CHECK (length(free_mint_wallet_cap_wei) > 0 AND free_mint_wallet_cap_wei NOT GLOB '*[^0-9]*');
ALTER TABLE spend_policy ADD COLUMN free_mint_period_cap_wei TEXT NOT NULL DEFAULT '2000000000000000' CHECK (length(free_mint_period_cap_wei) > 0 AND free_mint_period_cap_wei NOT GLOB '*[^0-9]*');
ALTER TABLE spend_reservation ADD COLUMN mint_period_id TEXT NOT NULL DEFAULT 'default';
CREATE INDEX idx_reservation_period ON spend_reservation(chain_profile_id, campaign_id, mint_period_id, status);
ALTER TABLE chain_profile ADD COLUMN success_finality_stage TEXT NOT NULL DEFAULT 'ethereum_final' CHECK (success_finality_stage IN ('soft', 'posted', 'ethereum_final'));

CREATE TABLE backup_policy (
  id TEXT PRIMARY KEY,
  retention_days INTEGER NOT NULL DEFAULT 30 CHECK (retention_days > 0),
  encryption_required INTEGER NOT NULL DEFAULT 1 CHECK (encryption_required = 1),
  approval_owner TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);
