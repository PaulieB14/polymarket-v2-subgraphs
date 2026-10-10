# open-interest (V2)

Per-market and global Open Interest for Polymarket on Polygon, in USDC (6 decimals).
OI = collateral locked in outcome tokens: splits add, merges and redemptions subtract,
and neg-risk conversions subtract the collateral they release.

The accounting follows Polymarket's own
[`oi-subgraph`](https://github.com/Polymarket/polymarket-subgraph/tree/main/oi-subgraph)
(same gating, same neg-risk conversion math), plus a `parentCollectionId == 0` check and
this repo's extra fields (counts, hourly snapshots, decimal amounts).

## Data sources

| Contract | Address | Start block | Events |
|---|---|---|---|
| Conditional Tokens | `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` | 4023686 (CTF deployment) | ConditionPreparation, PositionSplit, PositionsMerge, PayoutRedemption |
| Neg Risk Adapter | `0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296` | 50505403 (deployment) | MarketPrepared, QuestionPrepared, PositionSplit, PositionsMerge, PayoutRedemption, PositionsConverted |

## Rules

- **Only binary conditions registered via `ConditionPreparation` count.** That excludes
  third-party conditions and multi-outcome setups.
- **CTF events count only when collateral is USDC.e (`0x2791…4174`) and
  `parentCollectionId == 0`.**
  - V2's `CtfCollateralAdapter` unwraps pUSD and splits, merges, and redeems on CTF with
    USDC.e, so V2 flow is covered. pUSD or native USDC split directly on CTF creates
    different position IDs that the exchanges don't trade. That's ignored, and was a few
    dollars per day when sampled.
  - WMATIC and any other token are ignored. Before this fix, one 1-WMATIC split, read as
    6 decimals, showed up as $1T.
  - Nested splits, merges, and redemptions move outcome tokens, not collateral.
- **Neg-risk markets are counted through the NegRiskAdapter, in USDC.** At the CTF level
  they use WrappedCollateral (`0x3A3B…02E2`), which the CTF handlers skip. Counting WCOL at
  the CTF level overstates OI, because `convertPositions` mints WCOL and splits for the
  complementary questions while the converted NO tokens are burned. V2's
  `NegRiskCtfCollateralAdapter` routes through this adapter, so V2 is covered.
- **Conversions:** converting `amount` NO tokens of k questions releases `(k-1)*amount`,
  including the fee that goes to the vault. That's subtracted from global OI and spread
  evenly over the k conditions. Per-market neg-risk OI is therefore an allocation and can go
  slightly negative on individual questions. Polymarket's subgraph behaves the same way.
- **No clamping.** Full history from the CTF deployment means every decrease has a matching
  earlier increase.

## Start block

It has to be the CTF deployment block. OI is cumulative, and splits only count for
conditions whose `ConditionPreparation` was indexed. Starting later drops every market
created before the start block and leaves old markets' redemptions with nothing to subtract
from.

## Entities

- `Condition`: registered binary conditions
- `NegRiskEvent`: neg-risk markets (fee, question count)
- `MarketOpenInterest`: per-condition OI, split, merge, redemption, and conversion counts, `negRisk` flag
- `OISnapshot`: hourly per-market snapshots
- `GlobalOpenInterest`: platform total (`id: "global"`)

## Commands

```bash
npm install
npm run codegen
npm run build
npm test        # matchstick (graph test)
npm run deploy  # edit Studio slug in package.json
```
