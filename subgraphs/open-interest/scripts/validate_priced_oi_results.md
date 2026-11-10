# PR #6 broader RPC validation

Pinned Polygon block **97,090,132**. `eth_call` via Alchemy, `eth_getLogs` via Tenderly.
Gamma prices and Polymarket data-API OI (`https://data-api.polymarket.com/v2/oi?condition=<id>`, curl) were fetched back-to-back at the end of the run.
Burned NO is `balanceOf(0xa5ef39c3d3e10d0b270233af41cac69796b12966, noPositionId)` at the pinned block.
Live deployment: `QmUoL9MFKUgjkAhY4apuxLZK87LRsvTVqPpkS9KYsgVboH` (amount must be unchanged by this PR).

## Verdict

**The yesSupply / noSupply math is correct and ready to resync.** Priced OI = `yesSupply * p + noSupply * (1-p)` matches Polymarket's data API on the same markets that previously matched, and on most other supply-stable markets.

The earlier Newsom leftover is **not missed split logs.** An independent Tenderly recount with 200k-block pages (no cache) of adapter `PositionSplit` / `PositionsMerge` for Newsom (Dem nom) through block 97,090,132 returned **exactly 79,525 splits and 69,223 merges**, the same as the replay. The live subgraph at that same block reports 79,625 / 69,306 and an `amount` **$166.60 higher**. Dense windows (including 83,846,050–85,846,049, 42,180 splits) were also recounted with 50k-block pages and matched the cache to the log.

A 10k `eth_getLogs` cap was still added (Tenderly can silently truncate around 20k). It did not change the Newsom totals, because those pages were not truncated. Some other markets where the live deployment's `amount` disagrees with raw logs are the same class: the replay matches the chain, the current deployment does not. PR #6 does not change `amount`; a resync will recompute it from the same handlers.

Nothing has been merged, deployed, or published. A full resync is still required for the new fields.

## Coverage

- **100 markets** at one fixed block: **50 negRisk** across **18 events** (question counts 2, 3, 4, 5, 7, 8, 10, 11, 13, 28, 33, 53, 128) and **50 regular**.
- Mix includes favorites (Senate Republicans-lose p=0.987), long shots (Hamilton / Platner p=0.0005), mid-priced, 6 Dem-nomination placeholders, and resolved markets of both types (YES and NO, including heavy-convert and heavy-redeem cases).
- 26 markets traded after the pin (lastUpdated > 97,090,132); their live API numbers are not comparable to pinned supplies and are excluded from the residual stats below. **74 markets were supply-stable**; **43** of those had both a Gamma price and an API row.

## Residual stats (supply-stable markets only)

| set | n | within $1 | within $100 | within 0.1% | within $1 or 0.1% |
|---|---:|---:|---:|---:|---:|
| priced OI vs data-API | 43 | 29 | 36 | 39 | 39 |

### Highlighted markets

| Market | amount | yesSupply | noSupply | p | priced OI | API | priced−API | amount−API | burn NO Δ |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Adam Hamilton (Dem nom) | 3,186,244.98 | 3,186,244.98 | 0.07 | 0.0005 | 1,593.19 | 1,593.19 | +0.00 | +3,184,651.80 | 0 |
| Republicans lose AK/IA/KS/ME/MI/OH/TX | 3,454,655.24 | 5,011,710.50 | 2,457,868.05 | 0.9870 | 4,978,510.55 | 4,978,505.55 | +5.00 | -1,523,850.31 | 0 |
| regular aliens-before-2027 | 8,955,834.52 | 8,955,834.52 | 8,955,834.52 | 0.0165 | 8,955,834.52 | 8,955,834.52 | +0.00 | +0.00 | 0 |
| Gavin Newsom (Dem nom) | 4,100,997.91 | 5,989,925.50 | 2,803,680.58 | 0.1025 | 3,130,270.68 | 3,129,014.31 | +1,256.38 | +971,983.60 | 0 |
| Gavin Newsom (Presidential) | 3,223,261.60 | 3,948,880.96 | 1,063,778.73 | 0.0815 | 1,298,914.56 | 1,298,904.52 | +10.04 | +1,924,357.08 | 0 |
| placeholder fd83 (Dem nom) | 3,186,244.92 | 3,186,244.92 | 0.00 | — | — | — | — | — | 0 |

- Hamilton, the aliens regular market, Platner, Stewart, The Rock, Hunter Biden, and several mid-priced markets match the API to a fraction of a cent.
- Senate (p=0.987) is **+$5.00** (0.0001%): a 4-decimal price tick on a large (yes−no) imbalance.
- Newsom (Dem) is **+$1,256.38 (0.040%)**, inside the 0.1% band. Same supplies as the earlier 4-market test; the API figure moved. This is not a missing-log error.
- Newsom (Presidential) is **+$10.04 (0.001%)**.
- Placeholders have no Gamma/API row. Their entire `amount` is YES minted by conversions onto empty questions; priced OI would be ~$0 at a long-shot price.

### Outliers among supply-stable markets (|&Delta;| > $1 and > 0.1%)

| market | type | p | priced | API | residual | vs 0.1% | notes |
|---|---|---:|---:|---:|---:|---:|---|
| 10q open c (n>1 convert) | negRisk | 0.63 | 23,798.18 | 23,940.38 | -142.19 | 0.594% | Replay 524/204 vs subgraph 529/209; same chain-vs-deployment class, 0.59%. |
| regular low 10.03 | regular | 0.395 | 10.03 | 83.20 | -73.17 | 87.941% | Replay 3 splits / 1 merge vs subgraph 5/2; API equals the subgraph, not the chain. |
| regular low 10.04 | regular | 0.51 | 10.04 | 5,705.98 | -5,695.94 | 99.824% | Chain has 5 parent-0 CTF splits / 3 merges (full-history scan). Live subgraph reports 13/3 and $5,705.98, which matches the API, not the chain. |
| regular_mid 0xd64b917e | regular | 0.0275 | 670,801.66 | 670,057.26 | +744.40 | 0.111% | Replay has one fewer merge than the subgraph; API follows the subgraph ($744 / 0.111%). |

These residuals are **not** a yes/no supply formula bug: on the regulars, yes==no==amount, so priced OI equals `amount` regardless of p. Independent `eth_getLogs` on `regular low 10.04` (all CTF `PositionSplit` for that conditionId, any parent, from block 50,000,000 through the pin) found **5 splits total**, not 13. The current deployment and the data API agree with each other and disagree with the chain. The replay follows the chain.

## Invariants

- Unresolved regular markets with `yesSupply == noSupply == amount`: **43 / 43**.
- Negative `yesSupply`: **0** (none).
- Negative `noSupply`: **1** — market `negative amount (-1533) reported NO`. Its `amount` already matches the live subgraph (`amount_vs_sg = 0`); this is a pre-existing reported-NO bookkeeping case from PR #4, not a new PR #6 regression. `yesSupply` stays non-negative.
- Negative `amount`: **3** markets, all in the pre-existing `negative_amount` / reported-NO seed set, and all with `amount` equal to the live subgraph.
- Burn-address vs expected `minted+burned` (negRisk): **49 / 50** exact. The one miss is `negative amount (-772) many redemptions` (Δ raw = 172,350,001, about $172), a heavy-redemption resolved market.
- Per-market `amount` vs live subgraph: exact on most markets. Remaining gaps are the chain-vs-current-deployment class above (Newsom Dem **−$166.60** with a confirmed 100/83 split/merge under-count *on the subgraph*; several $1–$744 one-event gaps; the 10.03/10.04 cases). PR #6 leaves `amount` unchanged, so these already exist on `QmUoL9MF…`.

## Historical spot check

Replayed `amount` at block **96,090,132** (~1M earlier) vs the same live deployment queried with `block: { number: 96090132 }`.
- Compared: 79; exact: 65; missing on subgraph: 0; mismatches: 14.
- High-volume negRisk mismatches are the same dollar deltas as at the pin (e.g. Newsom Dem still **−$166.60**), which is what you'd expect if the extra subgraph counts predate both blocks.
- Four `regular resolved 1999 redeems *` markets are large mismatches because CTF `PayoutRedemption.conditionId` is **not indexed**, so a lifetime redeem replay is not reliable. Unresolved regulars are not affected. This is a known limitation, not a PR #6 supply bug.

## Global flow (2,000-block window ending at the pin)

- Subgraph global Δ: $1,807,508.91
- Replayed flow (CTF USDC.e split−merge−redeem + adapter split−merge−redeem − convert released): $1,810,203.14
- Difference: $-2,694.24 (0.15% of the window). Close, not exact; the window itself needed cap-splits on CTF split/redeem pages.

Fee-bearing multi-question events: none in the universe (one 1-question event has feeBps=100; the fee branch of convert has no numeric check here). Transfer-event mint/burn recount was skipped to stay inside the time box; burn-address `balanceOf` was used instead.

## Unit tests

`graph test` still refuses this host (`Unsupported platform: Linux x64 13`; no Docker). The official LimeChain `binary-linux-22` matchstick 0.6.0 runs here.

All **39/39** tests passed on perf commit `22b21f2` (Tue, 10 Nov 2026, 4:48 PM America/New_York), including yes/no supply assertions, negRisk rules, randomized properties, and two real-data event replays. `npm test` now uses `scripts/run-matchstick.sh` (commit `7e34005`).

## Perf (indexer suggestion #1)

Commit `22b21f2` (consumer-invisible): write `OISnapshot` without `load()`; load `Condition` only when no `MarketOpenInterest` exists yet; compare collateral as `Address` bytes; replace host `pow` with a precomputed 1e6 `BigDecimal`. Same writes, same order, same values. `graph build` passed. Suggestions #2 and #3 were not taken.

## Commits

| SHA | What |
|---|---|
| `18c999f0` | yesSupply / noSupply (original PR) |
| `22b21f2` | indexer perf #1 |
| `7e34005` | Matchstick runner for Debian 13; 39/39 passed |
| `e5ff182` | 10k log cap + validation script + this report |

Nothing merged, deployed, or published.
