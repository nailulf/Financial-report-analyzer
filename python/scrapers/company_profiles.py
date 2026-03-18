from __future__ import annotations

"""
company_profiles.py — Layer 4 scraper

Populates:
  - company_profiles (description, website, address, etc.)
  - company_officers (directors, commissioners)
  - shareholders (ownership structure)

Source: IDX API GetCompanyProfilesIndex (paginated)

Run:
    cd python && python -m scrapers.company_profiles
    cd python && python -m scrapers.company_profiles --ticker BBRI
"""
import argparse
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from utils.helpers import RunResult, setup_logging, safe_str, safe_float, safe_int
from utils.idx_client import IDXClient
from utils.supabase_client import (
    upsert, bulk_upsert, delete_where, fetch_column, start_run, finish_run
)

logger = logging.getLogger(__name__)


# ------------------------------------------------------------------
# IDX profile record parsers
# ------------------------------------------------------------------

def _parse_profile(ticker: str, record: dict) -> dict:
    """
    Map a raw IDX GetCompanyProfiles record to `company_profiles` schema.

    Verified field names from live API (March 2026):
      Alamat, Telepon, Fax, Email, Website, NPWP,
      KegiatanUsahaUtama (description), BAE (registry_agency),
      TanggalPencatatan (listing_date)
    """
    listing_date = None
    raw_date = record.get("TanggalPencatatan")
    if raw_date:
        s = str(raw_date).split("T")[0]
        for fmt in ("%Y-%m-%d", "%d/%m/%Y"):
            try:
                listing_date = datetime.strptime(s, fmt).strftime("%Y-%m-%d")
                break
            except ValueError:
                continue

    return {
        "ticker": ticker,
        "description": safe_str(record.get("KegiatanUsahaUtama")),
        "website": safe_str(record.get("Website")),
        "address": safe_str(record.get("Alamat")),
        "phone": safe_str(record.get("Telepon")),
        "email": safe_str(record.get("Email")),
        "npwp": safe_str(record.get("NPWP")),
        "listing_date": listing_date,
        "registry_agency": safe_str(record.get("BAE")),
        "last_updated": datetime.now(timezone.utc).isoformat(),
    }


def _parse_officers(ticker: str, record: dict) -> list[dict]:
    """
    Extract company officers (directors, commissioners) from an IDX profile record.

    IDX may provide officers in these keys:
      Direksi (directors), DewanKomisaris (commissioners)
    Each is a list of dicts with keys: Nama, Jabatan, JenisJabatan, etc.
    """
    officers: list[dict] = []
    now = datetime.now(timezone.utc).isoformat()

    def _add(people: list, role: str) -> None:
        for person in people:
            if not isinstance(person, dict):
                continue
            name = safe_str(person.get("Nama") or person.get("Name") or person.get("name"))
            if not name:
                continue
            title = safe_str(
                person.get("Jabatan") or person.get("Title") or person.get("title")
            )
            # Independent flag: IDX sometimes marks with 'Independen' in title
            is_independent = bool(
                person.get("IsIndependent")
                or (title and "independen" in title.lower())
            )
            officers.append({
                "ticker": ticker,
                "name": name,
                "role": role,
                "title": title,
                "is_independent": is_independent,
                "last_updated": now,
            })

    # Try common IDX field names for directors and commissioners
    directors = (
        record.get("Direksi")
        or record.get("Directors")
        or record.get("directors")
        or []
    )
    commissioners = (
        record.get("DewanKomisaris")
        or record.get("Commissioners")
        or record.get("commissioners")
        or []
    )

    if isinstance(directors, list):
        _add(directors, "director")
    if isinstance(commissioners, list):
        _add(commissioners, "commissioner")

    return officers


def _parse_shareholders(ticker: str, record: dict) -> list[dict]:
    """
    Extract shareholders from an IDX profile record.

    IDX may provide shareholders as:
      PemegangSaham / Shareholders — list of dicts with
      Nama, JenisPemegang, JumlahSaham, Persentase, TanggalData
    """
    shareholders: list[dict] = []
    now = datetime.now(timezone.utc).isoformat()

    raw = (
        record.get("PemegangSaham")
        or record.get("Shareholders")
        or record.get("shareholders")
        or []
    )
    if not isinstance(raw, list):
        return []

    snapshot_date = _parse_date(record.get("TanggalData") or record.get("SnapshotDate"))

    for sh in raw:
        if not isinstance(sh, dict):
            continue
        name = safe_str(sh.get("Nama") or sh.get("Name") or sh.get("name"))
        if not name:
            continue

        holder_type_raw = safe_str(
            sh.get("JenisPemegang") or sh.get("HolderType") or sh.get("holderType")
        )
        holder_type = _map_holder_type(holder_type_raw)

        shareholders.append({
            "ticker": ticker,
            "holder_name": name,
            "holder_type": holder_type,
            "shares_held": safe_int(
                sh.get("JumlahSaham") or sh.get("SharesHeld") or sh.get("sharesHeld")
            ),
            "percentage": safe_float(
                sh.get("Persentase") or sh.get("Percentage") or sh.get("percentage"), 4
            ),
            "snapshot_date": snapshot_date,
            "last_updated": now,
        })

    return shareholders


def _map_holder_type(raw: str | None) -> str | None:
    if not raw:
        return None
    lower = raw.lower()
    if any(k in lower for k in ["pemerintah", "government", "negara", "bumn"]):
        return "government"
    if any(k in lower for k in ["institusi", "institution", "lembaga", "perusahaan"]):
        return "institution"
    if any(k in lower for k in ["publik", "public", "masyarakat"]):
        return "public"
    if any(k in lower for k in ["individu", "individual", "perorangan"]):
        return "individual"
    return raw


def _parse_date(value) -> str | None:
    if not value:
        return None
    if "/Date(" in str(value):
        try:
            ms = int(str(value).replace("/Date(", "").replace(")/", "").split("+")[0])
            return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
        except (ValueError, IndexError):
            return None
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%Y%m%d", "%d-%m-%Y"):
        try:
            return datetime.strptime(str(value).strip(), fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None


# ------------------------------------------------------------------
# Main scraper
# ------------------------------------------------------------------

def run(tickers: list[str] | None = None) -> RunResult:
    """
    Fetch company profiles, officers, and shareholders.

    For each ticker:
    1. Fetches profile from IDX API
    2. Upserts into company_profiles (one row per ticker)
    3. Replaces company_officers rows (delete + insert to handle departures)
    4. Replaces shareholders rows (delete + insert for fresh snapshot)
    """
    result = RunResult("company_profiles")
    run_id = start_run(
        "company_profiles",
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

    logger.info("Processing %d tickers", len(ticker_list))
    client = IDXClient()

    profile_rows: list[dict] = []
    officer_rows: list[dict] = []
    shareholder_rows: list[dict] = []

    for i, ticker in enumerate(ticker_list, 1):
        logger.debug("[%d/%d] Fetching profile for %s", i, len(ticker_list), ticker)
        try:
            record = client.get_company_profile(ticker)
            if not record:
                result.skip(ticker, "no profile data from IDX")
                continue

            profile_rows.append(_parse_profile(ticker, record))
            officer_rows.extend(_parse_officers(ticker, record))
            shareholder_rows.extend(_parse_shareholders(ticker, record))
            result.ok(ticker)

        except Exception as e:
            logger.warning("Failed %s: %s", ticker, e)
            result.fail(ticker, str(e))

    # --- Upsert profiles ---
    if profile_rows:
        logger.info("Upserting %d company profiles...", len(profile_rows))
        bulk_upsert("company_profiles", profile_rows, on_conflict="ticker")

    # --- Replace officers (full refresh per ticker) ---
    if officer_rows:
        # Group by ticker and replace each ticker's officers atomically
        from collections import defaultdict
        officers_by_ticker: dict[str, list] = defaultdict(list)
        for row in officer_rows:
            officers_by_ticker[row["ticker"]].append(row)

        logger.info("Replacing officers for %d tickers...", len(officers_by_ticker))
        for ticker, rows in officers_by_ticker.items():
            delete_where("company_officers", "ticker", ticker)
            upsert("company_officers", rows, on_conflict="id")

    # --- Replace shareholders (full refresh per ticker) ---
    if shareholder_rows:
        from collections import defaultdict
        sh_by_ticker: dict[str, list] = defaultdict(list)
        for row in shareholder_rows:
            sh_by_ticker[row["ticker"]].append(row)

        logger.info("Replacing shareholders for %d tickers...", len(sh_by_ticker))
        for ticker, rows in sh_by_ticker.items():
            delete_where("shareholders", "ticker", ticker)
            upsert("shareholders", rows, on_conflict="id")

    result.print_summary()
    finish_run(run_id, **result.to_db_kwargs())
    return result


# ------------------------------------------------------------------
# Entry point
# ------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Scrape company profiles → company_profiles / officers / shareholders"
    )
    parser.add_argument("--ticker", nargs="+", help="Test mode: only process these tickers")
    args = parser.parse_args()

    setup_logging("company_profiles")
    run(tickers=args.ticker)
