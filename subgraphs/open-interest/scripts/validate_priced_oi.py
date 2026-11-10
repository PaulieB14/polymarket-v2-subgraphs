#!/usr/bin/env python3
"""Validate neg-risk OI design against Polygon RPC, Gamma prices, and Polymarket data-api.

Never prints the RPC key or full RPC URL.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from collections import defaultdict
from pathlib import Path
from typing import Any

import requests

ADAPTER = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296"
CTF = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"
USDC_E = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"
BURN = "0xa5ef39c3d3e10d0b270233af41cac69796b12966"
ADAPTER_START = 50_505_403
CTF_START = 10_727_107

# keccak event signatures (precomputed)
from eth_hash.auto import keccak


def evtsig(sig: str) -> str:
    return "0x" + keccak(sig.encode()).hex()


TOPIC_NR_SPLIT = evtsig("PositionSplit(address,bytes32,uint256)")
TOPIC_NR_MERGE = evtsig("PositionsMerge(address,bytes32,uint256)")
TOPIC_NR_REDEEM = evtsig("PayoutRedemption(address,bytes32,uint256[],uint256)")
TOPIC_NR_CONVERT = evtsig("PositionsConverted(address,bytes32,uint256,uint256)")
TOPIC_NR_QPREP = evtsig("QuestionPrepared(bytes32,bytes32,uint256,bytes)")
TOPIC_CTF_SPLIT = evtsig(
    "PositionSplit(address,address,bytes32,bytes32,uint256[],uint256)"
)
TOPIC_CTF_MERGE = evtsig(
    "PositionsMerge(address,address,bytes32,bytes32,uint256[],uint256)"
)
TOPIC_CTF_REDEEM = evtsig(
    "PayoutRedemption(address,address,bytes32,bytes32,uint256[],uint256)"
)

DEM_MARKET = "0x2c3d7e0eee6f058be3006baabf0d54a07da254ba47fe6e3e095e7990c7814700"
SENATE_MARKET = "0x1272214827e15386c39d02e86ae36a5aa0cb7abb9756020cfcd887b8c8026700"

MARKETS = [
    {
        "name": "Adam Hamilton (Dem nom)",
        "conditionId": "0xd2c0cc6a7ad3c0e2590fa55095052e98b1a2b146e9b807138c7421ac0e39c60e",
        "questionId": "0x2c3d7e0eee6f058be3006baabf0d54a07da254ba47fe6e3e095e7990c7814735",
        "marketId": DEM_MARKET,
        "index": 0x35,
        "negRisk": True,
        "startBlock": 73_845_369,
    },
    {
        "name": "placeholder (Dem nom)",
        "conditionId": "0xfd8318449c6d6b5b107c5ccac78b51310489b3cf527970a658d3ab4cccd1e1f4",
        "questionId": "0x2c3d7e0eee6f058be3006baabf0d54a07da254ba47fe6e3e095e7990c7814742",
        "marketId": DEM_MARKET,
        "index": 0x42,
        "negRisk": True,
        "startBlock": 73_845_427,
    },
    {
        "name": "Gavin Newsom (Dem nom)",
        "conditionId": "0x0f49db97f71c68b1e42a6d16e3de93d85dbf7d4148e3f018eb79e88554be9f75",
        "questionId": "0x2c3d7e0eee6f058be3006baabf0d54a07da254ba47fe6e3e095e7990c7814700",
        "marketId": DEM_MARKET,
        "index": 0x00,
        "negRisk": True,
        "startBlock": 73_845_131,
    },
    {
        "name": "Republicans lose AK/IA/KS/ME/MI/OH/TX",
        "conditionId": "0xa32317ba83c3c83dc43ef260c3744c22ed8000db53d30bc09372c45cff5fb07a",
        "questionId": "0x1272214827e15386c39d02e86ae36a5aa0cb7abb9756020cfcd887b8c802677f",
        "marketId": SENATE_MARKET,
        "index": 0x7F,
        "negRisk": True,
        "startBlock": 96_231_923,
    },
    {
        "name": "regular non-negRisk (0x747d…)",
        "conditionId": "0x747dc809fb79e1b05be09c42d6179459a58de2ef3e40f02484a4e1260f741f75",
        "questionId": "0x89fa09debbe698fbbeaad80dbd8f5fed352b8d9ee4769412530771dbdc34ea27",
        "marketId": None,
        "index": None,
        "negRisk": False,
        "startBlock": 79_494_419,
    },
]


def redact(s: str, rpc: str, key: str) -> str:
    out = s
    if rpc:
        out = out.replace(rpc, "<RPC>")
    if key:
        out = out.replace(key, "<KEY>")
    # also redact any path-looking alchemy keys
    return out


def pick_rpc(urls: list[str], key: str, label: str) -> str:
    last_err = None
    for url in urls:
        try:
            r = requests.post(
                url,
                json={"jsonrpc": "2.0", "id": 1, "method": "eth_blockNumber", "params": []},
                timeout=20,
                headers={"content-type": "application/json"},
            )
            data = r.json() if r.ok else None
            if r.ok and data and "result" in data:
                return url
            last_err = redact((r.text if not r.ok else json.dumps(data))[:200], url, key)
        except Exception as e:
            last_err = redact(repr(e), url, key)
    raise SystemExit(f"No working {label} RPC: {last_err}")


def load_rpcs() -> tuple[str, str, str]:
    """Return (call_rpc, logs_rpc, key). Alchemy free tier only allows a 10-block
    eth_getLogs window, so logs go to a public archive endpoint."""
    key_path = Path("/home/box/.alchemy_polygon_key")
    key = key_path.read_text().strip() if key_path.exists() else ""
    call_urls = []
    if key:
        call_urls.append(f"https://polygon-mainnet.g.alchemy.com/v2/{key}")
    call_urls += ["https://polygon.gateway.tenderly.co"]
    log_urls = [
        "https://polygon.gateway.tenderly.co",
        "https://polygon.drpc.org",
    ]
    call_url = pick_rpc(call_urls, key, "eth_call")
    logs_url = pick_rpc(log_urls, key, "eth_getLogs")
    return call_url, logs_url, key


class RPC:
    def __init__(self, url: str, key: str, name: str = "rpc"):
        self.url = url
        self.key = key
        self.name = name
        self.session = requests.Session()
        self.n = 0

    def call(self, method: str, params: list, timeout: int = 60) -> Any:
        self.n += 1
        payload = {"jsonrpc": "2.0", "id": self.n, "method": method, "params": params}
        try:
            r = self.session.post(
                self.url,
                json=payload,
                timeout=timeout,
                headers={"content-type": "application/json"},
            )
            r.raise_for_status()
            data = r.json()
        except Exception as e:
            raise RuntimeError(redact(str(e), self.url, self.key)) from None
        if "error" in data:
            raise RuntimeError(redact(json.dumps(data["error"]), self.url, self.key))
        return data["result"]

    def batch(self, calls: list[tuple[str, list]], timeout: int = 60) -> list[Any]:
        if not calls:
            return []
        payload = []
        for method, params in calls:
            self.n += 1
            payload.append({"jsonrpc": "2.0", "id": self.n, "method": method, "params": params})
        try:
            r = self.session.post(
                self.url,
                json=payload,
                timeout=timeout,
                headers={"content-type": "application/json"},
            )
            r.raise_for_status()
            data = r.json()
        except Exception as e:
            raise RuntimeError(redact(str(e), self.url, self.key)) from None
        if isinstance(data, dict) and "error" in data:
            raise RuntimeError(redact(json.dumps(data["error"]), self.url, self.key))
        by_id = {item["id"]: item for item in data}
        out = []
        # payload ids are sequential ending at self.n
        start = self.n - len(calls) + 1
        for i in range(len(calls)):
            item = by_id[start + i]
            if "error" in item:
                out.append(RuntimeError(redact(json.dumps(item["error"]), self.url, self.key)))
            else:
                out.append(item["result"])
        return out


def pad32(hex_or_int) -> str:
    if isinstance(hex_or_int, int):
        return hex(hex_or_int)[2:].rjust(64, "0")
    s = hex_or_int.lower().removeprefix("0x")
    return s.rjust(64, "0")


def topic_addr(addr: str) -> str:
    return "0x" + pad32(addr.lower().removeprefix("0x"))


def topic_bytes32(b: str) -> str:
    return "0x" + pad32(b)


def decode_uint(data: str, offset_bytes: int = 0) -> int:
    h = data.lower().removeprefix("0x")
    start = offset_bytes * 2
    return int(h[start : start + 64] or "0", 16)


def selector(sig: str) -> str:
    return "0x" + keccak(sig.encode()).hex()[:8]


def encode_address(addr: str) -> str:
    return pad32(addr.lower().removeprefix("0x"))


def encode_uint(n: int) -> str:
    return pad32(n)


def encode_bytes32(b: str) -> str:
    return pad32(b)


def encode_bool(v: bool) -> str:
    return pad32(1 if v else 0)


def usd(raw: int) -> float:
    return raw / 1_000_000


def fmt(raw: int | float | None, digits: 2) -> str:
    if raw is None:
        return "n/a"
    if isinstance(raw, int):
        return f"{usd(raw):,.6f}"
    return f"{raw:,.6f}"


def eth_call_data(rpc: RPC, to: str, data: str, block: int | str) -> str | None:
    blk = hex(block) if isinstance(block, int) else block
    try:
        return rpc.call("eth_call", [{"to": to, "data": data}, blk])
    except RuntimeError as e:
        msg = str(e).lower()
        if "execution reverted" in msg or "revert" in msg:
            return None
        raise


CACHE_DIR = Path(os.environ.get("VALIDATE_OI_CACHE", str(Path(__file__).resolve().parent / "cache")))

def _cache_key(address: str, topics: list, start: int, end: int) -> Path:
    import hashlib
    raw = json.dumps({"a": address.lower(), "t": topics, "s": start, "e": end}, sort_keys=True)
    return CACHE_DIR / (hashlib.sha1(raw.encode()).hexdigest() + ".json")

def get_logs(rpc: RPC, address: str, topics: list, start: int, end: int, label: str) -> list[dict]:
    """Adaptive chunked eth_getLogs. Starts at 2M blocks (works on Tenderly)."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    ck = _cache_key(address, topics, start, end)
    if ck.exists():
        return json.loads(ck.read_text())
    out: list[dict] = []
    chunk = 2_000_000
    cursor = start
    retries = 0
    while cursor <= end:
        to = min(cursor + chunk - 1, end)
        params = [{
            "address": address,
            "topics": topics,
            "fromBlock": hex(cursor),
            "toBlock": hex(to),
        }]
        try:
            logs = rpc.call("eth_getLogs", params, timeout=120)
            if len(logs) >= 10_000 and (to - cursor) > 0:
                mid = (cursor + to) // 2
                print(f"    cap-split {label} {cursor}-{to} ({len(logs)} logs) at {mid}")
                # shrink chunk and retry this window in two halves
                chunk = max(50, (to - cursor) // 2)
                continue
            out.extend(logs)
            cursor = to + 1
            retries = 0
            if chunk < 2_000_000:
                chunk = min(2_000_000, chunk * 2)
        except RuntimeError as e:
            msg = str(e).lower()
            shrinkable = any(s in msg for s in (
                "too many", "timeout", "range", "limit", "response size",
                "log response", "query returned more", "exceed", "400",
                "free tier", "not supported", "too much", "413", "-32600",
                "-32602", "blocks",
            ))
            if shrinkable and chunk > 50:
                chunk = max(50, chunk // 4)
                retries += 1
                if retries > 24:
                    raise RuntimeError(f"{label}: failed even at chunk={chunk}: {e}") from None
                continue
            retries += 1
            if retries > 8:
                raise RuntimeError(f"{label}: {e}") from None
            time.sleep(min(2 * retries, 8))
            continue
    ck.write_text(json.dumps(out))
    return out


def curl_json(url: str) -> Any:
    p = subprocess.run(
        ["curl", "-sS", "-A", "Mozilla/5.0", "--max-time", "30", url],
        capture_output=True,
        text=True,
    )
    if p.returncode != 0:
        raise RuntimeError(f"curl failed for {url}: {p.stderr[-200:]}")
    try:
        return json.loads(p.stdout)
    except json.JSONDecodeError:
        raise RuntimeError(f"non-json from {url}: {p.stdout[:300]}")


def main() -> int:
    out_dir = Path("/workspace/oi-negrisk-validate")
    call_url, logs_url, key = load_rpcs()
    rpc = RPC(call_url, key, "call")
    logs_rpc = RPC(logs_url, key, "logs")
    call_name = "Alchemy" if "alchemy.com" in call_url else "public"
    logs_name = "Tenderly" if "tenderly" in logs_url else "public"
    print(f"eth_call RPC: {call_name}; eth_getLogs RPC: {logs_name}")
    using_alchemy = "alchemy.com" in call_url

    head = int(rpc.call("eth_blockNumber", []), 16)
    print(f"Pinned block: {head}")

    # wcol
    wcol_raw = eth_call_data(rpc, ADAPTER, selector("wcol()"), head)
    if not wcol_raw or wcol_raw == "0x":
        raise SystemExit("wcol() call failed")
    wcol = "0x" + wcol_raw[-40:]
    print(f"WCOL: {wcol}")
    print(f"BURN: {BURN}")

    # position ids via adapter for neg-risk; CTF for regular
    for m in MARKETS:
        if m["negRisk"]:
            yes_data = selector("getPositionId(bytes32,bool)") + encode_bytes32(m["questionId"]) + encode_bool(True)
            no_data = selector("getPositionId(bytes32,bool)") + encode_bytes32(m["questionId"]) + encode_bool(False)
            yes_r = eth_call_data(rpc, ADAPTER, yes_data, head)
            no_r = eth_call_data(rpc, ADAPTER, no_data, head)
            m["yesId"] = int(yes_r, 16)
            m["noId"] = int(no_r, 16)
        else:
            # getCollectionId(0, conditionId, 1/2) then getPositionId(USDC.e, collection)
            col_yes = eth_call_data(
                rpc,
                CTF,
                selector("getCollectionId(bytes32,bytes32,uint256)")
                + encode_bytes32("0x" + "00" * 32)
                + encode_bytes32(m["conditionId"])
                + encode_uint(1),
                head,
            )
            col_no = eth_call_data(
                rpc,
                CTF,
                selector("getCollectionId(bytes32,bytes32,uint256)")
                + encode_bytes32("0x" + "00" * 32)
                + encode_bytes32(m["conditionId"])
                + encode_uint(2),
                head,
            )
            yes_r = eth_call_data(
                rpc,
                CTF,
                selector("getPositionId(address,bytes32)") + encode_address(USDC_E) + col_yes.removeprefix("0x"),
                head,
            )
            no_r = eth_call_data(
                rpc,
                CTF,
                selector("getPositionId(address,bytes32)") + encode_address(USDC_E) + col_no.removeprefix("0x"),
                head,
            )
            m["yesId"] = int(yes_r, 16)
            m["noId"] = int(no_r, 16)
        print(f"  {m['name']}: yesId={m['yesId']} noId={m['noId']}")

    # (b) ERC1155 state
    def bal_data(owner: str, token_id: int) -> str:
        return selector("balanceOf(address,uint256)") + encode_address(owner) + encode_uint(token_id)

    def try_total_supply(token_id: int) -> int | None:
        for sig in ("totalSupply(uint256)", "totalSupply(uint256)"):
            raw = eth_call_data(rpc, CTF, selector("totalSupply(uint256)") + encode_uint(token_id), head)
            if raw and raw != "0x" and len(raw) >= 66:
                return int(raw, 16)
        return None

    for m in MARKETS:
        m["yesTotal"] = try_total_supply(m["yesId"])
        m["noTotal"] = try_total_supply(m["noId"])
        yes_burn = eth_call_data(rpc, CTF, bal_data(BURN, m["yesId"]), head)
        no_burn = eth_call_data(rpc, CTF, bal_data(BURN, m["noId"]), head)
        m["yesBurn"] = int(yes_burn, 16) if yes_burn and yes_burn != "0x" else 0
        m["noBurn"] = int(no_burn, 16) if no_burn and no_burn != "0x" else 0
        # also adapter balance (should be ~0 for outstanding user tokens)
        yes_ad = eth_call_data(rpc, CTF, bal_data(ADAPTER, m["yesId"]), head)
        no_ad = eth_call_data(rpc, CTF, bal_data(ADAPTER, m["noId"]), head)
        m["yesAdapter"] = int(yes_ad, 16) if yes_ad and yes_ad != "0x" else 0
        m["noAdapter"] = int(no_ad, 16) if no_ad and no_ad != "0x" else 0
        if m["yesTotal"] is not None:
            m["yesCircOnchain"] = m["yesTotal"] - m["yesBurn"]
        else:
            m["yesCircOnchain"] = None
        if m["noTotal"] is not None:
            m["noCircOnchain"] = m["noTotal"] - m["noBurn"]
        else:
            m["noCircOnchain"] = None
        print(
            f"  onchain {m['name']}: totalY={m['yesTotal']} totalN={m['noTotal']} "
            f"burnY={m['yesBurn']} burnN={m['noBurn']}"
        )

    # (c) Gamma + data-api at the same time
    ids = [m["conditionId"] for m in MARKETS]
    # data-api allows up to 20
    oi_url = "https://data-api.polymarket.com/v2/oi?condition=" + ",".join(ids)
    print("Fetching data-api and Gamma…")
    api_oi = curl_json(oi_url)
    api_map = {}
    rows = api_oi.get("data", api_oi) if isinstance(api_oi, dict) else api_oi
    if isinstance(rows, list):
        for row in rows:
            cid = (row.get("condition_id") or row.get("conditionId") or "").lower()
            api_map[cid] = row.get("value")
    gamma_map = {}
    for m in MARKETS:
        gurl = f"https://gamma-api.polymarket.com/markets?condition_ids={m['conditionId']}"
        try:
            g = curl_json(gurl)
        except Exception as e:
            print(f"  gamma fail {m['name']}: {e}")
            g = []
        price = None
        title = None
        if isinstance(g, list) and g:
            rec = g[0]
            title = rec.get("question") or rec.get("title")
            op = rec.get("outcomePrices") or rec.get("outcome_prices")
            if isinstance(op, str):
                try:
                    op = json.loads(op)
                except Exception:
                    op = None
            if isinstance(op, list) and op:
                try:
                    price = float(op[0])
                except Exception:
                    price = None
        # fallback midpoint from CLOB if listed
        if price is None:
            try:
                tokens = curl_json(
                    f"https://gamma-api.polymarket.com/markets?condition_ids={m['conditionId']}"
                )
            except Exception:
                tokens = []
        m["gammaPriceYes"] = price
        m["gammaTitle"] = title
        m["apiOi"] = api_map.get(m["conditionId"].lower())
        gamma_map[m["conditionId"]] = price
        print(f"  {m['name']}: p={price} apiOi={m['apiOi']} title={title}")

    # (a) Replay logs
    # Cache conversions per event marketId
    convert_cache: dict[str, list[dict]] = {}

    def load_conversions(market_id: str, start: int) -> list[dict]:
        if market_id in convert_cache:
            return convert_cache[market_id]
        print(f"Fetching PositionsConverted for {market_id[:10]}… from {start} to {head}")
        logs = get_logs(
            logs_rpc,
            ADAPTER,
            [TOPIC_NR_CONVERT, None, topic_bytes32(market_id)],
            start,
            head,
            f"convert {market_id[:10]}",
        )
        parsed = []
        for lg in logs:
            index_set = int(lg["topics"][3], 16)
            amount = decode_uint(lg["data"])
            parsed.append({
                "block": int(lg["blockNumber"], 16),
                "indexSet": index_set,
                "amount": amount,
            })
        convert_cache[market_id] = parsed
        print(f"  {len(parsed)} conversions")
        return parsed

    def replay_negrisk(m: dict, conversions: list[dict], question_count: int) -> dict:
        cid_topic = topic_bytes32(m["conditionId"])
        print(f"Fetching adapter split/merge/redeem for {m['name']}…")
        splits = get_logs(logs_rpc, ADAPTER, [TOPIC_NR_SPLIT, None, cid_topic], m["startBlock"], head, f"split {m['name']}")
        merges = get_logs(logs_rpc, ADAPTER, [TOPIC_NR_MERGE, None, cid_topic], m["startBlock"], head, f"merge {m['name']}")
        redeems = get_logs(logs_rpc, ADAPTER, [TOPIC_NR_REDEEM, None, cid_topic], m["startBlock"], head, f"redeem {m['name']}")
        split_amt = sum(decode_uint(lg["data"]) for lg in splits)
        merge_amt = sum(decode_uint(lg["data"]) for lg in merges)
        # PayoutRedemption data is ABI-encoded (uint256[] amounts, uint256 payout)
        redeem_payout = 0
        for lg in redeems:
            data = lg["data"]
            # amounts is a dynamic array: offset, then payout follows after? 
            # types: uint256[] amounts, uint256 payout
            # canonical: word0 = offset of amounts, word1 = payout, then amounts...
            redeem_payout += decode_uint(data, 32)

        bit = 1 << m["index"]
        minted = 0
        burned = 0
        convert_n = 0
        for ev in conversions:
            convert_n += 1
            if ev["indexSet"] & bit:
                burned += ev["amount"]
            else:
                minted += ev["amount"]

        net_split = split_amt - merge_amt
        # current #4 amount math (unresolved; no outcome reported)
        amount = net_split - redeem_payout + minted - burned
        yes = net_split + minted  # redemptions of YES would reduce this; none expected
        no = net_split - burned
        # If tokens were redeemed, we'd need amounts[] to know which side. 0 here.
        return {
            "splitCount": len(splits),
            "mergeCount": len(merges),
            "redeemCount": len(redeems),
            "convertCount": convert_n,
            "splitAmt": split_amt,
            "mergeAmt": merge_amt,
            "redeemPayout": redeem_payout,
            "minted": minted,
            "burned": burned,
            "amount": amount,
            "yesSupply": yes,
            "noSupply": no,
        }

    def replay_regular(m: dict) -> dict:
        cid_topic = topic_bytes32(m["conditionId"])
        parent0 = topic_bytes32("0x" + "00" * 32)
        print(f"Fetching CTF split/merge for {m['name']}…")
        # topics: sig, stakeholder, parentCollectionId, conditionId
        splits = get_logs(logs_rpc, CTF, [TOPIC_CTF_SPLIT, None, parent0, cid_topic], m["startBlock"], head, f"ctf split {m['name']}")
        merges = get_logs(logs_rpc, CTF, [TOPIC_CTF_MERGE, None, parent0, cid_topic], m["startBlock"], head, f"ctf merge {m['name']}")
        # only count USDC.e collateral: in data, first word is collateralToken (address)
        def ctf_amount_if_usdce(lg: dict) -> int:
            data = lg["data"].removeprefix("0x")
            # collateralToken (32), then offset to partition array, then amount? 
            # types: address collateralToken, uint256[] partition, uint256 amount
            # word0 = collateral, word1 = offset(partition), word2 = amount, then partition
            coll = "0x" + data[24:64]
            if coll.lower() != USDC_E.lower():
                return 0
            return int(data[128:192], 16)

        split_amt = sum(ctf_amount_if_usdce(lg) for lg in splits)
        merge_amt = sum(ctf_amount_if_usdce(lg) for lg in merges)
        net = split_amt - merge_amt
        return {
            "splitCount": len(splits),
            "mergeCount": len(merges),
            "redeemCount": 0,
            "convertCount": 0,
            "splitAmt": split_amt,
            "mergeAmt": merge_amt,
            "redeemPayout": 0,
            "minted": 0,
            "burned": 0,
            "amount": net,
            "yesSupply": net,
            "noSupply": net,
        }

    # question counts
    # from subgraph we know 128 / 128; confirm via QuestionPrepared count if needed
    qcount = {DEM_MARKET: 128, SENATE_MARKET: 128}

    # Load conversions (needed for several markets). Start from first question block.
    dem_convs = load_conversions(DEM_MARKET, 73_845_131)
    senate_convs = load_conversions(SENATE_MARKET, 96_231_923)

    results = []
    for m in MARKETS:
        if m["negRisk"]:
            convs = dem_convs if m["marketId"] == DEM_MARKET else senate_convs
            replayed = replay_negrisk(m, convs, qcount[m["marketId"]])
        else:
            replayed = replay_regular(m)
        m["replay"] = replayed

        p = m["gammaPriceYes"]
        yes = replayed["yesSupply"]
        no = replayed["noSupply"]
        priced = None
        if p is not None:
            priced = usd(yes) * p + usd(no) * (1.0 - p)
        api = m["apiOi"]
        priced_vs_api = None if priced is None or api is None else priced - float(api)

        # on-chain supply comparison
        # burned NO at burn address should be minted + burned (synthetic NO + converted NO)
        expected_no_burn = replayed["minted"] + replayed["burned"] if m["negRisk"] else 0
        row = {
            "name": m["name"],
            "conditionId": m["conditionId"],
            "negRisk": m["negRisk"],
            "block": head,
            "yesId": str(m["yesId"]),
            "noId": str(m["noId"]),
            "replay": {k: v for k, v in replayed.items()},
            "yesSupply_usd": usd(yes),
            "noSupply_usd": usd(no),
            "amount_usd": usd(replayed["amount"]),
            "gamma_p_yes": p,
            "priced_oi": priced,
            "api_oi": api,
            "priced_minus_api": priced_vs_api,
            "current_subgraph_amount_minus_api": None if api is None else usd(replayed["amount"]) - float(api),
            "onchain": {
                "yesTotal": m["yesTotal"],
                "noTotal": m["noTotal"],
                "yesBurn": m["yesBurn"],
                "noBurn": m["noBurn"],
                "yesCirc": m["yesCircOnchain"],
                "noCirc": m["noCircOnchain"],
                "expectedNoBurn": expected_no_burn,
                "noBurn_minus_expected": m["noBurn"] - expected_no_burn,
                "yesCirc_minus_replay": None if m["yesCircOnchain"] is None else m["yesCircOnchain"] - yes,
                "noCirc_minus_replay": None if m["noCircOnchain"] is None else m["noCircOnchain"] - no,
            },
        }
        results.append(row)
        print("====", m["name"], "====")
        print(json.dumps(row, indent=2, default=str))

    # (d) Dem event: sum(per-market amount) vs global OI change from event logs
    print("Replaying all Dem-nomination splits/merges for event-level sum…")
    # We already have conversions. For each of 128 questions we need net splits.
    # Fetch QuestionPrepared to list condition ids / indices, then split/merge per condition.
    qprep = get_logs(
        logs_rpc,
        ADAPTER,
        [TOPIC_NR_QPREP, topic_bytes32(DEM_MARKET)],
        73_845_000,
        head,
        "dem QuestionPrepared",
    )
    questions = []
    for lg in qprep:
        qid = "0x" + lg["topics"][2][2:].rjust(64, "0")[-64:]
        # data: index (uint256) then bytes data
        index = decode_uint(lg["data"], 0)
        questions.append({"questionId": qid, "index": index, "block": int(lg["blockNumber"], 16)})
    print(f"  {len(questions)} questions prepared (expected 128)")

    # derive condition ids via adapter.getConditionId
    for q in questions:
        raw = eth_call_data(
            rpc, ADAPTER, selector("getConditionId(bytes32)") + encode_bytes32(q["questionId"]), head
        )
        q["conditionId"] = "0x" + raw[-64:] if raw else None

    # Replay splits/merges for every Dem condition only if FULL_DEM_SPLITS=1.
    # Default: use RPC conversions + already-replayed test markets, and skip
    # the other ~120 questions' split history (tens of thousands of logs each).
    conv_released = 0
    for ev in dem_convs:
        k = ev["indexSet"].bit_count()
        if k > 1:
            conv_released += (k - 1) * ev["amount"]

    import os
    full_dem = os.environ.get("FULL_DEM_SPLITS") == "1"
    dem_market_amounts = []
    already = {m["conditionId"]: m["replay"] for m in MARKETS if m.get("replay") and m.get("marketId") == DEM_MARKET}
    if not full_dem:
        print("FULL_DEM_SPLITS not set: event sum uses RPC conversions + the Dem test markets already replayed.")
        print("  Per-event identity: sum(amount) - global_delta = sum(minted-burned) + collateral_released")
        # Still compute conversion-side totals across all 128 questions from RPC conversions + prepared questions
        total_minted = total_burned = 0
        for q in questions:
            bit = 1 << q["index"]
            start_b = q["block"]
            minted = burned = 0
            for ev in dem_convs:
                if ev["block"] < start_b:
                    continue
                if ev["indexSet"] & bit:
                    burned += ev["amount"]
                else:
                    minted += ev["amount"]
            total_minted += minted
            total_burned += burned
        # net splits from the replayed Dem test markets only, plus identity
        replayed_split = sum(already[c]["splitAmt"] - already[c]["mergeAmt"] for c in already)
        event_report = {
            "marketId": DEM_MARKET,
            "questionCount": len(questions),
            "conversionCount": len(dem_convs),
            "full_split_replay": False,
            "replayed_test_markets": list(already.keys()),
            "total_minted_usd": usd(total_minted),
            "total_burned_usd": usd(total_burned),
            "conv_released_usd": usd(conv_released),
            "identity_minted_minus_burned_plus_released_usd": usd(total_minted - total_burned + conv_released),
            "note": (
                "Per-market amount = net_splits + minted - burned. Global event delta = net_splits - (k-1)*amount. "
                "They do not tie on an unresolved event: sum(amount) - global_delta = sum(minted-burned) + collateral_released. "
                "This identity is computed from PositionsConverted logs alone (net_splits cancel)."
            ),
            "test_market_net_splits_usd": usd(replayed_split),
            "ties": False,
        }
        print("==== DEM EVENT RECONCILIATION ====")
        print(json.dumps(event_report, indent=2))
        report = {
            "block": head,
            "rpc_call": call_name, "rpc_logs": logs_name,
            "wcol": wcol,
            "burn": BURN,
            "markets": results,
            "dem_event": event_report,
        }
        out_path = out_dir / "results.json"
        out_path.write_text(json.dumps(report, indent=2, default=str))
        print(f"Wrote {out_path}")
        print("\nTABLE")
        for r in results:
            on = r["onchain"]
            print(
                f"{r['name'][:40]:40} "
                f"{r['amount_usd']:14,.2f} "
                f"{r['yesSupply_usd']:14,.2f} "
                f"{r['noSupply_usd']:14,.2f} "
                f"{(r['gamma_p_yes'] if r['gamma_p_yes'] is not None else float('nan')):8.4f} "
                f"{(r['priced_oi'] if r['priced_oi'] is not None else float('nan')):14,.2f} "
                f"{(float(r['api_oi']) if r['api_oi'] is not None else float('nan')):14,.2f} "
                f"{(r['priced_minus_api'] if r['priced_minus_api'] is not None else float('nan')):12,.2f} "
                f"{(r['current_subgraph_amount_minus_api'] if r['current_subgraph_amount_minus_api'] is not None else float('nan')):12,.2f} "
                f"{usd(on['noBurn_minus_expected']):10,.2f}"
            )
        return 0

    # Global delta from logs:
    # +split -merge -redeem - (k-1)*convert_amount  (feeBps=0)
    global_delta = 0
    # conversions contribution
    conv_released = 0
    for ev in dem_convs:
        # k = popcount of indexSet among existing questions at that time? 
        # The handler uses current e.questionCount, which grows over time.
        # For each conversion, k = bits set in indexSet (bits only valid for prepared questions).
        k = ev["indexSet"].bit_count()
        if k > 1:
            conv_released += (k - 1) * ev["amount"]
    # We'll add split-merge as we go

    total_split = 0
    total_merge = 0
    total_minted = 0
    total_burned = 0
    sum_amount = 0

    for i, q in enumerate(questions):
        cid = q["conditionId"]
        if cid in already:
            rpl = already[cid]
        else:
            cid_topic = topic_bytes32(cid)
            start_b = q["block"]
            splits = get_logs(logs_rpc, ADAPTER, [TOPIC_NR_SPLIT, None, cid_topic], start_b, head, f"dem split {i}")
            merges = get_logs(logs_rpc, ADAPTER, [TOPIC_NR_MERGE, None, cid_topic], start_b, head, f"dem merge {i}")
            split_amt = sum(decode_uint(lg["data"]) for lg in splits)
            merge_amt = sum(decode_uint(lg["data"]) for lg in merges)
            bit = 1 << q["index"]
            minted = burned = 0
            for ev in dem_convs:
                if ev["block"] < start_b:
                    continue  # question not yet prepared; should not appear in indexSet legally
                if ev["indexSet"] & bit:
                    burned += ev["amount"]
                else:
                    minted += ev["amount"]
            rpl = {
                "splitAmt": split_amt,
                "mergeAmt": merge_amt,
                "minted": minted,
                "burned": burned,
                "amount": split_amt - merge_amt + minted - burned,
                "splitCount": len(splits),
                "mergeCount": len(merges),
            }
            if (i + 1) % 8 == 0:
                print(f"  replayed {i+1}/{len(questions)} Dem markets")
        total_split += rpl["splitAmt"]
        total_merge += rpl["mergeAmt"]
        total_minted += rpl["minted"]
        total_burned += rpl["burned"]
        sum_amount += rpl["amount"]
        dem_market_amounts.append({"conditionId": cid, "index": q["index"], **{k: rpl[k] for k in ("splitAmt","mergeAmt","minted","burned","amount")}})

    global_delta = total_split - total_merge - conv_released
    # identity from earlier:
    # sum(amount) = sum(net_splits) + sum((n-2k)*A)  -- n changes over time, so use actual minted-burned
    # sum(amount) = (total_split-total_merge) + total_minted - total_burned
    # global_delta = (total_split-total_merge) - conv_released
    # difference = total_minted - total_burned + conv_released

    event_report = {
        "marketId": DEM_MARKET,
        "questionCount": len(questions),
        "conversionCount": len(dem_convs),
        "total_split_usd": usd(total_split),
        "total_merge_usd": usd(total_merge),
        "total_minted_usd": usd(total_minted),
        "total_burned_usd": usd(total_burned),
        "conv_released_usd": usd(conv_released),
        "sum_per_market_amount_usd": usd(sum_amount),
        "global_delta_from_logs_usd": usd(global_delta),
        "sum_minus_global_usd": usd(sum_amount - global_delta),
        "identity_minted_minus_burned_plus_released_usd": usd(total_minted - total_burned + conv_released),
        "ties": sum_amount == global_delta,
    }
    print("==== DEM EVENT RECONCILIATION ====")
    print(json.dumps(event_report, indent=2))

    report = {
        "block": head,
        "rpc_call": call_name, "rpc_logs": logs_name,
        "wcol": wcol,
        "burn": BURN,
        "markets": results,
        "dem_event": event_report,
    }
    out_path = out_dir / "results.json"
    out_path.write_text(json.dumps(report, indent=2, default=str))
    print(f"Wrote {out_path}")

    # Human table
    print("\nTABLE")
    hdr = f"{'market':40} {'amount':>14} {'yes':>14} {'no':>14} {'p_yes':>8} {'priced':>14} {'api':>14} {'priced-api':>12} {'amt-api':>12} {'noBurnΔ':>10}"
    print(hdr)
    for r in results:
        on = r["onchain"]
        print(
            f"{r['name'][:40]:40} "
            f"{r['amount_usd']:14,.2f} "
            f"{r['yesSupply_usd']:14,.2f} "
            f"{r['noSupply_usd']:14,.2f} "
            f"{(r['gamma_p_yes'] if r['gamma_p_yes'] is not None else float('nan')):8.4f} "
            f"{(r['priced_oi'] if r['priced_oi'] is not None else float('nan')):14,.2f} "
            f"{(float(r['api_oi']) if r['api_oi'] is not None else float('nan')):14,.2f} "
            f"{(r['priced_minus_api'] if r['priced_minus_api'] is not None else float('nan')):12,.2f} "
            f"{(r['current_subgraph_amount_minus_api'] if r['current_subgraph_amount_minus_api'] is not None else float('nan')):12,.2f} "
            f"{usd(on['noBurn_minus_expected']):10,.2f}"
        )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as e:
        # last-resort redaction
        print("FATAL:", type(e).__name__, str(e)[:500], file=sys.stderr)
        raise
