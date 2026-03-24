from __future__ import annotations

"""
token_manager.py — Stockbit bearer token lifecycle manager.

Replaces the old workflow of manually pasting a token into .env.
Token is cached in a local file (~/.stockbit_token) with automatic
JWT expiry detection and interactive re-prompt when needed.

Resolution order:
  1. Cached file  (~/.stockbit_token)  — checked for expiry
  2. Environment   (STOCKBIT_BEARER_TOKEN in .env)  — migration path
  3. Interactive    prompt with browser instructions

Usage:
    from utils.token_manager import get_stockbit_token
    token = get_stockbit_token()          # returns str or None (non-interactive)
    token = get_stockbit_token(prompt=True)  # prompts if missing/expired
"""

import base64
import json
import logging
import os
import sys
import time
from pathlib import Path

logger = logging.getLogger(__name__)

_TOKEN_FILE = Path.home() / ".stockbit_token"
_ENV_KEY = "STOCKBIT_BEARER_TOKEN"

# Buffer: treat token as expired 1 hour before actual expiry
_EXPIRY_BUFFER_SECONDS = 3600


# ------------------------------------------------------------------
# JWT helpers (no external library needed)
# ------------------------------------------------------------------

def _decode_jwt_payload(token: str) -> dict:
    """Decode the payload (2nd segment) of a JWT without verification."""
    try:
        parts = token.split(".")
        if len(parts) != 3:
            return {}
        payload_b64 = parts[1]
        # Add padding
        padding = 4 - len(payload_b64) % 4
        if padding != 4:
            payload_b64 += "=" * padding
        payload_bytes = base64.urlsafe_b64decode(payload_b64)
        return json.loads(payload_bytes)
    except Exception:
        return {}


def _token_expiry(token: str) -> float | None:
    """Return the Unix timestamp when this JWT expires, or None if unknown."""
    payload = _decode_jwt_payload(token)
    exp = payload.get("exp")
    return float(exp) if exp else None


def _is_expired(token: str) -> bool:
    """True if the token is expired (or will expire within the buffer window)."""
    exp = _token_expiry(token)
    if exp is None:
        return False  # can't determine — assume valid
    return time.time() >= (exp - _EXPIRY_BUFFER_SECONDS)


def _days_until_expiry(token: str) -> float | None:
    """Return days until expiry, or None if unknown."""
    exp = _token_expiry(token)
    if exp is None:
        return None
    return (exp - time.time()) / 86400


# ------------------------------------------------------------------
# File cache
# ------------------------------------------------------------------

def _read_cached_token() -> str | None:
    """Read token from the cache file, return None if missing or empty."""
    try:
        if _TOKEN_FILE.exists():
            token = _TOKEN_FILE.read_text().strip()
            return token if token else None
    except Exception as e:
        logger.debug("Could not read token file %s: %s", _TOKEN_FILE, e)
    return None


def _save_token(token: str) -> None:
    """Save token to cache file with restrictive permissions."""
    try:
        _TOKEN_FILE.write_text(token.strip() + "\n")
        _TOKEN_FILE.chmod(0o600)  # owner read/write only
        logger.info("Stockbit token saved to %s", _TOKEN_FILE)
    except Exception as e:
        logger.warning("Could not save token to %s: %s", _TOKEN_FILE, e)


# ------------------------------------------------------------------
# Interactive prompt
# ------------------------------------------------------------------

_INSTRUCTIONS = """
┌─────────────────────────────────────────────────────────────┐
│             Stockbit Bearer Token Required                  │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. Open  https://stockbit.com  in Chrome                   │
│  2. Log in to your account                                  │
│  3. Open DevTools  (F12 / Cmd+Opt+I)                        │
│  4. Go to  Network  tab                                     │
│  5. Click any request → Headers → Authorization             │
│  6. Copy the token value  (without "Bearer " prefix)        │
│                                                             │
│  Token lasts ~30 days. You'll be prompted again when        │
│  it expires.                                                │
│                                                             │
│  Press Enter with no input to skip (public endpoints only). │
└─────────────────────────────────────────────────────────────┘
"""


def _prompt_for_token() -> str | None:
    """Show instructions and prompt user for a token. Returns None if skipped."""
    if not sys.stdin.isatty():
        logger.warning(
            "Stockbit token missing/expired and stdin is not a terminal — "
            "cannot prompt interactively. Set %s in .env or save to %s",
            _ENV_KEY, _TOKEN_FILE,
        )
        return None

    print(_INSTRUCTIONS)
    try:
        raw = input("Paste token: ").strip()
    except (EOFError, KeyboardInterrupt):
        print()
        return None

    if not raw:
        print("  → Skipped. Only public Stockbit endpoints will be available.\n")
        return None

    # Strip "Bearer " prefix if user included it
    if raw.lower().startswith("bearer "):
        raw = raw[7:].strip()

    # Validate: should look like a JWT (3 dot-separated segments)
    if raw.count(".") != 2:
        print("  ⚠ Warning: this doesn't look like a JWT token, but saving anyway.\n")

    # Check expiry
    days = _days_until_expiry(raw)
    if days is not None:
        if days <= 0:
            print(f"  ⚠ This token is already expired! Please get a fresh one.\n")
            return None
        print(f"  ✓ Token valid — expires in {days:.0f} days.\n")

    _save_token(raw)
    return raw


# ------------------------------------------------------------------
# Public API
# ------------------------------------------------------------------

def get_stockbit_token(prompt: bool = True) -> str | None:
    """
    Resolve a valid Stockbit bearer token.

    Resolution order:
      1. Cached file (~/.stockbit_token)
      2. STOCKBIT_BEARER_TOKEN env var (backward compat / CI)
      3. Interactive prompt (if prompt=True and stdin is a TTY)

    Returns the token string, or None if unavailable.
    """
    # 1. Try cached file
    token = _read_cached_token()
    if token:
        if not _is_expired(token):
            days = _days_until_expiry(token)
            if days is not None and days < 7:
                logger.warning("Stockbit token expires in %.0f days — consider refreshing soon", days)
            return token
        else:
            logger.warning("Cached Stockbit token has expired.")
            token = None  # fall through to prompt

    # 2. Try env var (backward compat)
    env_token = os.getenv(_ENV_KEY, "").strip()
    if env_token:
        if not _is_expired(env_token):
            # Migrate: save to file for next time
            logger.info("Migrating Stockbit token from .env to %s", _TOKEN_FILE)
            _save_token(env_token)
            return env_token
        else:
            logger.warning("Stockbit token from .env has expired.")

    # 3. Interactive prompt
    if prompt:
        return _prompt_for_token()

    return None


def clear_cached_token() -> None:
    """Remove the cached token file (e.g., after a 401 error)."""
    try:
        if _TOKEN_FILE.exists():
            _TOKEN_FILE.unlink()
            logger.info("Removed cached token at %s", _TOKEN_FILE)
    except Exception as e:
        logger.warning("Could not remove token file: %s", e)
