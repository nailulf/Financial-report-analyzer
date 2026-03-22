from __future__ import annotations

"""
Central configuration — reads from .env file.
All other modules import from here instead of touching os.environ directly.
"""
import os
import logging
from pathlib import Path
from dotenv import load_dotenv

# Load .env from project root (one level above this file)
_env_path = Path(__file__).parent.parent / ".env"
load_dotenv(_env_path)


# Supabase — read at import time but validated lazily when first used.
# This lets IDX API / yfinance code run without Supabase credentials set.
SUPABASE_URL: str = os.getenv("SUPABASE_URL", "")
SUPABASE_SERVICE_KEY: str = os.getenv("SUPABASE_SERVICE_KEY", "")


def require_supabase() -> None:
    """Call this before any Supabase operation to get a clear error if creds are missing."""
    missing = [k for k, v in [
        ("SUPABASE_URL", SUPABASE_URL),
        ("SUPABASE_SERVICE_KEY", SUPABASE_SERVICE_KEY),
    ] if not v]
    if missing:
        raise EnvironmentError(
            f"Missing required environment variable(s): {missing}. "
            f"Copy .env.example to .env and fill in your Supabase credentials."
        )

# Optional data sources
TWELVE_DATA_API_KEY: str = os.getenv("TWELVE_DATA_API_KEY", "")

# Stockbit (unofficial) — https://stockbit.com
# Login via username/password is no longer supported (requires WebSocket 2FA).
# Instead, copy the Bearer token directly from your browser/app session:
#   1. Open stockbit.com in Chrome, log in
#   2. Open DevTools → Network → any API request → Headers → Authorization
#   3. Copy the token value (without "Bearer ") into .env
# Token typically lasts 30 days. Re-copy when requests start failing 401.
STOCKBIT_BEARER_TOKEN: str = os.getenv("STOCKBIT_BEARER_TOKEN", "")
RATE_LIMIT_STOCKBIT_SECONDS: float = float(os.getenv("RATE_LIMIT_STOCKBIT_SECONDS", "0.8"))

# Logging
LOG_LEVEL: str = os.getenv("LOG_LEVEL", "INFO").upper()

# Paths
ROOT_DIR = Path(__file__).parent.parent
LOGS_DIR = Path(__file__).parent / "logs"
LOGS_DIR.mkdir(exist_ok=True)

# Scraper behaviour
RATE_LIMIT_IDX_SECONDS: float = 0.6       # max ~1.6 req/s to IDX API
RATE_LIMIT_YFINANCE_SECONDS: float = 0.1  # yfinance batch downloads are less strict
YFINANCE_BATCH_SIZE: int = 100            # tickers per yfinance bulk download call
DAILY_PRICE_HISTORY_YEARS: int = 5        # bootstrap history on first run
BROKER_SUMMARY_TOP_N: int = 200           # limit broker scraping to top N by market cap

# IDX API base  (changed from /umbraco/Surface in 2024 site redesign)
IDX_BASE_URL = "https://www.idx.co.id/primary"

# Logging helper used by helpers.py
def get_log_level() -> int:
    return getattr(logging, LOG_LEVEL, logging.INFO)
