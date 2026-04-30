-- =============================================================================
-- schema-v26-wyckoff-failed.sql
-- Phase 7b cont'd: Add structural-failure event types for v2 FSM detector.
--
-- When a "distribution" range breaks decisively up on volume, it was actually
-- re-accumulation. v2 emits 'distr_failed' explicitly so the chart shows the
-- structural failure (rather than silently switching state). Mirror for
-- 'accum_failed' on the bullish-rejection side.
--
-- Depends on: schema-v25-wyckoff-v2.sql
-- =============================================================================

ALTER TABLE wyckoff_events DROP CONSTRAINT IF EXISTS wyckoff_events_event_type_check;

ALTER TABLE wyckoff_events
    ADD CONSTRAINT wyckoff_events_event_type_check
    CHECK (event_type IN (
        -- Accumulation events
        'PS', 'SC', 'AR_up', 'ST_low', 'Spring', 'SOS', 'LPS',
        -- Distribution events
        'PSY', 'BC', 'AR_down', 'ST_high', 'UTAD', 'SOW', 'LPSY',
        -- Effort/Result anomalies
        'absorption', 'no_demand', 'no_supply',
        -- Passive drift (v23)
        'passive_markup', 'passive_markdown',
        -- Structural failures (v26)
        'distr_failed', 'accum_failed'
    ));
