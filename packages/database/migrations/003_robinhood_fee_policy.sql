ALTER TABLE fee_policy ADD COLUMN free_mint_priority_fee_component_wei TEXT NOT NULL DEFAULT '0' CHECK (length(free_mint_priority_fee_component_wei) > 0 AND free_mint_priority_fee_component_wei NOT GLOB '*[^0-9]*');
ALTER TABLE fee_policy ADD COLUMN free_mint_priority_fee_multiplier INTEGER NOT NULL DEFAULT 2 CHECK (free_mint_priority_fee_multiplier BETWEEN 0 AND 2);
ALTER TABLE fee_policy ADD COLUMN paid_mints_enabled INTEGER NOT NULL DEFAULT 0 CHECK (paid_mints_enabled IN (0, 1));

CREATE TABLE documentation_fixture (
  id TEXT PRIMARY KEY,
  chain_profile_id TEXT NOT NULL REFERENCES chain_profile(id),
  tx_hash TEXT NOT NULL,
  fixture_type TEXT NOT NULL CHECK (fixture_type IN ('external_wallet_failed', 'positive_reference')),
  execution_eligible INTEGER NOT NULL DEFAULT 0 CHECK (execution_eligible = 0),
  notes TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  UNIQUE(chain_profile_id, tx_hash)
);
CREATE INDEX idx_documentation_fixture_chain_type ON documentation_fixture(chain_profile_id, fixture_type);
