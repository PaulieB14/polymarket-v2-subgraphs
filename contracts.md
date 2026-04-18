# Polymarket V2 contracts (Polygon chainId 137)

## New for V2

Deployed **2026-03-31** by Polymarket Deployer 1 `0xca71ea69c54c163d17beb90beb8d001e1eb538a1`.

| Contract | Address | Role |
|---|---|---|
| CTF Exchange V2 | `0xE111180000d2663C0091e4f400237545B87B996B` | Order matching, fees, builder attribution |
| Neg Risk CTF Exchange V2 | `0xe2222d279d744050d28e00520010520000310F59` | Neg-risk market order matching |
| CtfCollateralAdapter | `0xADa100874d00e3331D00F2007a9c336a65009718` | Wraps CTF split/merge/redeem with pUSD↔USDC.e unwrap |
| NegRiskCtfCollateralAdapter | `0xAdA200001000ef00D07553cEE7006808F895c6F1` | Same for neg-risk markets |
| pUSD proxy | `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB` | User-facing ERC-20 wrapper |
| pUSD implementation | `0x6bBCef9f7ef3B6C592c99e0f206a0DE94Ad0925f` | |
| CollateralOnramp | `0x93070a847efEf7F70739046A929D47a521F5B8ee` | USDC.e → pUSD `wrap()` |
| CollateralOfframp | `0x2957922Eb93258b93368531d39fAcCA3B4dC5854` | pUSD → USDC.e `unwrap()` |

## Carried over from V1 (unchanged addresses)

| Contract | Address | Role |
|---|---|---|
| Conditional Tokens Framework | `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` | Canonical Gnosis CTF |
| Neg Risk Adapter | `0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296` | Prepares neg-risk conditions (deployed Nov 2023) |
| UMA CTF Adapter | `0x6A9D222616C90FcA5754cd1333cFD9b7fb6a4F74` | Oracle bridge |
| UMA Optimistic Oracle V2 | `0xCB1822859cEF82Cd2Eb4E6276C7916e692995130` | Resolution |
| USDC.e | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` | CTF-level collateral (still used under the hood) |

## V2 split flow (verified on-chain)

Decoded tx `0xed7b2c2db25397ab53fe9e4580d4c97bfd61ac447a0f36d6d8a3b6e2f15a0651`:

```
EOA 0xdD9A…25d3
  └─▶ CtfCollateralAdapter.splitPosition(4,000,000 pUSD)
        ├─ pUSD Transfer: user → 0xC011…2DFB (4M)   [burn pool]
        ├─ pUSD Transfer: 0xC011…2DFB → 0x0  (4M)   [actual burn]
        ├─ USDC.e Transfer: adapter → CTF (4M)
        └─ CTF emits PositionSplit {
             stakeholder: 0xADa1…9718,          ← adapter, NOT the user
             collateralToken: USDC.e             ← still USDC.e
           }
```

### Consequences for subgraphs

1. **`PositionSplit.stakeholder` is the adapter**, not the EOA. Per-user attribution needs tx-level unmasking via the pUSD burn `Transfer.from` in the same tx.
2. **CTF-level collateral is still USDC.e.** pUSD is purely wallet-facing. OI math continues to work unchanged.
3. **pUSD ↔ USDC.e is 1:1**, enforced onchain.

## Key blocks & deploy info

- V2 Exchange deployment: **block 84902353** (2026-03-31)
  - Tx: `0xd313453c195344b3eea2d91343fb840e51130ba5562fb9c9eda83fd0f82c6c97`
- Cutover / go-live: **2026-04-28 ~11:00 UTC**
- Testnet / preprod: `https://clob-v2.polymarket.com`

## Test markets (live on clob-v2)

- US/Iran nuclear deal in 2027: token_id `102936224134271070189104847090829839924697394514566827387181305960175107677216`
- Highest grossing movie 2026: token_id `81662326158871781857247725348568394697379926716334270967994039975048021832777` (and 5 others)
