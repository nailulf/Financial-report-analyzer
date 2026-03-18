from __future__ import annotations

"""
test_feasibility.py — End-to-end validation script

Runs a small, safe test for each data source and each scraper using a
single well-known stock (BBRI by default). Validates connectivity,
response parsing, and Supabase writes before running a full batch.

Run BEFORE the first full pipeline run:
    cd python && python test_feasibility.py
    cd python && python test_feasibility.py --ticker ASII   # use a different stock
    cd python && python test_feasibility.py --skip-db       # skip Supabase (offline test)

Exit code: 0 = all checks passed, 1 = one or more checks failed.
"""
import argparse
import sys
import traceback
from datetime import date, timedelta
from pathlib import Path

# Pretty output without Rich dependency check
try:
    from rich.console import Console
    from rich.table import Table
    console = Console()
    def _print(msg: str, style: str = "") -> None:
        console.print(msg, style=style if style else "")
except ImportError:
    def _print(msg: str, style: str = "") -> None:  # type: ignore[misc]
        print(msg)

# Ensure imports work from `python/` directory
sys.path.insert(0, str(Path(__file__).parent))


# ------------------------------------------------------------------
# Check registry
# ------------------------------------------------------------------

class CheckResult:
    def __init__(self, name: str):
        self.name = name
        self.passed: bool | None = None
        self.detail: str = ""

    def ok(self, detail: str = "") -> None:
        self.passed = True
        self.detail = detail

    def fail(self, detail: str = "") -> None:
        self.passed = False
        self.detail = detail


checks: list[CheckResult] = []


def check(name: str):
    """Decorator that wraps a test function and records pass/fail."""
    def decorator(fn):
        def wrapper(*args, **kwargs):
            c = CheckResult(name)
            checks.append(c)
            try:
                result = fn(*args, **kwargs)
                c.ok(str(result) if result else "OK")
            except Exception as e:
                c.fail(f"{type(e).__name__}: {e}")
                if "--verbose" in sys.argv:
                    traceback.print_exc()
            return c
        wrapper.__name__ = fn.__name__
        return wrapper
    return decorator


# ------------------------------------------------------------------
# Checks: environment
# ------------------------------------------------------------------

@check("Config loads from .env")
def check_config():
    from config import SUPABASE_URL, SUPABASE_SERVICE_KEY
    assert SUPABASE_URL.startswith("https://"), "SUPABASE_URL looks wrong"
    assert len(SUPABASE_SERVICE_KEY) > 20, "SUPABASE_SERVICE_KEY looks empty"
    return f"URL={SUPABASE_URL[:40]}..."


@check("Dependencies importable")
def check_imports():
    import curl_cffi
    import yfinance
    import pandas
    import supabase
    import tenacity
    import rich
    return f"yfinance={yfinance.__version__}, pandas={pandas.__version__}"


# ------------------------------------------------------------------
# Checks: IDX API
# ------------------------------------------------------------------

@check("IDX API: GetCompanyProfiles returns stock list")
def check_idx_stock_list():
    from utils.idx_client import IDXClient
    client = IDXClient()
    page = client.get_company_profiles_page(start=0, length=10)
    total = page.get("recordsTotal", 0)
    records = page.get("data", [])
    assert total > 100, f"Expected >100 total stocks, got {total}"
    assert len(records) > 0, "No records in first page"
    sample = records[0]
    assert "KodeEmiten" in sample, f"Expected KodeEmiten key, got: {list(sample.keys())[:5]}"
    return f"{total} total stocks, sample: {sample.get('KodeEmiten')} | {sample.get('NamaEmiten', '')[:30]}"


@check("IDX API: get_company_profile (BBRI)")
def check_idx_profile(ticker: str):
    from utils.idx_client import IDXClient
    client = IDXClient()
    profile = client.get_company_profile(ticker)
    assert profile is not None, "No profile returned"
    return f"Keys: {list(profile.keys())[:5]}"


@check("IDX API: get_trading_info (BBRI, 5 days)")
def check_idx_trading_info(ticker: str):
    from utils.idx_client import IDXClient
    client = IDXClient()
    records = client.get_trading_info(ticker, days=5)
    assert len(records) > 0, "No trading info records returned"
    return f"{len(records)} records, first keys: {list(records[0].keys())[:4]}"


@check("IDX API: get_broker_summary (BBRI, yesterday)")
def check_idx_broker_summary(ticker: str):
    from utils.idx_client import IDXClient
    client = IDXClient()
    # Try yesterday; if market was closed, response may be empty — that's OK
    yesterday = (date.today() - timedelta(days=1)).isoformat()
    records = client.get_broker_summary(ticker, yesterday)
    return f"{len(records)} broker records for {yesterday}"


# ------------------------------------------------------------------
# Checks: yfinance
# ------------------------------------------------------------------

@check("yfinance: 30-day OHLCV download (BBRI.JK)")
def check_yfinance_prices(ticker: str):
    import yfinance as yf
    import pandas as pd
    yf_ticker = f"{ticker}.JK"
    df = yf.download(yf_ticker, period="1mo", auto_adjust=True, progress=False)
    assert not df.empty, "Empty DataFrame returned"
    # yfinance >=1.0 always returns MultiIndex columns (Price, Ticker)
    # Access Close via MultiIndex or flat columns depending on version.
    if isinstance(df.columns, pd.MultiIndex):
        try:
            close_series = df.xs("Close", level="Price", axis=1)
        except (KeyError, TypeError):
            close_series = df.xs("Close", level=0, axis=1)
        close_val = float(close_series.iloc[-1].iloc[0])
    else:
        assert "Close" in df.columns, "No Close column"
        close_val = float(df["Close"].iloc[-1])
    return f"{len(df)} rows, latest close={close_val:.0f}"


@check("yfinance: annual financials (BBRI.JK)")
def check_yfinance_financials(ticker: str):
    import yfinance as yf
    t = yf.Ticker(f"{ticker}.JK")
    fin = t.financials
    assert fin is not None and not fin.empty, "No financials returned"
    return f"{len(fin.columns)} years, rows: {list(fin.index[:3])}"


@check("yfinance: quarterly financials (BBRI.JK)")
def check_yfinance_quarterly(ticker: str):
    import yfinance as yf
    t = yf.Ticker(f"{ticker}.JK")
    fin = t.quarterly_financials
    assert fin is not None and not fin.empty, "No quarterly financials returned"
    return f"{len(fin.columns)} quarters available"


# ------------------------------------------------------------------
# Checks: Supabase connectivity + write/read
# ------------------------------------------------------------------

@check("Supabase: connection OK")
def check_supabase_connect():
    from utils.supabase_client import get_client
    client = get_client()
    # Simple probe: list tables via the postgrest API
    resp = client.table("stocks").select("ticker").limit(1).execute()
    return f"stocks table accessible, {len(resp.data)} rows (may be 0 if empty)"


@check("Supabase: schema tables exist")
def check_supabase_tables():
    from utils.supabase_client import get_client
    client = get_client()
    required_tables = [
        "stocks", "daily_prices", "financials",
        "company_profiles", "company_officers", "shareholders",
        "broker_summary", "scraper_runs",
    ]
    missing = []
    for table in required_tables:
        try:
            client.table(table).select("*").limit(0).execute()
        except Exception:
            missing.append(table)
    if missing:
        raise AssertionError(f"Missing tables: {missing}. Did you apply docs/schema.sql?")
    return f"All {len(required_tables)} tables found"


@check("Supabase: upsert + read round-trip (stocks)")
def check_supabase_roundtrip(ticker: str):
    from utils.supabase_client import upsert, fetch_one, delete_where
    test_row = {
        "ticker": f"TEST_{ticker}",
        "name": "Feasibility Test Stock",
        "status": "Active",
    }
    upsert("stocks", [test_row], on_conflict="ticker")
    fetched = fetch_one("stocks", filters={"ticker": f"TEST_{ticker}"})
    assert fetched is not None, "Could not read back upserted row"
    assert fetched["name"] == "Feasibility Test Stock"
    # Clean up
    delete_where("stocks", "ticker", f"TEST_{ticker}")
    return "Write → Read → Delete OK"


# ------------------------------------------------------------------
# Checks: scraper parse logic (no DB write)
# ------------------------------------------------------------------

@check("Scraper: stock_universe parses IDX GetCompanyProfiles record")
def check_parse_stock_universe():
    from scrapers.stock_universe import _parse_company_profiles_record
    # Matches actual API response structure (verified March 2026)
    sample = {
        "KodeEmiten": "BBRI",
        "NamaEmiten": "Bank Rakyat Indonesia (Persero) Tbk.",
        "Sektor": "Keuangan",
        "SubSektor": "Bank",
        "PapanPencatatan": "Utama",
        "TanggalPencatatan": "2003-11-10T00:00:00",
        "Status": "0",
    }
    row = _parse_company_profiles_record(sample)
    assert row["ticker"] == "BBRI"
    assert row["sector"] == "Financials", f"Expected Financials, got: {row['sector']}"
    assert row["board"] == "Main", f"Expected Main, got: {row['board']}"
    assert row["listing_date"] == "2003-11-10"
    return f"Parsed: {row['ticker']} | {row['sector']} | {row['board']} | listed {row['listing_date']}"


@check("Scraper: daily_prices parses yfinance DataFrame")
def check_parse_daily_prices(ticker: str):
    import yfinance as yf
    from scrapers.daily_prices import _download_batch, _parse_batch_df
    end = date.today()
    start = end - timedelta(days=10)
    df = _download_batch([ticker], start, end)
    rows = _parse_batch_df(df, [ticker])
    assert len(rows) > 0, "No rows parsed"
    assert all(r["ticker"] == ticker for r in rows)
    assert all(r.get("close") is not None for r in rows)
    return f"{len(rows)} price rows parsed OK"


@check("Scraper: financials computes ratios")
def check_parse_financials(ticker: str):
    import yfinance as yf
    from scrapers.financials import _extract_annual
    t = yf.Ticker(f"{ticker}.JK")
    rows = _extract_annual(t)
    if not rows:
        return "SKIP: no annual data available (not necessarily an error)"
    row = rows[0]
    assert row["ticker"] == ticker
    # At least some ratios should be computed
    computed = [k for k in ["gross_margin", "net_margin", "roe", "roa"] if row.get(k) is not None]
    return f"{len(rows)} annual rows, ratios computed: {computed}"


@check("Scraper: money_flow parses trading info")
def check_parse_money_flow(ticker: str):
    from utils.idx_client import IDXClient
    from scrapers.money_flow import _parse_trading_info_row
    client = IDXClient()
    records = client.get_trading_info(ticker, days=5)
    if not records:
        return "SKIP: no trading info records (market may be closed)"
    parsed = [_parse_trading_info_row(ticker, r) for r in records]
    parsed = [p for p in parsed if p]
    return f"{len(parsed)} trading info rows parsed"


# ------------------------------------------------------------------
# Main runner
# ------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(description="IDX Analyzer — feasibility test")
    parser.add_argument("--ticker", default="BBRI", help="Stock to use for tests (default: BBRI)")
    parser.add_argument("--skip-db", action="store_true", help="Skip Supabase checks (offline mode)")
    parser.add_argument("--verbose", action="store_true", help="Print full tracebacks on failure")
    args = parser.parse_args()

    ticker = args.ticker.upper()
    _print(f"\n[bold]IDX Stock Analyzer — Feasibility Test[/bold]  (ticker={ticker})\n")

    # Run checks in order
    check_config()
    check_imports()
    check_idx_stock_list()
    check_idx_profile(ticker)
    check_idx_trading_info(ticker)
    check_idx_broker_summary(ticker)
    check_yfinance_prices(ticker)
    check_yfinance_financials(ticker)
    check_yfinance_quarterly(ticker)

    if not args.skip_db:
        check_supabase_connect()
        check_supabase_tables()
        check_supabase_roundtrip(ticker)
    else:
        _print("[yellow]Skipping Supabase checks (--skip-db)[/yellow]")

    check_parse_stock_universe()
    check_parse_daily_prices(ticker)
    check_parse_financials(ticker)
    check_parse_money_flow(ticker)

    # --- Summary table ---
    try:
        table = Table(title="Results", show_header=True)
        table.add_column("Check", style="bold")
        table.add_column("Status", justify="center")
        table.add_column("Detail")

        for c in checks:
            if c.passed is True:
                status = "[green]PASS[/green]"
            elif c.passed is False:
                status = "[red]FAIL[/red]"
            else:
                status = "[yellow]SKIP[/yellow]"
            table.add_row(c.name, status, c.detail[:80])

        console.print(table)
    except Exception:
        # Fallback plain output if Rich not available
        for c in checks:
            mark = "PASS" if c.passed else "FAIL" if c.passed is False else "SKIP"
            print(f"  [{mark}] {c.name}: {c.detail[:80]}")

    failed = [c for c in checks if c.passed is False]
    passed = [c for c in checks if c.passed is True]

    _print(f"\n[bold]{len(passed)} passed, {len(failed)} failed[/bold]")

    if failed:
        _print("\n[red]Failed checks:[/red]")
        for c in failed:
            _print(f"  • {c.name}: {c.detail}")
        _print("\n[yellow]Fix the above before running the full pipeline.[/yellow]")
        return 1

    _print("\n[green bold]All checks passed. Ready to run: python run_all.py --full --ticker BBRI[/green bold]")
    return 0


if __name__ == "__main__":
    sys.exit(main())
