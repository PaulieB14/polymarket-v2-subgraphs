# polymarket-v2-subgraphs

Subgraphs for Polymarket CLOB V2 on Polygon. Built for the **2026-04-28** V2 migration — new CTF Exchange contracts, pUSD collateral wrapper, native builder code attribution.

## Cutover

**2026-04-28 ~11:00 UTC**
- All V1 open orders wiped (~1 hour downtime)
- CLOB backend + Exchange contracts swap
- USDC.e → pUSD wrapper for wallet balances (CTF-level collateral remains USDC.e under the hood)

## Subgraphs in this repo

| Subgraph | Status | Tracks |
|---|---|---|
| [`orderbook`](./subgraphs/orderbook) | scaffold (stub ABI) | `OrderFilled` + `OrdersMatched` from both V2 exchanges, per-market + per-account volume, builder attribution hooks |

Planned next: `pnl`, `open-interest` companion (only if per-user attribution is needed — OI math itself is cross-version).

## V2 contract addresses

See [contracts.md](./contracts.md) for the full table + carry-overs from V1.

Key:
- CTF Exchange V2: `0xE111180000d2663C0091e4f400237545B87B996B`
- Neg Risk CTF Exchange V2: `0xe2222d279d744050d28e00520010520000310F59`
- pUSD: `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB`
- Deploy block: **84902353** (2026-03-31)

## Getting started

```bash
cd subgraphs/orderbook
npm install
npm run codegen
npm run build
# Studio deploy — edit slug in package.json first
npm run deploy
```

## Before you deploy

- [ ] Replace stub ABIs in `subgraphs/orderbook/abis/` with canonical ABIs from Polygonscan
- [ ] Verify V2 `OrderFilled` event signature (fee field position, whether `builder` is a topic)
- [ ] Run against V2 test markets on `clob-v2.polymarket.com` for at least one full trade round-trip
- [ ] Confirm start block — current `84902353` matches V2 Exchange deploy tx `0xd313…c97`
