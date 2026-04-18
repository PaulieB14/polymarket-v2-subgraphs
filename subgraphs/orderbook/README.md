# orderbook (V2)

Indexes `OrderFilled` and `OrdersMatched` from Polymarket's two V2 exchange contracts on Polygon.

## Data sources

| Contract | Address | Start block |
|---|---|---|
| CTF Exchange V2 | `0xE111180000d2663C0091e4f400237545B87B996B` | 84902353 |
| Neg Risk CTF Exchange V2 | `0xe2222d279d744050d28e00520010520000310F59` | 84902353 |

## V2 event shape (confirmed from on-chain ABI)

```solidity
event OrderFilled(
    bytes32 indexed orderHash,
    address indexed maker,
    address indexed taker,
    Side   side,              // 0 BUY, 1 SELL
    uint256 tokenId,          // single tokenId (not maker/taker asset IDs)
    uint256 makerAmountFilled,
    uint256 takerAmountFilled,
    uint256 fee,              // protocol-assessed at match time
    bytes32 builder,          // builder code for attribution (0x0 if none)
    bytes32 metadata          // opaque metadata
);

event OrdersMatched(
    bytes32 indexed takerOrderHash,
    address indexed takerOrderMaker,
    Side   side,
    uint256 tokenId,
    uint256 makerAmountFilled,
    uint256 takerAmountFilled
);
```

Key diffs from V1:
- `side` is now a direct event param (no need to infer from `makerAssetId == 0`)
- `tokenId` is a single field (V1 had `makerAssetId` + `takerAssetId`)
- `builder` attribution is native to the event
- `metadata` is new
- `fee` is protocol-assessed, not signed in by the maker

## Entities

- `OrderFilledEvent` — every matched fill, with derived `collateralAmount`/`tokenAmount`/`price`/`size` for convenience
- `OrdersMatchedEvent` — taker-order aggregation events
- `Account` — per-trader rollups (trades, volume, buy/sell counts)
- `Market` — per-tokenId rollups with `lastPrice`
- `Builder` — per builder-code rollups (orderCount, volume, fees); populated from the event directly
- `GlobalStats` — platform-wide counters

## Derivation conventions

```
BUY  (side=0): makerAmount = collateral paid    | takerAmount = tokens received
SELL (side=1): makerAmount = tokens sold        | takerAmount = collateral received

collateralAmount = side==BUY ? makerAmount : takerAmount
tokenAmount      = side==BUY ? takerAmount : makerAmount
price            = collateralAmount / tokenAmount   (0…1 range)
```

## Commands

```bash
npm install
npm run codegen   # generate types from ABIs + schema
npm run build     # compile WASM
npm run deploy    # deploy to Studio (edit slug in package.json)
```

## TODO before mainnet deploy

- [ ] Test against V2 test markets on `clob-v2.polymarket.com` (token_id `102936…7216` has liquidity)
- [ ] Validate BUY/SELL amount mapping against a known taker trade
- [ ] Confirm whether `FeeCharged` event (address receiver, uint256 amount) is worth indexing alongside `OrderFilled.fee`
- [ ] Decide if pause events (`TradingPaused`/`UserPaused`) belong in this subgraph or a sibling `admin` subgraph
