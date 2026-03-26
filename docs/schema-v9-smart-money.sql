-- =============================================================================
-- schema-v9-smart-money.sql
-- Smart Money Signal: broker flow, bandar signals, insider transactions
--
-- Depends on: schema.sql (stocks table)
-- Data source: Stockbit Exodus API (marketdetectors + insider/company/majorholder)
-- =============================================================================

-- 1. broker_flow — per-broker buy/sell data from Stockbit marketdetectors
--    Replaces broker_summary for Stockbit-sourced data (which has buy/sell split).
--    Old broker_summary table remains for IDX API data (combined totals only).
CREATE TABLE IF NOT EXISTS broker_flow (
    ticker         VARCHAR(10)  NOT NULL REFERENCES stocks(ticker) ON DELETE CASCADE,
    trade_date     DATE         NOT NULL,
    broker_code    VARCHAR(10)  NOT NULL,
    broker_type    VARCHAR(15),              -- Lokal, Asing, Pemerintah
    buy_lot        BIGINT       NOT NULL DEFAULT 0,
    sell_lot       BIGINT       NOT NULL DEFAULT 0,
    buy_value      BIGINT       NOT NULL DEFAULT 0,   -- IDR
    sell_value     BIGINT       NOT NULL DEFAULT 0,   -- IDR
    buy_avg_price  DECIMAL(12,2),
    sell_avg_price DECIMAL(12,2),
    frequency      INTEGER,
    net_lot        BIGINT GENERATED ALWAYS AS (buy_lot - sell_lot) STORED,
    net_value      BIGINT GENERATED ALWAYS AS (buy_value - sell_value) STORED,
    created_at     TIMESTAMPTZ  DEFAULT now(),
    PRIMARY KEY (ticker, trade_date, broker_code)
);

CREATE INDEX IF NOT EXISTS idx_bf_ticker_date ON broker_flow(ticker, trade_date DESC);
CREATE INDEX IF NOT EXISTS idx_bf_broker      ON broker_flow(broker_code, trade_date DESC);


-- 2. bandar_signal — Stockbit pre-computed accumulation/distribution signals
--    Sourced from the bandar_detector block of the marketdetectors endpoint.
--    Signals at different broker concentration levels (top 1/3/5/10 brokers).
CREATE TABLE IF NOT EXISTS bandar_signal (
    ticker              VARCHAR(10) NOT NULL REFERENCES stocks(ticker) ON DELETE CASCADE,
    trade_date          DATE        NOT NULL,
    broker_accdist      VARCHAR(20),    -- overall acc/dist signal
    top1_accdist        VARCHAR(20),    -- top 1 broker signal
    top3_accdist        VARCHAR(20),    -- top 3 brokers signal
    top5_accdist        VARCHAR(20),    -- top 5 brokers signal
    top10_accdist       VARCHAR(20),    -- top 10 brokers signal
    total_buyer         INTEGER,
    total_seller        INTEGER,
    total_value         BIGINT,
    total_volume        BIGINT,
    raw_json            JSONB,          -- full bandar_detector block for debugging
    created_at          TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (ticker, trade_date)
);

CREATE INDEX IF NOT EXISTS idx_bs_ticker_date ON bandar_signal(ticker, trade_date DESC);


-- 3. insider_transactions — KSEI major holder movements via Stockbit
--    Sourced from insider/company/majorholder endpoint.
--    Tracks buy/sell activity by major shareholders (>=1% ownership).
CREATE TABLE IF NOT EXISTS insider_transactions (
    id                    SERIAL PRIMARY KEY,
    ticker                VARCHAR(10) NOT NULL REFERENCES stocks(ticker) ON DELETE CASCADE,
    insider_id            TEXT,                -- Stockbit record ID for dedup
    insider_name          TEXT        NOT NULL,
    transaction_date      DATE        NOT NULL,
    action                VARCHAR(4)  NOT NULL CHECK (action IN ('BUY','SELL')),
    share_change          BIGINT      NOT NULL,
    shares_before         BIGINT,
    shares_after          BIGINT,
    ownership_before_pct  DECIMAL(8,4),
    ownership_after_pct   DECIMAL(8,4),
    ownership_change_pct  DECIMAL(8,4),
    nationality           VARCHAR(20),
    broker_code           VARCHAR(10),
    broker_group          VARCHAR(30),
    data_source           VARCHAR(20) DEFAULT 'KSEI',
    price                 BIGINT,
    created_at            TIMESTAMPTZ DEFAULT now(),
    UNIQUE (ticker, insider_name, transaction_date, action, share_change)
);

CREATE INDEX IF NOT EXISTS idx_it_ticker_date ON insider_transactions(ticker, transaction_date DESC);
CREATE INDEX IF NOT EXISTS idx_it_action      ON insider_transactions(action, transaction_date DESC);


-- =============================================================================
-- Signal computation function (from FRD)
-- =============================================================================

CREATE OR REPLACE FUNCTION compute_smart_money_signal(
    p_bandar_net_flow  BIGINT,
    p_insider_action   VARCHAR,
    p_flow_threshold   BIGINT DEFAULT 5000000
) RETURNS VARCHAR AS $$
DECLARE v_broker VARCHAR(10);
BEGIN
    v_broker := CASE
        WHEN p_bandar_net_flow >  p_flow_threshold THEN 'net_beli'
        WHEN p_bandar_net_flow < -p_flow_threshold THEN 'net_jual'
        ELSE 'netral'
    END;
    RETURN CASE
        WHEN v_broker='net_beli' AND p_insider_action='buy'               THEN 'STRONG_BUY'
        WHEN v_broker='net_beli' AND p_insider_action='none'              THEN 'ACCUMULATION'
        WHEN v_broker='net_beli' AND p_insider_action IN ('sell','mixed') THEN 'CONFLICT'
        WHEN v_broker='netral'   AND p_insider_action='buy'               THEN 'EARLY_SIGNAL'
        WHEN v_broker='netral'   AND p_insider_action='none'              THEN 'NEUTRAL'
        WHEN v_broker='netral'   AND p_insider_action IN ('sell','mixed') THEN 'CAUTION'
        WHEN v_broker='net_jual' AND p_insider_action='buy'               THEN 'TRAP'
        WHEN v_broker='net_jual' AND p_insider_action='none'              THEN 'DISTRIBUTION'
        WHEN v_broker='net_jual' AND p_insider_action IN ('sell','mixed') THEN 'DANGER'
        ELSE 'NEUTRAL'
    END;
END;
$$ LANGUAGE plpgsql IMMUTABLE;


-- =============================================================================
-- RLS policies — allow anonymous read access from the Next.js frontend
-- =============================================================================

CREATE POLICY anon_select_broker_flow
  ON broker_flow FOR SELECT TO anon USING (true);

CREATE POLICY anon_select_bandar_signal
  ON bandar_signal FOR SELECT TO anon USING (true);

CREATE POLICY anon_select_insider_transactions
  ON insider_transactions FOR SELECT TO anon USING (true);
