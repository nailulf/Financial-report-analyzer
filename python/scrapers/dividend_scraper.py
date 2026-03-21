from __future__ import annotations

"""
dividend_scraper.py — Fetch dividend history from yfinance for all IDX stocks.

Populates the `dividend_history` table with per-share dividend payments.
This is separate from the `financials.dividends_paid` cash flow field, which
represents total dividends paid by the company (from the cash flow statement).

dividend_history stores: ex_date, dividend per share (IDR), source.

Requires the following table to exist in Supabase:
─────────────────────────────────────────────────────
  CREATE TABLE dividend_history (
      ticker       TEXT        NOT NULL,
      ex_date      DATE        NOT NULL,
      amount       NUMERIC(20, 6),          -- IDR per share
      currency     TEXT        DEFAULT 'IDR',
      source       TEXT        DEFAULT 'yfinance',
      last_updated TIMESTAMPTZ,
      PRIMARY KEY (ticker, ex_date)
  );
─────────────────────────────────────────────────────

Run:
    cd python && python -m scrapers.dividend_scraper
    cd python && python -m scrapers.dividend_scraper --ticker BBRI TLKM
    cd python && python -m scrapers.dividend_scraper --years 10
"""

import argparse
import logging
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import yfinance as yf

sys.path.insert(0, str(Path(__file__).parent.parent))

from config import RATE_LIMIT_YFINANCE_SECONDS, YFINANCE_BATCH_SIZE
from utils.helpers import RunResult, setup_logging, safe_float
from utils.supabase_client import bulk_upsert, fetch_column, start_run, finish_run

logger = logging.getLogger(__name__)

# How many years of dividend history to keep (yfinance provides ~10+ years for liquid stocks)
DEFAULT_HISTORY_YEARS = 10


# ---------------------------------------------------------------------------
# Extraction
# ---------------------------------------------------------------------------

def _extract_dividends(ticker_obj: yf.Ticker, ticker: str) -> list[dict]:
    """
    Fetch dividend history for a single ticker from yfinance.
    Returns a list of row dicts ready for upsert into dividend_history.
    """
    try:
        divs: pd.Series = ticker_obj.dividends
    except Exception as e:
        logger.debug("%s: yfinance dividends fetch error: %s", ticker, e)
        return []

    if divs is None or divs.empty:
        return []

    rows: list[dict] = []
    now_iso = datetime.now(timezone.utc).isoformat()

    for dt_idx, amount in divs.items():
        try:
            # DatetimeIndex may be tz-aware or tz-naive depending on yfinance version
            if hasattr(dt_idx, "date"):
                ex_date = dt_idx.date().isoformat()
            else:
                ex_date = str(dt_idx)[:10]

            amt = safe_float(amount, 6)
            if amt is None or amt <= 0:
                continue  # skip zero / invalid entries

            rows.append({
                "ticker": ticker,
                "ex_date": ex_date,
                "amount": amt,
                "currency": "IDR",
                "source": "yfinance",
                "last_updated": now_iso,
            })
        except Exception as e:
            logger.debug("%s: error parsing dividend row %s: %s", ticker, dt_idx, e)
            continue

    return rows


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def run(
    tickers: list[str] | None = None,
) -> RunResult:
    """
    Fetch dividend history from yfinance and upsert into dividend_history.

    Args:
        tickers: If provided, only process these tickers.
    """
    result = RunResult("dividend_scraper")
    run_id = start_run(
        "dividend_scraper",
        metadata={"mode": "single" if tickers else "full"},
    )

    if tickers:
        ticker_list = [t.upper() for t in tickers]
    else:
        ticker_list = fetch_column("stocks", "ticker", filters={"status": "Active"})
        if not ticker_list:
            logger.error("No active stocks found. Run stock_universe.py first.")
            finish_run(run_id, "failed", error_message="stocks table empty")
            return result

    logger.info("Fetching dividend history for %d tickers", len(ticker_list))

    for i, ticker in enumerate(ticker_list, 1):
        yf_ticker = f"{ticker}.JK"
        logger.debug("[%d/%d] %s", i, len(ticker_list), ticker)
        try:
            t_obj = yf.Ticker(yf_ticker)
            rows = _extract_dividends(t_obj, ticker)

            if not rows:
                result.skip(ticker, "no dividend history in yfinance")
                continue

            bulk_upsert("dividend_history", rows, on_conflict="ticker,ex_date")
            logger.info("[%d/%d] %s: %d dividend records upserted", i, len(ticker_list), ticker, len(rows))
            result.ok(ticker)

        except Exception as e:
            logger.warning("Failed %s: %s", ticker, e)
            result.fail(ticker, str(e))

        # Rate limiting — yfinance is lenient but avoid bursts
        if i % YFINANCE_BATCH_SIZE == 0:
            time.sleep(RATE_LIMIT_YFINANCE_SECONDS * 2)
        else:
            time.sleep(RATE_LIMIT_YFINANCE_SECONDS)

    result.print_summary()
    finish_run(run_id, **result.to_db_kwargs())
    return result


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Dividend scraper — fetch IDX dividend history from yfinance → Supabase"
    )
    parser.add_argument("--ticker", nargs="+", help="Limit to specific tickers")
    parser.add_argument(
        "--years",
        type=int,
        default=DEFAULT_HISTORY_YEARS,
        help=f"Years of history to fetch (default: {DEFAULT_HISTORY_YEARS})",
    )
    args = parser.parse_args()

    setup_logging("dividend_scraper")
    run(tickers=args.ticker)
