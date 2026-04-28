-- =============================================================================
-- schema-v24-stocks-wyckoff-denorm.sql
-- Phase 7b cont'd: Denormalize latest Wyckoff event onto stocks table for
-- fast screener filtering (mirrors current_phase / current_phase_clarity).
--
-- Without these columns, the screener would have to JOIN wyckoff_events on
-- every query — too expensive for a list of 800+ stocks.
--
-- Depends on: schema-v23-wyckoff-passive.sql
-- =============================================================================

ALTER TABLE stocks
    ADD COLUMN IF NOT EXISTS current_wyckoff_event       TEXT,
    ADD COLUMN IF NOT EXISTS current_wyckoff_event_date  DATE,
    ADD COLUMN IF NOT EXISTS current_wyckoff_phase       TEXT,
    ADD COLUMN IF NOT EXISTS current_wyckoff_confidence  SMALLINT;

CREATE INDEX IF NOT EXISTS idx_stocks_wyckoff_event ON stocks(current_wyckoff_event);
CREATE INDEX IF NOT EXISTS idx_stocks_wyckoff_phase ON stocks(current_wyckoff_phase);
CREATE INDEX IF NOT EXISTS idx_stocks_wyckoff_date  ON stocks(current_wyckoff_event_date);
