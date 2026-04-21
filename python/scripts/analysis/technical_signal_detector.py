"""
Technical Signal Detector — Compute MACD, RSI, and volume change indicators.

Pre-computes technical analysis indicators from daily_prices data and stores
them in the technical_signals table. Denormalizes latest values to the stocks
table for screener filtering.

Indicators:
  - RSI (14-period Wilder's smoothed)
  - MACD (12, 26, 9) with golden/death cross detection
  - Volume change vs 20-day average

Designed for rebound detection screener:
  MACD golden cross + RSI 35-60 + volume spike → price rebound signal.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Dict, List, Optional, Tuple

from utils.supabase_client import get_client, bulk_upsert

logger = logging.getLogger(__name__)

# Cross signal constants
GOLDEN_CROSS = "golden_cross"
DEATH_CROSS = "death_cross"
NO_CROSS = "none"


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

@dataclass
class SignalParams:
    """Tunable parameters for technical signal computation."""
    rsi_period: int = 14
    macd_short: int = 5
    macd_long: int = 20
    macd_signal: int = 9
    volume_sma_period: int = 20
    lookback_days: int = 400        # ~1.5 years: enough for EMA warmup + output
    min_data_days: int = 50         # need at least this many days to compute


# ---------------------------------------------------------------------------
# Main Detector
# ---------------------------------------------------------------------------

class TechnicalSignalDetector:
    """
    Compute technical indicators for IDX stocks.

    Usage:
        detector = TechnicalSignalDetector()
        n = detector.compute_ticker("BBCA")
        results = detector.compute_batch(["BBCA", "BBRI"])
    """

    def __init__(self, params: SignalParams | None = None):
        self.params = params or SignalParams()

    # =================================================================
    # Public API
    # =================================================================

    def compute_ticker(self, ticker: str, dry_run: bool = False) -> int:
        """
        Full pipeline for one ticker:
        1. Fetch daily_prices
        2. Compute RSI, MACD, volume change for each day
        3. Upsert to technical_signals table
        4. Detect MACD cross
        5. Denormalize latest values to stocks table
        Returns number of signal rows written.
        """
        prices = self._fetch_prices(ticker)
        if len(prices) < self.params.min_data_days:
            logger.info(
                "%s: only %d price days (need %d), skipping",
                ticker, len(prices), self.params.min_data_days,
            )
            return 0

        closes = [p["close"] for p in prices]
        volumes = [p["volume"] for p in prices]
        dates = [p["date"] for p in prices]

        # Compute indicators
        rsi_values = self._rsi(closes, self.params.rsi_period)
        macd_line, macd_signal, macd_hist = self._macd(
            closes, self.params.macd_short, self.params.macd_long, self.params.macd_signal,
        )
        vol_sma, vol_change = self._volume_change(volumes, self.params.volume_sma_period)

        # Build rows — only where ALL indicators are available
        rows: list[dict] = []
        for i in range(len(dates)):
            if (
                rsi_values[i] is None
                or macd_line[i] is None
                or macd_signal[i] is None
                or macd_hist[i] is None
                or vol_sma[i] is None
            ):
                continue

            vol_chg = None
            if vol_sma[i] and vol_sma[i] > 0:
                vol_chg = round(volumes[i] / vol_sma[i] * 100, 2)

            rows.append({
                "ticker": ticker,
                "date": dates[i],
                "rsi_14": round(rsi_values[i], 2),
                "macd_line": round(macd_line[i], 4),
                "macd_signal": round(macd_signal[i], 4),
                "macd_histogram": round(macd_hist[i], 4),
                "volume_sma_20": int(vol_sma[i]),
                "volume_change_pct": vol_chg,
                "computed_at": datetime.now(timezone.utc).isoformat(),
            })

        if not rows:
            logger.warning("%s: no complete signal rows produced", ticker)
            return 0

        # Detect MACD cross from histogram
        hist_series = [r["macd_histogram"] for r in rows]
        cross_signal, cross_days = self._detect_macd_cross(hist_series)

        # Persist
        if not dry_run:
            bulk_upsert("technical_signals", rows, on_conflict="ticker,date")

            # Denormalize latest values to stocks table
            latest = rows[-1]
            self._denormalize_to_stocks(
                ticker, latest, cross_signal, cross_days,
            )
            logger.info(
                "%s: saved %d signal rows (RSI=%.1f, MACD hist=%.4f, cross=%s %s)",
                ticker, len(rows),
                latest["rsi_14"], latest["macd_histogram"],
                cross_signal,
                f"{cross_days}d ago" if cross_days is not None else "",
            )
        else:
            latest = rows[-1]
            logger.info(
                "%s: %d signal rows (dry run) — RSI=%.1f, MACD hist=%.4f, cross=%s",
                ticker, len(rows),
                latest["rsi_14"], latest["macd_histogram"], cross_signal,
            )

        return len(rows)

    def compute_batch(
        self,
        tickers: list[str] | None = None,
        dry_run: bool = False,
    ) -> dict[str, int]:
        """
        Batch computation. If tickers=None, processes all active stocks.
        Returns dict of {ticker: rows_written}. Negative values indicate failure.
        """
        if tickers is None:
            tickers = self._fetch_active_tickers()

        results: dict[str, int] = {}
        total = len(tickers)

        for i, ticker in enumerate(tickers, 1):
            try:
                n = self.compute_ticker(ticker, dry_run=dry_run)
                results[ticker] = n
                if i % 50 == 0 or i == total:
                    logger.info("Progress: %d / %d tickers processed", i, total)
            except Exception:
                logger.exception("%s: signal computation failed", ticker)
                results[ticker] = -1

        succeeded = sum(1 for v in results.values() if v >= 0)
        failed = sum(1 for v in results.values() if v < 0)
        logger.info(
            "Batch complete: %d tickers (%d ok, %d failed)",
            total, succeeded, failed,
        )
        return results

    # =================================================================
    # Indicator Computation (pure math, no DB)
    # =================================================================

    @staticmethod
    def _ema(values: list[float], period: int) -> list[Optional[float]]:
        """
        Exponential Moving Average.
        First EMA is the SMA of the first `period` values.
        Returns None for indices < period-1.
        """
        result: list[Optional[float]] = [None] * len(values)
        if len(values) < period:
            return result

        # Seed with SMA
        sma = sum(values[:period]) / period
        result[period - 1] = sma

        k = 2.0 / (period + 1)
        prev = sma
        for i in range(period, len(values)):
            ema_val = values[i] * k + prev * (1 - k)
            result[i] = ema_val
            prev = ema_val

        return result

    @staticmethod
    def _rsi(closes: list[float], period: int = 14) -> list[Optional[float]]:
        """
        Wilder's RSI.
        Uses smoothed average gains/losses (Wilder's method, not simple average).
        Returns None for indices where RSI cannot be computed.
        """
        result: list[Optional[float]] = [None] * len(closes)
        if len(closes) < period + 1:
            return result

        # Calculate price changes
        changes = [closes[i] - closes[i - 1] for i in range(1, len(closes))]

        # Initial averages (simple average of first `period` changes)
        gains = [max(c, 0) for c in changes[:period]]
        losses = [abs(min(c, 0)) for c in changes[:period]]
        avg_gain = sum(gains) / period
        avg_loss = sum(losses) / period

        # First RSI
        if avg_loss == 0:
            result[period] = 100.0
        else:
            rs = avg_gain / avg_loss
            result[period] = 100.0 - 100.0 / (1.0 + rs)

        # Subsequent values using Wilder's smoothing
        for i in range(period, len(changes)):
            change = changes[i]
            gain = max(change, 0)
            loss = abs(min(change, 0))

            avg_gain = (avg_gain * (period - 1) + gain) / period
            avg_loss = (avg_loss * (period - 1) + loss) / period

            if avg_loss == 0:
                result[i + 1] = 100.0
            else:
                rs = avg_gain / avg_loss
                result[i + 1] = 100.0 - 100.0 / (1.0 + rs)

        return result

    @staticmethod
    def _macd(
        closes: list[float],
        short_period: int = 12,
        long_period: int = 26,
        signal_period: int = 9,
    ) -> Tuple[list[Optional[float]], list[Optional[float]], list[Optional[float]]]:
        """
        MACD indicator.
        Returns (macd_line, macd_signal, macd_histogram) as parallel lists.
        """
        ema_short = TechnicalSignalDetector._ema(closes, short_period)
        ema_long = TechnicalSignalDetector._ema(closes, long_period)

        # MACD line = EMA(short) - EMA(long)
        macd_line: list[Optional[float]] = [None] * len(closes)
        for i in range(len(closes)):
            if ema_short[i] is not None and ema_long[i] is not None:
                macd_line[i] = ema_short[i] - ema_long[i]

        # Signal line = EMA(signal_period) of MACD line
        # Extract non-None MACD values for EMA computation
        macd_vals: list[float] = []
        macd_start_idx = -1
        for i, v in enumerate(macd_line):
            if v is not None:
                if macd_start_idx < 0:
                    macd_start_idx = i
                macd_vals.append(v)

        signal_ema = TechnicalSignalDetector._ema(macd_vals, signal_period)

        # Map signal EMA back to original indices
        macd_signal: list[Optional[float]] = [None] * len(closes)
        for j, val in enumerate(signal_ema):
            if val is not None:
                macd_signal[macd_start_idx + j] = val

        # Histogram = MACD line - Signal line
        macd_hist: list[Optional[float]] = [None] * len(closes)
        for i in range(len(closes)):
            if macd_line[i] is not None and macd_signal[i] is not None:
                macd_hist[i] = macd_line[i] - macd_signal[i]

        return macd_line, macd_signal, macd_hist

    @staticmethod
    def _volume_change(
        volumes: list[int], sma_period: int = 20,
    ) -> Tuple[list[Optional[float]], list[Optional[float]]]:
        """
        Volume vs SMA(20) as percentage.
        Returns (volume_sma_20, volume_change_pct) as parallel lists.
        volume_change_pct = (volume / volume_sma_20) * 100.
        100 = average, 200 = 2x average.
        """
        floats = [float(v) for v in volumes]
        vol_sma: list[Optional[float]] = [None] * len(volumes)
        vol_change: list[Optional[float]] = [None] * len(volumes)

        if len(volumes) < sma_period:
            return vol_sma, vol_change

        # SMA
        window_sum = sum(floats[:sma_period])
        vol_sma[sma_period - 1] = window_sum / sma_period
        for i in range(sma_period, len(volumes)):
            window_sum += floats[i] - floats[i - sma_period]
            vol_sma[i] = window_sum / sma_period

        # Change percentage
        for i in range(len(volumes)):
            if vol_sma[i] is not None and vol_sma[i] > 0:
                vol_change[i] = round(volumes[i] / vol_sma[i] * 100, 2)

        return vol_sma, vol_change

    # =================================================================
    # Cross Detection
    # =================================================================

    @staticmethod
    def _detect_macd_cross(
        histogram: list[float],
    ) -> Tuple[str, Optional[int]]:
        """
        Scan histogram backwards to find most recent sign change.
        Returns (signal, days_ago):
          - ('golden_cross', N) if last sign change was neg->pos, N days ago
          - ('death_cross', N)  if last sign change was pos->neg, N days ago
          - ('none', None)      if no cross detected
        """
        if len(histogram) < 2:
            return NO_CROSS, None

        for i in range(len(histogram) - 1, 0, -1):
            curr = histogram[i]
            prev = histogram[i - 1]

            # Skip zero values
            if curr == 0 or prev == 0:
                continue

            if curr > 0 and prev < 0:
                days_ago = len(histogram) - 1 - i
                return GOLDEN_CROSS, days_ago

            if curr < 0 and prev > 0:
                days_ago = len(histogram) - 1 - i
                return DEATH_CROSS, days_ago

        return NO_CROSS, None

    # =================================================================
    # Data Fetching
    # =================================================================

    def _fetch_prices(self, ticker: str) -> list[dict]:
        """Fetch OHLCV data from daily_prices table."""
        client = get_client()
        cutoff = (date.today() - timedelta(days=self.params.lookback_days)).isoformat()

        resp = (
            client.table("daily_prices")
            .select("date, close, volume")
            .eq("ticker", ticker)
            .gte("date", cutoff)
            .order("date")
            .execute()
        )
        rows = resp.data or []
        return [
            {
                "date": r["date"],
                "close": float(r["close"]),
                "volume": int(r["volume"] or 0),
            }
            for r in rows
            if r.get("close")
        ]

    def _fetch_active_tickers(self) -> list[str]:
        """Fetch all active tickers from stocks table."""
        client = get_client()
        resp = (
            client.table("stocks")
            .select("ticker")
            .eq("status", "Active")
            .order("ticker")
            .execute()
        )
        return [r["ticker"] for r in (resp.data or [])]

    # =================================================================
    # Persistence
    # =================================================================

    def _denormalize_to_stocks(
        self,
        ticker: str,
        latest: dict,
        cross_signal: str,
        cross_days: Optional[int],
    ) -> None:
        """Write latest signal values to stocks table for screener filtering."""
        get_client().table("stocks").update({
            "rsi_14": latest["rsi_14"],
            "macd_histogram": latest["macd_histogram"],
            "macd_cross_signal": cross_signal,
            "macd_cross_days_ago": cross_days,
            "volume_change_pct": latest["volume_change_pct"],
            "volume_avg_20d": latest["volume_sma_20"],
        }).eq("ticker", ticker).execute()
