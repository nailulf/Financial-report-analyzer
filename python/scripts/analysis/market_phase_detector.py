"""
Market Phase Detector — Detect market cycle phases from price/volume data.

Classifies daily price action into four phase types using SMA crossover
and ATR volatility analysis:
  - uptrend:          SMA20 > SMA50, spread > threshold (trending up)
  - downtrend:        SMA20 < SMA50, spread > threshold (trending down)
  - sideways_bullish: SMA20 > SMA50, spread <= threshold (ranging, bullish bias)
  - sideways_bearish: SMA20 < SMA50, spread <= threshold (ranging, bearish bias)

NOTE: This is an MA-based trend indicator, NOT Wyckoff structural analysis.

Three-layer pipeline:
  Layer 1: Daily classification (SMA crossover + ATR + volume)
  Layer 2: Phase merging (consecutive same-type days → single phase)
  Layer 3: Confirmation enrichment (broker flow, bandar signal, insider data)
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from utils.supabase_client import get_client, bulk_upsert, delete_where

logger = logging.getLogger(__name__)

# Phase type constants
UPTREND = "uptrend"
DOWNTREND = "downtrend"
SIDEWAYS_BULLISH = "sideways_bullish"
SIDEWAYS_BEARISH = "sideways_bearish"

PHASE_TYPES = {UPTREND, DOWNTREND, SIDEWAYS_BULLISH, SIDEWAYS_BEARISH}


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

@dataclass
class DetectionParams:
    """Tunable parameters for the detection algorithm."""
    short_ma: int = 20              # Short SMA period
    long_ma: int = 50               # Long SMA period
    atr_period: int = 14            # ATR calculation period
    min_phase_days: int = 8         # Absorb phases shorter than this
    vol_sma_period: int = 20        # Volume SMA period
    vol_spike_threshold: float = 1.8  # Volume spike = volume > volSMA * this
    lookback_days: int = 756        # ~3 years of trading data
    ma_spread_threshold: float = 0.015  # 1.5% spread = trending
    min_avg_volume: int = 100_000   # Liquidity filter: skip if avg vol < this


# ---------------------------------------------------------------------------
# Data containers
# ---------------------------------------------------------------------------

@dataclass
class DayData:
    """One trading day of OHLCV + computed indicators."""
    date: str               # YYYY-MM-DD
    open: float
    high: float
    low: float
    close: float
    volume: int
    # Computed indicators (filled in Layer 1)
    short_sma: Optional[float] = None
    long_sma: Optional[float] = None
    atr: Optional[float] = None
    vol_sma: Optional[float] = None
    classification: Optional[str] = None


@dataclass
class MarketPhase:
    """One detected market phase period."""
    ticker: str
    phase_type: str
    start_date: str
    end_date: str
    days: int = 0
    open_price: int = 0
    close_price: int = 0
    range_low: int = 0
    range_high: int = 0
    change_pct: float = 0.0
    phase_clarity: int = 30
    trend_strength: str = "sideways"
    # Volume statistics (computed during _build_phase)
    avg_volume: float = 0.0
    vol_trend: float = 0.0          # >1 = expanding, <1 = contracting (2nd half / 1st half)
    vol_spike_days: int = 0         # days where volume > vol_sma * threshold
    smart_money_alignment: Optional[int] = None
    broker_flow_alignment: Optional[str] = None
    bandar_signal_mode: Optional[str] = None
    insider_activity: Optional[Dict[str, Any]] = None
    is_current: bool = False


# ---------------------------------------------------------------------------
# Main Detector
# ---------------------------------------------------------------------------

class MarketPhaseDetector:
    """
    Detect market cycle phases for IDX stocks.

    Usage:
        detector = MarketPhaseDetector()
        phases = detector.detect_ticker("BBCA")
        detector.detect_batch(["BBCA", "BBRI", "BMRI"])
    """

    def __init__(self, params: DetectionParams | None = None):
        self.params = params or DetectionParams()

    # =================================================================
    # Public API
    # =================================================================

    def detect_ticker(self, ticker: str, dry_run: bool = False) -> List[MarketPhase]:
        """
        Full pipeline for one ticker:
        1. Fetch daily_prices
        2. Check liquidity filter
        3. Compute indicators + classify each day (Layer 1)
        4. Merge into phases (Layer 2)
        5. Enrich with broker/bandar/insider data (Layer 3)
        6. Score phase clarity
        7. Upsert to market_phases table
        """
        prices = self._fetch_prices(ticker)
        if not prices:
            logger.warning("%s: no price data found, skipping", ticker)
            return []

        # Liquidity filter
        avg_vol = sum(d.volume for d in prices) / len(prices)
        if avg_vol < self.params.min_avg_volume:
            logger.info(
                "%s: avg volume %s < %s threshold, skipping",
                ticker, f"{avg_vol:,.0f}", f"{self.params.min_avg_volume:,}",
            )
            return []

        # Layer 1: Compute indicators + classify
        self._compute_indicators(prices)
        classified = [d for d in prices if d.classification is not None]
        if len(classified) < self.params.min_phase_days:
            logger.warning("%s: only %d classified days, skipping", ticker, len(classified))
            return []

        # Layer 2: Merge into phases
        phases = self._merge_phases(ticker, classified)
        if not phases:
            logger.info("%s: no phases after merging", ticker)
            return []

        # Mark the last phase as current
        phases[-1].is_current = True

        # Layer 3: Enrich with confirmation signals
        self._enrich_phases(ticker, phases)

        # Score phase clarity
        for phase in phases:
            phase.phase_clarity = self._score_phase_clarity(phase)

        # Persist
        if not dry_run:
            self._upsert_phases(ticker, phases)
            logger.info("%s: saved %d phases", ticker, len(phases))
        else:
            logger.info("%s: detected %d phases (dry run, not saved)", ticker, len(phases))

        return phases

    def detect_batch(
        self,
        tickers: List[str] | None = None,
        dry_run: bool = False,
    ) -> Dict[str, int]:
        """
        Batch detection. If tickers=None, processes all active stocks.
        Returns dict of {ticker: phase_count}.
        """
        if tickers is None:
            tickers = self._fetch_active_tickers()

        results: Dict[str, int] = {}
        total = len(tickers)

        for i, ticker in enumerate(tickers, 1):
            try:
                phases = self.detect_ticker(ticker, dry_run=dry_run)
                results[ticker] = len(phases)
                if i % 50 == 0 or i == total:
                    logger.info("Progress: %d / %d tickers processed", i, total)
            except Exception:
                logger.exception("%s: detection failed", ticker)
                results[ticker] = -1

        succeeded = sum(1 for v in results.values() if v >= 0)
        failed = sum(1 for v in results.values() if v < 0)
        logger.info(
            "Batch complete: %d tickers (%d ok, %d failed)",
            total, succeeded, failed,
        )
        return results

    # =================================================================
    # Layer 1: Daily Classification
    # =================================================================

    def _compute_indicators(self, prices: List[DayData]) -> None:
        """Compute SMA, ATR, volume SMA and classify each day in-place."""
        n = len(prices)
        closes = [d.close for d in prices]
        volumes = [d.volume for d in prices]
        p = self.params

        # Compute SMAs
        short_sma = self._sma(closes, p.short_ma)
        long_sma = self._sma(closes, p.long_ma)
        vol_sma = self._sma([float(v) for v in volumes], p.vol_sma_period)

        # Compute ATR
        atrs = self._atr(prices, p.atr_period)

        # Assign indicators
        for i in range(n):
            prices[i].short_sma = short_sma[i]
            prices[i].long_sma = long_sma[i]
            prices[i].vol_sma = vol_sma[i]
            prices[i].atr = atrs[i]

        # Average ATR for the low-volatility override
        valid_atrs = [a for a in atrs if a is not None]
        avg_atr = sum(valid_atrs) / len(valid_atrs) if valid_atrs else 0

        # Classify each day
        for i in range(n):
            d = prices[i]
            if d.short_sma is None or d.long_sma is None:
                continue  # not enough data yet

            ma_spread = abs(d.short_sma - d.long_sma) / d.long_sma if d.long_sma else 0

            # Volume spike detection
            has_vol_spike = (
                d.vol_sma is not None
                and d.vol_sma > 0
                and d.volume > d.vol_sma * p.vol_spike_threshold
            )

            # ATR low-volatility override
            if d.atr is not None and avg_atr > 0 and d.atr < avg_atr * 0.85:
                if d.close < d.long_sma:
                    d.classification = SIDEWAYS_BEARISH
                else:
                    d.classification = SIDEWAYS_BULLISH
            # Standard SMA crossover classification
            elif ma_spread > p.ma_spread_threshold:
                d.classification = UPTREND if d.short_sma > d.long_sma else DOWNTREND
            # Volume-assisted: borderline spread + volume spike = treat as trending
            elif has_vol_spike and ma_spread > p.ma_spread_threshold * 0.6:
                d.classification = UPTREND if d.short_sma > d.long_sma else DOWNTREND
            else:
                # Sideways — bias from SMA relationship
                d.classification = (
                    SIDEWAYS_BULLISH if d.short_sma > d.long_sma
                    else SIDEWAYS_BEARISH
                )

    # =================================================================
    # Layer 2: Phase Merging
    # =================================================================

    def _merge_phases(self, ticker: str, days: List[DayData]) -> List[MarketPhase]:
        """Merge consecutive same-classification days into phases."""
        if not days:
            return []

        raw_phases: List[MarketPhase] = []
        current_type = days[0].classification
        phase_days: List[DayData] = [days[0]]

        for d in days[1:]:
            if d.classification == current_type:
                phase_days.append(d)
            else:
                raw_phases.append(self._build_phase(ticker, current_type, phase_days))
                current_type = d.classification
                phase_days = [d]

        # Final phase
        raw_phases.append(self._build_phase(ticker, current_type, phase_days))

        # Absorb short phases into predecessor
        merged: List[MarketPhase] = []
        for phase in raw_phases:
            if phase.days < self.params.min_phase_days and merged:
                # Extend previous phase to absorb this short one
                prev = merged[-1]
                prev.end_date = phase.end_date
                prev.days = self._trading_days_between(prev.start_date, prev.end_date, len(days))
                prev.close_price = phase.close_price
                prev.range_low = min(prev.range_low, phase.range_low)
                prev.range_high = max(prev.range_high, phase.range_high)
                if prev.open_price:
                    prev.change_pct = round(
                        (prev.close_price - prev.open_price) / prev.open_price * 100, 2
                    )
                prev.trend_strength = self._classify_trend_strength(prev.change_pct)
            else:
                merged.append(phase)

        return merged

    def _build_phase(
        self, ticker: str, phase_type: str, days: List[DayData],
    ) -> MarketPhase:
        """Create a MarketPhase from a list of consecutive days."""
        open_price = int(days[0].open)
        close_price = int(days[-1].close)
        range_low = int(min(d.low for d in days))
        range_high = int(max(d.high for d in days))
        change_pct = round(
            (close_price - open_price) / open_price * 100, 2
        ) if open_price else 0.0

        # Volume statistics
        volumes = [d.volume for d in days if d.volume > 0]
        avg_volume = sum(volumes) / len(volumes) if volumes else 0.0

        # Volume trend: compare 2nd half avg vs 1st half avg
        vol_trend = 1.0
        if len(volumes) >= 4:
            mid = len(volumes) // 2
            first_half = sum(volumes[:mid]) / mid
            second_half = sum(volumes[mid:]) / (len(volumes) - mid)
            vol_trend = round(second_half / first_half, 2) if first_half > 0 else 1.0

        # Count volume spike days (volume > vol_sma * threshold)
        threshold = self.params.vol_spike_threshold
        vol_spike_days = sum(
            1 for d in days
            if d.vol_sma and d.vol_sma > 0 and d.volume > d.vol_sma * threshold
        )

        return MarketPhase(
            ticker=ticker,
            phase_type=phase_type,
            start_date=days[0].date,
            end_date=days[-1].date,
            days=len(days),
            open_price=open_price,
            close_price=close_price,
            range_low=range_low,
            range_high=range_high,
            change_pct=change_pct,
            trend_strength=self._classify_trend_strength(change_pct),
            avg_volume=avg_volume,
            vol_trend=vol_trend,
            vol_spike_days=vol_spike_days,
        )

    # =================================================================
    # Layer 3: Confirmation Enrichment
    # =================================================================

    def _enrich_phases(self, ticker: str, phases: List[MarketPhase]) -> None:
        """Enrich phases with broker flow, bandar signal, and insider data."""
        if not phases:
            return

        overall_start = phases[0].start_date
        overall_end = phases[-1].end_date

        # Fetch all confirmation data in bulk (one query per table)
        broker_flows = self._fetch_broker_flows(ticker, overall_start, overall_end)
        bandar_signals = self._fetch_bandar_signals(ticker, overall_start, overall_end)
        insider_txns = self._fetch_insider_transactions(ticker, overall_start, overall_end)

        has_smart_money = bool(broker_flows or bandar_signals or insider_txns)

        for phase in phases:
            # Broker flow alignment
            phase_flows = [
                f for f in broker_flows
                if phase.start_date <= f["trade_date"] <= phase.end_date
            ]
            if phase_flows:
                net = sum(f.get("type_net_value", 0) or 0 for f in phase_flows)
                phase.broker_flow_alignment = self._assess_flow_alignment(
                    phase.phase_type, net,
                )
            else:
                phase.broker_flow_alignment = None

            # Bandar signal mode
            phase_signals = [
                s for s in bandar_signals
                if phase.start_date <= s["trade_date"] <= phase.end_date
            ]
            if phase_signals:
                modes = [s["broker_accdist"] for s in phase_signals if s.get("broker_accdist")]
                phase.bandar_signal_mode = self._mode(modes) if modes else None
            else:
                phase.bandar_signal_mode = None

            # Insider activity
            phase_insiders = [
                t for t in insider_txns
                if phase.start_date <= t["transaction_date"] <= phase.end_date
            ]
            if phase_insiders:
                buys = sum(1 for t in phase_insiders if t.get("action") == "BUY")
                sells = sum(1 for t in phase_insiders if t.get("action") == "SELL")
                net_shares = sum(t.get("share_change", 0) or 0 for t in phase_insiders)
                phase.insider_activity = {
                    "buys": buys, "sells": sells, "net_shares": net_shares,
                }
            else:
                phase.insider_activity = None

            # Smart money alignment score (only if data exists)
            if has_smart_money:
                phase.smart_money_alignment = self._score_smart_money_alignment(phase)

    # =================================================================
    # Phase Clarity Scoring (price + volume only, all tickers)
    # =================================================================

    def _score_phase_clarity(self, phase: MarketPhase) -> int:
        """
        Score 0-100 based on price/volume signals only.
        Separate from smart_money_alignment to avoid penalizing
        tickers without broker/bandar data.

        Factors:
          - Duration:              max 30 pts
          - Trend alignment:       max 25 pts
          - Price consistency:     max 25 pts
          - Volume confirmation:   max 20 pts
        """
        score = 0

        # 1. Duration (max 30)
        d = phase.days
        if d >= 60:
            score += 30
        elif d >= 40:
            score += 22
        elif d >= 20:
            score += 14
        elif d >= 10:
            score += 7
        else:
            score += 3

        # 2. Trend alignment (max 25)
        # For trending phases: larger |change| = more confident
        # For sideways phases: smaller |change| = more confident
        abs_change = abs(phase.change_pct)
        if phase.phase_type in (UPTREND, DOWNTREND):
            if abs_change > 20:
                score += 25
            elif abs_change > 10:
                score += 18
            elif abs_change > 5:
                score += 10
            else:
                score += 3
        else:  # sideways
            if abs_change < 5:
                score += 20
            elif abs_change < 10:
                score += 12
            else:
                score += 3

        # 3. Price consistency — direction matches type (max 25)
        if phase.phase_type == UPTREND and phase.change_pct > 0:
            score += 25
        elif phase.phase_type == DOWNTREND and phase.change_pct < 0:
            score += 25
        elif phase.phase_type in (SIDEWAYS_BULLISH, SIDEWAYS_BEARISH):
            score += 15  # sideways is inherently less directional
        else:
            score += 5  # type says up but price went down → low confidence

        # 4. Volume confirmation (max 20)
        # Trending phases: expanding volume confirms the trend
        # Sideways phases: contracting volume confirms consolidation
        vol_pts = 0
        if phase.phase_type in (UPTREND, DOWNTREND):
            # Expanding volume (2nd half > 1st half) confirms trend
            if phase.vol_trend >= 1.2:
                vol_pts = 15
            elif phase.vol_trend >= 1.0:
                vol_pts = 8
            else:
                vol_pts = 2  # contracting volume in a trend = weak
            # Volume spike days add conviction
            spike_ratio = phase.vol_spike_days / max(phase.days, 1)
            if spike_ratio > 0.15:
                vol_pts = min(vol_pts + 5, 20)
        else:  # sideways
            # Contracting volume confirms consolidation
            if phase.vol_trend <= 0.85:
                vol_pts = 15
            elif phase.vol_trend <= 1.0:
                vol_pts = 10
            else:
                vol_pts = 3  # expanding volume in sideways = unstable
        score += vol_pts

        return min(max(score, 15), 100)  # floor 15, cap 100

    def _score_smart_money_alignment(self, phase: MarketPhase) -> int:
        """
        Score 0-100 based on broker flow, bandar signal, insider data.
        Only called when at least some smart money data exists.
        """
        score = 0

        # Broker flow alignment (max 40)
        if phase.broker_flow_alignment == "confirms":
            score += 40
        elif phase.broker_flow_alignment == "neutral":
            score += 10
        # contradicts or None: 0

        # Bandar signal confirmation (max 35)
        if phase.bandar_signal_mode:
            bullish_signals = {"Big Acc", "Acc"}
            bearish_signals = {"Big Dist", "Dist"}

            if phase.phase_type in (UPTREND, SIDEWAYS_BULLISH):
                if phase.bandar_signal_mode in bullish_signals:
                    score += 35
                elif phase.bandar_signal_mode in bearish_signals:
                    score += 0
                else:
                    score += 15
            elif phase.phase_type in (DOWNTREND, SIDEWAYS_BEARISH):
                if phase.bandar_signal_mode in bearish_signals:
                    score += 35
                elif phase.bandar_signal_mode in bullish_signals:
                    score += 0
                else:
                    score += 15

        # Insider activity (max 25)
        if phase.insider_activity:
            buys = phase.insider_activity.get("buys", 0)
            sells = phase.insider_activity.get("sells", 0)
            if phase.phase_type in (UPTREND, SIDEWAYS_BULLISH) and buys > sells:
                score += 25
            elif phase.phase_type in (DOWNTREND, SIDEWAYS_BEARISH) and sells > buys:
                score += 25
            elif buys > 0 or sells > 0:
                score += 8  # activity exists but doesn't confirm

        return min(score, 100)

    # =================================================================
    # Data Fetching
    # =================================================================

    def _fetch_prices(self, ticker: str) -> List[DayData]:
        """Fetch OHLCV data from daily_prices table."""
        client = get_client()
        cutoff = (date.today() - timedelta(days=self.params.lookback_days)).isoformat()

        resp = (
            client.table("daily_prices")
            .select("date, open, high, low, close, volume")
            .eq("ticker", ticker)
            .gte("date", cutoff)
            .order("date")
            .execute()
        )
        rows = resp.data or []
        return [
            DayData(
                date=r["date"],
                open=float(r["open"] or 0),
                high=float(r["high"] or 0),
                low=float(r["low"] or 0),
                close=float(r["close"] or 0),
                volume=int(r["volume"] or 0),
            )
            for r in rows
            if r.get("close")  # skip days with no close price
        ]

    def _fetch_active_tickers(self) -> List[str]:
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

    def _fetch_broker_flows(
        self, ticker: str, start: str, end: str,
    ) -> List[Dict[str, Any]]:
        """Fetch aggregated broker flow data for a ticker within date range."""
        client = get_client()
        try:
            resp = (
                client.table("broker_flow")
                .select("trade_date, broker_type, net_value")
                .eq("ticker", ticker)
                .gte("trade_date", start)
                .lte("trade_date", end)
                .execute()
            )
            rows = resp.data or []
            # Aggregate net_value by trade_date
            aggregated: Dict[str, float] = {}
            for r in rows:
                td = r["trade_date"]
                aggregated[td] = aggregated.get(td, 0) + (r.get("net_value") or 0)
            return [
                {"trade_date": td, "type_net_value": v}
                for td, v in aggregated.items()
            ]
        except Exception:
            logger.debug("%s: broker_flow query failed, skipping", ticker)
            return []

    def _fetch_bandar_signals(
        self, ticker: str, start: str, end: str,
    ) -> List[Dict[str, Any]]:
        """Fetch bandar_signal rows for a ticker within date range."""
        client = get_client()
        try:
            resp = (
                client.table("bandar_signal")
                .select("trade_date, broker_accdist")
                .eq("ticker", ticker)
                .gte("trade_date", start)
                .lte("trade_date", end)
                .execute()
            )
            return resp.data or []
        except Exception:
            logger.debug("%s: bandar_signal query failed, skipping", ticker)
            return []

    def _fetch_insider_transactions(
        self, ticker: str, start: str, end: str,
    ) -> List[Dict[str, Any]]:
        """Fetch insider transaction rows for a ticker within date range."""
        client = get_client()
        try:
            resp = (
                client.table("insider_transactions")
                .select("transaction_date, action, share_change")
                .eq("ticker", ticker)
                .gte("transaction_date", start)
                .lte("transaction_date", end)
                .execute()
            )
            return resp.data or []
        except Exception:
            logger.debug("%s: insider_transactions query failed, skipping", ticker)
            return []

    # =================================================================
    # Persistence
    # =================================================================

    def _upsert_phases(self, ticker: str, phases: List[MarketPhase]) -> None:
        """DELETE + INSERT all phases for a ticker in one transaction."""
        import json

        # Delete existing phases for this ticker
        delete_where("market_phases", "ticker", ticker)

        # Build rows
        rows = []
        for p in phases:
            rows.append({
                "ticker": p.ticker,
                "phase_type": p.phase_type,
                "start_date": p.start_date,
                "end_date": p.end_date,
                "days": p.days,
                "open_price": p.open_price,
                "close_price": p.close_price,
                "range_low": p.range_low,
                "range_high": p.range_high,
                "change_pct": p.change_pct,
                "phase_clarity": p.phase_clarity,
                "trend_strength": p.trend_strength,
                "smart_money_alignment": p.smart_money_alignment,
                "broker_flow_alignment": p.broker_flow_alignment,
                "bandar_signal_mode": p.bandar_signal_mode,
                "insider_activity": json.dumps(p.insider_activity) if p.insider_activity else None,
                "is_current": p.is_current,
                "detection_version": "1.0",
                "detected_at": datetime.now(timezone.utc).isoformat(),
            })

        if rows:
            bulk_upsert("market_phases", rows, on_conflict="ticker,start_date")

        # Denormalize current phase onto stocks table for screener display
        current = next((p for p in phases if p.is_current), None)
        if current:
            get_client().table("stocks").update({
                "current_phase": current.phase_type,
                "current_phase_clarity": current.phase_clarity,
                "current_phase_days": current.days,
            }).eq("ticker", ticker).execute()

    # =================================================================
    # Helpers
    # =================================================================

    @staticmethod
    def _sma(values: List[float], period: int) -> List[Optional[float]]:
        """Simple Moving Average. Returns None for indices < period-1."""
        result: List[Optional[float]] = [None] * len(values)
        if len(values) < period:
            return result
        window_sum = sum(values[:period])
        result[period - 1] = window_sum / period
        for i in range(period, len(values)):
            window_sum += values[i] - values[i - period]
            result[i] = window_sum / period
        return result

    @staticmethod
    def _atr(prices: List[DayData], period: int) -> List[Optional[float]]:
        """Average True Range."""
        n = len(prices)
        result: List[Optional[float]] = [None] * n
        if n < 2:
            return result

        trs: List[float] = []
        for i in range(1, n):
            h = prices[i].high
            l = prices[i].low
            pc = prices[i - 1].close
            tr = max(h - l, abs(h - pc), abs(l - pc))
            trs.append(tr)

        if len(trs) < period:
            return result

        # Initial ATR = mean of first `period` TRs
        atr_val = sum(trs[:period]) / period
        result[period] = atr_val  # offset by 1 because trs starts at index 1

        # Smoothed ATR
        for i in range(period, len(trs)):
            atr_val = (atr_val * (period - 1) + trs[i]) / period
            result[i + 1] = atr_val  # +1 for the offset

        return result

    @staticmethod
    def _mode(items: List[str]) -> Optional[str]:
        """Return the most frequent item in a list."""
        if not items:
            return None
        counts: Dict[str, int] = {}
        for item in items:
            counts[item] = counts.get(item, 0) + 1
        return max(counts, key=counts.get)  # type: ignore[arg-type]

    @staticmethod
    def _classify_trend_strength(change_pct: float) -> str:
        """Classify trend strength from price change percentage."""
        abs_change = abs(change_pct)
        if abs_change > 15:
            return "strong"
        elif abs_change > 5:
            return "weak"
        return "sideways"

    @staticmethod
    def _assess_flow_alignment(phase_type: str, net_flow: float) -> str:
        """Assess whether net broker flow confirms or contradicts the phase type."""
        if abs(net_flow) < 1_000_000:  # less than 1M IDR = negligible
            return "neutral"

        flow_positive = net_flow > 0
        if phase_type in (UPTREND, SIDEWAYS_BULLISH):
            return "confirms" if flow_positive else "contradicts"
        elif phase_type in (DOWNTREND, SIDEWAYS_BEARISH):
            return "confirms" if not flow_positive else "contradicts"
        return "neutral"

    @staticmethod
    def _trading_days_between(start: str, end: str, total_days: int) -> int:
        """Estimate trading days between two dates."""
        d1 = date.fromisoformat(start)
        d2 = date.fromisoformat(end)
        calendar_days = (d2 - d1).days + 1
        # Rough estimate: ~5/7 of calendar days are trading days
        return max(1, round(calendar_days * 5 / 7))
