# open-interest (V2)

Per-market and global Open Interest tracker. Mirrors the handler logic from [`PaulieB14/polymarket-open-interest`](https://github.com/PaulieB14/polymarket-open-interest).

## Why it lives in the V2 monorepo

The Conditional Tokens contract is **unchanged** in V2, so this subgraph works across the cutover without modification. It's included here so the full V2 suite deploys as one unit.

## Data source

| Contract | Address | Start block |
|---|---|---|
| Conditional Tokens | `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` | 28000000 (V1 genesis) |

**Start block is deliberately at V1 genesis**, not the V2 Exchange deploy block. OI is cumulative — starting at V2 would erase ~years of running state and produce wrong totals.

## Entities

- `MarketOpenInterest` — per-condition OI with split/merge/redemption counts
- `OISnapshot` — hourly bucketed snapshots per market
- `GlobalOpenInterest` — platform-wide rollup

## V2 quirk — adapter masking (not impacting this subgraph, but documented)

In V2, splits flow through `CtfCollateralAdapter` (`0xADa1…9718`) and `NegRiskCtfCollateralAdapter` (`0xAdA2…c6F1`). `PositionSplit.stakeholder` is the adapter, not the EOA. The current schema is **per-market only**, so no unmasking is required. If you later add per-user OI attribution, you'll need to resolve the real user via the pUSD burn `Transfer.from` in the same tx — see [../../contracts.md](../../contracts.md).

## Commands

```bash
npm install
npm run codegen
npm run build
npm run deploy   # edit Studio slug in package.json
```
