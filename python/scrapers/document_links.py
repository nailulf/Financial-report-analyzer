from __future__ import annotations

"""
document_links.py — Layer 6a scraper

Fetches annual report and quarterly financial report document links from
the IDX GetFinancialReport endpoint, then stores them in company_documents.

This does NOT download or parse the PDFs — it only records that a document
exists and stores its URL. Completeness scoring reads from this table.

Covers:
  - Annual reports (reportType=arr): last ANNUAL_REPORT_YEARS years
  - Quarterly reports (reportType=rdf): last QUARTERLY_PERIODS periods

Run:
    cd python && python -m scrapers.document_links
    cd python && python -m scrapers.document_links --ticker BBRI
"""

import argparse
import logging
import sys
from datetime import date, datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from utils.helpers import RunResult, setup_logging, safe_str
from utils.idx_client import IDXClient
from utils.supabase_client import bulk_upsert, fetch_column, start_run, finish_run
from config import IDX_BASE_URL

logger = logging.getLogger(__name__)

# How far back to look for documents
ANNUAL_REPORT_YEARS = 5
QUARTERLY_PERIODS   = 8   # quarters to check back (2 full years)


# ---------------------------------------------------------------------------
# URL construction
# ---------------------------------------------------------------------------

def _make_doc_url(file_id: str | None) -> str | None:
    """Build an IDX direct download URL from a file_id."""
    if not file_id:
        return None
    return f"{IDX_BASE_URL}/Download/GetFile?id={file_id}"


# ---------------------------------------------------------------------------
# Response parsers
# ---------------------------------------------------------------------------

def _parse_financial_report_results(
    ticker: str,
    results: list[dict],
    doc_type: str,
    period_year: int,
    period_quarter: int,
) -> list[dict]:
    """
    Parse IDX GetFinancialReport Results array into company_documents rows.

    Each result item may have top-level fields AND an Attachments list.
    We store one row per attachment (each is a separate file).
    If no attachments, store one row from the top-level fields.
    """
    rows: list[dict] = []
    now = datetime.now(timezone.utc).isoformat()

    for item in results:
        if not isinstance(item, dict):
            continue

        pub_date = _parse_date(
            item.get("File_Modified")
            or item.get("PublishedDate")
            or item.get("TanggalPublikasi")
        )

        attachments: list[dict] = item.get("Attachments") or []
        if attachments:
            for att in attachments:
                file_id = safe_str(att.get("File_ID") or att.get("FileID"))
                rows.append({
                    "ticker":          ticker,
                    "doc_type":        doc_type,
                    "period_year":     period_year,
                    "period_quarter":  period_quarter,
                    "file_id":         file_id,
                    "doc_url":         _make_doc_url(file_id),
                    "doc_title":       safe_str(item.get("Judul") or item.get("Title")),
                    "published_date":  pub_date,
                    "fetched_at":      now,
                })
        else:
            file_id = safe_str(item.get("File_ID") or item.get("FileID"))
            rows.append({
                "ticker":          ticker,
                "doc_type":        doc_type,
                "period_year":     period_year,
                "period_quarter":  period_quarter,
                "file_id":         file_id,
                "doc_url":         _make_doc_url(file_id),
                "doc_title":       safe_str(item.get("Judul") or item.get("Title")),
                "published_date":  pub_date,
                "fetched_at":      now,
            })

    return rows


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


# ---------------------------------------------------------------------------
# Per-ticker scraping
# ---------------------------------------------------------------------------

def _get_quarter_range(n_quarters: int) -> list[tuple[int, int]]:
    """
    Return the last n_quarters (year, quarter) tuples in reverse chronological order.
    e.g. for n=8 from 2026-Q1: [(2025,4),(2025,3),(2025,2),(2025,1),(2024,4),...]
    """
    today = date.today()
    current_year = today.year
    current_q = (today.month - 1) // 3 + 1

    periods: list[tuple[int, int]] = []
    y, q = current_year, current_q
    for _ in range(n_quarters):
        q -= 1
        if q == 0:
            q = 4
            y -= 1
        periods.append((y, q))
    return periods


def _scrape_ticker(ticker: str, client: IDXClient) -> list[dict]:
    """Fetch all document rows for one ticker."""
    rows: list[dict] = []
    today_year = date.today().year

    # Annual reports — last ANNUAL_REPORT_YEARS years
    for year in range(today_year - 1, today_year - 1 - ANNUAL_REPORT_YEARS, -1):
        try:
            results = client.get_annual_report_list(ticker, year)
            if results:
                parsed = _parse_financial_report_results(
                    ticker, results, "annual_report", year, 0
                )
                rows.extend(parsed)
                logger.debug("%s: annual_report %d → %d doc(s)", ticker, year, len(parsed))
        except Exception as exc:
            logger.debug("Annual report %d failed for %s: %s", year, ticker, exc)

    # Quarterly reports — last QUARTERLY_PERIODS quarters
    for year, quarter in _get_quarter_range(QUARTERLY_PERIODS):
        try:
            results = client.get_financial_report_list(ticker, year, quarter)
            if results:
                parsed = _parse_financial_report_results(
                    ticker, results, "quarterly_report", year, quarter
                )
                rows.extend(parsed)
                logger.debug(
                    "%s: quarterly_report %dQ%d → %d doc(s)", ticker, year, quarter, len(parsed)
                )
        except Exception as exc:
            logger.debug(
                "Quarterly report %dQ%d failed for %s: %s", year, quarter, ticker, exc
            )

    return rows


# ---------------------------------------------------------------------------
# Main scraper
# ---------------------------------------------------------------------------

def run(tickers: list[str] | None = None) -> RunResult:
    """
    Fetch annual and quarterly report document links from IDX.
    Upserts into company_documents (one row per document per period).
    """
    result = RunResult("document_links")
    run_id = start_run(
        "document_links",
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

    logger.info("Fetching document links for %d tickers…", len(ticker_list))
    client = IDXClient()
    all_rows: list[dict] = []

    for i, ticker in enumerate(ticker_list, 1):
        logger.debug("[%d/%d] %s", i, len(ticker_list), ticker)
        try:
            rows = _scrape_ticker(ticker, client)
            if rows:
                all_rows.extend(rows)
                result.ok(ticker)
            else:
                result.skip(ticker, "no documents found")
        except Exception as exc:
            logger.warning("Failed %s: %s", ticker, exc)
            result.fail(ticker, str(exc))

    if all_rows:
        # Deduplicate by unique key — keep first occurrence per (ticker, doc_type, period_year, period_quarter).
        # Multiple attachments per period share the same key; PostgreSQL's ON CONFLICT cannot
        # update the same row twice within one batch, so we collapse to one row before upserting.
        seen: set[tuple] = set()
        deduped: list[dict] = []
        for row in all_rows:
            key = (row["ticker"], row["doc_type"], row["period_year"], row["period_quarter"])
            if key not in seen:
                seen.add(key)
                deduped.append(row)
        logger.info("Upserting %d document records (%d dupes dropped)…", len(deduped), len(all_rows) - len(deduped))
        bulk_upsert(
            "company_documents",
            deduped,
            on_conflict="ticker,doc_type,period_year,period_quarter",
        )

    result.print_summary()
    finish_run(run_id, **result.to_db_kwargs())
    return result


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Fetch IDX annual/quarterly report document links → company_documents"
    )
    parser.add_argument("--ticker", nargs="+", help="Test mode: only process these tickers")
    args = parser.parse_args()

    setup_logging("document_links")
    run(tickers=args.ticker)
