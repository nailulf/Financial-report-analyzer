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
| Market phase overlays | `python run_all.py --detect-phases` |
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

### Case 7: Technical Signals (MACD, RSI, Volume)

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

### Case 8: AI Analysis Pipeline

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

### Case 9: Enrichment & Gap Filling

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

### Case 10: Full Pipeline (everything from scratch)

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

### Case 11: Scoping by Ticker / Sector

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

### Case 12: CLI-Only Scrapers (not in run_all.py)

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
| Every trading day (after --daily) | `--detect-phases` | Market phase overlays |
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
