# Data Scraping Playbook

Operational guide for running the IDX Stock Analyzer data pipeline.
All commands assume you are in the `python/` directory with virtualenv active.

```bash
cd python
source venv/bin/activate
```

---

## Prerequisites

### Environment

```bash
cp ../.env.example ../.env   # first time only — fill in credentials
```

| Key | Where to get it | Required? |
|-----|----------------|-----------|
| `SUPABASE_URL` | Supabase → Settings → API | Yes |
| `SUPABASE_SERVICE_KEY` | Supabase → Settings → API → service_role key | Yes |
| `TWELVE_DATA_API_KEY` | twelvedata.com free tier | No (fallback only) |

### Stockbit Token

Stockbit is the **primary** data source for financials, broker flow, and insider data. A bearer token is required.

**Setup / refresh:**
```bash
python -c "from utils.token_manager import get_stockbit_token; get_stockbit_token()"
```
Or just run any Stockbit scraper — you'll be prompted automatically.

**How to get the token:**
1. Open https://stockbit.com in Chrome, log in
2. Open DevTools (F12) → Network tab
3. Click any request → Headers → Authorization
4. Copy the token value (without "Bearer " prefix)

**Token behavior:**
- Cached in `~/.stockbit_token` (not `.env`)
- JWT expiry decoded automatically — warns when expiring
- On 401 → auto-cleared, re-prompted next run
- Lasts ~30 days

---

## Data Sources

| Data type | Source | Notes |
|-----------|--------|-------|
| Financial statements | **Stockbit** (sole source) | keystats + full income/balance/cashflow |
| Price data (OHLCV) | yfinance | `.JK` suffix added internally |
| Foreign flow | **Stockbit** broker_flow (`broker_type='Asing'`) | Confirmed IDR values |
| Broker activity | **Stockbit** marketdetectors API | buy/sell split per broker |
| Bandar signals | **Stockbit** marketdetectors API | accumulation/distribution |
| Insider transactions | **Stockbit** (KSEI data) | Major holder movements |
| Company info | IDX API | profiles, officers, shareholders |
| Dividends | yfinance | Full history |
| Broker summary (legacy) | IDX API | Combined totals only, no buy/sell split |

> `financials.py` (yfinance-based) exists but is **not called** by the pipeline. Stockbit is the sole financials source.

---

## Quick Reference — What to Run When

| Situation | Command |
|-----------|---------|
| End of trading day | `python run_all.py --daily` |
| Weekly stock list refresh | `python run_all.py --weekly` |
| After earnings season | `python run_all.py --quarterly` |
| Everything from scratch | `python run_all.py --full` |
| Single stock test | `python run_all.py --full --ticker BBRI` |
| Broker flow for money-flow page | `python run_all.py --broker-backfill` |
| Insider transactions | `python run_all.py --insider` |
| Market phase overlays (SMA-based) | `python run_all.py --detect-phases` |
| Wyckoff events — v1 flat-pass detector | `python run_all.py --detect-wyckoff` |
| Wyckoff events — v2 FSM detector (**recommended**) | `python run_all.py --detect-wyckoff-v2` |
| Technical signals (MACD/RSI) | `python run_all.py --compute-signals` |
| AI investment thesis | `python run_all.py --ai-full --ticker BBRI` |
| Fix data gaps | `python run_all.py --fill-gaps` |

---

## Detailed Use Cases

### Case 1: Daily Refresh (after market close, ~16:00 WIB)

```bash
python run_all.py --daily
```

**What runs:** daily_prices → money_flow → update_scores → compute_signals

**What it populates:**
- `daily_prices` — OHLCV from yfinance
- `broker_summary` — IDX API broker totals
- `stocks` — completeness/confidence scores
- `technical_signals` + `stocks` — RSI, MACD, volume change

**Follow up with (optional):**
```bash
python run_all.py --detect-phases    # update market phase overlays
```

---

### Case 2: Broker Flow Backfill (for Money Flow page)

The Money Flow page's Foreign Flow Leaderboard uses `broker_flow` data from Stockbit.

```bash
# Default: top 200 stocks by market cap, last 90 trading days
python run_all.py --broker-backfill

# Specific tickers
python run_all.py --broker-backfill --ticker BBRI BMRI BBCA

# Specific number of days
python run_all.py --broker-backfill --backfill-days 30

# All stocks (not just top 200) — pass a limit higher than total stock count
python run_all.py --broker-backfill --batch-limit 900

# Batch processing (for large runs to avoid timeouts)
python run_all.py --broker-backfill --offset 0 --batch-limit 300
python run_all.py --broker-backfill --offset 300 --batch-limit 300
python run_all.py --broker-backfill --offset 600 --batch-limit 300
```

**What it populates:** `broker_flow` (per-broker buy/sell/net in IDR + lots), `bandar_signal`

**Default stock selection:** Top `BROKER_SUMMARY_TOP_N` (200) stocks by market_cap from the `stocks` table. Change in `config.py` to increase permanently.

**Also runs automatically in:** `--full` mode

> **Important:** If the Money Flow page shows few tickers in the leaderboard for a date, it means broker_backfill hasn't run for that date yet. Run `--broker-backfill --backfill-days 1` to fill the latest trading day.

---

### Case 3: Insider Transactions

```bash
# Default: top 200 stocks, 5 pages per ticker
python run_all.py --insider

# Specific ticker with more pages
python run_all.py --insider --ticker BBRI --insider-pages 10

# All stocks
python run_all.py --insider --batch-limit 900

# Batch processing
python run_all.py --insider --offset 0 --batch-limit 200
python run_all.py --insider --offset 200 --batch-limit 200
```

**What it populates:** `insider_transactions` (KSEI major holder movements from Stockbit)

**Not included in:** `--full` mode — must be run standalone.

---

### Case 4: Quarterly Financial Refresh

```bash
# Standard quarterly refresh
python run_all.py --quarterly

# Scoped to a sector
python run_all.py --quarterly --sector finance
python run_all.py --quarterly --sector "barang konsumen"

# With year range
python run_all.py --quarterly --year-from 2020 --year-to 2025

# Single stock
python run_all.py --quarterly --ticker BBRI
```

**What runs:** financials_fallback → company_profiles → document_links → corporate_events → update_scores

**Follow up with:**
```bash
python run_all.py --enrich-ratios    # sync PE/PBV/ROE to stocks table
```

---

### Case 5: Stockbit Financials Only (standalone)

```bash
# Only fill NULL fields (safe, default)
python run_all.py --fallback-financials

# Re-process even if data exists
python run_all.py --fallback-financials --fallback-all

# Preview without writing
python run_all.py --fallback-financials --dry-run

# Specific ticker + year range
python run_all.py --fallback-financials --ticker BBRI --year-from 2015
```

---

### Case 6: Market Phase Detection

```bash
python run_all.py --detect-phases                          # all active tickers
python run_all.py --detect-phases --ticker BBCA BBRI BMRI  # specific tickers
python run_all.py --detect-phases --dry-run                # detect but don't save
```

**What it does:**
1. Fetches ~3 years of daily_prices (OHLCV) per ticker
2. Classifies each day: SMA(20/50) crossover + ATR + volume spikes
3. Merges consecutive same-type days into phases (min 8 days)
4. Enriches with broker_flow, bandar_signal, insider_transactions
5. Scores phase clarity (0-100) and smart money alignment (0-100)
6. Writes to `market_phases` + denormalizes `current_phase` onto `stocks`

**Liquidity filter:** Stocks with avg volume < 100K shares/day are skipped.

**Dependencies:** Requires `daily_prices`. For smart money enrichment, also needs `broker_flow`, `bandar_signal`, `insider_transactions`.

---

### Case 7: Wyckoff Structural Event Detection

**Summary:** Detects classical Wyckoff events (Selling/Buying Climax, Spring,
UTAD, Sign of Strength/Weakness, etc.) on top of price/volume bars. Two
detectors run side-by-side; the chart and screener can show either via a
v1/v2 toggle. **v2 is the default and recommended.**

| Detector | Approach | Strengths | Weaknesses |
|----------|----------|-----------|------------|
| v1 (`--detect-wyckoff`) | Flat-pass: each detector scans all bars, then dedupes | Wider coverage, includes drift detection (`passive_markup`/`passive_markdown`) and effort-vs-result anomalies (`absorption`/`no_demand`/`no_supply`) | More false positives — can fire BC during a continuation rally |
| v2 (`--detect-wyckoff-v2`) | Finite state machine: events fire only from valid Wyckoff phase transitions, candidate-then-confirm lifecycle, asymmetric lockout | Structurally honest — every event passed an FSM gauntlet. Includes soft entries (`basis_building`/`topping_action`) and trend exhaustion (`markup_exhaustion`/`markdown_exhaustion`) for stocks without textbook climaxes | Fewer events — produces 0 events on truly choppy charts (which is correct, but UX can feel sparse) |

The two detectors write to **separate denorm columns** on the `stocks`
table (`current_wyckoff_*` for v1, `current_wyckoff_*_v2` for v2). Filters
on the screener target one or the other — they never conflict.

#### Run v1 (flat-pass detector)

```bash
python run_all.py --detect-wyckoff                          # all active tickers
python run_all.py --detect-wyckoff --ticker BBCA BBRI BMRI  # specific tickers
python run_all.py --detect-wyckoff --dry-run                # detect but don't save
```

**What it does:**
1. Fetches ~2 years of daily price/volume history per ticker
2. Six independent passes over all bars, each producing candidate events:
   - **Climax detection** (SC/BC) — single-bar climactic + AR follow-through confirmation
   - **Spring/UTAD detection** — pierce + reclaim within 3 bars
   - **Secondary tests** — low-volume retests of climax extremes
   - **SOS/SOW detection** — wide-range breakout/breakdown with expanding volume
   - **LPS/LPSY detection** — pullback after SOS/SOW on declining volume
   - **Effort vs Result** — absorption, no_demand, no_supply
   - **Passive drift** — `passive_markup` / `passive_markdown` for slow trends without climactic events
3. Deduplicates `(date, type)` collisions, suppresses near-duplicate climaxes (30-bar window)
4. Writes events to `wyckoff_events` table with `detection_version='1.0'`
5. Denormalizes latest event onto `stocks.current_wyckoff_event*` columns

**Output: typically 10-18 events per ticker over a 2-year window.**

#### Run v2 (FSM detector — recommended)

```bash
python run_all.py --detect-wyckoff-v2                          # all active tickers
python run_all.py --detect-wyckoff-v2 --ticker BBCA BBRI BMRI  # specific tickers
python run_all.py --detect-wyckoff-v2 --dry-run                # detect but don't save
```

**What it does:**
1. Fetches ~2 years of daily price/volume history per ticker
2. Streams bars through a 12-state finite state machine:
   - `UNKNOWN → DOWNTREND → ACCUM_A → ACCUM_B → ACCUM_C → ACCUM_D → MARKUP → UPTREND → DISTR_A → DISTR_B → DISTR_C → DISTR_D → MARKDOWN → ...`
3. Climax detection paths:
   - **Single-bar climax** — wide spread + climactic volume + close-position + trend confirmation
   - **3-bar cluster** (`CLIMACTIC_CLUSTER`) — gradual climax over 3 days
   - **15-bar absorption regime** (`ABSORPTION_REGIME`) — distributed climax pattern
4. Soft phase A entry when no textbook climax fires:
   - `BASIS_BUILDING` — soft accumulation entry from DOWNTREND (confidence 50%)
   - `TOPPING_ACTION` — soft distribution entry from MARKUP/UPTREND
5. Trend-driven phase exit when ranges roll over without classical events:
   - `markup_exhaustion` / `markdown_exhaustion` — slope reversal + 30% retracement
   - `range_breakout_up` / `range_breakout_down` — Phase B exits without Spring/UTAD
   - `distr_failed` / `accum_failed` — range failed in opposite direction
6. **Candidate-then-confirm lifecycle:** climax bars set a *candidate* silently; only emit BC/SC after 5+ bars of distribution/accumulation character. Any close above BC.high (or below SC.low) within 10 bars invalidates without recording an event.
7. **Asymmetric lockout:** `HARD_LOCKOUT_BARS=80` after CONFIRMED climax (trend presumed over), `SOFT_LOCKOUT_BARS=20` after INVALIDATED candidate (algorithm working correctly, only block re-trigger on the same cluster).
8. Writes events to `wyckoff_events` table with `detection_version='2.0'`
9. Denormalizes latest event + final FSM phase onto `stocks.current_wyckoff_*_v2` columns (including the fine-grained FSM phase like `accumulation_c`)

**Output: typically 4-8 events per ticker over a 2-year window — fewer but each is structurally validated.**

#### When to use which

| Use case | Recommended |
|----------|-------------|
| Default screener filtering / chart display | v2 |
| "What kind of structure is this stock in?" | v2 (use FSM phase like `accumulation_c`) |
| Cast a wider net — find stocks with ANY signal | v1 |
| Detect slow drift periods (passive markup/markdown) | v1 (v2 doesn't have these) |
| Bar-level effort/result context (absorption, no_demand) | v1 (v2 doesn't have these) |
| Trade triggers with low false positive rate | v2 |

Both can be run on the same ticker — they coexist via the `detection_version` column. The frontend chart toggle (`v1` / `v2` badge in the FASE PASAR widget) flips between their outputs. Likewise the screener filter row has a v1/v2 sub-toggle.

#### Schema requirements

Both detectors require the `wyckoff_events` table CHECK constraint to allow all current event types. Apply this once before running:

```bash
# In Supabase SQL editor — idempotent, safe to re-run
docs/schema-wyckoff-event-types-current.sql
```

Plus the v2 FSM detector requires the v2 denorm columns on `stocks`:

```bash
docs/schema-v25-wyckoff-v2.sql
```

#### Diagnostic

When a ticker produces unexpected results, trace the FSM bar-by-bar:

```bash
python -m scripts.analysis.wyckoff_v2_diagnostic DEWA --transitions-only
python -m scripts.analysis.wyckoff_v2_diagnostic BBRI                 # full trace
python -m scripts.analysis.wyckoff_v2_diagnostic AVIA --since 2025-09-01
```

When no events fire at all, the diagnostic surfaces the "best near-miss" climactic bar with its vol_z / spread_atr / close_position values.

**Auto-runs in:** Neither v1 nor v2 is included in `--full`. Run standalone after `--daily` or `--detect-phases`.

**Dependencies:** Requires `daily_prices` with at least 60 trading days per ticker (warm-up window for rolling stats).

---

### Case 8: Technical Signals (MACD, RSI, Volume)

```bash
python run_all.py --compute-signals                          # all active tickers
python run_all.py --compute-signals --ticker BBCA BBRI BMRI  # specific tickers
python run_all.py --compute-signals --dry-run                # compute but don't save
```

**What it computes:**
- **RSI (14-period)** — Wilder's smoothed relative strength index
- **MACD (5, 20, 9)** — line, signal, histogram + golden/death cross detection
- **Volume change** — current volume vs 20-day SMA (percentage)

**What it writes:**
- `technical_signals` table — one row per ticker per day
- `stocks` table (denormalized) — `rsi_14`, `macd_histogram`, `macd_cross_signal`, `macd_cross_days_ago`, `volume_change_pct`, `volume_avg_20d`

**Auto-runs in:** `--daily` and `--full`

**Dependencies:** Requires `daily_prices` with at least 50 trading days per ticker.

---

### Case 9: AI Analysis Pipeline

```bash
# Build context only (no LLM calls, no cost)
python run_all.py --build-ai-context
python run_all.py --build-ai-context --ticker BBRI

# Generate investment thesis (costs LLM tokens)
python run_all.py --run-ai-analysis
python run_all.py --run-ai-analysis --ai-provider anthropic
python run_all.py --run-ai-analysis --ai-model claude-sonnet-4
python run_all.py --run-ai-analysis --min-composite 60  # only high-quality stocks

# Both context + analysis in one command
python run_all.py --ai-full
python run_all.py --ai-full --ticker BBRI --ai-provider anthropic
```

**Context pipeline (4 stages):** data_cleaner → data_normalizer → scoring_engine → context_builder

**Tables:** `data_quality_flags`, `normalized_metrics`, `stock_scores`, `ai_context_cache`, `ai_analysis`

---

### Case 10: Enrichment & Gap Filling

#### Fill NULL ratio columns (no API calls, safe anytime)
```bash
python run_all.py --enrich-ratios
python run_all.py --enrich-ratios --ticker BBRI
python run_all.py --enrich-ratios --dry-run
```

#### Fetch dividend history
```bash
python run_all.py --dividends
python run_all.py --dividends --ticker BBRI TLKM
```

#### Auto-fix low-completeness stocks
```bash
python run_all.py --fill-gaps                              # top 100 most incomplete (default)
python run_all.py --fill-gaps --min-score 50               # only stocks scoring < 50
python run_all.py --fill-gaps --gap-limit 20               # process 20 stocks
python run_all.py --fill-gaps --gap-category ratios prices # specific gap types only
python run_all.py --fill-gaps --dry-run                    # detect gaps, no writes
```

Gap categories: `prices`, `financials_annual`, `financials_quarterly`, `ratios`, `profile`, `officers`, `shareholders`, `dividends`

---

### Case 11: Full Pipeline (everything from scratch)

```bash
python run_all.py --full
python run_all.py --full --ticker BBRI   # single stock test
```

**Execution order:**
```
 1. stock_universe        → stocks
 2. financials_fallback   → financials (Stockbit)
 3. company_profiles      → profiles, officers, shareholders
 4. document_links        → document_links (non-fatal)
 5. corporate_events      → corporate_events (non-fatal)
 6. daily_prices          → daily_prices (OHLCV)
 7. money_flow            → broker_summary (IDX API)
 8. broker_backfill       → broker_flow, bandar_signal (Stockbit, last 90 days)
 9. update_scores         → stocks (completeness_score, confidence_score)
10. enrich_ratios         → stocks (PE, PBV, ROE, net_margin, dividend_yield)
11. detect_phases         → market_phases, stocks (current_phase)
12. compute_signals       → technical_signals, stocks (rsi_14, macd_*, volume_*)
13. ai_context_pipeline   → data_quality → normalized → scores → ai_context_cache
14. ai_analysis           → ai_analysis (LLM investment thesis)
```

---

### Case 12: Scoping by Ticker / Sector

**Single or multiple tickers:**
```bash
python run_all.py --daily --ticker BBRI
python run_all.py --daily --ticker BBRI ASII BBCA
python run_all.py --full --ticker BBRI
```

**By sector:**
```bash
python run_all.py --quarterly --sector finance
python run_all.py --daily --sector energy
python run_all.py --fallback-financials --sector "barang konsumen"
python run_all.py --daily --sector healthcare technology   # multiple sectors
```

Sector matching is case-insensitive and supports partial names (e.g. "finance" → "Financials").

---

### Case 13: CLI-Only Scrapers (not in run_all.py)

#### Shareholders PDF import
```bash
python -m scrapers.shareholders_pdf --file ./data/shareholders.pdf --date 2025-12-31
python -m scrapers.shareholders_pdf --file ./data/holders.xlsx --date 2025-12-31 --dry-run
```

#### yfinance financials (secondary source, fills gaps)
```bash
python -m scrapers.financials --ticker BBRI
python -m scrapers.financials --ticker BBRI --period annual
```

---

## Running Individual Scrapers Directly

If `run_all.py` is overkill and you only need one scraper:

```bash
# Stock universe (IDX API)
python -m scrapers.stock_universe
python -m scrapers.stock_universe --ticker BBRI

# Prices (yfinance)
python -m scrapers.daily_prices
python -m scrapers.daily_prices --ticker BBRI ASII
python -m scrapers.daily_prices --full                   # force full history re-fetch

# Financials (Stockbit — primary)
python -m scrapers.financials_fallback
python -m scrapers.financials_fallback --ticker BBRI
python -m scrapers.financials_fallback --dry-run
python -m scrapers.financials_fallback --all             # re-process even if data exists

# Money flow (IDX API — value + frequency only)
python -m scrapers.money_flow
python -m scrapers.money_flow --ticker BBRI
python -m scrapers.money_flow --days 5
python -m scrapers.money_flow --date 2026-03-14

# Broker flow + bandar (Stockbit)
python -m scrapers.money_flow --broker-backfill 30

# Insider transactions (Stockbit / KSEI)
python -m scrapers.money_flow --insider
python -m scrapers.money_flow --insider --ticker BBRI

# Company profiles (IDX API)
python -m scrapers.company_profiles
python -m scrapers.company_profiles --ticker BBRI

# Document links & corporate events (IDX API)
python -m scrapers.document_links
python -m scrapers.corporate_events

# Ratio enrichment (DB only, no API calls)
python -m scrapers.ratio_enricher
python -m scrapers.ratio_enricher --ticker BBRI ASII
python -m scrapers.ratio_enricher --dry-run

# Dividends (yfinance)
python -m scrapers.dividend_scraper
python -m scrapers.dividend_scraper --ticker BBRI TLKM

# Gap filler (meta-scraper)
python -m scrapers.gap_filler --dry-run
python -m scrapers.gap_filler --category ratios

# Analysis modules (via run_all.py only)
python run_all.py --detect-phases
python run_all.py --detect-phases --ticker BBRI
python run_all.py --compute-signals
python run_all.py --compute-signals --ticker BBRI
```

---

## Refresh Job Tracking

When running for a single ticker, `run_all.py` auto-detects pending `stock_refresh_requests` jobs from the UI:

```bash
python run_all.py --full --ticker BBRI          # auto-detects pending job
python run_all.py --full --ticker BBRI --job-id 42   # explicit job ID
```

**Flow:** detects pending job → sets `running` → each scraper reports to `refresh_scraper_progress` → on completion writes after-scores → marks `completed` or `failed`

---

## Recommended Cadence

| Frequency | Command | What it does |
|-----------|---------|-------------|
| Every trading day (after 16:00 WIB) | `--daily` | Prices + value/frequency + technical signals |
| Every trading day (after --daily) | `--detect-phases` | Market phase overlays (SMA-based) |
| Every trading day (after --daily) | `--detect-wyckoff-v2` | Wyckoff structural events (FSM, recommended) |
| Weekly (optional) | `--detect-wyckoff` | v1 flat-pass — adds drift / effort-result events |
| Weekly (Sunday) | `--weekly` | Refresh stock universe from IDX |
| Weekly or bi-weekly | `--broker-backfill --backfill-days 7` | Keep money flow leaderboard fresh |
| After each earnings season | `--quarterly` then `--enrich-ratios` | Financials + screener sync |
| Monthly | `--dividends` | Dividend history from yfinance |
| Monthly | `--broker-backfill` | Full 90-day broker flow refresh |
| Monthly | `--insider` | KSEI insider transactions |
| Quarterly (after financials) | `--ai-full` | Regenerate AI investment theses |
| As needed | `--fill-gaps --gap-limit 50` | Fix incomplete stocks |

---

## Config Defaults (`python/config.py`)

| Setting | Default | What it controls |
|---------|---------|-----------------|
| `BROKER_SUMMARY_TOP_N` | 200 | Max stocks for `--broker-backfill` / `--insider` when no `--ticker` given |
| `DAILY_PRICE_HISTORY_YEARS` | 5 | Bootstrap price history on first run |
| `YFINANCE_BATCH_SIZE` | 100 | Tickers per yfinance bulk download |
| `RATE_LIMIT_IDX_SECONDS` | 0.6 | Delay between IDX API requests (~1.6 req/s) |
| `RATE_LIMIT_STOCKBIT_SECONDS` | 0.8 | Delay between Stockbit API requests |

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Missing required environment variable` | `.env` not loaded | Check `.env` file exists with Supabase credentials |
| `No active stocks found` | `stocks` table empty | Run `--weekly` first |
| IDX API returns 403 / empty | Rate limited | Wait a few minutes, retry |
| Stockbit "token required" prompt | No token or expired | Paste fresh token from browser DevTools |
| Stockbit 401 mid-run | Token expired during run | Auto-cleared — re-run and paste new token |
| Money Flow page shows few tickers | `broker_backfill` incomplete for that date | Run `--broker-backfill --backfill-days 1` |
| Money Flow page shows no data | No `broker_flow` data for the date range | Run `--broker-backfill` |
| Scores not updating | Scores auto-recalculate per mode | Run `--enrich-ratios` to force |
| Run interrupted | Ctrl+C or crash | Safe to re-run — all scrapers use upsert |
| Phase detection skips a stock | Avg volume < 100K shares/day | Liquidity filter — by design |
| Technical signals skips a stock | < 50 trading days of data | Need more price history |
| `--detect-wyckoff*` fails with `event_type_check` violation | Schema CHECK constraint outdated | Apply [docs/schema-wyckoff-event-types-current.sql](schema-wyckoff-event-types-current.sql) in Supabase SQL editor |
| Wyckoff v2 produces 0 events on a ticker | Choppy chart with no structural cycle (correct behavior) | Run diagnostic: `python -m scripts.analysis.wyckoff_v2_diagnostic TICKER`; check the "best near-miss" output |
| Screener Wyckoff column is empty | Detection hasn't run yet, or denorm columns missing | Run `--detect-wyckoff-v2`; ensure schema-v25 migration applied |

---

## Key Facts

- **Stockbit is the sole financial data source.** `financials.py` (yfinance) exists but is not in the pipeline.
- **Foreign flow comes from `broker_flow`** (Stockbit, `broker_type='Asing'`), not from `daily_prices`. The IDX API foreign flow fields were removed (unreliable data, unknown units).
- Token is in `~/.stockbit_token` (not `.env`). Managed automatically.
- Tickers stored **without** `.JK` suffix. Added internally when calling yfinance.
- All monetary values: **IDR as BIGINT**. Ratios stored as **15.5**, not 0.155.
- `quarter=0` = annual data; `quarter=1-4` = quarterly.
- `ratio_enricher` and `--compute-signals` make **no API calls** — safe to run anytime.
- `gap_filler` is the "fix everything" meta-scraper — detects gaps and calls the right scrapers.
- `--broker-backfill` defaults to top 200 by market cap. Use `--batch-limit 900` for all stocks.
- `--insider` is **not included** in `--full` — run standalone.
- `--detect-phases` and `--compute-signals` make no API calls — pure DB computation.
- `--ai-full` = `--build-ai-context` (free) + `--run-ai-analysis` (costs LLM tokens).
- **Wyckoff v1 and v2 coexist.** Both write to `wyckoff_events` with their own `detection_version` ('1.0' / '2.0'); they denormalize to separate columns (`current_wyckoff_*` vs `current_wyckoff_*_v2`) and never overwrite each other. v2 is recommended.
- **Wyckoff schema migrations are required.** Apply [docs/schema-wyckoff-event-types-current.sql](schema-wyckoff-event-types-current.sql) and [docs/schema-v25-wyckoff-v2.sql](schema-v25-wyckoff-v2.sql) before running either detector.
- **Wyckoff is not in `--full`.** Run `--detect-wyckoff-v2` standalone after the daily pipeline. v1 is also separate.
