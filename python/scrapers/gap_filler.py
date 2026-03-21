from __future__ import annotations

"""
gap_filler.py — Targeted re-scraper for incomplete stocks.

Scans all active stocks ordered by completeness_score (lowest first),
identifies which data categories are missing per ticker, and re-runs
the appropriate scrapers to fill those gaps.

This lets the data pool converge toward full completeness over time by
processing the most incomplete stocks first on each run.

Gap categories detected:
  prices              → re-runs daily_prices
  financials_annual   → re-runs financials (period=annual)
  financials_quarterly→ re-runs financials (period=quarterly)
  ratios              → re-runs ratio_enricher (no API calls)
  profile             → re-runs company_profiles
  officers            → re-runs company_profiles (batched with profile)
  shareholders        → re-runs company_profiles (batched with profile)
  dividends           → re-runs dividend_scraper

Run:
    cd python && python -m scrapers.gap_filler
    cd python && python -m scrapers.gap_filler --min-score 60
    cd python && python -m scrapers.gap_filler --limit 50
    cd python && python -m scrapers.gap_filler --category prices ratios
    cd python && python -m scrapers.gap_filler --dry-run
"""

import argparse
import logging
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from utils.helpers import RunResult, setup_logging
from utils.supabase_client import get_client, start_run, finish_run
from utils.score_calculator import update_scores_for_ticker

from rich.console import Console
from rich.table import Table

console = Console()
logger = logging.getLogger(__name__)

# Default: fill stocks below this completeness threshold
DEFAULT_MIN_SCORE = 70
# Default: process at most this many tickers per run (None = unlimited)
DEFAULT_LIMIT = 100

# All gap categories in priority order (highest data impact first)
ALL_CATEGORIES = [
    "prices",
    "financials_annual",
    "financials_quarterly",
    "ratios",
    "profile",
    "officers",
    "shareholders",
    "dividends",
]


# ---------------------------------------------------------------------------
# Gap detection — check what's missing for a single ticker
# ---------------------------------------------------------------------------

def _check_gaps(client, ticker: str, categories: list[str]) -> list[str]:
    """
    Return a list of gap category names for this ticker by making fast
    existence checks against the relevant tables.
    Only checks categories that are in the requested `categories` filter.
    """
    gaps: list[str] = []

    def _want(cat: str) -> bool:
        return cat in categories

    # ---- Prices ----
    if _want("prices"):
        resp = (
            client.table("daily_prices")
            .select("ticker")
            .eq("ticker", ticker)
            .limit(1)
            .execute()
        )
        if not (resp.data or []):
            gaps.append("prices")

    # ---- Annual financials ----
    if _want("financials_annual"):
        resp = (
            client.table("financials")
            .select("ticker")
            .eq("ticker", ticker)
            .eq("quarter", 0)
            .limit(1)
            .execute()
        )
        if not (resp.data or []):
            gaps.append("financials_annual")

    # ---- Quarterly financials ----
    if _want("financials_quarterly"):
        resp = (
            client.table("financials")
            .select("ticker")
            .eq("ticker", ticker)
            .gt("quarter", 0)
            .limit(1)
            .execute()
        )
        if not (resp.data or []):
            gaps.append("financials_quarterly")

    # ---- Ratios — check if core ratios are ALL null in most recent annual row ----
    if _want("ratios"):
        resp = (
            client.table("financials")
            .select("roe, pe_ratio, net_margin, gross_margin")
            .eq("ticker", ticker)
            .eq("quarter", 0)
            .order("year", desc=True)
            .limit(1)
            .execute()
        )
        if resp.data:
            row = resp.data[0]
            if all(row.get(f) is None for f in ["roe", "pe_ratio", "net_margin", "gross_margin"]):
                gaps.append("ratios")

    # ---- Company profile ----
    if _want("profile"):
        resp = (
            client.table("company_profiles")
            .select("ticker")
            .eq("ticker", ticker)
            .execute()
        )
        if not (resp.data or []):
            gaps.append("profile")

    # ---- Officers ----
    if _want("officers"):
        resp = (
            client.table("company_officers")
            .select("ticker")
            .eq("ticker", ticker)
            .limit(1)
            .execute()
        )
        if not (resp.data or []):
            gaps.append("officers")

    # ---- Shareholders ----
    if _want("shareholders"):
        resp = (
            client.table("shareholders")
            .select("ticker")
            .eq("ticker", ticker)
            .limit(1)
            .execute()
        )
        if not (resp.data or []):
            gaps.append("shareholders")

    # ---- Dividends (table may not exist yet — handle gracefully) ----
    if _want("dividends"):
        try:
            resp = (
                client.table("dividend_history")
                .select("ticker")
                .eq("ticker", ticker)
                .limit(1)
                .execute()
            )
            if not (resp.data or []):
                gaps.append("dividends")
        except Exception:
            pass  # table doesn't exist yet — skip silently

    return gaps


# ---------------------------------------------------------------------------
# Gap → scraper mapping
# ---------------------------------------------------------------------------

def _gaps_to_scrapers(gaps: list[str]) -> list[str]:
    """
    Map gap categories to the set of scrapers to run, in the order they
    should be executed. Deduplicates (profile + officers + shareholders all
    map to company_profiles, which is only run once).
    """
    scrapers: list[str] = []
    seen: set[str] = set()

    def _add(s: str) -> None:
        if s not in seen:
            scrapers.append(s)
            seen.add(s)

    for gap in gaps:
        if gap == "prices":
            _add("daily_prices")
        elif gap in ("financials_annual", "financials_quarterly"):
            _add("financials")
        elif gap == "ratios":
            _add("ratio_enricher")
        elif gap in ("profile", "officers", "shareholders"):
            _add("company_profiles")
        elif gap == "dividends":
            _add("dividend_scraper")
        elif gap == "financials_fallback":
            _add("financials_fallback")

    return scrapers


def _run_scraper(scraper_name: str, ticker: str, gaps: list[str]) -> bool:
    """
    Run a specific scraper for a single ticker.
    Returns True on success, False on failure.
    """
    from scrapers import (
        daily_prices,
        financials,
        company_profiles,
    )
    from scrapers.ratio_enricher import run as run_ratio_enricher
    from scrapers.dividend_scraper import run as run_dividend_scraper
    from scrapers.financials_fallback import run as run_financials_fallback

    try:
        if scraper_name == "daily_prices":
            daily_prices.run(tickers=[ticker])

        elif scraper_name == "financials":
            # Determine which period(s) to fetch based on what's missing
            has_annual = "financials_annual" in gaps
            has_quarterly = "financials_quarterly" in gaps
            if has_annual and has_quarterly:
                period = "both"
            elif has_annual:
                period = "annual"
            else:
                period = "quarterly"
            financials.run(tickers=[ticker], period=period)
            # After primary yfinance attempt, run fallback to fill any remaining NULLs
            run_financials_fallback(
                tickers=[ticker],
                source="both",
                only_missing=True,
                annual=has_annual,
                quarterly=has_quarterly,
            )

        elif scraper_name == "ratio_enricher":
            run_ratio_enricher(tickers=[ticker])

        elif scraper_name == "company_profiles":
            company_profiles.run(tickers=[ticker])

        elif scraper_name == "dividend_scraper":
            run_dividend_scraper(tickers=[ticker])

        elif scraper_name == "financials_fallback":
            run_financials_fallback(tickers=[ticker], source="both", only_missing=True)

        return True

    except Exception as e:
        logger.warning("  Scraper '%s' failed for %s: %s", scraper_name, ticker, e)
        return False


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def run(
    tickers: list[str] | None = None,
    min_score: int = DEFAULT_MIN_SCORE,
    limit: int | None = DEFAULT_LIMIT,
    categories: list[str] | None = None,
    dry_run: bool = False,
) -> RunResult:
    """
    Fill data gaps for stocks with completeness_score below `min_score`.

    Args:
        tickers:    If provided, only check these tickers (ignores min_score).
        min_score:  Only process stocks with completeness_score < this value.
        limit:      Maximum number of tickers to process in this run.
        categories: Limit gap checks to these categories. None = all.
        dry_run:    Detect and report gaps but do not run scrapers.
    """
    result = RunResult("gap_filler")
    run_id = start_run(
        "gap_filler",
        metadata={
            "min_score": min_score,
            "limit": limit,
            "categories": categories or ALL_CATEGORIES,
            "dry_run": dry_run,
        },
    )

    client = get_client()
    active_categories = categories or ALL_CATEGORIES

    # ---- Identify target tickers ----

    if tickers:
        # Explicit list: process regardless of score
        target_tickers = [t.upper() for t in tickers]
        logger.info("Gap filler: explicit tickers = %s", target_tickers)
    else:
        # Auto-select: stocks with completeness below threshold
        resp = (
            client.table("stocks")
            .select("ticker, completeness_score")
            .eq("status", "Active")
            .or_(f"completeness_score.lt.{min_score},completeness_score.is.null")
            .order("completeness_score", desc=False, nullsfirst=True)
            .execute()
        )
        all_candidates = resp.data or []
        target_tickers = [r["ticker"] for r in all_candidates]
        logger.info(
            "Found %d stocks with completeness < %d",
            len(target_tickers), min_score,
        )

    if limit is not None:
        target_tickers = target_tickers[:limit]

    if not target_tickers:
        logger.info("No stocks to process — all above threshold or none found.")
        finish_run(run_id, "success")
        return result

    console.print(
        f"[cyan]Gap filler: processing {len(target_tickers)} tickers "
        f"(min_score<{min_score}, categories={active_categories})"
        f"{'  [DRY RUN]' if dry_run else ''}[/cyan]"
    )

    # ---- Process each ticker ----

    gap_summary: list[dict] = []  # for the final report table

    for i, ticker in enumerate(target_tickers, 1):
        logger.info("[%d/%d] Checking %s…", i, len(target_tickers), ticker)

        gaps = _check_gaps(client, ticker, active_categories)

        if not gaps:
            result.skip(ticker, "no gaps detected")
            gap_summary.append({"ticker": ticker, "gaps": [], "scrapers": [], "status": "skip"})
            continue

        scrapers_to_run = _gaps_to_scrapers(gaps)
        logger.info("  %s: gaps=%s → scrapers=%s", ticker, gaps, scrapers_to_run)

        if dry_run:
            gap_summary.append({"ticker": ticker, "gaps": gaps, "scrapers": scrapers_to_run, "status": "dry_run"})
            result.skip(ticker, f"dry-run: gaps={gaps}")
            continue

        # Run each scraper
        all_ok = True
        for scraper_name in scrapers_to_run:
            success = _run_scraper(scraper_name, ticker, gaps)
            if not success:
                all_ok = False

        # Re-score after filling gaps
        try:
            update_scores_for_ticker(ticker)
        except Exception as e:
            logger.warning("  Score update failed for %s: %s", ticker, e)

        if all_ok:
            result.ok(ticker)
            gap_summary.append({"ticker": ticker, "gaps": gaps, "scrapers": scrapers_to_run, "status": "ok"})
        else:
            result.fail(ticker, "one or more scrapers failed")
            gap_summary.append({"ticker": ticker, "gaps": gaps, "scrapers": scrapers_to_run, "status": "partial"})

        # Brief pause between tickers to avoid rate-limit pile-up
        time.sleep(0.3)

    # ---- Print gap summary table ----

    table = Table(title="Gap Filler — Results", show_header=True)
    table.add_column("Ticker", style="bold")
    table.add_column("Gaps Found")
    table.add_column("Scrapers Run")
    table.add_column("Status")

    status_colors = {"ok": "green", "skip": "yellow", "dry_run": "cyan", "partial": "orange1"}

    for entry in gap_summary:
        color = status_colors.get(entry["status"], "white")
        table.add_row(
            entry["ticker"],
            ", ".join(entry["gaps"]) or "—",
            ", ".join(entry["scrapers"]) or "—",
            f"[{color}]{entry['status']}[/{color}]",
        )

    console.print(table)

    result.print_summary()
    finish_run(run_id, **result.to_db_kwargs())
    return result


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Gap filler — detect and fill missing data for incomplete IDX stocks",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python -m scrapers.gap_filler                          # fill all stocks < 70% complete
  python -m scrapers.gap_filler --min-score 50           # only very incomplete stocks
  python -m scrapers.gap_filler --limit 20               # process at most 20 tickers
  python -m scrapers.gap_filler --ticker BBRI ASII       # specific tickers
  python -m scrapers.gap_filler --category ratios prices # only specific gap types
  python -m scrapers.gap_filler --dry-run                # detect gaps only, no writes
        """,
    )
    parser.add_argument("--ticker", nargs="+", help="Specific tickers to check")
    parser.add_argument(
        "--min-score",
        type=int,
        default=DEFAULT_MIN_SCORE,
        metavar="N",
        help=f"Process stocks with completeness < N (default: {DEFAULT_MIN_SCORE})",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=DEFAULT_LIMIT,
        metavar="N",
        help=f"Max tickers to process in one run (default: {DEFAULT_LIMIT})",
    )
    parser.add_argument(
        "--category",
        nargs="+",
        choices=ALL_CATEGORIES,
        metavar="CAT",
        help=f"Limit to specific gap categories: {ALL_CATEGORIES}",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Detect gaps and report, but do not run any scrapers",
    )
    args = parser.parse_args()

    setup_logging("gap_filler")
    run(
        tickers=args.ticker,
        min_score=args.min_score,
        limit=args.limit,
        categories=args.category,
        dry_run=args.dry_run,
    )
