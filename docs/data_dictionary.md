# Data Dictionary

Field definitions for every table in the IDX Stock Analyzer database.

---

## stocks

Master list of all IDX-listed companies. Refreshed weekly.

| Column | Type | Description |
|--------|------|-------------|
| ticker | TEXT (PK) | IDX stock code, e.g. `BBRI`. No `.JK` suffix. |
| name | TEXT | Full company name |
| sector | TEXT | IDX sector (English-normalised) |
| subsector | TEXT | IDX subsector |
| listing_date | DATE | IPO / listing date on IDX |
| listed_shares | BIGINT | Total shares outstanding |
| market_cap | BIGINT | Latest market capitalisation in IDR |
| board | TEXT | `Main`, `Development`, or `Acceleration` |
| is_lq45 | BOOLEAN | Member of LQ45 index (current period) |
| is_idx30 | BOOLEAN | Member of IDX30 index (current period) |
| status | TEXT | `Active`, `Suspended`, or `Delisted` |
| last_updated | TIMESTAMPTZ | Row refresh timestamp |

---

## daily_prices

End-of-day price, volume, and foreign flow data. Refreshed daily.

| Column | Type | Description |
|--------|------|-------------|
| id | BIGSERIAL | Auto-increment PK |
| ticker | TEXT (FK) | References `stocks.ticker` |
| date | DATE | Trading date (IDX calendar) |
| open | DECIMAL | Opening price (IDR) |
| high | DECIMAL | Highest intraday price (IDR) |
| low | DECIMAL | Lowest intraday price (IDR) |
| close | DECIMAL | Closing price (IDR) |
| volume | BIGINT | Shares traded |
| value | BIGINT | Total transaction value in IDR |
| frequency | INTEGER | Number of transactions (orders matched) |
| foreign_buy | BIGINT | Foreign investor buy value in IDR |
| foreign_sell | BIGINT | Foreign investor sell value in IDR |
| foreign_net | BIGINT | `foreign_buy - foreign_sell` (positive = net buy) |
| last_updated | TIMESTAMPTZ | Row refresh timestamp |

**Source**: OHLCV via yfinance; foreign flow + value + frequency via IDX API (money_flow.py).

---

## financials

Annual and quarterly financial statements with computed ratios. Refreshed quarterly.

`quarter = 0` means annual report; `quarter = 1-4` means quarterly (Q1=Mar, Q2=Jun, Q3=Sep, Q4=Dec).

### Income Statement

| Column | Type | Description |
|--------|------|-------------|
| revenue | BIGINT | Total revenue (IDR) |
| cost_of_revenue | BIGINT | Cost of goods sold / cost of revenue (IDR) |
| gross_profit | BIGINT | Revenue minus cost of revenue (IDR) |
| operating_expense | BIGINT | Total operating expenses (IDR) |
| operating_income | BIGINT | Operating income / EBIT (IDR) |
| interest_expense | BIGINT | Interest expense (IDR) |
| income_before_tax | BIGINT | Pre-tax income (IDR) |
| tax_expense | BIGINT | Income tax expense (IDR) |
| net_income | BIGINT | Net income attributable to shareholders (IDR) |
| eps | DECIMAL | Earnings per share (IDR/share) |

### Balance Sheet

| Column | Type | Description |
|--------|------|-------------|
| total_assets | BIGINT | Total assets (IDR) |
| current_assets | BIGINT | Current assets (IDR) |
| total_liabilities | BIGINT | Total liabilities (IDR) |
| current_liabilities | BIGINT | Current liabilities (IDR) |
| total_equity | BIGINT | Total shareholders' equity (IDR) |
| total_debt | BIGINT | Short-term + long-term interest-bearing debt (IDR) |
| cash_and_equivalents | BIGINT | Cash and cash equivalents (IDR) |
| book_value_per_share | DECIMAL | Equity / listed shares (IDR/share) |

### Cash Flow

| Column | Type | Description |
|--------|------|-------------|
| operating_cash_flow | BIGINT | Net cash from operating activities (IDR) |
| capex | BIGINT | Capital expenditures — usually negative (IDR) |
| free_cash_flow | BIGINT | `operating_cash_flow - abs(capex)` (IDR) |
| dividends_paid | BIGINT | Cash dividends paid — usually negative (IDR) |

### Computed Ratios

All ratios computed from raw values above. Percentages are stored as-is (e.g. 15.5% → 15.5, not 0.155).

| Column | Type | Formula |
|--------|------|---------|
| gross_margin | DECIMAL | `gross_profit / revenue × 100` |
| operating_margin | DECIMAL | `operating_income / revenue × 100` |
| net_margin | DECIMAL | `net_income / revenue × 100` |
| roe | DECIMAL | `net_income / total_equity × 100` |
| roa | DECIMAL | `net_income / total_assets × 100` |
| current_ratio | DECIMAL | `current_assets / current_liabilities` |
| debt_to_equity | DECIMAL | `total_debt / total_equity` |
| pe_ratio | DECIMAL | `price_per_share / eps` (uses market_cap from `stocks`) |
| pbv_ratio | DECIMAL | `price_per_share / book_value_per_share` |
| dividend_yield | DECIMAL | `dps / price_per_share × 100` |
| payout_ratio | DECIMAL | `abs(dividends_paid) / net_income × 100` |

### Metadata

| Column | Type | Description |
|--------|------|-------------|
| source | TEXT | `yfinance`, `idx`, or `manual` |
| last_updated | TIMESTAMPTZ | Row refresh timestamp |

---

## company_profiles

Detailed company information. Refreshed quarterly.

| Column | Type | Description |
|--------|------|-------------|
| ticker | TEXT (PK, FK) | References `stocks.ticker` |
| description | TEXT | Business description |
| website | TEXT | Company website URL |
| address | TEXT | Registered office address |
| phone | TEXT | Contact phone number |
| email | TEXT | Contact email address |
| npwp | TEXT | Indonesian tax ID (NPWP) |
| listing_date | DATE | Date of IPO on IDX |
| registry_agency | TEXT | Share registrar / Biro Administrasi Efek |
| last_updated | TIMESTAMPTZ | Row refresh timestamp |

---

## company_officers

Directors, commissioners, and committee members. Refreshed quarterly (full replacement).

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL (PK) | Auto-increment |
| ticker | TEXT (FK) | References `stocks.ticker` |
| name | TEXT | Person's full name |
| role | TEXT | `director`, `commissioner`, or `committee` |
| title | TEXT | Specific title (e.g. `President Director`, `Independent Commissioner`) |
| is_independent | BOOLEAN | True if independent commissioner/director |
| last_updated | TIMESTAMPTZ | Row refresh timestamp |

---

## shareholders

Ownership structure snapshot. Refreshed quarterly (full replacement per ticker).

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL (PK) | Auto-increment |
| ticker | TEXT (FK) | References `stocks.ticker` |
| holder_name | TEXT | Shareholder name |
| holder_type | TEXT | `institution`, `individual`, `government`, or `public` |
| shares_held | BIGINT | Number of shares owned |
| percentage | DECIMAL | Ownership percentage (e.g. 25.5 means 25.5%) |
| snapshot_date | DATE | Date the ownership data was valid |
| last_updated | TIMESTAMPTZ | Row refresh timestamp |

---

## broker_summary

Broker-level buy/sell activity. Refreshed daily for top 200 stocks by market cap.

| Column | Type | Description |
|--------|------|-------------|
| id | BIGSERIAL (PK) | Auto-increment |
| ticker | TEXT (FK) | References `stocks.ticker` |
| date | DATE | Trading date |
| broker_code | TEXT | IDX broker code (e.g. `YP`, `MS`, `CC`) |
| broker_name | TEXT | Full broker name |
| buy_volume | BIGINT | Shares bought by this broker |
| buy_value | BIGINT | Buy value in IDR |
| sell_volume | BIGINT | Shares sold by this broker |
| sell_value | BIGINT | Sell value in IDR |
| net_volume | BIGINT | `buy_volume - sell_volume` |
| net_value | BIGINT | `buy_value - sell_value` (positive = net buyer) |
| last_updated | TIMESTAMPTZ | Row refresh timestamp |

---

## scraper_runs

Execution history for every scraper run.

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL (PK) | Auto-increment |
| scraper_name | TEXT | e.g. `daily_prices`, `financials`, `stock_universe` |
| started_at | TIMESTAMPTZ | When the run began |
| finished_at | TIMESTAMPTZ | When the run ended (NULL if still running) |
| stocks_processed | INTEGER | Number of tickers successfully processed |
| stocks_failed | INTEGER | Number of tickers that errored |
| stocks_skipped | INTEGER | Number of tickers skipped (already up to date, etc.) |
| status | TEXT | `running`, `success`, `partial`, `failed` |
| error_message | TEXT | Error details if status = `failed` |
| metadata | JSONB | Extra context (date range, mode, etc.) |
