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
from datetime import datetime

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


def run_daily(tickers: list[str] | None, days: int) -> None:
    """Runs: daily_prices → money_flow → scores"""
    _, dp, _, _, mf = _import_scrapers()
    console.rule("[bold blue]DAILY: daily_prices")
    dp.run(tickers=tickers)
    console.rule("[bold blue]DAILY: money_flow")
    mf.run(tickers=tickers, days=days)
    _update_scores(tickers)


def run_weekly(tickers: list[str] | None) -> None:
    """Runs: stock_universe → scores"""
    su, *_ = _import_scrapers()
    console.rule("[bold green]WEEKLY: stock_universe")
    su.run(tickers=tickers)
    _update_scores(tickers)


def run_quarterly(tickers: list[str] | None, period: str) -> None:
    """Runs: financials → company_profiles → document_links → corporate_events → scores"""
    _, _, fin, cp, _ = _import_scrapers()
    dl, ce = _import_phase2_scrapers()
    console.rule("[bold yellow]QUARTERLY: financials")
    fin.run(tickers=tickers, period=period)
    console.rule("[bold yellow]QUARTERLY: company_profiles")
    cp.run(tickers=tickers)
    console.rule("[bold yellow]QUARTERLY: document_links")
    dl.run(tickers=tickers)
    console.rule("[bold yellow]QUARTERLY: corporate_events")
    ce.run(tickers=tickers)
    _update_scores(tickers)


def run_full(tickers: list[str] | None, period: str, days: int) -> None:
    """Runs everything in dependency order. Scores updated once at the end."""
    su, dp, fin, cp, mf = _import_scrapers()
    dl, ce = _import_phase2_scrapers()
    console.rule("[bold green]WEEKLY: stock_universe")
    su.run(tickers=tickers)
    console.rule("[bold yellow]QUARTERLY: financials")
    fin.run(tickers=tickers, period=period)
    console.rule("[bold yellow]QUARTERLY: company_profiles")
    cp.run(tickers=tickers)
    console.rule("[bold yellow]QUARTERLY: document_links")
    dl.run(tickers=tickers)
    console.rule("[bold yellow]QUARTERLY: corporate_events")
    ce.run(tickers=tickers)
    console.rule("[bold blue]DAILY: daily_prices")
    dp.run(tickers=tickers)
    console.rule("[bold blue]DAILY: money_flow")
    mf.run(tickers=tickers, days=days)
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

    try:
        if args.full:
            run_full(args.ticker, args.period, args.days)
        else:
            if args.weekly:
                run_weekly(args.ticker)
            if args.quarterly:
                run_quarterly(args.ticker, args.period)
            if args.daily:
                run_daily(args.ticker, args.days)
    except KeyboardInterrupt:
        console.print("\n[yellow]Run interrupted by user.[/yellow]")
        sys.exit(130)
    except Exception as e:
        logger.exception("Unhandled error: %s", e)
        console.print(f"\n[red]Fatal error: {e}[/red]")
        sys.exit(1)

    elapsed = (datetime.now() - start).total_seconds()
    console.rule(f"[bold green]Done in {elapsed:.1f}s[/bold green]")


if __name__ == "__main__":
    main()
