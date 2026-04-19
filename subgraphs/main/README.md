# main (V2)

Market discovery and resolution status. Highest-traffic concern for most Polymarket clients.

## Data source

| Contract | Address | Start block |
|---|---|---|
| Conditional Tokens | `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` | 28000000 (V1 genesis) |

The Conditional Tokens contract is **unchanged** across V1 → V2 — same address, same events. Starting at V1 genesis means this subgraph catalogs every Polymarket condition ever prepared, which is necessary since pre-V2 conditions continue trading on V2 exchanges.

## Entities

- `Condition` — per conditionId: questionId, oracle, outcomeSlotCount, resolution status, payoutNumerators, timestamps
- `Global` — singleton counters: numConditions, numOpenConditions, numResolvedConditions

## Events handled

```solidity
event ConditionPreparation(
    bytes32 indexed conditionId,
    address indexed oracle,
    bytes32 indexed questionId,
    uint256 outcomeSlotCount
);

event ConditionResolution(
    bytes32 indexed conditionId,
    address indexed oracle,
    bytes32 indexed questionId,
    uint256 outcomeSlotCount,
    uint256[] payoutNumerators
);
```

## What this subgraph does NOT track

- **Trade volume / fees / OI** — see `orderbook` and `open-interest`
- **UMA oracle lifecycle** (proposal/dispute/settlement) — would belong in a separate `resolution` subgraph
- **Neg Risk event groups** — belongs in a neg-risk-specific subgraph (`NegRiskAdapter` events)
- **Account-level trader stats** — `orderbook` already maintains per-address rollups

Keeping this subgraph narrow maximizes index speed and keeps the entity surface easy to cache.

## Commands

```bash
npm install
npm run codegen
npm run build
npm run deploy   # Studio slug: polymarket-v2-main
```
