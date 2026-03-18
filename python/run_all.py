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


# ------------------------------------------------------------------
# Refresh job helpers
# ------------------------------------------------------------------

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
    _run_tracked(dl.run, "document_links", job_id, tickers=tickers)
    console.rule("[bold yellow]QUARTERLY: corporate_events")
    _run_tracked(ce.run, "corporate_events", job_id, tickers=tickers)
    _update_scores(tickers)


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
    _run_tracked(dl.run, "document_links", job_id, tickers=tickers)
    console.rule("[bold yellow]QUARTERLY: corporate_events")
    _run_tracked(ce.run, "corporate_events", job_id, tickers=tickers)
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
        """,
    )

    # Mode flags (at least one required)
    mode = parser.add_argument_group("Run modes (pick one or more)")
    mode.add_argument("--daily", action="store_true", help="Run: daily_prices + money_flow")
    mode.add_argument("--weekly", action="store_true", help="Run: stock_universe")
    mode.add_argument("--quarterly", action="store_true", help="Run: financials + company_profiles")
    mode.add_argument("--full", action="store_true", help="Run everything (weekly + quarterly + daily)")

    # Scope modifiers
    parser.add_argument("--ticker", nargs="+", metavar="TICKER", help="Limit to specific tickers")
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

    args = parser.parse_args()

    if not any([args.daily, args.weekly, args.quarterly, args.full]):
        parser.print_help()
        console.print("\n[red]Error: specify at least one run mode.[/red]")
        sys.exit(1)

    setup_logging("run_all")

    start = datetime.now()
    console.rule(f"[bold]IDX Stock Analyzer — {start.strftime('%Y-%m-%d %H:%M')}[/bold]")

    if args.ticker:
        console.print(f"[cyan]Scope: tickers = {args.ticker}[/cyan]")

    # Detect or use explicit refresh job id
    job_id: int | None = args.job_id or _detect_job(args.ticker)
    if job_id:
        from utils.supabase_client import update_refresh_job
        update_refresh_job(job_id, status="running")
        console.print(f"[cyan]Linked to refresh job #{job_id}[/cyan]")

    try:
        if args.full:
            run_full(args.ticker, args.period, args.days, job_id=job_id)
        else:
            if args.weekly:
                run_weekly(args.ticker, job_id=job_id)
            if args.quarterly:
                run_quarterly(args.ticker, args.period, job_id=job_id)
            if args.daily:
                run_daily(args.ticker, args.days, job_id=job_id)
    except KeyboardInterrupt:
        if job_id and args.ticker and len(args.ticker) == 1:
            _finalize_job(job_id, args.ticker[0], "failed", "interrupted by user")
        console.print("\n[yellow]Run interrupted by user.[/yellow]")
        sys.exit(130)
    except Exception as e:
        if job_id and args.ticker and len(args.ticker) == 1:
            _finalize_job(job_id, args.ticker[0], "failed", str(e))
        logger.exception("Unhandled error: %s", e)
        console.print(f"\n[red]Fatal error: {e}[/red]")
        sys.exit(1)
    else:
        if job_id and args.ticker and len(args.ticker) == 1:
            _finalize_job(job_id, args.ticker[0], "done")

    elapsed = (datetime.now() - start).total_seconds()
    console.rule(f"[bold green]Done in {elapsed:.1f}s[/bold green]")


if __name__ == "__main__":
    main()
