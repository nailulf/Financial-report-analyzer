# Smart Money Signal — Implementation Spec

## Stack
NextJS + Supabase (PostgreSQL). Python for scraping. Personal use, 800+ IDX tickers.

---

## Data Sources

### 1. Broker Summary
- **Endpoint:** `https://idx.co.id/api/broker-summary/{ticker}/{date}` (undocumented)
- **Auth:** None, but requires `curl_cffi` Chrome impersonation
- **Cadence:** Daily, available ~17:30 WIB after market close
- **Scrape strategy:** 1 request per (ticker, date), 1–2s delay, save raw JSON before parsing

### 2. Insider Trading Filing
- **Endpoint:** `https://idx.co.id/api/announcement` (category: keterbukaan insider) or `https://erep.ojk.go.id`
- **Format:** JSON or PDF — use `pdfplumber` for PDF parsing
- **Cadence:** Daily scan, filings appear within T+3 business days
- **Filter:** Only `on-market` and `off-market`; exclude hibah, warisan, ESOP exercise (`is_significant = false`)

---

## Database Schema

```sql
-- 1. Raw broker flow (scraped daily)
CREATE TABLE broker_flow (
  ticker        VARCHAR(10)  NOT NULL,
  trade_date    DATE         NOT NULL,
  broker_code   VARCHAR(10)  NOT NULL,
  buy_lot       BIGINT       NOT NULL DEFAULT 0,
  sell_lot      BIGINT       NOT NULL DEFAULT 0,
  buy_value     BIGINT       NOT NULL DEFAULT 0,  -- IDR as BIGINT
  sell_value    BIGINT       NOT NULL DEFAULT 0,
  net_lot       BIGINT GENERATED ALWAYS AS (buy_lot - sell_lot) STORED,
  net_value     BIGINT GENERATED ALWAYS AS (buy_value - sell_value) STORED,
  created_at    TIMESTAMPTZ  DEFAULT now(),
  PRIMARY KEY (ticker, trade_date, broker_code),
  FOREIGN KEY (ticker) REFERENCES stock_universe(ticker)
);
CREATE INDEX idx_bf_ticker_date ON broker_flow(ticker, trade_date DESC);
CREATE INDEX idx_bf_broker      ON broker_flow(broker_code, trade_date DESC);

-- 2. Insider transactions (scraped daily)
CREATE TABLE insider_transactions (
  id               SERIAL       PRIMARY KEY,
  ticker           VARCHAR(10)  NOT NULL,
  filing_date      DATE         NOT NULL,
  transaction_date DATE         NOT NULL,
  insider_name     TEXT         NOT NULL,
  insider_role     VARCHAR(100),
  action           VARCHAR(4)   NOT NULL CHECK (action IN ('BUY','SELL')),
  lot_amount       BIGINT       NOT NULL,
  price_per_lot    BIGINT,
  total_value      BIGINT,
  method           VARCHAR(50)  DEFAULT 'on-market',
  is_significant   BOOLEAN      DEFAULT true,
  created_at       TIMESTAMPTZ  DEFAULT now(),
  FOREIGN KEY (ticker) REFERENCES stock_universe(ticker)
);
CREATE INDEX idx_it_ticker_date ON insider_transactions(ticker, transaction_date DESC);

-- 3. Bandar broker labels (semi-manual, updated weekly)
CREATE TABLE bandar_brokers (
  ticker        VARCHAR(10)  NOT NULL,
  broker_code   VARCHAR(10)  NOT NULL,
  confidence    DECIMAL(3,2) DEFAULT 0.50,  -- 0.0–1.0
  identified_at DATE         NOT NULL,
  notes         TEXT,
  PRIMARY KEY (ticker, broker_code)
);

-- 4. Computed signals (recomputed nightly)
CREATE TABLE ownership_signals (
  ticker               VARCHAR(10)  NOT NULL,
  signal_date          DATE         NOT NULL,
  bandar_net_flow_30d  BIGINT,
  bandar_net_flow_7d   BIGINT,
  foreign_net_flow_30d BIGINT,
  insider_action_30d   VARCHAR(10),  -- 'buy'|'sell'|'mixed'|'none'
  insider_value_30d    BIGINT,
  smart_money_signal   VARCHAR(30),
  signal_confidence    DECIMAL(3,2),
  bandar_phase         VARCHAR(20),  -- ACCUMULATION|MARKUP|DISTRIBUTION|DANGER
  updated_at           TIMESTAMPTZ  DEFAULT now(),
  PRIMARY KEY (ticker, signal_date)
);
```

---

## Calculation Logic

### Step 1 — Identify bandar brokers (heuristic, weekly)
```sql
-- Candidate: broker with >15% of ticker's total volume over 6 months
-- AND net buy dominant when price was low AND net sell dominant when price was high
-- → INSERT into bandar_brokers with confidence = 0.7
-- Manual review raises confidence to 0.9+
-- Start with LQ45 tickers only
```

### Step 2 — Bandar net flow (rolling 30d)
```sql
SELECT SUM(net_value)
FROM broker_flow
WHERE ticker = :ticker
  AND trade_date BETWEEN (signal_date - 30) AND signal_date
  AND broker_code IN (
    SELECT broker_code FROM bandar_brokers
    WHERE ticker = :ticker AND confidence >= 0.7
  );
-- Threshold (mid-cap default): net_beli > +5_000_000, net_jual < -5_000_000
-- Store threshold per ticker in stock_universe.flow_threshold
```

### Step 3 — Insider action (rolling 30d)
```sql
SELECT
  SUM(CASE WHEN action='BUY'  THEN total_value ELSE 0 END) AS buy_val,
  SUM(CASE WHEN action='SELL' THEN total_value ELSE 0 END) AS sell_val,
  COUNT(*) AS filing_count
FROM insider_transactions
WHERE ticker = :ticker
  AND transaction_date BETWEEN (signal_date - 30) AND signal_date
  AND is_significant = true;

-- Classification:
-- buy_val > 0 AND sell_val = 0  → 'buy'
-- buy_val = 0 AND sell_val > 0  → 'sell'
-- both > 0                      → 'mixed' (treated as 'sell')
-- both = 0                      → 'none'
```

### Step 4 — Signal mapping (truth table)
```sql
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
    WHEN v_broker='net_beli' AND p_insider_action='buy'              THEN 'STRONG_BUY'
    WHEN v_broker='net_beli' AND p_insider_action='none'             THEN 'ACCUMULATION'
    WHEN v_broker='net_beli' AND p_insider_action IN ('sell','mixed') THEN 'CONFLICT'
    WHEN v_broker='netral'   AND p_insider_action='buy'              THEN 'EARLY_SIGNAL'
    WHEN v_broker='netral'   AND p_insider_action='none'             THEN 'NEUTRAL'
    WHEN v_broker='netral'   AND p_insider_action IN ('sell','mixed') THEN 'CAUTION'
    WHEN v_broker='net_jual' AND p_insider_action='buy'              THEN 'TRAP'
    WHEN v_broker='net_jual' AND p_insider_action='none'             THEN 'DISTRIBUTION'
    WHEN v_broker='net_jual' AND p_insider_action IN ('sell','mixed') THEN 'DANGER'
    ELSE 'NEUTRAL'
  END;
END;
$$ LANGUAGE plpgsql IMMUTABLE;
```

### Step 5 — Confidence score (0.0–1.0)
```sql
confidence = LEAST(1.0,
  (ABS(bandar_net_flow_30d)::float / flow_threshold * 0.40)  -- magnitude
  + (LEAST(filing_count / 3.0, 1.0) * 0.35)                 -- insider count
  + CASE WHEN sign(bandar_net_flow_7d) = sign(bandar_net_flow_30d)
         THEN 0.25 ELSE -0.10 END                            -- consistency
);
```

### Step 6 — Bandar phase detection (60d rolling)
| Phase | Condition |
|---|---|
| `ACCUMULATION` | Cumulative bandar flow rising 20+ days; price flat or down |
| `MARKUP` | Cumulative flow peaked; price up >15% from low; volume spike |
| `DISTRIBUTION` | Cumulative flow declining; price still near peak |
| `DANGER` | Cumulative flow down >20% from peak AND insider filing sell |

---

## Nightly Compute Job

```sql
-- Run after scraping completes (~20:00 WIB)
-- For each ticker in stock_universe:
INSERT INTO ownership_signals (
  ticker, signal_date,
  bandar_net_flow_30d, bandar_net_flow_7d, foreign_net_flow_30d,
  insider_action_30d, insider_value_30d,
  smart_money_signal, signal_confidence, bandar_phase
)
SELECT
  ticker,
  CURRENT_DATE AS signal_date,
  -- bandar_net_flow_30d: Step 2 query
  -- bandar_net_flow_7d:  same query with 7-day window
  -- foreign_net_flow_30d: same but broker_code IN known foreign brokers
  -- insider_action_30d:  Step 3 classification
  -- insider_value_30d:   sum of total_value from Step 3
  compute_smart_money_signal(bandar_net_flow_30d, insider_action_30d, flow_threshold),
  -- confidence: Step 5 formula
  -- bandar_phase: Step 6 logic
  now()
ON CONFLICT (ticker, signal_date) DO UPDATE SET
  smart_money_signal  = EXCLUDED.smart_money_signal,
  signal_confidence   = EXCLUDED.signal_confidence,
  bandar_phase        = EXCLUDED.bandar_phase,
  updated_at          = now();
```

---

## Python Scraper Outline

```python
# scraper/broker_flow.py
import curl_cffi.requests as requests
from datetime import date, timedelta
import time, json

HEADERS = {"User-Agent": "Mozilla/5.0 ..."}  # curl_cffi handles impersonation

def scrape_broker_flow(ticker: str, trade_date: date) -> list[dict]:
    url = f"https://idx.co.id/api/broker-summary/{ticker}/{trade_date}"
    r = requests.get(url, impersonate="chrome110", headers=HEADERS, timeout=15)
    r.raise_for_status()
    raw = r.json()
    # Save raw: json.dump(raw, open(f"raw/{ticker}_{trade_date}.json", "w"))
    return [
        {
            "ticker": ticker,
            "trade_date": trade_date,
            "broker_code": row["broker_code"],
            "buy_lot":    row["buy_lot"],
            "sell_lot":   row["sell_lot"],
            "buy_value":  row["buy_value"],
            "sell_value": row["sell_value"],
        }
        for row in raw.get("data", [])
    ]

def run_daily(tickers: list[str], trade_date: date):
    for ticker in tickers:
        rows = scrape_broker_flow(ticker, trade_date)
        # upsert to Supabase: supabase.table("broker_flow").upsert(rows).execute()
        time.sleep(1.5)

# scraper/insider_filing.py
def scrape_insider_filings(trade_date: date) -> list[dict]:
    # Scan IDX announcement API for insider category
    # Parse PDF if format is PDF (use pdfplumber)
    # Filter: method in ('on-market', 'off-market') → is_significant = True
    # Normalize insider_name for deduplication
    pass
```

---

## NextJS API Routes

```
GET /api/smart-money/[ticker]
  → ownership_signals for ticker, last 30 rows + current signal

GET /api/broker-flow/[ticker]
  → broker_flow grouped by date, filtered by bandar_brokers if ?bandar_only=true

GET /api/insider/[ticker]
  → insider_transactions where is_significant=true, last 60 days

GET /api/screener/smart-money
  → ownership_signals WHERE signal_date = today
    ORDER BY signal_confidence DESC
    optional filter: ?signal=ACCUMULATION&min_confidence=0.6
```

All routes use Supabase server client (service key stays server-side only).

---

## Acceptance Criteria (Phase 1)

- [ ] `broker_flow` populated for 60 days × LQ45 tickers (45 stocks minimum)
- [ ] `insider_transactions` populated for 90 days, `is_significant` correctly filtered
- [ ] `bandar_brokers` has ≥1 labeled broker for ≥20 LQ45 tickers
- [ ] `compute_smart_money_signal()` unit tested for all 9 input combinations
- [ ] Nightly job runs without error; `ownership_signals` populated for `CURRENT_DATE - 1`
- [ ] Screener query returns plausible output:
  ```sql
  SELECT ticker, smart_money_signal, signal_confidence
  FROM ownership_signals
  WHERE signal_date = CURRENT_DATE - 1
  ORDER BY signal_confidence DESC
  LIMIT 20;
  ```

---

## Known Constraints

| Issue | Mitigation |
|---|---|
| Bandar broker ID is heuristic, not ground truth | Start LQ45 only; manual review before scaling |
| Insider filing delay up to T+3 (often late) | Store both `filing_date` and `transaction_date`; flag late filings |
| IDX endpoint undocumented, may change | Save raw JSON before parsing; alert on schema change |
| Bandar may split orders across multiple brokers | Correlation analysis: brokers moving in sync = likely affiliates |
| `flow_threshold` is size-dependent | Store per-ticker in `stock_universe.flow_threshold`; default 5_000_000 |
