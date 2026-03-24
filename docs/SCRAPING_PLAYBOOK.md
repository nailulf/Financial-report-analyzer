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

Stockbit is the **primary** financial data source. A bearer token is required for full statement endpoints (income, balance sheet, cash flow). Public endpoints (ratios, keystats) work without a token.

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
Financial data:  Stockbit (primary) → yfinance (fills gaps)
Price data:      yfinance
Money flow:      IDX API
Company info:    IDX API
```

When `--quarterly` or `--full` runs:
1. **Stockbit** fetches financials first (keystats + full statements)
2. **yfinance** runs second and only fills NULL fields — never overwrites Stockbit data
3. Source tracking shows `"stockbit"`, `"yfinance"`, or `"stockbit+yfinance"` in DB

---

## The Scrapers

| Scraper | Table(s) populated | Source | Run how often |
|---------|-------------------|--------|---------------|
| `stock_universe` | `stocks` | IDX API | Weekly |
| `daily_prices` | `daily_prices` (OHLCV) | yfinance | Daily |
| `money_flow` | `daily_prices` (foreign flow), `broker_summary` | IDX API | Daily |
| `financials_fallback` | `financials` (annual + quarterly) | **Stockbit** (primary) | Quarterly |
| `financials` | `financials` (fills gaps) | yfinance (secondary) | Quarterly |
| `company_profiles` | `company_profiles`, `company_officers`, `shareholders` | IDX API | Quarterly |
| `document_links` | `document_links` | IDX API | Quarterly |
| `corporate_events` | `corporate_events` | IDX API | Quarterly |
| `ratio_enricher` | `financials` (fills NULL ratio columns) | DB only (no API) | After financials |
| `dividend_scraper` | `dividend_history` | yfinance | Monthly |
| `gap_filler` | various (re-runs targeted scrapers) | various | Weekly |

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

### Quarterly refresh (Stockbit → yfinance → profiles → docs → events)
```bash
python run_all.py --quarterly
```
Force annual only or quarterly only:
```bash
python run_all.py --quarterly --period annual
python run_all.py --quarterly --period quarterly
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

## Recommended Cadence

| Frequency | Command |
|-----------|---------|
| Every trading day (after 16:00 WIB) | `python run_all.py --daily` |
| Weekly (Sunday) | `python run_all.py --weekly` |
| After each earnings season | `python run_all.py --quarterly` then `python run_all.py --enrich-ratios` |
| Monthly | `python run_all.py --dividends` |
| Ongoing (whenever completeness is low) | `python run_all.py --fill-gaps --gap-limit 50` |

> **Note:** `--quarterly` now runs Stockbit + yfinance + profiles in one go.
> No need to run `--fallback-financials` separately after `--quarterly` anymore.

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

python -m scrapers.financials                       # yfinance (secondary, fills gaps)
python -m scrapers.financials --ticker BBRI
python -m scrapers.financials --ticker BBRI --period annual

python -m scrapers.money_flow
python -m scrapers.money_flow --ticker BBRI
python -m scrapers.money_flow --days 5              # last 5 trading days
python -m scrapers.money_flow --date 2026-03-14     # specific date

python -m scrapers.company_profiles
python -m scrapers.company_profiles --ticker BBRI

python -m scrapers.ratio_enricher
python -m scrapers.ratio_enricher --ticker BBRI ASII
python -m scrapers.ratio_enricher --dry-run

python -m scrapers.dividend_scraper
python -m scrapers.dividend_scraper --ticker BBRI TLKM

python -m scrapers.gap_filler --dry-run             # always dry-run first
python -m scrapers.gap_filler --category ratios
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

---

## Key Facts to Remember

- **Stockbit is the primary financial data source.** yfinance only fills gaps.
- Token is stored in `~/.stockbit_token` (not `.env`). Managed automatically — just paste when prompted.
- Tickers are stored **without** `.JK` suffix (e.g., `BBRI`, not `BBRI.JK`). The suffix is added internally when calling yfinance.
- All monetary values in the DB are **IDR as BIGINT** (no decimals).
- Ratios/percentages are stored as **15.5**, not 0.155.
- `quarter=0` means **annual** data; `quarter=1-4` means quarterly.
- `--quarterly` now runs Stockbit → yfinance → profiles in one pipeline. No separate `--fallback-financials` step needed.
- `ratio_enricher` makes **no API calls** — safe to run anytime without worrying about rate limits.
- `gap_filler` is the "fix everything" command — run it after any major pipeline issue to patch up what's missing.
