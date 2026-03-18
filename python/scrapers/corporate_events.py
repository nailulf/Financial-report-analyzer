from __future__ import annotations

"""
corporate_events.py — Layer 6b scraper

Fetches public expose and AGM (RUPS) records from IDX disclosure endpoints
and stores them in the corporate_events table.

Both IDX endpoints used here are unofficial and may not always return data.
The scraper handles failures gracefully — a non-responsive endpoint results
in a skip (not a failure) for that ticker.

Run:
    cd python && python -m scrapers.corporate_events
    cd python && python -m scrapers.corporate_events --ticker BBRI
"""

import argparse
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from utils.helpers import RunResult, setup_logging, safe_str
from utils.idx_client import IDXClient
from utils.supabase_client import get_client, fetch_column, start_run, finish_run

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Parsers
# ---------------------------------------------------------------------------

def _parse_date(value) -> str | None:
    if not value:
        return None
    s = str(value)
    if "T" in s:
        s = s.split("T")[0]
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%Y%m%d", "%d-%m-%Y"):
        try:
            return datetime.strptime(s.strip(), fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None


def _parse_public_expose(ticker: str, items: list[dict]) -> list[dict]:
    """
    Parse IDX public expose items into corporate_events rows.

    IDX field candidates (endpoint format varies):
      Judul / Title / NamaAcara  — event title
      TanggalPublikasi / EventDate / Tanggal — event date
      LinkFile / Url — source URL
    """
    rows: list[dict] = []
    now = datetime.now(timezone.utc).isoformat()

    for item in items:
        if not isinstance(item, dict):
            continue
        title = safe_str(
            item.get("Judul") or item.get("Title") or item.get("NamaAcara") or item.get("title")
        )
        event_date = _parse_date(
            item.get("TanggalPublikasi") or item.get("EventDate")
            or item.get("Tanggal") or item.get("date")
        )
        source_url = safe_str(
            item.get("LinkFile") or item.get("Url") or item.get("url")
        )
        rows.append({
            "ticker":      ticker,
            "event_type":  "public_expose",
            "event_date":  event_date,
            "title":       title,
            "summary":     None,
            "source_url":  source_url,
            "fetched_at":  now,
        })

    return rows


def _parse_agm(ticker: str, items: list[dict]) -> list[dict]:
    """
    Parse IDX AGM/RUPS announcement items into corporate_events rows.
    """
    rows: list[dict] = []
    now = datetime.now(timezone.utc).isoformat()

    for item in items:
        if not isinstance(item, dict):
            continue
        title = safe_str(
            item.get("Judul") or item.get("Title") or item.get("title")
        )
        event_date = _parse_date(
            item.get("TanggalPublikasi") or item.get("EventDate")
            or item.get("Tanggal") or item.get("date")
        )
        # Classify RUPSLB (extraordinary) vs RUPS (ordinary)
        event_type = "egm" if (
            title and any(k in title.upper() for k in ["RUPSLB", "LUAR BIASA", "EXTRAORDINARY"])
        ) else "agm"

        source_url = safe_str(item.get("LinkFile") or item.get("Url") or item.get("url"))
        rows.append({
            "ticker":      ticker,
            "event_type":  event_type,
            "event_date":  event_date,
            "title":       title,
            "summary":     None,
            "source_url":  source_url,
            "fetched_at":  now,
        })

    return rows


# ---------------------------------------------------------------------------
# Per-ticker scraping
# ---------------------------------------------------------------------------

def _scrape_ticker(ticker: str, client: IDXClient) -> list[dict]:
    rows: list[dict] = []

    # Public expose
    expose_items = client.get_public_expose_list(ticker)
    if expose_items:
        parsed = _parse_public_expose(ticker, expose_items)
        rows.extend(parsed)
        logger.debug("%s: %d public expose event(s)", ticker, len(parsed))

    # AGM / RUPS
    agm_items = client.get_agm_list(ticker)
    if agm_items:
        parsed = _parse_agm(ticker, agm_items)
        rows.extend(parsed)
        logger.debug("%s: %d agm/egm event(s)", ticker, len(parsed))

    return rows


# ---------------------------------------------------------------------------
# Main scraper
# ---------------------------------------------------------------------------

def run(tickers: list[str] | None = None) -> RunResult:
    """
    Fetch corporate events (public expose + AGM) for each ticker.

    Strategy:
    - Delete existing events for each ticker, then re-insert fresh data.
    - If the IDX endpoint returns nothing (common for small-cap stocks), skip.
    - Failures (HTTP errors, timeouts) are logged and counted but don't abort.
    """
    result = RunResult("corporate_events")
    run_id = start_run(
        "corporate_events",
        metadata={"mode": "single" if tickers else "full"},
    )

    if tickers:
        ticker_list = [t.upper() for t in tickers]
    else:
        ticker_list = fetch_column("stocks", "ticker", filters={"status": "Active"})
        if not ticker_list:
            logger.error("No active stocks in Supabase. Run stock_universe.py first.")
            finish_run(run_id, "failed", error_message="stocks table is empty")
            return result

    logger.info("Fetching corporate events for %d tickers…", len(ticker_list))
    client = IDXClient()
    db = get_client()

    for i, ticker in enumerate(ticker_list, 1):
        logger.debug("[%d/%d] %s", i, len(ticker_list), ticker)
        try:
            rows = _scrape_ticker(ticker, client)
            if rows:
                # Full refresh: delete existing events then insert new ones
                db.table("corporate_events").delete().eq("ticker", ticker).execute()
                db.table("corporate_events").insert(rows).execute()
                result.ok(ticker)
            else:
                result.skip(ticker, "no events found from IDX")
        except Exception as exc:
            logger.warning("Failed %s: %s", ticker, exc)
            result.fail(ticker, str(exc))

    result.print_summary()
    finish_run(run_id, **result.to_db_kwargs())
    return result


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Fetch corporate events (public expose, AGM) → corporate_events"
    )
    parser.add_argument("--ticker", nargs="+", help="Test mode: only process these tickers")
    args = parser.parse_args()

    setup_logging("corporate_events")
    run(tickers=args.ticker)
