# orderbook (V2)

Indexes `OrderFilled` and `OrdersMatched` from Polymarket's three V2 exchanges on Polygon.

## Data sources

| Exchange | Address | Trades | Start block |
|---|---|---|---|
| CTF Exchange V2 (`CTF`) | `0xE111180000d2663C0091e4f400237545B87B996B` | legacy CTF (USDC.e) position ids | 85050371 (first OrderFilled; deployed 84902353) |
| Neg Risk CTF Exchange V2 (`NEG_RISK`) | `0xe2222d279d744050d28e00520010520000310F59` | legacy neg-risk (WCOL) position ids | 85069592 (first OrderFilled; deployed 85058176) |
| PositionManager Exchange / MigratableExchange (`MIGRATABLE`) | `0xe3333700cA9d93003F00f0F71f8515005F6c00Aa` (proxy) | V2 PositionManager ids (pUSD): binary, neg-risk, combinatorial | 87620369 (first OrderFilled; proxy deployed 87479471) |

All three emit identical `OrderFilled` / `OrdersMatched` signatures (checked against the verified
Polygonscan ABIs and Polymarket/polymarket-v2-external `src/exchange/Exchange.sol`).
`MigratableExchange` also emits `ExecutionResult`, `FeeCharged`, pause/preapproval/admin events;
none are needed (fees are already on each `OrderFilled`).

## Fill semantics (important)

Each match emits one `OrderFilled` per maker order (`taker` = taker address), then one
`OrderFilled` for the taker order whose `taker` is **the exchange contract**, then `OrdersMatched`
(an exact copy of the taker fill's amounts).

* COMPLEMENTARY makers (opposite side, same token): the taker fill mirrors them.
* MINT (both BUY, complement tokens) / MERGE (both SELL): the taker's collateral is new money.

Volume = every maker fill + the taker fill's `netCollateral`
(`taker collateral − collateral of opposite-side makers in the same match`; 0 for pure
complementary matches). Fees = every fill. Accounts/Builders are credited per order owner
(`maker` field) once per fill, so the exchange contract never becomes an Account.

## Joining to the Open Interest subgraph

`Market.conditionId` / `OrderFilledEvent.conditionId` = `tokenId & ~0xff` for V2 PositionManager
ids, which equals OI `MarketOpenInterest.id`. A token is classified V2 only if the top byte is
1/2/3 **and** the 64 reserved bits (40..103) are zero (≈1.2% of legacy CTF ids have a top byte
of 1..3, so the module byte alone misclassifies). `module` is 0 for legacy CTF ids; their
`conditionId`/`outcomeIndex` are null because neither V2 exchange emits a token→condition event
(no `TokenRegistered`) and CTF position ids cannot be inverted on-chain — map them with Gamma
(`clob_token_ids`) or the CTF `getPositionId` forward computation off-chain.

## Entities

- `OrderFilledEvent` (immutable, Bytes id = txHash ++ logIndex)
- `OrdersMatchedEvent` (immutable; redundant with the taker `OrderFilledEvent`, kept for compatibility)
- `Market` — per-tokenId rollups (id stays the decimal tokenId string = CLOB token_id)
- `Account`, `Builder`, `GlobalStats` — rollups (Bytes ids)
- `Trade` timeseries → `MarketCandle` (hour/day OHLC, volume, count per token) and
  `ExchangeVolume` (hour/day per exchange, cumulative) aggregations
- `MatchScratch` — internal per-exchange accumulator for the match in progress

## Commands

```bash
npm install
npm run codegen
npm run build
npm test        # matchstick (scripts/run-matchstick.sh)
```

Matchstick 0.6.0 cannot store `Timestamp` values, so tests disable the `Trade` timeseries
write via `setTradeTimeseriesEnabled(false)`; deployed builds always write it.
