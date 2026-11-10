# Validation (Polygon, 10 Nov 2026)

Pinned block **97,088,270**. `eth_call` via Alchemy, `eth_getLogs` via Tenderly
(Alchemy's free plan only allows a 10-block log window). Prices and data-api OI
were fetched at the same time as the chain reads. CTF has no `totalSupply`;
burned NO was checked with `balanceOf(NO_TOKEN_BURN_ADDRESS, noPositionId)`.

`priced` = `yesSupply * p + noSupply * (1-p)` with Gamma / CLOB yes price `p`.
API = `https://data-api.polymarket.com/v2/oi?condition=<id>`.

| Market | amount (collateral) | yesSupply | noSupply | p(yes) | priced OI | Polymarket API | priced − API | amount − API | burn NO Δ |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Adam Hamilton (Dem nom) | 3,186,244.98 | 3,186,244.98 | 0.07 | 0.0005 | 1,593.188159 | 1,593.188159 | $0.00 | +$3,184,651.80 | 0 |
| Placeholder (Dem nom) `0xfd83…` | 3,186,244.92 | 3,186,244.92 | 0 | n/a (unlisted) | n/a | n/a | — | — | 0 |
| Gavin Newsom (Dem nom) | 4,100,997.91 | 5,989,925.50 | 2,803,680.58 | 0.1025 | 3,130,270.68 | 3,129,886.93 | +$383.76 | +$971,110.98 | 0 |
| Republicans lose AK/IA/… Senate | 3,454,655.24 | 5,011,710.50 | 2,457,868.05 | 0.9875 | 4,979,787.473883 | 4,979,787.473883 | $0.00 | −$1,525,132.23 | 0 |
| Regular (aliens before 2027) | 8,955,024.852464 | 8,955,024.852464 | 8,955,024.852464 | 0.0165 | 8,955,024.852464 | 8,955,024.852464 | $0.00 | $0.00 | 0 |

Notes:

- On-chain burned NO equals `minted + burned` from `PositionsConverted` on every
  neg-risk market (the complement's synthetic NO is also sent to the burn
  address). CTF has no totalSupply, so circulating supplies are from the log
  replay.
- Hamilton, the Senate market, and the regular market match the data-api to a
  fraction of a cent when priced. The Senate API moved by exactly
  `(yesSupply − noSupply) * Δp` when Gamma's price ticked from 0.9865 to
  0.9875 between two runs, which is the priced-OI definition in action.
- Newsom's leftover ~$384 (0.01%) is from a 4-decimal price plus a few missed
  high-volume split/merge logs (Tenderly count was 79,525 / 69,223 vs the live
  subgraph 79,625 / 69,306). Conversion minted/burned on Newsom still match the
  subgraph and the burn address to the token.
- The placeholder has no Gamma listing and no API row. Its entire `amount` is
  YES minted by conversions onto an empty market, which the API would price
  near $0.
- Adapter split/merge/redeem are not double-counted: CTF handlers skip
  WrappedCollateral; only the adapter events move neg-risk OI.

## Dem-nomination event identity (128 questions, 2,747 conversions, feeBps = 0)

Per-market `amount` = net splits + minted − burned. The event's contribution to
**global** OI is net splits − `(k−1)*amount` released. Those do **not** tie
while the event is unresolved:

| | USDC |
|---|---:|
| Sum of conversion YES mints across the 128 questions | 402,068,171.72 |
| Sum of conversion NO burns | 5,771,177.90 |
| Collateral released to users `(k−1)*amount` | 2,584,932.98 |
| `sum(amount) − global_delta` = minted − burned + released | **398,881,926.80** |

`net_splits` cancel in that identity, so this gap is computed from
`PositionsConverted` and `QuestionPrepared` logs alone. After
`OutcomeReported` settlement, per-question `amount` is supposed to line up
with global again (existing PR #4 tests).

A full resync is required; grafting cannot repair historical `amount` or the
new supply fields.
