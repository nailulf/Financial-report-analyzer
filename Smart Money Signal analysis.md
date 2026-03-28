# Smart Money Signal — Functional Requirements Document

**Version:** 2.0
**Status:** Implemented
**Last Updated:** March 2026

## Stack
NextJS 16 + Supabase (PostgreSQL). Python for scraping. Personal use, 800+ IDX tickers.

---

## Data Sources

### 1. Broker Flow + Bandar Detection (Stockbit API)
- **Endpoint:** Stockbit marketdetectors API (undocumented Exodus API)
- **Auth:** Bearer token, managed by `python/utils/token_manager.py` (cached + interactive refresh)
- **Data provided:** Per-broker buy/sell lots + values, broker type (Lokal/Asing/Pemerintah), pre-computed bandar_detector signals at 4 concentration levels (top 1/3/5/10 brokers)
- **Cadence:** Daily backfill via `run_all.py --broker-backfill`, configurable window (default 30 days)
- **Rate limit:** 0.8s between requests (configured in `python/config.py`)
- **Why Stockbit over direct IDX scraping:** Richer data — includes buy/sell split per broker (IDX API only provides combined totals), broker type classification, and pre-computed bandar accumulation/distribution signals. Eliminates the need for manual bandar broker labeling.

### 2. Insider Transactions (KSEI via Stockbit)
- **Endpoint:** Stockbit insider/company/majorholder API
- **Auth:** Same bearer token as broker flow
- **Data provided:** Major holder (≥1%) buy/sell activity — share changes, ownership before/after percentages, nationality, broker used
- **Cadence:** Via `run_all.py --insider`, paginated (default 5 pages per ticker)
- **Why Stockbit/KSEI over IDX/OJK:** Structured JSON data (no PDF parsing needed), includes ownership percentage changes, and covers all major holder movements reported to KSEI

### 3. Foreign Investor Flow (IDX API — supplementary)
- **Endpoint:** IDX API via `money_flow.py`
- **Auth:** `curl_cffi` with Chrome impersonation
- **Data provided:** Daily foreign buy/sell values stored in `daily_prices.foreign_buy/sell/net`
- **Cadence:** Daily via `run_all.py --daily`

---

## Database Schema

Defined in `docs/schema-v9-smart-money.sql`. Three tables + one SQL function:

```sql
-- 1. broker_flow — per-broker buy/sell data from Stockbit marketdetectors
CREATE TABLE broker_flow (
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

-- 2. bandar_signal — Stockbit pre-computed accumulation/distribution signals
CREATE TABLE bandar_signal (
    ticker              VARCHAR(10) NOT NULL REFERENCES stocks(ticker) ON DELETE CASCADE,
    trade_date          DATE        NOT NULL,
    broker_accdist      VARCHAR(20),    -- overall: "Big Acc", "Acc", "Normal Acc", "Dist", etc.
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

-- 3. insider_transactions — KSEI major holder movements via Stockbit
CREATE TABLE insider_transactions (
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
```

**Deviation from original spec:**
- `bandar_brokers` (manual labeling table) — **superseded** by automated `bandar_signal` from Stockbit's bandar_detector. No manual labeling needed.
- `ownership_signals` (nightly computed signals) — **superseded** by on-demand frontend computation in `signal-confidence.ts`. Signal scoring happens at query time, not as a batch job.

---

## Calculation Logic

### Architecture Change

The original spec planned SQL-side nightly batch computation. The actual implementation uses a **hybrid approach**:
- **Data collection**: Python scrapers populate `broker_flow`, `bandar_signal`, and `insider_transactions` tables
- **Signal scoring**: TypeScript module `web/src/lib/calculations/signal-confidence.ts` computes scores **on-demand** at query time
- **SQL function**: `compute_smart_money_signal()` exists in the database (from the original spec) but the primary scoring uses the richer TypeScript implementation

### Step 1 — Bandar Identification (automated, via Stockbit)

**Original plan:** Manual heuristic — broker with >15% volume over 6 months, manually reviewed.

**Actual implementation:** Automated via Stockbit's `bandar_detector` block. Stockbit pre-computes accumulation/distribution signals at 4 concentration levels:
- `broker_accdist`: Overall signal (e.g., "Big Acc", "Acc", "Normal Acc", "Dist", "Big Dist")
- `top1_accdist`: Top 1 broker by volume
- `top3_accdist`: Top 3 brokers
- `top5_accdist`: Top 5 brokers
- `top10_accdist`: Top 10 brokers

Additionally, the frontend computes **broker concentration** (`getBrokerConcentration()` in `web/src/lib/queries/broker.ts`):
- Aggregates broker_flow over N days
- Classifies brokers as `kandidat_bandar` (≥10% concentration + net position), `asing`, or `retail`
- Returns top 15 brokers by absolute net value

### Step 2 — Broker Flow Aggregation (on-demand)

Data is fetched via `getSmartMoneyData()` in `broker.ts`:
- Queries `broker_flow` for N days (default 30), batched to avoid PostgREST row cap
- Aggregates by broker type: `asing_net`, `lokal_net`, `pemerintah_net`
- Provides daily flow breakdown for charts via `getDailyBrokerFlowByType()`

### Step 3 — Insider Action (on-demand)

Data fetched via `getInsiderTransactions()` in `broker.ts`:
- Queries `insider_transactions` table (most recent 20 by default)
- Computes `total_value = share_change × price` for each transaction
- Frontend aggregates buy/sell values and determines net direction

### Step 4 — Phase Detection

Three phases, determined by overall broker flow direction:

| Phase | Indonesian | Condition |
|-------|-----------|-----------|
| `akumulasi` | Akumulasi | Net broker flow is positive (buying dominant) |
| `distribusi` | Distribusi | Net broker flow is negative (selling dominant) |
| `netral` | Netral | Net flow near zero |

### Step 5 — Signal Confidence Score (0–100)

Implemented in `web/src/lib/calculations/signal-confidence.ts` → `computeConfidence()`.

Five weighted components:

| Component | Max Points | What It Measures |
|-----------|-----------|-----------------|
| **Broker Magnitude** | 25 | `abs(netFlow) / totalTradingValue` — how significant is the net flow? |
| **Foreign Alignment** | 25 | Does foreign flow direction align with the overall signal phase? |
| **Bandar Confirmation** | 20 | Does Stockbit's bandar_detector signal (overall + top5) align with the phase? |
| **Insider Weight** | 15 | Do insider buy/sell transactions align? Bonus for material ownership changes. |
| **Broker Concentration** | 15 | Top 3 brokers: how concentrated, and does their direction align? |

**Scoring thresholds for Broker Magnitude (example):**
```
ratio ≥ 10%  → 25 pts
ratio ≥  5%  → 20 pts
ratio ≥  2%  → 15 pts
ratio ≥ 0.5% → 10 pts
ratio <  0.5% → 5 pts
```

**Strength labels:**
| Score | Label | Color |
|-------|-------|-------|
| ≥80 | Sangat Kuat | #006633 |
| ≥60 | Kuat | #155724 |
| ≥40 | Sedang | #856404 |
| ≥20 | Lemah | #CC6600 |
| <20 | Sangat Lemah | #721C24 |

Each component returns both a numeric score and an Indonesian-language explanation string used in the UI tooltip.

### Step 6 — Narrative Generation (rule-based)

Implemented in `signal-confidence.ts` → `generateNarrative()`.

Pattern-based system that detects money-flow patterns and describes what is happening in Indonesian. Patterns detected (ordered by specificity):

| Pattern | Conclusion |
|---------|-----------|
| All actors neutral | "Tidak ada pergerakan signifikan" |
| All actors accumulating | "Semua aktor selaras masuk" |
| All actors distributing | "Semua aktor selaras keluar" |
| Foreign exit absorbed domestically (low net) | "Perpindahan kepemilikan, bukan distribusi" |
| Asing + BUMN selling, retail absorbing | "Potensi distribusi ke retail" |
| Asing + BUMN buying, retail selling | "Smart money masuk" |
| Foreign-dominant accumulation | "Foreign smart money masuk" |
| Foreign-dominant distribution, absorbed | "Waspada jika tekanan asing berlanjut" |
| Foreign-dominant distribution, unabsorbed | "Tekanan jual asing dominan" |
| Retail-dominant accumulation | "Retail masuk, perlu konfirmasi smart money" |
| Retail-dominant distribution + asing buying | "Potensi akumulasi smart money" |
| Mixed buying/selling | "Belum ada konsensus arah" |

Each narrative includes an insider activity suffix when data is available (e.g., "Insider: 2 BUY, 1 SELL").

### Legacy: SQL Signal Function

The `compute_smart_money_signal()` SQL function from the original spec remains in the database (`docs/schema-v9-smart-money.sql`) for potential future batch computation. It implements the 3×3 truth table:

| Broker \ Insider | buy | none | sell/mixed |
|-----------------|-----|------|-----------|
| **net_beli** | STRONG_BUY | ACCUMULATION | CONFLICT |
| **netral** | EARLY_SIGNAL | NEUTRAL | CAUTION |
| **net_jual** | TRAP | DISTRIBUTION | DANGER |

---

## Data Pipeline (replaces "Nightly Compute Job")

**Original plan:** Nightly SQL batch job computing signals for all tickers into `ownership_signals` table.

**Actual implementation:** Two-stage architecture — data collection is batched, signal scoring is on-demand.

### Stage 1: Data Collection (Python, scheduled)

Run via `run_all.py`:

```bash
# Daily broker flow + bandar signals (after market close ~17:30 WIB)
python run_all.py --broker-backfill --backfill-days 1

# Insider transactions (weekly or on-demand)
python run_all.py --insider

# Can also run as part of single-ticker refresh
python run_all.py --full --ticker BBRI --scrapers broker_backfill
```

The `money_flow.py` scraper handles three Stockbit endpoints:
1. **marketdetectors** → `broker_flow` + `bandar_signal` tables
2. **insider/company/majorholder** → `insider_transactions` table

### Stage 2: Signal Scoring (TypeScript, on-demand)

When a user views a stock's broker activity widget, the frontend:

1. Calls `getSmartMoneyData(ticker, days)` → fetches broker_flow, bandar_signal, insider data in parallel
2. Determines signal phase (akumulasi/distribusi/netral)
3. Calls `computeConfidence(input)` → 100-point score with 5 components
4. Calls `generateNarrative(input)` → Indonesian-language explanation

This avoids maintaining a separate computed signals table and ensures scores always reflect the latest data.

---

## Python Scraper Implementation

All smart money scraping is handled by `python/scrapers/money_flow.py` which exposes two entry points used by `run_all.py`:

### `run_broker_backfill(tickers, days, offset, limit)`
- Iterates tickers (default: all stocks sorted by market cap)
- For each ticker, calls Stockbit marketdetectors endpoint for N days of history
- Parses response into `broker_flow` rows (per-broker buy/sell) and `bandar_signal` rows (bandar_detector block)
- Upserts both tables via `supabase_client.py`
- Rate limited at 0.8s between requests
- Supports offset/limit for batching large runs

### `run_insider_scrape(tickers, max_pages, offset, limit)`
- Iterates tickers, calls Stockbit insider/company/majorholder endpoint
- Paginated: fetches up to `max_pages` per ticker (default 5)
- Parses major holder buy/sell transactions
- Deduplicates via composite unique key: (ticker, insider_name, transaction_date, action, share_change)
- Upserts to `insider_transactions` table

### Key utilities
- `python/utils/stockbit_client.py` — Stockbit API wrapper
- `python/utils/token_manager.py` — Bearer token caching + interactive refresh

---

## NextJS Integration

### API Route

```
GET /api/stocks/[ticker]/broker?mode=smart-money&days=30
  → Full smart money data: broker summary, daily flow by type, concentration,
    bandar signal, insider transactions
```

All data is fetched server-side via Supabase server client (service key stays server-side only).

### Query Module: `web/src/lib/queries/broker.ts`

Key exported functions:
- `getSmartMoneyData(ticker, days)` — combines all queries below into one response
- `getStockBrokerSummary(ticker, days)` — top buyers/sellers/net, with bandar signal
- `getDailyBrokerFlowByType(ticker, days)` — daily asing/lokal/pemerintah flow for charts
- `getBrokerConcentration(ticker, days)` — top 15 brokers with concentration % and bandar/asing/retail classification
- `getBandarSignal(ticker, date)` — latest bandar_signal row
- `getInsiderTransactions(ticker, limit)` — recent major holder transactions

### Calculation Module: `web/src/lib/calculations/signal-confidence.ts`

Key exported functions:
- `computeConfidence(input)` → `ConfidenceScore` (total 0–100, per-component scores + explanations)
- `generateNarrative(input)` → `Narrative` (conclusion + detail in Indonesian)

### UI Widget: `BrokerActivityWidget.tsx`

Located at `web/src/components/stock/widgets/BrokerActivityWidget.tsx`. Renders:
- Smart money confidence score badge with strength label
- Narrative conclusion + expandable detail
- Daily flow chart (asing vs lokal vs pemerintah)
- Top brokers table with concentration % and bandar candidate flags
- Insider transaction list with ownership changes

---

## Acceptance Criteria

### Data Pipeline ✅
- [x] `broker_flow` populated via Stockbit backfill (configurable days × tickers)
- [x] `bandar_signal` populated with multi-level acc/dist signals (top 1/3/5/10)
- [x] `insider_transactions` populated via KSEI data with deduplication
- [x] `compute_smart_money_signal()` SQL function deployed
- [x] Pipeline runs via `run_all.py --broker-backfill` and `--insider` without error

### Frontend Signal Scoring ✅
- [x] 100-point confidence score computed with 5 weighted components
- [x] Indonesian-language narrative generated for all detected patterns
- [x] Phase detection (akumulasi/distribusi/netral) working
- [x] Broker concentration analysis with bandar candidate detection
- [x] All components return per-item explanations for UI tooltips

### UI Integration ✅
- [x] BrokerActivityWidget renders smart money data on stock detail page
- [x] Daily flow chart shows asing/lokal/pemerintah breakdown
- [x] Insider transactions displayed with ownership change percentages

---

## Known Constraints

| Issue | Mitigation |
|---|---|
| Stockbit bearer token expires periodically | `token_manager.py` caches tokens; interactive refresh when expired |
| Stockbit API is undocumented, may change | `raw_json` column in `bandar_signal` preserves full response for debugging |
| Bandar detection relies on Stockbit's algorithm | Multi-level signals (top 1/3/5/10) provide redundancy; frontend also computes concentration-based bandar candidates independently |
| KSEI insider data may have delays | Transactions are stored by `transaction_date` not filing date; stale data is acceptable for 30-day rolling windows |
| PostgREST row cap (1000) truncates broker_flow queries | Batched fetching in `_fetchBrokerFlowBatched()`; date lookups via `bandar_signal` (1 row/date) instead of `broker_flow` (~50 rows/date) |
| Signal confidence is relative, not absolute | Strength labels (Sangat Kuat → Sangat Lemah) help users interpret; narrative provides qualitative context |
| Broker type classification comes from Stockbit | May not be 100% accurate for all brokers; `kandidat_bandar` status is supplemented by concentration analysis |
