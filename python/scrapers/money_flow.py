from __future__ import annotations

"""
money_flow.py — Broker flow + bandar signal + insider transactions scraper

Updates tables:
  - broker_flow:          per-broker buy/sell split (Stockbit marketdetectors)
  - bandar_signal:        accumulation/distribution signals (Stockbit marketdetectors)
  - insider_transactions: KSEI major holder movements (Stockbit insider API)

Run:
    cd python && python -m scrapers.money_flow
    cd python && python -m scrapers.money_flow --ticker BBRI
    cd python && python -m scrapers.money_flow --date 2026-03-14
    cd python && python -m scrapers.money_flow --days 5
    cd python && python -m scrapers.money_flow --broker-backfill 30
    cd python && python -m scrapers.money_flow --insider --ticker BBRI
    cd python && python -m scrapers.money_flow --insider --days 90
"""
import argparse
import logging
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from config import BROKER_SUMMARY_TOP_N
from utils.helpers import RunResult, setup_logging, safe_int, safe_float, safe_str
from utils.supabase_client import bulk_upsert, fetch_all, start_run, finish_run

logger = logging.getLogger(__name__)


# ------------------------------------------------------------------
# Date helpers
# ------------------------------------------------------------------

def _last_n_trading_dates(n: int) -> list[date]:
    """
    Return the last N calendar dates that could be trading days.
    Simple approximation: skip weekends. Doesn't account for IDX holidays.
    """
    dates: list[date] = []
    d = date.today() - timedelta(days=1)  # start from yesterday
    while len(dates) < n:
        if d.weekday() < 5:  # Mon-Fri
            dates.append(d)
        d -= timedelta(days=1)
    return dates


# ------------------------------------------------------------------
# Helpers: Stockbit value parsing
# ------------------------------------------------------------------

def _parse_sci_int(value) -> int | None:
    """Parse scientific notation strings like '6.777811e+08' to int.
    Also handles negative strings like '-53268'. Returns abs value."""
    if value is None:
        return None
    try:
        return abs(int(float(str(value))))
    except (ValueError, TypeError):
        return None


# ------------------------------------------------------------------
# Parser: Stockbit marketdetectors (broker flow + bandar signal)
# ------------------------------------------------------------------

def _fetch_broker_marketdetector(
    ticker: str,
    trade_date: str,
    client,
) -> tuple[list[dict], dict | None]:
    """
    Fetch broker flow + bandar signal from Stockbit marketdetectors endpoint.

    Single API call returns both per-broker buy/sell arrays and
    pre-computed bandar accumulation/distribution signals.

    API structure (verified March 2026):
      - broker_summary.brokers_buy[]: {netbs_broker_code, blot, bval, netbs_buy_avg_price, type, freq}
      - broker_summary.brokers_sell[]: {netbs_broker_code, slot, sval, netbs_sell_avg_price, type, freq}
      - Buy and sell arrays are disjoint — same broker does NOT appear in both.
      - bandar_detector: {broker_accdist, top1.accdist, top3.accdist, ..., value, volume, total_buyer, total_seller}

    Returns:
        (broker_flow_rows, bandar_signal_row)
    """
    data = client.get_market_detector(ticker, date=trade_date)
    if not data:
        return [], None

    now_iso = datetime.now(timezone.utc).isoformat()

    # --- Parse broker summary ---
    broker_summary = data.get("broker_summary") or {}
    brokers_buy = broker_summary.get("brokers_buy") or []
    brokers_sell = broker_summary.get("brokers_sell") or []

    # Buy and sell arrays are disjoint — merge by netbs_broker_code.
    brokers: dict[str, dict] = {}

    for b in brokers_buy:
        code = b.get("netbs_broker_code")
        if not code:
            continue
        blot = _parse_sci_int(b.get("blot")) or 0
        bval = _parse_sci_int(b.get("bval")) or 0
        brokers[code] = {
            "ticker": ticker,
            "trade_date": trade_date,
            "broker_code": code,
            "broker_type": b.get("type"),
            "buy_lot": blot,
            "sell_lot": 0,
            "buy_value": bval,
            "sell_value": 0,
            "buy_avg_price": safe_float(b.get("netbs_buy_avg_price")),
            "sell_avg_price": None,
            "frequency": safe_int(b.get("freq")),
            "created_at": now_iso,
        }

    for b in brokers_sell:
        code = b.get("netbs_broker_code")
        if not code:
            continue
        slot = _parse_sci_int(b.get("slot")) or 0
        sval = _parse_sci_int(b.get("sval")) or 0
        if code in brokers:
            # Rare: broker in both buy and sell — merge sell into existing
            brokers[code]["sell_lot"] = slot
            brokers[code]["sell_value"] = sval
            brokers[code]["sell_avg_price"] = safe_float(b.get("netbs_sell_avg_price"))
        else:
            brokers[code] = {
                "ticker": ticker,
                "trade_date": trade_date,
                "broker_code": code,
                "broker_type": b.get("type"),
                "buy_lot": 0,
                "sell_lot": slot,
                "buy_value": 0,
                "sell_value": sval,
                "buy_avg_price": None,
                "sell_avg_price": safe_float(b.get("netbs_sell_avg_price")),
                "frequency": safe_int(b.get("freq")),
                "created_at": now_iso,
            }

    broker_rows = list(brokers.values())

    # --- Parse bandar detector ---
    bandar = data.get("bandar_detector")
    bandar_row = None
    if bandar and bandar.get("broker_accdist"):
        bandar_row = {
            "ticker": ticker,
            "trade_date": trade_date,
            "broker_accdist": safe_str(bandar.get("broker_accdist")),
            "top1_accdist": safe_str((bandar.get("top1") or {}).get("accdist")),
            "top3_accdist": safe_str((bandar.get("top3") or {}).get("accdist")),
            "top5_accdist": safe_str((bandar.get("top5") or {}).get("accdist")),
            "top10_accdist": safe_str((bandar.get("top10") or {}).get("accdist")),
            "total_buyer": safe_int(bandar.get("total_buyer")),
            "total_seller": safe_int(bandar.get("total_seller")),
            "total_value": _parse_sci_int(bandar.get("value")),
            "total_volume": _parse_sci_int(bandar.get("volume")),
            "created_at": now_iso,
        }

    return broker_rows, bandar_row


def _parse_date(value) -> str | None:
    if not value:
        return None
    if "/Date(" in str(value):
        try:
            ms = int(str(value).replace("/Date(", "").replace(")/", "").split("+")[0])
            return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
        except (ValueError, IndexError):
            return None
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%Y%m%d", "%d-%m-%Y", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(str(value).strip()[:10], fmt[:10]).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None


# ------------------------------------------------------------------
# Main scraper
# ------------------------------------------------------------------

def run(
    tickers: list[str] | None = None,
    dates: list[date] | None = None,
    days: int = 2,
) -> RunResult:
    """
    Fetch broker_flow + bandar_signal from Stockbit marketdetectors.

    Args:
        tickers: If None, uses all active stocks.
        dates:   If None, defaults to last `days` trading days.
        days:    Number of recent trading days to fetch (default: 2).
    """
    result = RunResult("money_flow")
    run_id = start_run(
        "money_flow",
        metadata={"mode": "single" if tickers else "all", "days": days},
    )

    # --- Determine ticker list ---
    if tickers:
        ticker_list = [t.upper() for t in tickers]
    else:
        all_stocks = fetch_all("stocks", "ticker", filters={"status": "Active"})
        ticker_list = [r["ticker"] for r in all_stocks]
        logger.info("Targeting all %d active stocks", len(ticker_list))

    # --- Determine date list ---
    if dates:
        date_list = [d.isoformat() if isinstance(d, date) else d for d in dates]
    else:
        date_list = [d.isoformat() for d in _last_n_trading_dates(days)]
    logger.info("Fetching data for dates: %s", date_list)

    # --- Init Stockbit client ---
    try:
        from utils.stockbit_client import StockbitClient
        sb_client = StockbitClient()
    except Exception as e:
        logger.error("Stockbit client init failed: %s", e)
        finish_run(run_id, "failed", error_message=str(e))
        return result

    if not sb_client.is_authenticated:
        logger.error("Stockbit token required for money_flow")
        finish_run(run_id, "failed", error_message="no token")
        return result

    all_broker_rows: list[dict] = []
    all_bandar_rows: list[dict] = []

    for i, ticker in enumerate(ticker_list, 1):
        ticker_broker_count = 0
        try:
            for trade_date in date_list:
                broker_rows, bandar_row = _fetch_broker_marketdetector(
                    ticker, trade_date, sb_client,
                )
                if broker_rows:
                    all_broker_rows.extend(broker_rows)
                    ticker_broker_count += len(broker_rows)
                if bandar_row:
                    all_bandar_rows.append(bandar_row)

            logger.info("[%d/%d] %s: %d broker rows, %d bandar signals",
                        i, len(ticker_list), ticker, ticker_broker_count,
                        sum(1 for r in all_bandar_rows if r["ticker"] == ticker))
            result.ok(ticker)

        except Exception as e:
            logger.warning("Failed %s: %s", ticker, e)
            result.fail(ticker, str(e))

        # Batch upsert to avoid huge memory usage
        if len(all_broker_rows) > 5000:
            logger.info("Batch upserting %d broker_flow rows...", len(all_broker_rows))
            bulk_upsert("broker_flow", all_broker_rows, on_conflict="ticker,trade_date,broker_code")
            all_broker_rows.clear()
        if len(all_bandar_rows) > 500:
            logger.info("Batch upserting %d bandar_signal rows...", len(all_bandar_rows))
            bulk_upsert("bandar_signal", all_bandar_rows, on_conflict="ticker,trade_date")
            all_bandar_rows.clear()

    # Final upserts
    if all_broker_rows:
        logger.info("Upserting %d broker_flow rows...", len(all_broker_rows))
        bulk_upsert("broker_flow", all_broker_rows, on_conflict="ticker,trade_date,broker_code")
    if all_bandar_rows:
        logger.info("Upserting %d bandar_signal rows...", len(all_bandar_rows))
        bulk_upsert("bandar_signal", all_bandar_rows, on_conflict="ticker,trade_date")

    result.print_summary()
    finish_run(run_id, **result.to_db_kwargs())
    return result


# ------------------------------------------------------------------
# Broker backfill (Stockbit marketdetectors — buy/sell split + bandar)
# ------------------------------------------------------------------

def run_broker_backfill(
    tickers: list[str] | None = None,
    days: int = 30,
    offset: int = 0,
    limit: int | None = None,
) -> RunResult:
    """
    Backfill broker_flow + bandar_signal from Stockbit marketdetectors.

    Single API call per ticker/date returns both per-broker buy/sell data
    and pre-computed bandar accumulation/distribution signals.

    Args:
        tickers: Tickers to process. None = top by market cap.
        days:    Number of trading days to backfill (default: 30).
        offset:  Skip first N tickers (for batching).
        limit:   Max tickers to process (default: BROKER_SUMMARY_TOP_N).
    """
    result = RunResult("broker_backfill")
    run_id = start_run("broker_backfill", metadata={"days": days, "offset": offset, "limit": limit})

    if tickers:
        ticker_list = [t.upper() for t in tickers]
    else:
        all_stocks = fetch_all("stocks", "ticker, market_cap", filters={"status": "Active"})
        all_stocks.sort(key=lambda r: r.get("market_cap") or 0, reverse=True)
        cap = limit if limit is not None else BROKER_SUMMARY_TOP_N
        ticker_list = [r["ticker"] for r in all_stocks[offset:offset + cap]]

    date_list = [d.isoformat() for d in _last_n_trading_dates(days)]
    logger.info("Broker backfill: %d tickers × %d dates (%s to %s)",
                len(ticker_list), len(date_list), date_list[-1], date_list[0])

    try:
        from utils.stockbit_client import StockbitClient
        sb_client = StockbitClient()
    except Exception as e:
        logger.error("Stockbit client init failed: %s", e)
        finish_run(run_id, "failed", error_message=str(e))
        return result

    if not sb_client.is_authenticated:
        logger.error("Stockbit token required for broker backfill")
        finish_run(run_id, "failed", error_message="no token")
        return result

    all_broker_rows: list[dict] = []
    all_bandar_rows: list[dict] = []

    for i, ticker in enumerate(ticker_list, 1):
        ticker_broker_count = 0
        try:
            for trade_date in date_list:
                broker_rows, bandar_row = _fetch_broker_marketdetector(
                    ticker, trade_date, sb_client,
                )
                if broker_rows:
                    all_broker_rows.extend(broker_rows)
                    ticker_broker_count += len(broker_rows)
                if bandar_row:
                    all_bandar_rows.append(bandar_row)

            logger.info("[%d/%d] %s: %d broker rows, %d bandar signals",
                        i, len(ticker_list), ticker, ticker_broker_count,
                        sum(1 for r in all_bandar_rows if r["ticker"] == ticker))
            result.ok(ticker)

        except Exception as e:
            logger.warning("Failed %s: %s", ticker, e)
            result.fail(ticker, str(e))

        # Batch upsert to avoid huge memory usage
        if len(all_broker_rows) > 5000:
            logger.info("Batch upserting %d broker_flow rows...", len(all_broker_rows))
            bulk_upsert("broker_flow", all_broker_rows, on_conflict="ticker,trade_date,broker_code")
            all_broker_rows.clear()
        if len(all_bandar_rows) > 500:
            logger.info("Batch upserting %d bandar_signal rows...", len(all_bandar_rows))
            bulk_upsert("bandar_signal", all_bandar_rows, on_conflict="ticker,trade_date")
            all_bandar_rows.clear()

    # Final upserts
    if all_broker_rows:
        logger.info("Upserting %d broker_flow rows...", len(all_broker_rows))
        bulk_upsert("broker_flow", all_broker_rows, on_conflict="ticker,trade_date,broker_code")
    if all_bandar_rows:
        logger.info("Upserting %d bandar_signal rows...", len(all_bandar_rows))
        bulk_upsert("bandar_signal", all_bandar_rows, on_conflict="ticker,trade_date")

    result.print_summary()
    finish_run(run_id, **result.to_db_kwargs())
    return result


# ------------------------------------------------------------------
# Insider transactions (Stockbit — KSEI major holder movements)
# ------------------------------------------------------------------

def _clamp_pct(value: float | None) -> float | None:
    """Clamp percentage to fit DECIMAL(8,4) — max 9999.9999."""
    if value is None:
        return None
    return max(-9999.9999, min(9999.9999, round(value, 4)))


def _parse_formatted_int(value: str | None) -> int | None:
    """Parse Stockbit formatted numbers like '+98,000' or '806,109,768' to int."""
    if not value:
        return None
    s = str(value).replace(",", "").replace("+", "").strip()
    try:
        return abs(int(s))
    except (ValueError, TypeError):
        return None


def _parse_insider_date(raw: str | None) -> str | None:
    """Parse Stockbit insider date format like '28 Jan 26' → '2026-01-28'."""
    if not raw:
        return None
    s = str(raw).strip()
    # Try Stockbit's "DD Mon YY" format first
    for fmt in ("%d %b %y", "%d %B %y", "%Y-%m-%d", "%d/%m/%Y"):
        try:
            return datetime.strptime(s, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return _parse_date(s)


def _parse_insider_record(ticker: str, record: dict) -> dict | None:
    """
    Map a single Stockbit insider/majorholder movement record to an
    insider_transactions row.

    Verified API structure (March 2026):
      name, symbol, date ("28 Jan 26"), action_type ("ACTION_TYPE_BUY"),
      previous: {value, percentage}, current: {value, percentage},
      changes: {value, percentage}, nationality ("NATIONALITY_TYPE_LOCAL"),
      price_formatted ("3,640"), broker_detail: {code, group}, badges: [...]
    """
    name = record.get("name")
    if not name:
        logger.debug("Insider record missing name, keys: %s", list(record.keys()))
        return None

    # Parse action — filter to BUY/SELL only, skip CROSS and other types
    raw_action = str(record.get("action_type") or "").upper()
    if "BUY" in raw_action:
        action = "BUY"
    elif "SELL" in raw_action:
        action = "SELL"
    else:
        # Skip ACTION_TYPE_CROSS, ACTION_TYPE_UNSPECIFIED, etc.
        return None

    # Parse share change from changes.value (formatted like "+98,000")
    changes = record.get("changes") or {}
    share_change = _parse_formatted_int(changes.get("value"))
    if not share_change:
        return None

    # Parse date
    trade_date = _parse_insider_date(record.get("date"))
    if not trade_date:
        return None

    # Parse previous/current holdings
    previous = record.get("previous") or {}
    current = record.get("current") or {}

    # Nationality: strip NATIONALITY_TYPE_ prefix
    raw_nat = str(record.get("nationality") or "")
    nationality = raw_nat.replace("NATIONALITY_TYPE_", "") if raw_nat else None

    # Broker detail
    broker_detail = record.get("broker_detail") or {}
    broker_code = broker_detail.get("code") or None
    broker_group = broker_detail.get("group") or None
    if broker_group:
        broker_group = broker_group.replace("BROKER_GROUP_", "")
    if broker_group == "UNSPECIFIED":
        broker_group = None

    return {
        "ticker": ticker,
        "insider_id": safe_str(record.get("id")),
        "insider_name": name,
        "transaction_date": trade_date,
        "action": action,
        "share_change": share_change,
        "shares_before": _parse_formatted_int(previous.get("value")),
        "shares_after": _parse_formatted_int(current.get("value")),
        "ownership_before_pct": _clamp_pct(safe_float(previous.get("percentage"))),
        "ownership_after_pct": _clamp_pct(safe_float(current.get("percentage"))),
        "ownership_change_pct": _clamp_pct(safe_float(changes.get("percentage"))),
        "nationality": nationality if nationality and nationality != "UNSPECIFIED" else None,
        "broker_code": broker_code if broker_code else None,
        "broker_group": broker_group,
        "data_source": "KSEI",
        "price": _parse_formatted_int(record.get("price_formatted")),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }


def run_insider_scrape(
    tickers: list[str] | None = None,
    max_pages: int = 5,
    offset: int = 0,
    limit: int | None = None,
) -> RunResult:
    """
    Fetch KSEI major holder movements from Stockbit insider API.

    Args:
        tickers:   Tickers to process. None = top by market cap.
        max_pages: Max pages to fetch per ticker (20 records/page).
        offset:    Skip first N tickers (for batching).
        limit:     Max tickers to process (default: BROKER_SUMMARY_TOP_N).
    """
    result = RunResult("insider_scrape")
    run_id = start_run("insider_scrape", metadata={"max_pages": max_pages, "offset": offset, "limit": limit})

    if tickers:
        ticker_list = [t.upper() for t in tickers]
    else:
        all_stocks = fetch_all("stocks", "ticker, market_cap", filters={"status": "Active"})
        all_stocks.sort(key=lambda r: r.get("market_cap") or 0, reverse=True)
        cap = limit if limit is not None else BROKER_SUMMARY_TOP_N
        ticker_list = [r["ticker"] for r in all_stocks[offset:offset + cap]]

    logger.info("Insider scrape: %d tickers, max %d pages each", len(ticker_list), max_pages)

    try:
        from utils.stockbit_client import StockbitClient
        sb_client = StockbitClient()
    except Exception as e:
        logger.error("Stockbit client init failed: %s", e)
        finish_run(run_id, "failed", error_message=str(e))
        return result

    if not sb_client.is_authenticated:
        logger.error("Stockbit token required for insider scrape")
        finish_run(run_id, "failed", error_message="no token")
        return result

    all_rows: list[dict] = []
    seen_keys: set[tuple] = set()

    def _insider_key(r: dict) -> tuple:
        return (r["ticker"], r["insider_name"], r["transaction_date"], r["action"], r["share_change"])

    for i, ticker in enumerate(ticker_list, 1):
        ticker_count = 0
        try:
            for page in range(1, max_pages + 1):
                data = sb_client.get_insider_movements(ticker, page=page, limit=20)
                movements = data.get("movement") or data.get("movements") or []

                if not movements:
                    break  # no more pages

                for record in movements:
                    row = _parse_insider_record(ticker, record)
                    if row:
                        key = _insider_key(row)
                        if key not in seen_keys:
                            seen_keys.add(key)
                            all_rows.append(row)
                            ticker_count += 1

                # If fewer than limit, we've reached the last page
                if len(movements) < 20:
                    break

            logger.info("[%d/%d] %s: %d insider transactions",
                        i, len(ticker_list), ticker, ticker_count)
            if ticker_count > 0:
                result.ok(ticker)

        except Exception as e:
            logger.warning("Failed insider %s: %s", ticker, e)
            result.fail(ticker, str(e))

        # Batch upsert
        if len(all_rows) > 2000:
            logger.info("Batch upserting %d insider rows...", len(all_rows))
            bulk_upsert(
                "insider_transactions", all_rows,
                on_conflict="ticker,insider_name,transaction_date,action,share_change",
            )
            all_rows.clear()

    # Final upsert
    if all_rows:
        logger.info("Upserting %d insider rows...", len(all_rows))
        bulk_upsert(
            "insider_transactions", all_rows,
            on_conflict="ticker,insider_name,transaction_date,action,share_change",
        )

    result.print_summary()
    finish_run(run_id, **result.to_db_kwargs())
    return result


# ------------------------------------------------------------------
# Entry point
# ------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Scrape foreign flow + broker flow + insider transactions"
    )
    parser.add_argument("--ticker", nargs="+", help="Only process these tickers")
    parser.add_argument("--date", help="Specific date to fetch (YYYY-MM-DD)")
    parser.add_argument("--days", type=int, default=2, help="Number of recent trading days (default: 2)")
    parser.add_argument(
        "--broker-backfill",
        type=int,
        metavar="DAYS",
        help="Backfill broker_flow + bandar_signal from Stockbit for N trading days",
    )
    parser.add_argument("--offset", type=int, default=0, help="Skip first N tickers (for batching, e.g. --offset 200)")
    parser.add_argument("--limit", type=int, default=None, help="Max tickers to process (default: BROKER_SUMMARY_TOP_N)")
    parser.add_argument(
        "--insider",
        action="store_true",
        help="Scrape KSEI major holder movements from Stockbit",
    )
    parser.add_argument(
        "--insider-pages",
        type=int,
        default=5,
        metavar="N",
        help="Max pages per ticker for insider scrape (default: 5)",
    )
    args = parser.parse_args()

    setup_logging("money_flow")

    if args.broker_backfill:
        run_broker_backfill(tickers=args.ticker, days=args.broker_backfill, offset=args.offset, limit=args.limit)
    elif args.insider:
        run_insider_scrape(tickers=args.ticker, max_pages=args.insider_pages, offset=args.offset, limit=args.limit)
    else:
        specific_dates = None
        if args.date:
            try:
                specific_dates = [datetime.strptime(args.date, "%Y-%m-%d").date()]
            except ValueError:
                logger.error("Invalid date format: %s (expected YYYY-MM-DD)", args.date)
                sys.exit(1)
        run(tickers=args.ticker, dates=specific_dates, days=args.days)
