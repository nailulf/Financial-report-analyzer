from __future__ import annotations

"""
run_all.py — Master orchestrator

Controls which scrapers run, in what order, and with what arguments.

Usage:
    python run_all.py --daily          # daily_prices + money_flow
    python run_all.py --weekly         # stock_universe
    python run_all.py --quarterly      # financials + company_profiles
    python run_all.py --full           # everything (weekly + quarterly + daily)
    python run_all.py --ticker BBRI    # all scrapers for one stock (testing)

    # Mix and match:
    python run_all.py --daily --ticker BBRI ASII
    python run_all.py --quarterly --period annual
"""
import argparse
import logging
import sys
import time
from datetime import datetime, timezone

from utils.helpers import setup_logging
from rich.console import Console

console = Console()
logger = logging.getLogger("run_all")

# Scraper import is deferred to avoid slow imports when only one flag is used
def _import_scrapers():
    from scrapers import stock_universe, daily_prices, financials, company_profiles, money_flow
    return stock_universe, daily_prices, financials, company_profiles, money_flow


def _import_phase2_scrapers():
    from scrapers import document_links, corporate_events
    return document_links, corporate_events


def _import_enrichment_scrapers():
    from scrapers import ratio_enricher, dividend_scraper, gap_filler, financials_fallback
    return ratio_enricher, dividend_scraper, gap_filler, financials_fallback


# ------------------------------------------------------------------
# Refresh job helpers
# ------------------------------------------------------------------

def _sector_matches(user_term: str, sector: str) -> bool:
    """
    Return True if user_term loosely matches a sector name.

    Matching strategy (applied in order, first match wins):
      1. Substring: "health" matches "Healthcare", "barang" matches "Barang Konsumen Primer"
      2. Reverse substring: "Financials" matches search term "fullfinancials" (edge case)
      3. Fuzzy: SequenceMatcher ratio > 0.70 — catches "finance" → "Financials" (ratio ≈ 0.71)
    """
    from difflib import SequenceMatcher
    u = user_term.lower().strip()
    s = sector.lower().strip()
    if len(u) < 3:
        return u == s
    if u in s or s in u:
        return True
    return SequenceMatcher(None, u, s).ratio() > 0.70


def _tickers_for_sectors(sectors: list[str]) -> list[str]:
    """
    Resolve a list of sector names to their constituent tickers from the DB.

    Sector matching is case-insensitive, supports partial names, and fuzzy matches:
        "finance"  → matches "Financials"
        "energy"   → matches "Energy"
        "consumer" → matches both "Barang Konsumen Primer" and "Barang Konsumen Non-Primer"
        "health"   → matches "Healthcare"

    Raises SystemExit if no tickers are found (likely a typo in sector name).
    """
    from utils.supabase_client import get_client
    db = get_client()
    resp = db.from_("stocks").select("ticker, sector").eq("status", "Active").execute()
    all_stocks = resp.data or []

    matched: list[str] = []
    matched_sectors: set[str] = set()
    for row in all_stocks:
        sector = (row.get("sector") or "").strip()
        if any(_sector_matches(s, sector) for s in sectors):
            matched.append(row["ticker"])
            matched_sectors.add(sector)

    if not matched:
        available = sorted({(r.get("sector") or "").strip() for r in all_stocks if r.get("sector")})
        console.print(f"[red]No tickers found for sector(s): {sectors}[/red]")
        console.print(f"[yellow]Available sectors:[/yellow]")
        for s in available:
            count = sum(1 for r in all_stocks if (r.get("sector") or "").strip() == s)
            console.print(f"  {s}  ({count} stocks)")
        sys.exit(1)

    console.print(f"[cyan]Sector filter → {len(matched)} tickers across: {sorted(matched_sectors)}[/cyan]")
    return sorted(matched)


def _detect_job(tickers: list[str] | None) -> int | None:
    """Auto-detect a pending UI refresh job when running for exactly one ticker."""
    if not tickers or len(tickers) != 1:
        return None
    from utils.supabase_client import get_pending_refresh_job
    job_id = get_pending_refresh_job(tickers[0])
    if job_id:
        logger.info("Detected pending refresh job %d for %s", job_id, tickers[0])
    return job_id


def _run_tracked(scraper_fn, scraper_name: str, job_id: int | None, **kwargs):
    """
    Call scraper_fn(**kwargs). If job_id is set, bracket the call with
    refresh_scraper_progress updates (running → done/failed).
    Exceptions propagate after marking the progress row as failed.
    """
    if job_id is None:
        return scraper_fn(**kwargs)

    from utils.supabase_client import update_refresh_scraper_progress
    update_refresh_scraper_progress(job_id, scraper_name, "running")
    t0 = datetime.now(timezone.utc)
    try:
        result = scraper_fn(**kwargs)
        duration_ms = int((datetime.now(timezone.utc) - t0).total_seconds() * 1000)
        update_refresh_scraper_progress(
            job_id, scraper_name, "done",
            rows_added=result.n_ok,
            duration_ms=duration_ms,
        )
        return result
    except Exception as exc:
        duration_ms = int((datetime.now(timezone.utc) - t0).total_seconds() * 1000)
        update_refresh_scraper_progress(
            job_id, scraper_name, "failed",
            duration_ms=duration_ms,
            error_msg=str(exc),
        )
        raise


def _run_tracked_optional(scraper_fn, scraper_name: str, job_id: int | None, **kwargs):
    """
    Like _run_tracked but non-fatal — exceptions are caught, logged, and the
    progress row is marked 'failed', but execution continues.
    Used for Phase 2 scrapers (document_links, corporate_events) whose DB tables
    may not be created yet, so a failure should never block score recalculation.
    """
    try:
        return _run_tracked(scraper_fn, scraper_name, job_id, **kwargs)
    except Exception as exc:
        logger.warning("Scraper '%s' failed (non-fatal, pipeline continues): %s", scraper_name, exc)
        return None


def _finalize_job(job_id: int, ticker: str, status: str, error_message: str | None = None) -> None:
    """
    Close out a stock_refresh_requests job: write after-scores, set status + finished_at.
    Sets no_new_data=True when the job succeeded but all scrapers added 0 rows.
    """
    from utils.supabase_client import update_refresh_job, fetch_one, fetch_all
    stock = fetch_one("stocks", "completeness_score, confidence_score", {"ticker": ticker.upper()})
    prog = fetch_all("refresh_scraper_progress", "rows_added", {"request_id": job_id})
    total_rows = sum((r.get("rows_added") or 0) for r in prog)
    fields: dict = {
        "status": status,
        "finished_at": datetime.now(timezone.utc).isoformat(),
        "completeness_after": (stock or {}).get("completeness_score"),
        "confidence_after": (stock or {}).get("confidence_score"),
        "no_new_data": (total_rows == 0 and status == "done"),
    }
    if error_message:
        fields["error_message"] = error_message
    update_refresh_job(job_id, **fields)
    logger.info("Finalized refresh job %d: status=%s no_new_data=%s", job_id, status, fields["no_new_data"])


# ------------------------------------------------------------------
# Run modes
# ------------------------------------------------------------------

def _update_scores(tickers: list[str] | None) -> None:
    """Recompute completeness + confidence scores after a scraper run."""
    from utils.score_calculator import update_scores_for_ticker, update_all_scores
    console.rule("[bold cyan]SCORES: updating completeness & confidence")
    if tickers:
        for ticker in tickers:
            update_scores_for_ticker(ticker)
    else:
        update_all_scores()


def run_daily(tickers: list[str] | None, days: int, job_id: int | None = None) -> None:
    """Runs: daily_prices → money_flow → scores"""
    _, dp, _, _, mf = _import_scrapers()
    console.rule("[bold blue]DAILY: daily_prices")
    _run_tracked(dp.run, "daily_prices", job_id, tickers=tickers)
    console.rule("[bold blue]DAILY: money_flow")
    _run_tracked(mf.run, "money_flow", job_id, tickers=tickers, days=days)
    _update_scores(tickers)


def run_weekly(tickers: list[str] | None, job_id: int | None = None) -> None:
    """Runs: stock_universe → scores"""
    su, *_ = _import_scrapers()
    console.rule("[bold green]WEEKLY: stock_universe")
    _run_tracked(su.run, "stock_universe", job_id, tickers=tickers)
    _update_scores(tickers)


def run_quarterly(tickers: list[str] | None, period: str, job_id: int | None = None) -> None:
    """Runs: financials → company_profiles → document_links → corporate_events → scores"""
    _, _, fin, cp, _ = _import_scrapers()
    dl, ce = _import_phase2_scrapers()
    console.rule("[bold yellow]QUARTERLY: financials")
    _run_tracked(fin.run, "financials", job_id, tickers=tickers, period=period)
    console.rule("[bold yellow]QUARTERLY: company_profiles")
    _run_tracked(cp.run, "company_profiles", job_id, tickers=tickers)
    console.rule("[bold yellow]QUARTERLY: document_links")
    _run_tracked_optional(dl.run, "document_links", job_id, tickers=tickers)
    console.rule("[bold yellow]QUARTERLY: corporate_events")
    _run_tracked_optional(ce.run, "corporate_events", job_id, tickers=tickers)
    _update_scores(tickers)


def run_enrich_ratios(tickers: list[str] | None, dry_run: bool = False) -> None:
    """Runs: ratio_enricher → scores"""
    re_, _, _, _ = _import_enrichment_scrapers()
    console.rule("[bold magenta]ENRICH: ratio_enricher")
    _run_tracked(re_.run, "ratio_enricher", None, tickers=tickers, dry_run=dry_run)
    if not dry_run:
        _update_scores(tickers)


def run_dividends(tickers: list[str] | None) -> None:
    """Runs: dividend_scraper"""
    _, ds, _, _ = _import_enrichment_scrapers()
    console.rule("[bold magenta]ENRICH: dividend_scraper")
    _run_tracked(ds.run, "dividend_scraper", None, tickers=tickers)


def run_financials_fallback(
    tickers: list[str] | None,
    source: str,
    only_missing: bool,
    dry_run: bool = False,
) -> None:
    """Runs: financials_fallback (Stockbit + FMP multi-source backfill)"""
    _, _, _, ff = _import_enrichment_scrapers()
    console.rule("[bold magenta]FALLBACK: financials_fallback")
    _run_tracked(ff.run, "financials_fallback", None,
                 tickers=tickers, source=source, only_missing=only_missing, dry_run=dry_run)
    if not dry_run:
        _update_scores(tickers)


def run_fill_gaps(
    tickers: list[str] | None,
    min_score: int,
    limit: int | None,
    categories: list[str] | None,
    dry_run: bool = False,
) -> None:
    """Runs: gap_filler"""
    _, _, gf, _ = _import_enrichment_scrapers()
    console.rule("[bold magenta]GAPS: gap_filler")
    gf.run(
        tickers=tickers,
        min_score=min_score,
        limit=limit,
        categories=categories,
        dry_run=dry_run,
    )


def run_full(tickers: list[str] | None, period: str, days: int, job_id: int | None = None) -> None:
    """Runs everything in dependency order. Scores updated once at the end."""
    su, dp, fin, cp, mf = _import_scrapers()
    dl, ce = _import_phase2_scrapers()
    console.rule("[bold green]WEEKLY: stock_universe")
    _run_tracked(su.run, "stock_universe", job_id, tickers=tickers)
    console.rule("[bold yellow]QUARTERLY: financials")
    _run_tracked(fin.run, "financials", job_id, tickers=tickers, period=period)
    console.rule("[bold yellow]QUARTERLY: company_profiles")
    _run_tracked(cp.run, "company_profiles", job_id, tickers=tickers)
    console.rule("[bold yellow]QUARTERLY: document_links")
    _run_tracked_optional(dl.run, "document_links", job_id, tickers=tickers)
    console.rule("[bold yellow]QUARTERLY: corporate_events")
    _run_tracked_optional(ce.run, "corporate_events", job_id, tickers=tickers)
    console.rule("[bold blue]DAILY: daily_prices")
    _run_tracked(dp.run, "daily_prices", job_id, tickers=tickers)
    console.rule("[bold blue]DAILY: money_flow")
    _run_tracked(mf.run, "money_flow", job_id, tickers=tickers, days=days)
    _update_scores(tickers)


# ------------------------------------------------------------------
# CLI
# ------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="IDX Stock Analyzer — Data Pipeline Orchestrator",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python run_all.py --daily
  python run_all.py --weekly
  python run_all.py --quarterly
  python run_all.py --full
  python run_all.py --ticker BBRI ASII BBCA
  python run_all.py --daily --ticker BBRI
  python run_all.py --quarterly --period annual

  # Sector-based scraping (partial match, case-insensitive):
  python run_all.py --fallback-financials --sector finance
  python run_all.py --quarterly --sector energy
  python run_all.py --fallback-financials --sector "barang konsumen"   # both consumer sectors
  python run_all.py --daily --sector healthcare technology
  python run_all.py --fallback-financials --sector finance --dry-run

  # Enrichment & gap filling:
  python run_all.py --enrich-ratios                    # fill NULL ratios from stored data
  python run_all.py --enrich-ratios --ticker BBRI      # single ticker
  python run_all.py --enrich-ratios --dry-run          # preview only
  python run_all.py --dividends                        # fetch all dividend history
  python run_all.py --fill-gaps                        # fix top-100 most incomplete stocks
  python run_all.py --fill-gaps --min-score 50         # only very incomplete stocks
  python run_all.py --fill-gaps --gap-limit 20         # process 20 stocks per run
  python run_all.py --fill-gaps --gap-category ratios prices  # specific gap types
  python run_all.py --fill-gaps --dry-run              # detect gaps, no writes
  python run_all.py --fallback-financials              # Stockbit+FMP backfill (only missing)
  python run_all.py --fallback-financials --fallback-source fmp   # FMP only
  python run_all.py --fallback-financials --ticker BBRI --dry-run
        """,
    )

    # Mode flags (at least one required)
    mode = parser.add_argument_group("Run modes (pick one or more)")
    mode.add_argument("--daily", action="store_true", help="Run: daily_prices + money_flow")
    mode.add_argument("--weekly", action="store_true", help="Run: stock_universe")
    mode.add_argument("--quarterly", action="store_true", help="Run: financials + company_profiles")
    mode.add_argument("--full", action="store_true", help="Run everything (weekly + quarterly + daily)")
    mode.add_argument("--enrich-ratios", action="store_true", help="Fill NULL ratio columns from stored raw data (no API calls)")
    mode.add_argument("--dividends", action="store_true", help="Fetch full dividend history from yfinance")
    mode.add_argument("--fill-gaps", action="store_true", help="Detect and fill data gaps for low-completeness stocks")
    mode.add_argument("--fallback-financials", action="store_true", help="Backfill financial data from Stockbit + FMP where yfinance data is missing")

    # Scope modifiers
    parser.add_argument("--ticker", nargs="+", metavar="TICKER", help="Limit to specific tickers")
    parser.add_argument(
        "--sector",
        nargs="+",
        metavar="SECTOR",
        help="Limit to tickers in these sectors (case-insensitive, partial match). "
             "E.g. --sector finance energy  or  --sector 'Barang Konsumen'",
    )
    parser.add_argument(
        "--job-id",
        type=int,
        default=None,
        metavar="ID",
        help="Link this run to a stock_refresh_requests job (auto-detected for single --ticker runs)",
    )
    parser.add_argument(
        "--period",
        choices=["annual", "quarterly", "both"],
        default="both",
        help="Financials period type (default: both)",
    )
    parser.add_argument(
        "--days",
        type=int,
        default=2,
        help="Number of recent trading days for money_flow (default: 2)",
    )
    # Gap filler options
    parser.add_argument(
        "--min-score",
        type=int,
        default=70,
        metavar="N",
        help="--fill-gaps: process stocks with completeness < N (default: 70)",
    )
    parser.add_argument(
        "--gap-limit",
        type=int,
        default=100,
        metavar="N",
        help="--fill-gaps: max tickers to process per run (default: 100)",
    )
    parser.add_argument(
        "--gap-category",
        nargs="+",
        metavar="CAT",
        help="--fill-gaps: limit to specific gap categories "
             "(prices, financials_annual, financials_quarterly, ratios, profile, officers, shareholders, dividends)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="--fill-gaps / --enrich-ratios / --fallback-financials: detect issues but do not write to DB",
    )
    # Fallback financials options
    parser.add_argument(
        "--fallback-source",
        choices=["stockbit", "fmp", "both"],
        default="both",
        metavar="SRC",
        help="--fallback-financials: data source (stockbit, fmp, both — default: both)",
    )
    parser.add_argument(
        "--fallback-all",
        action="store_true",
        help="--fallback-financials: process all tickers even if data exists (default: only missing)",
    )

    args = parser.parse_args()

    all_modes = [args.daily, args.weekly, args.quarterly, args.full,
                 args.enrich_ratios, args.dividends, args.fill_gaps, args.fallback_financials]
    if not any(all_modes):
        parser.print_help()
        console.print("\n[red]Error: specify at least one run mode.[/red]")
        sys.exit(1)

    setup_logging("run_all")

    start = datetime.now()
    console.rule(f"[bold]IDX Stock Analyzer — {start.strftime('%Y-%m-%d %H:%M')}[/bold]")

    # Resolve --sector into a ticker list (merges with any explicit --ticker)
    tickers: list[str] | None = args.ticker
    if args.sector:
        sector_tickers = _tickers_for_sectors(args.sector)
        if tickers:
            # Union: explicit tickers + sector tickers (deduplicated)
            tickers = sorted(set(tickers) | set(sector_tickers))
            console.print(f"[cyan]Scope: {len(tickers)} tickers (--ticker + --sector combined)[/cyan]")
        else:
            tickers = sector_tickers
    elif tickers:
        console.print(f"[cyan]Scope: tickers = {tickers}[/cyan]")

    # Detect or use explicit refresh job id (only meaningful for single-ticker runs)
    job_id: int | None = args.job_id or _detect_job(tickers)
    if job_id:
        from utils.supabase_client import update_refresh_job
        update_refresh_job(job_id, status="running")
        console.print(f"[cyan]Linked to refresh job #{job_id}[/cyan]")

    try:
        if args.full:
            run_full(tickers, args.period, args.days, job_id=job_id)
        else:
            if args.weekly:
                run_weekly(tickers, job_id=job_id)
            if args.quarterly:
                run_quarterly(tickers, args.period, job_id=job_id)
            if args.daily:
                run_daily(tickers, args.days, job_id=job_id)
            if args.enrich_ratios:
                run_enrich_ratios(tickers, dry_run=args.dry_run)
            if args.dividends:
                run_dividends(tickers)
            if args.fill_gaps:
                run_fill_gaps(
                    tickers=tickers,
                    min_score=args.min_score,
                    limit=args.gap_limit,
                    categories=args.gap_category,
                    dry_run=args.dry_run,
                )
            if args.fallback_financials:
                run_financials_fallback(
                    tickers=tickers,
                    source=args.fallback_source,
                    only_missing=not args.fallback_all,
                    dry_run=args.dry_run,
                )
    except KeyboardInterrupt:
        if job_id and tickers and len(tickers) == 1:
            _finalize_job(job_id, tickers[0], "failed", "interrupted by user")
        console.print("\n[yellow]Run interrupted by user.[/yellow]")
        sys.exit(130)
    except Exception as e:
        if job_id and tickers and len(tickers) == 1:
            _finalize_job(job_id, tickers[0], "failed", str(e))
        logger.exception("Unhandled error: %s", e)
        console.print(f"\n[red]Fatal error: {e}[/red]")
        sys.exit(1)
    else:
        if job_id and tickers and len(tickers) == 1:
            _finalize_job(job_id, tickers[0], "done")

    elapsed = (datetime.now() - start).total_seconds()
    console.rule(f"[bold green]Done in {elapsed:.1f}s[/bold green]")


if __name__ == "__main__":
    main()
