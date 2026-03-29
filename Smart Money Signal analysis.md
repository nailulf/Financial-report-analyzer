# Smart Money Signal — Functional Requirements Document

**Version:** 3.0
**Status:** Implemented
**Last Updated:** March 28, 2026

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

### Step 1 — Bandar Identification (3-Layer Algorithm, v3.0)

**Original plan (v1):** Manual heuristic — broker with >15% volume over 6 months, manually reviewed.

**v2 implementation:** Simple rule: `concentration >= 10% AND type !== 'asing'`. Proven inadequate via 85-stock backtest — generates false positives (UBS/Maybank flagged everywhere) and misses real bandars (Henan Putihrai in PTRO, Buana Capital in BUKA).

**Current implementation (v3):** 3-layer algorithm in `getBrokerConcentration()` (`web/src/lib/queries/broker.ts`), backtested across 85 IDX stocks (Oct 2025–Mar 2026). Correctly identified 27 real bandar candidates while filtering 12 false positives.

#### Constants (`web/src/lib/broker-constants.ts`)

**Platform Brokers** (excluded from bandar candidacy — aggregated retail orders, not institutional):
```
CC (Mandiri/MOST), YP (Mirae Asset), XL (Stockbit), XC (Ajaib), PD (Indo Premier/IPOT)
```

**Broker Names**: Full 90-broker IDX member directory mapping code → name (e.g., `AK → UBS`, `ZP → Maybank`, `HP → Henan Putihrai`).

#### Layer 1 — Concentration + Directional Consistency

For each non-platform broker, compute:
- `concentration_pct` = broker volume (buy + sell) / total stock volume × 100
- `dir_pct` = max(buy_days, sell_days) / active_days × 100
- Requires `active_days >= 5` to avoid noise from sporadic trades

| Tier | Concentration | Consistency | Meaning |
|------|--------------|-------------|---------|
| **A** | ≥ 8% | ≥ 65% | Strong signal — high volume, directionally committed |
| **A2** | ≥ 5% | ≥ 70% | Moderate volume but very consistent direction |
| **B** | ≥ 3% | ≥ 75% | Lower volume but extremely persistent direction |

Platform brokers (CC, YP, XL, XC, PD) never receive a tier.

#### Layer 2 — Stock-Specificity

Only computed for brokers that pass Layer 1. Answers: "Is this broker unusually focused on THIS stock, or does it behave the same everywhere?"

```
broker_vol_this_stock = buy + sell in this stock over N days
broker_avg_vol_per_stock = total volume across ALL stocks / number of stocks traded
specificity = broker_vol_this_stock / broker_avg_vol_per_stock
```

Implemented via `_getBrokerGlobalStats()` — queries `broker_flow` across all tickers for each tier-qualifying broker code, batched by broker to stay within PostgREST row cap.

| Specificity | Label | Meaning |
|-------------|-------|---------|
| ≥ 3.0x | **SPECIFIC** | Broker puts 3x+ more money here than its average — targeting this stock |
| ≥ 1.5x | **ELEVATED** | Above average, worth watching |
| < 1.5x | **UBIQ** | Normal behavior — broker is big everywhere (likely false positive) |

**Key insight from backtest:** UBS (AK) appears at 8-14% concentration in most stocks with ~1.0x specificity (UBIQ) — it's just a large broker, not a bandar. Henan Putihrai (HP) at 5.2% in PTRO but 4.5x specificity — genuinely targeting PTRO.

#### Layer 3 — Counter-Retail (soft signal)

```
platform_net = SUM(net_value) for CC, YP, XL, XC, PD
counter_retail = (platform_net < 0 AND broker_net > 0) OR (platform_net > 0 AND broker_net < 0)
```

Not a gate — adds context. When a broker accumulates while retail platforms sell, it's the "bandar tampung jatuhan retail" pattern observed in IDX community analysis.

#### Final Classification

```
if is_platform → status = 'retail', no tier
if tier != null AND specificity_label != 'UBIQ' → status = 'kandidat_bandar'
if broker_type == 'Asing' AND not kandidat_bandar → status = 'asing'
else → status = 'retail'
```

Additionally, brokers with concentration ≥ 15% get a **"Big Player"** visual highlight regardless of tier — big money can't hide even without directional consistency.

#### Backtest Results (85 stocks, Oct 2025–Mar 2026)

Real bandar candidates confirmed:
- HP (Henan Putihrai) in PTRO: 5.2% conc, 80% dir, 4.5x SPECIFIC, counter-retail
- RF (Buana Capital) in BUKA: 6.2% conc, 71% dir, 6.1x SPECIFIC, counter-retail
- KI (Ciptadana) in CMNT: 19.7% conc, 80% dir, 10.5x SPECIFIC
- SS (Supra) in MORA: 33.0% conc, 90% dir, 10.9x SPECIFIC
- RB (INA Sekuritas) in INTP: 17.0% conc, 91% dir, 3.6x SPECIFIC

False positives correctly filtered:
- AK (UBS) in BBNI/NISP/TAPG/ITMG: 8-11% conc but 1.0-1.4x UBIQ (appears in 81 stocks)
- ZP (Maybank) in AKRA/SCMA: 8-9% conc but 1.3x UBIQ (appears in 82 stocks)

#### Supplementary: Stockbit Bandar Detector Signals

Stockbit pre-computes acc/dist signals at 4 concentration levels (stored in `bandar_signal` table):
- `broker_accdist`: Overall signal (e.g., "Big Acc", "Acc", "Normal Acc", "Dist", "Big Dist")
- `top1/3/5/10_accdist`: Per concentration level

These are used by the Bandar Confirmation component in confidence scoring (20 pts max) but are NOT the primary bandar identification mechanism (that's the 3-layer algorithm above).

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
| **Broker Concentration** | 15 | Top 3 non-platform brokers: concentration, tier, specificity, counter-retail bonuses |

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

### Step 6 — Narrative Generation (rule-based + bandar context)

Implemented in `signal-confidence.ts` → `generateNarrative()`.

Pattern-based system that detects money-flow patterns and describes what is happening in Indonesian. **v3.0 enrichment:** narratives are now augmented with bandar detection context from the 3-layer algorithm via `extractBandarContext()`.

#### Base Patterns (ordered by specificity):

| Pattern | Conclusion |
|---------|-----------|
| All actors neutral | "Tidak ada pergerakan signifikan" |
| All actors neutral + bandar accumulating | "Pasar sepi, tapi bandar aktif akumulasi" |
| All actors neutral + bandar distributing | "Pasar sepi, tapi bandar aktif distribusi" |
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

#### Bandar Context Enrichment (v3.0)

After pattern detection, the narrative is enriched with bandar candidate data:

- **Strong unidirectional bandar** (SPECIFIC + tier A/A2, only accumulators or only distributors):
  Conclusion is **prepended** → `"Bandar BRI Danareksa akumulasi (counter-retail) — waspada jika tekanan asing berlanjut"`
- **Weaker bandar** (tier B or ELEVATED):
  Conclusion is **appended** → `"Waspada jika tekanan asing berlanjut. Bandar BRI Danareksa akumulasi"`
- **Mixed bandar** (both accumulators and distributors detected):
  Context is **appended** → `"Sinyal awal. Bandar campuran: BRI Danareksa akumulasi, OCBC distribusi"`

Tooltip detail always includes full bandar breakdown: broker code, name, concentration %, specificity ratio, and counter-retail flag.

Each narrative also includes insider activity suffix when data is available (e.g., "Insider: 2 BUY, 1 SELL").

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

- `days` parameter: max 200 (increased from 90 in v3.0)
- All data is fetched server-side via Supabase server client (service key stays server-side only)

### Constants Module: `web/src/lib/broker-constants.ts` (v3.0)

- `PLATFORM_BROKERS: Set<string>` — CC, YP, XL, XC, PD
- `BROKER_NAMES: Record<string, string>` — 90 IDX broker codes → short names

### Query Module: `web/src/lib/queries/broker.ts`

Key exported functions:
- `getSmartMoneyData(ticker, days)` — combines all queries below into one response
- `getStockBrokerSummary(ticker, days)` — top buyers/sellers/net, with bandar signal
- `getDailyBrokerFlowByType(ticker, days)` — daily asing/lokal/pemerintah flow for charts
- `getBrokerConcentration(ticker, days)` — **v3.0: 3-layer algorithm** returning top 20 brokers with tier, specificity, counter-retail, avg price, net lot
- `_getBrokerGlobalStats(brokerCodes, dates)` — **v3.0: cross-stock specificity** query for Layer 2
- `getBandarSignal(ticker, date)` — latest bandar_signal row
- `getInsiderTransactions(ticker, limit)` — recent major holder transactions

**v3.0 `BrokerConcentrationRow` fields:**
```typescript
{
  broker_code, broker_name, broker_type,
  total_buy_value, total_sell_value, total_net_value,
  concentration_pct,
  // Layer 1
  buy_days, sell_days, active_days, dir_pct, net_direction, tier,
  // Layer 2
  specificity, specificity_label,
  // Layer 3
  counter_retail,
  // VWAP & position size
  net_lot, avg_buy_price, avg_sell_price,
  // Classification
  is_platform, status
}
```

### Calculation Module: `web/src/lib/calculations/signal-confidence.ts`

Key exported functions:
- `computeConfidence(input)` → `ConfidenceScore` (total 0–100, per-component scores + explanations)
- `generateNarrative(input)` → `Narrative` (conclusion + detail in Indonesian, enriched with bandar context)
- `extractBandarContext(concentration)` → **v3.0:** extracts accumulators/distributors from concentration data for narrative enrichment

**v3.0 Broker Concentration scoring changes:**
- Filters out platform brokers from top 3
- Tier bonus: A(+3), A2(+2), B(+1) — replaces flat +2 for kandidat_bandar
- Specificity bonus: SPECIFIC(+2), ELEVATED(+1)
- Counter-retail bonus: +1
- All capped at 15 points

### UI Widget: `BrokerActivityWidget.tsx`

Located at `web/src/components/stock/widgets/BrokerActivityWidget.tsx`. Renders:

**Summary Cards:**
- Net flow, net asing, insider filing, combined signal with confidence score

**Tab 1 — Aliran Broker Harian:**
- Diverging stacked bar chart (BUMN/Asing/Retail) with price overlay
- **v3.0:** Auto-aggregates to weekly buckets when >90 data points (keeps bars readable at 120D/200D)

**Tab 2 — Kumulatif Net Flow:**
- Line chart showing cumulative asing/lokal/pemerintah flow over time

**Tab 3 — Identifikasi Broker Bandar (v3.0 redesign):**
- 10-column table: Broker (code+name), Net Flow, Avg Price (buy/sell VWAP), Net Lot (position size in lots + shares), Konsentrasi%, Konsistensi% (with buy/sell/total day breakdown), Tier (A/A2/B badge), Spesifisitas (ratio + SPECIFIC/ELEVATED/UBIQ), Counter-Retail (CR flag), Status
- Platform brokers shown at 50% opacity with "(Platform)" label
- Brokers with ≥15% concentration get amber "Big Player" highlight
- Column headers have instant CSS tooltips explaining each metric
- Expandable "Selengkapnya" explanation box with threshold details

**Tab 4 — Insider Filings:**
- Recent KSEI major holder transactions with ownership changes

**Duration Presets:** 10D, 20D, 30D, 60D, 90D, 120D, 200D (expanded from 10-60D in v3.0)

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

### 3-Layer Bandar Detection (v3.0) ✅
- [x] Layer 1: Concentration + directional consistency → tier A/A2/B
- [x] Layer 2: Stock-specificity via cross-stock global volume comparison
- [x] Layer 3: Counter-retail signal (platform broker direction opposition)
- [x] Platform broker exclusion (CC, YP, XL, XC, PD)
- [x] Broker name mapping (90 IDX brokers)
- [x] Big Player highlight for ≥15% concentration
- [x] VWAP per broker (avg buy/sell price from lot data)
- [x] Net lot tracking (position size accumulated/distributed)
- [x] Narrative enrichment with bandar context
- [x] Backtested across 85 stocks (Oct 2025–Mar 2026)

### UI Integration ✅
- [x] BrokerActivityWidget renders smart money data on stock detail page
- [x] Daily flow chart shows asing/lokal/pemerintah breakdown
- [x] Weekly aggregation for >90 day ranges
- [x] Insider transactions displayed with ownership change percentages
- [x] Duration presets extended to 200D
- [x] Broker identification table with 10 columns + tooltips
- [x] Expandable explanation box with threshold documentation

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
| Broker type classification comes from Stockbit | May not be 100% accurate for all brokers; `kandidat_bandar` status uses 3-layer algorithm independent of Stockbit's type field |
| Layer 2 specificity requires cross-stock queries | Adds 1-3 extra Supabase round-trips per tier-qualifying broker; only executed for brokers passing Layer 1 (typically 3-8) |
| VWAP uses lot-based calculation (1 lot = 100 shares) | `avg_price = total_value / (total_lot × 100)`; slight rounding vs Stockbit's `buy_avg_price` field |
| 200D duration creates dense charts | Auto-aggregation to weekly bars when >90 data points; cumulative chart unaffected |
| Platform broker list is hardcoded (5 brokers) | Defined in `web/src/lib/broker-constants.ts`; may need updating if IDX retail landscape changes |
