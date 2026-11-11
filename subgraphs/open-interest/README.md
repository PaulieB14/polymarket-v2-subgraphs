# open-interest (V2)

Per-market and global Open Interest for Polymarket on Polygon, in USDC (6 decimals).
`amount` is unpriced collateral locked in outcome tokens: splits add, merges and
redemptions subtract, and neg-risk conversions adjust per-question bookkeeping
and subtract the collateral they release from the global total.

Polymarket's data-api (`/v2/oi`) reports *priced gross* open interest:
`yesSupply * yesPrice + noSupply * (1 - yesPrice)` (minus fee-receiver shares).
On regular binary markets `yesSupply == noSupply == amount`, so `amount` matches
the API to the cent. On open neg-risk markets the supplies are unbalanced
(conversions mint YES on the complement and burn NO in the index set), so
`amount` will not match the API. Use `yesSupply` / `noSupply` and apply a price
off-chain.

The gating (binary conditions, USDC.e-only CTF events, adapter-tracked neg-risk)
follows Polymarket's own
[`oi-subgraph`](https://github.com/Polymarket/polymarket-subgraph/tree/main/oi-subgraph),
plus a `parentCollectionId == 0` check, conversion settlement on
`OutcomeReported`, circulating supplies, and this repo's extra fields (counts,
hourly snapshots, decimal amounts).

## Data sources

| Contract | Address | Start block | Events |
|---|---|---|---|
| Conditional Tokens | `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` | 4023686 (CTF deployment) | ConditionPreparation, PositionSplit, PositionsMerge, PayoutRedemption |
| Neg Risk Adapter | `0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296` | 50505403 (deployment) | MarketPrepared, QuestionPrepared, PositionSplit, PositionsMerge, PayoutRedemption, PositionsConverted |
| V2 PositionManager (mints / burns) | `0x006F54F7f9A22e0000CC2AB60031000000ae9fEF` | 87479608 (first ModuleAdded) | TransferSingle, TransferBatch with `from = 0` / `to = 0` topic filters |
| V2 BinaryModule | `0x1000008dD9001B968442c1000017eaE6E0dA00Ba` | 87479608 | PositionsSplit, PositionsMerged, PositionRedeemed, ConditionResolved, MigrationConditionRegistered, PositionMigrated |
| V2 NegRiskModule | `0x200000900045e3B6259600682756002200028933` | 87479608 | the above plus HorizontalSplit, HorizontalMerge, RemainingConditionsDerivableAsNo, SyntheticConditionDerivableAsYes |

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
- **Direct WrappedCollateral on the CTF:** a CTF split / merge / redemption in WCOL whose
  caller is *not* the NegRiskAdapter (an EOA splitting the traded neg-risk tokens directly)
  counts on a neg-risk condition in `amount`, counters, both supplies and global. The
  adapter's own CTF calls stay excluded (its events already mirror them). Without this, NO
  minted directly and later redeemed through the adapter drove `noSupply` negative
  (question `0x688e74a4…830f`: −$1,533).
- **Adapter redemptions that sweep stray WCOL:** `NegRiskAdapter.redeemPositions` pays out
  its whole WCOL balance, so a redemption can pay more than the burned tokens are worth
  (tx `0x24bbad6a…4cdc`: amounts [0,0], payout $816.84). The `amount` / global decrease is
  capped at the burned tokens' value.
- **Polymarket V2 markets** (Gamma `polyv2-*`) live in the V2 PositionManager ERC1155, not
  the CTF. `MarketOpenInterest.id` is the 32-byte Gamma `conditionId` (top byte = module id:
  1 binary, 2 neg-risk); `collateralToken` is pUSD. Supplies come from PositionManager mints
  and burns of module 1 / 2 positions (exact on every path: split, merge, redeem, convert,
  horizontal, migration, bridge); combinatorial positions (module 3) are skipped. `amount`
  comes from module PositionsSplit / PositionsMerged / PositionRedeemed. Horizontal split /
  merge move global only (one collateral amount backs every YES of the event). Resolution
  comes from ConditionResolved; on neg-risk events the siblings and the synthetic Other
  derive NO from RemainingConditionsDerivableAsNo, and Other derives YES from
  SyntheticConditionDerivableAsYes.
- **V2 migration of legacy positions:** `migratePositions` escrows the legacy tokens in the
  module, mints the V2 positions, and merges complete legacy sets (or redeems resolved ones)
  on the CTF. PositionMigrated removes the escrowed tokens from the legacy market's
  supplies (they back the V2 tokens; counting both double counts priced OI). The module's
  CTF merge / redemption moves the released collateral from the legacy market's `amount`
  to the V2 market's; global is unchanged (it leaves OI when the V2 positions redeem).
  Legacy and V2 ids are linked through `MigrationLink`.
- **Conversions:** `convertPositions(marketId, indexSet, amount)` burns `amount` NO
  on each of the k questions in `indexSet`, mints `amount` YES on each of the other
  n−k questions, and releases `(k-1)*amount` collateral (fee included; fee is 0 on
  the events we checked). This subgraph:
  - subtracts the released collateral from **global** OI (same as Polymarket's oi-subgraph);
  - updates per-market `amount` by −amount on the converted questions and +amount on
    the complement, then settles those bookkeeping entries on `OutcomeReported`
    (this is *not* what Polymarket's oi-subgraph does — theirs spreads the released
    collateral over the k converted questions only, which is how sibling markets
    went to ±$50M before our PRs #3/#4);
  - updates circulating `yesSupply` / `noSupply` for the tokens actually minted or
    burned. Those supplies, times the outcome price, are what match the data-api.
- **`conversionCount`** is incremented for every question in the event on each
  conversion, so it is identical across the event. Use `convertMintCount` /
  `convertBurnCount` to see which side a question was on.
- **No clamping.** Full history from the CTF deployment means every decrease has a matching
  earlier increase. A full resync is required after this change; grafting cannot
  repair historical `amount` or supplies.

## Start block

It has to be the CTF deployment block. OI is cumulative, and splits only count for
conditions whose `ConditionPreparation` was indexed. Starting later drops every market
created before the start block and leaves old markets' redemptions with nothing to subtract
from.

## Entities

- `Condition`: registered binary conditions
- `NegRiskEvent`: neg-risk markets (fee, question count)
- `MarketOpenInterest`: per-condition collateral `amount`, circulating `yesSupply` / `noSupply`, split, merge, redemption, and conversion counts, `negRisk` flag
- `ConditionPayout`: resolution payouts (CTF ConditionResolution, V2 ConditionResolved / derived results)
- `MigrationLink`: V2 condition id <-> legacy CTF condition id
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
