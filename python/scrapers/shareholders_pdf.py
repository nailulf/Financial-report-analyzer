from __future__ import annotations

"""
shareholders_pdf.py — Bulk 1%+ shareholder data loader

Parses a PDF or Excel file containing major shareholder (≥1%) data for all
IDX stocks, then upserts into the `shareholders_major` table with a given
report date. Each upload is a historical snapshot — old data is never deleted.

Supported input formats:
  - Excel (.xlsx / .xls / .csv) — preferred; use pandas
  - PDF with tables         — uses pdfplumber, falls back to tabula-py

Expected table columns (detected automatically, case-insensitive):
  Ticker / Kode Emiten / Kode Saham   → ticker
  Nama Pemegang / Holder Name         → holder_name
  Jenis Pemegang / Holder Type        → holder_type  (optional)
  Jumlah Saham / Shares Held          → shares_held   (optional)
  Persentase / % / Percentage         → percentage

Usage:
    cd python
    python -m scrapers.shareholders_pdf --file data/shareholders_Q4_2025.xlsx --date 2025-12-31
    python -m scrapers.shareholders_pdf --file data/shareholders.pdf --date 2025-12-31
    python -m scrapers.shareholders_pdf --file data/shareholders.pdf --date 2025-12-31 --dry-run
    python -m scrapers.shareholders_pdf --file data/shareholders.pdf --date 2025-12-31 --format pdf
"""

import argparse
import logging
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import pandas as pd

sys.path.insert(0, str(Path(__file__).parent.parent))

from utils.helpers import RunResult, setup_logging, safe_float, safe_int
from utils.supabase_client import bulk_upsert, fetch_column, start_run, finish_run

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Column name mapping — extend these lists to handle more source formats
# ---------------------------------------------------------------------------

TICKER_COLS     = ["share_code", "kode emiten", "kode saham", "ticker", "kode",
                   "emiten", "stock code", "stock", "code", "saham"]
HOLDER_COLS     = ["investor_name", "nama pemegang saham", "nama pemegang",
                   "pemegang saham", "shareholder", "holder name", "holder",
                   "nama", "pemegang", "shareholder name"]
TYPE_COLS       = ["investor_type", "jenis pemegang", "jenis", "holder type",
                   "type", "kategori", "tipe pemegang"]
SHARES_COLS     = ["total_holding_shares", "jumlah saham", "jumlah lembar",
                   "shares held", "shares", "lembar saham", "jumlah", "lembar"]
PCT_COLS        = ["percentage", "persentase", "persentase (%)", "persen",
                   "% kepemilikan", "% ownership", "%", "pct", "kepemilikan (%)"]

# Holder type normalisation
TYPE_MAP = {
    "pemerintah": "government", "government": "government", "negara": "government",
    "bumn": "government",
    "institusi": "institution", "institution": "institution", "lembaga": "institution",
    "perusahaan": "institution", "badan usaha": "institution",
    "asing": "foreign", "foreign": "foreign", "luar negeri": "foreign",
    "publik": "public", "public": "public", "masyarakat": "public",
    "individu": "individual", "individual": "individual", "perorangan": "individual",
    "orang perseorangan": "individual",
}


# ---------------------------------------------------------------------------
# Column detection
# ---------------------------------------------------------------------------

def _match_col(headers: list[str], candidates: list[str]) -> Optional[str]:
    """Return the first header that matches any candidate (case-insensitive, stripped)."""
    normalised = {h.lower().strip(): h for h in headers}
    for candidate in candidates:
        c = candidate.lower().strip()
        if c in normalised:
            return normalised[c]
        # partial match: any header that *contains* the candidate keyword
        for norm, orig in normalised.items():
            if c in norm:
                return orig
    return None


def detect_columns(df: pd.DataFrame) -> dict[str, Optional[str]]:
    """Map logical field names → actual DataFrame column names."""
    headers = list(df.columns)
    mapping = {
        "ticker":      _match_col(headers, TICKER_COLS),
        "holder_name": _match_col(headers, HOLDER_COLS),
        "holder_type": _match_col(headers, TYPE_COLS),
        "shares_held": _match_col(headers, SHARES_COLS),
        "percentage":  _match_col(headers, PCT_COLS),
    }
    return mapping


# ---------------------------------------------------------------------------
# Holder type normalisation
# ---------------------------------------------------------------------------

def normalise_holder_type(raw: Optional[str]) -> Optional[str]:
    if not raw:
        return None
    lower = str(raw).lower().strip()
    for key, value in TYPE_MAP.items():
        if key in lower:
            return value
    return raw.strip() if raw else None


# ---------------------------------------------------------------------------
# Percentage / shares cleaning
# ---------------------------------------------------------------------------

def _clean_numeric(val) -> Optional[float]:
    """Convert various string formats to float. Handles '15,32%', '1.234.567', etc."""
    if val is None or (isinstance(val, float) and pd.isna(val)):
        return None
    s = str(val).strip()
    # Remove percentage sign and surrounding whitespace
    s = s.replace("%", "").strip()
    # Remove thousand separators (comma or dot used as thousand sep)
    # Detect whether comma is decimal or thousand separator:
    # If there are two different separators, the last one is decimal.
    has_comma = "," in s
    has_dot   = "." in s
    if has_comma and has_dot:
        # e.g. "1.234,56" (European) or "1,234.56" (US)
        if s.rindex(",") > s.rindex("."):
            # comma is decimal separator
            s = s.replace(".", "").replace(",", ".")
        else:
            # dot is decimal separator
            s = s.replace(",", "")
    elif has_comma:
        # Could be thousand sep ("1,234") or decimal ("1,5")
        parts = s.split(",")
        if len(parts) == 2 and len(parts[1]) <= 2:
            # Treat as decimal ("15,32" → "15.32")
            s = s.replace(",", ".")
        else:
            s = s.replace(",", "")
    try:
        return float(s)
    except ValueError:
        return None


def _clean_shares(val) -> Optional[int]:
    """Convert share count strings to int."""
    if val is None or (isinstance(val, float) and pd.isna(val)):
        return None
    s = str(val).strip().replace(",", "").replace(".", "").replace(" ", "")
    # Handle numbers like "1.234.567" (dot as thousand sep)
    # If after removing dots we have a valid int, use that
    try:
        return int(float(s))
    except ValueError:
        return None


def _clean_ticker(val) -> Optional[str]:
    """Normalise ticker: strip .JK suffix, uppercase, remove whitespace."""
    if not val or (isinstance(val, float) and pd.isna(val)):
        return None
    t = str(val).strip().upper()
    if t.endswith(".JK"):
        t = t[:-3]
    # Remove any non-alphanumeric characters (some PDFs have trailing dots/spaces)
    t = re.sub(r"[^A-Z0-9]", "", t)
    return t if t else None


# ---------------------------------------------------------------------------
# DataFrame → row dicts
# ---------------------------------------------------------------------------

def dataframe_to_rows(
    df: pd.DataFrame,
    report_date: str,
    known_tickers: set[str],
    source: str = "excel_upload",
) -> tuple[list[dict], list[str]]:
    """
    Convert a cleaned DataFrame to `shareholders_major` row dicts.

    Returns:
        (valid_rows, warnings)
    """
    col = detect_columns(df)
    logger.info("Column mapping: %s", col)

    if not col["ticker"]:
        raise ValueError(
            f"Could not detect ticker column. Available columns: {list(df.columns)}"
        )
    if not col["holder_name"]:
        raise ValueError(
            f"Could not detect holder_name column. Available columns: {list(df.columns)}"
        )
    if not col["percentage"]:
        raise ValueError(
            f"Could not detect percentage column. Available columns: {list(df.columns)}"
        )

    now = datetime.now(timezone.utc).isoformat()
    rows: list[dict] = []
    warnings: list[str] = []

    for idx, row in df.iterrows():
        ticker = _clean_ticker(row[col["ticker"]])
        if not ticker:
            continue

        holder_name = str(row[col["holder_name"]]).strip() if col["holder_name"] else None
        if not holder_name or holder_name.lower() in ("nan", "none", ""):
            continue

        percentage = _clean_numeric(row[col["percentage"]])
        if percentage is None:
            continue

        # Skip junk rows (e.g. repeated headers, subtotals)
        if ticker.lower() in ("kode", "ticker", "saham", "emiten", "total"):
            continue
        if holder_name.lower() in ("nama pemegang", "pemegang saham", "holder", "total"):
            continue

        # Warn but still include unknown tickers (data may lag stock_universe)
        if known_tickers and ticker not in known_tickers:
            warnings.append(f"Unknown ticker: {ticker} (row {idx})")

        holder_type = None
        if col["holder_type"]:
            holder_type = normalise_holder_type(row.get(col["holder_type"]))

        shares_held = None
        if col["shares_held"]:
            shares_held = _clean_shares(row.get(col["shares_held"]))

        rows.append({
            "ticker":      ticker,
            "report_date": report_date,
            "holder_name": holder_name,
            "holder_type": holder_type,
            "shares_held": shares_held,
            "percentage":  percentage,
            "source":      source,
            "uploaded_at": now,
            "last_updated": now,
        })

    # Deduplicate: same investor can appear multiple times per stock/date
    # (e.g. scripless vs scrip rows, or multiple domiciles).
    # Merge by summing shares_held and percentage; keep first holder_type seen.
    merged: dict[tuple, dict] = {}
    for r in rows:
        key = (r["ticker"], r["holder_name"], r["report_date"])
        if key not in merged:
            merged[key] = r.copy()
        else:
            existing = merged[key]
            if r["shares_held"] is not None:
                existing["shares_held"] = (existing["shares_held"] or 0) + r["shares_held"]
            if r["percentage"] is not None:
                existing["percentage"] = round((existing["percentage"] or 0) + r["percentage"], 4)
            if existing["holder_type"] is None and r["holder_type"] is not None:
                existing["holder_type"] = r["holder_type"]

    deduped = list(merged.values())
    if len(deduped) < len(rows):
        logger.info("Deduplicated %d → %d rows (merged split holdings)", len(rows), len(deduped))

    return deduped, warnings


# ---------------------------------------------------------------------------
# File readers
# ---------------------------------------------------------------------------

def read_excel(file_path: Path) -> pd.DataFrame:
    """Read Excel or CSV file into a single DataFrame."""
    suffix = file_path.suffix.lower()
    if suffix == ".csv":
        # Try comma first, then semicolon
        try:
            df = pd.read_csv(file_path, dtype=str)
        except Exception:
            df = pd.read_csv(file_path, sep=";", dtype=str)
    else:
        df = pd.read_excel(file_path, dtype=str, header=0)

    # Drop fully empty rows and columns
    df = df.dropna(how="all").dropna(axis=1, how="all")
    df.columns = [str(c).strip() for c in df.columns]
    return df


def read_pdf(file_path: Path) -> pd.DataFrame:
    """
    Extract tables from a PDF and combine them into one DataFrame.

    Strategy:
    1. Try pdfplumber (better for complex layouts)
    2. Fall back to tabula-py
    """
    try:
        return _read_pdf_pdfplumber(file_path)
    except ImportError:
        pass

    try:
        return _read_pdf_tabula(file_path)
    except ImportError:
        pass

    raise ImportError(
        "PDF parsing requires either pdfplumber or tabula-py.\n"
        "Install with:  pip install pdfplumber\n"
        "           or: pip install tabula-py"
    )


def _read_pdf_pdfplumber(file_path: Path) -> pd.DataFrame:
    import pdfplumber  # type: ignore

    all_rows: list[list] = []
    header: list[str] | None = None

    with pdfplumber.open(str(file_path)) as pdf:
        logger.info("PDF has %d pages", len(pdf.pages))
        for page_num, page in enumerate(pdf.pages, 1):
            tables = page.extract_tables()
            for table in tables:
                if not table:
                    continue
                for row in table:
                    if row is None:
                        continue
                    cleaned = [str(c).strip() if c is not None else "" for c in row]
                    if not any(cleaned):
                        continue

                    # Detect header row: contains known column keywords
                    row_lower = [c.lower() for c in cleaned]
                    is_header = any(
                        any(k in cell for k in ["kode", "ticker", "pemegang", "persentase", "percentage"])
                        for cell in row_lower
                    )

                    if header is None and is_header:
                        header = cleaned
                    elif is_header and header is not None:
                        # Skip repeated headers on subsequent pages
                        pass
                    elif header is not None:
                        all_rows.append(cleaned)

    if not header:
        raise ValueError("Could not detect header row in PDF")
    if not all_rows:
        raise ValueError("No data rows extracted from PDF")

    # Pad rows that are shorter than header
    n = len(header)
    padded = [r + [""] * (n - len(r)) if len(r) < n else r[:n] for r in all_rows]
    df = pd.DataFrame(padded, columns=header)
    df = df.replace("", None).dropna(how="all")
    return df


def _read_pdf_tabula(file_path: Path) -> pd.DataFrame:
    import tabula  # type: ignore

    dfs = tabula.read_pdf(
        str(file_path),
        pages="all",
        multiple_tables=True,
        pandas_options={"dtype": str},
        silent=True,
    )
    if not dfs:
        raise ValueError("tabula-py extracted no tables from the PDF")

    combined = pd.concat(dfs, ignore_index=True)
    combined = combined.dropna(how="all").dropna(axis=1, how="all")
    combined.columns = [str(c).strip() for c in combined.columns]
    return combined


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def run(
    file_path: str | Path,
    report_date: str,
    fmt: str = "auto",
    dry_run: bool = False,
) -> RunResult:
    """
    Parse file and upsert into shareholders_major.

    Args:
        file_path:   Path to the PDF, Excel, or CSV file
        report_date: 'YYYY-MM-DD' as-of date for this snapshot
        fmt:         'auto', 'pdf', 'excel', or 'csv'
        dry_run:     If True, parse and validate but do not write to Supabase
    """
    result = RunResult("shareholders_pdf")
    path = Path(file_path)

    if not path.exists():
        logger.error("File not found: %s", path)
        result.fail("file", f"not found: {path}")
        return result

    # Validate report date
    try:
        datetime.strptime(report_date, "%Y-%m-%d")
    except ValueError:
        logger.error("Invalid date format '%s'. Use YYYY-MM-DD.", report_date)
        result.fail("date", "invalid format, expected YYYY-MM-DD")
        return result

    run_id = start_run(
        "shareholders_pdf",
        metadata={"file": str(path), "report_date": report_date, "dry_run": dry_run},
    )

    # --- Detect format ---
    suffix = path.suffix.lower()
    if fmt == "auto":
        fmt = "pdf" if suffix == ".pdf" else "excel"

    source = "pdf_upload" if fmt == "pdf" else "excel_upload"

    # --- Read file ---
    logger.info("Reading %s file: %s", fmt.upper(), path)
    try:
        df = read_pdf(path) if fmt == "pdf" else read_excel(path)
    except Exception as e:
        logger.error("Failed to read file: %s", e)
        result.fail(str(path), str(e))
        finish_run(run_id, "failed", error_message=str(e))
        return result

    logger.info("Extracted %d rows × %d columns", len(df), len(df.columns))
    logger.info("Columns: %s", list(df.columns))

    # --- Load known tickers for validation ---
    try:
        known_tickers: set[str] = set(fetch_column("stocks", "ticker"))
    except Exception:
        known_tickers = set()
        logger.warning("Could not load ticker list from Supabase — skipping ticker validation")

    # --- Convert to rows ---
    try:
        rows, warnings = dataframe_to_rows(df, report_date, known_tickers, source)
    except ValueError as e:
        logger.error("Column mapping failed: %s", e)
        result.fail("columns", str(e))
        finish_run(run_id, "failed", error_message=str(e))
        return result

    for w in warnings[:20]:
        logger.warning(w)
    if len(warnings) > 20:
        logger.warning("... and %d more unknown-ticker warnings", len(warnings) - 20)

    logger.info("Parsed %d valid shareholder rows for report_date=%s", len(rows), report_date)

    if not rows:
        logger.error("No valid rows produced — check column mapping and file format")
        result.fail("data", "no valid rows")
        finish_run(run_id, "failed", error_message="no valid rows")
        return result

    # --- Preview (always show) ---
    unique_tickers = len({r["ticker"] for r in rows})
    logger.info("Coverage: %d tickers, %d total holder rows", unique_tickers, len(rows))

    if dry_run:
        logger.info("[DRY RUN] Would upsert %d rows — not writing to Supabase.", len(rows))
        # Print a sample
        for r in rows[:5]:
            logger.info("  Sample: %s", r)
        result.ok("dry_run")
        finish_run(run_id, "success")
        return result

    # --- Upsert ---
    logger.info("Upserting %d rows into shareholders_major...", len(rows))
    try:
        bulk_upsert(
            "shareholders_major",
            rows,
            on_conflict="ticker,holder_name,report_date",
        )
        for r in rows:
            result.ok(r["ticker"])
    except Exception as e:
        logger.error("Upsert failed: %s", e)
        result.fail("upsert", str(e))
        finish_run(run_id, "failed", error_message=str(e))
        return result

    result.print_summary()
    finish_run(run_id, **result.to_db_kwargs())
    logger.info(
        "Done. %d rows upserted for report_date=%s (%d tickers).",
        len(rows), report_date, unique_tickers,
    )
    return result


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description=(
            "Upload major shareholder (≥1%%) data from a PDF or Excel file "
            "into shareholders_major with full historical tracking."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python -m scrapers.shareholders_pdf --file data/shareholders_Q4_2025.xlsx --date 2025-12-31
  python -m scrapers.shareholders_pdf --file data/shareholders.pdf --date 2025-12-31
  python -m scrapers.shareholders_pdf --file data/shareholders.pdf --date 2025-12-31 --dry-run
  python -m scrapers.shareholders_pdf --file report.csv --date 2025-09-30 --format excel
        """,
    )
    parser.add_argument(
        "--file", "-f", required=True,
        help="Path to the PDF, Excel (.xlsx/.xls), or CSV file",
    )
    parser.add_argument(
        "--date", "-d", required=True,
        help="Report date in YYYY-MM-DD format (as-of date for this snapshot)",
    )
    parser.add_argument(
        "--format", dest="fmt", default="auto",
        choices=["auto", "pdf", "excel"],
        help="Force file format. Default: auto-detect from extension.",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Parse and validate without writing to Supabase",
    )
    args = parser.parse_args()

    setup_logging("shareholders_pdf")
    run(
        file_path=args.file,
        report_date=args.date,
        fmt=args.fmt,
        dry_run=args.dry_run,
    )
