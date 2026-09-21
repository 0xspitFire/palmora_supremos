-- Preserve staged Robinhood finality observations without treating disabled
-- or not-yet-final receipts as confirmed settlement evidence.

DROP TRIGGER receipt_status_finality_guard;

CREATE TRIGGER receipt_status_finality_guard
BEFORE INSERT ON transaction_receipt
WHEN (NEW.finality_stage IN ('posted', 'ethereum_final') AND NEW.status NOT IN ('pending', 'confirmed'))
  OR (NEW.status IN ('reverted', 'reorged', 'dropped') AND NEW.finality_stage IN ('posted', 'ethereum_final'))
BEGIN SELECT RAISE(ABORT, 'receipt status and finality are inconsistent'); END;
