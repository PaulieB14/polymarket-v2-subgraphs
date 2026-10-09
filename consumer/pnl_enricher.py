"""Enrich pnl subgraph positions with market metadata, resolutions and redemptions.

Joins:
  1. polymarket-v2-pnl subgraph       — on-chain positions, cost basis, realized P&L
  2. polymarket-v2 main subgraph      — tokenId -> condition/outcome, resolution payouts
  3. Polymarket Activity subgraph     — PayoutRedemption events (who redeemed what)
  4. Polymarket gamma REST API        — market slug, outcome label, closed flag

Why redemptions come from Activity and not from main: main declares
PayoutRedemption with the wrong indexed params, so every main `Redemption` has
condition 0x0 and a junk collateral. Main's conditions/resolutions are correct
and stay the source of truth for payouts; redemptions come from Polymarket's
Activity subgraph, which decodes the event correctly (CTF + NegRiskAdapter).

Outputs unified records of the form:

    {
      "user": "0x...",
      "buy_cost": 6438.35, "sell_revenue": 247.09,
      "realized_pnl": -6191.26, "unrealized_pnl": 0.0,
      "settled_pnl": 2910.92, "total_pnl": -3280.34, "pnl_pct": -0.5095,
      "net_position": 9096.61, "avg_price": 0.68, "current_price": 1.0,
      "last_trade_price": 0.99, "position_value": 9096.61, "active": true,
      "buys": 693, "sells": 20, "transactions": 713,
      "resolution": {"resolved": true, "payout": 1.0, "resolution_timestamp": 1781000000, "source": "main"},
      "redemptions": {"source": "activity", "count": 1, "payout": 9096.61, "last_timestamp": 1781000100},
      "market": {
        "condition_id": "0x...", "market_slug": "btc-updown-5m-1771359600",
        "token_id": "25362...", "outcome_index": 0, "outcome_label": "Up", "closed": true
      }
    }

Usage:
    GRAPH_API_KEY=xxx python pnl_enricher.py 0xUSER [0xUSER2 ...]
    GRAPH_API_KEY=xxx python pnl_enricher.py --active-only 0xUSER
    GRAPH_API_KEY=xxx python pnl_enricher.py --redemptions none --resolutions none 0xUSER   # pre-join behaviour
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Callable, Iterable
from urllib import error, request

# --- Endpoints ------------------------------------------------------------------
# Every endpoint can be overridden with an env var holding a full URL; a literal
# "{key}" in the URL is replaced with the Graph API key.
PNL_IPFS = os.environ.get("PNL_DEPLOYMENT", "QmT21E4p8r6FCzW2EPK4NVj1dbcggdvKxZr8uuMcB4P5Cu")
MAIN_IPFS = os.environ.get("MAIN_DEPLOYMENT", "QmTKrqyYg23BjhihmsrRjbV9cVS2piNmnHsr7cjYaTgdWu")
# Polymarket's own Activity subgraph (github.com/Polymarket/polymarket-subgraph,
# activity-subgraph). Queried by subgraph id so it follows Polymarket's upgrades.
ACTIVITY_SUBGRAPH_ID = os.environ.get("ACTIVITY_SUBGRAPH_ID", "Bx1W4S7kDVxs9gC3s2G6DS8kdNBJNVhMviCtin2DiBp")

GRAPH_GATEWAY = "https://gateway.thegraph.com/api/{key}/deployments/id/{ipfs}"
GRAPH_GATEWAY_SUBGRAPH = "https://gateway.thegraph.com/api/{key}/subgraphs/id/{id}"
POLYMARKET_GAMMA = "https://gamma-api.polymarket.com/markets"

PAGE = 1000          # max `first` on the gateway
ID_CHUNK = 200       # ids per `_in` filter

UA = "polymarket-v2-pnl-enricher/0.2"


def endpoint(name: str, api_key: str) -> str:
    env = {"pnl": "PNL_SUBGRAPH_URL", "main": "MAIN_SUBGRAPH_URL", "activity": "ACTIVITY_SUBGRAPH_URL"}[name]
    override = os.environ.get(env)
    if override:
        return override.replace("{key}", api_key)
    if name == "pnl":
        return GRAPH_GATEWAY.format(key=api_key, ipfs=PNL_IPFS)
    if name == "main":
        return GRAPH_GATEWAY.format(key=api_key, ipfs=MAIN_IPFS)
    return GRAPH_GATEWAY_SUBGRAPH.format(key=api_key, id=ACTIVITY_SUBGRAPH_ID)


# --- Queries ----------------------------------------------------------------------
ACCOUNT_QUERY = """
query Account($user: String!) {
  account(id: $user) { id buysQuantity sellsQuantity realizedPnl }
}
"""

POSITIONS_QUERY = """
query Positions($user: String!, $cursor: String!, $minAmount: BigInt!) {
  userPositions(first: %d, orderBy: id, orderDirection: asc,
                where: {account: $user, id_gt: $cursor, amount_gte: $minAmount}) {
    id
    tokenId
    amount
    avgPrice
    totalBought
    totalSold
    realizedPnl
  }
}
""" % PAGE

MARKETS_QUERY = """
query Markets($ids: [BigInt!]!) {
  markets(first: %d, where: {tokenId_in: $ids}) {
    tokenId
    lastPrice
  }
}
""" % PAGE

# main: tokenId -> condition + resolution. Do NOT read main's `Redemption`
# entity: its PayoutRedemption decoding is broken (condition always 0x0).
MAIN_MARKETDATA_QUERY = """
query MarketData($ids: [String!]!) {
  _meta { block { number timestamp } }
  marketDatas(first: %d, where: {id_in: $ids}) {
    id
    outcomeIndex
    condition {
      id
      oracle
      outcomeSlotCount
      resolutionTimestamp
      payouts
      payoutNumerators
      payoutDenominator
    }
  }
}
""" % PAGE

ACTIVITY_REDEMPTIONS_QUERY = """
query Redemptions($redeemers: [String!]!, $conditions: [String!]!, $cursor: String!) {
  redemptions(first: %d, orderBy: id, orderDirection: asc,
              where: {redeemer_in: $redeemers, condition_in: $conditions, id_gt: $cursor}) {
    id
    timestamp
    redeemer
    condition
    indexSets
    payout
  }
}
""" % PAGE


def http_post_json(url: str, body: dict[str, Any], timeout: float = 30) -> dict[str, Any]:
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


def query_subgraph(name: str, api_key: str, query: str, variables: dict[str, Any]) -> dict[str, Any]:
    res = http_post_json(endpoint(name, api_key), {"query": query, "variables": variables})
    if res.get("errors"):
        raise RuntimeError(f"{name} subgraph error: {res['errors']}")
    return res["data"]


def query_pnl(api_key: str, query: str, variables: dict[str, Any]) -> dict[str, Any]:
    return query_subgraph("pnl", api_key, query, variables)


def chunks(items: list[str], size: int = ID_CHUNK) -> Iterable[list[str]]:
    for i in range(0, len(items), size):
        yield items[i : i + size]


def paginate(fetch: Callable[[str], list[dict[str, Any]]]) -> list[dict[str, Any]]:
    """Cursor pagination on `id_gt` (stable, unlike `skip`)."""
    out: list[dict[str, Any]] = []
    cursor = ""
    while True:
        page = fetch(cursor)
        out.extend(page)
        if len(page) < PAGE:
            return out
        cursor = page[-1]["id"]


# --- Sources ----------------------------------------------------------------------
def fetch_account(api_key: str, user: str, active_only: bool) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    account = query_pnl(api_key, ACCOUNT_QUERY, {"user": user}).get("account")
    if not account:
        return None, []
    min_amount = "1" if active_only else "0"
    positions = paginate(lambda c: query_pnl(
        api_key, POSITIONS_QUERY, {"user": user, "cursor": c, "minAmount": min_amount})["userPositions"])
    return account, positions


def fetch_last_prices(api_key: str, token_ids: list[str]) -> dict[str, float]:
    out: dict[str, float] = {}
    for chunk in chunks(token_ids):
        for m in query_pnl(api_key, MARKETS_QUERY, {"ids": chunk})["markets"]:
            out[str(m["tokenId"])] = float(m["lastPrice"])
    return out


def payout_fraction(condition: dict[str, Any], outcome_index: int) -> float | None:
    nums, den = condition.get("payoutNumerators"), condition.get("payoutDenominator")
    if nums and den and int(den) > 0 and outcome_index < len(nums):
        return int(nums[outcome_index]) / int(den)
    payouts = condition.get("payouts")
    if payouts and outcome_index < len(payouts):
        return float(payouts[outcome_index])
    return None


def fetch_resolutions(api_key: str, token_ids: list[str]) -> tuple[dict[str, dict[str, Any]], int | None]:
    """{token_id: {condition_id, outcome_index, resolved, payout, resolution_timestamp}} from main.

    Tokens main doesn't know (e.g. NegRisk positions minted via the adapter, or
    activity past main's head) are simply absent.
    """
    out: dict[str, dict[str, Any]] = {}
    head: int | None = None
    for chunk in chunks(token_ids):
        data = query_subgraph("main", api_key, MAIN_MARKETDATA_QUERY, {"ids": chunk})
        head = data.get("_meta", {}).get("block", {}).get("number", head)
        for md in data["marketDatas"]:
            cond = md.get("condition")
            if not cond or md.get("outcomeIndex") is None:
                continue
            idx = int(md["outcomeIndex"])
            resolved = cond.get("resolutionTimestamp") is not None
            out[str(md["id"])] = {
                "condition_id": cond["id"],
                "outcome_index": idx,
                "resolved": resolved,
                "payout": payout_fraction(cond, idx) if resolved else None,
                "resolution_timestamp": int(cond["resolutionTimestamp"]) if resolved else None,
            }
    return out, head


def fetch_redemptions(api_key: str, redeemers: list[str], condition_ids: list[str]) -> dict[str, dict[str, Any]]:
    """{condition_id: {count, payout, last_timestamp}} from the Activity subgraph.

    `payout` is collateral (USDC.e / pUSD, 6 decimals) scaled to units. Covers CTF
    PayoutRedemption and NegRiskAdapter PayoutRedemption (Activity skips the CTF
    event when the redeemer is the NegRiskAdapter, so nothing is double counted).
    """
    out: dict[str, dict[str, Any]] = {}
    redeemers = sorted({r.lower() for r in redeemers})
    for chunk in chunks(sorted(set(condition_ids)), 100):
        rows = paginate(lambda c: query_subgraph(
            "activity", api_key, ACTIVITY_REDEMPTIONS_QUERY,
            {"redeemers": redeemers, "conditions": chunk, "cursor": c})["redemptions"])
        for r in rows:
            agg = out.setdefault(r["condition"], {"count": 0, "payout_raw": 0, "last_timestamp": 0})
            agg["count"] += 1
            agg["payout_raw"] += int(r["payout"])
            agg["last_timestamp"] = max(agg["last_timestamp"], int(r["timestamp"]))
    for agg in out.values():
        agg["payout"] = round(agg.pop("payout_raw") / 1e6, 6)
    return out


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
            except (error.HTTPError, error.URLError) as e:
                sys.stderr.write(f"warn: gamma error for chunk {i} ({filter_qs!r}): {e}\n")
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


# --- Enrichment -------------------------------------------------------------------
def enrich_user(
    api_key: str,
    user: str,
    active_only: bool = False,
    resolutions: str = "main",
    redemptions: str = "activity",
    extra_redeemers: list[str] | None = None,
) -> list[dict[str, Any]]:
    user = user.lower()
    account, positions = fetch_account(api_key, user, active_only)
    if not account or not positions:
        return []

    token_ids = [str(p["tokenId"]) for p in positions]
    price_by_token = fetch_last_prices(api_key, token_ids)
    meta_by_token = fetch_polymarket_metadata(token_ids)

    res_by_token: dict[str, dict[str, Any]] = {}
    if resolutions == "main":
        try:
            res_by_token, main_head = fetch_resolutions(api_key, token_ids)
            sys.stderr.write(f"info: main resolutions for {len(res_by_token)}/{len(token_ids)} tokens "
                             f"(main head block {main_head})\n")
        except (RuntimeError, error.URLError, OSError) as e:
            sys.stderr.write(f"warn: main subgraph unavailable, positions valued at last trade price: {e}\n")

    red_by_condition: dict[str, dict[str, Any]] | None = None
    if redemptions == "activity":
        cond_ids = {r["condition_id"] for r in res_by_token.values()}
        cond_ids |= {m["condition_id"].lower() for m in meta_by_token.values() if m.get("condition_id")}
        try:
            red_by_condition = fetch_redemptions(api_key, [user, *(extra_redeemers or [])], sorted(cond_ids))
        except (RuntimeError, error.URLError, OSError) as e:
            sys.stderr.write(f"warn: activity subgraph unavailable, redemptions omitted: {e}\n")

    buys = int(account["buysQuantity"])
    sells = int(account["sellsQuantity"])

    def condition_of(tid: str) -> str | None:
        res = res_by_token.get(tid)
        if res:
            return res["condition_id"]
        cid = meta_by_token.get(tid, {}).get("condition_id")
        return cid.lower() if cid else None

    # Settlement inferred from redemptions, for conditions main hasn't resolved
    # (main lags chain head). CTF/NegRisk redeem burns the caller's whole balance,
    # so the user's redemption payout on a condition is what their held tokens
    # settled for. Spread it over the user's positions on that condition pro rata
    # (exact when only one outcome is held, which is the common case).
    inferred_price: dict[str, float] = {}
    if red_by_condition:
        held: dict[str, float] = {}
        for p in positions:
            tid = str(p["tokenId"])
            r = res_by_token.get(tid)
            cid = condition_of(tid)
            if cid and cid in red_by_condition and not (r and r["resolved"]):
                held[cid] = held.get(cid, 0.0) + int(p["amount"]) / 1e6
        for cid, tokens in held.items():
            if tokens <= 0:
                continue
            implied = red_by_condition[cid]["payout"] / tokens
            if implied > 1 + 1e-6:
                # pnl `amount` only tracks exchange fills; tokens from splits or
                # transfers make the redeemed amount exceed it. Don't guess.
                sys.stderr.write(f"warn: redemption on {cid} exceeds tracked balance; not inferring settlement\n")
                continue
            inferred_price[cid] = implied

    out: list[dict[str, Any]] = []
    for p in positions:
        tid = str(p["tokenId"])
        amount_tokens = int(p["amount"]) / 1e6  # CTF outcome tokens are 6dp
        avg_price = float(p["avgPrice"])
        last_price = price_by_token.get(tid, 0.0)
        total_bought = int(p["totalBought"]) / 1e6
        total_sold = int(p["totalSold"]) / 1e6
        realized_pnl = float(p["realizedPnl"])
        meta = meta_by_token.get(tid, {})
        res = res_by_token.get(tid)
        condition_id = condition_of(tid)

        resolution: dict[str, Any] = {"resolved": False, "payout": None, "resolution_timestamp": None,
                                      "source": "main" if res else None}
        if res and res["resolved"] and res["payout"] is not None:
            resolution.update(resolved=True, payout=res["payout"],
                              resolution_timestamp=res["resolution_timestamp"], source="main")
        elif condition_id in inferred_price:
            resolution.update(resolved=True, payout=round(inferred_price[condition_id], 6),
                              resolution_timestamp=None, source="activity-redemption")
        resolved = resolution["resolved"]
        current_price = resolution["payout"] if resolved else last_price

        buy_cost = round(total_bought * avg_price, 2)
        position_value = round(amount_tokens * current_price, 2)
        # sell_revenue is the implied collateral received from sells, derivable from
        # realized_pnl + (cost basis of sold tokens). We approximate as
        # realized_pnl + total_sold * avg_price for a useful display value.
        sell_revenue = round(realized_pnl + total_sold * avg_price, 2)
        cost_of_held = amount_tokens * avg_price
        # A resolved position is no longer "unrealized": it settles at the payout.
        settled_pnl = round(position_value - cost_of_held, 2) if resolved else 0.0
        unrealized_pnl = 0.0 if resolved else round(position_value - cost_of_held, 2)
        total_pnl = round(realized_pnl + settled_pnl + unrealized_pnl, 2)
        pnl_pct = round(total_pnl / buy_cost, 4) if buy_cost else 0.0

        red = None
        if red_by_condition is not None and condition_id:
            agg = red_by_condition.get(condition_id)
            red = {"source": "activity", "count": agg["count"] if agg else 0,
                   "payout": agg["payout"] if agg else 0.0,
                   "last_timestamp": agg["last_timestamp"] if agg else None}

        out.append({
            "user": user,
            "buy_cost": buy_cost,
            "sell_revenue": sell_revenue,
            "realized_pnl": round(realized_pnl, 2),
            "unrealized_pnl": unrealized_pnl,
            "settled_pnl": settled_pnl,
            "total_pnl": total_pnl,
            "pnl_pct": pnl_pct,
            "net_position": position_value,  # value of held tokens at current price / payout
            "avg_price": round(avg_price, 4),
            "current_price": round(current_price, 4),
            "last_trade_price": round(last_price, 4),
            "position_value": position_value,
            "active": amount_tokens > 0,
            "buys": buys,
            "sells": sells,
            "transactions": buys + sells,
            "resolution": resolution,
            # Per-condition (covers every outcome of the condition the user redeemed);
            # don't sum across records of the same condition.
            "redemptions": red,
            "market": {
                "condition_id": condition_id,
                "market_slug": meta.get("market_slug"),
                "token_id": tid,
                "outcome_index": (res or {}).get("outcome_index"),
                "outcome_label": meta.get("outcome_label"),
                "closed": resolved or meta.get("closed", False),
            },
        })
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description="Enrich Polymarket V2 P&L positions")
    parser.add_argument("users", nargs="+", help="One or more 0x user addresses")
    parser.add_argument("--active-only", action="store_true", help="Skip positions with zero amount")
    parser.add_argument("--api-key", default=os.environ.get("GRAPH_API_KEY"),
                        help="Graph API key (or set GRAPH_API_KEY env)")
    parser.add_argument("--resolutions", choices=("main", "none"),
                        default=os.environ.get("PNL_RESOLUTIONS_SOURCE", "main"),
                        help="Where resolution payouts come from (default: main subgraph)")
    parser.add_argument("--redemptions", choices=("activity", "none"),
                        default=os.environ.get("PNL_REDEMPTIONS_SOURCE", "activity"),
                        help="Where redemptions come from (default: Polymarket Activity subgraph)")
    parser.add_argument("--redeemer", action="append", default=[],
                        help="Extra address to attribute redemptions to (e.g. the user's EOA). Repeatable.")
    args = parser.parse_args()

    if not args.api_key:
        sys.exit("error: GRAPH_API_KEY env var or --api-key required")

    all_records: list[dict[str, Any]] = []
    for user in args.users:
        all_records.extend(enrich_user(args.api_key, user, args.active_only,
                                       args.resolutions, args.redemptions, args.redeemer))

    json.dump(all_records, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
