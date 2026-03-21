-- =============================================================================
-- Schema v5 — Phase 3: Volume Anomaly + Flow Score Views
-- Apply in Supabase SQL Editor after schema-v4-phase3-migration.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. v_volume_anomalies
--    Per-stock: today's volume vs 20-day average. Used to surface unusual
--    trading activity. A ratio >= 2.0 means volume is 2× the 20-day average.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_volume_anomalies AS
WITH ranked AS (
  SELECT
    ticker,
    date,
    volume,
    close,
    ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY date DESC) AS rn
  FROM daily_prices
  WHERE volume IS NOT NULL AND volume > 0
),
latest AS (
  SELECT ticker, date AS latest_date, volume AS today_volume, close AS latest_close
  FROM ranked
  WHERE rn = 1
),
avg20 AS (
  SELECT
    ticker,
    ROUND(AVG(volume)) AS avg_vol_20d,
    COUNT(*)           AS sample_days
  FROM ranked
  WHERE rn BETWEEN 2 AND 21   -- skip today, take previous 20 sessions
  GROUP BY ticker
  HAVING COUNT(*) >= 5         -- need at least 5 sessions to be meaningful
)
SELECT
  l.ticker,
  l.latest_date,
  l.today_volume,
  l.latest_close,
  a.avg_vol_20d,
  a.sample_days,
  ROUND((l.today_volume::numeric / a.avg_vol_20d), 2) AS volume_ratio
FROM latest l
JOIN avg20 a USING (ticker)
WHERE a.avg_vol_20d > 0
  AND l.today_volume > a.avg_vol_20d  -- only stocks with above-average volume
ORDER BY volume_ratio DESC;


-- -----------------------------------------------------------------------------
-- 2. v_flow_score
--    Composite money-flow score (0–100) per stock derived from three signals:
--
--    foreign_score  (0–50 pts)  Percentile rank of 5-day net foreign flow.
--                               50 = top foreign buyer, 0 = top foreign seller.
--
--    volume_score   (0–25 pts)  Volume anomaly combined with price direction.
--                               High volume on up days = bullish; on down days
--                               = bearish. Neutral when no anomaly.
--
--    price_score    (0–25 pts)  5-day price change. Strong up = 25, strong
--                               down = 1, flat = 12–13 (neutral).
--
--    Interpretation:
--      70–100 : Strong accumulation signal (Kuat)
--      51–69  : Mild accumulation (Akumulasi)
--      40–50  : Neutral (Netral)
--      25–39  : Mild distribution (Lemah)
--       0–24  : Strong distribution signal (Distribusi)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_flow_score AS
WITH vol_data AS (
  SELECT
    ticker,
    date,
    volume,
    close,
    ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY date DESC) AS rn
  FROM daily_prices
  WHERE volume IS NOT NULL AND volume > 0
),
latest_price AS (
  SELECT ticker, close AS latest_close, volume AS latest_volume
  FROM vol_data WHERE rn = 1
),
price_5d_ago AS (
  SELECT ticker, close AS close_5d_ago
  FROM vol_data WHERE rn = 6
),
avg_volume AS (
  SELECT
    ticker,
    AVG(volume) AS avg_vol_20d
  FROM vol_data
  WHERE rn BETWEEN 2 AND 21
  GROUP BY ticker
  HAVING COUNT(*) >= 5
),
base AS (
  SELECT
    lp.ticker,
    lp.latest_close,
    lp.latest_volume,
    p5.close_5d_ago,
    av.avg_vol_20d,
    CASE
      WHEN av.avg_vol_20d > 0
        THEN ROUND((lp.latest_volume::numeric / av.avg_vol_20d), 2)
      ELSE NULL
    END AS volume_ratio,
    CASE
      WHEN p5.close_5d_ago > 0
        THEN ROUND(((lp.latest_close - p5.close_5d_ago) / p5.close_5d_ago * 100)::numeric, 2)
      ELSE NULL
    END AS pct_change_5d,
    ff.foreign_net_5d,
    ff.foreign_net_20d
  FROM latest_price lp
  LEFT JOIN price_5d_ago p5    USING (ticker)
  LEFT JOIN avg_volume av       USING (ticker)
  LEFT JOIN v_foreign_flow_summary ff USING (ticker)
),
ranked AS (
  SELECT
    *,
    PERCENT_RANK() OVER (ORDER BY COALESCE(foreign_net_5d, 0)) AS foreign_pct_rank
  FROM base
)
SELECT
  ticker,
  latest_close,
  latest_volume,
  avg_vol_20d,
  volume_ratio,
  pct_change_5d,
  foreign_net_5d,
  foreign_net_20d,
  ROUND(foreign_pct_rank * 100)::integer AS foreign_percentile,

  -- ── Component scores ──────────────────────────────────────────────────────
  ROUND(foreign_pct_rank * 50)::integer AS foreign_score,

  ROUND(CASE
    WHEN volume_ratio IS NULL              THEN 12   -- neutral: no vol data
    WHEN volume_ratio >= 2 AND pct_change_5d > 0 THEN 25  -- big vol + up  = bullish
    WHEN volume_ratio >= 2 AND pct_change_5d < 0 THEN 0   -- big vol + down = bearish
    WHEN volume_ratio >= 1.5 AND pct_change_5d > 0 THEN 20
    WHEN volume_ratio >= 1.5 AND pct_change_5d < 0 THEN 5
    WHEN pct_change_5d > 0                THEN 15
    WHEN pct_change_5d < 0                THEN 10
    ELSE 12
  END)::integer AS volume_score,

  ROUND(CASE
    WHEN pct_change_5d IS NULL  THEN 12   -- neutral: no price data
    WHEN pct_change_5d > 10     THEN 25
    WHEN pct_change_5d > 5      THEN 20
    WHEN pct_change_5d > 2      THEN 17
    WHEN pct_change_5d > 0      THEN 14
    WHEN pct_change_5d > -2     THEN 11
    WHEN pct_change_5d > -5     THEN 7
    WHEN pct_change_5d > -10    THEN 4
    ELSE 1
  END)::integer AS price_score,

  -- ── Total flow score (0–100) ───────────────────────────────────────────────
  LEAST(100, GREATEST(0,
    ROUND(foreign_pct_rank * 50)::integer
    +
    ROUND(CASE
      WHEN volume_ratio IS NULL              THEN 12
      WHEN volume_ratio >= 2 AND pct_change_5d > 0 THEN 25
      WHEN volume_ratio >= 2 AND pct_change_5d < 0 THEN 0
      WHEN volume_ratio >= 1.5 AND pct_change_5d > 0 THEN 20
      WHEN volume_ratio >= 1.5 AND pct_change_5d < 0 THEN 5
      WHEN pct_change_5d > 0                THEN 15
      WHEN pct_change_5d < 0                THEN 10
      ELSE 12
    END)::integer
    +
    ROUND(CASE
      WHEN pct_change_5d IS NULL  THEN 12
      WHEN pct_change_5d > 10     THEN 25
      WHEN pct_change_5d > 5      THEN 20
      WHEN pct_change_5d > 2      THEN 17
      WHEN pct_change_5d > 0      THEN 14
      WHEN pct_change_5d > -2     THEN 11
      WHEN pct_change_5d > -5     THEN 7
      WHEN pct_change_5d > -10    THEN 4
      ELSE 1
    END)::integer
  ))::integer AS flow_score

FROM ranked;
