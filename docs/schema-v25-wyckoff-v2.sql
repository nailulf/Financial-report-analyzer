-- =============================================================================
-- schema-v25-wyckoff-v2.sql
-- Phase 7b cont'd: Allow v1 and v2 detector outputs to coexist for
-- side-by-side comparison.
--
-- v1 (wyckoff_detector.py) — flat-event passes, deduped + clustered
-- v2 (wyckoff_detector_v2.py) — finite state machine, sequence-enforced
--
-- Both write to wyckoff_events with detection_version='1.0' / '2.0'. Frontend
-- toggles which set to display. Once a winner is chosen, we drop the loser.
--
-- Depends on: schema-v23-wyckoff-passive.sql
-- =============================================================================

-- Drop old unique constraint that prevents same-day same-type rows across versions.
ALTER TABLE wyckoff_events
    DROP CONSTRAINT IF EXISTS wyckoff_events_ticker_event_date_event_type_key;

-- Recreate including detection_version so v1 and v2 can each have their own row.
ALTER TABLE wyckoff_events
    ADD CONSTRAINT wyckoff_events_ticker_event_date_event_type_version_key
    UNIQUE (ticker, event_date, event_type, detection_version);

-- Index by detection_version for fast filtering on the screener / chart fetches.
CREATE INDEX IF NOT EXISTS idx_we_version ON wyckoff_events(detection_version);

-- Add denormalized v2 columns to stocks (parallel to v1 denorm columns from v24).
-- The detector writes to whichever set matches its version.
ALTER TABLE stocks
    ADD COLUMN IF NOT EXISTS current_wyckoff_event_v2       TEXT,
    ADD COLUMN IF NOT EXISTS current_wyckoff_event_date_v2  DATE,
    ADD COLUMN IF NOT EXISTS current_wyckoff_phase_v2       TEXT,
    ADD COLUMN IF NOT EXISTS current_wyckoff_confidence_v2  SMALLINT,
    -- v2-specific: the fine-grained FSM phase (accumulation_a/b/c/d, markup, etc.)
    ADD COLUMN IF NOT EXISTS current_wyckoff_fsm_phase_v2   TEXT;
