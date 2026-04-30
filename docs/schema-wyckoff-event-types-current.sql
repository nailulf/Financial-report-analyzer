-- =============================================================================
-- schema-wyckoff-event-types-current.sql
-- Idempotent: brings wyckoff_events.event_type CHECK constraint fully up to
-- date with whatever the latest detector emits. Run this whenever the
-- detector adds new event types.
--
-- This is the consolidated current-state version of the constraint;
-- supersedes the partial deltas in v22 / v23 / v26.
-- =============================================================================

ALTER TABLE wyckoff_events DROP CONSTRAINT IF EXISTS wyckoff_events_event_type_check;

ALTER TABLE wyckoff_events
    ADD CONSTRAINT wyckoff_events_event_type_check
    CHECK (event_type IN (
        -- Accumulation events
        'PS', 'SC', 'AR_up', 'ST_low', 'Spring', 'SOS', 'LPS',
        -- Distribution events
        'PSY', 'BC', 'AR_down', 'ST_high', 'UTAD', 'SOW', 'LPSY',
        -- Effort/Result anomalies (v1 detector)
        'absorption', 'no_demand', 'no_supply',
        -- Passive drift (v1 detector, v23)
        'passive_markup', 'passive_markdown',
        -- Structural failures (v2 FSM detector, v26)
        'distr_failed', 'accum_failed',
        -- v2.1 spec additions (v27)
        'markup_exhaustion', 'markdown_exhaustion',
        'basis_building', 'topping_action',
        'range_breakout_up', 'range_breakout_down'
    ));

-- Verify:
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'wyckoff_events'::regclass
  AND conname = 'wyckoff_events_event_type_check';
