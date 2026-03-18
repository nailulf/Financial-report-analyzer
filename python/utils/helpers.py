from __future__ import annotations

"""
Shared utilities: structured logging, retry decorator, scraper result tracking.
"""
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from rich.console import Console
from rich.logging import RichHandler
from rich.table import Table

from config import LOGS_DIR, get_log_level

console = Console()


# ------------------------------------------------------------------
# Logging setup
# ------------------------------------------------------------------

def setup_logging(scraper_name: str) -> logging.Logger:
    """
    Configure logging for a scraper run.
    Writes to both:
      - Console (via RichHandler for pretty output)
      - File: logs/YYYY-MM-DD_<scraper_name>.log

    Returns the root logger (all child loggers inherit it).
    """
    log_file = LOGS_DIR / f"{datetime.now().strftime('%Y-%m-%d')}_{scraper_name}.log"
    level = get_log_level()

    handlers: list[logging.Handler] = [
        RichHandler(console=console, rich_tracebacks=True, show_path=False),
        logging.FileHandler(log_file, encoding="utf-8"),
    ]

    logging.basicConfig(
        level=level,
        format="%(asctime)s [%(name)s] %(levelname)s %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
        handlers=handlers,
        force=True,
    )

    logger = logging.getLogger(scraper_name)
    logger.info("Log file: %s", log_file)
    return logger


# ------------------------------------------------------------------
# Result tracking
# ------------------------------------------------------------------

class RunResult:
    """
    Accumulates per-ticker outcomes during a scraper run.

    Usage:
        result = RunResult("daily_prices")
        result.ok("BBRI")
        result.fail("ASII", "HTTP 503")
        result.skip("BRIS", "already up to date")
        result.print_summary()
    """

    def __init__(self, scraper_name: str):
        self.scraper_name = scraper_name
        self.started_at = datetime.now(timezone.utc)
        self._ok: list[str] = []
        self._failed: list[tuple[str, str]] = []   # (ticker, reason)
        self._skipped: list[tuple[str, str]] = []  # (ticker, reason)

    def ok(self, ticker: str) -> None:
        self._ok.append(ticker)

    def fail(self, ticker: str, reason: str = "") -> None:
        self._failed.append((ticker, reason))
        logging.getLogger(self.scraper_name).warning("FAILED %s: %s", ticker, reason)

    def skip(self, ticker: str, reason: str = "") -> None:
        self._skipped.append((ticker, reason))

    @property
    def n_ok(self) -> int:
        return len(self._ok)

    @property
    def n_failed(self) -> int:
        return len(self._failed)

    @property
    def n_skipped(self) -> int:
        return len(self._skipped)

    @property
    def status(self) -> str:
        if self.n_failed == 0:
            return "success"
        if self.n_ok > 0:
            return "partial"
        return "failed"

    def print_summary(self) -> None:
        """Print a rich summary table to the console."""
        elapsed = (datetime.now(timezone.utc) - self.started_at).total_seconds()

        table = Table(title=f"[bold]{self.scraper_name}[/bold] — Run Summary", show_header=True)
        table.add_column("Outcome", style="bold")
        table.add_column("Count", justify="right")
        table.add_column("Details")

        table.add_row("[green]OK[/green]", str(self.n_ok), "")
        table.add_row(
            "[red]Failed[/red]",
            str(self.n_failed),
            ", ".join(f"{t}: {r}" for t, r in self._failed[:5])
            + ("…" if self.n_failed > 5 else ""),
        )
        table.add_row(
            "[yellow]Skipped[/yellow]",
            str(self.n_skipped),
            "",
        )
        table.add_row("Elapsed", f"{elapsed:.1f}s", "")
        table.add_row("Status", f"[bold]{self.status.upper()}[/bold]", "")

        console.print(table)

        if self._failed:
            console.print("[red]Failed tickers:[/red]")
            for ticker, reason in self._failed:
                console.print(f"  • {ticker}: {reason}")

    def to_db_kwargs(self) -> dict[str, Any]:
        """Return kwargs for supabase_client.finish_run()."""
        return {
            "status": self.status,
            "stocks_processed": self.n_ok,
            "stocks_failed": self.n_failed,
            "stocks_skipped": self.n_skipped,
        }


# ------------------------------------------------------------------
# Data cleaning helpers
# ------------------------------------------------------------------

def safe_int(value: Any) -> int | None:
    """Convert to int, return None if not possible."""
    try:
        return int(value) if value is not None else None
    except (ValueError, TypeError):
        return None


def safe_float(value: Any, decimals: int | None = None) -> float | None:
    """Convert to float, return None if not possible."""
    try:
        if value is None:
            return None
        f = float(value)
        if decimals is not None:
            f = round(f, decimals)
        return f
    except (ValueError, TypeError):
        return None


def safe_str(value: Any) -> str | None:
    """Strip and return string, None if empty."""
    if value is None:
        return None
    s = str(value).strip()
    return s if s else None


def parse_idr_string(value: Any) -> int | None:
    """
    Parse IDR values that may come as strings like '1.234.567' or '1,234,567'.
    Returns integer IDR value or None.
    """
    if value is None:
        return None
    s = str(value).strip().replace(".", "").replace(",", "").replace(" ", "")
    return safe_int(s)


def compute_ratio(
    numerator: Any,
    denominator: Any,
    scale: float = 1.0,
    max_abs: float = 9_999_999.0,
) -> float | None:
    """
    Safely compute numerator/denominator * scale. Returns None on division by zero.
    Values beyond ±max_abs are stored as None (extreme outliers, e.g. near-zero equity).
    """
    n = safe_float(numerator)
    d = safe_float(denominator)
    if n is None or d is None or d == 0:
        return None
    result = (n / d) * scale
    if abs(result) > max_abs:
        return None
    return round(result, 4)
