# Product Requirements Document (PRD)

# IDX Stock Analyzer — Data Backbone

**Version:** 1.0
**Author:** Nailul
**Last Updated:** March 2026
**Status:** Planning → Feasibility Testing

---

## 1. Vision

Build a comprehensive, self-maintained data pool of Indonesian stock market data that serves as a **foundation layer** for any financial analysis, visualization, or decision-making tool we want to build — now or in the future.

The data backbone is the product. Dashboards, screeners, valuation calculators, and sentiment trackers are consumers that sit on top of it. If the data layer is solid, any application can be built quickly and reliably.

```
                    ┌──────────────────────────────────────┐
                    │        FUTURE APPLICATIONS           │
                    │                                      │
                    │  • Fundamental Dashboard              │
                    │  • Money Flow Tracker                 │
                    │  • Stock Screener                     │
                    │  • Intrinsic Value Calculator          │
                    │  • Sentiment Analyzer                 │
                    │  • Portfolio Tracker                   │
                    │  • Dividend Planner (v2)               │
                    │  • Alerting System                    │
                    │  • AI-Powered Research Assistant       │
                    │  • Anything else we think of...       │
                    └──────────────────┬───────────────────┘
                                      │ reads from
                    ┌──────────────────▼───────────────────┐
                    │         DATA BACKBONE                 │
                    │     (This is what we're building)     │
                    │                                      │
                    │  Complete, clean, structured,         │
                    │  queryable Indonesian stock data      │
                    └──────────────────────────────────────┘
```

---

## 2. Goals & Non-Goals

### Goals

1. **Comprehensive coverage** — All 800+ IDX-listed stocks, not a curated subset. The data pool should be complete enough that any stock question can be answered by querying it.

2. **Historical depth** — Minimum 4 years of financial statements (yfinance limit), 10+ years of daily prices, and as far back as we can go for dividends and corporate actions.

3. **Data freshness** — Daily prices updated end-of-day. Financial statements updated quarterly. Company profiles updated quarterly. Broker/money flow data updated daily.

4. **Structured and queryable** — Data stored in well-normalized PostgreSQL tables with clear relationships. Any question like "show me all banking stocks with ROE > 15% and D/E < 2" should be answerable with a single SQL query.

5. **Self-maintainable** — Scraper scripts that can be run manually or via cron. When a scraper breaks (they will), it should be obvious what broke and fixable within an hour.

6. **Foundation for multiple applications** — The schema should not be designed around one specific dashboard. It should be a general-purpose financial data store.

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
| — Computed Ratios — | — | — |
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
| — | — | — |
| source | TEXT | `yfinance`, `idx`, `manual` |
| last_updated | TIMESTAMPTZ | When this row was last refreshed |
| UNIQUE | (ticker, year, quarter) | One row per stock per period |

**Source:** yfinance (primary, ~4 years) + IDX API financial reports (extended history)

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

**Source:** IDX API company profiles endpoint + idx-bei scraper patterns

#### Layer 5: Money Flow & Broker Data (refreshed daily)

Broker-level trading activity and foreign/domestic flow tracking.

**Table: `broker_summary`**

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

### 3.2 Future Extension Tables (not in Phase 1)

These tables will be added when we build features on top of the data backbone:

- **`dividends`** — Historical dividend declarations, ex-dates, payment dates, amounts
- **`corporate_actions`** — Stock splits, rights issues, mergers
- **`news`** — Aggregated news articles with sentiment scores
- **`valuations_cache`** — Pre-computed intrinsic values (DCF, DDM, Graham)
- **`watchlists`** — Personal stock watchlists
- **`index_constituents`** — Which stocks belong to LQ45, IDX30, etc. over time
- **`sector_averages`** — Pre-computed sector average ratios for benchmarking

---

## 4. Data Acquisition Pipeline

### 4.1 Scraper Scripts

Each script is a standalone Python file that can be run independently. All scripts are idempotent (safe to re-run) and use UPSERT logic.

| Script | Data Layer | Source | Frequency | Estimated Runtime |
|--------|-----------|--------|-----------|-------------------|
| `stock_universe.py` | Layer 1 | Twelve Data + IDX | Weekly | ~2 min |
| `daily_prices.py` | Layer 2 | yfinance | Daily | ~15-20 min (800 stocks) |
| `money_flow.py` | Layer 2 + 5 | IDX API | Daily | ~30-45 min (800 stocks) |
| `financials.py` | Layer 3 | yfinance + IDX | Quarterly | ~60-90 min (800 stocks) |
| `company_profiles.py` | Layer 4 | IDX API | Quarterly | ~45-60 min (800 stocks) |

### 4.2 Orchestration

A master script `run_all.py` orchestrates execution:

```
run_all.py --daily          # Runs: daily_prices + money_flow
run_all.py --weekly         # Runs: stock_universe
run_all.py --quarterly      # Runs: financials + company_profiles
run_all.py --full           # Runs: everything
run_all.py --ticker BBRI    # Runs: all scrapers for one stock (testing)
```

### 4.3 Error Handling

- Each scraper logs to both console and a log file (`logs/YYYY-MM-DD_scraper_name.log`)
- Failed individual stocks are logged but don't stop the batch
- After each run, a summary shows: X succeeded, Y failed, Z skipped
- A `scraper_runs` table in Supabase tracks execution history:

| Field | Type | Description |
|-------|------|-------------|
| id | SERIAL | — |
| scraper_name | TEXT | e.g., `daily_prices` |
| started_at | TIMESTAMPTZ | — |
| finished_at | TIMESTAMPTZ | — |
| stocks_processed | INTEGER | — |
| stocks_failed | INTEGER | — |
| status | TEXT | `success`, `partial`, `failed` |
| error_message | TEXT | If failed |

---

## 5. Phase Plan

### Phase 1: Data Backbone (Weeks 1-4)

**Goal:** A fully populated Supabase database with all 5 data layers operational.

**Deliverables:**
- [ ] Supabase project created with all tables from Section 3.1
- [ ] `stock_universe.py` — populates `stocks` table (all 800+ tickers)
- [ ] `daily_prices.py` — populates `daily_prices` (1 year of history for all stocks, then daily going forward)
- [ ] `financials.py` — populates `financials` (4 years via yfinance for all stocks)
- [ ] `company_profiles.py` — populates `company_profiles`, `company_officers`, `shareholders`
- [ ] `money_flow.py` — populates `broker_summary` + foreign flow columns in `daily_prices`
- [ ] `run_all.py` orchestrator working
- [ ] Data can be queried directly in Supabase dashboard to validate completeness

**Success criteria:** Can answer these questions by querying Supabase:
- "List all banking stocks sorted by ROE"
- "Show BBRI's revenue for the last 4 years"
- "Which stocks had the highest foreign net buy last week?"
- "Top 5 brokers buying ASII today"
- "All stocks with P/E < 10 and dividend yield > 5%"

### Phase 2: First Application — Fundamental Dashboard (Weeks 5-7)

**Goal:** A NextJS web app that visualizes the data backbone.

**Deliverables:**
- [ ] NextJS project scaffolded with Supabase connection
- [ ] Stock search / browse page
- [ ] Single stock analysis page (`/stock/[ticker]`) with:
  - Key metrics card row (price, P/E, P/BV, ROE, dividend yield)
  - Revenue & profit trend chart (Recharts line chart)
  - Margin trend chart
  - Balance sheet health (debt vs cash, current ratio)
  - Cash flow trend
  - CAGR table (3yr, 5yr for revenue, profit, equity)
  - Health scorecard (traffic light system)
- [ ] Peer comparison page (`/compare`)

### Phase 3: Money Flow Dashboard (Weeks 8-9)

**Deliverables:**
- [ ] Foreign flow visualization (daily bar chart, cumulative line)
- [ ] Broker activity table (top buyers/sellers)
- [ ] Volume anomaly detection (flag when volume > 2x 20-day average)
- [ ] Flow score indicator (composite of foreign flow + broker + volume signals)

### Phase 4: Valuation Engine (Weeks 10-12)

**Deliverables:**
- [ ] DCF calculator with adjustable assumptions
- [ ] DDM calculator (for dividend-paying stocks)
- [ ] Graham Number calculator
- [ ] Relative valuation (P/E, P/BV vs sector average)
- [ ] Combined valuation range visualization
- [ ] Margin of safety indicator

### Phase 5: Sentiment & Intelligence (Future)

**Deliverables:**
- [ ] News aggregation from Indonesian financial media
- [ ] Claude API integration for sentiment analysis
- [ ] Investability verdict combining all signals
- [ ] Entry/exit plan generator
- [ ] Alerting for significant changes (price, flow, news)

---

## 6. Data Quality Requirements

### Completeness Targets

| Data Type | Target Coverage | Acceptable Minimum |
|-----------|----------------|-------------------|
| Stock universe | 100% of IDX active listings | 95% |
| Daily prices | 100% of stocks, 1 year history | 90% of stocks |
| Financial statements | 90% of stocks, 4 years | 80% of stocks, 2 years |
| Company profiles | 80% of stocks | 60% of stocks |
| Broker summary | Top 200 stocks by market cap | Top 100 stocks |

### Accuracy

- Price data must match official IDX closing prices (yfinance is generally reliable for this)
- Financial statement numbers must match the company's published reports
- Ratios computed from raw data (not taken from third-party pre-computed values) to ensure consistency
- When data from multiple sources conflicts, IDX official data takes priority, then yfinance, then others

### Freshness

| Data Type | Maximum Staleness |
|-----------|------------------|
| Daily prices | 1 day (updated after market close) |
| Foreign flow | 1 day |
| Broker summary | 1 day |
| Financial statements | 30 days after earnings release |
| Company profiles | 90 days |
| Stock universe | 7 days |

---

## 7. Constraints & Risks

### Technical Constraints

- **IDX API instability**: IDX endpoints are undocumented and may change or break without notice. Mitigation: Keep scraper logic modular so individual scrapers can be fixed without affecting others. Reference idx-bei repo for endpoint updates.
- **yfinance IDX coverage gaps**: Some smaller stocks may have incomplete data. Mitigation: Track completeness in `scraper_runs`, fill gaps manually or from IDX when critical.
- **Supabase free tier limits**: 500MB database, 1GB file storage, 50K monthly active users (irrelevant for personal use). The 500MB database limit is the binding constraint — estimated data size for 800 stocks × 1 year daily prices + 4 years financials ≈ 100-150MB, well within limit.
- **Scraper rate limiting**: Must respect source rate limits to avoid IP blocks. All scrapers include delays between requests.

### Data Risks

- **IDX blocks scraping**: If IDX changes their Cloudflare or anti-bot configuration, `curl_cffi` may stop working. Fallback: Use yfinance for what it covers, manually supplement the rest.
- **Yahoo Finance discontinues IDX coverage**: Unlikely but possible. Fallback: Sectors.app paid API ($10-20/month) covers all IDX stocks.
- **Financial data inconsistency**: Different sources may report slightly different numbers due to normalization differences. Mitigation: Store the `source` field and prefer raw IDX data when available.

---

## 8. Success Metrics

The data backbone is successful when:

1. **Coverage**: ≥90% of IDX active stocks have complete data across all 5 layers
2. **Freshness**: Daily data is never more than 1 trading day old
3. **Reliability**: Scrapers run successfully ≥95% of the time (partial failures for individual stocks are acceptable)
4. **Queryability**: Any reasonable stock screening question can be answered with a single SQL query
5. **Extensibility**: Adding a new data field or new data source takes less than 1 day of work
6. **Build speed**: A new application feature (chart, table, calculation) can be built in under 1 day because the data is already clean and available

---

## Appendix A: Reference Projects

| Project | URL | Relevance |
|---------|-----|-----------|
| nichsedge/idx-bei | github.com/nichsedge/idx-bei | IDX API scraper patterns, company profiles, broker data |
| noczero/idx-fundamental-analysis | github.com/noczero/idx-fundamental-analysis | Stockbit API, fundamental data retrieval |
| Rachdyan/idx_financial_report | github.com/Rachdyan/idx_financial_report | Raw financial statement parsing from IDX |
| Dividend Dashboard (own project) | — | Recharts patterns, IDR formatting, financial calculations |

## Appendix B: IDR Data Size Estimates

| Table | Row Estimate | Avg Row Size | Total |
|-------|-------------|-------------|-------|
| stocks | 900 | 500B | ~0.4MB |
| daily_prices (1yr) | 900 × 250 = 225,000 | 200B | ~45MB |
| financials (4yr) | 900 × 4 = 3,600 | 800B | ~3MB |
| company_profiles | 900 | 2KB | ~2MB |
| company_officers | 900 × 8 = 7,200 | 200B | ~1.5MB |
| shareholders | 900 × 10 = 9,000 | 200B | ~2MB |
| broker_summary (1yr, top 200) | 200 × 250 × 10 = 500,000 | 150B | ~75MB |
| **Total** | | | **~130MB** |

Comfortably within Supabase free tier (500MB).
