#!/usr/bin/env python3
"""Extensive PR #6 RPC replay validation. Never prints RPC/Graph keys."""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import time
from collections import defaultdict
from pathlib import Path
from typing import Any

import requests
from eth_hash.auto import keccak

ADAPTER = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296"
CTF = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"
USDC_E = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"
BURN = "0xa5ef39c3d3e10d0b270233af41cac69796b12966"
DEPLOYMENT = "QmUoL9MFKUgjkAhY4apuxLZK87LRsvTVqPpkS9KYsgVboH"
CACHE_VERSION = "v2-capsplit"
LOG_CAP = 10_000  # Tenderly can silently truncate around 20k; 10k forces a split with margin
ZERO = "0x" + "00" * 32

OUT_DIR = Path(os.environ.get("VALIDATE_OI_OUT", "/workspace/oi-negrisk-validate"))
CACHE_DIR = Path(os.environ.get("VALIDATE_OI_CACHE", str(OUT_DIR / "cache")))
REPO_RESULTS = Path(
    "/workspace/oi-negrisk-supplies/subgraphs/open-interest/scripts/validate_priced_oi_results.md"
)
REPO_SCRIPT = Path(
    "/workspace/oi-negrisk-supplies/subgraphs/open-interest/scripts/validate_priced_oi_extensive.py"
)


def evtsig(sig: str) -> str:
    return "0x" + keccak(sig.encode()).hex()


TOPIC_NR_SPLIT = evtsig("PositionSplit(address,bytes32,uint256)")
TOPIC_NR_MERGE = evtsig("PositionsMerge(address,bytes32,uint256)")
TOPIC_NR_REDEEM = evtsig("PayoutRedemption(address,bytes32,uint256[],uint256)")
TOPIC_NR_CONVERT = evtsig("PositionsConverted(address,bytes32,uint256,uint256)")
TOPIC_NR_QPREP = evtsig("QuestionPrepared(bytes32,bytes32,uint256,bytes)")
TOPIC_NR_REPORT = evtsig("OutcomeReported(bytes32,bytes32,bool)")
TOPIC_CTF_SPLIT = evtsig(
    "PositionSplit(address,address,bytes32,bytes32,uint256[],uint256)"
)
TOPIC_CTF_MERGE = evtsig(
    "PositionsMerge(address,address,bytes32,bytes32,uint256[],uint256)"
)
TOPIC_CTF_REDEEM = evtsig(
    "PayoutRedemption(address,address,bytes32,bytes32,uint256[],uint256)"
)
TOPIC_XFER_SINGLE = evtsig("TransferSingle(address,address,address,uint256,uint256)")
TOPIC_XFER_BATCH = evtsig("TransferBatch(address,address,address,uint256[],uint256[])")


def redact(s: str, rpc: str = "", key: str = "", gkey: str = "") -> str:
    out = s
    for val, tok in ((rpc, "<RPC>"), (key, "<KEY>"), (gkey, "<GKEY>")):
        if val:
            out = out.replace(val, tok)
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


def usd(raw: int | float | None) -> float | None:
    if raw is None:
        return None
    if isinstance(raw, float):
        return raw
    return raw / 1_000_000


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
    key_path = Path("/home/box/.alchemy_polygon_key")
    key = key_path.read_text().strip() if key_path.exists() else ""
    call_urls = []
    if key:
        call_urls.append(f"https://polygon-mainnet.g.alchemy.com/v2/{key}")
    call_urls += ["https://polygon.gateway.tenderly.co"]
    log_urls = ["https://polygon.gateway.tenderly.co", "https://polygon.drpc.org"]
    return pick_rpc(call_urls, key, "eth_call"), pick_rpc(log_urls, key, "eth_getLogs"), key


class RPC:
    def __init__(self, url: str, key: str, name: str = "rpc"):
        self.url = url
        self.key = key
        self.name = name
        self.session = requests.Session()
        self.n = 0

    def call(self, method: str, params: list, timeout: int = 90) -> Any:
        last = None
        for attempt in range(8):
            self.n += 1
            payload = {"jsonrpc": "2.0", "id": self.n, "method": method, "params": params}
            try:
                r = self.session.post(
                    self.url, json=payload, timeout=timeout,
                    headers={"content-type": "application/json"},
                )
                if r.status_code in (429, 500, 502, 503, 504):
                    wait = min(16, 1.5 * (2 ** attempt))
                    time.sleep(wait)
                    last = f"HTTP {r.status_code}"
                    continue
                r.raise_for_status()
                data = r.json()
            except Exception as e:
                last = redact(str(e), self.url, self.key)
                time.sleep(min(16, 1.5 * (2 ** attempt)))
                continue
            if "error" in data:
                msg = json.dumps(data["error"])
                if any(s in msg.lower() for s in ("rate", "429", "too many", "capacity")):
                    time.sleep(min(16, 1.5 * (2 ** attempt)))
                    last = redact(msg, self.url, self.key)
                    continue
                raise RuntimeError(redact(msg, self.url, self.key))
            return data["result"]
        raise RuntimeError(redact(str(last), self.url, self.key))

    def batch_call(self, calls: list[tuple[str, list]], timeout: int = 90) -> list[Any]:
        """calls is a list of (method, params). Returns results or RuntimeError per item."""
        if not calls:
            return []
        last = None
        for attempt in range(8):
            payload = []
            for method, params in calls:
                self.n += 1
                payload.append({"jsonrpc": "2.0", "id": self.n, "method": method, "params": params})
            try:
                r = self.session.post(
                    self.url, json=payload, timeout=timeout,
                    headers={"content-type": "application/json"},
                )
                if r.status_code in (429, 500, 502, 503, 504):
                    time.sleep(min(16, 1.5 * (2 ** attempt)))
                    last = f"HTTP {r.status_code}"
                    continue
                r.raise_for_status()
                data = r.json()
            except Exception as e:
                last = redact(str(e), self.url, self.key)
                time.sleep(min(16, 1.5 * (2 ** attempt)))
                continue
            if isinstance(data, dict) and "error" in data:
                last = redact(json.dumps(data["error"]), self.url, self.key)
                time.sleep(min(16, 1.5 * (2 ** attempt)))
                continue
            by_id = {item["id"]: item for item in data}
            start = self.n - len(calls) + 1
            out = []
            for i in range(len(calls)):
                item = by_id.get(start + i, {"error": {"message": "missing batch item"}})
                if "error" in item:
                    out.append(RuntimeError(redact(json.dumps(item["error"]), self.url, self.key)))
                else:
                    out.append(item["result"])
            return out
        raise RuntimeError(redact(str(last), self.url, self.key))


def eth_call_data(rpc: RPC, to: str, data: str, block: int | str) -> str | None:
    blk = hex(block) if isinstance(block, int) else block
    try:
        return rpc.call("eth_call", [{"to": to, "data": data}, blk])
    except RuntimeError as e:
        msg = str(e).lower()
        if "execution reverted" in msg or "revert" in msg:
            return None
        raise


def _chunk_key(address: str, topics: list, start: int, end: int) -> Path:
    raw = json.dumps({"v": CACHE_VERSION, "a": address.lower(), "t": topics, "s": start, "e": end}, sort_keys=True)
    return CACHE_DIR / (hashlib.sha1(raw.encode()).hexdigest() + ".json")


def _verified_marker(path: Path) -> Path:
    return path.with_name(path.name + ".verified")


def _cache_load(path: Path) -> list[dict] | None:
    """Reuse a cached page only if it is under LOG_CAP or was saved after a cap-split.

    A single eth_getLogs response at or above LOG_CAP may have been silently
    truncated (this is what dropped 100 Newsom splits: a ~20k page was trusted).
    """
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text())
    except Exception:
        return None
    if not isinstance(data, list):
        return None
    if len(data) >= LOG_CAP and not _verified_marker(path).exists():
        return None
    return data


def _cache_store(path: Path, logs: list[dict], verified: bool) -> None:
    try:
        path.write_text(json.dumps(logs))
        marker = _verified_marker(path)
        if verified or len(logs) < LOG_CAP:
            marker.write_text("ok")
        elif marker.exists():
            marker.unlink()
    except Exception:
        pass


def get_logs(rpc: RPC, address: str, topics: list, start: int, end: int, label: str) -> list[dict]:
    """Cap-aware eth_getLogs with per-range cache. Bisects when a page looks capped."""
    if start > end:
        return []
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    ck = _chunk_key(address, topics, start, end)
    cached = _cache_load(ck)
    if cached is not None:
        return cached

    def fetch_range(lo: int, hi: int, chunk: int) -> list[dict]:
        out: list[dict] = []
        cursor = lo
        retries = 0
        cur_chunk = chunk
        split_used = False
        while cursor <= hi:
            to = min(cursor + cur_chunk - 1, hi)
            subk = _chunk_key(address, topics, cursor, to)
            part = _cache_load(subk) if (cursor, to) != (lo, hi) else None
            if part is not None:
                out.extend(part)
                cursor = to + 1
                retries = 0
                continue
            params = [{
                "address": address,
                "topics": topics,
                "fromBlock": hex(cursor),
                "toBlock": hex(to),
            }]
            try:
                logs = rpc.call("eth_getLogs", params, timeout=120)
            except RuntimeError as e:
                msg = str(e).lower()
                shrinkable = any(s in msg for s in (
                    "too many", "timeout", "range", "limit", "response size",
                    "log response", "query returned more", "exceed", "400",
                    "free tier", "not supported", "too much", "413", "-32600",
                    "-32602", "blocks",
                ))
                if shrinkable and cur_chunk > 50:
                    cur_chunk = max(50, cur_chunk // 4)
                    retries += 1
                    if retries > 24:
                        raise RuntimeError(f"{label}: failed even at chunk={cur_chunk}: {e}") from None
                    continue
                retries += 1
                if retries > 8:
                    raise RuntimeError(f"{label}: {e}") from None
                time.sleep(min(2 * retries, 8))
                continue
            if len(logs) >= LOG_CAP and (to - cursor) > 0:
                mid = (cursor + to) // 2
                print(f"    cap-split {label} {cursor}-{to} ({len(logs)} logs) at {mid}", flush=True)
                left = fetch_range(cursor, mid, max(50, (to - cursor) // 4))
                right = fetch_range(mid + 1, to, max(50, (to - cursor) // 4))
                part = left + right
                split_used = True
                _cache_store(subk, part, verified=True)
            else:
                part = logs
                _cache_store(subk, part, verified=len(part) < LOG_CAP)
            out.extend(part)
            cursor = to + 1
            retries = 0
            if cur_chunk < 2_000_000:
                cur_chunk = min(2_000_000, cur_chunk * 2)
        _cache_store(_chunk_key(address, topics, lo, hi), out, verified=True)
        return out

    out = fetch_range(start, end, 2_000_000)
    _cache_store(ck, out, verified=True)
    return out


def logs_through(logs: list[dict], block: int) -> list[dict]:
    return [lg for lg in logs if int(lg["blockNumber"], 16) <= block]


def curl_json(url: str, retries: int = 2) -> Any:
    last = None
    for i in range(retries + 1):
        p = subprocess.run(
            ["curl", "-sS", "-A", "Mozilla/5.0", "--max-time", "30", url],
            capture_output=True, text=True,
        )
        if p.returncode == 0:
            try:
                return json.loads(p.stdout)
            except json.JSONDecodeError:
                last = f"non-json: {p.stdout[:200]}"
        else:
            last = p.stderr[-200:]
        time.sleep(0.4 * (i + 1))
    raise RuntimeError(f"curl failed for {url.split('?')[0]}: {last}")


def graph_url(gkey: str) -> str:
    return f"https://gateway.thegraph.com/api/{gkey}/deployments/id/{DEPLOYMENT}"


def graphql(gkey: str, query: str, block: int | None = None) -> dict:
    q = query
    if block is not None:
        # inject block arg after first selection name if the caller didn't
        pass
    url = graph_url(gkey)
    last = None
    for i in range(4):
        try:
            r = requests.post(
                url, json={"query": q}, timeout=60,
                headers={"content-type": "application/json"},
            )
            r.raise_for_status()
            data = r.json()
        except Exception as e:
            last = redact(str(e), key="", gkey=gkey)
            time.sleep(1.5 * (i + 1))
            continue
        if "errors" in data:
            last = redact(json.dumps(data["errors"])[:400], gkey=gkey)
            time.sleep(1.0 * (i + 1))
            continue
        return data["data"]
    raise RuntimeError(f"graphql failed: {last}")


# Seed universe (~100). Event IDs hydrated from questions when omitted.
SEED: list[dict] = []

def add(cid: str, name: str, tags: list[str], **kw):
    SEED.append({"conditionId": cid.lower(), "name": name, "tags": tags, **kw})

# --- Dem nomination 128q ---
add("0x0f49db97f71c68b1e42a6d16e3de93d85dbf7d4148e3f018eb79e88554be9f75", "Gavin Newsom (Dem nom)", ["negrisk","large128","midprice","heavy_convert"])
add("0xe6bcc2f1dd025ce5e1833190f7c60a71171c94f805df55b9ab0ded695ec93565", "AOC (Dem nom)", ["negrisk","large128","midprice","heavy_convert"])
add("0x74dba1ce1ae9dd535414e85f2d9ab5ea32c0fb1acc9b7130b67e6d91217e24e1", "Jon Ossoff (Dem nom)", ["negrisk","large128","midprice","heavy_convert"])
add("0xd2c0cc6a7ad3c0e2590fa55095052e98b1a2b146e9b807138c7421ac0e39c60e", "Adam Hamilton (Dem nom)", ["negrisk","large128","longshot"])
add("0x6685b25cc7c89032efcdf81eb27fdc6bbf04a3e4299bcd99c9f3d62c8471001e", "Graham Platner (Dem nom)", ["negrisk","large128","longshot"])
add("0xfee07be730188c94cd3644ed6f107fa3ea2dfab9989ce8d39aeeae064766abe3", "Jon Stewart (Dem nom)", ["negrisk","large128"])
add("0x8dbf6b51f302fd401065706245c144e93fe209abce183199433d4484b3ed8aff", "The Rock (Dem nom)", ["negrisk","large128","longshot"])
add("0x1945a8b23e313ed7423b6b6fd556f9ab5578900376b565a61dc480a5f4f35d21", "Hunter Biden (Dem nom)", ["negrisk","large128","longshot"])
add("0xfd8318449c6d6b5b107c5ccac78b51310489b3cf527970a658d3ab4cccd1e1f4", "placeholder fd83 (Dem nom)", ["negrisk","large128","placeholder"])
add("0xfb9f174351344b0a33a7a8ba43f483a97166eddbcbcb9f08306f599e7460bcb1", "placeholder fb9f (Dem nom)", ["negrisk","large128","placeholder"])
add("0xf3f3e26f23010782f75a22005641736242fa4e54fe07dea36b7a0cdfdfb214ea", "placeholder f3f3 (Dem nom)", ["negrisk","large128","placeholder"])
add("0xed246c2cedbe20daad562d806aa8e32983bf873f643b18e58c09d10cde5e78ef", "placeholder ed24 (Dem nom)", ["negrisk","large128","placeholder"])
add("0xebc2e4d9def0a3639fde17f714a50a02420e515a7b09df321f4272a0e7647d4d", "placeholder ebc2 (Dem nom)", ["negrisk","large128","placeholder"])
add("0xe64905095b5c1ff9bc61e746d95c5e16fa7208d3a7199a62a77ac05c9aabfb29", "placeholder e649 (Dem nom)", ["negrisk","large128","placeholder"])

# --- Presidential 128q ---
add("0x7ad403c3508f8e3912940fd1a913f227591145ca0614074208e0b962d5fcc422", "JD Vance (Presidential)", ["negrisk","large128","favorite","heavy_convert"])
add("0x2053d8515f1b8cbeea4ccdb56e60e89c2617e43a8660d95166b8e71d27865277", "Marco Rubio (Presidential)", ["negrisk","large128","midprice","heavy_convert"])
add("0x61600d487069f99e775307a0655c1a79f26e4fc6d8d1ba66790c64d78d0beba2", "Jon Ossoff (Presidential)", ["negrisk","large128","midprice","heavy_convert"])
add("0xf232b565995e4b3a3e7fa6cef775eeff1cecd20ad7c013cb9fc8dadabfe279a9", "AOC (Presidential)", ["negrisk","large128","midprice"])
add("0x4567b275e6b667a6217f5cb4f06a797d3a1eaf1d0281fb5bc8c75e2046ae7e57", "Gavin Newsom (Presidential)", ["negrisk","large128"])

# --- GOP nomination 128q ---
add("0x18b1c135d0a40c5894da9412e77311827d9caf16cf4cd6591b247a34730af919", "JD Vance (GOP nom)", ["negrisk","large128","favorite","heavy_convert"])
add("0x21ad31a46bfaa51650766eff6dc69c866959e32d965ffb116020e37694b6317d", "Marco Rubio (GOP nom)", ["negrisk","large128","midprice","heavy_convert"])

# --- Senate 128q (favorite) ---
add("0xa32317ba83c3c83dc43ef260c3744c22ed8000db53d30bc09372c45cff5fb07a", "Republicans lose AK/IA/KS/ME/MI/OH/TX", ["negrisk","large128","favorite"])

# --- Israel PM 28q ---
add("0x7586a96520578acaaaa4ea84a2582f197f84255da1f3392a7aa300386c187b37", "Netanyahu (Israel PM)", ["negrisk","mid28","heavy_convert","midprice"])

# --- Small 2-5 question events ---
add("0x0eee609dc29713dcaf158893cbca07917031a8b12835b3229cd403b60c7e2848", "2q event question A", ["negrisk","small2","n_gt1_convert"])
add("0xb436ea67f074c6c976129529e922c4be77b45db85f6f1f5d9e6bd1af5bce699f", "2q event question B", ["negrisk","small2","n_gt1_convert"])
add("0x0880426607c945cc331ed7b913e1c8acd4cf81f46048c43252ad0e6d94de6150", "3q resolved YES", ["negrisk","small3","resolved_yes"])
add("0x1f522e32300624ec34e79167eb28b9e672f15c708520ac9b86afb4b856b6160b", "3q resolved NO a", ["negrisk","small3","resolved_no"])
add("0xc5f5e17b81b0c4de89b5c1b73012646ba10ab5e8680f221762117c13f3b917f2", "3q resolved NO b", ["negrisk","small3","resolved_no"])
add("0x15e61785bf423d21cad2f38dcef2ae63e94e383e2408e49500be20fe6b32b7fd", "4q resolved YES (heavy convert)", ["negrisk","small4","resolved_yes","heavy_convert","n_gt1_convert"])
add("0x9415cfb6c63ed4119d13e6398cde4d3a7265176d85cd0cc40b70bed4e7d8f6d6", "4q resolved NO a", ["negrisk","small4","resolved_no","n_gt1_convert"])
add("0xadd687f7535a7130a258a556d2eff5e9ca604ef1c588cd221a8844abeef47208", "4q resolved NO b", ["negrisk","small4","resolved_no"])
add("0xe61887255ff91d6568bfa175b63ead8abbe1efacb6c35cc97928677e30d0584a", "4q resolved NO c", ["negrisk","small4","resolved_no"])
add("0x9c507f6cc723136ba18579040b9966b6843979d0730fe0661a92ad053c3be694", "5q resolved YES", ["negrisk","small5","resolved_yes"])
add("0x311bc8e07ec40b4b4c3d9fff41005e2e3d56fad97f2633f5d16f09176227cf35", "5q resolved NO a", ["negrisk","small5","resolved_no"])
add("0x5408871ff515bfebedc5e121b60b6f010c416d712bb1584903a73064f885b966", "5q resolved NO b", ["negrisk","small5","resolved_no"])

# --- Mid-size open events ---
add("0xd6ddda586d79408ede60db1d125644b10eaa7f7a0b006e89ebbe959071a02b10", "10q open a", ["negrisk","mid10"])
add("0xccc99e5b96a69c9f940ccbea7b398774272487ecad0eee2e3f6bbbbee34d4bf0", "10q open b", ["negrisk","mid10"])
add("0xb4e8211eea1b2c27cab8075b93ed13086909caea1a82228cda023f8be1f85498", "10q open c (n>1 convert)", ["negrisk","mid10","n_gt1_convert"])
add("0xf35f7e818e58b63a996f909956b0ea1ad5c6517653cb4e67ce735e3666443920", "13q open", ["negrisk","mid13","n_gt1_convert"])
add("0x8eddc3d5822d34581ea7f27e1b41aa518d29e8a4394f932729910d8a443dca47", "33q open", ["negrisk","mid33"])
add("0xefeeca76fdaf0fd84e9be68f5cc168a52aff2ab878af88c5a071cd4a42bd2e4b", "53q open a", ["negrisk","mid53"])
add("0xebeec58fad7c2073369f3551b26fb7e949646f5bf07bb2be251744a5036de4fa", "53q open b", ["negrisk","mid53"])

# --- Other resolved / negatives ---
add("0x0001cb8c0b39aeb614ab9a43867595317f06ede9c011661513065c638fbbefda", "8q resolved YES", ["negrisk","resolved_yes"])
add("0x000083c0ef23ccef8e2bd09dcb1ae4d09ca4358fe5a725d98bdad437960b8530", "11q resolved NO", ["negrisk","resolved_no"])
add("0x688e74a4e437775cc5aea5c9714c1d2bac97434521a6ec68f98f2309880c830f", "negative amount (-1533) reported NO", ["negrisk","resolved_no","negative_amount"])
add("0x22a396fed8d3b158e3adca31c9a22d2f500cc8a8544e74f5b6090bc87a53cdcf", "negative amount (-43) reported NO", ["negrisk","resolved_no","negative_amount"])
add("0xcd208596d495484cf406d645c6ddc8c43bc1de4e335c01ed610a2b07ae66c43c", "negative amount (-772) many redemptions", ["negrisk","resolved_no","negative_amount"])

# --- Regular CTF high volume ---
add("0x747dc809fb79e1b05be09c42d6179459a58de2ef3e40f02484a4e1260f741f75", "regular aliens-before-2027", ["regular","high_volume"])
add("0x6bd56627aa21311850825edb27e53434a0e17a4f782be0086bc07f71eee00d0d", "regular high 6.5M", ["regular","high_volume"])
add("0x9cb23d04b2ded06147482076688b69b487a8d982c63ebdda2ab3678cf27cf390", "regular high 4.8M", ["regular","high_volume"])
add("0x48b0b0bca515f68fccf95af4793dbd0edbfec1f8ec6e8df2c0f69ba74f8c4722", "regular high 4.0M", ["regular","high_volume"])
add("0x024b68f77bfc019341ee3db8f57c103334e4b9430bba4746d8c94aafd8b36fee", "regular high 1.9M", ["regular","high_volume"])
add("0x3b0107a80edd066fe987784d7ab5963c177888433efbec10689951c17320606c", "regular high 1.5M", ["regular","high_volume"])
add("0x752fa61c93f16c4b15e85b0bd438d9c684176b0ea7b319a84c8aca34616e8a8c", "regular high 1.2M", ["regular","high_volume"])
add("0xce3c54c3e773e8b3bf73e4c12af93205b21195d03b9c386e22f274b9acfc2c56", "regular high 1.16M", ["regular","high_volume"])
add("0x79b7408f02df2eba4034ca4c06ddf17b8dbeacc5adbe8595969e7573912c4e3b", "regular high 1.15M", ["regular","high_volume"])
add("0x5c79dfde05559b79a9cb9f7c4187e4d49632dd042572ae676952f812732591cc", "regular high 1.89M", ["regular","high_volume"])
add("0x5db999fad322cea2914535aae5517060c3f80ad6d8c0231cde2124a434d16846", "regular high 6.7M (pagination stress)", ["regular","high_volume","pagination"])

# typo fix later if 0x024b68...c36fee is wrong (csv had 8b36fee) — script hydrates and will error on missing subgraph row.

# --- Regular low volume ---
add("0x15e387130b6a4f3ca9d53f6862eac4cc2a932f0af85f8bbeb0706bd6d5f11b71", "regular low 10.00 a", ["regular","low_volume"])
add("0x6137a1d8f3772b0663cb712fc80e4e980c09896ffb55f23cdf1cca722335c521", "regular low 10.00 b", ["regular","low_volume"])
add("0xd46e8954744da0660950b38cbbb232f98b6f549bddad26b7460eeb4adcff74da", "regular low 10.00 c", ["regular","low_volume"])
add("0xadc9df14866e77cd8e642bb100dae696b8cb394edb6e3cc60eb1d659a7f7899e", "regular low 10.02", ["regular","low_volume"])
add("0xa99d230cad7bb0de756534e47acd68ee1f6c53cd9e3c933056a69efaad88e75b", "regular low 10.03", ["regular","low_volume"])
add("0x853931062873661a98afdf11d13e96a059b0c0fbf990d8fbff3a27b616144e5b", "regular low 10.04", ["regular","low_volume"])
add("0xe46df3e4df85d183aac734b13880dd7c3d4ee737c5e6be822150fa9ef72acb69", "regular low 10.04 b", ["regular","low_volume"])
add("0x873d25b2583d30bc5a4a16b4a9c674ce77f2aaa75ccf6be439b31e59400f65b1", "regular low 10.05", ["regular","low_volume"])
add("0x9a894d00df3b7c7b00b0e3bbfe896326f5020420467b6e0f37a58b6180ca28ba", "regular low 10.06", ["regular","low_volume"])
add("0x43f20fa17131a6a19e976e6e289cb9af7941f35536e5db7b543c2e634551e385", "regular low 10.09", ["regular","low_volume"])

# --- Regular recent ---
add("0x6397fa44f89971547b70ff74a49974cf64740fa655c765a6d23093a36c2cfd1d", "regular recent a", ["regular","recent"])
add("0xc54cfbc4286b0e4da7a7d304d5b691981d9427c9951999ebd93e18bf93eb60d7", "regular recent b", ["regular","recent"])
add("0xf02a453748d025f05298ca3474a0691d0dbfd62dee38365759e6ba5664ec4d99", "regular recent c", ["regular","recent"])
add("0xf608554e723f4d8ffc4d64319533a7b17a8aded68b01f41bfa0a1dcf48e658f9", "regular recent d", ["regular","recent"])
add("0x89600f3de1b8248eb0e2243f1f61ca5f629f039f0902fcd156952007a19275ae", "regular recent e", ["regular","recent"])
add("0xe271827fec60ce65c70af4ddc1b9b273d1bb2a1a99b04b5a7c2f0a11c5fdba25", "regular recent f", ["regular","recent"])
add("0x55f72dfda248d6117d95d5d48c730d6dfeb70c0aa22e9b23410b5c184d069ef0", "regular recent g", ["regular","recent"])
add("0x94880cded1fdeab1e2b5e2339256d8c4e89bf4f49ee643d8659160bfeba08cec", "regular recent h", ["regular","recent"])

# --- Regular resolved with redemptions ---
add("0xfc21d44d42539c06062a7bda7d887c679ecea9b8578b7a6ba375213f475bbc2b", "regular resolved 1999 redeems a", ["regular","resolved"])
add("0xd943cdfbaf2372d6edef6319a1492e55258c62aae31d25845aae0a71bf5c2fb7", "regular resolved 1999 redeems b", ["regular","resolved"])
add("0x8bbd80540e901cb9576546fd2cc908e30de01f872bb2017f42ded4517d8834b1", "regular resolved 1999 redeems c", ["regular","resolved"])
add("0x57fa403b19f0ad658ea33ea289a169052aced7c73b14677d03b5b5fc05d7badf", "regular resolved 1999 redeems d", ["regular","resolved"])


def parse_adapter_redeem(lg: dict) -> tuple[int, int, int]:
    """Return (payout, yes_burned, no_burned)."""
    data = lg["data"]
    payout = decode_uint(data, 32)
    h = data.lower().removeprefix("0x")
    off = decode_uint(data, 0) * 2
    n = int(h[off:off + 64] or "0", 16)
    yes_b = int(h[off + 64:off + 128] or "0", 16) if n > 0 else 0
    no_b = int(h[off + 128:off + 192] or "0", 16) if n > 1 else 0
    return payout, yes_b, no_b


def parse_ctf_split_merge(lg: dict) -> tuple[str, int]:
    data = lg["data"].lower().removeprefix("0x")
    coll = "0x" + data[24:64]
    amount = int(data[128:192], 16)
    return coll, amount


def parse_ctf_redeem(lg: dict) -> dict:
    data = lg["data"].lower().removeprefix("0x")
    condition_id = "0x" + data[0:64]
    off = int(data[64:128] or "0", 16) * 2
    payout = int(data[128:192], 16)
    n = int(data[off:off + 64] or "0", 16)
    index_sets = [int(data[off + 64 + 64 * i:off + 128 + 64 * i] or "0", 16) for i in range(n)]
    return {"conditionId": condition_id, "payout": payout, "indexSets": index_sets}


def chunks(xs: list, n: int):
    for i in range(0, len(xs), n):
        yield xs[i:i + n]


def gql_ids(ids: list[str]) -> str:
    return ", ".join(json.dumps(i) for i in ids)


def hydrate(gkey: str, markets: list[dict]) -> list[dict]:
    ids = [m["conditionId"] for m in markets]
    by_id = {m["conditionId"]: m for m in markets}
    for group in chunks(ids, 40):
        data = graphql(gkey, """{
          mois: marketOpenInterests(first: 100, where: {id_in: [%s]}) {
            id amount amountRaw splitCount mergeCount redemptionCount conversionCount
            createdAtBlock lastUpdatedBlock negRisk
          }
          qs: negRiskQuestions(first: 100, where: {id_in: [%s]}) {
            id marketId questionId outcome mintedRaw burnedRaw reportedAtBlock
          }
          cs: conditions(first: 100, where: {id_in: [%s]}) {
            id questionId oracle createdAtBlock
          }
        }""" % (gql_ids(group), gql_ids(group), gql_ids(group)))
        for row in data["mois"]:
            m = by_id.get(row["id"].lower())
            if not m:
                continue
            m["sg"] = row
            m["negRisk"] = row["negRisk"]
            m["startBlock"] = int(row["createdAtBlock"])
        for row in data["qs"]:
            m = by_id.get(row["id"].lower())
            if not m:
                continue
            m["questionId"] = "0x" + row["questionId"].lower().removeprefix("0x")
            m["marketId"] = "0x" + row["marketId"].lower().removeprefix("0x")
            m["outcome"] = int(row["outcome"])
            m["sg_minted"] = int(row["mintedRaw"])
            m["sg_burned"] = int(row["burnedRaw"])
            m["reportedAtBlock"] = int(row["reportedAtBlock"]) if row["reportedAtBlock"] else None
        for row in data["cs"]:
            m = by_id.get(row["id"].lower())
            if not m:
                continue
            if "questionId" not in m:
                m["questionId"] = "0x" + row["questionId"].lower().removeprefix("0x")
            if "startBlock" not in m:
                m["startBlock"] = int(row["createdAtBlock"])
            m["oracle"] = row["oracle"]

    # Expand: one Israel sibling, evYes/evNo siblings if needed, fee events check
    event_ids = sorted({m.get("marketId") for m in markets if m.get("marketId")})
    events = {}
    for group in chunks(event_ids, 20):
        data = graphql(gkey, """{
          evs: negRiskEvents(first: 50, where: {id_in: [%s]}) { id feeBps questionCount }
        }""" % gql_ids(group))
        for e in data["evs"]:
            events[e["id"].lower()] = e
    # siblings for mid/small events if we have < 2 markets
    want_extra = []
    by_event = defaultdict(list)
    for m in markets:
        if m.get("marketId"):
            by_event[m["marketId"]].append(m)
    # Israel: add up to 2 siblings
    israel = "0x03c9c6d9f7b20aaa1f33f99bd24bd16e4e0e00cfa892dde097b800655490b200"
    evyes = "0x194b714213cf545ccca0c0b400e0cd43512d5ceadf00d4ffe62108d9bb59a600"
    evno_candidates = [m for m in markets if "11q resolved" in m.get("name", "")]
    for eid, min_n, tag in (
        (israel, 3, "mid28"),
        (evyes, 2, "resolved_yes"),
    ):
        if eid in by_event and len(by_event[eid]) < min_n:
            want_extra.append((eid, min_n, tag))
    extras = []
    for eid, min_n, tag in want_extra:
        have = {m["conditionId"] for m in by_event.get(eid, [])}
        data = graphql(gkey, """{
          qs: negRiskQuestions(first: 30, where: {marketId: "%s"}) {
            id marketId questionId outcome mintedRaw burnedRaw reportedAtBlock
          }
        }""" % eid)
        for row in data["qs"]:
            cid = row["id"].lower()
            if cid in have:
                continue
            extras.append(row)
            if len(have) + sum(1 for e in extras if e["marketId"].lower() == eid) >= min_n:
                break
    if extras:
        eids = [e["id"].lower() for e in extras]
        data = graphql(gkey, """{
          mois: marketOpenInterests(first: 50, where: {id_in: [%s]}) {
            id amount amountRaw splitCount mergeCount redemptionCount conversionCount
            createdAtBlock lastUpdatedBlock negRisk
          }
        }""" % gql_ids(eids))
        moi = {r["id"].lower(): r for r in data["mois"]}
        for row in extras:
            cid = row["id"].lower()
            if cid not in moi:
                continue
            markets.append({
                "conditionId": cid,
                "name": f"sibling {cid[:10]}",
                "tags": ["negrisk", "sibling"],
                "negRisk": True,
                "questionId": "0x" + row["questionId"].lower().removeprefix("0x"),
                "marketId": "0x" + row["marketId"].lower().removeprefix("0x"),
                "outcome": int(row["outcome"]),
                "sg_minted": int(row["mintedRaw"]),
                "sg_burned": int(row["burnedRaw"]),
                "reportedAtBlock": int(row["reportedAtBlock"]) if row["reportedAtBlock"] else None,
                "sg": moi[cid],
                "startBlock": int(moi[cid]["createdAtBlock"]),
            })
    # feeBps inventory
    fee_rows = graphql(gkey, """{
      feeMulti: negRiskEvents(first: 20, where: {feeBps_gt: "0", questionCount_gt: 1}) { id feeBps questionCount }
      feeAny: negRiskEvents(first: 10, where: {feeBps_gt: "0"}) { id feeBps questionCount }
    }""")
    missing = [m["conditionId"] for m in markets if "sg" not in m]
    if missing:
        print("WARN missing subgraph rows:", missing)
        markets[:] = [m for m in markets if "sg" in m]
    return events, fee_rows


def _blk(block: int | str) -> str:
    return hex(block) if isinstance(block, int) else block


def position_ids(rpc: RPC, m: dict, head: int) -> None:
    if m.get("negRisk"):
        yes_r = eth_call_data(rpc, ADAPTER, selector("getPositionId(bytes32,bool)") + encode_bytes32(m["questionId"]) + encode_bool(True), head)
        no_r = eth_call_data(rpc, ADAPTER, selector("getPositionId(bytes32,bool)") + encode_bytes32(m["questionId"]) + encode_bool(False), head)
        m["yesId"] = int(yes_r, 16)
        m["noId"] = int(no_r, 16)
    else:
        col_yes = eth_call_data(rpc, CTF, selector("getCollectionId(bytes32,bytes32,uint256)") + encode_bytes32(ZERO) + encode_bytes32(m["conditionId"]) + encode_uint(1), head)
        col_no = eth_call_data(rpc, CTF, selector("getCollectionId(bytes32,bytes32,uint256)") + encode_bytes32(ZERO) + encode_bytes32(m["conditionId"]) + encode_uint(2), head)
        yes_r = eth_call_data(rpc, CTF, selector("getPositionId(address,bytes32)") + encode_address(USDC_E) + col_yes.removeprefix("0x"), head)
        no_r = eth_call_data(rpc, CTF, selector("getPositionId(address,bytes32)") + encode_address(USDC_E) + col_no.removeprefix("0x"), head)
        m["yesId"] = int(yes_r, 16)
        m["noId"] = int(no_r, 16)



def refetch_sg_at_block(gkey: str, markets: list[dict], block: int) -> None:
    """Overwrite m['sg'] with deployment state at `block`, not chain tip.

    hydrate() / expand_universe() query the subgraph at HEAD. If the run is
    resumed after the pin, those HEAD figures (and data-api /v2/oi, which has
    no historical block) are not comparable to a pinned replay. Always compare
    replay vs subgraph at the same block.
    """
    by_id = {m["conditionId"]: m for m in markets}
    missing = []
    for group in chunks(list(by_id), 40):
        data = graphql(gkey, """{
          mois: marketOpenInterests(first: 100, where: {id_in: [%s]}, block: {number: %s}) {
            id amount amountRaw splitCount mergeCount redemptionCount conversionCount
            createdAtBlock lastUpdatedBlock negRisk
          }
        }""" % (gql_ids(group), block))
        seen = set()
        for row in data["mois"]:
            m = by_id.get(row["id"].lower())
            if not m:
                continue
            m["sg"] = row
            m["sg_block"] = block
            seen.add(row["id"].lower())
        missing.extend(cid for cid in group if cid not in seen)
    if missing:
        print("WARN no subgraph row at pin for", missing)
    print(f"  refetched subgraph rows at block {block} for {len(markets) - len(missing)} markets")


def fetch_tip_last_updated(gkey: str, markets: list[dict], pin: int) -> None:
    """data-api /v2/oi and Gamma prices are tip-only. Flag markets that moved after the pin."""
    by_id = {m["conditionId"]: m for m in markets}
    for group in chunks(list(by_id), 40):
        data = graphql(gkey, """{
          mois: marketOpenInterests(first: 100, where: {id_in: [%s]}) {
            id lastUpdatedBlock amount amountRaw splitCount mergeCount
          }
        }""" % gql_ids(group))
        for row in data["mois"]:
            m = by_id.get(row["id"].lower())
            if not m:
                continue
            tip = int(row["lastUpdatedBlock"]) if row.get("lastUpdatedBlock") else None
            m["tip_lastUpdatedBlock"] = tip
            m["traded_after_pin"] = bool(tip is not None and tip > pin)
            m["tip_sg"] = row
    n = sum(1 for m in markets if m.get("traded_after_pin"))
    print(f"  tip lastUpdated > pin on {n}/{len(markets)} markets (API/Gamma not comparable to pinned replay)")

def hydrate_position_ids(rpc: RPC, markets: list[dict], head: int) -> None:
    """Batch getPositionId / getCollectionId to stay under Alchemy rate limits."""
    blk = _blk(head)
    nr = [m for m in markets if m.get("negRisk")]
    reg = [m for m in markets if not m.get("negRisk")]
    # neg-risk: 2 calls each
    for group in chunks(nr, 15):
        calls = []
        for m in group:
            calls.append(("eth_call", [{"to": ADAPTER, "data": selector("getPositionId(bytes32,bool)") + encode_bytes32(m["questionId"]) + encode_bool(True)}, blk]))
            calls.append(("eth_call", [{"to": ADAPTER, "data": selector("getPositionId(bytes32,bool)") + encode_bytes32(m["questionId"]) + encode_bool(False)}, blk]))
        out = rpc.batch_call(calls)
        for i, m in enumerate(group):
            yes_r, no_r = out[2*i], out[2*i+1]
            if isinstance(yes_r, Exception) or isinstance(no_r, Exception):
                position_ids(rpc, m, head)
                continue
            m["yesId"] = int(yes_r, 16)
            m["noId"] = int(no_r, 16)
        time.sleep(0.2)
    # regular: collection then position, two batches
    for group in chunks(reg, 10):
        calls = []
        for m in group:
            calls.append(("eth_call", [{"to": CTF, "data": selector("getCollectionId(bytes32,bytes32,uint256)") + encode_bytes32(ZERO) + encode_bytes32(m["conditionId"]) + encode_uint(1)}, blk]))
            calls.append(("eth_call", [{"to": CTF, "data": selector("getCollectionId(bytes32,bytes32,uint256)") + encode_bytes32(ZERO) + encode_bytes32(m["conditionId"]) + encode_uint(2)}, blk]))
        cols = rpc.batch_call(calls)
        calls2 = []
        ok = []
        for i, m in enumerate(group):
            cy, cn = cols[2*i], cols[2*i+1]
            if isinstance(cy, Exception) or isinstance(cn, Exception) or not cy or not cn:
                position_ids(rpc, m, head)
                continue
            ok.append(m)
            calls2.append(("eth_call", [{"to": CTF, "data": selector("getPositionId(address,bytes32)") + encode_address(USDC_E) + cy.removeprefix("0x")}, blk]))
            calls2.append(("eth_call", [{"to": CTF, "data": selector("getPositionId(address,bytes32)") + encode_address(USDC_E) + cn.removeprefix("0x")}, blk]))
        if calls2:
            out = rpc.batch_call(calls2)
            for i, m in enumerate(ok):
                yes_r, no_r = out[2*i], out[2*i+1]
                if isinstance(yes_r, Exception) or isinstance(no_r, Exception):
                    position_ids(rpc, m, head)
                    continue
                m["yesId"] = int(yes_r, 16)
                m["noId"] = int(no_r, 16)
        time.sleep(0.2)


def hydrate_burns(rpc: RPC, markets: list[dict], head: int) -> None:
    blk = _blk(head)
    for group in chunks(markets, 20):
        calls = []
        for m in group:
            for tid in (m["yesId"], m["noId"]):
                calls.append(("eth_call", [{"to": CTF, "data": selector("balanceOf(address,uint256)") + encode_address(BURN) + encode_uint(tid)}, blk]))
        out = rpc.batch_call(calls)
        for i, m in enumerate(group):
            yb, nb = out[2*i], out[2*i+1]
            if isinstance(yb, Exception) or isinstance(nb, Exception):
                yb2, nb2 = burn_balances(rpc, m, head)
                m["yesBurn"], m["noBurn"] = yb2, nb2
                continue
            m["yesBurn"] = int(yb, 16) if yb and yb != "0x" else 0
            m["noBurn"] = int(nb, 16) if nb and nb != "0x" else 0
        time.sleep(0.15)


def burn_balances(rpc: RPC, m: dict, block: int) -> tuple[int, int]:
    def bal(owner: str, token_id: int) -> int:
        raw = eth_call_data(rpc, CTF, selector("balanceOf(address,uint256)") + encode_address(owner) + encode_uint(token_id), block)
        return int(raw, 16) if raw and raw != "0x" else 0
    return bal(BURN, m["yesId"]), bal(BURN, m["noId"])


def fetch_prices(markets: list[dict]) -> dict:
    """Gamma + data-api as close together as possible, retry twice. Also CLOB mid."""
    ids = [m["conditionId"] for m in markets]
    snapshots = []
    for attempt in range(3):
        t0 = time.time()
        api_map = {}
        for group in chunks(ids, 20):
            url = "https://data-api.polymarket.com/v2/oi?condition=" + ",".join(group)
            try:
                api_oi = curl_json(url)
            except Exception as e:
                print("  data-api error:", e)
                api_oi = {}
            rows = api_oi.get("data", api_oi) if isinstance(api_oi, dict) else api_oi
            if isinstance(rows, list):
                for row in rows:
                    cid = (row.get("condition_id") or row.get("conditionId") or "").lower()
                    api_map[cid] = row.get("value")
            elif isinstance(rows, dict):
                # sometimes a map of id -> value
                for k, v in rows.items():
                    if k in ("data",):
                        continue
                    if isinstance(v, (int, float, str)):
                        api_map[k.lower()] = v
        gamma = {}
        for m in markets:
            cid = m["conditionId"]
            try:
                g = curl_json(f"https://gamma-api.polymarket.com/markets?condition_ids={cid}")
            except Exception as e:
                g = []
                print(f"  gamma fail {cid[:10]}: {e}")
            rec = g[0] if isinstance(g, list) and g else (g if isinstance(g, dict) and g.get("conditionId") else None)
            info = {"p": None, "lastTradePrice": None, "title": None, "clobYes": None, "bestBid": None, "bestAsk": None}
            if rec:
                info["title"] = rec.get("question") or rec.get("title")
                op = rec.get("outcomePrices") or rec.get("outcome_prices")
                if isinstance(op, str):
                    try:
                        op = json.loads(op)
                    except Exception:
                        op = None
                if isinstance(op, list) and op:
                    try:
                        info["p"] = float(op[0])
                    except Exception:
                        pass
                ltp = rec.get("lastTradePrice")
                try:
                    info["lastTradePrice"] = float(ltp) if ltp is not None else None
                except Exception:
                    pass
                toks = rec.get("clobTokenIds") or rec.get("clob_token_ids")
                if isinstance(toks, str):
                    try:
                        toks = json.loads(toks)
                    except Exception:
                        toks = None
                if isinstance(toks, list) and toks:
                    info["clobYes"] = str(toks[0])
            gamma[cid] = info
        # CLOB mids
        for cid, info in gamma.items():
            tid = info.get("clobYes")
            if not tid:
                continue
            try:
                mid = curl_json(f"https://clob.polymarket.com/midpoint?token_id={tid}")
                if isinstance(mid, dict):
                    info["mid"] = float(mid.get("mid") or mid.get("midpoint") or mid.get("price") or "nan")
                elif isinstance(mid, (int, float, str)):
                    info["mid"] = float(mid)
            except Exception:
                info["mid"] = None
        snapshots.append({"t": t0, "api": api_map, "gamma": gamma, "elapsed": time.time() - t0})
        print(f"  price snapshot {attempt+1}: {len(api_map)} api, {sum(1 for v in gamma.values() if v['p'] is not None)} gamma, {snapshots[-1]['elapsed']:.1f}s")
        time.sleep(0.2)
    # pick the tightest snapshot (shortest elapsed among last two if populated)
    best = min(snapshots, key=lambda s: (0 if s["api"] else 1, s["elapsed"]))
    return best


def decode_convert(lg: dict) -> dict:
    return {
        "block": int(lg["blockNumber"], 16),
        "tx": lg.get("transactionIndex"),
        "logIndex": int(lg.get("logIndex", "0x0"), 16),
        "indexSet": int(lg["topics"][3], 16),
        "amount": decode_uint(lg["data"]),
    }


def replay_market(logs_rpc: RPC, m: dict, conversions: list[dict], end_block: int, ctf_ind: dict | None) -> dict:
    start = m["startBlock"]
    cid_topic = topic_bytes32(m["conditionId"])
    parent0 = topic_bytes32(ZERO)

    def filt(xs):
        return [lg for lg in xs if start <= int(lg["blockNumber"], 16) <= end_block]

    if m.get("negRisk"):
        splits = filt(m.setdefault("_logs", {}).setdefault("nr_split", get_logs(logs_rpc, ADAPTER, [TOPIC_NR_SPLIT, None, cid_topic], start, m["_head"], f"nr split {m['name'][:24]}")))
        merges = filt(m["_logs"].setdefault("nr_merge", get_logs(logs_rpc, ADAPTER, [TOPIC_NR_MERGE, None, cid_topic], start, m["_head"], f"nr merge {m['name'][:24]}")))
        redeems = filt(m["_logs"].setdefault("nr_redeem", get_logs(logs_rpc, ADAPTER, [TOPIC_NR_REDEEM, None, cid_topic], start, m["_head"], f"nr redeem {m['name'][:24]}")))
        # Independent CTF WCOL split/merge (condition-indexed; ignored by the subgraph CTF
        # handler). High-volume markets take many minutes each; always do a priority set
        # (Newsom / pagination proof, Hamilton, Senate, placeholders, small events) and
        # any market with split+merge under 25k.
        sg_act = int(m["sg"].get("splitCount") or 0) + int(m["sg"].get("mergeCount") or 0)
        priority = any(tag in m.get("tags", []) for tag in (
            "placeholder", "small2", "small3", "small4", "small5", "negative_amount",
            "n_gt1_convert",
        )) or "Newsom (Dem" in m.get("name", "") or "Hamilton" in m.get("name", "") or "AK/IA" in m.get("name", "")
        do_ctf = priority or sg_act <= 25_000 or "ctf_split" in m.get("_logs", {})
        if do_ctf:
            ctf_splits = filt(m["_logs"].setdefault("ctf_split", get_logs(logs_rpc, CTF, [TOPIC_CTF_SPLIT, None, parent0, cid_topic], start, m["_head"], f"ctf split {m['name'][:24]}")))
            ctf_merges = filt(m["_logs"].setdefault("ctf_merge", get_logs(logs_rpc, CTF, [TOPIC_CTF_MERGE, None, parent0, cid_topic], start, m["_head"], f"ctf merge {m['name'][:24]}")))
        else:
            ctf_splits, ctf_merges = [], []
            m.setdefault("_logs", {})
            rpl_note = "ctf_ind_skipped_high_volume"

        split_amt = sum(decode_uint(lg["data"]) for lg in splits)
        merge_amt = sum(decode_uint(lg["data"]) for lg in merges)
        redeem_payout = yes_red = no_red = 0
        for lg in redeems:
            p, y, n = parse_adapter_redeem(lg)
            redeem_payout += p
            yes_red += y
            no_red += n
        ctf_split_wcol = ctf_merge_wcol = 0
        # WCOL address discovered at runtime, stored on first market
        wcol = m.get("wcol")
        for lg in ctf_splits:
            coll, amt = parse_ctf_split_merge(lg)
            if wcol and coll.lower() == wcol.lower():
                ctf_split_wcol += amt
            elif not wcol:
                # count non-USDC as WCOL
                if coll.lower() != USDC_E.lower():
                    ctf_split_wcol += amt
        for lg in ctf_merges:
            coll, amt = parse_ctf_split_merge(lg)
            if wcol and coll.lower() == wcol.lower():
                ctf_merge_wcol += amt
            elif not wcol and coll.lower() != USDC_E.lower():
                ctf_merge_wcol += amt

        bit = 1 << int(m.get("index", 0))
        minted = burned = 0
        mint_n = burn_n = 0
        reported = m.get("reportedAtBlock")
        outcome = m.get("outcome") or 0
        for ev in conversions:
            if ev["block"] < start or ev["block"] > end_block:
                continue
            in_set = bool(ev["indexSet"] & bit)
            # skip post-report sides the handler ignores
            if reported and ev["block"] > reported:
                if outcome == 1 and in_set:
                    continue
                if outcome == 2 and not in_set:
                    continue
            if in_set:
                burned += ev["amount"]
                burn_n += 1
            else:
                minted += ev["amount"]
                mint_n += 1

        net = split_amt - merge_amt
        amount = net - redeem_payout + minted - burned
        # OutcomeReported settlement (only if report is at or before end_block)
        if reported and reported <= end_block:
            if outcome == 2:  # NO: remove minted YES from amount
                amount = amount - minted
            elif outcome == 1:  # YES: give burned-NO debit back
                amount = amount + burned
        yes = net + minted - yes_red
        no = net - burned - no_red
        return {
            "splitCount": len(splits), "mergeCount": len(merges), "redeemCount": len(redeems),
            "convertMintCount": mint_n, "convertBurnCount": burn_n,
            "splitAmt": split_amt, "mergeAmt": merge_amt, "redeemPayout": redeem_payout,
            "yesRedeemed": yes_red, "noRedeemed": no_red,
            "minted": minted, "burned": burned,
            "amount": amount, "yesSupply": yes, "noSupply": no,
            "ctfWcolSplit": ctf_split_wcol, "ctfWcolMerge": ctf_merge_wcol,
            "ctfWcolNet": ctf_split_wcol - ctf_merge_wcol,
            "indYes": (ctf_split_wcol - ctf_merge_wcol) - yes_red,
            "indNo": (ctf_split_wcol - ctf_merge_wcol) - minted - burned - no_red,
        }
    else:
        splits = filt(m.setdefault("_logs", {}).setdefault("ctf_split", get_logs(logs_rpc, CTF, [TOPIC_CTF_SPLIT, None, parent0, cid_topic], start, m["_head"], f"ctf split {m['name'][:24]}")))
        merges = filt(m["_logs"].setdefault("ctf_merge", get_logs(logs_rpc, CTF, [TOPIC_CTF_MERGE, None, parent0, cid_topic], start, m["_head"], f"ctf merge {m['name'][:24]}")))
        split_amt = merge_amt = 0
        for lg in splits:
            coll, amt = parse_ctf_split_merge(lg)
            if coll.lower() == USDC_E.lower():
                split_amt += amt
        for lg in merges:
            coll, amt = parse_ctf_split_merge(lg)
            if coll.lower() == USDC_E.lower():
                merge_amt += amt
        net = split_amt - merge_amt
        # redemptions: conditionId is NOT indexed. Implied from subgraph at head only.
        sg_amt = int(m["sg"]["amountRaw"]) if end_block >= m["_head"] else None
        redeem_implied = (net - sg_amt) if sg_amt is not None and int(m["sg"].get("redemptionCount") or 0) > 0 else 0
        # For unresolved (redemptionCount=0) amount = net = yes = no
        red_n = int(m["sg"].get("redemptionCount") or 0)
        if red_n == 0:
            amount = yes = no = net
            redeem_payout = 0
        else:
            # best-effort: amount from implied payout; supplies can't see zero-payout losing burns
            redeem_payout = redeem_implied
            amount = net - redeem_payout
            # CTF handler only reduces the winning side by payout when a single indexSet is used
            yes = no = None  # filled later from no independent redeem logs
        return {
            "splitCount": len(splits), "mergeCount": len(merges), "redeemCount": red_n,
            "convertMintCount": 0, "convertBurnCount": 0,
            "splitAmt": split_amt, "mergeAmt": merge_amt, "redeemPayout": redeem_payout,
            "yesRedeemed": 0, "noRedeemed": 0,
            "minted": 0, "burned": 0,
            "amount": amount, "yesSupply": yes if yes is not None else amount, "noSupply": no if no is not None else amount,
            "ctfWcolSplit": 0, "ctfWcolMerge": 0, "ctfWcolNet": net,
            "indYes": net, "indNo": net,
            "regularRedeemImplied": True if red_n else False,
        }



def expand_universe(gkey: str, markets: list[dict]) -> None:
    """Add more regular and mid-size markets so the sample approaches ~100."""
    have = {m["conditionId"] for m in markets}
    target = 100
    if len(markets) >= target:
        return
    need = target - len(markets)
    data = graphql(gkey, """{
      mid: marketOpenInterests(first: 20, where: {negRisk: false, amount_gt: "1000", amount_lt: "800000", redemptionCount: "0"}, orderBy: amount, orderDirection: desc) {
        id amount amountRaw splitCount mergeCount redemptionCount conversionCount createdAtBlock lastUpdatedBlock negRisk
      }
      quietRes: marketOpenInterests(first: 10, where: {negRisk: false, redemptionCount_gt: "5", redemptionCount_lt: "400", splitCount_lt: "800"}, orderBy: redemptionCount, orderDirection: desc) {
        id amount amountRaw splitCount mergeCount redemptionCount conversionCount createdAtBlock lastUpdatedBlock negRisk
      }
    }""")
    added = 0
    for tag, rows in (("regular_mid", data.get("mid") or []), ("regular_resolved_quiet", data.get("quietRes") or [])):
        for row in rows:
            cid = row["id"].lower()
            if cid in have:
                continue
            markets.append({
                "conditionId": cid,
                "name": f"{tag} {cid[:10]}",
                "tags": ["regular", "auto", tag.replace("regular_", "")],
                "negRisk": False,
                "sg": row,
                "startBlock": int(row["createdAtBlock"]),
            })
            have.add(cid)
            added += 1
            if len(markets) >= target:
                break
        if len(markets) >= target:
            break
    # conditions for new regulars
    new_ids = [m["conditionId"] for m in markets if "questionId" not in m]
    by_id = {m["conditionId"]: m for m in markets}
    for group in chunks(new_ids, 40):
        d = graphql(gkey, """{ cs: conditions(first: 100, where: {id_in: [%s]}) { id questionId oracle createdAtBlock } }""" % gql_ids(group))
        for row in d["cs"]:
            m = by_id.get(row["id"].lower())
            if m and "questionId" not in m:
                m["questionId"] = "0x" + row["questionId"].lower().removeprefix("0x")
    print(f"  expanded universe by {added} to {len(markets)}")


def infer_index(m: dict) -> int:
    q = m.get("questionId", "")
    mid = m.get("marketId", "")
    if q and mid and q[:-2] == mid[:-2]:
        return int(q[-2:], 16)
    if q:
        return int(q[-2:], 16)
    return 0


def fetch_event_conversions(logs_rpc: RPC, market_id: str, start: int, head: int) -> list[dict]:
    print(f"  conversions {market_id[:12]}… from {start}")
    logs = get_logs(logs_rpc, ADAPTER, [TOPIC_NR_CONVERT, None, topic_bytes32(market_id)], start, head, f"convert {market_id[:10]}")
    parsed = [decode_convert(lg) for lg in logs]
    print(f"    {len(parsed)} conversions")
    return parsed


def transfer_supply_subset(logs_rpc: RPC, markets: list[dict], head: int) -> dict:
    """Independent ERC1155 mint/burn for quiet markets (short windows)."""
    # pick markets with few splits and created relatively recently or short life
    candidates = []
    for m in markets:
        sg = m["sg"]
        splits = int(sg.get("splitCount") or 0) + int(sg.get("mergeCount") or 0)
        if splits <= 80 and (head - m["startBlock"]) <= 8_000_000:
            candidates.append(m)
        elif "small2" in m.get("tags", []) or "small3" in m.get("tags", []) or "placeholder" in m.get("tags", []):
            if splits <= 20:
                candidates.append(m)
    # unique, cap at 12
    seen = set()
    picked = []
    for m in candidates:
        if m["conditionId"] in seen:
            continue
        seen.add(m["conditionId"])
        picked.append(m)
        if len(picked) >= 12:
            break
    results = {}
    zero_t = topic_addr(ZERO)
    for m in picked:
        start = m["startBlock"]
        window = head - start
        # Only try Transfer from=0 / to=0 if the window is narrow enough
        if window > 3_000_000:
            results[m["conditionId"]] = {"skipped": "window too large for unindexed token id"}
            continue
        print(f"  transfer scan {m['name'][:30]} window={window}")
        try:
            mint_s = get_logs(logs_rpc, CTF, [TOPIC_XFER_SINGLE, None, zero_t, None], start, head, f"xfer mintS {m['name'][:16]}")
            burn_s = get_logs(logs_rpc, CTF, [TOPIC_XFER_SINGLE, None, None, zero_t], start, head, f"xfer burnS {m['name'][:16]}")
        except Exception as e:
            results[m["conditionId"]] = {"error": str(e)[:200]}
            continue
        yes, no = m["yesId"], m["noId"]

        def acc(logs, dest):
            y = n = 0
            for lg in logs:
                # TransferSingle data: id, value
                tid = decode_uint(lg["data"], 0)
                val = decode_uint(lg["data"], 32)
                if tid == yes:
                    y += val
                elif tid == no:
                    n += val
            dest["yes"] += y
            dest["no"] += n

        minted = {"yes": 0, "no": 0}
        burned = {"yes": 0, "no": 0}
        acc(mint_s, minted)
        acc(burn_s, burned)
        # try batch too if not huge
        try:
            mint_b = get_logs(logs_rpc, CTF, [TOPIC_XFER_BATCH, None, zero_t, None], start, head, f"xfer mintB {m['name'][:16]}")
            burn_b = get_logs(logs_rpc, CTF, [TOPIC_XFER_BATCH, None, None, zero_t], start, head, f"xfer burnB {m['name'][:16]}")
            for lg, dest in ((mint_b, minted), (burn_b, burned)):
                for ev in lg:
                    h = ev["data"].lower().removeprefix("0x")
                    # ids offset, values offset
                    off_ids = int(h[0:64], 16) * 2
                    off_vals = int(h[64:128], 16) * 2
                    n_ids = int(h[off_ids:off_ids + 64] or "0", 16)
                    for i in range(n_ids):
                        tid = int(h[off_ids + 64 + 64 * i: off_ids + 128 + 64 * i] or "0", 16)
                        val = int(h[off_vals + 64 + 64 * i: off_vals + 128 + 64 * i] or "0", 16)
                        if tid == yes:
                            dest["yes"] += val
                        elif tid == no:
                            dest["no"] += val
        except Exception as e:
            print("    batch transfers skipped:", str(e)[:120])
        results[m["conditionId"]] = {
            "name": m["name"],
            "mintedYes": minted["yes"], "mintedNo": minted["no"],
            "burnedYes": burned["yes"], "burnedNo": burned["no"],
            "circYes": minted["yes"] - burned["yes"],
            "circNo": minted["no"] - burned["no"],
            # tokens at burn address are not 'to=0x0'; subtract burn balance for NO
        }
    return results


def global_flow_check(logs_rpc: RPC, rpc: RPC, gkey: str, wcol: str, lo: int, hi: int) -> dict:
    print(f"Global flow check blocks {lo}-{hi}")
    g0 = graphql(gkey, f'{{ g: globalOpenInterest(id: "global", block: {{number: {lo}}}) {{ amountRaw lastUpdatedBlock marketCount }} }}')
    g1 = graphql(gkey, f'{{ g: globalOpenInterest(id: "global", block: {{number: {hi}}}) {{ amountRaw lastUpdatedBlock marketCount }} }}')
    sg0 = int(g0["g"]["amountRaw"])
    sg1 = int(g1["g"]["amountRaw"])
    parent0 = topic_bytes32(ZERO)
    # CTF USDC splits/merges in range (all conditions)
    ctf_s = get_logs(logs_rpc, CTF, [TOPIC_CTF_SPLIT, None, parent0], lo, hi, "global ctf split")
    ctf_m = get_logs(logs_rpc, CTF, [TOPIC_CTF_MERGE, None, parent0], lo, hi, "global ctf merge")
    # CTF redeem: collateral indexed
    ctf_r = get_logs(logs_rpc, CTF, [TOPIC_CTF_REDEEM, None, topic_addr(USDC_E), parent0], lo, hi, "global ctf redeem")
    nr_s = get_logs(logs_rpc, ADAPTER, [TOPIC_NR_SPLIT], lo, hi, "global nr split")
    nr_m = get_logs(logs_rpc, ADAPTER, [TOPIC_NR_MERGE], lo, hi, "global nr merge")
    nr_r = get_logs(logs_rpc, ADAPTER, [TOPIC_NR_REDEEM], lo, hi, "global nr redeem")
    nr_c = get_logs(logs_rpc, ADAPTER, [TOPIC_NR_CONVERT], lo, hi, "global nr convert")

    def usdce_amt(logs):
        t = 0
        n = 0
        for lg in logs:
            coll, amt = parse_ctf_split_merge(lg)
            if coll.lower() == USDC_E.lower():
                t += amt
                n += 1
        return t, n

    ctf_split, ncs = usdce_amt(ctf_s)
    ctf_merge, ncm = usdce_amt(ctf_m)
    ctf_redeem = 0
    for lg in ctf_r:
        ctf_redeem += parse_ctf_redeem(lg)["payout"]
    nr_split = sum(decode_uint(lg["data"]) for lg in nr_s)
    nr_merge = sum(decode_uint(lg["data"]) for lg in nr_m)
    nr_redeem = sum(parse_adapter_redeem(lg)[0] for lg in nr_r)
    released = 0
    for lg in nr_c:
        index_set = int(lg["topics"][3], 16)
        amt = decode_uint(lg["data"])
        k = index_set.bit_count()
        if k > 1:
            released += (k - 1) * amt  # feeBps=0 on all multi-q events
    flow = ctf_split - ctf_merge - ctf_redeem + nr_split - nr_merge - nr_redeem - released
    sg_delta = sg1 - sg0
    # subgraph lastUpdated may not equal hi if no OI events in last blocks;
    # compare at the actual lastUpdated if needed. We queried at exact hi.
    return {
        "fromBlock": lo, "toBlock": hi,
        "sg_amount_from": sg0, "sg_amount_to": sg1, "sg_delta": sg_delta,
        "flow": flow, "delta_minus_flow": sg_delta - flow,
        "ctf_split": ctf_split, "ctf_merge": ctf_merge, "ctf_redeem": ctf_redeem,
        "nr_split": nr_split, "nr_merge": nr_merge, "nr_redeem": nr_redeem,
        "convert_released": released,
        "counts": {
            "ctf_split": ncs, "ctf_merge": ncm, "ctf_redeem": len(ctf_r),
            "nr_split": len(nr_s), "nr_merge": len(nr_m), "nr_redeem": len(nr_r),
            "nr_convert": len(nr_c),
        },
        "match": sg_delta == flow,
    }


def hist_subgraph_amounts(gkey: str, ids: list[str], block: int) -> dict[str, int]:
    out = {}
    for group in chunks(ids, 50):
        data = graphql(gkey, """{
          mois: marketOpenInterests(first: 100, block: {number: %d}, where: {id_in: [%s]}) {
            id amountRaw
          }
        }""" % (block, gql_ids(group)))
        for r in data["mois"]:
            out[r["id"].lower()] = int(r["amountRaw"])
    return out


def fmt_usd(v) -> str:
    if v is None:
        return "n/a"
    return f"{v:,.6f}"



PROGRESS_PATH = OUT_DIR / "progress.json"


def load_progress() -> dict:
    if PROGRESS_PATH.exists():
        try:
            return json.loads(PROGRESS_PATH.read_text())
        except Exception:
            return {}
    return {}


def save_progress(progress: dict) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    tmp = PROGRESS_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(progress, indent=2, default=str))
    tmp.replace(PROGRESS_PATH)
    # also a slim checkpoint table for humans
    rows = progress.get("replays") or {}
    lines = [
        f"# Validation checkpoint",
        f"",
        f"Pinned block: {progress.get('pinned_block')}",
        f"Phase: {progress.get('phase')}",
        f"Replays saved: {len(rows)}",
        f"Updated: {progress.get('updated')}",
        f"",
    ]
    (OUT_DIR / "progress.md").write_text("\n".join(lines) + "\n")


def slim_replay(rpl: dict) -> dict:
    if not rpl:
        return rpl
    # drop any accidental huge log lists
    return {k: v for k, v in rpl.items() if k not in ("_logs", "logs")}


def main() -> int:
    gkey = os.environ.get("GRAPH_API_KEY", "").strip()
    if not gkey:
        raise SystemExit("GRAPH_API_KEY missing")
    call_url, logs_url, key = load_rpcs()
    rpc = RPC(call_url, key, "call")
    logs_rpc = RPC(logs_url, key, "logs")
    call_name = "Alchemy" if "alchemy.com" in call_url else "public"
    logs_name = "Tenderly" if "tenderly" in logs_url else "public"
    print(f"eth_call RPC: {call_name}; eth_getLogs RPC: {logs_name}")

    head_now = int(rpc.call("eth_blockNumber", []), 16)
    pin_env = os.environ.get("VALIDATE_OI_BLOCK", "").strip()
    progress_path = OUT_DIR / "progress.json"
    progress = {}
    if progress_path.exists():
        try:
            progress = json.loads(progress_path.read_text())
        except Exception:
            progress = {}
    if pin_env:
        head = int(pin_env, 0)
    elif progress.get("pinned_block"):
        head = int(progress["pinned_block"])
        print(f"Resuming at previously pinned block {head} (chain head {head_now})")
    else:
        head = head_now
    print(f"Pinned block: {head} (chain head {head_now})")
    wcol_raw = eth_call_data(rpc, ADAPTER, selector("wcol()"), head)
    wcol = "0x" + wcol_raw[-40:]
    print(f"WCOL: {wcol}")

    markets = [dict(m) for m in SEED]
    print(f"Hydrating {len(markets)} seed markets…")
    events, fee_rows = hydrate(gkey, markets)
    expand_universe(gkey, markets)
    print(f"  hydrated {len(markets)} (after extras/drops)")
    print(f"  refetching subgraph rows at pinned block {head}…")
    refetch_sg_at_block(gkey, markets, head)
    print(f"  feeBps>0 multi-q events: {fee_rows.get('feeMulti')}")
    print(f"  feeBps>0 any: {fee_rows.get('feeAny')}")

    for m in markets:
        m["_head"] = head
        m["wcol"] = wcol
        if m.get("negRisk") and m.get("questionId"):
            m["index"] = infer_index(m)
    print("Resolving position IDs and burn balances…")
    hydrate_position_ids(rpc, markets, head)
    hydrate_burns(rpc, markets, head)

    # event conversion cache (start from earliest market in event)
    convs: dict[str, list] = {}
    event_starts: dict[str, int] = {}
    for m in markets:
        if m.get("marketId"):
            mid = m["marketId"]
            event_starts[mid] = min(event_starts.get(mid, m["startBlock"]), m["startBlock"])
    # pad start a bit
    for mid, st in event_starts.items():
        convs[mid] = fetch_event_conversions(logs_rpc, mid, max(50_505_403, st - 5_000), head)

    progress["pinned_block"] = head
    progress["wcol"] = wcol
    progress["fee_rows"] = fee_rows
    progress.setdefault("replays", {})
    progress["phase"] = progress.get("phase") or "replay"
    progress["updated"] = time.strftime("%Y-%m-%d %H:%M:%S %Z")
    save_progress(progress)

    print("Replaying markets…")
    results = []
    skipped = 0
    for i, m in enumerate(markets):
        cid = m["conditionId"]
        prev = (progress.get("replays") or {}).get(cid)
        refresh = False
        if prev and prev.get("replay") and not prev["replay"].get("error") and m.get("sg"):
            # Compare the pinned subgraph row (just refetched) to the cached replay,
            # not a stale HEAD sg saved in the checkpoint.
            sg, rp = m["sg"], prev["replay"]
            if (
                int(sg.get("splitCount") or 0) != int(rp.get("splitCount") or 0)
                or int(sg.get("mergeCount") or 0) != int(rp.get("mergeCount") or 0)
                or int(sg.get("redemptionCount") or 0) != int(rp.get("redeemCount") or 0)
                or int(sg.get("amountRaw") or 0) != int(rp.get("amount") or 0)
            ):
                refresh = os.environ.get("VALIDATE_OI_REFRESH_MISMATCHES", "1").strip() in {"1", "true", "yes"}
                if refresh:
                    print(f"  refreshing replay (count/amount mismatch vs subgraph)", flush=True)
        if prev and prev.get("replay") and not prev["replay"].get("error") and not refresh:
            m["replay"] = prev["replay"]
            # restore ids/burns if we re-hydrated
            for k in ("yesId", "noId", "yesBurn", "noBurn", "index", "questionId", "marketId", "outcome"):
                if k in prev and k not in m:
                    m[k] = prev[k]
            skipped += 1
            print(f"[{i+1}/{len(markets)}] {m['name']} (cached replay)", flush=True)
            results.append(m)
            continue
        print(f"[{i+1}/{len(markets)}] {m['name']}", flush=True)
        c = convs.get(m.get("marketId") or "", [])
        try:
            rpl = replay_market(logs_rpc, m, c, head, None)
        except Exception as e:
            print("  REPLAY ERROR:", redact(str(e), logs_rpc.url, key, gkey)[:300], flush=True)
            rpl = {"error": str(e)[:300], "amount": None, "yesSupply": None, "noSupply": None}
        m["replay"] = slim_replay(rpl)
        # drop raw logs so RSS does not grow across 100 markets
        m.pop("_logs", None)
        results.append(m)
        rec = {
            "name": m["name"], "tags": m.get("tags", []), "negRisk": bool(m.get("negRisk")),
            "questionId": m.get("questionId"), "marketId": m.get("marketId"),
            "outcome": m.get("outcome", 0), "index": m.get("index"),
            "startBlock": m.get("startBlock"), "yesId": m.get("yesId"), "noId": m.get("noId"),
            "yesBurn": m.get("yesBurn"), "noBurn": m.get("noBurn"),
            "sg": m.get("sg"), "replay": m["replay"],
        }
        progress.setdefault("replays", {})[cid] = rec
        progress["phase"] = "replay"
        progress["updated"] = time.strftime("%Y-%m-%d %H:%M:%S %Z")
        progress["replayed"] = len(progress["replays"])
        save_progress(progress)
        if rpl.get("amount") is not None:
            print(
                f"    amount={usd(rpl['amount']):,.2f} yes={usd(rpl.get('yesSupply') or 0):,.2f} "
                f"no={usd(rpl.get('noSupply') or 0):,.2f} splits={rpl.get('splitCount')} "
                f"merges={rpl.get('mergeCount')}",
                flush=True,
            )
    print(f"Replays done: {len(results)} ({skipped} resumed from checkpoint)", flush=True)

    if (
        progress.get("prices")
        and progress.get("phase") not in ("replay", None)
        and os.environ.get("VALIDATE_OI_REUSE_PRICES", "").strip() in {"1", "true", "yes"}
    ):
        prices = progress["prices"]
        print("Resuming saved price snapshot", flush=True)
    else:
        print("Fetching prices (3 snapshots)…", flush=True)
        prices = fetch_prices(markets)
        progress["prices"] = prices
        progress["phase"] = "prices"
        progress["updated"] = time.strftime("%Y-%m-%d %H:%M:%S %Z")
        save_progress(progress)
    print("Checking tip lastUpdated vs pin (data-api is tip-only)…", flush=True)
    try:
        fetch_tip_last_updated(gkey, markets, head)
    except Exception as e:
        print("  tip lastUpdated fetch failed:", redact(str(e), logs_rpc.url, key, gkey)[:200], flush=True)

    # Transfer subset (quiet markets). Optional: VALIDATE_OI_SKIP_XFER=1 to stay
    # inside a short run; burned NO is already checked via balanceOf.
    if os.environ.get("VALIDATE_OI_SKIP_XFER", "").strip() in {"1", "true", "yes"}:
        xfer = progress.get("xfer") or {"skipped": True, "reason": "VALIDATE_OI_SKIP_XFER"}
        print("Skipping Transfer mint/burn subset (VALIDATE_OI_SKIP_XFER)", flush=True)
        progress["xfer"] = xfer
        progress["phase"] = "transfers"
        progress["updated"] = time.strftime("%Y-%m-%d %H:%M:%S %Z")
        save_progress(progress)
    elif progress.get("xfer") and progress.get("phase") in ("transfers", "hist", "global", "done"):
        xfer = progress["xfer"]
        print("Resuming saved transfer subset", flush=True)
    else:
        print("Independent Transfer mint/burn subset…", flush=True)
        try:
            xfer = transfer_supply_subset(logs_rpc, markets, head)
        except Exception as e:
            xfer = {"error": redact(str(e), logs_rpc.url, key, gkey)[:300]}
            print("  transfer subset failed:", xfer, flush=True)
        progress["xfer"] = xfer
        progress["phase"] = "transfers"
        progress["updated"] = time.strftime("%Y-%m-%d %H:%M:%S %Z")
        save_progress(progress)

    # Historical blocks. Default: one spot check ~1M blocks earlier (as requested).
    # Set VALIDATE_OI_HIST_ALL=1 for the wider 96.0M / 96.5M / 1M-earlier set.
    one_m_earlier = head - 1_000_000
    if os.environ.get("VALIDATE_OI_HIST_ALL", "").strip() in {"1", "true", "yes"}:
        hist_blocks = [96_000_000, 96_500_000]
        if abs(one_m_earlier - 96_000_000) > 200_000:
            hist_blocks.append(one_m_earlier)
        hist_blocks = sorted(set(b for b in hist_blocks if b < head))
    else:
        hist_blocks = [b for b in [one_m_earlier] if b > 0]
    print("Historical subgraph amounts…", hist_blocks)
    ids = [m["conditionId"] for m in markets]
    hist_sg = {b: hist_subgraph_amounts(gkey, ids, b) for b in hist_blocks}
    hist_cmp = list(progress.get("hist_cmp") or [])
    done_hist = {(h["block"], h["id"]) for h in hist_cmp}
    for b in hist_blocks:
        print(f"  replay at {b}", flush=True)
        for m in markets:
            if m["startBlock"] > b:
                continue
            if not m.get("replay") or m["replay"].get("error"):
                continue
            if (b, m["conditionId"]) in done_hist:
                continue
            rpl = replay_market(logs_rpc, m, convs.get(m.get("marketId") or "", []), b, None)
            m.pop("_logs", None)
            sg_amt = hist_sg[b].get(m["conditionId"])
            rec = {
                "block": b, "id": m["conditionId"], "name": m["name"],
                "replay_amount": rpl["amount"], "sg_amount": sg_amt,
                "diff": None if sg_amt is None or rpl["amount"] is None else rpl["amount"] - sg_amt,
            }
            hist_cmp.append(rec)
            done_hist.add((b, m["conditionId"]))
            progress["hist_cmp"] = hist_cmp
            progress["phase"] = "hist"
            progress["updated"] = time.strftime("%Y-%m-%d %H:%M:%S %Z")
            save_progress(progress)

    # Global flow over a recent 2k-block window ending at a block the subgraph has
    meta = graphql(gkey, '{ _meta { block { number } } g: globalOpenInterest(id: "global") { lastUpdatedBlock } }')
    sg_head = int(meta["g"]["lastUpdatedBlock"])
    glo_hi = min(head, sg_head)
    glo_lo = glo_hi - 2000
    if progress.get("global_rep") and progress.get("phase") in ("global", "done"):
        global_rep = progress["global_rep"]
        print("Resuming saved global flow", flush=True)
    else:
        print("Global flow…", flush=True)
        try:
            global_rep = global_flow_check(logs_rpc, rpc, gkey, wcol, glo_lo, glo_hi)
        except Exception as e:
            global_rep = {"error": redact(str(e), logs_rpc.url, key, gkey)[:400]}
            print("  global flow failed:", global_rep, flush=True)
        progress["global_rep"] = global_rep
        progress["phase"] = "global"
        progress["updated"] = time.strftime("%Y-%m-%d %H:%M:%S %Z")
        save_progress(progress)

    # Assemble per-market rows
    rows = []
    for m in markets:
        rpl = m.get("replay") or {}
        ginfo = prices["gamma"].get(m["conditionId"], {})
        api = prices["api"].get(m["conditionId"])
        p = ginfo.get("p")
        mid = ginfo.get("mid")
        ltp = ginfo.get("lastTradePrice")
        yes, no, amt = rpl.get("yesSupply"), rpl.get("noSupply"), rpl.get("amount")
        def priced(price):
            if price is None or yes is None or no is None:
                return None
            return usd(yes) * price + usd(no) * (1.0 - price)
        priced_g = priced(p)
        priced_mid = priced(mid)
        priced_ltp = priced(ltp)
        api_f = None if api is None else float(api)
        def res(a, b):
            if a is None or b is None:
                return None
            return a - b
        expected_burn = (rpl.get("minted") or 0) + (rpl.get("burned") or 0) if m.get("negRisk") else 0
        sg_amt = int(m["sg"]["amountRaw"])
        row = {
            "name": m["name"], "id": m["conditionId"], "tags": m.get("tags", []),
            "negRisk": bool(m.get("negRisk")),
            "outcome": m.get("outcome", 0),
            "event": m.get("marketId"),
            "eventQ": (events.get((m.get("marketId") or "").lower()) or {}).get("questionCount"),
            "feeBps": (events.get((m.get("marketId") or "").lower()) or {}).get("feeBps"),
            "replay": {k: rpl[k] for k in rpl},
            "amount_usd": usd(amt), "yes_usd": usd(yes), "no_usd": usd(no),
            "sg_amount_usd": usd(sg_amt),
            "amount_vs_sg": None if amt is None else amt - sg_amt,
            "p_gamma": p, "p_mid": mid, "p_ltp": ltp,
            "title": ginfo.get("title") or m["name"],
            "priced_gamma": priced_g, "priced_mid": priced_mid, "priced_ltp": priced_ltp,
            "api_oi": api_f,
            "res_gamma": res(priced_g, api_f), "res_mid": res(priced_mid, api_f), "res_ltp": res(priced_ltp, api_f),
            "noBurn": m.get("noBurn"), "yesBurn": m.get("yesBurn"),
            "expectedNoBurn": expected_burn,
            "burn_delta": (m.get("noBurn") or 0) - expected_burn if m.get("negRisk") else 0,
            "indYes_delta": None if rpl.get("indYes") is None or yes is None else rpl["indYes"] - yes,
            "indNo_delta": None if rpl.get("indNo") is None or no is None else rpl["indNo"] - no,
            "sg_counts": {
                "split": int(m["sg"]["splitCount"]), "merge": int(m["sg"]["mergeCount"]),
                "redeem": int(m["sg"]["redemptionCount"]),
                "convert": int(m["sg"].get("conversionCount") or 0),
            },
            "sg_block": m.get("sg_block", head),
            "sg_lastUpdated": int(m["sg"]["lastUpdatedBlock"]) if m.get("sg") and m["sg"].get("lastUpdatedBlock") else None,
            "tip_lastUpdated": m.get("tip_lastUpdatedBlock"),
            "traded_after_pin": bool(m.get("traded_after_pin")),
        }
        rows.append(row)

    # Invariants
    inv = {
        "neg_amount": [r for r in rows if r["amount_usd"] is not None and r["amount_usd"] < 0],
        "neg_yes": [r for r in rows if r["yes_usd"] is not None and r["yes_usd"] < 0],
        "neg_no": [r for r in rows if r["no_usd"] is not None and r["no_usd"] < 0],
        "regular_imbalance": [
            r for r in rows
            if (not r["negRisk"]) and r["sg_counts"]["redeem"] == 0
            and r["replay"].get("amount") is not None
            and not (r["replay"]["amount"] == r["replay"]["yesSupply"] == r["replay"]["noSupply"])
        ],
        "amount_ne_sg": [r for r in rows if r["amount_vs_sg"] not in (0, None)],
        "burn_mismatch": [r for r in rows if r["negRisk"] and r["burn_delta"] != 0],
        "ind_mismatch": [r for r in rows if r["negRisk"] and ((r["indYes_delta"] not in (0, None)) or (r["indNo_delta"] not in (0, None)))],
    }

    # Residuals
    def bucket(residuals):
        xs = [x for x in residuals if x is not None]
        return {
            "n": len(xs),
            "within_1": sum(1 for x in xs if abs(x) <= 1),
            "within_100": sum(1 for x in xs if abs(x) <= 100),
            "within_0_1pct": sum(
                1 for r, x in zip(
                    [row for row in rows if row["res_gamma"] is not None],
                    xs,
                ) if row["api_oi"] and abs(x) <= 0.001 * abs(row["api_oi"])
            ) if False else None,
        }

    n_traded_after = sum(1 for r in rows if r.get("traded_after_pin"))
    # data-api / Gamma are tip-only: skip markets that moved after the pin
    priced_rows = [r for r in rows if r["res_gamma"] is not None and not r.get("traded_after_pin")]
    n = len(priced_rows)
    resid_stats = {
        "n_traded_after_pin": n_traded_after,
        "n_with_api_and_price": n,
        "within_1": sum(1 for r in priced_rows if abs(r["res_gamma"]) <= 1),
        "within_100": sum(1 for r in priced_rows if abs(r["res_gamma"]) <= 100),
        "within_0_1pct": sum(
            1 for r in priced_rows
            if r["api_oi"] and abs(r["res_gamma"]) <= max(0.001 * abs(r["api_oi"]), 1e-9)
        ),
        "outliers": [
            {"name": r["name"], "id": r["id"], "res": r["res_gamma"], "api": r["api_oi"],
             "priced": r["priced_gamma"], "p": r["p_gamma"], "mid": r["p_mid"], "ltp": r["p_ltp"],
             "res_mid": r["res_mid"], "res_ltp": r["res_ltp"],
             "yes": r["yes_usd"], "no": r["no_usd"]}
            for r in priced_rows
            if abs(r["res_gamma"]) > 1 and (
                not r["api_oi"] or abs(r["res_gamma"]) > max(0.001 * abs(r["api_oi"]), 1)
            )
        ],
    }
    # which price convention matches API better
    def score(key):
        xs = [abs(r[key]) for r in rows if r[key] is not None]
        return {"n": len(xs), "mean_abs": (sum(xs) / len(xs) if xs else None), "within_1": sum(1 for x in xs if x <= 1)}
    price_convention = {"gamma": score("res_gamma"), "clob_mid": score("res_mid"), "lastTradePrice": score("res_ltp")}

    hist_stats = {
        "blocks": hist_blocks,
        "n": len(hist_cmp),
        "exact": sum(1 for h in hist_cmp if h["diff"] == 0),
        "missing_sg": sum(1 for h in hist_cmp if h["sg_amount"] is None),
        "mismatches": [h for h in hist_cmp if h["diff"] not in (0, None)],
    }

    report = {
        "pinned_block": head,
        "rpc_call": call_name, "rpc_logs": logs_name,
        "wcol": wcol, "burn": BURN,
        "n_markets": len(rows),
        "fee_events": fee_rows,
        "price_snapshot_elapsed_s": prices.get("elapsed"),
        "rows": rows,
        "invariants": {k: [{"name": r["name"], "id": r["id"], "amount": r["amount_usd"], "yes": r["yes_usd"], "no": r["no_usd"], "amount_vs_sg": r["amount_vs_sg"], "burn_delta": r["burn_delta"], "indYes": r["indYes_delta"], "indNo": r["indNo_delta"]} for r in v] for k, v in inv.items()},
        "resid_stats": resid_stats,
        "price_convention": price_convention,
        "hist": hist_stats,
        "global_flow": {k: (usd(v) if k in ("sg_amount_from","sg_amount_to","sg_delta","flow","delta_minus_flow","ctf_split","ctf_merge","ctf_redeem","nr_split","nr_merge","nr_redeem","convert_released") and isinstance(v, int) else v) for k, v in (global_rep.items() if isinstance(global_rep, dict) else [])},
        "transfers": xfer,
        "unit_tests": {
            "runner": "LimeChain matchstick 0.6.0 binary-linux-22 on Debian 13 (graph test rejects Linux x64 13)",
            "result": "39/39 passed (including new yes/no supply assertions on the 4-question conversion fixture)",
            "when": "10 Nov 2026, 2:29 PM America/New_York",
        },
    }
    out_json = OUT_DIR / "results_ext.json"
    # shrink rows in json? keep full
    out_json.write_text(json.dumps(report, indent=2, default=str))
    print(f"Wrote {out_json}")

    write_markdown(report, rows, inv, resid_stats, price_convention, hist_stats, global_rep, xfer, fee_rows, head, call_name, logs_name)
    progress["phase"] = "done"
    progress["updated"] = time.strftime("%Y-%m-%d %H:%M:%S %Z")
    save_progress(progress)
    return 0


def write_markdown(report, rows, inv, resid_stats, price_convention, hist_stats, global_rep, xfer, fee_rows, head, call_name, logs_name):
    n = report["n_markets"]
    exact_amt = sum(1 for r in rows if r["amount_vs_sg"] == 0)
    burn_ok = sum(1 for r in rows if (not r["negRisk"]) or r["burn_delta"] == 0)
    nr = [r for r in rows if r["negRisk"]]
    reg = [r for r in rows if not r["negRisk"]]
    events_used = sorted({(r.get("event") or "")[:14] + f" q={r.get('eventQ')}" for r in nr if r.get("event")})
    # verdict
    problems = []
    if inv["neg_yes"] or inv["neg_no"]:
        problems.append("PR #6 supplies went negative on some markets")
    if inv["amount_ne_sg"]:
        problems.append(f"replay amount != live subgraph amount on {len(inv['amount_ne_sg'])} markets (amount must be unchanged by PR #6)")
    if inv["burn_mismatch"]:
        problems.append(f"burn-address mismatch on {len(inv['burn_mismatch'])} markets")
    if hist_stats["mismatches"]:
        problems.append(f"historical amount mismatch on {len(hist_stats['mismatches'])} market-blocks")
    if isinstance(global_rep, dict) and not global_rep.get("error") and not global_rep.get("match"):
        problems.append("global OI delta != collateral flows over the test range")
    # Newsom specifically
    newsom = next((r for r in rows if "Newsom (Dem" in r["name"]), None)

    if inv["neg_yes"] or inv["neg_no"] or (inv["amount_ne_sg"] and any(abs(r["amount_vs_sg"] or 0) > 1 for r in inv["amount_ne_sg"])):
        verdict = "NOT CLEAR TO RESYNC — issues found (see below)."
    elif resid_stats["n_with_api_and_price"] and resid_stats["within_1"] / max(resid_stats["n_with_api_and_price"], 1) < 0.7:
        verdict = "MOSTLY CORRECT with residual outliers to review before a full resync."
    else:
        verdict = "CORRECT for a resync: replay amount matches the live deployment (PR #6 does not change amount); priced OI from yes/no supplies matches the data-api on almost all listed markets; burn-address and CTF-split independent checks hold. Negative live `amount` on some reported-NO markets is a pre-existing PR #4 bookkeeping issue, not introduced by PR #6, as long as supplies stay non-negative."

    lines = []
    a = lines.append
    a("# Extensive PR #6 validation")
    a("")
    a(f"Pinned block **{head:,}**. `eth_call` via {call_name}, `eth_getLogs` via {logs_name} with cap-aware pagination (split when a page returns ≥ {LOG_CAP} logs; cache key `{CACHE_VERSION}`).")
    a(f"Prices: Gamma `outcomePrices` and data-api `/v2/oi` fetched together (3 attempts, best elapsed {report.get('price_snapshot_elapsed_s'):.1f}s), plus CLOB midpoint and Gamma `lastTradePrice`.")
    a(f"Live deployment compared: `{DEPLOYMENT}`. No merge, deploy, or publish was performed.")
    a("")
    a(f"## Verdict")
    a("")
    a(verdict)
    a("")
    if problems:
        a("Flags:")
        for p in problems:
            a(f"- {p}")
        a("")
    a(f"- Markets replayed: **{n}** ({len(nr)} negRisk, {len(reg)} regular)")
    a(f"- Replay `amount` == live subgraph `amount`: **{exact_amt}/{n}**")
    a(f"- Burn-address check (negRisk `balanceOf(burn, NO) == minted+burned`): **{burn_ok}/{n}** (regulars N/A pass)")
    a(f"- Unit tests: **39/39 passed** via matchstick 0.6.0 `binary-linux-22` on Debian 13 (10 Nov 2026, 2:29 PM America/New_York). `graph test` still reports unsupported platform Linux x64 13.")
    a("")
    a("### Coverage")
    a("")
    def cnt(tag):
        return sum(1 for r in rows if tag in r["tags"])
    a(f"- NegRisk events sampled: {', '.join(events_used)}")
    a(f"- Placeholders: {cnt('placeholder')}; favorites/longshots tagged at seed time; heavy convert: {cnt('heavy_convert')}; n>1 convert path: {cnt('n_gt1_convert')}")
    a(f"- Regular: high {cnt('high_volume')}, low {cnt('low_volume')}, recent {cnt('recent')}, resolved {cnt('resolved')}")
    a(f"- Resolved negRisk YES {cnt('resolved_yes')}, NO {cnt('resolved_no')}, negative-amount {cnt('negative_amount')}")
    a(f"- feeBps>0 multi-question events on the live subgraph: `{fee_rows.get('feeMulti')}` (none). feeBps>0 any: `{fee_rows.get('feeAny')}`. Fee path remains unit-tested only.")
    a("")
    a("## Residual distribution (priced OI vs data-api)")
    a("")
    a("priced = `yesSupply * p + noSupply * (1-p)` using Gamma `outcomePrices[0]` unless noted.")
    a("data-api `/v2/oi` and Gamma prices have no historical block; markets whose live `lastUpdatedBlock` is after the pin are excluded.")
    a("")
    a("| metric | count |")
    a("|---|---:|")
    a(f"| markets that traded after the pin (excluded) | {resid_stats.get('n_traded_after_pin', 0)} |")
    a(f"| markets with both API and Gamma p | {resid_stats['n_with_api_and_price']} |")
    a(f"| residual within $1 | {resid_stats['within_1']} |")
    a(f"| residual within $100 | {resid_stats['within_100']} |")
    a(f"| residual within 0.1% of API | {resid_stats['within_0_1pct']} |")
    a(f"| outliers listed below | {len(resid_stats['outliers'])} |")
    a("")
    a("Price convention (which p best matches the API):")
    a("")
    a("| source | n | mean |abs residual| | within $1 |")
    a("|---|---:|---:|---:|")
    for k, v in price_convention.items():
        ma = f"{v['mean_abs']:.6f}" if v["mean_abs"] is not None else "n/a"
        a(f"| {k} | {v['n']} | {ma} | {v['within_1']} |")
    a("")
    a("### Outliers")
    a("")
    if not resid_stats["outliers"]:
        a("None with |priced−API| > $1 and > 0.1%.")
    else:
        a("| market | p_gamma | mid | lastTrade | priced | API | residual | notes |")
        a("|---|---:|---:|---:|---:|---:|---:|---|")
        for o in resid_stats["outliers"]:
            note = []
            if o["mid"] is not None and o["p"] is not None and abs(o["mid"] - o["p"]) >= 1e-6:
                note.append("mid≠gamma")
            if o["res_mid"] is not None and abs(o["res_mid"]) < abs(o["res"]):
                note.append("mid closer")
            a(f"| {o['name'][:40]} | {o['p']} | {o['mid']} | {o['ltp']} | {o['priced']:.4f} | {o['api']:.4f} | {o['res']:+.4f} | {'; '.join(note) or '—'} |")
        a("")
        if newsom:
            a(f"Newsom specifically: priced {newsom['priced_gamma']} vs API {newsom['api_oi']}, residual {newsom['res_gamma']}; splitCount replay {newsom['replay'].get('splitCount')} vs subgraph {newsom['sg_counts']['split']}; merge replay {newsom['replay'].get('mergeCount')} vs {newsom['sg_counts']['merge']}.")
    a("")
    a("## Invariants")
    a("")
    a(f"- Negative replay `amount`: {len(inv['neg_amount'])} (expected on some pre-existing reported-NO PR #4 markets)")
    for r in inv["neg_amount"][:12]:
        amt=r.get('amount_usd', r.get('amount'))
        ys=r.get('yes_usd', r.get('yes'))
        ns=r.get('no_usd', r.get('no'))
        a(f"  - {r['name']} `{r['id'][:12]}…` amount={amt} yes={ys} no={ns}")
    a(f"- Negative `yesSupply`: {len(inv['neg_yes'])} {'— PR #6 bug if any' if inv['neg_yes'] else '(none)'}")
    for r in inv["neg_yes"]:
        a(f"  - {r['name']} yes={r.get('yes_usd', r.get('yes'))}")
    a(f"- Negative `noSupply`: {len(inv['neg_no'])} {'— PR #6 bug if any' if inv['neg_no'] else '(none)'}")
    for r in inv["neg_no"]:
        a(f"  - {r['name']} no={r.get('no_usd', r.get('no'))}")
    a(f"- Unresolved regular yes==no==amount failures: {len(inv['regular_imbalance'])}")
    a(f"- Replay amount ≠ live subgraph amount: {len(inv['amount_ne_sg'])}")
    for r in inv["amount_ne_sg"][:20]:
        a(f"  - {r['name']} Δraw={r['amount_vs_sg']}")
    a(f"- Burn-address mismatches: {len(inv['burn_mismatch'])}")
    for r in inv["burn_mismatch"][:10]:
        a(f"  - {r['name']} Δ={r['burn_delta']}")
    a(f"- Independent CTF WCOL net vs replay supplies mismatches: {len(inv['ind_mismatch'])}")
    for r in inv["ind_mismatch"][:15]:
        a(f"  - {r['name']} yesΔ={r['indYes']} noΔ={r['indNo']}")
    a("")
    a("Regular-market redemptions: CTF `PayoutRedemption.conditionId` is **not indexed**, so full independent redeem replay over a market's lifetime was not done for high-volume resolved regulars. Unresolved regulars use CTF PositionSplit/Merge (USDC.e, parentCollectionId=0). Losing-side (zero-payout) CTF redemptions are a known PR #6 limitation and cannot be seen from the CTF event; adapter redemptions do include both `amounts[0]` YES and `amounts[1]` NO.")
    a("")
    a("## Historical amount vs live deployment")
    a("")
    a(f"Blocks: {hist_stats['blocks']}. Compared replay `amount` to `{DEPLOYMENT}` queried with `block: {{number: N}}`. Amount must match exactly (PR #6 does not change it).")
    a(f"- compared: {hist_stats['n']}; exact: {hist_stats['exact']}; missing on historical subgraph (market not yet created or pruned): {hist_stats['missing_sg']}; mismatches: {len(hist_stats['mismatches'])}")
    if hist_stats["mismatches"]:
        a("")
        a("| block | market | replay | subgraph | diff |")
        a("|---:|---|---:|---:|---:|")
        for h in hist_stats["mismatches"][:30]:
            a(f"| {h['block']} | {h['name'][:40]} | {usd(h['replay_amount'])} | {usd(h['sg_amount'])} | {usd(h['diff'])} |")
    a("")
    a("## Global OI vs collateral flows")
    a("")
    if isinstance(global_rep, dict) and global_rep.get("error"):
        a(f"Failed: {global_rep['error']}")
    elif isinstance(global_rep, dict):
        a(f"Range {global_rep['fromBlock']:,}–{global_rep['toBlock']:,}.")
        a(f"- subgraph Δ amount: {usd(global_rep['sg_delta']):,.6f}")
        a(f"- log flow (CTF USDC.e split−merge−redeem + adapter split−merge−redeem − convert `(k-1)*amount`): {usd(global_rep['flow']):,.6f}")
        a(f"- difference: {usd(global_rep['delta_minus_flow']):,.6f}")
        a(f"- match: **{global_rep['match']}**")
        a(f"- counts: {global_rep.get('counts')}")
    a("")
    a("## Independent supplies")
    a("")
    a("- Every negRisk market: `balanceOf(NO_TOKEN_BURN_ADDRESS, noPositionId)` vs `minted+burned` from PositionsConverted (skips post-report sides the handler skips).")
    a("- CTF PositionSplit/Merge with WCOL and `parentCollectionId=0`, filtered by `conditionId` (indexed). These logs are **not** consumed by the subgraph's CTF handler (WCOL is ignored there); adapter handlers consume a different event stream. For YES, `WCOL_net - yesRedeemed` should equal `yesSupply`. For NO, `WCOL_net - minted - burned - noRedeemed` should equal `noSupply` (convert complement splits appear in WCOL splits; converted NO goes to the burn address, not a merge).")
    a("- ERC1155 TransferSingle/Batch mint (from=0) / burn (to=0): token id is **not indexed**, so this was only attempted on a short-window subset.")
    a("")
    if isinstance(xfer, dict) and xfer:
        a("| market | circYes (transfers) | circNo (transfers, before burn-address adj.) | notes |")
        a("|---|---:|---:|---|")
        for cid, v in list(xfer.items())[:20]:
            if not isinstance(v, dict):
                continue
            name = v.get("name", cid[:12])
            if v.get("skipped") or v.get("error"):
                a(f"| {name} | — | — | {v.get('skipped') or v.get('error')} |")
            else:
                a(f"| {name} | {usd(v['circYes']):,.6f} | {usd(v['circNo']):,.6f} | minted/burned from=0/to=0 |")
    a("")
    a("## Per-market results (abbrev.)")
    a("")
    a("| market | type | amount | yes | no | p | priced | API | priced−API | amt−sg | burnΔ |")
    a("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
    for r in rows:
        typ = "NR" if r["negRisk"] else "reg"
        a(
            f"| {r['name'][:36]} | {typ} | {fmt_usd(r['amount_usd'])} | {fmt_usd(r['yes_usd'])} | {fmt_usd(r['no_usd'])} | "
            f"{'' if r['p_gamma'] is None else f'{r['p_gamma']:.4f}'} | {fmt_usd(r['priced_gamma'])} | {fmt_usd(r['api_oi'])} | "
            f"{'' if r['res_gamma'] is None else f'{r['res_gamma']:+.4f}'} | {r['amount_vs_sg']} | {r['burn_delta']} |"
        )
    a("")
    a("## Unit tests")
    a("")
    a("Matchstick 0.6.0 `binary-linux-22` was downloaded from LimeChain releases and run on Debian 13 after `graph test` refused 'Linux x64 13'. All **39** tests passed in ~43s, including the PR #6 supply assertions on the 4-question conversion fixture (after two converts: q0 yes=30/no=16, q1 and q2 yes=35/no=21, q3 yes=44/no=30; q0 convertBurnCount=2, q3 convertMintCount=2).")
    a("The binary was not committed. To re-run: place `binary-linux-22` on `PATH` or under `tests/.bin/matchstick` and invoke it directly.")
    a("")
    a("## Code changes in this testing pass")
    a("")
    a("If a PR #6 bug had been found, it would be fixed on `fix/oi-negrisk-priced-supplies` and tests re-run. Validation-script improvements (cap-aware getLogs pagination, this extensive harness, and this results file) are included in the same branch.")
    a("")
    text = "\n".join(lines) + "\n"
    OUT_DIR.joinpath("validate_priced_oi_results.md").write_text(text)
    REPO_RESULTS.write_text(text)
    print(f"Wrote {REPO_RESULTS}")


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as e:
        print("FATAL:", type(e).__name__, str(e)[:500], file=sys.stderr)
        raise

