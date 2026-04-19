# pnl (V2)

Per-user position + realized P&L tracker for Polymarket V2.

Designed to replace the lighter-weight Slimmed P&L pattern for V2 traffic. Heavy analytics (win rate, profit factor, max drawdown, daily time-series) are intentionally deferred — keep the base indexing fast; layer analytics on top in a separate subgraph or client-side.

## Data sources

| Contract | Address | Start block | Why |
|---|---|---|---|
| CTF Exchange V2 | `0xE111180000d2663C0091e4f400237545B87B996B` | 84902353 | `OrderFilled` → cost basis + realized P&L |
| Neg Risk CTF Exchange V2 | `0xe2222d279d744050d28e00520010520000310F59` | 84902353 | Same |

`ConditionalTokens.TransferSingle` was intentionally **not** indexed — it's a firehose of non-Polymarket 1155 transfers and slows sync dramatically for marginal value. Positions are tracked purely from `OrderFilled` events, which is accurate for anyone whose activity is through the exchange (99%+ of volume).

## Scope — V2-only

Start block is the V2 Exchange deploy (2026-03-31). Users with positions established on V1 won't have cost basis here; their first V2 sell against pre-existing holdings will register `realizedPnl = 0` (the clamp protects against negative balances).

### V1 P&L endpoints for legacy history

For pre-cutover history, query the existing V1 subgraphs alongside this one and union client-side:

- **Slimmed V1 P&L** — `QmZAYiMeZiWC7ZjdWepek7hy1jbcW3ngimBF9ibTiTtwQU` (lightweight, highest-traffic at ~1M queries/month)
- **Beefy V1 P&L** — `QmbHwcGkumWdyTK2jYWXV3vX4WyinftEGbuwi7hDkhPWqG` (full analytics: winRate, profitFactor, maxDrawdown, daily stats)

Pattern:
```ts
// Client-side union
const v1 = await queryV1Pnl(user);   // Slimmed or Beefy
const v2 = await queryV2Pnl(user);   // this subgraph
const mergedPositions = mergeBy(pos => `${pos.user}-${pos.tokenId}`, v1, v2);
```

## Entities

```
Account        (address)       — aggregate trades/volume/realizedPnl
UserPosition   (user, tokenId) — amount, avgPrice, realizedPnl, totalBought, totalSold
Market         (tokenId)       — volume, fills, lastPrice
```

## Cost-basis math

On a BUY fill for `user` at price `p` for size `q`:

```
newAmount    = oldAmount + q
newAvgPrice  = (oldAmount * oldAvgPrice + q * p) / newAmount
totalBought += q
```

On a SELL fill for `user` at price `p` for size `q`:

```
soldAgainstHolding = min(q, amount)
realizedPnl += (p - avgPrice) * soldAgainstHolding      // scaled to USDC units
newAmount    = amount - soldAgainstHolding
// avgPrice unchanged on a pure sell
```

Both maker and taker positions are updated per fill. Exchange contract addresses (`0xE111…996B`, `0xe222…0F59`) are skipped — they appear as counterparties in `matchOrders` flows and would inflate trader counts.

## Validated against Polygonscan + Data API

- Orderbook-level field match: 100% (see root README ground-truth check)
- Cross-subgraph consistency: `sum(account.tradesQuantity) = 2 × orderbook.tradesQuantity − exchange_contract_participations` (exact match)
- Post-cutover on April 28, a further 3-way cross-check against Polymarket's Data API becomes meaningful
