# Product Requirements Document (PRD)

# IDX Stock Analyzer — Data Backbone

**Version:** 2.0
**Author:** Nailul
**Last Updated:** March 2026
**Status:** Active Development — Phases 1–4 complete, Phase 5 in progress

---

## 1. Vision

Build a comprehensive, self-maintained data pool of Indonesian stock market data that serves as a **foundation layer** for any financial analysis, visualization, or decision-making tool we want to build — now or in the future.

The data backbone is the product. Dashboards, screeners, valuation calculators, and sentiment trackers are consumers that sit on top of it. If the data layer is solid, any application can be built quickly and reliably.

```
          ┌──────────────────────────────────────────────────────┐
          │              BUILT APPLICATIONS  ✅                   │
          │                                                      │
          │  • Stock Screener (home page, advanced filters)      │
          │  • Fundamental Dashboard (25-widget stock detail)    │
          │  • Money Flow Tracker (foreign, broker, anomalies)   │
          │  • Valuation Engine (Graham, DCF, margin of safety)  │
          │  • Smart Money Signals (bandar, insider, confidence) │
          │  • Shareholder Network Graph (force-graph viz)       │
          │  • Peer Comparison (multi-stock side-by-side)        │
          │  • Dividend History Viewer                           │
          ├──────────────────────────────────────────────────────┤
          │              PLANNED / IN PROGRESS  🔄               │
          │                                                      │
          │  • News Aggregation + Sentiment Analysis             │
          │  • Portfolio Tracker                                  │
          │  • Alerting System                                   │
          │  • AI-Powered Research Assistant                      │
          └────────────────────────┬─────────────────────────────┘
                                   │ reads from
          ┌────────────────────────▼─────────────────────────────┐
          │               DATA BACKBONE  ✅                       │
          │        (Operational — 12 scrapers, 15+ tables)       │
          │                                                      │
          │  Complete, clean, structured,                         │
          │  queryable Indonesian stock data                      │
          └──────────────────────────────────────────────────────┘
```

---

## 2. Goals & Non-Goals

### Goals

1. **Comprehensive coverage** — All 800+ IDX-listed stocks, not a curated subset. The data pool should be complete enough that any stock question can be answered by querying it.

2. **Historical depth** — Up to 10 years of financial statements (Stockbit), 5+ years of daily prices (yfinance), and as far back as we can go for dividends and corporate actions.

3. **Data freshness** — Daily prices updated end-of-day. Financial statements updated quarterly. Company profiles updated quarterly. Broker/money flow data updated daily.

4. **Structured and queryable** — Data stored in well-normalized PostgreSQL tables with clear relationships. Any question like "show me all banking stocks with ROE > 15% and D/E < 2" should be answerable with a single SQL query.

5. **Self-maintainable** — Scraper scripts that can be run manually or via cron. When a scraper breaks (they will), it should be obvious what broke and fixable within an hour.

6. **Foundation for multiple applications** — The schema should not be designed around one specific dashboard. It should be a general-purpose financial data store.

7. **Developer experience** — Single-ticker refresh from the UI, per-scraper job tracking, automated gap detection and filling, completeness/confidence scoring per stock.

### Non-Goals (for now)

- Real-time or intraday data (end-of-day is sufficient)
- Multi-user access or authentication
- Public-facing product or commercial use
- Mobile app (responsive web is fine)
- Automated trading or order execution
- Data redistribution or API for others

---

## 3. Data Architecture

### 3.1 Five-Layer Data Model

The data backbone is organized in five layers, from most static to most dynamic:

#### Layer 1: Stock Universe (refreshed weekly)

The master list of all IDX-listed stocks with basic metadata.

**Table: `stocks`**

| Field | Type | Description |
|-------|------|-------------|
| ticker | TEXT (PK) | Stock code, e.g., `BBRI` |
| name | TEXT | Full company name |
| sector | TEXT | IDX sector classification |
| subsector | TEXT | IDX subsector |
| listing_date | DATE | IPO / listing date |
| listed_shares | BIGINT | Total shares outstanding |
| market_cap | BIGINT | Latest market cap in IDR |
| board | TEXT | Main / Development / Acceleration |
| is_lq45 | BOOLEAN | Member of LQ45 index |
| is_idx30 | BOOLEAN | Member of IDX30 index |
| status | TEXT | Active / Suspended / Delisted |
| completeness_score | DECIMAL | 0–100, auto-computed data completeness |
| confidence_score | DECIMAL | 0–100, auto-computed data confidence |
| last_updated | TIMESTAMPTZ | When this row was last refreshed |

**Source:** Twelve Data API (ticker list) + IDX API (metadata)

#### Layer 2: Daily Market Data (refreshed daily)

End-of-day price, volume, and transaction data for every stock.

**Table: `daily_prices`**

| Field | Type | Description |
|-------|------|-------------|
| id | BIGSERIAL (PK) | Auto-increment |
| ticker | TEXT (FK → stocks) | Stock code |
| date | DATE | Trading date |
| open | DECIMAL | Opening price |
| high | DECIMAL | Highest price |
| low | DECIMAL | Lowest price |
| close | DECIMAL | Closing price |
| volume | BIGINT | Shares traded |
| value | BIGINT | Transaction value in IDR |
| frequency | INTEGER | Number of transactions |
| foreign_buy | BIGINT | Foreign buy value (IDR) |
| foreign_sell | BIGINT | Foreign sell value (IDR) |
| foreign_net | BIGINT | Net foreign flow (IDR) |
| — | — | — |
| UNIQUE | (ticker, date) | One row per stock per day |

**Source:** yfinance (OHLCV) + IDX API (foreign flow, value, frequency)

#### Layer 3: Financial Statements (refreshed quarterly)

Annual and quarterly income statements, balance sheets, and cash flow statements.

**Table: `financials`**

| Field | Type | Description |
|-------|------|-------------|
| id | SERIAL (PK) | Auto-increment |
| ticker | TEXT (FK → stocks) | Stock code |
| year | INTEGER | Fiscal year |
| quarter | INTEGER | 0 = annual, 1-4 = quarterly |
| period_end | DATE | End date of the reporting period |
| — Income Statement — | — | — |
| revenue | BIGINT | Total revenue |
| cost_of_revenue | BIGINT | COGS |
| gross_profit | BIGINT | Gross profit |
| operating_expense | BIGINT | Total operating expenses |
| operating_income | BIGINT | Operating income / EBIT |
| interest_expense | BIGINT | Interest expense |
| income_before_tax | BIGINT | Pre-tax income |
| tax_expense | BIGINT | Tax |
| net_income | BIGINT | Net income |
| eps | DECIMAL | Earnings per share |
| — Balance Sheet — | — | — |
| total_assets | BIGINT | Total assets |
| current_assets | BIGINT | Current assets |
| total_liabilities | BIGINT | Total liabilities |
| current_liabilities | BIGINT | Current liabilities |
| total_equity | BIGINT | Total shareholders' equity |
| total_debt | BIGINT | Short-term + long-term debt |
| cash_and_equivalents | BIGINT | Cash and cash equivalents |
| book_value_per_share | DECIMAL | Equity / shares outstanding |
| — Cash Flow — | — | — |
| operating_cash_flow | BIGINT | Cash from operations |
| capex | BIGINT | Capital expenditures |
| free_cash_flow | BIGINT | OCF - capex |
| dividends_paid | BIGINT | Cash dividends paid |
| investing_cash_flow | BIGINT | Cash from investing activities |
| financing_cash_flow | BIGINT | Cash from financing activities |
| — Balance Sheet (extended) — | — | — |
| short_term_debt | BIGINT | Short-term borrowings |
| long_term_debt | BIGINT | Long-term borrowings |
| net_debt | BIGINT | Total debt − cash |
| working_capital | BIGINT | Current assets − current liabilities |
| — Core Ratios — | — | — |
| gross_margin | DECIMAL | Gross profit / revenue (%) |
| operating_margin | DECIMAL | Operating income / revenue (%) |
| net_margin | DECIMAL | Net income / revenue (%) |
| roe | DECIMAL | Return on equity (%) |
| roa | DECIMAL | Return on assets (%) |
| current_ratio | DECIMAL | Current assets / current liabilities |
| debt_to_equity | DECIMAL | Total debt / equity |
| pe_ratio | DECIMAL | Price / EPS |
| pbv_ratio | DECIMAL | Price / book value |
| dividend_yield | DECIMAL | Dividend per share / price (%) |
| payout_ratio | DECIMAL | Dividends paid / net income (%) |
| — Advanced Ratios (V8) — | — | — |
| roce | DECIMAL | Return on capital employed (%) |
| roic | DECIMAL | Return on invested capital (%) |
| interest_coverage | DECIMAL | EBIT / interest expense (×) |
| asset_turnover | DECIMAL | Revenue / total assets (×) |
| inventory_turnover | DECIMAL | COGS / inventory (×) |
| lt_debt_to_equity | DECIMAL | Long-term debt / equity |
| total_liabilities_to_equity | DECIMAL | Total liabilities / equity |
| debt_to_assets | DECIMAL | Total debt / total assets |
| financial_leverage | DECIMAL | Total assets / equity (×) |
| ps_ratio | DECIMAL | Price / sales |
| ev_ebitda | DECIMAL | Enterprise value / EBITDA |
| earnings_yield | DECIMAL | EPS / price (%) |
| — | — | — |
| source | TEXT | `stockbit`, `yfinance`, `idx`, `manual` |
| last_updated | TIMESTAMPTZ | When this row was last refreshed |
| UNIQUE | (ticker, year, quarter) | One row per stock per period |

**Source:** Stockbit (primary, up to 10 years) + yfinance (fallback, ~4 years)

#### Layer 4: Company Profiles (refreshed quarterly)

Detailed company information, management, and ownership structure.

**Table: `company_profiles`**

| Field | Type | Description |
|-------|------|-------------|
| ticker | TEXT (PK, FK → stocks) | Stock code |
| description | TEXT | Company business description |
| website | TEXT | Company website URL |
| address | TEXT | Registered address |
| phone | TEXT | Contact phone |
| email | TEXT | Contact email |
| npwp | TEXT | Tax ID |
| listing_date | DATE | Date of IPO |
| registry_agency | TEXT | Share registrar |
| last_updated | TIMESTAMPTZ | — |

**Table: `company_officers`**

| Field | Type | Description |
|-------|------|-------------|
| id | SERIAL (PK) | — |
| ticker | TEXT (FK → stocks) | Stock code |
| name | TEXT | Person's name |
| role | TEXT | `director`, `commissioner`, `committee` |
| title | TEXT | Specific title (President Director, etc.) |
| is_independent | BOOLEAN | Independent commissioner flag |
| last_updated | TIMESTAMPTZ | — |

**Table: `shareholders`**

| Field | Type | Description |
|-------|------|-------------|
| id | SERIAL (PK) | — |
| ticker | TEXT (FK → stocks) | Stock code |
| holder_name | TEXT | Name of shareholder |
| holder_type | TEXT | `institution`, `individual`, `government`, `public` |
| shares_held | BIGINT | Number of shares |
| percentage | DECIMAL | Ownership percentage |
| snapshot_date | DATE | Date of the data |
| last_updated | TIMESTAMPTZ | — |

**Table: `shareholders_major`** (historical snapshots of holders ≥1%)

| Field | Type | Description |
|-------|------|-------------|
| id | SERIAL (PK) | — |
| ticker | TEXT (FK → stocks) | Stock code |
| report_date | DATE | Date of the ownership snapshot |
| holder_name | TEXT | Name of shareholder |
| holder_type | TEXT | `institution`, `individual`, `government`, `foreign`, `public` |
| shares_held | BIGINT | Number of shares |
| percentage | DECIMAL | Ownership percentage |
| source | TEXT | `pdf_upload`, `excel_upload`, `idx_api` |
| last_updated | TIMESTAMPTZ | — |
| — | — | — |
| UNIQUE | (ticker, report_date, holder_name) | One row per holder per snapshot |

**Views:**
- `v_shareholders_major_latest` — most recent snapshot per ticker
- `v_shareholders_major_snapshots` — available report dates + coverage stats

**Source:** IDX API company profiles endpoint + PDF/Excel bulk upload (`shareholders_pdf.py`)

#### Layer 5: Money Flow & Broker Data (refreshed daily)

Broker-level trading activity, smart money signals, and insider transactions.

**Table: `broker_summary`** (IDX API legacy — combined totals only)

| Field | Type | Description |
|-------|------|-------------|
| id | BIGSERIAL (PK) | — |
| ticker | TEXT (FK → stocks) | Stock code |
| date | DATE | Trading date |
| broker_code | TEXT | Broker code (e.g., `YP`, `MS`, `CC`) |
| broker_name | TEXT | Full broker name |
| buy_volume | BIGINT | Shares bought |
| buy_value | BIGINT | Buy value in IDR |
| sell_volume | BIGINT | Shares sold |
| sell_value | BIGINT | Sell value in IDR |
| net_volume | BIGINT | Net shares |
| net_value | BIGINT | Net value in IDR |
| — | — | — |
| UNIQUE | (ticker, date, broker_code) | One row per stock per broker per day |

**Source:** IDX broker summary endpoint

**Table: `broker_flow`** (Stockbit — per-broker buy/sell split with broker type)

| Field | Type | Description |
|-------|------|-------------|
| ticker | VARCHAR(10) (FK → stocks) | Stock code |
| trade_date | DATE | Trading date |
| broker_code | VARCHAR(10) | Broker code |
| broker_type | VARCHAR(15) | `Lokal`, `Asing`, `Pemerintah` |
| buy_lot | BIGINT | Lots bought |
| sell_lot | BIGINT | Lots sold |
| buy_value | BIGINT | Buy value in IDR |
| sell_value | BIGINT | Sell value in IDR |
| buy_avg_price | DECIMAL | Average buy price |
| sell_avg_price | DECIMAL | Average sell price |
| net_lot | BIGINT (GENERATED) | buy_lot − sell_lot |
| net_value | BIGINT (GENERATED) | buy_value − sell_value |
| — | — | — |
| PRIMARY KEY | (ticker, trade_date, broker_code) | — |

**Source:** Stockbit marketdetectors API

**Table: `bandar_signal`** (Stockbit — accumulation/distribution detection)

| Field | Type | Description |
|-------|------|-------------|
| ticker | VARCHAR(10) (FK → stocks) | Stock code |
| trade_date | DATE | Trading date |
| broker_accdist | VARCHAR(20) | Overall acc/dist signal (e.g., `Big Acc`, `Dist`) |
| top1_accdist | VARCHAR(20) | Top 1 broker signal |
| top3_accdist | VARCHAR(20) | Top 3 brokers signal |
| top5_accdist | VARCHAR(20) | Top 5 brokers signal |
| top10_accdist | VARCHAR(20) | Top 10 brokers signal |
| total_buyer | INTEGER | Number of distinct buying brokers |
| total_seller | INTEGER | Number of distinct selling brokers |
| total_value | BIGINT | Total trading value |
| total_volume | BIGINT | Total trading volume |
| raw_json | JSONB | Full bandar_detector block for debugging |
| — | — | — |
| PRIMARY KEY | (ticker, trade_date) | — |

**Source:** Stockbit bandar_detector block

**Table: `insider_transactions`** (KSEI major holder movements)

| Field | Type | Description |
|-------|------|-------------|
| id | SERIAL (PK) | — |
| ticker | VARCHAR(10) (FK → stocks) | Stock code |
| insider_id | TEXT | Stockbit record ID for dedup |
| insider_name | TEXT | Name of major holder |
| transaction_date | DATE | Date of transaction |
| action | VARCHAR(4) | `BUY` or `SELL` |
| share_change | BIGINT | Number of shares transacted |
| shares_before | BIGINT | Shares held before transaction |
| shares_after | BIGINT | Shares held after transaction |
| ownership_before_pct | DECIMAL(8,4) | Ownership % before |
| ownership_after_pct | DECIMAL(8,4) | Ownership % after |
| ownership_change_pct | DECIMAL(8,4) | Change in ownership % |
| nationality | VARCHAR(20) | Holder nationality |
| broker_code | VARCHAR(10) | Broker used |
| data_source | VARCHAR(20) | Default `KSEI` |
| price | BIGINT | Transaction price per share |
| — | — | — |
| UNIQUE | (ticker, insider_name, transaction_date, action, share_change) | — |

**Source:** KSEI via Stockbit insider/company/majorholder endpoint

### 3.2 Supplementary Tables (implemented)

**Table: `dividend_history`**

| Field | Type | Description |
|-------|------|-------------|
| ticker | TEXT (FK → stocks) | Stock code |
| ex_date | DATE | Ex-dividend date |
| amount | DECIMAL | Dividend per share (IDR) |
| currency | TEXT | Default `IDR` |
| source | TEXT | `yfinance` |
| — | — | — |
| UNIQUE | (ticker, ex_date) | — |

**Source:** yfinance dividend history (up to 10 years)

### 3.3 Operational / Meta Tables

**Table: `stock_refresh_requests`** — Tracks per-ticker refresh jobs triggered from the UI.

| Field | Type | Description |
|-------|------|-------------|
| id | SERIAL (PK) | — |
| ticker | TEXT (FK → stocks) | Stock being refreshed |
| status | TEXT | `pending`, `running`, `done`, `failed` |
| requested_at | TIMESTAMPTZ | When the refresh was requested |
| started_at | TIMESTAMPTZ | When scraping began |
| finished_at | TIMESTAMPTZ | When scraping completed |
| completeness_before | DECIMAL | Score before refresh |
| completeness_after | DECIMAL | Score after refresh |
| confidence_before | DECIMAL | Score before refresh |
| confidence_after | DECIMAL | Score after refresh |
| no_new_data | BOOLEAN | True if all scrapers added 0 rows |
| error_message | TEXT | If failed |

**Table: `refresh_scraper_progress`** — Per-scraper status within a refresh job.

| Field | Type | Description |
|-------|------|-------------|
| request_id | INTEGER (FK → stock_refresh_requests) | Parent job |
| scraper_name | TEXT | e.g., `financials_fallback`, `daily_prices` |
| status | TEXT | `pending`, `running`, `done`, `failed` |
| rows_added | INTEGER | Rows upserted by this scraper |
| duration_ms | INTEGER | Execution time in milliseconds |
| error_msg | TEXT | If failed |
| started_at | TIMESTAMPTZ | — |
| finished_at | TIMESTAMPTZ | — |

**Table: `scraper_runs`** — Historical audit log of all pipeline executions.

| Field | Type | Description |
|-------|------|-------------|
| id | SERIAL | — |
| scraper_name | TEXT | e.g., `daily_prices` |
| started_at | TIMESTAMPTZ | — |
| finished_at | TIMESTAMPTZ | — |
| mode | TEXT | `daily`, `weekly`, `full`, etc. |
| status | TEXT | `success`, `partial`, `failed` |
| rows_added | INTEGER | Total rows upserted |
| error_message | TEXT | If failed |

### 3.4 Future Extension Tables

- **`news`** — Aggregated news articles with sentiment scores
- **`index_constituents`** — Which stocks belong to LQ45, IDX30, etc. over time
- **`sector_averages`** — Pre-computed sector average ratios for benchmarking
- **`portfolio`** — Personal portfolio tracking with buy/sell transactions

---

## 4. Data Acquisition Pipeline

### 4.1 Data Sources

| Source | What It Provides | Access Method | Role |
|--------|-----------------|---------------|------|
| **Stockbit** | Financial statements (10yr), broker flow, bandar detection, insider transactions | Bearer token API via `stockbit_client.py` | **Primary** for financials & smart money |
| **IDX API** | Stock universe, foreign flow, company profiles, document links, corporate events | `curl_cffi` with Chrome impersonation via `idx_client.py` | **Primary** for universe & profiles |
| **yfinance** | Daily prices (OHLCV), dividend history, financial fallback | Python `yfinance` library, `.JK` suffix | **Primary** for prices, **fallback** for financials |
| **Twelve Data** | Complete IDX ticker/symbol list | Free API (8 calls/min, 800/day) | Optional fallback for ticker list |

### 4.2 Scraper Scripts

Each script is a standalone Python file that can be run independently. All scripts are idempotent (safe to re-run) and use UPSERT logic.

| Script | Layer | Source | Frequency | Description |
|--------|-------|--------|-----------|-------------|
| `stock_universe.py` | 1 | IDX + Twelve Data | Weekly | All IDX tickers + metadata |
| `daily_prices.py` | 2 | yfinance | Daily | OHLCV, 5-year historical bootstrap |
| `financials_fallback.py` | 3 | **Stockbit** | Quarterly | **Primary** — IS/BS/CF + 25 ratios, up to 10yr history |
| `financials.py` | 3 | yfinance | On-demand | Fallback — 4 years of statements |
| `company_profiles.py` | 4 | IDX API | Quarterly | Directors, shareholders, company info |
| `shareholders_pdf.py` | 4 | PDF/Excel upload | On-demand | Bulk load major shareholders (≥1%), historical snapshots |
| `money_flow.py` | 2+5 | IDX + Stockbit | Daily | Foreign flow (IDX), broker flow + bandar signals + insider transactions (Stockbit) |
| `dividend_scraper.py` | — | yfinance | On-demand | Per-share dividend history, up to 10 years |
| `document_links.py` | — | IDX API | Quarterly | Links to financial reports, prospectus |
| `corporate_events.py` | — | IDX API | Quarterly | Earnings announcements, corporate actions |
| `ratio_enricher.py` | 3 | (no API) | On-demand | Fills NULL ratio columns from stored raw data |
| `gap_filler.py` | all | (re-runs scrapers) | On-demand | Detects and re-scrapes incomplete stocks |

### 4.3 Orchestration

Master script `run_all.py` controls scraper execution with modes and scope modifiers:

**Run modes:**
```
python run_all.py --daily                  # daily_prices + money_flow
python run_all.py --weekly                 # stock_universe
python run_all.py --quarterly              # financials (Stockbit) + company_profiles + docs + events
python run_all.py --full                   # everything in dependency order
python run_all.py --fallback-financials    # Stockbit financials standalone
python run_all.py --broker-backfill        # Stockbit broker flow + bandar signals
python run_all.py --insider                # KSEI insider transactions
python run_all.py --dividends              # yfinance dividend history
python run_all.py --enrich-ratios          # fill NULL ratios from stored data (no API)
python run_all.py --fill-gaps              # re-scrape most incomplete stocks
```

**Scope modifiers:**
```
--ticker BBRI ASII BBCA              # limit to specific tickers
--sector finance energy              # fuzzy sector matching (case-insensitive)
--period annual|quarterly|both       # financials period type
--days 5                             # trading days for money_flow
--year-from 2018 --year-to 2024      # financials year range
--scrapers daily_prices,money_flow   # selective scraper filter in --full mode
--job-id 42                          # link to UI refresh request
--dry-run                            # preview only, no writes
--backfill-days 60                   # broker-backfill window
--offset 100 --batch-limit 50        # batching for large runs
```

### 4.4 Job Tracking & UI Integration

The pipeline integrates with the web UI for single-ticker refresh:

1. User clicks "Refresh" on a stock detail page → creates a `stock_refresh_requests` row (status: `pending`)
2. Triggers `run_all.py --full --ticker BBRI --job-id 42` via GitHub Actions (remote) or local execution (dev)
3. Each scraper updates its `refresh_scraper_progress` row in real-time (running → done/failed, rows_added, duration_ms)
4. Frontend polls `/api/stocks/[ticker]/refresh/[job_id]` for live progress
5. On completion, `completeness_after` and `confidence_after` scores are recorded

### 4.5 Error Handling

- Each scraper logs to both console and a log file (`logs/YYYY-MM-DD_scraper_name.log`) via Rich
- Failed individual stocks are logged but don't stop the batch
- Phase 2 scrapers (`document_links`, `corporate_events`) are non-fatal — failures never block score recalculation
- After each run, completeness + confidence scores are recomputed for affected tickers

---

## 5. Web Application Architecture

### 5.1 Tech Stack

| Technology | Version | Role |
|-----------|---------|------|
| Next.js (App Router) | 16 | Full-stack framework |
| React | 19 | UI library |
| TypeScript | 5 | Type safety |
| Tailwind CSS | 3.4 | Styling |
| Recharts | 2.15 | Charts (line, bar, area, pie) |
| react-force-graph-2d | 1.27 | Shareholder network visualization |
| Mermaid | 11.13 | Diagrams |
| @supabase/supabase-js | 2.99 | Database client |
| @supabase/ssr | 0.9 | Server-side Supabase client |

### 5.2 Pages

| Route | Description |
|-------|-------------|
| `/` | Stock screener home — advanced filters (sector, board, ROE, P/E, P/BV, margin, yield), multi-sort, pagination, watchlist toggle |
| `/stock/[ticker]` | Single stock analysis — 25 modular widgets (see 5.4) |
| `/money-flow` | Money flow dashboard — foreign flow leaderboard, broker activity, volume anomalies, composite flow score |
| `/compare` | Peer comparison — up to 5 stocks side-by-side, metrics grid + charts |
| `/investors` | Shareholder network — interactive force-graph of investor-stock relationships, search by name/ticker |

### 5.3 API Routes

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/search` | GET | Full-text ticker/name search for autocomplete |
| `/api/stocks/[ticker]/broker` | GET | Broker summary (30-day), smart money signals |
| `/api/stocks/[ticker]/refresh` | POST | Trigger on-demand data refresh via GitHub Actions |
| `/api/stocks/[ticker]/refresh/local` | POST | Trigger local scraper execution (dev mode) |
| `/api/stocks/[ticker]/refresh/[job_id]` | GET | Poll individual scraper progress |
| `/api/stocks/[ticker]/freshness` | GET | Last update timestamps per data category |
| `/api/stocks/[ticker]/stockbit/fetch` | GET | Fetch Stockbit financial data |
| `/api/stocks/[ticker]/stockbit/upsert` | POST | Persist Stockbit data to Supabase |
| `/api/investors/network` | GET | Shareholder graph nodes + links, sector filtering |

### 5.4 Stock Detail Widgets (25)

The `/stock/[ticker]` page is composed of modular widgets:

| Widget | Description |
|--------|-------------|
| HeroBar | Ticker, price, change %, market cap, last update |
| PriceWidget | Current price, 52-week high/low |
| FinancialHighlightsWidget | Key metrics at a glance |
| FundamentalsWidget | Profitability ratios (ROE, ROA, margins) |
| RatiosWidget | Valuation ratios (P/E, P/BV, D/E, current ratio) |
| ValuationWidget | Graham number, DCF intrinsic value, margin of safety |
| GrowthHealthWidget | 7-metric health scores (green/yellow/red) |
| FinancialStatementsWidget | Interactive IS/BS/CF tables |
| FinancialChartsWidget | Revenue, profit, cash flow trends |
| DividendWidget | Dividend history, yield, payout ratio |
| CompanyProfileWidget | Description, website, address, contact |
| ProductsWidget | Business segments/products |
| PeersWidget | Comparable companies in same sector |
| ShareholdersWidget | Major shareholders with ownership % |
| SectorOutlookWidget | Sector trends and comparables |
| BrokerActivityWidget | 30-day broker trading activity, smart money signals |
| TechnicalWidget | Technical analysis |
| SentimentWidget | Market sentiment indicators |
| StoriesWidget | News/events timeline |
| AIInsightsWidget | AI-generated analysis snippets |
| InvestmentThesisWidget | Bull/bear case summary |
| DataQualityWidget | Data completeness score and confidence |
| VerdictWidget | Overall recommendation |
| NavTabs | Tab navigation between sections |
| SectionDivider | Visual separators |

### 5.5 Calculation Modules

| Module | Location | Description |
|--------|----------|-------------|
| `valuation.ts` | `lib/calculations/` | Graham Number, DCF (3 scenarios: bear/base/bull), margin of safety |
| `health-score.ts` | `lib/calculations/` | 7-metric health system: ROE, net margin, ROA, current ratio, D/E, FCF, gross margin |
| `cagr.ts` | `lib/calculations/` | Compound annual growth rate for revenue/earnings trends |
| `signal-confidence.ts` | `lib/calculations/` | 100-point smart money scoring system (see Smart Money Signal FRD) |
| `formatters.ts` | `lib/calculations/` | SSR-safe IDR formatting, percentage formatting, number formatting |

### 5.6 Query Modules

Nine server-side query modules in `lib/queries/`: `stocks.ts`, `financials.ts`, `prices.ts`, `company.ts`, `money-flow.ts`, `broker.ts`, `dividends.ts`, `comparison.ts`, `completeness.ts`.

---

## 6. Phase Plan

### Phase 1: Data Backbone — ✅ Complete

**Goal:** A fully populated Supabase database with all 5 data layers operational.

**Delivered:**
- [x] Supabase project created with 15+ tables across 9 schema migrations (`docs/schema.sql` through `docs/schema-v9-smart-money.sql`)
- [x] `stock_universe.py` — populates `stocks` table (all 800+ tickers)
- [x] `daily_prices.py` — populates `daily_prices` (5-year historical bootstrap)
- [x] `financials_fallback.py` — populates `financials` (up to 10 years via Stockbit, 25+ ratios)
- [x] `financials.py` — yfinance fallback (4 years)
- [x] `company_profiles.py` — populates `company_profiles`, `company_officers`, `shareholders`
- [x] `money_flow.py` — populates `broker_summary` (IDX) + `broker_flow` + `bandar_signal` + `insider_transactions` (Stockbit)
- [x] `dividend_scraper.py`, `document_links.py`, `corporate_events.py`, `shareholders_pdf.py`
- [x] `ratio_enricher.py` + `gap_filler.py` for data quality maintenance
- [x] `run_all.py` orchestrator with 10 run modes and scope modifiers
- [x] Completeness + confidence scoring per stock (`score_calculator.py`)

### Phase 2: Fundamental Dashboard — ✅ Complete

**Goal:** A NextJS web app that visualizes the data backbone.

**Delivered:**
- [x] NextJS 16 project with Supabase SSR connection
- [x] Stock screener home page with advanced filters (sector, board, ROE, P/E, P/BV, margin, yield)
- [x] Single stock analysis page (`/stock/[ticker]`) with 25 modular widgets
- [x] Revenue & profit trend charts, margin charts, balance sheet health, cash flow trends
- [x] CAGR computation, health scorecard (7 metrics, green/yellow/red)
- [x] Peer comparison page (`/compare`) — up to 5 stocks side-by-side
- [x] Full-text search with autocomplete
- [x] Watchlist toggle (star system)

### Phase 3: Money Flow Dashboard — ✅ Complete

**Delivered:**
- [x] Dedicated money flow page (`/money-flow`) with foreign flow leaderboard
- [x] Broker activity section with independent date range
- [x] Volume anomaly detection
- [x] Composite flow score (bullish/bearish signals)
- [x] Daily flow chart by broker type (asing/lokal/pemerintah) on stock detail
- [x] Broker concentration analysis with bandar candidate detection

### Phase 4: Valuation Engine — ✅ Complete

**Delivered:**
- [x] Graham Number calculator
- [x] DCF calculator with 3 scenarios (bearish, base, bullish) — flexible base (FCF, Dividend, EPS)
- [x] Margin of safety indicator
- [x] Health score system (7 metrics with configurable thresholds)
- [x] IDX-specific valuation assumptions (WACC, terminal growth, risk-free rate)
- [x] ValuationWidget integrated into stock detail page

### Phase 5: Smart Money & Intelligence — 🔄 In Progress

**Delivered:**
- [x] Smart Money Signal system — broker flow + bandar detection + insider transactions → 100-point confidence scoring
- [x] Rule-based narrative generator with Indonesian-language explanations
- [x] Phase detection (akumulasi / distribusi / netral)
- [x] Shareholder network graph (`/investors`) — interactive force-graph visualization
- [x] AI Insights widget (placeholder)
- [x] Investment thesis widget (bull/bear case)
- [x] Verdict widget (overall recommendation)

**Remaining:**
- [ ] News aggregation from Indonesian financial media
- [ ] Claude API integration for sentiment analysis
- [ ] Alerting system for significant changes (price, flow, insider activity)
- [ ] Entry/exit plan generator

### Phase 6: Future Enhancements (Planned)

- [ ] Portfolio tracker with buy/sell transactions and P&L
- [ ] Sector rotation dashboard
- [ ] Earnings calendar with estimate tracking
- [ ] Automated daily/weekly email digest

---

## 7. Data Quality Requirements

### Automated Quality Scoring

Each stock has two auto-computed scores maintained by `score_calculator.py`:

- **Completeness score** (0–100): Measures data presence across all categories (prices, financials, ratios, profile, officers, shareholders, dividends). Stored in `stocks.completeness_score`.
- **Confidence score** (0–100): Measures data recency and source quality. Stored in `stocks.confidence_score`.

The `gap_filler.py` scraper uses completeness scores to automatically identify and re-scrape stocks below a threshold (default: 70%).

### Completeness Targets

| Data Type | Target Coverage | Acceptable Minimum |
|-----------|----------------|-------------------|
| Stock universe | 100% of IDX active listings | 95% |
| Daily prices | 100% of stocks, 5 year history | 90% of stocks |
| Financial statements | 90% of stocks, 10 years (Stockbit) | 80% of stocks, 4 years (yfinance) |
| Company profiles | 80% of stocks | 60% of stocks |
| Broker flow (Stockbit) | Top 200 stocks by market cap | Top 100 stocks |
| Insider transactions | All stocks with KSEI filings | — |

### Accuracy

- Price data must match official IDX closing prices (yfinance is generally reliable for this)
- Financial statement numbers must match the company's published reports
- Ratios sourced from Stockbit where available, computed from raw data as fallback
- When data from multiple sources conflicts: Stockbit > IDX official > yfinance > computed
- `source` field in `financials` table tracks data provenance

### Freshness

| Data Type | Maximum Staleness |
|-----------|------------------|
| Daily prices | 1 day (updated after market close) |
| Foreign flow | 1 day |
| Broker flow + bandar signal | 1 day (Stockbit backfill) |
| Financial statements | 30 days after earnings release |
| Company profiles | 90 days |
| Stock universe | 7 days |
| Insider transactions | 7 days |

---

## 8. Constraints & Risks

### Technical Constraints

- **Stockbit API dependency**: Stockbit is the primary source for financials, broker flow, bandar signals, and insider data. The API is undocumented and requires a bearer token that must be periodically refreshed. Mitigation: `token_manager.py` caches tokens and handles interactive refresh; yfinance serves as fallback for financials.
- **IDX API instability**: IDX endpoints are undocumented and may change or break without notice. Mitigation: Keep scraper logic modular so individual scrapers can be fixed without affecting others. IDX API has been stable in practice.
- **yfinance IDX coverage gaps**: Some smaller stocks may have incomplete data. Mitigation: Stockbit is now primary for financials; yfinance is primarily used for prices and dividends where it is reliable.
- **Supabase free tier limits**: 500MB database limit. With 15+ tables, broker_flow being the largest (many rows per ticker per day), storage is growing. Current estimate ~200-300MB. Monitor and consider Supabase Pro if approaching limit.
- **Scraper rate limiting**: Rate limits per source — IDX (0.6s), yfinance (0.1s), Stockbit (0.8s). All configured in `config.py`.

### Data Risks

- **Stockbit token expiry**: Bearer tokens expire periodically. If the token expires during a batch run, that run will fail. Mitigation: `token_manager.py` with cached token + interactive refresh prompt.
- **IDX blocks scraping**: If IDX changes anti-bot configuration, `curl_cffi` may stop working. Fallback: yfinance for prices, Stockbit for financials.
- **Financial data inconsistency**: Stockbit and yfinance may report slightly different numbers. Mitigation: Stockbit takes priority; `source` field tracks provenance.
- **PostgREST row cap**: Supabase's default 1000-row limit can silently truncate results for liquid stocks with many broker rows. Mitigation: batched queries in `broker.ts` and `_fetchBrokerFlowBatched`.

---

## 9. Success Metrics

| Metric | Target | Current Status |
|--------|--------|----------------|
| **Coverage** | ≥90% of IDX active stocks with complete data | ✅ 800+ stocks in universe, completeness scoring active |
| **Freshness** | Daily data ≤1 trading day old | ✅ Daily pipeline operational |
| **Reliability** | Scrapers succeed ≥95% of runs | ✅ Non-fatal error handling, gap_filler for remediation |
| **Queryability** | Any screening question → single query | ✅ Advanced screener with multi-filter, 25+ ratios |
| **Extensibility** | New data source < 1 day to add | ✅ Modular scraper architecture, 12 scrapers operational |
| **Build speed** | New feature < 1 day | ✅ 25 widgets, 5 pages, 5 calculation modules built |
| **Smart money** | Signal confidence for top stocks | ✅ 100-point scoring with 5 components + narrative |

---

## Appendix A: Reference Projects & Data Sources

| Project / Source | URL | Relevance |
|-----------------|-----|-----------|
| **Stockbit Exodus API** | (undocumented) | Primary source for financials, broker flow, bandar detection, insider transactions |
| nichsedge/idx-bei | github.com/nichsedge/idx-bei | IDX API scraper patterns, company profiles, broker data |
| noczero/idx-fundamental-analysis | github.com/noczero/idx-fundamental-analysis | Stockbit API patterns, fundamental data retrieval |
| Rachdyan/idx_financial_report | github.com/Rachdyan/idx_financial_report | Raw financial statement parsing from IDX |
| Dividend Dashboard (own project) | — | Recharts patterns, IDR formatting, financial calculations |

## Appendix B: Data Size Estimates

| Table | Row Estimate | Avg Row Size | Total |
|-------|-------------|-------------|-------|
| stocks | 900 | 600B | ~0.5MB |
| daily_prices (5yr) | 900 × 1,250 = 1,125,000 | 200B | ~225MB |
| financials (10yr, annual+quarterly) | 900 × 50 = 45,000 | 1.2KB | ~54MB |
| company_profiles | 900 | 2KB | ~2MB |
| company_officers | 7,200 | 200B | ~1.5MB |
| shareholders | 9,000 | 200B | ~2MB |
| shareholders_major | 5,000 | 250B | ~1.3MB |
| broker_summary (IDX legacy) | 500,000 | 150B | ~75MB |
| broker_flow (Stockbit, 30d × 200) | 200 × 30 × 50 = 300,000 | 150B | ~45MB |
| bandar_signal (30d × 200) | 6,000 | 500B | ~3MB |
| insider_transactions | 10,000 | 300B | ~3MB |
| dividend_history | 5,000 | 100B | ~0.5MB |
| meta tables | ~50,000 | 200B | ~10MB |
| **Total** | | | **~420MB** |

Approaching Supabase free tier limit (500MB). Monitor growth; daily_prices is the largest table. Consider archiving older price data or upgrading to Supabase Pro if needed.
