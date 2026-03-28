from __future__ import annotations

"""
ratio_enricher.py — Fill NULL computed fields in the financials table
from raw data that is already stored in the database.

No external API calls are made. This enricher reads raw financial data
(revenue, net_income, total_assets, etc.) and derives any missing ratio
fields using the same formulas as financials.py.

High-impact situations where this helps:
  • market_cap / listed_shares was NULL when a ticker was first scraped
    → pe_ratio and pbv_ratio could not be computed at the time.
  • yfinance returned partial data on a flaky request — raw rows exist
    but ratio columns came back None.
  • Newer stocks that were added to the universe after the last full run
    got prices later, so ratios can now be back-filled.

Run:
    cd python && python -m scrapers.ratio_enricher
    cd python && python -m scrapers.ratio_enricher --ticker BBRI ASII
    cd python && python -m scrapers.ratio_enricher --dry-run
"""

import argparse
import logging
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent.parent))

from utils.helpers import RunResult, setup_logging, safe_float, safe_int, compute_ratio
from utils.supabase_client import get_client, fetch_column, start_run, finish_run

logger = logging.getLogger(__name__)

# Columns we may write — never touch raw data columns
_RATIO_COLS = [
    "eps", "book_value_per_share",
    "gross_margin", "operating_margin", "net_margin",
    "roe", "roa", "current_ratio", "debt_to_equity",
    "free_cash_flow",
    "pe_ratio", "pbv_ratio", "dividend_yield", "payout_ratio",
]

# Raw data columns we read (must exist in the row)
_RAW_COLS = ",".join([
    "ticker", "year", "quarter",
    "revenue", "gross_profit", "operating_income", "net_income",
    "total_assets", "current_assets", "total_liabilities",
    "total_equity", "current_liabilities", "total_debt",
    "operating_cash_flow", "capex", "free_cash_flow",
    "dividends_paid",
] + _RATIO_COLS)


# ---------------------------------------------------------------------------
# Per-row enrichment logic
# ---------------------------------------------------------------------------

def _compute_updates(
    row: dict,
    price_per_share: float | None,
    listed_shares: int | None,
) -> dict[str, Any]:
    """
    Compute only the ratio fields that are currently NULL but can be derived
    from available raw data.  Returns a dict of {column: value} to update.
    Returns an empty dict if nothing can be improved.
    """
    updates: dict[str, Any] = {}

    def _needs(col: str) -> bool:
        return row.get(col) is None

    # Short-hands for raw fields
    revenue          = row.get("revenue")
    gross_profit     = row.get("gross_profit")
    operating_income = row.get("operating_income")
    net_income       = row.get("net_income")
    total_assets     = row.get("total_assets")
    current_assets   = row.get("current_assets")
    total_equity     = row.get("total_equity")
    current_liab     = row.get("current_liabilities")
    total_debt       = row.get("total_debt")
    ocf              = row.get("operating_cash_flow")
    capex            = row.get("capex")
    dividends_paid   = row.get("dividends_paid")

    # ---- Ratios derivable purely from stored raw data ----

    if _needs("gross_margin"):
        v = compute_ratio(gross_profit, revenue, scale=100)
        if v is not None:
            updates["gross_margin"] = v

    if _needs("operating_margin"):
        v = compute_ratio(operating_income, revenue, scale=100)
        if v is not None:
            updates["operating_margin"] = v

    if _needs("net_margin"):
        v = compute_ratio(net_income, revenue, scale=100)
        if v is not None:
            updates["net_margin"] = v

    if _needs("roe"):
        v = compute_ratio(net_income, total_equity, scale=100)
        if v is not None:
            updates["roe"] = v

    if _needs("roa"):
        v = compute_ratio(net_income, total_assets, scale=100)
        if v is not None:
            updates["roa"] = v

    if _needs("current_ratio"):
        v = compute_ratio(current_assets, current_liab)
        if v is not None:
            updates["current_ratio"] = v

    if _needs("debt_to_equity"):
        v = compute_ratio(total_debt, total_equity)
        if v is not None:
            updates["debt_to_equity"] = v

    if _needs("free_cash_flow") and ocf is not None and capex is not None:
        fcf = safe_int(ocf - abs(capex))
        if fcf is not None:
            updates["free_cash_flow"] = fcf

    if _needs("payout_ratio") and dividends_paid and net_income and net_income != 0:
        v = safe_float(abs(dividends_paid) / net_income * 100, 4)
        if v is not None:
            updates["payout_ratio"] = v

    # ---- Per-share ratios: need listed_shares ----

    effective_eps  = row.get("eps")
    effective_bvps = row.get("book_value_per_share")

    if _needs("eps") and net_income is not None and listed_shares and listed_shares > 0:
        eps = safe_float(net_income / listed_shares, 4)
        if eps is not None:
            updates["eps"] = eps
            effective_eps = eps   # use it downstream in same pass

    if _needs("book_value_per_share") and total_equity is not None and listed_shares and listed_shares > 0:
        bvps = safe_float(total_equity / listed_shares, 4)
        if bvps is not None:
            updates["book_value_per_share"] = bvps
            effective_bvps = bvps

    # ---- Market ratios: need price_per_share ----

    if price_per_share is not None:
        if _needs("pe_ratio") and effective_eps and effective_eps != 0:
            pe = safe_float(price_per_share / effective_eps, 2)
            if pe and 0 < pe < 500:
                updates["pe_ratio"] = pe

        if _needs("pbv_ratio") and effective_bvps and effective_bvps != 0:
            pbv = safe_float(price_per_share / effective_bvps, 2)
            if pbv and 0 < pbv < 100:
                updates["pbv_ratio"] = pbv

        if _needs("dividend_yield") and dividends_paid and listed_shares and listed_shares > 0:
            dps = abs(dividends_paid) / listed_shares
            dy = safe_float(dps / price_per_share * 100, 4)
            if dy is not None:
                updates["dividend_yield"] = dy

    return updates


# ---------------------------------------------------------------------------
# Per-ticker orchestration
# ---------------------------------------------------------------------------

def _get_price_per_share(client, ticker: str) -> tuple[float | None, int | None]:
    """
    Return (price_per_share, listed_shares) for ticker using the latest
    available close price from daily_prices and listed_shares from stocks.
    Falls back to market_cap / listed_shares if no price row found.
    """
    stock_resp = (
        client.table("stocks")
        .select("market_cap, listed_shares")
        .eq("ticker", ticker)
        .execute()
    )
    stock = (stock_resp.data or [{}])[0]
    listed_shares: int | None = safe_int(stock.get("listed_shares"))

    # Prefer actual latest close price over market_cap approximation
    price_resp = (
        client.table("daily_prices")
        .select("close")
        .eq("ticker", ticker)
        .order("date", desc=True)
        .limit(1)
        .execute()
    )
    price_data = price_resp.data or []

    if price_data and price_data[0].get("close") is not None:
        price_per_share = safe_float(price_data[0]["close"])
    elif listed_shares and listed_shares > 0 and stock.get("market_cap"):
        price_per_share = safe_float(stock["market_cap"]) / listed_shares
    else:
        price_per_share = None

    return price_per_share, listed_shares


def _enrich_ticker(
    client,
    ticker: str,
    dry_run: bool = False,
) -> tuple[int, int]:
    """
    Enrich all financials rows for one ticker.
    Returns (rows_checked, rows_updated).
    """
    resp = (
        client.table("financials")
        .select(_RAW_COLS)
        .eq("ticker", ticker)
        .execute()
    )
    rows = resp.data or []
    if not rows:
        return 0, 0

    price_per_share, listed_shares = _get_price_per_share(client, ticker)
    rows_updated = 0

    for row in rows:
        updates = _compute_updates(row, price_per_share, listed_shares)
        if not updates:
            continue

        updates["last_updated"] = datetime.now(timezone.utc).isoformat()
        logger.debug(
            "  %s %d Q%d: updating %s",
            ticker, row["year"], row["quarter"], list(updates.keys()),
        )

        if not dry_run:
            client.table("financials").update(updates).eq(
                "ticker", ticker
            ).eq("year", row["year"]).eq("quarter", row["quarter"]).execute()

        rows_updated += 1

    return len(rows), rows_updated


# ---------------------------------------------------------------------------
# Screener denormalization — copy latest annual ratios → stocks table
# ---------------------------------------------------------------------------

_SCREENER_RATIO_COLS = ["pe_ratio", "pbv_ratio", "roe", "net_margin", "dividend_yield"]


def _sync_screener_ratios(client, tickers: list[str]) -> int:
    """
    For each ticker, read the latest annual financials row (quarter=0)
    and copy the 5 key screener ratios into the stocks table.
    Returns number of stocks updated.
    """
    from utils.supabase_client import bulk_upsert

    # Fetch latest annual financials for the given tickers
    select_cols = "ticker, year, " + ", ".join(_SCREENER_RATIO_COLS)
    resp = (
        client.table("financials")
        .select(select_cols)
        .in_("ticker", tickers)
        .eq("quarter", 0)
        .order("year", desc=True)
        .execute()
    )

    # Keep only the latest year per ticker
    latest: dict[str, dict] = {}
    for row in (resp.data or []):
        t = row["ticker"]
        if t not in latest:
            latest[t] = row

    updates: list[dict] = []
    for ticker, row in latest.items():
        update: dict[str, Any] = {"ticker": ticker}
        has_data = False
        for col in _SCREENER_RATIO_COLS:
            v = row.get(col)
            if v is not None:
                update[col] = v
                has_data = True
        if has_data:
            updates.append(update)

    if updates:
        bulk_upsert("stocks", updates, on_conflict="ticker")

    return len(updates)


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def run(
    tickers: list[str] | None = None,
    dry_run: bool = False,
) -> RunResult:
    """
    Re-derive NULL ratio columns from stored raw data for all (or specified) tickers.

    Args:
        tickers: Limit to these tickers. None = all active stocks.
        dry_run: If True, compute but do not write to the database.
    """
    result = RunResult("ratio_enricher")
    run_id = start_run(
        "ratio_enricher",
        metadata={
            "mode": "single" if tickers else "full",
            "dry_run": dry_run,
        },
    )

    client = get_client()

    if tickers:
        ticker_list = [t.upper() for t in tickers]
    else:
        ticker_list = fetch_column("stocks", "ticker", filters={"status": "Active"})
        if not ticker_list:
            logger.error("No active stocks found. Run stock_universe.py first.")
            finish_run(run_id, "failed", error_message="stocks table empty")
            return result

    logger.info(
        "Enriching ratios for %d tickers%s",
        len(ticker_list),
        " [DRY RUN]" if dry_run else "",
    )

    total_checked = 0
    total_updated = 0

    for i, ticker in enumerate(ticker_list, 1):
        try:
            checked, updated = _enrich_ticker(client, ticker, dry_run=dry_run)
            total_checked += checked
            total_updated += updated
            if updated > 0:
                logger.info("[%d/%d] %s: enriched %d/%d rows", i, len(ticker_list), ticker, updated, checked)
                result.ok(ticker)
            else:
                result.skip(ticker, f"all ratios already populated ({checked} rows)")
        except Exception as e:
            logger.warning("Failed %s: %s", ticker, e)
            result.fail(ticker, str(e))

        # Small pause to avoid hammering Supabase
        if i % 100 == 0:
            time.sleep(0.5)

    logger.info(
        "Ratio enrichment complete: %d rows checked, %d rows updated across %d tickers",
        total_checked, total_updated, len(ticker_list),
    )

    # --- Sync screener ratios into the stocks table ---
    if not dry_run:
        synced = _sync_screener_ratios(client, ticker_list)
        logger.info("Synced screener ratios for %d stocks", synced)

    result.print_summary()
    finish_run(run_id, **result.to_db_kwargs())
    return result


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Ratio enricher — fill NULL ratio columns in financials table from existing raw data"
    )
    parser.add_argument("--ticker", nargs="+", help="Limit to specific tickers")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Compute enrichments but do not write to the database",
    )
    args = parser.parse_args()

    setup_logging("ratio_enricher")
    run(tickers=args.ticker, dry_run=args.dry_run)
