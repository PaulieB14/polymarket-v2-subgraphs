# consumer/pnl_enricher.py

Joins on-chain `pnl` subgraph data with resolutions from the `main` subgraph,
redemptions from Polymarket's **Activity** subgraph, and Polymarket's gamma REST
API to produce unified per-position records with derived P&L and full market
metadata — without bloating the subgraph itself.

| Source | Used for |
|---|---|
| `pnl` (`QmT21E4p…`) | positions, cost basis, realized P&L from fills, last trade price |
| `main` (`QmTKrqyY…`) | tokenId → condition + outcome index, resolution payouts |
| Polymarket Activity (`Bx1W4S7k…`, [source](https://github.com/Polymarket/polymarket-subgraph/tree/main/activity-subgraph)) | `PayoutRedemption` events (CTF + NegRiskAdapter) |
| gamma API | slug, outcome label, `closed`, condition id fallback |

### Why redemptions don't come from `main`

`main` declares `PayoutRedemption(indexed address,address,indexed bytes32,indexed bytes32,uint256[],uint256)`,
but the CTF emits `redeemer`, `collateralToken` and `parentCollectionId` as the
indexed params and `conditionId` unindexed. topic0 still matches, so the handler
fires, but every `Redemption` decodes with condition `0x0` and a junk collateral.
Re-syncing `main` to fix it isn't practical, so the enricher reads redemptions
from Polymarket's Activity subgraph (correct signature, at chain head) and joins
them to `main`'s conditions on condition id. **Never use `main`'s `Redemption`,
`MarketProfit` or `Account.profit`.**

## Why this exists

The `pnl` subgraph is intentionally lean (3 entities). Adding market metadata
(slug, outcome label, condition_id) to it would require either a new
`ConditionalTokens` data source (slow indexing, duplicates work the `main`
subgraph already does) or IPFS/HTTP file data sources (much slower sync).

Instead, this enricher fetches metadata at query time from Polymarket's free
gamma API and computes the derived P&L fields client-side.

## Output shape

```json
{
  "user": "0x...",
  "buy_cost": 6438.35,
  "sell_revenue": 247.09,
  "realized_pnl": -6191.26,
  "unrealized_pnl": 0.0,
  "settled_pnl": 2910.92,
  "total_pnl": -3280.34,
  "pnl_pct": -0.5095,
  "net_position": 9096.61,
  "avg_price": 0.68,
  "current_price": 1.0,
  "last_trade_price": 0.99,
  "position_value": 9096.61,
  "active": true,
  "buys": 693,
  "sells": 20,
  "transactions": 713,
  "resolution": {"resolved": true, "payout": 1.0, "resolution_timestamp": 1781000000, "source": "main"},
  "redemptions": {"source": "activity", "count": 1, "payout": 9096.61, "last_timestamp": 1781000100},
  "market": {
    "condition_id": "0x...",
    "market_slug": "btc-updown-5m-...",
    "token_id": "...",
    "outcome_index": 0,
    "outcome_label": "Up",
    "closed": true
  }
}
```

## Usage

```bash
# Set your Graph API key once (https://thegraph.com/studio/apikeys)
export GRAPH_API_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Single user, all positions
python3 pnl_enricher.py 0x38e598961dd0456a7fb2e758bd433d3e59fb8a4a

# Active positions only
python3 pnl_enricher.py --active-only 0x38e598961dd0456a7fb2e758bd433d3e59fb8a4a

# Multiple users
python3 pnl_enricher.py 0xUSER1 0xUSER2 0xUSER3

# Also attribute redemptions made from another address you control (repeatable)
python3 pnl_enricher.py --redeemer 0xMY_EOA 0xMY_PROXY

# Previous behaviour (no main / Activity join; held tokens valued at last trade)
python3 pnl_enricher.py --resolutions none --redemptions none 0xUSER
```

### Configuration

| Setting | Default | Notes |
|---|---|---|
| `GRAPH_API_KEY` / `--api-key` | — | One key is used for all three subgraphs via the gateway |
| `--resolutions` / `PNL_RESOLUTIONS_SOURCE` | `main` | `none` disables the join |
| `--redemptions` / `PNL_REDEMPTIONS_SOURCE` | `activity` | `none` disables the join |
| `PNL_DEPLOYMENT`, `MAIN_DEPLOYMENT` | pinned deployments | gateway `/deployments/id/<Qm…>` |
| `ACTIVITY_SUBGRAPH_ID` | `Bx1W4S7kDVxs9gC3s2G6DS8kdNBJNVhMviCtin2DiBp` | gateway `/subgraphs/id/<id>`, follows Polymarket's upgrades |
| `PNL_SUBGRAPH_URL`, `MAIN_SUBGRAPH_URL`, `ACTIVITY_SUBGRAPH_URL` | — | full URL override; a literal `{key}` is replaced with the API key |

If `main` or Activity errors, the enricher logs a warning to stderr and carries
on without that join (positions fall back to last-trade valuation, `redemptions`
is `null`).

Output is JSON to stdout — pipe to `jq`, save to file, etc.

## Field derivations

| Field | Source | Derivation |
|---|---|---|
| `realized_pnl` | pnl subgraph | `UserPosition.realizedPnl` (exchange fills only) |
| `resolution` | main, else Activity | `main`: `payoutNumerators[outcomeIndex] / payoutDenominator`. If main hasn't resolved the condition (main lags head) but the user redeemed it, `source: "activity-redemption"` and `payout` = redeemed collateral ÷ tokens held on that condition |
| `settled_pnl` | derived | resolved positions only: `amount × payout − amount × avgPrice` |
| `redemptions` | Activity | per **condition** (count, collateral payout scaled from 6dp, last timestamp) for redeemer ∈ {user, `--redeemer`…}. Don't sum it across the two outcome records of one condition |
| `buy_cost` | pnl subgraph | `totalBought × avgPrice` |
| `sell_revenue` | pnl subgraph | `realizedPnl + totalSold × avgPrice` (approximation; for exact, query orderbook subgraph fills) |
| `position_value` | derived | `amount × current_price` |
| `unrealized_pnl` | derived | unresolved positions only: `position_value − amount × avgPrice` |
| `total_pnl` | derived | `realized + settled + unrealized` |
| `pnl_pct` | derived | `total_pnl / buy_cost` |
| `current_price` | derived | resolution payout if resolved, else `last_trade_price` |
| `last_trade_price` | pnl subgraph | `Market.lastPrice` |
| `condition_id` | main, else gamma | `MarketData.condition.id`, else `markets[].conditionId` |
| `outcome_index` | main | `MarketData.outcomeIndex` |
| `market_slug` | gamma API | `markets[].slug` |
| `outcome_label` | gamma API | `markets[].outcomes[idx]` aligned to `clobTokenIds` |
| `closed` | main / gamma | resolved, or gamma `markets[].closed` |

## Implementation notes

- **Gamma double-pass**: gamma filters out closed markets by default. The enricher
  queries twice per chunk — once with the default filter (open markets) and once
  with `closed=true&active=true` (resolved markets) — then merges. Without this,
  resolved-market positions return null metadata.
- **Token ID chunking**: gamma accepts batched `?clob_token_ids=` params. Default
  chunk size is 50 tokens per request.
- **Pagination**: positions and redemptions page with an `id_gt` cursor (1,000 per
  page); `_in` filters are chunked. (Previously `account.positions` silently
  returned only the first 100 positions.)
- **No external deps**: stdlib only (`urllib`, `json`, `argparse`). Drop into any
  Python ≥ 3.10 environment.

## Known gaps

- **Adapter-mediated V2 redemptions aren't attributable.** When a wallet redeems
  through `CtfCollateralAdapter` / `NegRiskCtfCollateralAdapter` (or a batch
  redeemer such as `0xa1200000…`), the on-chain `redeemer` is that contract, not
  the user, so a `redeemer_in: [user]` filter can't see it. Those positions still
  settle correctly whenever `main` has the resolution; only the `redemptions`
  field (claimed vs. unclaimed) is incomplete. Fixing it needs tx-level unmasking
  (pUSD burn `Transfer.from` in the same tx), see `contracts.md`.
- **main lags chain head.** Conditions resolved after main's head and never
  redeemed by the user (typically losing positions) stay valued at the last
  trade price until main catches up.
- `pnl.amount` only tracks exchange fills, so tokens from splits/merges/transfers
  aren't included; settlement inference from a redemption is skipped when the
  redeemed amount exceeds the tracked balance.

## Future work

- Swap the remaining gamma calls (slug, outcome label) for on-chain metadata to
  remove the off-chain dependency.
- For `sell_revenue` precision, integrate the `orderbook` subgraph's per-fill
  data (`EnrichedOrderFilled` events) to compute true average sell price.
