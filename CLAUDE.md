# CLAUDE.md

## Project Overview

**IDX Stock Analyzer** is a personal stock analysis platform focused on the Indonesian Stock Exchange (IDX / Bursa Efek Indonesia). The core mission is to build a comprehensive, self-maintained **data pool** of Indonesian financial market data that serves as the backbone for analysis tools, dashboards, and decision-making features built on top.

This is a personal-use tool. There is no auth system, no multi-tenancy, no public-facing product concerns. Optimize for data completeness, accuracy, and developer convenience over scalability or user management.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     DATA ACQUISITION LAYER                      │
│                   (Python scripts, run locally)                  │
│                                                                 │
│  stock_universe.py ─── Company profiles, tickers, sectors       │
│  daily_prices.py ───── OHLCV + volume via yfinance              │
│  financials.py ─────── Income, balance sheet, cash flow         │
│  money_flow.py ─────── Foreign flow, broker summary (IDX)       │
│  company_profiles.py ─ Directors, commissioners, shareholders   │
└──────────────────────────────┬──────────────────────────────────┘
                               │ Push via Supabase client
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                     DATA STORAGE LAYER                          │
│                        (Supabase)                               │
│                                                                 │
│  PostgreSQL tables: stocks, daily_prices, financials_annual,    │
│  financials_quarterly, money_flow, broker_summary,              │
│  company_officers, shareholders, news, valuations_cache         │
└──────────────────────────────┬──────────────────────────────────┘
                               │ Read via Supabase JS client
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                    APPLICATION LAYER                             │
│                  (NextJS on Vercel)                              │
│                                                                 │
│  API Routes: /api/stocks, /api/calculate/*, /api/search         │
│  Pages: /dashboard, /stock/[ticker], /compare, /screener        │
│  Charts: Recharts (line, bar, pie, area)                        │
└─────────────────────────────────────────────────────────────────┘
```

## Tech Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Data scraping | Python 3.10+ | yfinance, curl_cffi, requests, pandas |
| Database | Supabase (PostgreSQL) | Free tier, hosted |
| Frontend + Backend | NextJS (App Router) | Full-stack, deployed on Vercel |
| Charts | Recharts | Already used in prior dividend dashboard project |
| Styling | Tailwind CSS | Utility-first |

## Data Sources

| Source | What It Provides | Access Method |
|--------|-----------------|---------------|
| Yahoo Finance (yfinance) | Price history, basic financials, dividends, holders | Python `yfinance` library, `.JK` suffix for IDX tickers |
| IDX Official API (idx.co.id) | Stock list, company profiles, financial reports, broker summary, trading info | HTTP requests with browser impersonation via `curl_cffi` |
| Twelve Data | Complete IDX ticker/symbol list | Free API (8 calls/min, 800/day) |
| GitHub: nichsedge/idx-bei | Reference scraper for IDX endpoints, company profiles, financial ratios | MIT licensed, Python, uses curl_cffi |
| GitHub: noczero/idx-fundamental-analysis | Stockbit + yfinance fundamental data | Reference for Stockbit API patterns |
| GitHub: Rachdyan/idx_financial_report | Raw financial statements from IDX | Reference for quarterly report scraping |

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
├── CLAUDE.md                          # This file
├── PRD.md                             # Product requirements document
│
├── python/                            # Data acquisition scripts (run locally)
│   ├── requirements.txt
│   ├── config.py                      # Supabase credentials, API keys
│   ├── scrapers/
│   │   ├── stock_universe.py          # Fetch all IDX tickers + metadata
│   │   ├── daily_prices.py            # Daily OHLCV via yfinance
│   │   ├── financials.py              # Annual + quarterly financial statements
│   │   ├── money_flow.py              # Foreign flow + broker summary
│   │   └── company_profiles.py        # Officers, shareholders, company info
│   ├── utils/
│   │   ├── idx_client.py              # IDX API client with curl_cffi
│   │   ├── supabase_client.py         # Supabase insert/upsert helpers
│   │   └── helpers.py                 # Formatting, retry logic, logging
│   └── run_all.py                     # Orchestrator to run all scrapers
│
├── web/                               # NextJS application
│   ├── package.json
│   ├── next.config.js
│   ├── tailwind.config.js
│   ├── src/
│   │   ├── app/
│   │   │   ├── layout.tsx
│   │   │   ├── page.tsx               # Dashboard home / watchlist
│   │   │   ├── stock/[ticker]/
│   │   │   │   └── page.tsx           # Single stock analysis
│   │   │   ├── compare/
│   │   │   │   └── page.tsx           # Peer comparison
│   │   │   └── api/
│   │   │       ├── stocks/route.ts    # Stock list + search
│   │   │       └── calculate/
│   │   │           └── valuation/route.ts
│   │   ├── components/
│   │   │   ├── charts/                # Recharts wrappers
│   │   │   ├── tables/                # Data tables
│   │   │   └── ui/                    # Shared UI components
│   │   └── lib/
│   │       ├── supabase.ts            # Supabase client config
│   │       ├── types.ts               # TypeScript types matching DB schema
│   │       └── calculations/          # Valuation models, ratio computations
│   └── public/
│
└── docs/                              # Documentation
    └── data_dictionary.md             # Field definitions for every table
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
- Supabase queries in NextJS use the `@supabase/supabase-js` client
- Currency formatting: `Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR' })`
- Charts: Recharts with consistent color palette (blue=#3B82F6, green=#10B981, purple=#8B5CF6)

### SSR & Chart Rendering

- **Never use `ssr: false`** with `next/dynamic`. It is forbidden in Server Components and breaks SSR.
- Chart components that use browser-only libraries (Recharts) must use the **mounted guard** pattern for SSR compatibility:
  ```typescript
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  if (!mounted) return <ChartSkeleton height={300} />
  ```
- SSR renders the skeleton; Recharts hydrates on the client after mount. No `dynamic()` wrapper needed.
- All chart components are `'use client'` and handle their own mount guard internally.

### Scraping Etiquette

- Rate limit all scrapers: minimum 0.5s between requests
- IDX endpoints: maximum 2 requests/second
- yfinance bulk downloads: batch 50-100 tickers per call
- Always include User-Agent header
- Cache aggressively — financial data doesn't change intraday

## Current Status

- [x] Data source research and evaluation complete
- [x] Architecture decisions made (Python local + NextJS + Supabase)
- [x] Feasibility test script created (pending local execution)
- [ ] Feasibility test run and results analyzed
- [ ] Supabase database schema designed
- [ ] Python scraper scripts built
- [ ] Data pipeline operational
- [ ] NextJS dashboard built

## Related Prior Work

The owner previously built a **Dividend Investment Dashboard** (`Dashboard_Investasi_Dividen_untuk_Pensiun.tsx`) — a React component with:
- IDR currency formatting
- Recharts-based visualizations (bar, line charts)
- Financial simulation logic (compound growth, reinvestment, coverage ratios)
- Indonesian language interface

This serves as a design reference and proof of capability. The stock analysis tool follows similar patterns but reads from a live database instead of user-inputted parameters.

## Decision Log

| Decision | Choice | Reasoning |
|----------|--------|-----------|
| Primary user | Personal use only | No auth, no rate limiting, scraping is viable |
| Priority features | Fundamental analysis + Money flow | Most actionable for investment decisions |
| Data cost | Free sources only (scraping) | Personal project, cost-conscious |
| Architecture | Monolithic NextJS + local Python | Simple, maintainable, no microservices overhead |
| Stock coverage | All IDX stocks (800+) | Comprehensive data pool > selective coverage |
| Data processing split | Python local for heavy scraping, NextJS API for light fetches | Best of both: Python's scraping libraries + NextJS convenience |
| Database | Supabase (PostgreSQL) | Already familiar, free tier, good JS/Python clients |
| Deployment | Vercel (NextJS) | Free tier, seamless NextJS deployment |
