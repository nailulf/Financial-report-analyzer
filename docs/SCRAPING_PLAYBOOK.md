# Data Scraping Playbook

Operational guide for running the IDX Stock Analyzer data pipeline.

All commands assume you're in the `python/` directory with the venv active:

```bash
cd python
source venv/bin/activate
```

---

## Contents

1. [Setup](#1-setup)
2. [Cheat sheet](#2-cheat-sheet)
3. [Daily operations](#3-daily-operations)
4. [Weekly / market structure](#4-weekly--market-structure)
5. [Earnings & periodic refresh](#5-earnings--periodic-refresh)
6. [Money flow, insiders, dividends](#6-money-flow-insiders-dividends)
7. [Enrichment & gap filling](#7-enrichment--gap-filling)
8. [AI analysis pipeline](#8-ai-analysis-pipeline)
9. [Scoping (`--ticker` / `--sector`)](#9-scoping---ticker----sector)
10. [Full pipeline (`--full`)](#10-full-pipeline---full)
11. [Standalone scrapers](#11-standalone-scrapers)
12. [Recommended cadence](#12-recommended-cadence)
13. [Refresh job tracking](#13-refresh-job-tracking)
14. [Config](#14-config)
15. [Troubleshooting](#15-troubleshooting)
16. [Key facts](#16-key-facts)

---

## 1. Setup

### Environment

```bash
cp ../.env.example ../.env   # first time only
```

| Key | Source | Required? |
|---|---|---|
| `SUPABASE_URL` | Supabase → Settings → API | Yes |
| `SUPABASE_SERVICE_KEY` | Supabase → Settings → API → service_role | Yes |
| `TWELVE_DATA_API_KEY` | twelvedata.com free tier | No (fallback only) |

### Stockbit token

Stockbit is the **primary source** for financials, broker flow, and insider data.

**Get / refresh the token:**

```bash
python -c "from utils.token_manager import get_stockbit_token; get_stockbit_token()"
```

Or just run any Stockbit scraper — you'll be prompted.

**Where to grab it from:** open https://stockbit.com in Chrome (logged in) → DevTools (F12) → Network → any request → Headers → Authorization. Copy the value *without* the `Bearer ` prefix.

**Behavior:**
- Cached in `~/.stockbit_token` (never in `.env`)
- JWT expiry decoded automatically; warns when expiring
- 401 → token cleared, you'll be re-prompted next run
- Lifetime ≈ 30 days
- **IP-bound** — token only works from the machine that obtained it. Stockbit scrapers will 401 from datacenter IPs (GitHub Actions, Vercel cron).

### Data sources at a glance

| Data | Source | Notes |
|---|---|---|
| Financial statements | **Stockbit** (sole source) | income / balance / cashflow + keystats |
| Price OHLCV | yfinance | `.JK` suffix added internally |
| Foreign flow | **Stockbit** `broker_flow` (`broker_type='Asing'`) | confirmed IDR |
| Per-broker buy/sell | **Stockbit** marketdetectors API | broker_flow + bandar_signal |
| Insider transactions | **Stockbit** (KSEI data) | major holder movements |
| Company info | IDX API | profiles, officers, shareholders |
| Dividends | yfinance | full history |
| IDX broker summary (legacy) | IDX API | aggregated only; kept for compatibility |

> `financials.py` (yfinance) exists but is **not in the pipeline**. Stockbit is the only financials source.

---

## 2. Cheat sheet

The 90% case — what to run when:

| Situation | Command |
|---|---|
| **End of trading day (fast)** | `python run_all.py --daily-light` |
| End of trading day (full) | `python run_all.py --daily` |
| MACD / RSI / volume signals | `python run_all.py --compute-signals` |
| Update market phase overlays | `python run_all.py --detect-phases` |
| Wyckoff events (recommended) | `python run_all.py --detect-wyckoff-v2` |
| Weekly stock-universe refresh | `python run_all.py --weekly` |
| After earnings season | `python run_all.py --quarterly` |
| Broker flow for Money Flow page | `python run_all.py --broker-backfill` |
| KSEI insider transactions | `python run_all.py --insider` |
| AI investment thesis | `python run_all.py --ai-full --ticker BBRI` |
| Single-stock end-to-end test | `python run_all.py --full --ticker BBRI` |
| Fix incomplete stocks | `python run_all.py --fill-gaps` |
| Everything from scratch | `python run_all.py --full` |

---

## 3. Daily operations

The pipeline has **two daily modes**:

### `--daily-light` — the typical end-of-day refresh

```bash
python run_all.py --daily-light
```

**Runs:** `daily_prices` → `money_flow`

**Use this most days.** Pulls today's OHLCV (yfinance) and foreign flow / broker summary (IDX). No Stockbit calls, no quarterly chain, no derivations. Fastest path to "today's prices and flow are in the DB."

Chain `--compute-signals` if you also want MACD/RSI updated:

```bash
python run_all.py --daily-light --compute-signals
```

### `--daily` — full daily, includes current-year quarterly catch-up

```bash
python run_all.py --daily
```

**Runs (in order):**

1. `financials_fallback` (Stockbit, **current year only**) — picks up any filings posted today
2. `company_profiles` (IDX)
3. `document_links` (IDX, non-fatal)
4. `corporate_events` (IDX, non-fatal)
5. `daily_prices` (yfinance)
6. `money_flow` (IDX foreign flow + broker summary)
7. `technical_signals` (MACD / RSI / volume change)

Use this when you want filings caught the same day they're published. The quarterly chain is gated to `year_from = year_to = today.year` to stay fast — broaden with `--year-from / --year-to` if needed.

> **`--daily` requires Stockbit** because of step 1. It can only run on your machine (IP-bound token). If you're scheduling from a server, use `--daily-light`.

### `--compute-signals` — MACD / RSI / volume (DB-only)

```bash
python run_all.py --compute-signals                  # all active tickers
python run_all.py --compute-signals --ticker BBRI    # subset
python run_all.py --compute-signals --dry-run        # preview
```

**Computes:** Wilder's RSI(14), MACD(5,20,9) + golden/death cross detection, volume vs 20-day SMA.

**Writes:** `technical_signals` (one row per ticker per day) and denormalizes onto `stocks` (`rsi_14`, `macd_*`, `volume_change_pct`, `volume_avg_20d`).

**Auto-runs in:** `--daily` and `--full`. **Not** in `--daily-light`.

**Needs:** ≥ 50 trading days of `daily_prices`.

---

## 4. Weekly / market structure

### `--weekly` — refresh the stock universe

```bash
python run_all.py --weekly
```

**Runs:** `stock_universe` only — adds new IPOs, marks delistings, refreshes board/sector classification.

### `--detect-phases` — SMA-based market phase overlay

```bash
python run_all.py --detect-phases                          # all active
python run_all.py --detect-phases --ticker BBCA BBRI BMRI
python run_all.py --detect-phases --dry-run
```

**What it does:** classifies each day via SMA(20/50) crossover + ATR + volume spikes, merges consecutive same-type days into phases (min 8 days), scores phase clarity and smart-money alignment, then writes to `market_phases` and denormalizes `current_phase` onto `stocks`.

**Filter:** stocks with avg volume < 100K shares/day are skipped.

**Needs:** `daily_prices`; smart-money enrichment also uses `broker_flow`, `bandar_signal`, `insider_transactions`.

### `--detect-wyckoff-v2` — FSM-based Wyckoff events (recommended)

```bash
python run_all.py --detect-wyckoff-v2                          # all active
python run_all.py --detect-wyckoff-v2 --ticker BBCA BBRI
python run_all.py --detect-wyckoff-v2 --dry-run
```

**What it does:** streams bars through a 12-state finite state machine
(`UNKNOWN → DOWNTREND → ACCUM_A→B→C→D → MARKUP → UPTREND → DISTR_A→B→C→D → MARKDOWN → ...`).
Climaxes are detected via three paths (single-bar climactic, 3-bar cluster, 15-bar absorption regime) and confirmed only after 5+ bars of phase-consistent character. Soft phase-A entries (`basis_building`, `topping_action`) cover stocks without textbook climaxes. Trend-driven exits (`markup_exhaustion`, `range_breakout_*`, `accum_failed`/`distr_failed`) cover ranges that roll over.

**Writes:** `wyckoff_events` rows with `detection_version='2.0'` + denormalizes latest event and final FSM phase onto `stocks.current_wyckoff_*_v2` columns (including fine-grained phases like `accumulation_c`).

**Output:** typically 4–8 events per ticker over 2 years — fewer than v1, but each is structurally validated.

**Needs:** ≥ 60 trading days of `daily_prices` (warm-up).

### `--detect-wyckoff` — v1 flat-pass detector (legacy / wider coverage)

```bash
python run_all.py --detect-wyckoff
```

Six independent passes over all bars (climax / Spring-UTAD / secondary tests / SOS-LPS / effort-vs-result / passive drift), deduped at the end. Wider coverage than v2 — includes `passive_markup`/`passive_markdown` drift and `absorption`/`no_demand`/`no_supply` effort-result events. More false positives. Output: typically 10–18 events per ticker over 2 years.

Writes to `wyckoff_events` with `detection_version='1.0'` and denormalizes to `stocks.current_wyckoff_*` (separate columns from v2 — the two never overwrite each other).

### When to use which Wyckoff detector

| Goal | Use |
|---|---|
| Default screener / chart display | **v2** |
| "What structural phase is this in?" | v2 (FSM phase like `accumulation_c`) |
| Trade triggers with low false-positive rate | v2 |
| Wider net — any signal at all | v1 |
| Drift periods (passive markup/markdown) | v1 (v2 doesn't have these) |
| Bar-level effort/result (absorption / no_demand) | v1 (v2 doesn't have these) |

The frontend chart toggle (`v1` / `v2` in the FASE PASAR widget) and the screener's Wyckoff sub-toggle flip between detectors.

### Wyckoff schema prerequisites

Apply once in Supabase SQL editor (idempotent):

```text
docs/schema-wyckoff-event-types-current.sql   # CHECK constraint with all event types
docs/schema-v25-wyckoff-v2.sql                # v2 denorm columns on stocks
```

### Wyckoff diagnostic

Trace the FSM bar-by-bar when results are surprising:

```bash
python -m scripts.analysis.wyckoff_v2_diagnostic BBRI                  # full trace
python -m scripts.analysis.wyckoff_v2_diagnostic DEWA --transitions-only
python -m scripts.analysis.wyckoff_v2_diagnostic AVIA --since 2025-09-01
```

When no events fire, the diagnostic surfaces the "best near-miss" climactic bar.

---

## 5. Earnings & periodic refresh

### `--quarterly` — full quarterly refresh

```bash
python run_all.py --quarterly
python run_all.py --quarterly --sector finance
python run_all.py --quarterly --year-from 2020 --year-to 2025
python run_all.py --quarterly --ticker BBRI
```

**Runs:** `financials_fallback` (Stockbit, full year range) → `company_profiles` → `document_links` → `corporate_events`.

**Follow up with:**

```bash
python run_all.py --enrich-ratios    # sync PE/PBV/ROE/etc to stocks table
```

### `--fallback-financials` — Stockbit financials standalone

```bash
python run_all.py --fallback-financials                       # fill NULLs only (safe)
python run_all.py --fallback-financials --fallback-all        # re-process even if data exists
python run_all.py --fallback-financials --dry-run             # preview, no writes
python run_all.py --fallback-financials --ticker BBRI --year-from 2015
```

---

## 6. Money flow, insiders, dividends

### `--broker-backfill` — Stockbit broker flow

```bash
python run_all.py --broker-backfill                              # default: top 200 by mcap, last 90 days
python run_all.py --broker-backfill --ticker BBRI BMRI BBCA      # specific
python run_all.py --broker-backfill --backfill-days 30
python run_all.py --broker-backfill --batch-limit 900            # all stocks
python run_all.py --broker-backfill --offset 300 --batch-limit 300   # batched
```

**Writes:** `broker_flow` (per-broker buy/sell/net in IDR + lots), `bandar_signal`.

**Default stock selection:** top `BROKER_SUMMARY_TOP_N` (200) by market cap from `stocks`. Change in `config.py`.

**Also runs in:** `--full`.

> If the Money Flow page shows few tickers in the leaderboard for a date, broker_backfill hasn't run for that date. `--broker-backfill --backfill-days 1` patches the latest day.

### `--insider` — KSEI insider transactions

```bash
python run_all.py --insider                                      # top 200, 5 pages each
python run_all.py --insider --ticker BBRI --insider-pages 10
python run_all.py --insider --batch-limit 900                    # all stocks
python run_all.py --insider --offset 200 --batch-limit 200       # batched
```

**Writes:** `insider_transactions` (KSEI major holder movements via Stockbit).

**Not in `--full`** — run standalone.

### `--dividends` — yfinance dividend history

```bash
python run_all.py --dividends
python run_all.py --dividends --ticker BBRI TLKM
```

---

## 7. Enrichment & gap filling

### `--enrich-ratios` — fill NULL ratio columns (DB-only, no API)

```bash
python run_all.py --enrich-ratios
python run_all.py --enrich-ratios --ticker BBRI
python run_all.py --enrich-ratios --dry-run
```

Computes PE / PBV / ROE / net margin / dividend yield from stored raw data and denormalizes onto `stocks`. Safe to run anytime.

### `--fill-gaps` — auto-fix incomplete stocks

```bash
python run_all.py --fill-gaps                              # top 100 most incomplete
python run_all.py --fill-gaps --min-score 50               # only stocks scoring < 50
python run_all.py --fill-gaps --gap-limit 20
python run_all.py --fill-gaps --gap-category ratios prices
python run_all.py --fill-gaps --dry-run
```

**Gap categories:** `prices`, `financials_annual`, `financials_quarterly`, `ratios`, `profile`, `officers`, `shareholders`, `dividends`.

**Period-aware financial gap detection.** A ticker is flagged with `financials_annual` if it has zero annual rows **or** its latest annual is older than the most recent year past its OJK filing deadline (year-end + 120 days). Same for `financials_quarterly` (quarter-end + 30 days). Catches stocks that filed historically but stopped — e.g., on 2026-05-06 a ticker with annual data through 2024 is flagged because 2025 annual was due 2026-04-30.

See [gap_filler.py:_expected_recent_annual / _expected_recent_quarter](../python/scrapers/gap_filler.py).

---

## 8. AI analysis pipeline

```bash
# Context only (no LLM calls, no cost)
python run_all.py --build-ai-context
python run_all.py --build-ai-context --ticker BBRI

# Investment thesis (costs LLM tokens)
python run_all.py --run-ai-analysis
python run_all.py --run-ai-analysis --ai-provider anthropic
python run_all.py --run-ai-analysis --ai-model claude-sonnet-4
python run_all.py --run-ai-analysis --min-composite 60   # batch: high-quality only

# Both in one command
python run_all.py --ai-full
python run_all.py --ai-full --ticker BBRI --ai-provider anthropic
```

**Context pipeline (4 stages):** `data_cleaner` → `data_normalizer` → `scoring_engine` → `context_builder`.

**Tables written:** `data_quality_flags`, `normalized_metrics`, `stock_scores`, `ai_context_cache`, `ai_analysis`.

The AI pipeline maintains its own internal `stock_scores` table (reliability / confidence / composite) — independent of the `stocks` table.

---

## 9. Scoping (`--ticker` / `--sector`)

Works with any mode.

**By ticker:**

```bash
python run_all.py --daily-light --ticker BBRI
python run_all.py --daily-light --ticker BBRI ASII BBCA
python run_all.py --full --ticker BBRI
```

**By sector** (case-insensitive, partial match, fuzzy):

```bash
python run_all.py --quarterly --sector finance                       # → Financials
python run_all.py --daily --sector energy
python run_all.py --fallback-financials --sector "barang konsumen"   # both consumer sectors
python run_all.py --daily --sector healthcare technology             # multiple
```

Sector resolution: substring → reverse-substring → fuzzy (SequenceMatcher ratio > 0.70). Combine with `--ticker` for a union.

---

## 10. Full pipeline (`--full`)

```bash
python run_all.py --full
python run_all.py --full --ticker BBRI   # single-stock end-to-end test
```

**Execution order:**

1. `stock_universe` → `stocks`
2. `financials_fallback` → `financials` (Stockbit)
3. `company_profiles` → profiles, officers, shareholders
4. `document_links` → `document_links` (non-fatal)
5. `corporate_events` → `corporate_events` (non-fatal)
6. `daily_prices` → `daily_prices` (OHLCV)
7. `money_flow` → IDX foreign flow + broker summary
8. `broker_backfill` → `broker_flow`, `bandar_signal` (Stockbit, last 90 days)
9. `enrich_ratios` → `stocks` (PE / PBV / ROE / net_margin / dividend_yield)
10. `detect_phases` → `market_phases`, `stocks.current_phase`
11. `compute_signals` → `technical_signals`, `stocks.rsi_14` / `macd_*` / `volume_*`
12. `ai_context_pipeline` → cleaned → normalized → scored → `ai_context_cache`
13. `ai_analysis` → `ai_analysis` (LLM thesis)

**Selective `--full`:** use `--scrapers` to run only some steps; others are marked skipped in the progress table.

```bash
python run_all.py --full --scrapers daily_prices,money_flow,technical_signals
```

---

## 11. Standalone scrapers

When `run_all.py` is overkill:

```bash
# Stock universe (IDX)
python -m scrapers.stock_universe
python -m scrapers.stock_universe --ticker BBRI

# Prices (yfinance)
python -m scrapers.daily_prices
python -m scrapers.daily_prices --ticker BBRI ASII
python -m scrapers.daily_prices --full                  # force full re-fetch

# Financials (Stockbit)
python -m scrapers.financials_fallback
python -m scrapers.financials_fallback --ticker BBRI
python -m scrapers.financials_fallback --dry-run
python -m scrapers.financials_fallback --all            # re-process even if data exists

# Money flow (IDX)
python -m scrapers.money_flow
python -m scrapers.money_flow --ticker BBRI
python -m scrapers.money_flow --days 5
python -m scrapers.money_flow --date 2026-03-14

# Broker flow + bandar (Stockbit)
python -m scrapers.money_flow --broker-backfill 30

# Insider transactions (Stockbit / KSEI)
python -m scrapers.money_flow --insider
python -m scrapers.money_flow --insider --ticker BBRI

# Company profiles (IDX)
python -m scrapers.company_profiles
python -m scrapers.company_profiles --ticker BBRI

# Document links & corporate events (IDX)
python -m scrapers.document_links
python -m scrapers.corporate_events

# Ratio enrichment (DB only)
python -m scrapers.ratio_enricher
python -m scrapers.ratio_enricher --ticker BBRI ASII
python -m scrapers.ratio_enricher --dry-run

# Dividends (yfinance)
python -m scrapers.dividend_scraper
python -m scrapers.dividend_scraper --ticker BBRI TLKM

# Gap filler (meta-scraper)
python -m scrapers.gap_filler --dry-run
python -m scrapers.gap_filler --category ratios

# Shareholders PDF import
python -m scrapers.shareholders_pdf --file ./data/shareholders.pdf --date 2025-12-31
python -m scrapers.shareholders_pdf --file ./data/holders.xlsx --date 2025-12-31 --dry-run

# yfinance financials (NOT in pipeline — gap-fill only)
python -m scrapers.financials --ticker BBRI
python -m scrapers.financials --ticker BBRI --period annual
```

Analysis modules (phase / Wyckoff / signals) only run via `run_all.py`.

---

## 12. Recommended cadence

| Frequency | Command | What it does |
|---|---|---|
| Every trading day (post-16:00 WIB) | `--daily-light` | Prices + foreign flow + broker summary |
| Every trading day (post `--daily-light`) | `--compute-signals` | MACD / RSI / volume |
| Every trading day (post `--daily-light`) | `--detect-phases` | SMA market phase overlay |
| Every trading day (post `--daily-light`) | `--detect-wyckoff-v2` | Wyckoff structural events |
| Weekly (Sunday) | `--weekly` | Refresh stock universe |
| Weekly | `--broker-backfill --backfill-days 7` | Keep Money Flow page fresh |
| Weekly (optional) | `--detect-wyckoff` | v1 flat-pass — adds drift + effort/result events |
| After each earnings season | `--quarterly` then `--enrich-ratios` | Financials + screener sync |
| Monthly | `--dividends` | Dividend history |
| Monthly | `--broker-backfill` | Full 90-day broker flow refresh |
| Monthly | `--insider` | KSEI insider transactions |
| Quarterly (after financials) | `--ai-full` | Regenerate AI investment theses |
| As needed | `--fill-gaps --gap-limit 50` | Patch incomplete stocks |

> **Note on `--daily` vs `--daily-light`:** prefer `--daily-light` for the routine end-of-day refresh. Use `--daily` only when you specifically want to pick up new filings the same day (and only from your local machine — Stockbit IP-binds the token).

---

## 13. Refresh job tracking

When running for a single ticker, `run_all.py` auto-detects pending `stock_refresh_requests` jobs from the UI:

```bash
python run_all.py --full --ticker BBRI                # auto-detects pending job
python run_all.py --full --ticker BBRI --job-id 42    # explicit
```

**Flow:** detects pending job → marks `running` → each scraper reports to `refresh_scraper_progress` → on completion marks `done` or `failed`.

---

## 14. Config

`python/config.py`:

| Setting | Default | Controls |
|---|---|---|
| `BROKER_SUMMARY_TOP_N` | 200 | Max stocks for `--broker-backfill` / `--insider` when no `--ticker` given |
| `DAILY_PRICE_HISTORY_YEARS` | 5 | Bootstrap price history on first run |
| `YFINANCE_BATCH_SIZE` | 100 | Tickers per yfinance bulk download |
| `RATE_LIMIT_IDX_SECONDS` | 0.6 | Delay between IDX API requests (~1.6 req/s) |
| `RATE_LIMIT_STOCKBIT_SECONDS` | 0.8 | Delay between Stockbit API requests |

---

## 15. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Missing required environment variable` | `.env` not loaded | Check `.env` exists with Supabase credentials |
| `No active stocks found` | `stocks` table empty | Run `--weekly` first |
| IDX API returns 403 / empty | Rate limited | Wait a few minutes, retry |
| Stockbit "token required" prompt | No token or expired | Paste fresh token from browser DevTools |
| Stockbit 401 mid-run | Token expired or running from non-local IP | Re-run locally with fresh token |
| Money Flow page shows few tickers | `broker_backfill` incomplete for that date | `--broker-backfill --backfill-days 1` |
| Money Flow page shows nothing | No `broker_flow` data for the range | `--broker-backfill` |
| Run interrupted | Ctrl+C / crash | Safe to re-run — all scrapers upsert |
| Phase detection skips a stock | Avg volume < 100K shares/day | Liquidity filter — by design |
| Technical signals skip a stock | < 50 days of price data | Need more price history |
| `--detect-wyckoff*` fails with `event_type_check` violation | CHECK constraint outdated | Apply [docs/schema-wyckoff-event-types-current.sql](schema-wyckoff-event-types-current.sql) |
| Wyckoff v2 produces 0 events | Choppy chart with no structural cycle (correct) | Run diagnostic: `python -m scripts.analysis.wyckoff_v2_diagnostic TICKER` |
| Screener Wyckoff column empty | Detection hasn't run, or denorm columns missing | Run `--detect-wyckoff-v2`; ensure schema-v25 applied |

---

## 16. Key facts

- **Stockbit is the sole financials source.** `financials.py` (yfinance) exists but is not in the pipeline.
- **Stockbit token is IP-bound.** Runs only from the machine that obtained it. GitHub Actions / Vercel cron will 401.
- **Foreign flow comes from `broker_flow`** (Stockbit, `broker_type='Asing'`), not from `daily_prices`. The IDX API foreign-flow fields were removed (unreliable, unknown units).
- Token in `~/.stockbit_token` (not `.env`). Managed automatically.
- Tickers stored **without** `.JK` suffix. Added internally for yfinance.
- All monetary values: **IDR as BIGINT**. Ratios stored as `15.5`, not `0.155`.
- `quarter=0` = annual; `quarter=1-4` = quarterly.
- `ratio_enricher`, `compute_signals`, `detect_phases` make **no API calls** — safe anytime.
- `gap_filler` is the "fix everything" meta-scraper — detects gaps and calls the right scrapers.
- `--broker-backfill` defaults to top 200 by market cap. Use `--batch-limit 900` for all stocks.
- `--insider` is **not in `--full`** — run standalone.
- `--ai-full` = `--build-ai-context` (free) + `--run-ai-analysis` (costs LLM tokens).
- **Wyckoff v1 and v2 coexist.** Same `wyckoff_events` table with separate `detection_version` and separate denorm columns on `stocks` — they never overwrite each other. v2 is the default.
- **Wyckoff schema migrations are required.** Apply [docs/schema-wyckoff-event-types-current.sql](schema-wyckoff-event-types-current.sql) and [docs/schema-v25-wyckoff-v2.sql](schema-v25-wyckoff-v2.sql) before running either detector.
- **Wyckoff detectors are not in `--full`.** Run `--detect-wyckoff-v2` standalone after the daily pipeline.
- **No completeness/confidence score updates.** The data pipeline no longer maintains `stocks.completeness_score` / `stocks.confidence_score`; the UI doesn't surface them. The AI pipeline has its own internal `stock_scores` table.
