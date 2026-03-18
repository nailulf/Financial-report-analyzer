from __future__ import annotations

"""
stock_universe.py — Layer 1 scraper

Populates the `stocks` table with all IDX-listed companies.

Primary source: IDX API (GetCompanyProfiles — single endpoint for full universe)
Optional fallback: Twelve Data API (when IDX returns incomplete data)

GetCompanyProfiles returns all data needed in one paginated endpoint:
  - Ticker, name, sector, subsector, board, listing date (for stocks table)
  - Address, phone, email, website, NPWP, registry (for company_profiles table)

Run:
    cd python && python -m scrapers.stock_universe
    cd python && python -m scrapers.stock_universe --ticker BBRI   # single stock test
"""
import argparse
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from config import TWELVE_DATA_API_KEY
from utils.helpers import RunResult, setup_logging, safe_str, safe_int
from utils.idx_client import IDXClient
from utils.supabase_client import bulk_upsert, start_run, finish_run

logger = logging.getLogger(__name__)

# ------------------------------------------------------------------
# IDX field → DB column mapping
# Verified against live API response (March 2026)
# ------------------------------------------------------------------

# IDX sector names are in Indonesian — map to English for consistency
_SECTOR_MAP: dict[str, str] = {
    "Keuangan": "Financials",
    "Energi": "Energy",
    "Barang Baku": "Basic Materials",
    "Barang Konsumsi Primer": "Consumer Staples",
    "Barang Konsumsi Non-Primer": "Consumer Discretionary",
    "Perindustrian": "Industrials",
    "Properti & Real Estat": "Property & Real Estate",
    "Teknologi": "Technology",
    "Infrastruktur": "Infrastructure",
    "Transportasi & Logistik": "Transportation & Logistics",
    "Kesehatan": "Healthcare",
    # Legacy sector names (pre-2021 classification)
    "Barang Konsumsi": "Consumer Goods",
    "Pertanian": "Agriculture",
    "Pertambangan": "Mining",
    "Industri Dasar": "Basic Industry",
    "Aneka Industri": "Miscellaneous Industry",
    "Properti": "Property",
    "Perdagangan": "Trade, Services & Investment",
}

_BOARD_MAP: dict[str, str] = {
    "Utama": "Main",
    "Pengembangan": "Development",
    "Akselerasi": "Acceleration",
}


def _normalise_sector(raw: str | None) -> str | None:
    if not raw:
        return None
    return _SECTOR_MAP.get(raw.strip(), raw.strip())


def _normalise_board(raw: str | None) -> str | None:
    if not raw:
        return None
    return _BOARD_MAP.get(raw.strip(), raw.strip())


def _parse_company_profiles_record(record: dict) -> dict:
    """
    Map a raw IDX GetCompanyProfiles record to our `stocks` schema.

    Verified field names from live API (March 2026):
      KodeEmiten, NamaEmiten, Sektor, SubSektor, SubIndustri,
      PapanPencatatan, TanggalPencatatan, Status
    """
    ticker = safe_str(record.get("KodeEmiten"))
    if not ticker:
        return {}

    # Status "0" = Active in IDX API
    raw_status = str(record.get("Status", "0")).strip()
    status = "Active" if raw_status in ("0", "Active", "") else "Suspended"

    return {
        "ticker": ticker.upper(),
        "name": safe_str(record.get("NamaEmiten")),
        "sector": _normalise_sector(record.get("Sektor")),
        "subsector": safe_str(record.get("SubSektor") or record.get("SubIndustri")),
        "board": _normalise_board(record.get("PapanPencatatan")),
        "listing_date": _parse_date(record.get("TanggalPencatatan")),
        "status": status,
        "last_updated": datetime.now(timezone.utc).isoformat(),
    }


def _parse_date(value: str | None) -> str | None:
    if not value:
        return None
    s = str(value).strip()
    # ISO datetime string from IDX: "2003-11-10T00:00:00"
    if "T" in s:
        s = s.split("T")[0]
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%Y%m%d", "%d-%m-%Y"):
        try:
            return datetime.strptime(s, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None


# ------------------------------------------------------------------
# Optional: Twelve Data fallback ticker source
# ------------------------------------------------------------------

def _fetch_tickers_twelve_data() -> list[str]:
    if not TWELVE_DATA_API_KEY:
        return []
    import requests
    try:
        resp = requests.get(
            "https://api.twelvedata.com/stocks",
            params={"exchange": "IDX", "apikey": TWELVE_DATA_API_KEY},
            timeout=20,
        )
        resp.raise_for_status()
        data = resp.json().get("data", [])
        tickers = [row["symbol"] for row in data if "symbol" in row]
        logger.info("Twelve Data returned %d tickers", len(tickers))
        return tickers
    except Exception as e:
        logger.warning("Twelve Data fetch failed: %s", e)
        return []


# ------------------------------------------------------------------
# Main scraper
# ------------------------------------------------------------------

def run(tickers: list[str] | None = None) -> RunResult:
    """
    Fetch all IDX stocks from GetCompanyProfiles and upsert into `stocks`.

    Args:
        tickers: If provided, only process these tickers (testing mode).
    """
    result = RunResult("stock_universe")
    run_id = start_run("stock_universe", metadata={"mode": "single" if tickers else "full"})

    client = IDXClient()
    stocks_by_ticker: dict[str, dict] = {}

    # --- Fetch all companies via GetCompanyProfiles (paginated) ---
    logger.info("Fetching IDX company list (GetCompanyProfiles, paginated)...")
    page_size = 100
    start = 0
    total_records: int | None = None

    while True:
        try:
            page = client.get_company_profiles_page(start=start, length=page_size)
            if total_records is None:
                total_records = page.get("recordsTotal", 0)
                logger.info("IDX reports %d total companies", total_records)

            records = page.get("data", [])
            if not records:
                break

            for record in records:
                row = _parse_company_profiles_record(record)
                if row.get("ticker"):
                    stocks_by_ticker[row["ticker"]] = row

            logger.info("Fetched %d / %d", min(start + page_size, total_records or 0), total_records or 0)
            start += page_size
            if total_records and start >= total_records:
                break

        except Exception as e:
            logger.error("Fetch failed at start=%d: %s", start, e)
            break

    # --- Fallback to Twelve Data if IDX returned nothing ---
    if not stocks_by_ticker:
        logger.warning("IDX returned no companies. Trying Twelve Data fallback...")
        td_tickers = _fetch_tickers_twelve_data()
        for t in td_tickers:
            stocks_by_ticker[t.upper()] = {
                "ticker": t.upper(),
                "status": "Active",
                "last_updated": datetime.now(timezone.utc).isoformat(),
            }

    # --- Filter to requested tickers if in single-stock mode ---
    if tickers:
        tickers_upper = {t.upper() for t in tickers}
        stocks_by_ticker = {t: r for t, r in stocks_by_ticker.items() if t in tickers_upper}
        logger.info("Filtered to %d requested tickers", len(stocks_by_ticker))

    # --- Upsert into Supabase ---
    rows = [r for r in stocks_by_ticker.values() if r.get("ticker")]
    logger.info("Upserting %d stocks into Supabase...", len(rows))
    try:
        bulk_upsert("stocks", rows, on_conflict="ticker")
        for row in rows:
            result.ok(row["ticker"])
    except Exception as e:
        logger.error("Bulk upsert failed: %s", e)
        for row in rows:
            result.fail(row.get("ticker", "?"), str(e))

    result.print_summary()
    finish_run(run_id, **result.to_db_kwargs())
    return result


# ------------------------------------------------------------------
# Entry point
# ------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Scrape IDX stock universe → Supabase stocks table")
    parser.add_argument("--ticker", nargs="+", help="Test mode: only process these tickers")
    args = parser.parse_args()

    setup_logging("stock_universe")
    run(tickers=args.ticker)
