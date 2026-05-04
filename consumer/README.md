# consumer/pnl_enricher.py

Joins on-chain `pnl` subgraph data with Polymarket's gamma REST API to produce
unified per-position records with derived P&L and full market metadata —
without bloating the subgraph itself.

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
  "unrealized_pnl": 9005.64,
  "total_pnl": 2814.38,
  "pnl_pct": -0.96,
  "net_position": 9096.61,
  "avg_price": 0.68,
  "current_price": 0.99,
  "position_value": 9005.64,
  "active": true,
  "buys": 693,
  "sells": 20,
  "transactions": 713,
  "market": {
    "condition_id": "0x...",
    "market_slug": "btc-updown-5m-...",
    "token_id": "...",
    "outcome_label": "Up",
    "closed": false
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
```

Output is JSON to stdout — pipe to `jq`, save to file, etc.

## Field derivations

| Field | Source | Derivation |
|---|---|---|
| `realized_pnl` | pnl subgraph | `UserPosition.realizedPnl` |
| `buy_cost` | pnl subgraph | `totalBought × avgPrice` |
| `sell_revenue` | pnl subgraph | `realizedPnl + totalSold × avgPrice` (approximation; for exact, query orderbook subgraph fills) |
| `position_value` | pnl + lastPrice | `amount × lastPrice` |
| `unrealized_pnl` | derived | `position_value − amount × avgPrice` |
| `total_pnl` | derived | `realized + unrealized` |
| `pnl_pct` | derived | `total_pnl / buy_cost` |
| `current_price` | pnl subgraph | `Market.lastPrice` |
| `condition_id` | gamma API | `markets[].conditionId` |
| `market_slug` | gamma API | `markets[].slug` |
| `outcome_label` | gamma API | `markets[].outcomes[idx]` aligned to `clobTokenIds` |
| `closed` | gamma API | `markets[].closed` |

## Implementation notes

- **Gamma double-pass**: gamma filters out closed markets by default. The enricher
  queries twice per chunk — once with the default filter (open markets) and once
  with `closed=true&active=true` (resolved markets) — then merges. Without this,
  resolved-market positions return null metadata.
- **Token ID chunking**: gamma accepts batched `?clob_token_ids=` params. Default
  chunk size is 50 tokens per request.
- **No external deps**: stdlib only (`urllib`, `json`, `argparse`). Drop into any
  Python ≥ 3.10 environment.

## Future work

- Once your `main` subgraph finishes syncing, swap the gamma calls for a single
  GraphQL query against `MarketData(id: $tokenId) { condition { id, ... }, outcomeIndex }`.
  Removes the off-chain dependency.
- For `sell_revenue` precision, integrate the `orderbook` subgraph's per-fill
  data (`EnrichedOrderFilled` events) to compute true average sell price.
