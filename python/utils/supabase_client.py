from __future__ import annotations

"""
Supabase client wrapper — all database reads and writes go through here.

Design principles:
- Single shared client instance (module-level singleton).
- All writes use UPSERT so scrapers are safe to re-run.
- Bulk operations are chunked to stay within Supabase request size limits.
- Callers pass plain dicts; this module handles serialisation.
"""
import logging
from typing import Any

from supabase import create_client, Client

from config import SUPABASE_URL, SUPABASE_SERVICE_KEY, require_supabase

logger = logging.getLogger(__name__)

# Module-level singleton — initialised on first import
_client: Client | None = None


def get_client() -> Client:
    global _client
    if _client is None:
        require_supabase()  # raises EnvironmentError with a clear message if creds missing
        _client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    return _client


# ------------------------------------------------------------------
# Core write operations
# ------------------------------------------------------------------

def upsert(table: str, rows: list[dict], on_conflict: str) -> int:
    """
    Upsert a batch of rows into a Supabase table.

    Args:
        table:       Table name, e.g. 'stocks'
        rows:        List of row dicts. Keys must match column names.
        on_conflict: Comma-separated column(s) for conflict detection,
                     e.g. 'ticker' or 'ticker,date'

    Returns:
        Number of rows upserted.
    """
    if not rows:
        return 0
    client = get_client()
    client.table(table).upsert(rows, on_conflict=on_conflict).execute()
    logger.debug("upserted %d rows into %s", len(rows), table)
    return len(rows)


def bulk_upsert(
    table: str,
    rows: list[dict],
    on_conflict: str,
    batch_size: int = 500,
) -> int:
    """
    Upsert a large list of rows in chunks to avoid request size limits.

    Returns total number of rows upserted.
    """
    if not rows:
        return 0
    total = 0
    for i in range(0, len(rows), batch_size):
        chunk = rows[i : i + batch_size]
        total += upsert(table, chunk, on_conflict)
        logger.debug("bulk_upsert progress: %d / %d rows", min(i + batch_size, len(rows)), len(rows))
    return total


def delete_where(table: str, column: str, value: Any) -> None:
    """Delete rows matching a single column filter."""
    get_client().table(table).delete().eq(column, value).execute()


# ------------------------------------------------------------------
# Read helpers
# ------------------------------------------------------------------

def fetch_all(table: str, columns: str = "*", filters: dict | None = None) -> list[dict]:
    """
    Fetch all rows from a table, optionally filtered.

    Args:
        table:   Table name
        columns: Comma-separated column names or '*'
        filters: Dict of {column: value} equality filters

    Returns list of row dicts.
    """
    client = get_client()
    query = client.table(table).select(columns)
    if filters:
        for col, val in filters.items():
            query = query.eq(col, val)
    resp = query.execute()
    return resp.data or []


def fetch_column(table: str, column: str, filters: dict | None = None) -> list[Any]:
    """Convenience: fetch a single column as a flat list."""
    rows = fetch_all(table, column, filters)
    return [r[column] for r in rows if column in r]


def fetch_one(table: str, columns: str = "*", filters: dict | None = None) -> dict | None:
    """Fetch first matching row or None."""
    rows = fetch_all(table, columns, filters)
    return rows[0] if rows else None


# ------------------------------------------------------------------
# Scraper run tracking
# ------------------------------------------------------------------

def start_run(scraper_name: str, metadata: dict | None = None) -> int:
    """
    Insert a new scraper_runs record with status='running'.
    Returns the run ID to pass to finish_run().
    """
    from datetime import datetime, timezone
    row = {
        "scraper_name": scraper_name,
        "started_at": datetime.now(timezone.utc).isoformat(),
        "status": "running",
        "metadata": metadata,
    }
    resp = get_client().table("scraper_runs").insert(row).execute()
    run_id: int = resp.data[0]["id"]
    logger.info("Started run %d for scraper '%s'", run_id, scraper_name)
    return run_id


def finish_run(
    run_id: int,
    status: str,
    stocks_processed: int = 0,
    stocks_failed: int = 0,
    stocks_skipped: int = 0,
    error_message: str | None = None,
) -> None:
    """
    Update a scraper_runs record on completion.

    status: 'success' | 'partial' | 'failed'
    """
    from datetime import datetime, timezone
    update = {
        "finished_at": datetime.now(timezone.utc).isoformat(),
        "status": status,
        "stocks_processed": stocks_processed,
        "stocks_failed": stocks_failed,
        "stocks_skipped": stocks_skipped,
        "error_message": error_message,
    }
    get_client().table("scraper_runs").update(update).eq("id", run_id).execute()
    logger.info(
        "Finished run %d: status=%s processed=%d failed=%d skipped=%d",
        run_id, status, stocks_processed, stocks_failed, stocks_skipped,
    )
