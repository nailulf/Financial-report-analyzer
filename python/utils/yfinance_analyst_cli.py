"""
yfinance_analyst_cli.py — Fetch analyst ratings/recommendations for an IDX ticker.

Usage:
    python utils/yfinance_analyst_cli.py --ticker BBRI

Outputs JSON to stdout. Appends .JK suffix automatically.
"""
from __future__ import annotations

import argparse
import json
import sys

import yfinance as yf


def fetch_analyst_data(ticker: str) -> dict:
    """Fetch analyst consensus, price targets, and recommendations from yfinance."""
    symbol = f"{ticker.upper()}.JK"
    stock = yf.Ticker(symbol)

    result: dict = {"ticker": ticker.upper(), "symbol": symbol}

    # -- Basic info (target price, recommendation, analyst count) --
    try:
        info = stock.info or {}
        result["current_price"] = info.get("currentPrice") or info.get("regularMarketPrice")
        result["target_high"] = info.get("targetHighPrice")
        result["target_low"] = info.get("targetLowPrice")
        result["target_mean"] = info.get("targetMeanPrice")
        result["target_median"] = info.get("targetMedianPrice")
        result["recommendation_key"] = info.get("recommendationKey")  # e.g. "buy", "hold"
        result["recommendation_mean"] = info.get("recommendationMean")  # 1=strong buy .. 5=sell
        result["number_of_analysts"] = info.get("numberOfAnalystOpinions")
    except Exception:
        pass

    # -- Recommendations summary (monthly breakdown: strongBuy/buy/hold/sell/strongSell) --
    try:
        rec_summary = stock.recommendations_summary
        if rec_summary is not None and not rec_summary.empty:
            rows = []
            for _, row in rec_summary.iterrows():
                rows.append({
                    "period": row.get("period", ""),
                    "strongBuy": int(row.get("strongBuy", 0)),
                    "buy": int(row.get("buy", 0)),
                    "hold": int(row.get("hold", 0)),
                    "sell": int(row.get("sell", 0)),
                    "strongSell": int(row.get("strongSell", 0)),
                })
            result["recommendations_summary"] = rows
    except Exception:
        result["recommendations_summary"] = []

    # -- Upgrades/downgrades --
    try:
        upgrades = stock.upgrades_downgrades
        if upgrades is not None and not upgrades.empty:
            recent = upgrades.tail(10).reset_index()
            rows = []
            for _, row in recent.iterrows():
                entry = {}
                for col in recent.columns:
                    val = row[col]
                    if hasattr(val, "isoformat"):
                        entry[col] = val.isoformat()
                    else:
                        entry[col] = val
                rows.append(entry)
            result["upgrades_downgrades"] = rows
    except Exception:
        result["upgrades_downgrades"] = []

    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ticker", required=True)
    args = parser.parse_args()

    data = fetch_analyst_data(args.ticker)
    json.dump(data, sys.stdout, default=str)


if __name__ == "__main__":
    main()
