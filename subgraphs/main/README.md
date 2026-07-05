# Polymarket CLOB V2 — main

Trades, markets, positions, accounts, conditions and orderbook aggregates for
Polymarket's **CLOB V2** (live 2026-04-28). This is a monolithic subgraph covering
the V2 exchanges plus the shared Conditional Tokens contract.

**Studio slug:** `polymarket-v-2-main`
**Deployment ID:** `QmTKrqyYg23BjhihmsrRjbV9cVS2piNmnHsr7cjYaTgdWu`

## Data sources

| Contract | Address | Start block |
|---|---|---|
| Conditional Tokens (CTF) | `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` | 84000000 |
| CTF Exchange V2 | `0xE111180000d2663C0091e4f400237545B87B996B` | 84902353 |
| Neg Risk CTF Exchange V2 | `0xe2222d279d744050d28e00520010520000310F59` | 84902353 |

Addresses match the [official V2 contracts](https://docs.polymarket.com/resources/contracts).
Network: Polygon (matic).

## V2 notes

- **Collateral is pUSD** (`0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB`, **6 decimals**,
  1:1 USDC-backed) — it replaced USDC.e at the V2 cutover. Both are 6-decimals, so
  collateral amounts scale by `1e6`. USDC.e and pUSD are both labeled in the `Collateral`
  entity; anything else falls back to `Unknown`/18.
- **The V2 `OrderFilled` event carries `builder` and `metadata`** (bytes32) and an
  operator-set `fee` (fees are charged at match time in V2, not embedded in the order).
  Builder attribution is tracked in the `Builder` entity.

## Why the CTF starts at the V2 era (not genesis, and not grafted)

The Conditional Tokens contract is shared and unchanged across V1 → V2. A *market* is a
`Condition`, and pre-V2 conditions keep trading on V2 — but their **pUSD** outcome tokens
are only split **after** the cutover, so every mapping-relevant `PositionSplit` is in the
V2 era. Indexing the CTF from V1 genesis would drag in ~58M blocks / ~1.15M conditions of
irrelevant V1 history.

Instead, when `handlePositionSplit` (or merge/redemption) encounters a condition it hasn't
indexed — a pre-V2 market still trading on V2 — it creates a lightweight **stub condition**
on the fly: `outcomeSlotCount` comes from one cheap `getOutcomeSlotCount` call, while
`oracle`/`questionId` (which live only on the un-indexed `ConditionPreparation`) stay
**null** and can be recovered from the conditionId via Polymarket's Gamma API. This keeps
every V2-traded market mapped to its condition while staying lean and V2-focused.

Grafting onto the old deployment was rejected: it would inherit data built with the old
(buggy) mapping and only apply fixes going forward.

## Key mapping details

- **`MarketData.condition` is nullable.** It's set when a token's `PositionSplit` is
  indexed. It stays null only for tokens with no standard base-CTF split under their
  collateral — e.g. NegRisk positions minted via the NegRisk Adapter, or combinatorial /
  converted positions. (A non-nullable `condition` was the original crash: an un-split
  NegRisk token wedged the previous deployment at block 86,132,125.)
- **positionId → condition derivation is gated to once per `(condition, collateral,
  parentCollection)`.** Polymarket emits millions of splits; re-deriving on every one made
  the CTF contract calls dominate sync time. The `ConditionCollateralMap` entity records
  which tuples are already mapped so the derivation runs once per market+collateral.
  `getPositionId` is `keccak256(collateral ++ collectionId)`; `getCollectionId` is
  alt_bn128 EC math, so it remains a contract call (now called rarely, under the gate).

## Entities

- `Global`, `OrdersMatchedGlobal` — platform-wide singleton aggregates (volume, trades,
  fees, unique traders, condition counts)
- `Account` — per-address: trade count, volume, realized profit, timestamps
- `Collateral` — token metadata (pUSD, USDC.e)
- `Condition` — per conditionId: outcomeSlotCount, oracle*, questionId*, resolution status,
  payouts (*null on stub conditions)
- `Split`, `Merge`, `Redemption` — CTF position lifecycle events
- `MarketData` — the ERC-1155 tokenId → `Condition` mapping, plus latest orderbook price
- `MarketPosition` — per-user per-token position (quantity/value bought/sold, net, fees)
- `MarketProfit` — per-user per-condition realized profit
- `Transaction` — per-fill maker/taker trade records
- `OrderFilledEvent`, `OrdersMatchedEvent`, `EnrichedOrderFilled` — raw + enriched exchange events
- `Orderbook` — per-token orderbook aggregates
- `Builder` — V2 builder-code attribution (order count, volume, fees)
- `ConditionCollateralMap` — internal derivation-gate bookkeeping (not for querying)

## Events handled

CTF: `ConditionPreparation`, `ConditionResolution`, `PositionSplit`, `PositionsMerge`,
`PayoutRedemption`.
Exchanges (V2 shapes): `OrderFilled(bytes32,address,address,uint8,uint256,uint256,uint256,uint256,bytes32,bytes32)`,
`OrdersMatched(bytes32,address,uint8,uint256,uint256,uint256)`.

## Not indexed (by design)

- **UMA oracle lifecycle** (proposal/dispute/settlement) — belongs in a dedicated resolution subgraph
- **NegRisk Adapter** (`0xd91E80cF…35296`) position minting/conversion — would give NegRisk
  tokens a mapped condition; currently they carry a null `condition`
- **Combos suite** (PositionManager, BinaryModule, CombinatorialModule, third Exchange) —
  a separate V2 contract family

## Commands

```bash
npm install
npm run codegen
npm run build
graph deploy polymarket-v-2-main --node https://api.studio.thegraph.com/deploy/ -l <version>
```
