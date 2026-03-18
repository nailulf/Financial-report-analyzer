# FRD — Data Completeness & Confidence Score

**Feature:** Per-stock data quality scoring + user-triggered data refresh
**Scope:** Stock detail page (`/stock/[ticker]`)
**Status:** Draft v1.0 — March 2026

---

## 1. Overview

Every stock in the IDX universe has a different level of data availability — blue chips like BBRI have years of clean data while small-cap acceleration-board stocks may have only a ticker and a price. Without surfacing this gap explicitly, analyses built on thin data are silently unreliable.

This feature introduces two scores per stock:

| Score | What it measures | Range |
|---|---|---|
| **Data Completeness** | How much data we have across all categories | 1–100 |
| **Confidence Score** | How likely the data we have is correct and usable | 0–100 |

When completeness is low, users can trigger a data refresh and — if the scraper finds nothing new — see suggested alternative sources to fill the gap manually.

---

## 2. Goals

- Make data gaps visible and actionable on the stock detail page
- Give users (and future AI agents) a machine-readable signal of how much to trust the data
- Allow targeted single-ticker refresh without running the full pipeline
- Provide clear fallback guidance when scrapers come up empty

## Non-Goals

- Confidence scores for individual fields (too granular for now)
- User-facing data editing or manual overrides

---

## 3. Scoring Model: Data Completeness (1–100)

### 3.1 Categories and Weights

| # | Category | Max Pts | What is measured |
|---|---|---|---|
| 1 | Price History | 15 | Days of OHLCV in `daily_prices` / 1250 (5yr × 250d) |
| 2 | Annual Financials Coverage | 12 | Distinct years with `quarter=0` records / 5 |
| 3 | Annual Financials Quality | 10 | Core income/balance/cash flow fields present in latest annual row (7 fields) |
| 4 | Quarterly Financials | 10 | Rows with `quarter > 0` / 8 (last 8 quarters) |
| 5 | Quarterly Report Documents | 8 | IDX PDF links on record for last 4 quarters |
| 6 | Annual Report Documents | 5 | At least one annual report PDF on record |
| 7 | Company Profile | 7 | description (3) + website (1) + address (1) + phone (1) + email (1) |
| 8 | Board & Commissioners | 8 | Directors ≥ 1 (4) + Commissioners ≥ 1 (4) |
| 9 | Shareholders ≥ 1% | 8 | At least 3 shareholders on record (5) + snapshot < 180 days old (3) |
| 10 | Corporate Events | 7 | Public expose (4) + AGM/RUPS record (3) |
| 11 | Derived Metrics | 10 | All ratio columns non-null in latest `financials` row (pe_ratio, pbv_ratio, roe, roa, current_ratio, debt_to_equity, net_margin, gross_margin, dividend_yield, payout_ratio — 1pt each) |
| — | **Total** | **100** | Minimum clamped to 1 for any stock in the universe |

### 3.2 Score Bands

| Band | Range | Label | Color |
|---|---|---|---|
| High | 80–100 | Good | Green |
| Medium | 50–79 | Partial | Amber |
| Low | 1–49 | Thin | Red |

### 3.3 Extensibility

New categories are added by:
1. Adding a new CTE to `v_data_completeness` SQL view
2. Adding the component column to the view SELECT
3. Adding it to the `DataCompletenessBreakdown` TypeScript type
4. Redistributing weights (total must remain 100)

The score_version field (see §7.1) tracks which version of the formula produced a stored score.

---

## 4. Scoring Model: Confidence Score (0–100)

Confidence measures data reliability — not volume. A stock could have 5 years of data but all from a single scraped source with no cross-validation. Another could have 2 years of data from IDX's official API and pass all sanity checks.

### 4.1 Factors and Weights

| # | Factor | Max Pts | Criteria |
|---|---|---|---|
| 1 | **Data Freshness** | 25 | See §4.2 |
| 2 | **Source Reliability** | 20 | See §4.3 |
| 3 | **Sanity Check Pass Rate** | 30 | See §4.4 |
| 4 | **Cross-Source Consistency** | 15 | See §4.5 |
| 5 | **Scraper Success Rate** | 10 | See §4.6 |

### 4.2 Data Freshness (25 pts)

| Data type | Points | Full score condition |
|---|---|---|
| Price (close) | 10 | Latest price date ≤ 2 trading days ago |
| Annual financials | 8 | Latest annual year = current year − 1 AND updated ≤ 90 days ago |
| Quarterly financials | 4 | Latest quarter ≤ 45 days past its period end |
| Company profile | 3 | `last_updated` ≤ 180 days ago |

Partial scores: if the condition is not met, award half points if it's ≤ 2× the threshold, zero otherwise.

### 4.3 Source Reliability (20 pts)

| Condition | Points |
|---|---|
| Financials sourced from `idx` (official IDX API parse) | 20 |
| Financials sourced from `yfinance` with ≥ 3 years history | 14 |
| Financials sourced from `yfinance` with < 3 years | 8 |
| Only profile-level data, no financial statements | 0 |

Source is read from the `source` column on the `financials` table.

### 4.4 Sanity Check Pass Rate (30 pts)

Each check is worth 3 points. Pass all 10 → 30 pts.

| # | Check | Description |
|---|---|---|
| S1 | Revenue positive | `revenue > 0` for all periods (banking exception: use interest income) |
| S2 | Net income bounded | `abs(net_income) ≤ revenue` for all periods |
| S3 | Balance sheet identity | `abs(total_assets − (total_liabilities + total_equity)) / total_assets < 0.05` |
| S4 | EPS consistency | `abs(eps − net_income / listed_shares) / abs(eps) < 0.10` |
| S5 | Date sequence | Financial periods are monotonically increasing (no gaps > 2 years) |
| S6 | No duplicate periods | No two rows with same `(ticker, year, quarter)` |
| S7 | PE ratio range | `pe_ratio` is null OR `0 < pe_ratio < 500` |
| S8 | PBV ratio range | `pbv_ratio` is null OR `0 < pbv_ratio < 100` |
| S9 | Equity non-negative | `total_equity > 0` in the latest annual (flag negative but don't disqualify) |
| S10 | Free cash flow derivable | `abs(free_cash_flow − (operating_cash_flow − capex)) / abs(free_cash_flow) < 0.10` |

### 4.5 Cross-Source Consistency (15 pts)

Only applies when data from multiple sources is present.

| Check | Points |
|---|---|
| yfinance close price vs IDX `daily_prices` close: within 1% for last 5 overlapping days | 8 |
| yfinance revenue vs IDX-parsed revenue in any overlapping period: within 5% | 7 |

If only one source exists, award 7 pts by default (no evidence of inconsistency).

### 4.6 Scraper Success Rate (10 pts)

Look at `scraper_runs` for this ticker's last run (per scraper). Deduct 2 pts per scraper that ended in `failed` or `partial` for this ticker.

Full 10 pts if all 5 scrapers last ran successfully.

---

## 5. UI/UX Specification

### 5.1 Placement on Stock Detail Page

Insert a `DataQualityPanel` component **immediately below `StockHeader`** and **above `MetricsRow`** in `/stock/[ticker]/page.tsx`.

```
[ StockHeader ]
[ DataQualityPanel ]    ← NEW
[ MetricsRow ]
[ PriceHistoryChart ]
...
```

### 5.2 DataQualityPanel — Default (Collapsed) State

A single horizontal bar showing both scores:

```
┌────────────────────────────────────────────────────────────────┐
│  Data Quality                                          [↓ Details]
│                                                                 │
│  Completeness   ████████████░░░░  72 / 100   Partial           │
│  Confidence     ██████████████░░  84 / 100   Good              │
│                                                                 │
│  Last refreshed: 2 days ago   [↺ Refresh Data]                 │
└────────────────────────────────────────────────────────────────┘
```

- Progress bars use color from §3.2 bands
- "Refresh Data" button: always visible, but highlighted (amber border) when completeness < 50
- Last refreshed: derived from `MAX(last_updated)` across all tables for this ticker

### 5.3 DataQualityPanel — Expanded State (click "Details")

Two columns: completeness breakdown on the left, confidence breakdown on the right.

**Completeness Breakdown (left):**

```
Category               Score   Max
─────────────────────────────────
Price History          15      15  ✓
Annual Coverage        10      12
Annual Quality          8      10
Quarterly Financials    6      10
Quarterly Reports       0       8  ⚠ Missing
Annual Reports          5       5  ✓
Company Profile         5       7
Board & Commissioners   8       8  ✓
Shareholders ≥1%        5       8
Corporate Events        0       7  ⚠ Missing
Derived Metrics         5      10
─────────────────────────────────
Total                  67     100
```

**Confidence Breakdown (right):**

```
Factor                 Score   Max
───────────────────────────────
Data Freshness         22      25
Source Reliability     14      20
Sanity Checks          27      30  (9/10 passed)
Cross-Source           15      15  ✓
Scraper Success         8      10  (1 partial)
───────────────────────────────
Total                  86     100
```

Failed sanity checks are listed inline with a short description (e.g., "S3: Balance sheet off by 7%").

### 5.4 Refresh Flow

**Trigger:** User clicks "↺ Refresh Data"

**Step 1 — Confirm**
Modal: "Refresh data for {TICKER}? This will re-run all scrapers for this stock. Estimated time: 2–5 minutes."
Buttons: [Cancel] [Start Refresh]

**Step 2 — In Progress**
Button becomes disabled spinner: "Refreshing…"
A progress log appears below (SSE stream or 3s polling):
```
[✓] stock_universe   — done (0.3s)
[✓] daily_prices     — 847 → 849 days (+2 new rows)
[⟳] financials       — running…
[ ] company_profiles — waiting
[ ] money_flow       — waiting
```

**Step 3a — Success**
```
✓ Refresh complete. Scores updated.
   Completeness: 67 → 71  (+4)
   Confidence:   84 → 86  (+2)
   [View changes ↓]  ← accordion with diff
```

**Step 3b — No New Data Found**
```
ℹ No new data found since last run (2026-03-16).
  The scraper returned the same data as before.

  Alternative sources you can check manually:
  [see §5.5]
```

### 5.5 Alternative Sources Panel

Shown when a refresh finds no new data, or when the user clicks "Not finding data? Try these sources" (always visible in expanded state when any category scores 0).

| What's missing | Alternative Source | Link |
|---|---|---|
| Financial statements | IDX e-Reporting (official XBRL) | `e-reporting.idx.co.id` |
| Annual report PDF | IDX company disclosure page | `idx.co.id/id/perusahaan-tercatat/laporan-keuangan-dan-tahunan` |
| Quarterly report PDF | Same IDX disclosure page | Same URL |
| Shareholder data | KSEI Investor Area | `ksei.co.id/data-dan-statistik` |
| Corporate events / RUPS | IDX disclosure (keterbukaan informasi) | `idx.co.id/id/perusahaan-tercatat/keterbukaan-informasi` |
| Price history (fallback) | Stooq historical data | `stooq.com` |
| Directors & commissioners | IDX company profile page | `idx.co.id/umbraco/Surface/ListedCompany/GetCompanyProfilesIndex?code={TICKER}` |
| Public expose documents | IDX public expose archive | `idx.co.id/id/berita/public-expose` |

Each row has a "Copy link" button and a short instruction (e.g., "Download the XBRL zip → place in `/data/manual/{TICKER}/`").

---

## 6. Schema Changes

### 6.1 New Table: `company_documents`

```sql
CREATE TABLE IF NOT EXISTS company_documents (
    id              SERIAL PRIMARY KEY,
    ticker          TEXT NOT NULL REFERENCES stocks(ticker) ON DELETE CASCADE,
    doc_type        TEXT NOT NULL,     -- 'annual_report', 'quarterly_report', 'public_expose', 'agm_minutes'
    period_year     INTEGER,
    period_quarter  INTEGER,           -- NULL for annual/events
    doc_url         TEXT,              -- IDX PDF URL
    doc_title       TEXT,
    published_date  DATE,
    fetched_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (ticker, doc_type, period_year, period_quarter)
);

CREATE INDEX IF NOT EXISTS idx_docs_ticker ON company_documents(ticker);
CREATE INDEX IF NOT EXISTS idx_docs_type   ON company_documents(ticker, doc_type);
```

### 6.2 New Table: `corporate_events`

```sql
CREATE TABLE IF NOT EXISTS corporate_events (
    id              SERIAL PRIMARY KEY,
    ticker          TEXT NOT NULL REFERENCES stocks(ticker) ON DELETE CASCADE,
    event_type      TEXT NOT NULL,     -- 'public_expose', 'agm', 'egm', 'board_meeting'
    event_date      DATE,
    title           TEXT,
    summary         TEXT,
    source_url      TEXT,
    fetched_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_ticker ON corporate_events(ticker);
```

### 6.3 New Columns on `stocks`

```sql
ALTER TABLE stocks
    ADD COLUMN IF NOT EXISTS completeness_score  INTEGER,
    ADD COLUMN IF NOT EXISTS confidence_score    INTEGER,
    ADD COLUMN IF NOT EXISTS score_version       TEXT DEFAULT 'v1',
    ADD COLUMN IF NOT EXISTS scores_updated_at   TIMESTAMPTZ;
```

Scores are persisted here after each scraper run (not computed live on every page load) to keep query latency low.

### 6.4 Updated `v_data_completeness` View

The existing view (schema.sql lines 341–458) must be extended to add:
- CTEs for `company_documents` (quarterly_reports_score, annual_reports_score)
- CTE for `corporate_events` (public_expose_score, agm_score)
- CTE for `company_officers` (board_score)
- CTE for shareholders freshness (shareholder_freshness_score)
- CTE for derived metrics field count (derived_metrics_score)

Replace weight distribution per §3.1.

### 6.5 New Table: `stock_refresh_requests`

```sql
CREATE TABLE IF NOT EXISTS stock_refresh_requests (
    id              SERIAL PRIMARY KEY,
    ticker          TEXT NOT NULL REFERENCES stocks(ticker) ON DELETE CASCADE,
    requested_at    TIMESTAMPTZ DEFAULT NOW(),
    status          TEXT DEFAULT 'pending',   -- 'pending', 'running', 'done', 'failed'
    triggered_run_id INTEGER REFERENCES scraper_runs(id),
    completeness_before INTEGER,
    confidence_before   INTEGER,
    completeness_after  INTEGER,
    confidence_after    INTEGER,
    no_new_data     BOOLEAN DEFAULT FALSE,
    finished_at     TIMESTAMPTZ
);
```

---

## 7. API Changes

### 7.1 GET `/api/stocks/[ticker]/completeness`

Returns the full breakdown for the DataQualityPanel.

**Response:**
```typescript
{
  ticker: string
  completeness_score: number       // 1–100
  confidence_score: number         // 0–100
  score_version: string            // e.g. 'v1'
  scores_updated_at: string | null // ISO timestamp
  last_scraped_at: string | null   // MAX last_updated across all tables

  completeness_breakdown: {
    price_history:        { score: number; max: number; detail: string }
    annual_coverage:      { score: number; max: number; detail: string }
    annual_quality:       { score: number; max: number; detail: string }
    quarterly_financials: { score: number; max: number; detail: string }
    quarterly_reports:    { score: number; max: number; detail: string }
    annual_reports:       { score: number; max: number; detail: string }
    company_profile:      { score: number; max: number; detail: string }
    board_commissioners:  { score: number; max: number; detail: string }
    shareholders:         { score: number; max: number; detail: string }
    corporate_events:     { score: number; max: number; detail: string }
    derived_metrics:      { score: number; max: number; detail: string }
  }

  confidence_breakdown: {
    freshness:        { score: number; max: number; detail: string }
    source:           { score: number; max: number; detail: string }
    sanity_checks:    { score: number; max: number; detail: string; failed_checks: string[] }
    cross_source:     { score: number; max: number; detail: string }
    scraper_success:  { score: number; max: number; detail: string }
  }

  missing_categories: string[]     // categories with score = 0
}
```

### 7.2 POST `/api/stocks/[ticker]/refresh`

Triggers a single-ticker scraper run.

**Response (202 Accepted):**
```typescript
{ job_id: number }
```

**Implementation:**
1. If a `pending` or `running` job already exists for this ticker, returns its `job_id` (idempotent — prevents duplicate jobs from multiple button clicks).
2. Otherwise, inserts a row into `stock_refresh_requests` and seeds `refresh_scraper_progress` rows (one per scraper, status `waiting`).
3. Fires a `workflow_dispatch` event to GitHub Actions via the REST API, passing `mode=full`, `ticker`, and `job_id` as inputs.

The GitHub Actions runner executes `python run_all.py --full --ticker {TICKER} --job-id {JOB_ID}`, which auto-detects the job and updates all progress rows in real time.

Requires two environment variables on Vercel:
- `GITHUB_ACTIONS_TOKEN` — GitHub PAT with `workflow` scope
- `GITHUB_REPO` — repository slug, e.g. `yourname/idx-stock-analysis`

If these are unset, the job row is still created but no runner is triggered (graceful degradation — user can still run Python locally).

### 7.4 GET `/api/stocks/[ticker]/refresh`

Returns the most recent active (`pending` or `running`) job for the ticker, or `{ job_id: null }`.

Used by the `DataQualityPanel` on mount to resume polling if the user navigated away during an active refresh.

**Response:**
```typescript
{ job_id: number | null, status?: 'pending' | 'running' }
```

### 7.3 GET `/api/stocks/[ticker]/refresh/[job_id]`

Polling endpoint for refresh status.

**Response:**
```typescript
{
  job_id: number
  status: 'pending' | 'running' | 'done' | 'failed'
  progress: {
    scraper: string
    status: 'waiting' | 'running' | 'done' | 'failed'
    rows_added: number | null
    duration_ms: number | null
  }[]
  no_new_data: boolean
  completeness_before: number | null
  completeness_after:  number | null
  confidence_before:   number | null
  confidence_after:    number | null
  finished_at: string | null
}
```

---

## 8. Python Changes

### 8.1 New Script: `python/utils/score_calculator.py`

Computes both scores for a given ticker (or all tickers) and writes them to `stocks.completeness_score` and `stocks.confidence_score`.

Called at the end of every scraper run and after a user-triggered refresh.

```python
# Entry points:
def compute_scores(ticker: str) -> tuple[int, int]:
    """Returns (completeness_score, confidence_score)"""

def update_scores_for_ticker(ticker: str) -> None:
    """Compute and upsert scores to stocks table"""

def update_all_scores(batch_size: int = 100) -> None:
    """Batch-update all active stocks"""
```

Sanity checks (§4.4) are implemented in Python (not SQL) so they can be tested independently and extended without a DB migration.

### 8.2 New Scraper: `python/scrapers/corporate_events.py`

Fetches public expose and AGM records from IDX keterbukaan informasi endpoint.

Populates `corporate_events` table.

### 8.3 New Scraper: `python/scrapers/document_links.py`

Fetches PDF document links from IDX `GetFinancialReport` endpoint for:
- Annual reports (last 5 years)
- Quarterly reports (last 8 quarters)

Populates `company_documents` table.

### 8.4 Updated `run_all.py`

- Add `corporate_events` and `document_links` as Layer 6 scrapers
- After all scrapers complete, call `update_scores_for_ticker(ticker)` (single) or `update_all_scores()` (full run)
- `--job-id ID` CLI flag links a run to a `stock_refresh_requests` row. When set (or auto-detected for single-ticker runs), each scraper call updates its `refresh_scraper_progress` row (`waiting → running → done/failed`) with `rows_added` and `duration_ms`. On completion, `stock_refresh_requests` is finalized with `status`, `finished_at`, after-scores, and `no_new_data`.
- Auto-detection: if `--ticker BBRI` is given without `--job-id`, the script queries `stock_refresh_requests` for the latest `pending` or `running` job for that ticker and re-attaches to it automatically.

### 8.5 GitHub Actions Workflow (`.github/workflows/scraper.yml`)

The workflow has two triggers:

**Scheduled (automatic):**

| Schedule | Mode | Description |
|---|---|---|
| Weekdays 16:30 WIB (09:30 UTC) | `--daily` | Prices + money flow, after IDX market close |
| Sunday 15:00 WIB (08:00 UTC) | `--weekly` | Stock universe refresh |
| 1st of month 14:00 WIB (07:00 UTC) | `--quarterly` | Financials + company profiles |

**`workflow_dispatch` (UI-triggered):**

Accepts inputs `mode`, `ticker`, and `job_id`. Called by `POST /api/stocks/[ticker]/refresh` via the GitHub REST API. Runs on `ubuntu-latest`, installs Python deps from `python/requirements.txt`, and executes:

```bash
cd python && python run_all.py --{mode} --ticker {ticker} --job-id {job_id}
```

Requires GitHub Secrets: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`.

---

## 9. New TypeScript Types

Add to `web/src/lib/types/api.ts`:

```typescript
export interface CompletenessCategory {
  score: number
  max: number
  detail: string           // human-readable e.g. "847 / 1250 days"
}

export interface ConfidenceCategory extends CompletenessCategory {
  failed_checks?: string[] // only for sanity_checks
}

export interface DataQuality {
  ticker: string
  completeness_score: number
  confidence_score: number
  score_version: string
  scores_updated_at: string | null
  last_scraped_at: string | null
  missing_categories: string[]

  completeness_breakdown: {
    price_history:        CompletenessCategory
    annual_coverage:      CompletenessCategory
    annual_quality:       CompletenessCategory
    quarterly_financials: CompletenessCategory
    quarterly_reports:    CompletenessCategory
    annual_reports:       CompletenessCategory
    company_profile:      CompletenessCategory
    board_commissioners:  CompletenessCategory
    shareholders:         CompletenessCategory
    corporate_events:     CompletenessCategory
    derived_metrics:      CompletenessCategory
  }

  confidence_breakdown: {
    freshness:       ConfidenceCategory
    source:          ConfidenceCategory
    sanity_checks:   ConfidenceCategory
    cross_source:    ConfidenceCategory
    scraper_success: ConfidenceCategory
  }
}

export interface RefreshJob {
  job_id: number
  status: 'pending' | 'running' | 'done' | 'failed'
  no_new_data: boolean
  completeness_before: number | null
  completeness_after:  number | null
  confidence_before:   number | null
  confidence_after:    number | null
  progress: {
    scraper: string
    status:  'waiting' | 'running' | 'done' | 'failed'
    rows_added:   number | null
    duration_ms:  number | null
  }[]
  finished_at: string | null
}
```

---

## 10. Open Questions

| # | Question | Resolution |
|---|---|---|
| OQ-1 | **Refresh execution model:** Vercel Functions can't spawn long Python processes. | ✅ **Resolved** — GitHub Actions `workflow_dispatch`. POST /api/refresh creates the job row then calls the GitHub REST API to trigger a runner. Scheduled batch runs also use GitHub Actions cron. See §8.5. |
| OQ-2 | **Score freshness:** Recompute scores live on every page load (query v_data_completeness) or only on scraper run? | Persist to `stocks` table on scraper run. Page load reads stored scores. |
| OQ-3 | **Confidence score storage:** Compute in Python (more flexibility) or in SQL view? | Python, in `score_calculator.py`. SQL view is too rigid for sanity checks. |
| OQ-4 | **Negative equity handling:** Several IDX stocks (especially banks) have edge cases. Flag or penalize? | Flag in confidence breakdown, do not penalize completeness. |
| OQ-5 | **Score versioning:** When formula weights change, should historical scores be recomputed? | Yes. Running `update_all_scores()` after any formula change is the migration. score_version column tracks which formula was used. |
| OQ-6 | **Corporate events scraper feasibility:** IDX keterbukaan informasi may require JS rendering. | Defer to Phase 2. Score the category as 0 until the scraper is built. |

---

## 11. Implementation Order

```
Phase 1 — Foundation (enable scoring on existing data)
  1. Add completeness_score, confidence_score, score_version, scores_updated_at to stocks table
  2. Update v_data_completeness view with new weights and officer/shareholder freshness CTEs
  3. Write score_calculator.py (Python) — completeness + confidence from existing tables
  4. Hook score_calculator into run_all.py end-of-run
  5. GET /api/stocks/[ticker]/completeness API route
  6. DataQualityPanel UI component (collapsed state only)
  7. Wire into stock detail page

Phase 2 — Extended data + breakdown
  8. Add company_documents table + document_links.py scraper
  9. Add corporate_events table + corporate_events.py scraper (if IDX allows)
  10. Expand DataQualityPanel to show full category breakdown (expanded state)
  11. Add alternative sources panel (static content, shown when categories = 0)

Phase 3 — Refresh flow
  12. Add stock_refresh_requests + refresh_scraper_progress tables
  13. POST /api/stocks/[ticker]/refresh (idempotent, triggers GitHub Actions)
  14. GET /api/stocks/[ticker]/refresh (active job check, for UI resume-on-mount)
  15. GET /api/stocks/[ticker]/refresh/[job_id] (polling endpoint)
  16. Refresh UI flow (modal → live per-scraper progress log → score diff)
  17. ✅ OQ-1 resolved — GitHub Actions workflow_dispatch (see §8.5)
  18. run_all.py --job-id flag + auto-detection + _run_tracked / _finalize_job helpers
  19. supabase_client.py refresh job helpers (get_pending_refresh_job, update_refresh_job, update_refresh_scraper_progress)
```

---

## 12. Figma / Design Reference

Colors follow existing project palette:
- Green: `#10B981` (Tailwind `green-500`)
- Amber: `#F59E0B` (Tailwind `amber-400`)
- Red: `#EF4444` (Tailwind `red-500`)
- Progress bar track: `#E5E7EB` (Tailwind `gray-200`)

Score badge style matches existing `Badge` component in `src/components/ui/badge.tsx`.
