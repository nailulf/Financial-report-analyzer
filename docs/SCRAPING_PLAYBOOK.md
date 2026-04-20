# Data Scraping Playbook

Operational guide for running the IDX Stock Analyzer data pipeline.

---

## Prerequisites

```bash
cd python
source venv/bin/activate        # activate virtualenv
cp ../.env.example ../.env      # first time only — fill in Supabase credentials
```

Required `.env` values:
| Key | Where to get it |
|-----|----------------|
| `SUPABASE_URL` | Supabase project → Settings → API |
| `SUPABASE_SERVICE_KEY` | Supabase project → Settings → API → service_role key |
| `TWELVE_DATA_API_KEY` | Optional. twelvedata.com free tier — used as fallback only |

> **Stockbit token** is no longer stored in `.env`. It's managed interactively — see below.

---

## Stockbit Token Setup

Stockbit is the **primary** financial data source. A bearer token is required for full statement endpoints (income, balance sheet, cash flow) and broker/insider data. Public endpoints (ratios, keystats) work without a token.

**First time / token expired:**
```bash
cd python
python -c "from utils.token_manager import get_stockbit_token; get_stockbit_token()"
```
Or just run any scraper — you'll be prompted automatically:

```
┌─────────────────────────────────────────────────────────────┐
│             Stockbit Bearer Token Required                  │
├─────────────────────────────────────────────────────────────┤
│  1. Open  https://stockbit.com  in Chrome                   │
│  2. Log in to your account                                  │
│  3. Open DevTools  (F12 / Cmd+Opt+I)                        │
│  4. Go to  Network  tab                                     │
│  5. Click any request → Headers → Authorization             │
│  6. Copy the token value  (without "Bearer " prefix)        │
└─────────────────────────────────────────────────────────────┘

Paste token: <paste here>
```

**How it works:**
- Token is cached in `~/.stockbit_token` (file, not .env)
- JWT expiry is decoded automatically — you're warned when it's about to expire
- On 401 errors, the cached token is cleared and you're re-prompted next run
- Token lasts ~30 days before needing refresh
- Backward compat: `STOCKBIT_BEARER_TOKEN` in `.env` still works (auto-migrated to file)

---

## Data Source Hierarchy

```
Financial data:  Stockbit (primary, sole source in pipeline)
Price data:      yfinance
Money flow:      IDX API (foreign flow), Stockbit (broker flow, bandar signals)
Insider data:    Stockbit (KSEI major holder movements)
Company info:    IDX API
Dividends:       yfinance
```

When `--quarterly` or `--full` runs:
1. **Stockbit** fetches all financials (keystats + full statements)
2. **company_profiles** fetches company info, officers, shareholders from IDX API
3. **document_links** + **corporate_events** fetch supplementary data from IDX API

> **Note:** `financials.py` (yfinance-based) exists in the codebase but is **not called** by the pipeline. Stockbit is the sole financials source.

---

## The Scrapers

### Pipeline scrapers (managed by `run_all.py`)

| Scraper | Table(s) populated | Source | Run mode |
|---------|-------------------|--------|----------|
| `stock_universe` | `stocks` | IDX API | `--weekly`, `--full` |
| `daily_prices` | `daily_prices` (OHLCV) | yfinance | `--daily`, `--full` |
| `money_flow` | `daily_prices` (foreign flow), `broker_summary` | IDX API | `--daily`, `--full` |
| `financials_fallback` | `financials` (annual + quarterly) | **Stockbit** | `--quarterly`, `--full`, `--fallback-financials` |
| `company_profiles` | `company_profiles`, `company_officers`, `shareholders` | IDX API | `--quarterly`, `--full` |
| `document_links` | `document_links` | IDX API | `--quarterly`, `--full` (non-fatal) |
| `corporate_events` | `corporate_events` | IDX API | `--quarterly`, `--full` (non-fatal) |
| `ratio_enricher` | `financials` + `stocks` (screener ratios) | DB only (no API) | `--enrich-ratios`, `--full` |
| `dividend_scraper` | `dividend_history` | yfinance | `--dividends` |
| `gap_filler` | various (re-runs targeted scrapers) | various | `--fill-gaps` |
| `broker_backfill` | `broker_flow`, `bandar_signal` | Stockbit | `--broker-backfill`, `--full` |
| `insider` | `insider_transactions` | Stockbit (KSEI) | `--insider` |

### Analysis & AI pipeline (managed by `run_all.py`)

| Module | Table(s) populated | Source | Run mode |
|--------|-------------------|--------|----------|
| `market_phase_detector` | `market_phases`, `stocks` (current_phase) | DB only (price + broker data) | `--detect-phases`, runs after `--daily` chain |
| `data_cleaner` | `data_quality_flags` | DB only | `--build-ai-context`, `--ai-full` |
| `data_normalizer` | `normalized_metrics` | DB only | `--build-ai-context`, `--ai-full` |
| `scoring_engine` | `stock_scores` | DB only | `--build-ai-context`, `--ai-full` |
| `context_builder` | `ai_context_cache` | DB only | `--build-ai-context`, `--ai-full` |
| `ai_analyst` | `ai_analysis` | OpenAI / Anthropic | `--run-ai-analysis`, `--ai-full` |

### CLI-only scrapers (NOT in `run_all.py`, run manually)

| Scraper | Table(s) populated | Source | How to run |
|---------|-------------------|--------|------------|
| `shareholders_pdf` | `shareholders_major` | Local PDF/Excel/CSV | `python -m scrapers.shareholders_pdf --file <path> --date <YYYY-MM-DD>` |
| `financials` | `financials` (fills gaps) | yfinance | `python -m scrapers.financials --ticker BBRI` |

---

## Pipeline Execution Order

### `--full` (everything, dependency order)

```
 1. stock_universe        → stocks table
 2. financials_fallback   → financials table (Stockbit)
 3. company_profiles      → company_profiles, company_officers, shareholders
 4. document_links        → document_links (non-fatal if table missing)
 5. corporate_events      → corporate_events (non-fatal if table missing)
 6. daily_prices          → daily_prices (OHLCV)
 7. money_flow            → daily_prices (foreign flow) + broker_summary
 8. broker_backfill       → broker_flow, bandar_signal (Stockbit, last 90 days)
 9. update_scores         → stocks (completeness_score, confidence_score)
10. enrich_ratios         → stocks (PE, PBV, ROE, net_margin, dividend_yield)
11. ai_context_pipeline   → data_quality_flags → normalized_metrics → stock_scores → ai_context_cache
12. ai_analysis           → ai_analysis (LLM investment thesis)
```

### `--quarterly`

```
1. financials_fallback   → financials (Stockbit)
2. company_profiles      → profiles, officers, shareholders
3. document_links        → document_links (non-fatal)
4. corporate_events      → corporate_events (non-fatal)
5. update_scores
```

### `--daily`

```
1. daily_prices          → OHLCV
2. money_flow            → foreign flow + broker summary
3. update_scores
```

### `--weekly`

```
1. stock_universe        → stocks
2. update_scores
```

---

## Common Operations

All commands are run from the `python/` directory.

### Daily refresh (prices + money flow)
```bash
python run_all.py --daily
```

### Weekly refresh (stock list)
```bash
python run_all.py --weekly
```

### Quarterly refresh (Stockbit financials → profiles → docs → events)
```bash
python run_all.py --quarterly
```

### Full refresh (everything, in dependency order)
```bash
python run_all.py --full
```

### Test on a single stock
```bash
python run_all.py --full --ticker BBRI
python run_all.py --daily --ticker BBRI ASII BBCA
```

### Sector-scoped run
```bash
python run_all.py --quarterly --sector finance
python run_all.py --daily --sector energy
python run_all.py --fallback-financials --sector "barang konsumen"   # matches both consumer sectors
python run_all.py --daily --sector healthcare technology             # multiple sectors
```
Sector matching is case-insensitive and supports partial names (e.g. "finance" → "Financials").

### Year range filtering (Stockbit financials)
```bash
python run_all.py --quarterly --year-from 2020 --year-to 2025
python run_all.py --fallback-financials --year-from 2023
python run_all.py --full --ticker BBRI --year-from 2015
```

---

## Enrichment & Gap Filling

Run these **after** the primary scrapers, not instead of them.

### Fill NULL ratio columns (no API calls, safe to run anytime)
```bash
python run_all.py --enrich-ratios
python run_all.py --enrich-ratios --ticker BBRI    # single stock
python run_all.py --enrich-ratios --dry-run        # preview without writing
```

### Fetch dividend history
```bash
python run_all.py --dividends
python run_all.py --dividends --ticker BBRI TLKM
```

### Run Stockbit financials standalone
```bash
python run_all.py --fallback-financials             # only fills NULL fields (default)
python run_all.py --fallback-financials --ticker BBRI
python run_all.py --fallback-financials --fallback-all   # re-process even if data exists
python run_all.py --fallback-financials --dry-run
```

### Fix low-completeness stocks (auto-detects what's missing and re-runs the right scrapers)
```bash
python run_all.py --fill-gaps                         # top 100 most incomplete stocks (default)
python run_all.py --fill-gaps --min-score 50          # only stocks with score < 50
python run_all.py --fill-gaps --gap-limit 20          # process 20 stocks per run
python run_all.py --fill-gaps --gap-category ratios prices   # specific gap types only
python run_all.py --fill-gaps --dry-run               # detect gaps, no writes
```

Gap categories: `prices`, `financials_annual`, `financials_quarterly`, `ratios`, `profile`, `officers`, `shareholders`, `dividends`

---

## Smart Money Pipeline (Broker Flow, Bandar, Insider)

These populate the money flow analysis widgets (broker activity, bandar detection, insider tracking).

### Broker flow backfill (Stockbit)
```bash
python run_all.py --broker-backfill                                # last 90 days, top stocks by market cap
python run_all.py --broker-backfill --backfill-days 60 --ticker BBRI
python run_all.py --broker-backfill --offset 100 --batch-limit 50  # batch processing
```
Populates `broker_flow` and `bandar_signal` tables from Stockbit marketdetectors API.

> Also runs automatically in `--full` mode.

### Insider transactions (Stockbit / KSEI)
```bash
python run_all.py --insider                                        # top stocks, 5 pages each
python run_all.py --insider --ticker BBRI                          # specific ticker
python run_all.py --insider --insider-pages 10                     # more pages per ticker
python run_all.py --insider --offset 50 --batch-limit 25           # batch processing
```
Populates `insider_transactions` table from KSEI major holder movement data.

---

## Market Phase Detection (Fase Pasar)

Detects market cycle phases (Uptrend, Downtrend, Sideways Bullish, Sideways Bearish) using SMA(20/50) crossover + ATR volatility + volume patterns. Enriches each phase with broker flow, bandar signal, and insider confirmation data.

```bash
python run_all.py --detect-phases                                  # all active tickers
python run_all.py --detect-phases --ticker BBCA BBRI BMRI          # specific tickers
python run_all.py --detect-phases --dry-run                        # detect but don't save
```

**What it does:**
1. Fetches ~3 years of daily_prices (OHLCV) per ticker
2. Classifies each day using SMA crossover + ATR + volume spikes
3. Merges consecutive same-type days into phases (min 8 days)
4. Enriches with broker_flow, bandar_signal, insider_transactions
5. Scores phase clarity (0-100) from price/volume signals
6. Scores smart money alignment (0-100) from broker/bandar/insider data
7. Writes to `market_phases` table + denormalizes `current_phase` onto `stocks`

**Liquidity filter:** Stocks with avg volume < 500K shares/day are skipped.

**Dependencies:** Requires `daily_prices` data. For smart money enrichment, also needs `broker_flow`, `bandar_signal`, and `insider_transactions`.

**Tables populated:** `market_phases`, `stocks` (current_phase, current_phase_clarity, current_phase_days)

---

## AI Analysis Pipeline (Phase 6)

Builds investment context from financial data, then generates LLM-based investment theses.

### Build AI context (no LLM calls)
```bash
python run_all.py --build-ai-context                               # all eligible tickers
python run_all.py --build-ai-context --ticker BBRI                 # single ticker
python run_all.py --build-ai-context --dry-run
```

Runs 4 stages: data_cleaner → data_normalizer → scoring_engine → context_builder.
Populates: `data_quality_flags`, `normalized_metrics`, `stock_scores`, `ai_context_cache`.

### Generate AI investment thesis (LLM calls)
```bash
python run_all.py --run-ai-analysis                                # requires ai_context_cache
python run_all.py --run-ai-analysis --ai-provider anthropic        # use Claude instead of GPT
python run_all.py --run-ai-analysis --ai-model claude-sonnet-4     # specific model
python run_all.py --run-ai-analysis --min-composite 60             # only high-quality stocks
```

### Full AI pipeline (context + analysis)
```bash
python run_all.py --ai-full                                        # build context then generate thesis
python run_all.py --ai-full --ticker BBRI --ai-provider anthropic
```

Populates: `ai_analysis` (lynch_category, buffett_moat, bull/bear/neutral cases, analyst_verdict).

---

## CLI-Only Scrapers (Manual)

These scrapers are NOT part of the `run_all.py` pipeline and must be run directly.

### Shareholders PDF import (local files)
```bash
python -m scrapers.shareholders_pdf --file ./data/shareholders.pdf --date 2025-12-31
python -m scrapers.shareholders_pdf --file ./data/holders.xlsx --date 2025-12-31 --dry-run
```
Parses local PDF/Excel/CSV files containing ≥1% shareholder data and upserts into `shareholders_major` table.

### yfinance financials (standalone, secondary source)
```bash
python -m scrapers.financials --ticker BBRI
python -m scrapers.financials --ticker BBRI --period annual
```
Fetches from yfinance and fills NULL fields only. Not part of the automated pipeline.

---

## Refresh Job Tracking

When running for a single ticker, `run_all.py` auto-detects pending `stock_refresh_requests` jobs from the UI:

```bash
# Auto-detected:
python run_all.py --full --ticker BBRI    # finds pending job, tracks progress per scraper

# Explicit:
python run_all.py --full --ticker BBRI --job-id 42
```

Job tracking flow:
1. Detects pending job → sets status to `running`
2. Each scraper reports progress to `refresh_scraper_progress` table
3. On completion → writes after-scores, sets `no_new_data` if all scrapers added 0 rows
4. On failure → records error message, marks job as `failed`

---

## Recommended Cadence

| Frequency | Command | Notes |
|-----------|---------|-------|
| Every trading day (after 16:00 WIB) | `python run_all.py --daily` | Prices + foreign flow |
| Every trading day (after --daily) | `python run_all.py --detect-phases` | Update market phase overlays |
| Weekly (Sunday) | `python run_all.py --weekly` | Refresh stock universe |
| After each earnings season | `python run_all.py --quarterly` then `--enrich-ratios` | Financials + screener sync |
| Monthly | `python run_all.py --dividends` | Dividend history |
| Monthly | `python run_all.py --broker-backfill` | Broker flow + bandar signals |
| Monthly | `python run_all.py --insider` | KSEI insider transactions |
| Monthly (after broker data) | `python run_all.py --detect-phases` | Refresh phases with new smart money data |
| Quarterly (after financials) | `python run_all.py --ai-full` | Regenerate AI investment theses |
| Ongoing (low completeness) | `python run_all.py --fill-gaps --gap-limit 50` | Fix data gaps |

---

## Running Individual Scrapers Directly

If `run_all.py` is overkill and you only need one scraper:

```bash
cd python
python -m scrapers.stock_universe
python -m scrapers.stock_universe --ticker BBRI

python -m scrapers.daily_prices
python -m scrapers.daily_prices --ticker BBRI ASII
python -m scrapers.daily_prices --full              # force full history re-fetch

python -m scrapers.financials_fallback              # Stockbit (primary)
python -m scrapers.financials_fallback --ticker BBRI
python -m scrapers.financials_fallback --dry-run
python -m scrapers.financials_fallback --all        # re-process even if data exists

python -m scrapers.financials                       # yfinance (secondary, standalone only)
python -m scrapers.financials --ticker BBRI
python -m scrapers.financials --ticker BBRI --period annual

python -m scrapers.money_flow
python -m scrapers.money_flow --ticker BBRI
python -m scrapers.money_flow --days 5              # last 5 trading days
python -m scrapers.money_flow --date 2026-03-14     # specific date
python -m scrapers.money_flow --broker-backfill 30  # Stockbit broker flow
python -m scrapers.money_flow --insider             # KSEI insider transactions

python -m scrapers.company_profiles
python -m scrapers.company_profiles --ticker BBRI

python -m scrapers.document_links
python -m scrapers.document_links --ticker BBRI

python -m scrapers.corporate_events
python -m scrapers.corporate_events --ticker BBRI

python -m scrapers.ratio_enricher
python -m scrapers.ratio_enricher --ticker BBRI ASII
python -m scrapers.ratio_enricher --dry-run

python -m scrapers.dividend_scraper
python -m scrapers.dividend_scraper --ticker BBRI TLKM

python -m scrapers.gap_filler --dry-run             # always dry-run first
python -m scrapers.gap_filler --category ratios

python -m scrapers.shareholders_pdf --file <path> --date 2025-12-31
python -m scrapers.shareholders_pdf --file <path> --date 2025-12-31 --dry-run
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `Missing required environment variable` | `.env` not loaded or key missing | Check `.env` file exists and has Supabase credentials |
| `No active stocks found` | `stocks` table empty | Run `--weekly` or `stock_universe` first |
| IDX API returns 403 / empty | IDX blocked the request | Wait a few minutes and retry; IDX rate limit is ~1.6 req/s |
| Stockbit "token required" prompt | No token or expired | Paste a fresh token from browser DevTools (see Token Setup above) |
| Stockbit 401 during run | Token just expired mid-run | Cached token auto-cleared — re-run and paste a new token |
| yfinance data is stale / missing | yfinance occasionally has gaps | Stockbit is now primary; yfinance is secondary. Run `--fill-gaps` for stubborn gaps |
| Scores not updating | Scores are recalculated automatically at the end of each mode | Run `python run_all.py --enrich-ratios` to force a score refresh |
| Run interrupted mid-way | Ctrl+C or crash | Re-run the same command — all scrapers are idempotent (upsert, safe to re-run) |
| `--period annual` has no effect | Known issue: `--period` flag is accepted but not forwarded to Stockbit scraper | Use `financials_fallback` directly with `--annual-only` or `--quarterly-only` flags |

---

## Key Facts to Remember

- **Stockbit is the sole financial data source in the pipeline.** `financials.py` (yfinance) exists but is not called by `run_all.py`.
- Token is stored in `~/.stockbit_token` (not `.env`). Managed automatically — just paste when prompted.
- Tickers are stored **without** `.JK` suffix (e.g., `BBRI`, not `BBRI.JK`). The suffix is added internally when calling yfinance.
- All monetary values in the DB are **IDR as BIGINT** (no decimals).
- Ratios/percentages are stored as **15.5**, not 0.155.
- `quarter=0` means **annual** data; `quarter=1-4` means quarterly.
- `--quarterly` runs Stockbit → profiles → docs → events. No separate `--fallback-financials` step needed.
- `ratio_enricher` makes **no API calls** — safe to run anytime without worrying about rate limits.
- `gap_filler` is the "fix everything" meta-scraper — it calls other scrapers internally based on detected gaps.
- `document_links` and `corporate_events` are **non-fatal** — if their DB tables don't exist, the pipeline continues.
- Broker backfill runs automatically in `--full` mode. Can also run standalone via `--broker-backfill`.
- Insider scraping requires standalone `--insider` invocation (not included in `--full`).
- `--detect-phases` detects market phases from price/volume data. No API calls — pure computation. Run after `--daily`.
- `--ai-full` = `--build-ai-context` + `--run-ai-analysis`. Context build is free (DB only); analysis costs LLM tokens.
- `--enrich-ratios` now runs automatically in `--full` mode after scoring. Syncs PE/PBV/ROE from financials to stocks table.
