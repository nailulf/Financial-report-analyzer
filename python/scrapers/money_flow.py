from __future__ import annotations

"""
money_flow.py — Layer 2 + 5 scraper (foreign flow + broker summary)

Updates two tables:
  - daily_prices: fills foreign_buy, foreign_sell, foreign_net columns
                  (and value, frequency if not yet populated by daily_prices.py)
  - broker_summary: inserts per-broker buy/sell data

Scope: limited to BROKER_SUMMARY_TOP_N stocks by market cap (scraping
800 × 800 brokers × daily is too slow). Extend the scope by changing
that config value.

Run:
    cd python && python -m scrapers.money_flow
    cd python && python -m scrapers.money_flow --ticker BBRI
    cd python && python -m scrapers.money_flow --date 2026-03-14        # specific date
    cd python && python -m scrapers.money_flow --days 5                 # last N trading days
"""
import argparse
import logging
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from config import BROKER_SUMMARY_TOP_N
from utils.helpers import RunResult, setup_logging, safe_int, safe_float, safe_str
from utils.idx_client import IDXClient
from utils.supabase_client import bulk_upsert, fetch_all, fetch_column, get_client, start_run, finish_run

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
# Parser: IDX trading info (foreign flow + value + frequency)
# ------------------------------------------------------------------

def _parse_trading_info_row(ticker: str, record: dict) -> dict | None:
    """
    Map a single IDX GetTradingInfoSS reply to a daily_prices UPDATE dict.

    Verified field names from live API (March 2026):
      Date, ForeignBuy, ForeignSell, Value, Frequency
    """
    raw_date = record.get("Date")
    if not raw_date:
        return None

    trade_date = _parse_date(raw_date)
    if not trade_date:
        return None

    foreign_buy = safe_int(record.get("ForeignBuy"))
    foreign_sell = safe_int(record.get("ForeignSell"))
    foreign_net = None
    if foreign_buy is not None and foreign_sell is not None:
        foreign_net = foreign_buy - foreign_sell

    return {
        "ticker": ticker,
        "date": trade_date,
        "foreign_buy": foreign_buy,
        "foreign_sell": foreign_sell,
        "foreign_net": foreign_net,
        "value": safe_int(record.get("Value")),
        "frequency": safe_int(record.get("Frequency")),
        "last_updated": datetime.now(timezone.utc).isoformat(),
    }


# ------------------------------------------------------------------
# Parser: IDX broker summary
# ------------------------------------------------------------------

def _parse_broker_row(ticker: str, trade_date: str, record: dict) -> dict | None:
    """
    Map a single IDX GetBrokerSummary record to a broker_summary row.

    Verified field names from live API (March 2026):
      IDFirm (broker_code), FirmName (broker_name),
      Volume (total), Value (total IDR), Frequency

    NOTE: IDX API returns total volume/value per broker only.
    Buy/sell split is NOT available from this endpoint.
    buy_volume/buy_value store total; sell_volume/sell_value are NULL.
    """
    broker_code = safe_str(record.get("IDFirm"))
    if not broker_code:
        return None

    total_volume = safe_int(record.get("Volume"))
    total_value = safe_int(record.get("Value"))

    return {
        "ticker": ticker,
        "date": trade_date,
        "broker_code": broker_code,
        "broker_name": safe_str(record.get("FirmName")),
        # IDX only provides total (buy+sell combined) — no split available
        "buy_volume": total_volume,
        "buy_value": total_value,
        "sell_volume": None,
        "sell_value": None,
        "net_volume": None,
        "net_value": None,
        "frequency": safe_int(record.get("Frequency")),
        "last_updated": datetime.now(timezone.utc).isoformat(),
    }


# ------------------------------------------------------------------
# Parser: Stockbit broker distribution (buy/sell split)
# ------------------------------------------------------------------

def _fetch_broker_stockbit(
    ticker: str,
    trade_date: str,
    client,
) -> list[dict]:
    """
    Fetch broker buy/sell data from Stockbit's order-trade/broker/distribution.

    Makes 2 API calls per ticker/date (value + volume), merges into unified rows.
    Returns list of broker_summary row dicts with buy/sell/net filled.
    """
    value_data = client.get_broker_distribution(ticker, trade_date, data_type="VALUE")
    volume_data = client.get_broker_distribution(ticker, trade_date, data_type="VOLUME")

    if not value_data and not volume_data:
        return []

    # Merge buy/sell by broker code
    brokers: dict[str, dict] = {}
    now_iso = datetime.now(timezone.utc).isoformat()

    def ensure(code: str, inv_type: str) -> dict:
        if code not in brokers:
            brokers[code] = {
                "ticker": ticker,
                "date": trade_date,
                "broker_code": code,
                "broker_name": None,  # filled later from existing data or left null
                "buy_volume": None,
                "buy_value": None,
                "sell_volume": None,
                "sell_value": None,
                "net_volume": None,
                "net_value": None,
                "frequency": None,
                "investor_type": inv_type or None,
                "last_updated": now_iso,
            }
        return brokers[code]

    # Value data (IDR amounts)
    for b in value_data.get("top_broker_buy") or []:
        row = ensure(b["code"], b.get("type"))
        row["buy_value"] = safe_int(b["amount"])
    for b in value_data.get("top_broker_sell") or []:
        row = ensure(b["code"], b.get("type"))
        row["sell_value"] = safe_int(b["amount"])

    # Volume data (share counts)
    for b in volume_data.get("top_broker_buy") or []:
        row = ensure(b["code"], b.get("type"))
        row["buy_volume"] = safe_int(b["amount"])
    for b in volume_data.get("top_broker_sell") or []:
        row = ensure(b["code"], b.get("type"))
        row["sell_volume"] = safe_int(b["amount"])

    # Compute net
    for row in brokers.values():
        bv = row.get("buy_value") or 0
        sv = row.get("sell_value") or 0
        row["net_value"] = bv - sv
        bvol = row.get("buy_volume") or 0
        svol = row.get("sell_volume") or 0
        row["net_volume"] = bvol - svol

    return list(brokers.values())


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
    Fetch foreign flow and broker summary.

    Args:
        tickers: If None, uses top BROKER_SUMMARY_TOP_N stocks by market cap.
        dates:   If None, defaults to last `days` trading days.
        days:    Number of recent trading days to fetch (default: 2).
    """
    result = RunResult("money_flow")
    run_id = start_run(
        "money_flow",
        metadata={"mode": "single" if tickers else "top_n", "days": days},
    )

    # --- Determine ticker list ---
    if tickers:
        ticker_list = [t.upper() for t in tickers]
    else:
        # Top N stocks by market cap
        rows = fetch_all(
            "stocks",
            "ticker",
            filters={"status": "Active"},
        )
        # Sort by market_cap descending — fetch all then sort
        all_stocks = fetch_all("stocks", "ticker, market_cap", filters={"status": "Active"})
        all_stocks.sort(key=lambda r: r.get("market_cap") or 0, reverse=True)
        ticker_list = [r["ticker"] for r in all_stocks[:BROKER_SUMMARY_TOP_N]]
        logger.info("Targeting top %d stocks by market cap", len(ticker_list))

    # --- Determine date list ---
    if dates:
        date_list = [d.isoformat() if isinstance(d, date) else d for d in dates]
    else:
        date_list = [d.isoformat() for d in _last_n_trading_dates(days)]
    logger.info("Fetching data for dates: %s", date_list)

    client = IDXClient()
    trading_info_rows: list[dict] = []
    broker_rows: list[dict] = []

    for i, ticker in enumerate(ticker_list, 1):
        logger.debug("[%d/%d] %s", i, len(ticker_list), ticker)
        try:
            # --- Foreign flow (covers multiple days per call) ---
            trading_records = client.get_trading_info(ticker, days=max(days + 3, 10))
            for record in trading_records:
                row = _parse_trading_info_row(ticker, record)
                if row and row["date"] in date_list:
                    trading_info_rows.append(row)

            # --- Broker summary (one call per date) ---
            for trade_date in date_list:
                broker_records = client.get_broker_summary(ticker, trade_date)
                for record in broker_records:
                    row = _parse_broker_row(ticker, trade_date, record)
                    if row:
                        broker_rows.append(row)

            result.ok(ticker)

        except Exception as e:
            logger.warning("Failed %s: %s", ticker, e)
            result.fail(ticker, str(e))

    # --- Upsert foreign flow into daily_prices ---
    if trading_info_rows:
        logger.info("Upserting %d trading info rows into daily_prices...", len(trading_info_rows))
        # Only update the foreign flow + value + frequency columns
        # Use upsert which will merge with existing OHLCV data
        bulk_upsert("daily_prices", trading_info_rows, on_conflict="ticker,date")

    # --- Upsert broker summary ---
    if broker_rows:
        logger.info("Upserting %d broker summary rows...", len(broker_rows))
        bulk_upsert("broker_summary", broker_rows, on_conflict="ticker,date,broker_code")

    result.print_summary()
    finish_run(run_id, **result.to_db_kwargs())
    return result


# ------------------------------------------------------------------
# Broker backfill (Stockbit — buy/sell split)
# ------------------------------------------------------------------

def run_broker_backfill(
    tickers: list[str] | None = None,
    days: int = 30,
) -> RunResult:
    """
    Backfill broker_summary with buy/sell data from Stockbit.

    Fetches per-day broker distribution for the last N trading days.
    Each day requires 2 API calls per ticker (value + volume).

    Args:
        tickers: Tickers to process. None = top N by market cap.
        days:    Number of trading days to backfill (default: 30).
    """
    result = RunResult("broker_backfill")
    run_id = start_run("broker_backfill", metadata={"days": days})

    if tickers:
        ticker_list = [t.upper() for t in tickers]
    else:
        all_stocks = fetch_all("stocks", "ticker, market_cap", filters={"status": "Active"})
        all_stocks.sort(key=lambda r: r.get("market_cap") or 0, reverse=True)
        ticker_list = [r["ticker"] for r in all_stocks[:BROKER_SUMMARY_TOP_N]]

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

    all_rows: list[dict] = []

    for i, ticker in enumerate(ticker_list, 1):
        ticker_rows = 0
        try:
            for trade_date in date_list:
                rows = _fetch_broker_stockbit(ticker, trade_date, sb_client)
                if rows:
                    # Strip investor_type if column doesn't exist in DB
                    for r in rows:
                        r.pop("investor_type", None)
                    all_rows.extend(rows)
                    ticker_rows += len(rows)

            logger.info("[%d/%d] %s: %d broker rows across %d dates",
                        i, len(ticker_list), ticker, ticker_rows, len(date_list))
            result.ok(ticker)

        except Exception as e:
            logger.warning("Failed %s: %s", ticker, e)
            result.fail(ticker, str(e))

        # Batch upsert every 10 tickers to avoid huge memory usage
        if len(all_rows) > 5000:
            logger.info("Batch upserting %d broker rows...", len(all_rows))
            bulk_upsert("broker_summary", all_rows, on_conflict="ticker,date,broker_code")
            all_rows.clear()

    # Final upsert
    if all_rows:
        logger.info("Upserting %d broker rows...", len(all_rows))
        bulk_upsert("broker_summary", all_rows, on_conflict="ticker,date,broker_code")

    result.print_summary()
    finish_run(run_id, **result.to_db_kwargs())
    return result


# ------------------------------------------------------------------
# Entry point
# ------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Scrape foreign flow + broker summary → daily_prices / broker_summary"
    )
    parser.add_argument("--ticker", nargs="+", help="Test mode: only process these tickers")
    parser.add_argument("--date", help="Specific date to fetch (YYYY-MM-DD)")
    parser.add_argument("--days", type=int, default=2, help="Number of recent trading days (default: 2)")
    parser.add_argument(
        "--broker-backfill",
        type=int,
        metavar="DAYS",
        help="Backfill broker buy/sell data from Stockbit for N trading days",
    )
    args = parser.parse_args()

    setup_logging("money_flow")

    if args.broker_backfill:
        run_broker_backfill(tickers=args.ticker, days=args.broker_backfill)
    else:
        specific_dates = None
        if args.date:
            try:
                specific_dates = [datetime.strptime(args.date, "%Y-%m-%d").date()]
            except ValueError:
                logger.error("Invalid date format: %s (expected YYYY-MM-DD)", args.date)
                sys.exit(1)
        run(tickers=args.ticker, dates=specific_dates, days=args.days)
