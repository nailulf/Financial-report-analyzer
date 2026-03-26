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
| `ratio_enricher` | `financials` (fills NULL ratio columns) | DB only (no API) | `--enrich-ratios` |
| `dividend_scraper` | `dividend_history` | yfinance | `--dividends` |
| `gap_filler` | various (re-runs targeted scrapers) | various | `--fill-gaps` |

### CLI-only scrapers (NOT in `run_all.py`, run manually)

| Scraper | Table(s) populated | Source | How to run |
|---------|-------------------|--------|------------|
| `money_flow --broker-backfill` | `broker_flow`, `bandar_signal` | Stockbit | `python -m scrapers.money_flow --broker-backfill 30` |
| `money_flow --insider` | `insider_transactions` | Stockbit (KSEI) | `python -m scrapers.money_flow --insider` |
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
8. update_scores         → stocks (completeness_score, confidence_score)
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

## CLI-Only Scrapers (Manual)

These scrapers are NOT part of the `run_all.py` pipeline and must be run directly.

### Broker flow backfill (Stockbit)
```bash
python -m scrapers.money_flow --broker-backfill 30                 # last 30 days, top stocks by market cap
python -m scrapers.money_flow --broker-backfill 60 --ticker BBRI   # specific ticker, 60 days
python -m scrapers.money_flow --broker-backfill 30 --offset 100 --limit 50  # batch: skip 100, process 50
```
Populates `broker_flow` and `bandar_signal` tables from Stockbit marketdetectors API.

### Insider transactions (Stockbit / KSEI)
```bash
python -m scrapers.money_flow --insider                            # top stocks, 5 pages each
python -m scrapers.money_flow --insider --ticker BBRI              # specific ticker
python -m scrapers.money_flow --insider --insider-pages 10         # more pages per ticker
python -m scrapers.money_flow --insider --offset 50 --limit 25    # batch processing
```
Populates `insider_transactions` table from KSEI major holder movement data.

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

| Frequency | Command |
|-----------|---------|
| Every trading day (after 16:00 WIB) | `python run_all.py --daily` |
| Weekly (Sunday) | `python run_all.py --weekly` |
| After each earnings season | `python run_all.py --quarterly` then `python run_all.py --enrich-ratios` |
| Monthly | `python run_all.py --dividends` |
| Monthly (optional) | `python -m scrapers.money_flow --broker-backfill 30` |
| Monthly (optional) | `python -m scrapers.money_flow --insider` |
| Ongoing (whenever completeness is low) | `python run_all.py --fill-gaps --gap-limit 50` |

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
- Broker backfill and insider scraping require **manual CLI invocation** — they are not part of `run_all.py`.
