-- =============================================================================
-- schema-v23-wyckoff-passive.sql
-- Phase 7b cont'd: Add passive_markup / passive_markdown event types
--
-- Real Wyckoff covers climactic events well, but classical theory does NOT
-- have a clean event for "slow drift" phases (where supply/demand imbalance
-- is steady rather than dramatic). DEWA's Feb-Apr 2026 decline from ~800 to
-- ~400 produced ZERO events under the original detector because no single
-- bar carried climactic signature — yet a 50% move clearly happened.
--
-- This adds two pragmatic event types to mark those drift phases.
--
-- Depends on: schema-v22-wyckoff.sql
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
        -- Passive drift (added v23)
        'passive_markup', 'passive_markdown'
    ));
