from __future__ import annotations

"""
daily_prices.py — Layer 2 scraper (OHLCV)

Populates `daily_prices` with end-of-day price and volume data via yfinance.
Value and frequency columns are filled separately by money_flow.py.
Foreign flow data is sourced from Stockbit broker_flow (broker_type='Asing').

Behaviour:
  - First run (bootstrap): fetches DAILY_PRICE_HISTORY_YEARS years of history
  - Subsequent runs: fetches only data since the last known date per ticker
  - Runs in batches of YFINANCE_BATCH_SIZE tickers to respect yfinance limits

Run:
    cd python && python -m scrapers.daily_prices
    cd python && python -m scrapers.daily_prices --ticker BBRI ASII
    cd python && python -m scrapers.daily_prices --full    # force full history re-fetch
"""
import argparse
import logging
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pandas as pd
import yfinance as yf

sys.path.insert(0, str(Path(__file__).parent.parent))

from config import (
    DAILY_PRICE_HISTORY_YEARS,
    YFINANCE_BATCH_SIZE,
    RATE_LIMIT_YFINANCE_SECONDS,
)
from utils.helpers import RunResult, setup_logging, safe_float, safe_int
from utils.supabase_client import bulk_upsert, fetch_all, start_run, finish_run

logger = logging.getLogger(__name__)


# ------------------------------------------------------------------
# Date range helpers
# ------------------------------------------------------------------

def _bootstrap_start() -> date:
    return date.today() - timedelta(days=365 * DAILY_PRICE_HISTORY_YEARS)


def _get_last_dates(tickers: list[str]) -> dict[str, date]:
    """
    Query Supabase for the most recent date we have per ticker.
    Returns {ticker: last_date}.
    """
    if not tickers:
        return {}

    from utils.supabase_client import get_client
    client = get_client()

    # Fetch max date per ticker in one query using Supabase's aggregate
    # Supabase JS client doesn't support GROUP BY natively, so we query
    # recent rows and process in Python. For 800+ tickers this is fine
    # since we only need the max date column.
    resp = (
        client.table("daily_prices")
        .select("ticker, date")
        .in_("ticker", tickers)
        .order("date", desc=True)
        .execute()
    )

    last_dates: dict[str, date] = {}
    for row in (resp.data or []):
        t = row["ticker"]
        if t not in last_dates:
            last_dates[t] = datetime.strptime(row["date"], "%Y-%m-%d").date()
    return last_dates


# ------------------------------------------------------------------
# yfinance download + parse
# ------------------------------------------------------------------

def _yf_ticker(ticker: str) -> str:
    """Append .JK suffix for IDX stocks."""
    return f"{ticker}.JK"


def _download_batch(
    tickers: list[str],
    start: date,
    end: date,
) -> pd.DataFrame:
    """
    Download OHLCV for a batch of tickers using yfinance bulk download.
    Returns a wide DataFrame with MultiIndex columns: (field, ticker).
    """
    yf_tickers = [_yf_ticker(t) for t in tickers]
    df = yf.download(
        yf_tickers,
        start=start.isoformat(),
        end=(end + timedelta(days=1)).isoformat(),  # end is exclusive in yfinance
        auto_adjust=True,
        progress=False,
        threads=True,
    )
    return df


def _parse_batch_df(df: pd.DataFrame, tickers: list[str]) -> list[dict]:
    """
    Convert the wide yfinance DataFrame into a flat list of row dicts
    suitable for the `daily_prices` table.
    """
    rows: list[dict] = []
    if df.empty:
        return rows

    # yfinance >=1.0 always returns MultiIndex columns (Price, Ticker)
    # even for single-ticker downloads.
    is_multi = isinstance(df.columns, pd.MultiIndex)

    for ticker in tickers:
        yf_ticker = _yf_ticker(ticker)
        try:
            if is_multi:
                # Try named level ("Ticker") first (yfinance >=1.0),
                # fall back to positional level 1 for older versions.
                try:
                    ticker_df = df.xs(yf_ticker, level="Ticker", axis=1)
                except (KeyError, TypeError):
                    ticker_df = df.xs(yf_ticker, level=1, axis=1)
            else:
                ticker_df = df
        except KeyError:
            logger.debug("No data for %s in batch", ticker)
            continue

        ticker_df = ticker_df.dropna(subset=["Close"])

        for idx_date, row in ticker_df.iterrows():
            trade_date = idx_date.date() if hasattr(idx_date, "date") else idx_date
            rows.append({
                "ticker": ticker,
                "date": trade_date.isoformat(),
                "open": safe_float(row.get("Open"), 2),
                "high": safe_float(row.get("High"), 2),
                "low": safe_float(row.get("Low"), 2),
                "close": safe_float(row.get("Close"), 2),
                "volume": safe_int(row.get("Volume")),
                # value / frequency / foreign flow filled by money_flow.py
                "last_updated": datetime.now(timezone.utc).isoformat(),
            })
    return rows


# ------------------------------------------------------------------
# Market data enrichment (market_cap + listed_shares → stocks table)
# ------------------------------------------------------------------

def _enrich_market_data(tickers: list[str]) -> tuple[int, int]:
    """
    Fetch market_cap and shares_outstanding from yfinance fast_info
    for each ticker and upsert into the stocks table.

    Returns (enriched_count, failed_count).
    """
    updates: list[dict] = []
    failed = 0

    for i, ticker in enumerate(tickers):
        try:
            info = yf.Ticker(_yf_ticker(ticker)).fast_info
            market_cap = getattr(info, "market_cap", None)
            shares = getattr(info, "shares", None)

            row: dict[str, Any] = {"ticker": ticker}
            has_data = False

            if market_cap and market_cap > 0:
                row["market_cap"] = int(market_cap)
                has_data = True
            if shares and shares > 0:
                row["listed_shares"] = int(shares)
                has_data = True

            if has_data:
                updates.append(row)
            else:
                logger.debug("No market data from yfinance for %s", ticker)

        except Exception as e:
            logger.debug("fast_info failed for %s: %s", ticker, e)
            failed += 1

        if RATE_LIMIT_YFINANCE_SECONDS > 0 and i < len(tickers) - 1:
            time.sleep(RATE_LIMIT_YFINANCE_SECONDS)

    if updates:
        bulk_upsert("stocks", updates, on_conflict="ticker")
        logger.info("Enriched market_cap/listed_shares for %d stocks", len(updates))

    return len(updates), failed


def _sync_latest_prices(tickers: list[str]) -> int:
    """
    Copy the latest closing price from daily_prices into
    stocks.current_price / stocks.price_date for fast screener queries.

    Returns number of stocks updated.
    """
    from utils.supabase_client import get_client
    client = get_client()

    # Fetch the most recent price row per ticker (already downloaded above)
    resp = (
        client.table("daily_prices")
        .select("ticker, close, date")
        .in_("ticker", tickers)
        .order("date", desc=True)
        .execute()
    )

    # Keep only the latest row per ticker
    latest: dict[str, dict] = {}
    for row in (resp.data or []):
        t = row["ticker"]
        if t not in latest:
            latest[t] = row

    updates = [
        {
            "ticker": t,
            "current_price": float(r["close"]),
            "price_date": r["date"],
        }
        for t, r in latest.items()
        if r.get("close") is not None
    ]

    if updates:
        bulk_upsert("stocks", updates, on_conflict="ticker")
        logger.info("Synced current_price for %d stocks", len(updates))

    return len(updates)


# ------------------------------------------------------------------
# Main scraper
# ------------------------------------------------------------------

def run(
    tickers: list[str] | None = None,
    force_full: bool = False,
) -> RunResult:
    """
    Fetch daily price data and upsert into `daily_prices`.

    Args:
        tickers:    If provided, only process these tickers.
        force_full: Ignore last known date; re-fetch full history.
    """
    result = RunResult("daily_prices")
    run_id = start_run(
        "daily_prices",
        metadata={
            "mode": "single" if tickers else ("full_refresh" if force_full else "incremental"),
            "history_years": DAILY_PRICE_HISTORY_YEARS,
        },
    )

    # --- Determine ticker list ---
    if tickers:
        ticker_list = [t.upper() for t in tickers]
    else:
        from utils.supabase_client import fetch_column
        ticker_list = fetch_column("stocks", "ticker", filters={"status": "Active"})
        if not ticker_list:
            logger.error("No active stocks found in Supabase. Run stock_universe.py first.")
            finish_run(run_id, "failed", error_message="stocks table is empty")
            return result
    logger.info("Processing %d tickers", len(ticker_list))

    # --- Determine date ranges per ticker ---
    today = date.today()
    bootstrap_start = _bootstrap_start()

    if force_full:
        date_ranges = {t: bootstrap_start for t in ticker_list}
        logger.info("Force full: fetching from %s for all tickers", bootstrap_start)
    else:
        last_dates = _get_last_dates(ticker_list)
        date_ranges: dict[str, date] = {}
        for t in ticker_list:
            if t in last_dates:
                # Fetch from day after last known date; overlap 1 day for safety
                date_ranges[t] = last_dates[t] - timedelta(days=1)
            else:
                date_ranges[t] = bootstrap_start

        new_tickers = [t for t in ticker_list if t not in last_dates]
        existing_tickers = [t for t in ticker_list if t in last_dates]
        logger.info(
            "New tickers (bootstrap): %d | Incremental updates: %d",
            len(new_tickers), len(existing_tickers),
        )

    # --- Group tickers by start date for efficient batching ---
    # Tickers with the same start date can be downloaded together.
    from collections import defaultdict
    groups: dict[date, list[str]] = defaultdict(list)
    for t in ticker_list:
        groups[date_ranges[t]].append(t)

    # --- Download and upsert in batches ---
    for start_date, group_tickers in groups.items():
        if start_date >= today:
            for t in group_tickers:
                result.skip(t, "already up to date")
            continue

        logger.info(
            "Downloading %d tickers from %s to %s",
            len(group_tickers), start_date, today,
        )

        for batch_start in range(0, len(group_tickers), YFINANCE_BATCH_SIZE):
            batch = group_tickers[batch_start : batch_start + YFINANCE_BATCH_SIZE]
            try:
                df = _download_batch(batch, start_date, today)
                rows = _parse_batch_df(df, batch)

                if rows:
                    bulk_upsert("daily_prices", rows, on_conflict="ticker,date")
                    logger.info("Upserted %d price rows for batch of %d tickers", len(rows), len(batch))

                for t in batch:
                    result.ok(t)

            except Exception as e:
                logger.error("Batch download failed (start=%s): %s", start_date, e)
                for t in batch:
                    result.fail(t, str(e))

    # --- Enrich market_cap + listed_shares in stocks table ---
    logger.info("Enriching market_cap / listed_shares for %d tickers …", len(ticker_list))
    enriched, enrich_failed = _enrich_market_data(ticker_list)
    logger.info("Market data enrichment: %d updated, %d failed", enriched, enrich_failed)

    # --- Sync latest price into stocks table (for screener) ---
    price_synced = _sync_latest_prices(ticker_list)
    logger.info("Synced current_price for %d stocks", price_synced)

    result.print_summary()
    finish_run(run_id, **result.to_db_kwargs())
    return result


# ------------------------------------------------------------------
# Entry point
# ------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Scrape daily prices → Supabase daily_prices table")
    parser.add_argument("--ticker", nargs="+", help="Test mode: only process these tickers")
    parser.add_argument("--full", action="store_true", help="Force re-fetch full history")
    args = parser.parse_args()

    setup_logging("daily_prices")
    run(tickers=args.ticker, force_full=args.full)
