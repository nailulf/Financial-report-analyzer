from __future__ import annotations

"""
financials.py — yfinance financial data (secondary source)

Populates the `financials` table with income statement, balance sheet,
cash flow data, and computed ratios from yfinance.

Source priority: Stockbit (primary, run first) > yfinance (this file, fills gaps)

When Stockbit data already exists for a (ticker, year, quarter), yfinance
only fills NULL fields — it never overwrites existing Stockbit values.
When no row exists yet, yfinance writes the full row.

Run:
    cd python && python -m scrapers.financials
    cd python && python -m scrapers.financials --ticker BBRI
    cd python && python -m scrapers.financials --ticker BBRI --period annual
"""
import argparse
import logging
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

import pandas as pd
import yfinance as yf

sys.path.insert(0, str(Path(__file__).parent.parent))

from config import RATE_LIMIT_YFINANCE_SECONDS, YFINANCE_BATCH_SIZE
from utils.helpers import RunResult, setup_logging, safe_float, safe_int, compute_ratio
from utils.supabase_client import bulk_upsert, fetch_column, fetch_one, get_client, start_run, finish_run

logger = logging.getLogger(__name__)

PeriodType = Literal["annual", "quarterly", "both"]


# ------------------------------------------------------------------
# yfinance extraction helpers
# ------------------------------------------------------------------

def _safe_get(df: pd.DataFrame, *keys: str) -> int | None:
    """
    Try multiple field name variants on a yfinance DataFrame.
    Returns the first non-null integer value found, or None.
    """
    if df is None or df.empty:
        return None
    for key in keys:
        if key in df.index:
            vals = df.loc[key]
            non_null = vals.dropna()
            if not non_null.empty:
                return safe_int(non_null.iloc[0])
    return None


def _get_series_value(df: pd.DataFrame, col: pd.Timestamp, *keys: str) -> int | None:
    """Get value for a specific period column from a yfinance DataFrame."""
    if df is None or df.empty or col not in df.columns:
        return None
    for key in keys:
        if key in df.index:
            val = df.loc[key, col]
            return safe_int(val) if pd.notna(val) else None
    return None


def _period_end_date(ts: pd.Timestamp) -> str | None:
    try:
        return ts.strftime("%Y-%m-%d")
    except Exception:
        return None


def _extract_annual(ticker_obj: yf.Ticker) -> list[dict]:
    """
    Extract annual financial statements from yfinance.
    Returns list of row dicts (one per fiscal year).
    """
    try:
        income = ticker_obj.financials          # columns = fiscal year end dates
        balance = ticker_obj.balance_sheet
        cashflow = ticker_obj.cashflow
    except Exception as e:
        logger.debug("yfinance annual fetch error: %s", e)
        return []

    if income is None or income.empty:
        return []

    rows = []
    for col in income.columns:
        year = col.year
        row = _build_row(ticker_obj.ticker, year, 0, col, income, balance, cashflow)
        if row:
            rows.append(row)
    return rows


def _extract_quarterly(ticker_obj: yf.Ticker) -> list[dict]:
    """
    Extract quarterly financial statements from yfinance.
    Returns list of row dicts.
    """
    try:
        income = ticker_obj.quarterly_financials
        balance = ticker_obj.quarterly_balance_sheet
        cashflow = ticker_obj.quarterly_cashflow
    except Exception as e:
        logger.debug("yfinance quarterly fetch error: %s", e)
        return []

    if income is None or income.empty:
        return []

    rows = []
    for col in income.columns:
        # Determine quarter from month: Q1=Mar, Q2=Jun, Q3=Sep, Q4=Dec
        month = col.month
        quarter = (month - 1) // 3 + 1
        year = col.year
        row = _build_row(ticker_obj.ticker, year, quarter, col, income, balance, cashflow)
        if row:
            rows.append(row)
    return rows


def _build_row(
    yf_ticker: str,
    year: int,
    quarter: int,
    period_col: pd.Timestamp,
    income: pd.DataFrame,
    balance: pd.DataFrame,
    cashflow: pd.DataFrame,
) -> dict | None:
    """Build a single `financials` row dict from yfinance DataFrames."""
    # Strip .JK suffix to get IDX ticker
    ticker = yf_ticker.replace(".JK", "").upper()

    def g(df, *keys):
        return _get_series_value(df, period_col, *keys)

    # --- Income Statement ---
    revenue = g(income, "Total Revenue", "Revenue", "TotalRevenue")
    cost_of_revenue = g(income, "Cost Of Revenue", "CostOfRevenue", "Cost of Revenue")
    gross_profit = g(income, "Gross Profit", "GrossProfit")
    operating_expense = g(income, "Total Operating Expenses", "Operating Expenses", "OperatingExpenses")
    operating_income = g(income, "Operating Income", "EBIT", "OperatingIncome")
    interest_expense = g(income, "Interest Expense", "InterestExpense")
    income_before_tax = g(income, "Pretax Income", "Income Before Tax", "PretaxIncome")
    tax_expense = g(income, "Tax Provision", "Income Tax Expense", "TaxProvision")
    net_income = g(income, "Net Income", "NetIncome", "Net Income Common Stockholders")
    eps = safe_float(g(income, "Basic EPS", "Diluted EPS", "EPS"))

    # --- Balance Sheet ---
    total_assets = g(balance, "Total Assets", "TotalAssets")
    current_assets = g(balance, "Current Assets", "Total Current Assets", "CurrentAssets")
    total_liabilities = g(balance, "Total Liabilities Net Minority Interest", "Total Liab", "TotalLiabilities")
    current_liabilities = g(balance, "Current Liabilities", "Total Current Liabilities", "CurrentLiabilities")
    total_equity = g(balance, "Stockholders Equity", "Total Equity Gross Minority Interest", "TotalEquity")
    total_debt = g(balance, "Total Debt", "Long Term Debt", "TotalDebt")
    cash = g(balance, "Cash And Cash Equivalents", "Cash", "CashAndCashEquivalents")
    book_value_per_share = safe_float(g(balance, "Book Value", "BookValue"))

    # --- Cash Flow ---
    ocf = g(cashflow, "Operating Cash Flow", "Total Cash From Operating Activities", "OperatingCashFlow")
    capex = g(cashflow, "Capital Expenditure", "Capital Expenditures", "CapitalExpenditure")
    dividends_paid = g(cashflow, "Common Stock Dividend Paid", "Dividends Paid", "DividendsPaid")
    fcf = safe_int((ocf or 0) - abs(capex or 0)) if ocf is not None else None

    # Skip rows with no useful data at all
    if all(v is None for v in [revenue, total_assets, net_income]):
        return None

    # --- Computed Ratios ---
    gross_margin = compute_ratio(gross_profit, revenue, scale=100)
    operating_margin = compute_ratio(operating_income, revenue, scale=100)
    net_margin = compute_ratio(net_income, revenue, scale=100)
    roe = compute_ratio(net_income, total_equity, scale=100)
    roa = compute_ratio(net_income, total_assets, scale=100)
    current_ratio = compute_ratio(current_assets, current_liabilities)
    debt_to_equity = compute_ratio(total_debt, total_equity)
    # P/E and P/BV require current price — computed here using stored market_cap
    # These will be filled in by a separate enrichment step (see _enrich_market_ratios)

    return {
        "ticker": ticker,
        "year": year,
        "quarter": quarter,
        "period_end": _period_end_date(period_col),
        # Income
        "revenue": revenue,
        "cost_of_revenue": cost_of_revenue,
        "gross_profit": gross_profit,
        "operating_expense": operating_expense,
        "operating_income": operating_income,
        "interest_expense": interest_expense,
        "income_before_tax": income_before_tax,
        "tax_expense": tax_expense,
        "net_income": net_income,
        "eps": eps,
        # Balance
        "total_assets": total_assets,
        "current_assets": current_assets,
        "total_liabilities": total_liabilities,
        "current_liabilities": current_liabilities,
        "total_equity": total_equity,
        "total_debt": total_debt,
        "cash_and_equivalents": cash,
        "book_value_per_share": book_value_per_share,
        # Cash Flow
        "operating_cash_flow": ocf,
        "capex": capex,
        "free_cash_flow": fcf,
        "dividends_paid": dividends_paid,
        # Ratios
        "gross_margin": gross_margin,
        "operating_margin": operating_margin,
        "net_margin": net_margin,
        "roe": roe,
        "roa": roa,
        "current_ratio": current_ratio,
        "debt_to_equity": debt_to_equity,
        # Market ratios: pe_ratio, pbv_ratio, dividend_yield, payout_ratio
        # — left NULL here, filled by _enrich_market_ratios()
        "source": "yfinance",
        "last_updated": datetime.now(timezone.utc).isoformat(),
    }


def _enrich_market_ratios(rows: list[dict], ticker: str) -> None:
    """
    Fill pe_ratio, pbv_ratio, dividend_yield for the most recent annual row.
    Uses market_cap from the stocks table + eps/book_value from financials.
    Modifies rows in-place.
    """
    stock = fetch_one("stocks", "market_cap, listed_shares", filters={"ticker": ticker})
    if not stock:
        return

    market_cap = stock.get("market_cap")
    listed_shares = stock.get("listed_shares")
    if not market_cap or not listed_shares or listed_shares == 0:
        return

    price_per_share = market_cap / listed_shares

    for row in rows:
        if row.get("eps") and row["eps"] != 0:
            row["pe_ratio"] = safe_float(price_per_share / row["eps"], 2)
        if row.get("book_value_per_share") and row["book_value_per_share"] != 0:
            row["pbv_ratio"] = safe_float(price_per_share / row["book_value_per_share"], 2)
        if row.get("dividends_paid") and listed_shares and listed_shares > 0:
            dps = abs(row["dividends_paid"]) / listed_shares
            row["dividend_yield"] = safe_float(dps / price_per_share * 100, 4)
        if row.get("dividends_paid") and row.get("net_income") and row["net_income"] != 0:
            row["payout_ratio"] = safe_float(abs(row["dividends_paid"]) / row["net_income"] * 100, 4)


# ------------------------------------------------------------------
# IDX source stub (extend here when adding IDX financial reports)
# ------------------------------------------------------------------

def _fetch_from_idx(ticker: str, year: int, quarter: int) -> list[dict]:
    """
    Fetch financial data from IDX official reports.

    This is a stub for future implementation. To extend:
    1. Use IDXClient.get_financial_report_list(ticker, year, quarter)
       to get the download URL of the XBRL/PDF report.
    2. Download and parse the report.
    3. Map to the same row dict format as _build_row().
    4. Call this function before yfinance in run() and merge results,
       giving IDX data priority over yfinance data.

    Returns empty list (not implemented yet).
    """
    logger.debug("IDX financial source not yet implemented for %s %d Q%d", ticker, year, quarter)
    return []


# ------------------------------------------------------------------
# Merge helpers — yfinance fills NULLs only when Stockbit data exists
# ------------------------------------------------------------------

_IDENTITY_FIELDS = {"ticker", "year", "quarter"}

_FILLABLE_FIELDS = {
    "period_end",
    "revenue", "cost_of_revenue", "gross_profit", "operating_expense",
    "operating_income", "interest_expense", "income_before_tax",
    "tax_expense", "net_income", "eps",
    "total_assets", "current_assets", "total_liabilities", "current_liabilities",
    "total_equity", "total_debt", "cash_and_equivalents", "book_value_per_share",
    "operating_cash_flow", "capex", "free_cash_flow", "dividends_paid",
    "gross_margin", "operating_margin", "net_margin",
    "roe", "roa", "current_ratio", "debt_to_equity",
    "pe_ratio", "pbv_ratio", "dividend_yield", "payout_ratio",
}


def _get_existing_rows(ticker: str) -> dict[tuple[int, int], dict]:
    """Fetch existing financials rows for ticker, indexed by (year, quarter)."""
    db = get_client()
    fields = ",".join(["ticker", "year", "quarter", "source"] + sorted(_FILLABLE_FIELDS))
    resp = db.table("financials").select(fields).eq("ticker", ticker).execute()
    return {(r["year"], r["quarter"]): r for r in (resp.data or [])}


def _merge_with_existing(
    rows: list[dict],
    existing: dict[tuple[int, int], dict],
) -> list[dict]:
    """
    Merge yfinance rows with existing DB rows (typically from Stockbit).
    - New periods: write full yfinance row
    - Existing periods: only fill NULL fields, never overwrite
    """
    merged: list[dict] = []
    for row in rows:
        key = (row["year"], row["quarter"])
        db_row = existing.get(key)

        if db_row is None:
            # No existing data — write full row
            merged.append(row)
            continue

        # Existing row — only fill NULLs
        updates: dict = {}
        for field in _FILLABLE_FIELDS:
            if db_row.get(field) is None and row.get(field) is not None:
                updates[field] = row[field]

        if not updates:
            continue  # nothing new from yfinance

        # Update source tracking
        current_source = db_row.get("source") or "unknown"
        if "yfinance" not in current_source:
            updates["source"] = f"{current_source}+yfinance"

        updates["last_updated"] = row.get("last_updated")
        updates["ticker"] = row["ticker"]
        updates["year"] = row["year"]
        updates["quarter"] = row["quarter"]
        merged.append(updates)

    return merged


# ------------------------------------------------------------------
# Main scraper
# ------------------------------------------------------------------

def run(
    tickers: list[str] | None = None,
    period: PeriodType = "both",
) -> RunResult:
    """
    Fetch financial statements and upsert into `financials`.

    Args:
        tickers: If provided, only process these tickers.
        period:  'annual', 'quarterly', or 'both'.
    """
    result = RunResult("financials")
    run_id = start_run(
        "financials",
        metadata={"mode": "single" if tickers else "full", "period": period},
    )

    if tickers:
        ticker_list = [t.upper() for t in tickers]
    else:
        ticker_list = fetch_column("stocks", "ticker", filters={"status": "Active"})
        if not ticker_list:
            logger.error("No active stocks in Supabase. Run stock_universe.py first.")
            finish_run(run_id, "failed", error_message="stocks table is empty")
            return result

    logger.info("Processing %d tickers (period=%s)", len(ticker_list), period)

    for i, ticker in enumerate(ticker_list, 1):
        yf_ticker = f"{ticker}.JK"
        logger.debug("[%d/%d] Fetching %s", i, len(ticker_list), ticker)
        try:
            t_obj = yf.Ticker(yf_ticker)
            rows: list[dict] = []

            if period in ("annual", "both"):
                rows.extend(_extract_annual(t_obj))
            if period in ("quarterly", "both"):
                rows.extend(_extract_quarterly(t_obj))

            if not rows:
                result.skip(ticker, "no data from yfinance")
                continue

            # Enrich with market ratios using stored market_cap
            _enrich_market_ratios(rows, ticker)

            # Merge: only fill NULLs when Stockbit data already exists
            existing = _get_existing_rows(ticker)
            rows = _merge_with_existing(rows, existing)

            if not rows:
                result.skip(ticker, "yfinance data redundant (Stockbit already complete)")
                continue

            # Upsert immediately — don't buffer all tickers in memory
            bulk_upsert("financials", rows, on_conflict="ticker,year,quarter")
            result.ok(ticker)

        except Exception as e:
            logger.warning("Failed %s: %s", ticker, e)
            result.fail(ticker, str(e))

        # Rate limiting between tickers
        if i % YFINANCE_BATCH_SIZE == 0:
            time.sleep(RATE_LIMIT_YFINANCE_SECONDS)

    result.print_summary()
    finish_run(run_id, **result.to_db_kwargs())
    return result


# ------------------------------------------------------------------
# Entry point
# ------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Scrape financial statements → Supabase financials table")
    parser.add_argument("--ticker", nargs="+", help="Test mode: only process these tickers")
    parser.add_argument(
        "--period",
        choices=["annual", "quarterly", "both"],
        default="both",
        help="Which period type to fetch (default: both)",
    )
    args = parser.parse_args()

    setup_logging("financials")
    run(tickers=args.ticker, period=args.period)
