# CLAUDE.md

## Project Overview

**IDX Stock Analyzer** is a personal stock analysis platform focused on the Indonesian Stock Exchange (IDX / Bursa Efek Indonesia). The core mission is to build a comprehensive, self-maintained **data pool** of Indonesian financial market data that serves as the backbone for analysis tools, dashboards, and decision-making features built on top.

This is a personal-use tool. There is no auth system, no multi-tenancy, no public-facing product concerns. Optimize for data completeness, accuracy, and developer convenience over scalability or user management.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     DATA ACQUISITION LAYER                      │
│                   (Python scripts, run locally)                 │
│                                                                 │
│  stock_universe.py ──── Tickers, sectors, listing metadata     │
│  daily_prices.py ────── OHLCV via yfinance                     │
│  financials.py ──────── Income, balance sheet, cash flow       │
│  financials_fallback.py  Stockbit fallback for missing periods  │
│  ratio_enricher.py ──── Computed ratios + CAGR rollups          │
│  money_flow.py ──────── Foreign flow, broker summary (IDX)      │
│  company_profiles.py ── Officers, shareholders                  │
│  shareholders_pdf.py ── Major shareholders from IDX PDFs        │
│  dividend_scraper.py ── Dividend history                        │
│  corporate_events.py ── Splits, rights issues, etc.             │
│  document_links.py ──── Filing URLs                             │
│  gap_filler.py ──────── Backfill missing rows across tables     │
└──────────────────────────────┬──────────────────────────────────┘
                               │ UPSERT via Supabase client
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                       DATA STORAGE LAYER                        │
│                          (Supabase)                             │
│                                                                 │
│  Tables (~30, see docs/schema-v*.sql for migrations):           │
│  stocks, daily_prices, financials_annual, financials_quarterly, │
│  money_flow, broker_summary, company_officers, shareholders,    │
│  dividends, corporate_events, market_phases, technical_signals, │
│  wyckoff_events, strategies, screener_*, valuations_cache,      │
│  ai_analysis, sector_templates, macro_context, …                │
└──────────────────────────────┬──────────────────────────────────┘
                               │ Read by analysis + scoring
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                  ANALYSIS & SCORING LAYER                       │
│                  (Python, run on schedule)                      │
│                                                                 │
│  scripts/analysis/                                              │
│    ├── market_phase_detector.py    Macro regime detection       │
│    ├── technical_signal_detector.py Price/volume signals        │
│    ├── wyckoff_detector.py         Wyckoff phases (v1)          │
│    └── wyckoff_detector_v2.py      FSM-based Wyckoff (v2)       │
│                                                                 │
│  scripts/scoring/                                               │
│    ├── context_builder.py    Assemble per-stock context bundle  │
│    ├── data_normalizer.py    Cross-source field reconciliation  │
│    ├── scoring_engine.py     Deterministic numeric scoring      │
│    └── ai_analyst.py         LLM-based qualitative analysis     │
│                                                                 │
│  Outputs written back to Supabase (wyckoff_events,              │
│  technical_signals, market_phases, ai_analysis, …)              │
└──────────────────────────────┬──────────────────────────────────┘
                               │ Read via Supabase JS client
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                    APPLICATION LAYER                            │
│                  (NextJS 16 on Vercel)                          │
│                                                                 │
│  Pages: /, /stock/[ticker], /compare, /investors,               │
│         /money-flow                                             │
│  API:   /api/stocks/[ticker]/{ai-analysis, wyckoff, phases,     │
│         broker, freshness, refresh, stockbit/{fetch,upsert}, …},│
│         /api/strategies, /api/investors/network, /api/search,   │
│         /api/admin/{macro-context, sector-template/[subsector]} │
│  Charts: lightweight-charts (price), Recharts (fundamentals),   │
│          react-force-graph-2d (investor network), mermaid       │
└─────────────────────────────────────────────────────────────────┘
```

## Tech Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Data scraping | Python 3.10+ | yfinance, curl_cffi, requests, pandas |
| Analysis & scoring | Python 3.10+ | numpy, pandas, custom FSM, LLM client |
| Database | Supabase (PostgreSQL) | Free tier, hosted; migrations in `docs/schema-v*.sql` |
| Frontend + Backend | NextJS 16 (App Router) + React 19 | Full-stack, deployed on Vercel |
| Supabase client (web) | `@supabase/ssr` + `@supabase/supabase-js` | SSR-aware client/server split |
| Charts | `lightweight-charts` (price), `recharts` (fundamentals), `react-force-graph-2d` (graphs), `mermaid` (diagrams) | Mixed depending on use case |
| Styling | Tailwind CSS | Utility-first |

## Data Sources

| Source | What It Provides | Access Method |
|--------|-----------------|---------------|
| Yahoo Finance (yfinance) | Price history, basic financials, dividends, holders, analyst targets | Python `yfinance` library, `.JK` suffix for IDX tickers |
| IDX Official API (idx.co.id) | Stock list, company profiles, financial reports, broker summary, trading info | HTTP via `curl_cffi` with browser impersonation |
| IDX shareholder PDFs | Major shareholders (>5%) | PDF parsing via `shareholders_pdf.py` |
| Stockbit | Fallback financials, ratios, analyst data | `stockbit_client.py` — **must run from owner's machine** (token is session/IP-bound; 401 from datacenter IPs) |
| Twelve Data | Complete IDX ticker/symbol list | Free API (8 calls/min, 800/day) |
| GitHub: nichsedge/idx-bei | Reference scraper for IDX endpoints | MIT, Python, curl_cffi |
| GitHub: noczero/idx-fundamental-analysis | Reference for Stockbit API patterns | — |
| GitHub: Rachdyan/idx_financial_report | Reference for quarterly report scraping | — |

### IDX API Endpoints (discovered from open-source scrapers)

These are unofficial endpoints used by idx.co.id's frontend. They require browser-like headers and may change without notice.

```
GET https://www.idx.co.id/umbraco/Surface/StockData/GetConstituent
GET https://www.idx.co.id/umbraco/Surface/ListedCompany/GetCompanyProfilesIndex?start=0&length=10&code={TICKER}
GET https://www.idx.co.id/umbraco/Surface/ListedCompany/GetFinancialReport?indexFrom=0&pageSize=10&year={YEAR}&reportType=rdf&periode={QUARTER}&kodeEmiten={TICKER}
GET https://www.idx.co.id/umbraco/Surface/ListedCompany/GetTradingInfoSS?code={TICKER}&length={DAYS}
GET https://www.idx.co.id/umbraco/Surface/TradingSummary/GetBrokerSummary?date={YYYY-MM-DD}&stockCode={TICKER}&board=
```

All IDX endpoints require:
- `curl_cffi` with `impersonate="chrome"` (regular `requests` gets blocked)
- Headers: User-Agent, Referer (https://www.idx.co.id/...), X-Requested-With: XMLHttpRequest

## Project Structure

```
idx-stock-analysis/
├── CLAUDE.md
├── Indonesian Stock Analysis Tool PRD.md
├── Smart Money Signal analysis.md
├── IDX_AI_Pipeline_FRD.docx
│
├── shared/                              # Cross-stack JSON config
│   ├── macro-context.json               # Macro regime context for AI analyst
│   └── scoring-config.json              # Scoring weights + thresholds
│
├── python/
│   ├── requirements.txt
│   ├── config.py
│   ├── run_all.py                       # Orchestrator
│   ├── test_feasibility.py
│   ├── simulate_phase6.py
│   ├── scrapers/                        # Data acquisition
│   │   ├── stock_universe.py
│   │   ├── daily_prices.py
│   │   ├── financials.py
│   │   ├── financials_fallback.py       # Stockbit fallback
│   │   ├── ratio_enricher.py
│   │   ├── money_flow.py
│   │   ├── company_profiles.py
│   │   ├── shareholders_pdf.py
│   │   ├── dividend_scraper.py
│   │   ├── corporate_events.py
│   │   ├── document_links.py
│   │   └── gap_filler.py
│   ├── scripts/
│   │   ├── analysis/                    # Detection layer
│   │   │   ├── market_phase_detector.py
│   │   │   ├── technical_signal_detector.py
│   │   │   ├── wyckoff_detector.py      # v1
│   │   │   ├── wyckoff_detector_v2.py   # v2 FSM (current)
│   │   │   └── wyckoff_*_diagnostic.py
│   │   └── scoring/                     # AI analyst pipeline
│   │       ├── config.py
│   │       ├── schema.py
│   │       ├── data_cleaner.py
│   │       ├── data_normalizer.py
│   │       ├── context_builder.py
│   │       ├── scoring_engine.py
│   │       └── ai_analyst.py
│   ├── utils/
│   │   ├── idx_client.py
│   │   ├── stockbit_client.py
│   │   ├── stockbit_fetch_cli.py
│   │   ├── token_manager.py
│   │   ├── yfinance_analyst_cli.py
│   │   ├── score_calculator.py
│   │   ├── supabase_client.py
│   │   └── helpers.py
│   ├── tests/                           # pytest, see python/pytest.ini
│   └── data/                            # Local artifacts (PDFs, etc.)
│
├── web/                                 # NextJS 16 application
│   ├── package.json
│   ├── src/
│   │   ├── app/
│   │   │   ├── layout.tsx
│   │   │   ├── page.tsx                 # Home / watchlist
│   │   │   ├── stock/[ticker]/
│   │   │   ├── compare/
│   │   │   ├── investors/
│   │   │   ├── money-flow/
│   │   │   └── api/
│   │   │       ├── search/
│   │   │       ├── strategies/{,[id]/{,count}}/
│   │   │       ├── investors/network/
│   │   │       ├── admin/{macro-context,sector-template/[subsector]}/
│   │   │       └── stocks/[ticker]/
│   │   │           ├── ai-analysis/
│   │   │           ├── trigger-ai-analysis/
│   │   │           ├── wyckoff/
│   │   │           ├── phases/
│   │   │           ├── broker/
│   │   │           ├── analyst/
│   │   │           ├── freshness/
│   │   │           ├── context-quality/
│   │   │           ├── domain-notes/
│   │   │           ├── pipeline-debug/
│   │   │           ├── raw-data/[table]/
│   │   │           ├── refresh/{,local,[job_id]}/
│   │   │           └── stockbit/{fetch,upsert}/
│   │   ├── components/
│   │   │   ├── charts/                  # lightweight-charts + Recharts
│   │   │   ├── stock/                   # Stock detail page widgets
│   │   │   ├── analytics/
│   │   │   ├── compare/
│   │   │   ├── home/
│   │   │   ├── investors/
│   │   │   ├── money-flow/
│   │   │   ├── nav/
│   │   │   └── ui/
│   │   └── lib/
│   │       ├── supabase/{client,server}.ts
│   │       ├── queries/                 # Per-domain query helpers
│   │       ├── calculations/            # cagr, valuation, formatters, …
│   │       ├── types/{api,database,network}.ts
│   │       ├── analytics.ts
│   │       ├── broker-constants.ts
│   │       ├── watchlists.ts
│   │       └── constants.ts
│   └── public/
│
├── supabase/                            # Reserved for Supabase CLI artifacts
│
└── docs/
    ├── data_dictionary.md
    ├── SCRAPING_PLAYBOOK.md
    ├── frd-data-completeness-confidence.md
    ├── wyckoff_detector_v2_spec.md
    ├── Wyckoff_Phase_Detection_FRD.docx
    ├── schema.sql                       # Base schema
    └── schema-v{2..27}-*.sql            # Numbered migrations
```

## Key Conventions

### Data

- All monetary values stored in IDR (Indonesian Rupiah) as BIGINT (no decimals for currency)
- All ratios/percentages stored as DECIMAL, e.g., 15.5% stored as 15.5 (not 0.155)
- Dates stored as DATE or TIMESTAMP WITH TIME ZONE
- Tickers stored WITHOUT the `.JK` suffix (e.g., `BBRI` not `BBRI.JK`). The `.JK` suffix is appended only when calling yfinance.
- Financial periods: year INTEGER + quarter INTEGER (1-4). Annual data uses quarter = 0.
- All scraper scripts are idempotent — safe to re-run. Use UPSERT (ON CONFLICT UPDATE) for all inserts.

### Code

- Python scripts: snake_case, type hints encouraged, logging via Python `logging` module
- NextJS: TypeScript, App Router, server components by default
- Supabase queries in NextJS go through `@/lib/queries/*` (per-domain) using the SSR-safe client from `@/lib/supabase/{client,server}`
- Charts: pick the right tool — `lightweight-charts` for price/volume time series, Recharts for fundamentals (bar/line/area), `react-force-graph-2d` for investor relationship graphs
- Color palette: blue=#3B82F6, green=#10B981, purple=#8B5CF6 (consistent across Recharts)

### Schema Migrations

- Schema lives in [docs/](docs/) as numbered SQL files: `schema.sql` (base) + `schema-vN-<name>.sql` for each migration
- Current head is **v27** ([docs/schema-v27-wyckoff-v2-1.sql](docs/schema-v27-wyckoff-v2-1.sql))
- Add a new migration as `schema-v{N+1}-<short-name>.sql`; never edit a previously-applied migration
- Migrations are applied manually via the Supabase SQL editor (no automated tool); keep each one self-contained and idempotent (`IF NOT EXISTS`, `ON CONFLICT`, etc.) where feasible
- Update [docs/data_dictionary.md](docs/data_dictionary.md) whenever a migration adds/changes columns

### SSR Hydration Safety (CRITICAL)

This project has strict SSR requirements. **Every component must produce identical HTML on server and client during the initial render.** Hydration mismatches cause React errors, visual flicker, and broken interactivity.

#### Banned Patterns — NEVER use these in render output:

| Pattern | Why it breaks | Use instead |
|---------|--------------|-------------|
| `toLocaleString('id-ID')` | Node.js and browser ICU produce different output | `fmtNumID()` from `lib/calculations/formatters` |
| `Intl.NumberFormat('id-ID')` | Same locale divergence as above | `fmtNumID()`, `formatIDRCompact()` |
| `new Date()` / `Date.now()` in render | Server time ≠ client time | Guard behind `mounted` state, or use static placeholder |
| `Math.random()` in render | Different on every execution | Use deterministic IDs, or guard behind `mounted` |
| `<input type="date">` with empty value | Browser normalizes date inputs differently | Render only after `mounted` is true |
| `new Date().getFullYear()` at module scope | Can differ at year boundary between server/client | Use a hardcoded constant, update annually |

#### Required: Deterministic Number Formatting

**All number formatting must use the deterministic formatters in `lib/calculations/formatters.ts`:**

```typescript
// ✅ CORRECT — deterministic, SSR-safe
import { fmtNumID, formatIDRCompact, formatPercent } from '@/lib/calculations/formatters'
fmtNumID(1234567)           // "1.234.567"
formatIDRCompact(1500000)   // "1.5Jt"
formatPercent(15.5)         // "15.5%"

// ❌ WRONG — locale-dependent, causes hydration mismatch
value.toLocaleString('id-ID')
new Intl.NumberFormat('id-ID').format(value)
```

`fmtNumID()` uses regex-based thousand separators (`.`) and decimal commas (`,`) — identical output in Node.js and all browsers.

#### Required: Mounted Guard Pattern

Any component rendering browser-only content (Recharts, Mermaid, date inputs, time-dependent values) must use:

```typescript
const [mounted, setMounted] = useState(false)
useEffect(() => setMounted(true), [])

// For chart components — show skeleton during SSR:
if (!mounted) return <ChartSkeleton height={300} />

// For inline elements — conditionally render:
{mounted && <input type="date" ... />}
{mounted ? relativeTime(timestamp) : '—'}
```

- **Never use `ssr: false`** with `next/dynamic`. It is forbidden in Server Components.
- All chart components are `'use client'` and handle their own mount guard internally.
- SSR renders the skeleton/placeholder; interactive content hydrates after mount.

#### Checklist Before Every Component

Before writing or modifying any component, verify:

1. **No locale-dependent formatting** — grep for `toLocaleString`, `Intl.NumberFormat`
2. **No time-dependent render values** — grep for `new Date()`, `Date.now()`, `Math.random()`
3. **Browser-only inputs guarded** — `<input type="date">`, `<input type="time">` behind `mounted`
4. **Chart/visualization libraries guarded** — Recharts, Mermaid, D3, lightweight-charts, react-force-graph-2d behind `mounted`
5. **Tooltip/formatter callbacks null-safe** — Recharts passes `null` for missing data points

### Scraping Etiquette

- Rate limit all scrapers: minimum 0.5s between requests
- IDX endpoints: maximum 2 requests/second
- yfinance bulk downloads: batch 50–100 tickers per call
- Always include User-Agent header
- Cache aggressively — financial data doesn't change intraday

### Where Things Run

| Job | Where it can run | Why |
|-----|------------------|-----|
| yfinance scrapers, IDX scrapers, analysis (Wyckoff, market phase, technical signals), scoring engine | Owner's machine **or** GH Actions / Vercel cron | Public endpoints, no IP binding |
| Stockbit-dependent scrapers (`financials_fallback.py`, `stockbit_client.py` paths, analyst CLIs) | **Owner's machine only** | Stockbit bearer tokens are session/IP-bound — 401 from datacenter IPs even with valid `exp` |
| AI analyst (`scripts/scoring/ai_analyst.py`) | Anywhere with API keys | Calls external LLM; no IP binding |

## Analysis & AI Analyst Pipeline

The analysis layer turns raw financial/price data into derived signals. It runs on schedule and writes back to Supabase, which the web app reads.

### Detection (`python/scripts/analysis/`)

- **Market phase detector** — classifies the macro regime per stock/index using `daily_prices` + `financials_*`. Output: `market_phases` table.
- **Technical signal detector** — price/volume rule-based signals. Output: `technical_signals` table.
- **Wyckoff detector v1** — original heuristic phase detector.
- **Wyckoff detector v2** — FSM-based phase detector with structural events; runs side-by-side with v1 (toggle in screener / stock page) until v2 is validated. Spec: [docs/wyckoff_detector_v2_spec.md](docs/wyckoff_detector_v2_spec.md). Output: `wyckoff_events` (per-event) + denormalized current phase on `stocks`.

### Scoring + AI analyst (`python/scripts/scoring/`)

Pipeline order, per ticker:

1. **`data_cleaner` / `data_normalizer`** — reconcile fields across yfinance / IDX / Stockbit (different units, naming, missing periods).
2. **`context_builder`** — assemble a per-stock context bundle: financials snapshot, ratios, peer comparison, market phase, Wyckoff state, macro context (from [shared/macro-context.json](shared/macro-context.json)), sector template.
3. **`scoring_engine`** — deterministic numeric scoring driven by [shared/scoring-config.json](shared/scoring-config.json). Produces sub-scores (fundamentals, valuation, momentum, smart money) + composite.
4. **`ai_analyst`** — passes the bundle to an LLM for qualitative analysis, narrative, risks. Output: `ai_analysis` table; cached and refreshed on demand via `/api/stocks/[ticker]/trigger-ai-analysis`.

The web app surfaces the result on the stock detail page; admins can edit `macro-context` and `sector-template` via `/api/admin/...` to influence future runs.

## Active Workstreams

- **Wyckoff v1 → v2 migration** — both detectors run; v2 FSM is being validated against v1 on real data. Toggle remains until confidence is high enough to retire v1.
- **AI analyst quality** — refining `context_builder` inputs and `scoring-config` weights based on observed outputs.
- **Data completeness** — `gap_filler.py` + `financials_fallback.py` (Stockbit) chase missing periods.
- **Schema is at v27**; new migrations land as `schema-v{N+1}-*.sql` in `docs/`.

## Related Prior Work

The owner previously built a **Dividend Investment Dashboard** (`Dashboard_Investasi_Dividen_untuk_Pensiun.tsx`) — a React component with IDR currency formatting, Recharts visualizations, and Indonesian-language UI. Used as a design reference for the analyzer.

## Decision Log

| Decision | Choice | Reasoning |
|----------|--------|-----------|
| Primary user | Personal use only | No auth, no rate limiting, scraping is viable |
| Priority features | Fundamental analysis + Money flow + Wyckoff phase | Most actionable for investment decisions |
| Data cost | Free sources only (scraping) | Personal project, cost-conscious |
| Architecture | Monolithic NextJS + local Python | Simple, maintainable, no microservices overhead |
| Stock coverage | All IDX stocks (800+) | Comprehensive data pool > selective coverage |
| Data processing split | Heavy scraping + analysis in Python; light fetches in NextJS API routes | Best of both: Python's libraries + NextJS convenience |
| Database | Supabase (PostgreSQL) | Already familiar, free tier, good JS/Python clients |
| Schema versioning | Numbered SQL files in `docs/schema-v*.sql`, applied manually | Simple, reviewable in git, no migration tool overhead |
| Deployment | Vercel (NextJS) | Free tier, seamless NextJS deployment |
| Stockbit-dependent jobs | Run only on owner's machine | Stockbit tokens are session/IP-bound — 401 from datacenter IPs |
| Wyckoff detector | Keep v1 + v2 FSM side-by-side via version toggle | Validate v2 on production data before retiring v1 |
| Price chart library | `lightweight-charts` for price; Recharts for fundamentals | Lightweight-charts is purpose-built for OHLCV; Recharts is better for bar/line fundamentals |
| AI analyst inputs | Externalized in `shared/macro-context.json` + `shared/scoring-config.json` | Editable without code changes; admin API routes can update them |
| Supabase client (web) | `@supabase/ssr` with split `client.ts` / `server.ts` | Required for SSR-safe auth & cookies in App Router |
