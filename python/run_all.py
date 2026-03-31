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
    python run_all.py --broker-backfill   # Stockbit broker flow + bandar signals
    python run_all.py --insider           # KSEI insider transactions

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
    from scrapers import stock_universe, daily_prices, company_profiles, money_flow
    return stock_universe, daily_prices, company_profiles, money_flow


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
    _, dp, _, mf = _import_scrapers()
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


def run_quarterly(tickers: list[str] | None, period: str, job_id: int | None = None,
                   year_from: int | None = None, year_to: int | None = None) -> None:
    """Runs: stockbit financials → company_profiles → docs → events → scores"""
    _, _, cp, _ = _import_scrapers()
    dl, ce = _import_phase2_scrapers()
    _, _, _, ff = _import_enrichment_scrapers()
    console.rule("[bold yellow]QUARTERLY: financials (Stockbit)")
    _run_tracked(ff.run, "financials_fallback", job_id,
                 tickers=tickers, source="stockbit", only_missing=False,
                 annual=(period in ("annual", "both")),
                 quarterly=(period in ("quarterly", "both")),
                 year_from=year_from, year_to=year_to)
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


def run_dividends(tickers: list[str] | None, job_id: int | None = None) -> None:
    """Runs: dividend_scraper"""
    _, ds, _, _ = _import_enrichment_scrapers()
    console.rule("[bold magenta]ENRICH: dividend_scraper")
    _run_tracked(ds.run, "dividend_scraper", job_id, tickers=tickers)


def run_financials_fallback(
    tickers: list[str] | None,
    source: str,
    only_missing: bool,
    dry_run: bool = False,
    year_from: int | None = None,
    year_to: int | None = None,
) -> None:
    """Runs: financials from Stockbit (standalone)"""
    _, _, _, ff = _import_enrichment_scrapers()
    console.rule("[bold magenta]STOCKBIT: financials")
    _run_tracked(ff.run, "financials_fallback", None,
                 tickers=tickers, source=source, only_missing=only_missing, dry_run=dry_run,
                 year_from=year_from, year_to=year_to)
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


def run_broker_backfill(tickers: list[str] | None, days: int = 30,
                        offset: int = 0, limit: int | None = None,
                        job_id: int | None = None) -> None:
    """Runs: money_flow broker backfill from Stockbit"""
    from scrapers.money_flow import run_broker_backfill as _backfill
    console.rule("[bold blue]BROKER BACKFILL: broker_flow + bandar_signal")
    _run_tracked(_backfill, "broker_backfill", job_id,
                 tickers=tickers, days=days, offset=offset, limit=limit)


def run_insider(tickers: list[str] | None, max_pages: int = 5,
                offset: int = 0, limit: int | None = None) -> None:
    """Runs: money_flow insider scrape from Stockbit/KSEI"""
    from scrapers.money_flow import run_insider_scrape as _insider
    console.rule("[bold blue]INSIDER: insider_transactions (KSEI)")
    _insider(tickers=tickers, max_pages=max_pages, offset=offset, limit=limit)


def run_full(tickers: list[str] | None, period: str, days: int, job_id: int | None = None,
             year_from: int | None = None, year_to: int | None = None,
             scraper_filter: set[str] | None = None,
             backfill_days: int = 90, offset: int = 0, batch_limit: int | None = None,
             ai_provider: str = "openai", ai_model: str | None = None,
             min_composite: int = 50, dry_run: bool = False) -> None:
    """Runs everything in dependency order. Scores updated once at the end.

    If scraper_filter is set, only matching scrapers execute; others are skipped
    (their progress rows are marked 'done' with rows_added=0 when job_id is set).
    """
    def _should_run(name: str) -> bool:
        if scraper_filter is None:
            return True
        if name in scraper_filter:
            return True
        # Mark skipped scrapers as done in the progress table
        if job_id is not None:
            from utils.supabase_client import update_refresh_scraper_progress
            update_refresh_scraper_progress(job_id, name, "done", rows_added=0)
        logger.info("Skipping %s (not in scraper filter)", name)
        return False

    su, dp, cp, mf = _import_scrapers()
    dl, ce = _import_phase2_scrapers()
    _, _, _, ff = _import_enrichment_scrapers()
    if _should_run("stock_universe"):
        console.rule("[bold green]WEEKLY: stock_universe")
        _run_tracked(su.run, "stock_universe", job_id, tickers=tickers)
    if _should_run("financials_fallback"):
        console.rule("[bold yellow]QUARTERLY: financials (Stockbit)")
        _run_tracked(ff.run, "financials_fallback", job_id,
                     tickers=tickers, source="stockbit", only_missing=False,
                     annual=(period in ("annual", "both")),
                     quarterly=(period in ("quarterly", "both")),
                     year_from=year_from, year_to=year_to)
    if _should_run("company_profiles"):
        console.rule("[bold yellow]QUARTERLY: company_profiles")
        _run_tracked(cp.run, "company_profiles", job_id, tickers=tickers)
    if _should_run("document_links"):
        console.rule("[bold yellow]QUARTERLY: document_links")
        _run_tracked_optional(dl.run, "document_links", job_id, tickers=tickers)
    if _should_run("corporate_events"):
        console.rule("[bold yellow]QUARTERLY: corporate_events")
        _run_tracked_optional(ce.run, "corporate_events", job_id, tickers=tickers)
    if _should_run("daily_prices"):
        console.rule("[bold blue]DAILY: daily_prices")
        _run_tracked(dp.run, "daily_prices", job_id, tickers=tickers)
    if _should_run("money_flow"):
        console.rule("[bold blue]DAILY: money_flow")
        _run_tracked(mf.run, "money_flow", job_id, tickers=tickers, days=days)
    if _should_run("broker_backfill"):
        from scrapers.money_flow import run_broker_backfill as _backfill
        console.rule("[bold blue]FULL: broker_flow + bandar_signal (backfill)")
        _run_tracked(_backfill, "broker_backfill", job_id,
                     tickers=tickers, days=backfill_days, offset=offset, limit=batch_limit)
    _update_scores(tickers)

    # ── Phase 6: AI pipeline (context + analysis) ──
    if _should_run("ai_context"):
        _run_ai_context_pipeline(tickers, job_id=job_id, dry_run=dry_run)
    if _should_run("ai_analysis"):
        _run_ai_analysis_pipeline(
            tickers, provider=ai_provider, model=ai_model,
            min_composite=min_composite, job_id=job_id, dry_run=dry_run,
        )


# ------------------------------------------------------------------
# CLI
# ------------------------------------------------------------------

# ------------------------------------------------------------------
# Phase 6: AI pipeline functions
# ------------------------------------------------------------------

def _run_ai_context_pipeline(
    tickers: list[str] | None,
    job_id: int | None = None,
    dry_run: bool = False,
) -> None:
    """
    Phase 6 Stages 1-4: clean → normalize → score → build context bundle.
    Writes to: data_quality_flags, normalized_metrics, stock_scores, ai_context_cache.
    """
    from scripts.scoring.data_cleaner import DataCleaner
    from scripts.scoring.data_normalizer import DataNormalizer
    from scripts.scoring.scoring_engine import ScoringPipeline
    from scripts.scoring.context_builder import ContextBuilder
    from utils.supabase_client import get_client

    console.rule("[bold cyan]PHASE 6: Build AI Context[/bold cyan]")

    sb = get_client()
    cleaner = DataCleaner()
    normalizer = DataNormalizer()
    scorer = ScoringPipeline()
    builder = ContextBuilder()

    # Resolve tickers
    if tickers is None:
        resp = sb.table("stocks").select("ticker").eq("status", "Active").execute()
        tickers = [r["ticker"] for r in (resp.data or [])]
    console.print(f"[cyan]Processing {len(tickers)} tickers[/cyan]")

    from datetime import timedelta
    from utils.helpers import RunResult
    result = RunResult("ai_context_pipeline")

    for ticker in tickers:
        try:
            # Fetch data
            stock = (sb.table("stocks").select("*").eq("ticker", ticker).execute().data or [{}])[0]
            financials = (sb.table("financials").select("*")
                         .eq("ticker", ticker).eq("quarter", 0).order("year").execute().data or [])

            if not financials:
                result.skip(ticker, "no annual financials")
                continue

            # Stage 1: Clean
            clean_rows, flags, cleaning = cleaner.clean_ticker(financials, stock)

            # Stage 2: Normalize
            metrics = normalizer.normalize(clean_rows, flags, stock)

            # Stage 3: Score
            score = scorer.run(metrics, flags, clean_rows, stock)

            # Stage 4: Build context
            price = (sb.table("daily_prices").select("date, close")
                     .eq("ticker", ticker).order("date", desc=True).limit(1).execute().data or [{}])[0]

            cutoff_30d = (datetime.now() - timedelta(days=30)).strftime("%Y-%m-%d")
            broker_flow = (sb.table("broker_flow").select("trade_date, broker_type, net_value")
                          .eq("ticker", ticker).gte("trade_date", cutoff_30d).execute().data or [])

            bandar = (sb.table("bandar_signal").select("trade_date, broker_accdist, top5_accdist")
                     .eq("ticker", ticker).order("trade_date", desc=True).limit(1).execute().data or [None])[0]

            cutoff_90d = (datetime.now() - timedelta(days=90)).strftime("%Y-%m-%d")
            insiders = (sb.table("insider_transactions").select("action, ownership_change_pct")
                       .eq("ticker", ticker).gte("transaction_date", cutoff_90d).execute().data or [])

            shareholders = (sb.table("shareholders_major").select("holder_name, holder_type, percentage")
                           .eq("ticker", ticker).order("percentage", desc=True).limit(5).execute().data or [])

            # Domain notes (optional)
            notes_row = (sb.table("stock_notes").select("domain_notes")
                        .eq("ticker", ticker).execute().data or [{}])[0]
            domain_notes = notes_row.get("domain_notes")

            # Sector template (optional)
            subsector = stock.get("subsector")
            template_row = (sb.table("sector_templates").select("*")
                           .eq("subsector", subsector).execute().data or [{}])[0] if subsector else {}

            bundle = builder.build(
                ticker=ticker, stock=stock, metrics=metrics, score=score,
                flags=flags, clean_rows=clean_rows, latest_price=price,
                broker_flow_30d=broker_flow, bandar_latest=bandar,
                insider_90d=insiders, shareholders=shareholders,
                domain_notes=domain_notes,
                sector_template=template_row if template_row.get("subsector") else None,
            )

            if not dry_run:
                import json
                # Write data_quality_flags
                flag_rows = []
                for yr, f in flags.items():
                    flag_rows.append({
                        "ticker": ticker, "year": yr,
                        "is_covid_year": f.is_covid_year, "is_ipo_year": f.is_ipo_year,
                        "has_anomaly": f.has_anomaly, "has_one_time_items": f.has_one_time_items,
                        "scale_warning": f.scale_warning, "source_conflict": f.source_conflict,
                        "usability_flag": f.usability_flag,
                        "anomaly_metrics": json.dumps(f.anomaly_metrics) if f.anomaly_metrics else None,
                        "cleaner_notes": json.dumps(f.notes) if f.notes else None,
                    })
                if flag_rows:
                    sb.table("data_quality_flags").upsert(flag_rows, on_conflict="ticker,year").execute()

                # Write normalized_metrics
                metric_rows = []
                for m in metrics:
                    metric_rows.append({
                        "ticker": ticker, "metric_name": m.metric_name, "unit": m.unit,
                        "latest_value": m.latest_value, "latest_year": m.latest_year,
                        "cagr_full": m.cagr_full, "cagr_3yr": m.cagr_3yr,
                        "trend_direction": m.trend_direction, "trend_r2": m.trend_r2,
                        "trend_slope_pct": m.trend_slope_pct, "volatility": m.volatility,
                        "z_score_vs_sector": m.z_score_vs_sector,
                        "percentile_vs_sector": m.percentile_vs_sector,
                        "peer_group_level": m.peer_group_level, "peer_count": m.peer_count,
                        "data_years_count": m.data_years_count,
                        "anomaly_years": json.dumps(m.anomaly_years) if m.anomaly_years else None,
                        "missing_years": json.dumps(m.missing_years) if m.missing_years else None,
                        "years_json": json.dumps(m.years), "values_json": json.dumps(m.values),
                    })
                if metric_rows:
                    sb.table("normalized_metrics").upsert(metric_rows, on_conflict="ticker,metric_name").execute()

                # Write stock_scores
                sb.table("stock_scores").upsert({
                    "ticker": ticker,
                    "reliability_total": score.reliability_total,
                    "reliability_grade": score.reliability_grade,
                    "reliability_completeness": score.reliability_completeness,
                    "reliability_consistency": score.reliability_consistency,
                    "reliability_freshness": score.reliability_freshness,
                    "reliability_source": score.reliability_source,
                    "reliability_penalties": score.reliability_penalties,
                    "confidence_total": score.confidence_total,
                    "confidence_grade": score.confidence_grade,
                    "confidence_signal": score.confidence_signal,
                    "confidence_trend": score.confidence_trend,
                    "confidence_depth": score.confidence_depth,
                    "confidence_peers": score.confidence_peers,
                    "confidence_valuation": score.confidence_valuation,
                    "composite_score": score.composite_score,
                    "ready_for_ai": score.ready_for_ai,
                    "bullish_signals": json.dumps(score.bullish_signals),
                    "bearish_signals": json.dumps(score.bearish_signals),
                    "data_gap_flags": json.dumps(score.data_gap_flags),
                    "missing_metrics": json.dumps(score.missing_metrics),
                    "data_years_available": score.data_years_available,
                    "primary_source": score.primary_source,
                    "sector_peers_count": score.sector_peers_count,
                }, on_conflict="ticker").execute()

                # Write ai_context_cache
                sb.table("ai_context_cache").upsert({
                    "ticker": ticker,
                    "context_json": bundle.context,
                    "context_version": bundle.context_version,
                    "token_estimate": bundle.token_estimate,
                    "ready_for_ai": bundle.ready_for_ai,
                    "data_as_of": price.get("date"),
                }, on_conflict="ticker").execute()

            console.print(
                f"  [green]✓[/green] {ticker}: reliability={score.reliability_grade} "
                f"confidence={score.confidence_grade} composite={score.composite_score} "
                f"ready={'✓' if score.ready_for_ai else '✗'} tokens={bundle.token_estimate}"
            )
            result.ok(ticker)

        except Exception as e:
            logger.warning("AI context failed for %s: %s", ticker, e, exc_info=True)
            result.fail(ticker, str(e))

    result.print_summary()


def _run_ai_analysis_pipeline(
    tickers: list[str] | None,
    provider: str = "openai",
    model: str | None = None,
    min_composite: int = 50,
    job_id: int | None = None,
    dry_run: bool = False,
) -> None:
    """
    Phase 6 Stage 5: Call LLM to generate investment thesis.
    Reads from ai_context_cache, writes to ai_analysis.
    """
    from scripts.scoring.ai_analyst import AIAnalyst
    from utils.supabase_client import get_client

    console.rule("[bold cyan]PHASE 6: AI Analysis[/bold cyan]")

    sb = get_client()
    analyst = AIAnalyst(provider=provider, model=model)
    console.print(f"[cyan]Provider: {analyst.provider_name} / Model: {analyst.model_name}[/cyan]")

    # Get eligible tickers
    query = sb.table("ai_context_cache").select("ticker, context_json, ready_for_ai")
    if tickers:
        query = query.in_("ticker", tickers)
    query = query.eq("ready_for_ai", True)
    rows = query.execute().data or []

    if not rows:
        console.print("[yellow]No tickers eligible for AI analysis (ready_for_ai=FALSE or no context cache).[/yellow]")
        return

    # Filter by min_composite if scores available
    if min_composite > 0:
        score_resp = sb.table("stock_scores").select("ticker, composite_score").execute()
        score_map = {r["ticker"]: r.get("composite_score", 0) for r in (score_resp.data or [])}
        rows = [r for r in rows if score_map.get(r["ticker"], 0) >= min_composite]

    console.print(f"[cyan]Analyzing {len(rows)} tickers (ready_for_ai=TRUE, composite>={min_composite})[/cyan]")

    from utils.helpers import RunResult
    result = RunResult("ai_analysis")

    for row in rows:
        ticker = row["ticker"]
        context = row["context_json"]
        if isinstance(context, str):
            import json
            context = json.loads(context)

        try:
            # Get score metadata for validation
            score_row = (sb.table("stock_scores").select("reliability_grade, data_gap_flags")
                        .eq("ticker", ticker).execute().data or [{}])[0]

            current_price = context.get("valuation", {}).get("current_price")
            data_gaps = score_row.get("data_gap_flags")
            if isinstance(data_gaps, str):
                import json
                data_gaps = json.loads(data_gaps)

            # Get sector template and domain notes
            subsector = context.get("sub_sector")
            template = (sb.table("sector_templates").select("*")
                       .eq("subsector", subsector).execute().data or [{}])[0] if subsector else {}
            notes_row = (sb.table("stock_notes").select("domain_notes")
                        .eq("ticker", ticker).execute().data or [{}])[0]

            if dry_run:
                console.print(f"  [dim]DRY RUN: {ticker} — would call {analyst.model_name}[/dim]")
                result.ok(ticker)
                continue

            analysis = analyst.analyze(
                context_bundle=context,
                current_price=current_price,
                data_gap_flags=data_gaps,
                reliability_grade=score_row.get("reliability_grade"),
                sector_template=template if template.get("subsector") else None,
                domain_notes=notes_row.get("domain_notes"),
            )

            if analysis.success:
                import json
                sb.table("ai_analysis").upsert({
                    "ticker": ticker,
                    "lynch_category": analysis.lynch_category,
                    "buffett_moat": analysis.buffett_moat,
                    "analyst_verdict": analysis.analyst_verdict,
                    "confidence_level": analysis.confidence_level,
                    "bull_case": analysis.bull_case,
                    "bear_case": analysis.bear_case,
                    "neutral_case": analysis.neutral_case,
                    "business_narrative": analysis.bull_case.get("scenario", "") if analysis.bull_case else "",
                    "model_used": analyst.model_name,
                    "prompt_tokens": analysis.prompt_tokens,
                    "output_tokens": analysis.output_tokens,
                }, on_conflict="ticker").execute()

                console.print(
                    f"  [green]✓[/green] {ticker}: {analysis.lynch_category} / "
                    f"{analysis.analyst_verdict} / confidence={analysis.confidence_level} "
                    f"(${analysis.cost_usd_estimate:.4f})"
                )
                result.ok(ticker)
            else:
                console.print(f"  [red]✗[/red] {ticker}: {analysis.error}")
                result.fail(ticker, analysis.error or "unknown")

        except Exception as e:
            logger.warning("AI analysis failed for %s: %s", ticker, e, exc_info=True)
            result.fail(ticker, str(e))

    result.print_summary()


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
  python run_all.py --fallback-financials              # Stockbit backfill (only missing)
  python run_all.py --fallback-financials --ticker BBRI --dry-run

  # Broker flow & insider transactions (Stockbit):
  python run_all.py --broker-backfill                  # last 30 days, top stocks by mcap
  python run_all.py --broker-backfill --backfill-days 60 --ticker BBRI
  python run_all.py --broker-backfill --offset 100 --batch-limit 50
  python run_all.py --insider                          # KSEI insider transactions
  python run_all.py --insider --ticker BBRI --insider-pages 10

  # Full pipeline with AI analysis:
  python run_all.py --full --ticker BBRI                       # scrape + AI (openai default)
  python run_all.py --full --ticker BBRI --ai-provider anthropic
  python run_all.py --full --ticker BBRI --dry-run             # scrape only, skip AI writes
        """,
    )

    # Mode flags (at least one required)
    mode = parser.add_argument_group("Run modes (pick one or more)")
    mode.add_argument("--daily", action="store_true", help="Run: daily_prices + money_flow")
    mode.add_argument("--weekly", action="store_true", help="Run: stock_universe")
    mode.add_argument("--quarterly", action="store_true", help="Run: financials + company_profiles")
    mode.add_argument("--full", action="store_true", help="Run everything (weekly + quarterly + daily + broker backfill + AI analysis)")
    mode.add_argument("--enrich-ratios", action="store_true", help="Fill NULL ratio columns from stored raw data (no API calls)")
    mode.add_argument("--dividends", action="store_true", help="Fetch full dividend history from yfinance")
    mode.add_argument("--fill-gaps", action="store_true", help="Detect and fill data gaps for low-completeness stocks")
    mode.add_argument("--fallback-financials", action="store_true", help="Run Stockbit financials standalone (primary source, fills all tickers)")
    mode.add_argument("--broker-backfill", action="store_true", help="Backfill broker flow + bandar signals from Stockbit")
    mode.add_argument("--insider", action="store_true", help="Fetch KSEI insider transactions from Stockbit")

    # Phase 6: AI pipeline modes
    mode.add_argument("--build-ai-context", action="store_true",
                      help="Phase 6: clean → normalize → score → build AI context bundle")
    mode.add_argument("--run-ai-analysis", action="store_true",
                      help="Phase 6: call LLM to generate investment thesis (requires ai_context_cache)")
    mode.add_argument("--ai-full", action="store_true",
                      help="Phase 6: full pipeline = build-ai-context + run-ai-analysis")

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
        "--fallback-all",
        action="store_true",
        help="--fallback-financials: process all tickers even if data exists (default: only missing)",
    )
    # Broker backfill / insider options
    parser.add_argument(
        "--backfill-days",
        type=int,
        default=90,
        metavar="N",
        help="--broker-backfill / --full: number of days to backfill (default: 90)",
    )
    parser.add_argument(
        "--insider-pages",
        type=int,
        default=5,
        metavar="N",
        help="--insider: max pages per ticker (default: 5)",
    )
    parser.add_argument(
        "--offset",
        type=int,
        default=0,
        metavar="N",
        help="--broker-backfill / --insider: skip first N tickers (for batching)",
    )
    parser.add_argument(
        "--batch-limit",
        type=int,
        default=None,
        metavar="N",
        help="--broker-backfill / --insider: max tickers to process (for batching)",
    )
    # Scraper filter (for selective refresh from UI)
    parser.add_argument(
        "--scrapers",
        type=str,
        default="",
        help="Comma-separated scraper names to run. When set, only matching scrapers execute "
             "in --full mode. Others are skipped. Empty = run all (default).",
    )
    # Phase 6: AI pipeline options
    parser.add_argument(
        "--ai-provider",
        type=str,
        default="openai",
        choices=["openai", "anthropic"],
        help="LLM provider for --run-ai-analysis (default: openai)",
    )
    parser.add_argument(
        "--ai-model",
        type=str,
        default=None,
        metavar="MODEL",
        help="LLM model name (default: gpt-5.2 for openai, claude-sonnet-4 for anthropic)",
    )
    parser.add_argument(
        "--min-composite",
        type=int,
        default=50,
        metavar="N",
        help="--ai-full batch: only analyze stocks with composite_score >= N (default: 50)",
    )

    # Year range (applies to --quarterly, --full, --fallback-financials)
    parser.add_argument(
        "--year-from",
        type=int,
        default=None,
        metavar="YEAR",
        help="Earliest fiscal year to fetch from Stockbit (default: current_year - 10)",
    )
    parser.add_argument(
        "--year-to",
        type=int,
        default=None,
        metavar="YEAR",
        help="Latest fiscal year to fetch from Stockbit (default: current_year)",
    )

    args = parser.parse_args()

    all_modes = [args.daily, args.weekly, args.quarterly, args.full,
                 args.enrich_ratios, args.dividends, args.fill_gaps, args.fallback_financials,
                 args.broker_backfill, args.insider,
                 args.build_ai_context, args.run_ai_analysis, args.ai_full]
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

    # Parse --scrapers filter (comma-separated → set, empty string → None = run all)
    scraper_filter: set[str] | None = None
    if args.scrapers:
        scraper_filter = {s.strip() for s in args.scrapers.split(",") if s.strip()}
        console.print(f"[cyan]Scraper filter: {sorted(scraper_filter)}[/cyan]")

    # Detect or use explicit refresh job id (only meaningful for single-ticker runs)
    job_id: int | None = args.job_id or _detect_job(tickers)
    if job_id:
        from utils.supabase_client import update_refresh_job
        update_refresh_job(job_id, status="running")
        console.print(f"[cyan]Linked to refresh job #{job_id}[/cyan]")

    try:
        # ── Core pipeline modes (mutually exclusive: --full vs individual) ──
        if args.full:
            run_full(tickers, args.period, args.days, job_id=job_id,
                     year_from=args.year_from, year_to=args.year_to,
                     scraper_filter=scraper_filter,
                     backfill_days=args.backfill_days,
                     offset=args.offset, batch_limit=args.batch_limit,
                     ai_provider=args.ai_provider, ai_model=args.ai_model,
                     min_composite=args.min_composite, dry_run=args.dry_run)
        else:
            if args.weekly:
                run_weekly(tickers, job_id=job_id)
            if args.quarterly:
                run_quarterly(tickers, args.period, job_id=job_id,
                              year_from=args.year_from, year_to=args.year_to)
            if args.daily:
                run_daily(tickers, args.days, job_id=job_id)
            if args.fallback_financials:
                run_financials_fallback(
                    tickers=tickers,
                    source="stockbit",
                    only_missing=not args.fallback_all,
                    dry_run=args.dry_run,
                    year_from=args.year_from,
                    year_to=args.year_to,
                )

        # ── Enrichment modes (can combine with --full or run standalone) ──
        # When --scrapers filter is active, only run enrichment if the scraper is in the filter
        def _filter_ok(name: str) -> bool:
            return scraper_filter is None or name in scraper_filter

        if args.enrich_ratios and _filter_ok("ratio_enricher"):
            run_enrich_ratios(tickers, dry_run=args.dry_run)
        if args.dividends and _filter_ok("dividend_scraper"):
            run_dividends(tickers, job_id=job_id)
        if args.fill_gaps:
            run_fill_gaps(
                tickers=tickers,
                min_score=args.min_score,
                limit=args.gap_limit,
                categories=args.gap_category,
                dry_run=args.dry_run,
            )
        if args.broker_backfill and _filter_ok("broker_backfill"):
            run_broker_backfill(
                tickers=tickers,
                days=args.backfill_days,
                offset=args.offset,
                limit=args.batch_limit,
                job_id=job_id,
            )
        if args.insider:
            run_insider(
                tickers=tickers,
                max_pages=args.insider_pages,
                offset=args.offset,
                limit=args.batch_limit,
            )

        # ── Phase 6: AI pipeline modes ────────────────────────────────
        if args.build_ai_context or args.ai_full:
            _run_ai_context_pipeline(tickers, job_id=job_id, dry_run=args.dry_run)
        if args.run_ai_analysis or args.ai_full:
            _run_ai_analysis_pipeline(
                tickers,
                provider=args.ai_provider,
                model=args.ai_model,
                min_composite=args.min_composite,
                job_id=job_id,
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
