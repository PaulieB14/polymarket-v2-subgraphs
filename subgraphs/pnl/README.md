# pnl (V2)

Per-user position + realized P&L tracker for Polymarket V2.

Designed to replace the lighter-weight Slimmed P&L pattern for V2 traffic. Heavy analytics (win rate, profit factor, max drawdown, daily time-series) are intentionally deferred — keep the base indexing fast; layer analytics on top in a separate subgraph or client-side.

## Data sources

| Contract | Address | Start block | Why |
|---|---|---|---|
| CTF Exchange V2 | `0xE111180000d2663C0091e4f400237545B87B996B` | 84902353 | `OrderFilled` → cost basis + realized P&L |
| Neg Risk CTF Exchange V2 | `0xe2222d279d744050d28e00520010520000310F59` | 84902353 | Same |
| Conditional Tokens | `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` | 84902353 | `TransferSingle` → balance adjustments outside trades (redemptions/merges/P2P transfers) |

Note the CTF data source starts at the V2 exchange deploy block — this subgraph is V2-only. If you need V1 P&L continuity, query both subgraphs and union client-side.

## Entities

```
UserPosition   (user, tokenId) — amount, avgPrice, realizedPnl, totalBought
Account        (address)       — aggregate trades/volume/realizedPnl
MarketStats    (tokenId)       — volume, fills, lastPrice
```

Structure is deliberately minimal; this is the fast-lookup slice. For per-market P&L breakdowns or leaderboards, either:
- Add a `MarketPosition` entity here, OR
- Run a downstream aggregation job that reads this subgraph

## Cost-basis math

On a BUY fill for `user` at price `p` for size `q`:

```
newAmount    = oldAmount + q
newAvgPrice  = (oldAmount * oldAvgPrice + q * p) / newAmount
totalBought += q
```

On a SELL fill for `user` at price `p` for size `q`:

```
realizedPnl += (p - avgPrice) * min(q, amount)
newAmount    = max(amount - q, 0)
// avgPrice unchanged on a pure sell
```

## TODO before mainnet deploy

- [ ] Verify the BUY/SELL amount convention against real V2 fills
- [ ] Decide whether to index pUSD Transfer events for wallet balance display (separate data source)
- [ ] Add `MarketPosition` entity if a V2 P&L leaderboard is in scope
- [ ] Handle `PositionSplit`/`PositionsMerge`/`PayoutRedemption` explicitly for clean cost-basis resets (currently TransferSingle captures the balance side only)
