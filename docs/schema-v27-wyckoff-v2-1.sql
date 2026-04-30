-- =============================================================================
-- schema-v27-wyckoff-v2-1.sql
-- Phase 7b cont'd: Add 6 v2.1 event types per
-- docs/wyckoff_detector_v2_spec.md
--
-- New event types support:
--   markup_exhaustion / markdown_exhaustion  → trend-driven phase exit when
--                                              no clean climax fires
--   basis_building / topping_action          → soft phase A entry when no
--                                              textbook SC/BC fires
--   range_breakout_up / range_breakout_down  → Phase B exits without Spring
--                                              or UTAD producing the textbook
--                                              signal first
--
-- Idempotent: drops + recreates the CHECK constraint with the full current
-- vocabulary.
-- =============================================================================

ALTER TABLE wyckoff_events DROP CONSTRAINT IF EXISTS wyckoff_events_event_type_check;

ALTER TABLE wyckoff_events
    ADD CONSTRAINT wyckoff_events_event_type_check
    CHECK (event_type IN (
        -- Accumulation events
        'PS', 'SC', 'AR_up', 'ST_low', 'Spring', 'SOS', 'LPS',
        -- Distribution events
        'PSY', 'BC', 'AR_down', 'ST_high', 'UTAD', 'SOW', 'LPSY',
        -- Effort/Result anomalies (v1)
        'absorption', 'no_demand', 'no_supply',
        -- Passive drift (v1, v23)
        'passive_markup', 'passive_markdown',
        -- Structural failures (v2 FSM, v26)
        'distr_failed', 'accum_failed',
        -- v2.1 spec additions (v27)
        'markup_exhaustion', 'markdown_exhaustion',
        'basis_building', 'topping_action',
        'range_breakout_up', 'range_breakout_down'
    ));
