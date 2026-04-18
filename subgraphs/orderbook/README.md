# orderbook (V2)

Indexes `OrderFilled` and `OrdersMatched` from Polymarket's two V2 exchange contracts on Polygon.

## Data sources

| Contract | Address | Start block |
|---|---|---|
| CTF Exchange V2 | `0xE111180000d2663C0091e4f400237545B87B996B` | 84902353 |
| Neg Risk CTF Exchange V2 | `0xe2222d279d744050d28e00520010520000310F59` | 84902353 |

## Entities

- `OrderFilledEvent` — every matched fill, with price/size/side derived from maker/taker asset IDs
- `OrdersMatchedEvent` — taker order aggregation events
- `Account` — per-trader rollups (trades, volume, buys/sells)
- `Market` — per-tokenId rollups
- `Builder` — stub entity for builder code attribution (**TODO**: populate once event topic location is confirmed)
- `GlobalStats` — platform-wide counters

## Known TODOs (important)

1. **Stub ABIs** — `abis/CtfExchangeV2.json` and `abis/NegRiskCtfExchangeV2.json` contain ONLY minimal `OrderFilled` / `OrdersMatched` event definitions based on V1 signatures. **Before deploy**, replace with the canonical ABI from Polygonscan once the V2 contracts are verified and available.
2. **Builder attribution** — the V2 `Order` struct adds a `builder` bytes32 field (per the migration doc), but it's unclear whether it surfaces as an indexed topic on `OrderFilled`. The `Builder` entity is defined in the schema but not written to from handlers. Wire up once confirmed.
3. **Fee field** — V2 fees are protocol-assessed at match time, not signed. The `fee` field on the emitted event is still populated but may have different meaning vs V1.
4. **Side derivation** — current logic infers BUY/SELL from `makerAssetId == 0`. Validate against real V2 fills before trusting.

## Commands

```bash
npm install
npm run codegen   # generate types from ABIs + schema
npm run build     # compile WASM
npm run deploy    # deploy to Studio (edit slug in package.json)
```
