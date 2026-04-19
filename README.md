# polymarket-v2-subgraphs

Subgraphs for Polymarket CLOB V2 on Polygon. Built for the **2026-04-28** V2 migration — new CTF Exchange contracts, pUSD collateral wrapper, native builder code attribution.

## Cutover

**2026-04-28 ~11:00 UTC**
- All V1 open orders wiped (~1 hour downtime)
- CLOB backend + Exchange contracts swap
- USDC.e → pUSD wrapper for wallet balances (CTF-level collateral remains USDC.e under the hood)

## Subgraphs

| Subgraph | Tracks | Data sources |
|---|---|---|
| [`main`](./subgraphs/main) | Conditions, resolution status, global counters | Conditional Tokens (unchanged in V2) |
| [`orderbook`](./subgraphs/orderbook) | Order fills, matches, per-market + per-trader volume, **builder attribution** | CTF Exchange V2, Neg Risk CTF Exchange V2 |
| [`pnl`](./subgraphs/pnl) | Per-user positions with cost basis, realized P&L, per-market aggregates | Both V2 exchanges, Conditional Tokens (TransferSingle) |
| [`open-interest`](./subgraphs/open-interest) | Per-market OI, hourly snapshots, global OI | Conditional Tokens (unchanged in V2) |

All four live under one monorepo so shared ABIs + conventions stay in sync.

## V2 contract addresses

See [contracts.md](./contracts.md) for the full table + carry-overs from V1.

Key:
- CTF Exchange V2: `0xE111180000d2663C0091e4f400237545B87B996B`
- Neg Risk CTF Exchange V2: `0xe2222d279d744050d28e00520010520000310F59`
- Conditional Tokens: `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` (unchanged)
- pUSD: `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB`
- V2 Exchange deploy block: **84902353** (2026-03-31)

## Non-obvious V2 quirk — adapter masking

V2 splits/merges/redeems from the wallet flow go through `CtfCollateralAdapter` (`0xADa1…9718`) and `NegRiskCtfCollateralAdapter` (`0xAdA2…c6F1`). That means `PositionSplit.stakeholder` is the adapter, not the EOA. Current schemas are per-market (not per-user), so they're unaffected — but any future per-user attribution needs tx-level unmasking via the pUSD burn `Transfer.from`.

Details in [contracts.md](./contracts.md).

## Getting started

```bash
cd subgraphs/<name>
npm install
npm run codegen
npm run build
npm run deploy    # edit Studio slug in each subgraph's package.json
```

## Start-block conventions

| Subgraph | Start block | Why |
|---|---|---|
| main | 28000000 (V1 genesis) | Conditions created pre-V2 still trade in V2 |
| orderbook | 84902353 (V2 deploy) | V2-only exchange events |
| pnl | 84902353 (V2 deploy) | V2-only cost basis; query V1 P&L separately for history |
| open-interest | 28000000 (V1 genesis) | OI is cumulative — starting at V2 would erase running state |
