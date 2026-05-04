"""Enrich pnl subgraph positions with Polymarket market metadata + derived P&L.

Joins:
  1. polymarket-v2-pnl subgraph — on-chain positions, cost basis, realized P&L
  2. Polymarket gamma REST API   — market slug, outcome label, resolution status

Outputs unified records of the form:

    {
      "user": "0x...",
      "buy_cost": 6438.35, "sell_revenue": 247.09,
      "realized_pnl": -6191.26, "unrealized_pnl": 9005.64,
      "total_pnl": 2814.38, "pnl_pct": -0.96,
      "net_position": 9096.61, "avg_price": 0.68, "current_price": 0.99,
      "position_value": 9005.64, "active": true,
      "buys": 693, "sells": 20, "transactions": 713,
      "market": {
        "condition_id": "0x...",
        "market_slug": "btc-updown-5m-1771359600",
        "token_id": "25362...",
        "outcome_label": "Up",
        "closed": false
      }
    }

Usage:
    GRAPH_API_KEY=xxx python pnl_enricher.py 0xUSER [0xUSER2 ...]
    GRAPH_API_KEY=xxx python pnl_enricher.py --active-only 0xUSER
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any
from urllib import error, request

PNL_IPFS = "QmT21E4p8r6FCzW2EPK4NVj1dbcggdvKxZr8uuMcB4P5Cu"
GRAPH_GATEWAY = "https://gateway.thegraph.com/api/{key}/deployments/id/{ipfs}"
POLYMARKET_GAMMA = "https://gamma-api.polymarket.com/markets"

POSITIONS_QUERY = """
query Positions($user: String!) {
  account(id: $user) {
    id
    buysQuantity
    sellsQuantity
    realizedPnl
    positions {
      tokenId
      amount
      avgPrice
      totalBought
      totalSold
      realizedPnl
    }
  }
}
"""

MARKETS_QUERY = """
query Markets($ids: [String!]!) {
  markets(where: {tokenId_in: $ids}) {
    tokenId
    lastPrice
  }
}
"""


UA = "polymarket-v2-pnl-enricher/0.1"


def http_post_json(url: str, body: dict[str, Any], timeout: float = 15) -> dict[str, Any]:
    req = request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "User-Agent": UA},
        method="POST",
    )
    with request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


def http_get_json(url: str, timeout: float = 15) -> Any:
    req = request.Request(url, headers={"User-Agent": UA})
    with request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


def query_pnl(api_key: str, query: str, variables: dict[str, Any]) -> dict[str, Any]:
    url = GRAPH_GATEWAY.format(key=api_key, ipfs=PNL_IPFS)
    res = http_post_json(url, {"query": query, "variables": variables})
    if res.get("errors"):
        raise RuntimeError(f"pnl subgraph error: {res['errors']}")
    return res["data"]


def fetch_polymarket_metadata(token_ids: list[str]) -> dict[str, dict[str, Any]]:
    """Returns {token_id: {condition_id, slug, outcome_label, closed}}."""
    out: dict[str, dict[str, Any]] = {}
    # Gamma filters out closed markets by default — need two passes (open + closed)
    # to cover both. Chunk to avoid huge URLs.
    CHUNK = 50
    for i in range(0, len(token_ids), CHUNK):
        chunk = token_ids[i : i + CHUNK]
        chunk_set = {str(t) for t in chunk}
        qs = "&".join(f"clob_token_ids={tid}" for tid in chunk)
        for filter_qs in ("", "&closed=true&active=true"):
            try:
                markets = http_get_json(f"{POLYMARKET_GAMMA}?{qs}&limit={CHUNK}{filter_qs}")
            except error.HTTPError as e:
                sys.stderr.write(f"warn: gamma {e.code} for chunk {i} ({filter_qs!r}): {e.reason}\n")
                continue
            for m in markets if isinstance(markets, list) else []:
                tokens_raw = m.get("clobTokenIds") or "[]"
                outcomes_raw = m.get("outcomes") or "[]"
                try:
                    tokens = json.loads(tokens_raw) if isinstance(tokens_raw, str) else tokens_raw
                    outcomes = json.loads(outcomes_raw) if isinstance(outcomes_raw, str) else outcomes_raw
                except json.JSONDecodeError:
                    continue
                for idx, tid in enumerate(tokens):
                    tid_str = str(tid)
                    if tid_str in chunk_set and tid_str not in out:
                        out[tid_str] = {
                            "condition_id": m.get("conditionId"),
                            "market_slug": m.get("slug"),
                            "outcome_label": outcomes[idx] if idx < len(outcomes) else None,
                            "closed": bool(m.get("closed")),
                        }
    return out


def enrich_user(api_key: str, user: str, active_only: bool = False) -> list[dict[str, Any]]:
    user = user.lower()
    data = query_pnl(api_key, POSITIONS_QUERY, {"user": user})
    account = data.get("account")
    if not account:
        return []

    positions = account["positions"]
    if active_only:
        positions = [p for p in positions if int(p["amount"]) > 0]
    if not positions:
        return []

    # Pull current prices for all relevant tokens
    token_ids = [p["tokenId"] for p in positions]
    market_data = query_pnl(api_key, MARKETS_QUERY, {"ids": token_ids})
    price_by_token = {m["tokenId"]: float(m["lastPrice"]) for m in market_data["markets"]}

    # Pull market metadata from Polymarket REST
    meta_by_token = fetch_polymarket_metadata(token_ids)

    buys = int(account["buysQuantity"])
    sells = int(account["sellsQuantity"])

    out: list[dict[str, Any]] = []
    for p in positions:
        tid = p["tokenId"]
        amount_tokens = int(p["amount"]) / 1e6  # CTF outcome tokens are 6dp
        avg_price = float(p["avgPrice"])
        current_price = price_by_token.get(tid, 0.0)
        total_bought = int(p["totalBought"]) / 1e6
        total_sold = int(p["totalSold"]) / 1e6
        realized_pnl = float(p["realizedPnl"])

        buy_cost = round(total_bought * avg_price, 2)
        position_value = round(amount_tokens * current_price, 2)
        # sell_revenue is the implied collateral received from sells, derivable from
        # realized_pnl + (cost basis of sold tokens). We approximate as
        # realized_pnl + total_sold * avg_price for a useful display value.
        sell_revenue = round(realized_pnl + total_sold * avg_price, 2)
        unrealized_pnl = round(position_value - amount_tokens * avg_price, 2)
        total_pnl = round(realized_pnl + unrealized_pnl, 2)
        pnl_pct = round(total_pnl / buy_cost, 4) if buy_cost else 0.0

        meta = meta_by_token.get(tid, {})
        out.append({
            "user": user,
            "buy_cost": buy_cost,
            "sell_revenue": sell_revenue,
            "realized_pnl": round(realized_pnl, 2),
            "unrealized_pnl": unrealized_pnl,
            "total_pnl": total_pnl,
            "pnl_pct": pnl_pct,
            "net_position": position_value,  # value of held tokens at current price
            "avg_price": round(avg_price, 4),
            "current_price": round(current_price, 4),
            "position_value": position_value,
            "active": amount_tokens > 0,
            "buys": buys,
            "sells": sells,
            "transactions": buys + sells,
            "market": {
                "condition_id": meta.get("condition_id"),
                "market_slug": meta.get("market_slug"),
                "token_id": tid,
                "outcome_label": meta.get("outcome_label"),
                "closed": meta.get("closed", False),
            },
        })
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description="Enrich Polymarket V2 P&L positions")
    parser.add_argument("users", nargs="+", help="One or more 0x user addresses")
    parser.add_argument("--active-only", action="store_true", help="Skip positions with zero amount")
    parser.add_argument("--api-key", default=os.environ.get("GRAPH_API_KEY"),
                        help="Graph API key (or set GRAPH_API_KEY env)")
    args = parser.parse_args()

    if not args.api_key:
        sys.exit("error: GRAPH_API_KEY env var or --api-key required")

    all_records: list[dict[str, Any]] = []
    for user in args.users:
        all_records.extend(enrich_user(args.api_key, user, args.active_only))

    json.dump(all_records, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
