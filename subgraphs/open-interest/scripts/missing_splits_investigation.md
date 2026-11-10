# Follow-up: “missing splits” on PR #6 outliers

2026-11-10, America/New_York. Pinned validation block **97,090,132**. Live deployment `QmUoL9MFKUgjkAhY4apuxLZK87LRsvTVqPpkS9KYsgVboH`. No merge, deploy, or publish.

Raw receipts, time-travel walks, and activity-subgraph dumps live in `/workspace/pr6-validation/missing-splits/` (not committed).

## Plain-language conclusion

The “13 vs 5 splits” story on regular market 10.04 was not a missed on-chain path in the replay. It was a **time-mismatch**.

At block 97,090,132 the chain, the live OI subgraph, the official-style activity subgraph, and the replay all show **5 splits, 3 merges, amount $10.04**. After the pin — in a burst of CTF Exchange V2 mint-matches at blocks 97,093,179–97,093,183 and 97,093,312 — eight more ordinary `PositionSplit` events added **$5,695.94**, bringing the tip to **13 splits, $5,705.978041**. That tip amount equals today’s data-api `/v2/oi` and Gamma `volume`.

data-api `/v2/oi` has no historical block. The validation run hydrated subgraph rows at **chain tip**, replayed to the **pin**, and on resume left the fresh tip row in `results_ext.json` while `progress.json` kept the earlier row. So 10.04 (and 10.03, d64b, 10q-c) looked like subgraph overcounts. They are not.

The replay script was **not** changed to listen for a new event. Those post-pin splits are the same CTF `PositionSplit(parent=0, partition=[1,2], collateral=USDC.e)` the replay already counts, including when the stakeholder is the newer collateral-adapter sibling `0xada10087…`. Replaying to a later block would pick them up automatically.

**Newsom is the one real at-pin discrepancy that remains:** replay and an independent Tenderly recount of NegRiskAdapter logs both get **79,525 splits / 69,223 merges / amount $4,100,997.91**. The live deployment at the same block reports **79,625 / 69,306 / $4,101,164.50** (100 extra splits, 83 extra merges, **+$166.60**). That gap already existed at the pin; after the pin the market only added one merge (−$872.62 at block 97,095,251). There is still no extra transaction list from the OI subgraph (it stores counts and snapshots, not every event id), so those 100 extra splits were not isolated to individual txs.

For unresolved regular markets that actually stay still after the pin, API OI matches chain+subgraph amount (10.04 and 10.03 at tip, d64b after its post-pin merge). The subgraph is **not** missing a mint path versus the API on those markets. API > pin-block subgraph on 10.04 was just the API being current. Newsom’s API (~$3.13M) tracks **priced** OI, not unpriced `amount` (~$4.10M); that is a different comparison than missed splits.

## Official / third-party subgraphs

- Goldsky `oi-subgraph/0.0.6` and `activity-subgraph/0.0.4` under `project_cl6mb8i9h0003e201j6li0diw` return `ENDPOINT_DEPRECATED` (paused after Polymarket’s V2 migration; they tell you to use Goldsky Edge / Turbo).
- The Graph network activity subgraph `Bx1W4S7kDVxs9gC3s2G6DS8kdNBJNVhMviCtin2DiBp` (deployment `Qmf3qPUsfQ8et6E3QNBmuXXKqUJi91mo5zbsaTkQrSnMAP`) is **live** (head was 97,096,006 during this run). Entities: `Split`, `Merge`, `Redemption`, `NegRiskConversion`, `Condition`, `Position`. `Split` has `id` (`txhash_logIndex`), `timestamp`, `stakeholder`, `condition`, `amount`.

Activity vs our deployment vs replay at the **pin**:

| market | pin QmUoL9 / replay | pin activity (Split−Merge net) | tip QmUoL9 / activity / API |
|---|---|---|---|
| 10.04 Baylor −19.5 | 5 / 3 / $10.04 — all three agree | 5 / 3 / $10.04 | 13 / 3 / $5,705.978041 — all three agree |
| 10.03 Suns −6.5 | 3 / 1 / $10.033897 — all three agree | 3 / 1 / $10.033897 | 5 / 2 / $83.204629 — all three agree |
| d64b regular mid | 1203 / 541 / $670,801.66 — all three agree | 1203 / 541 / $670,801.66 | 1203 / 542 / $670,057.26 (one merge −$744.40 at 97,094,394); API = tip amount |
| 10q-c (negRisk) | 524 / 204 / amount $28,621.62 — QmUoL9 = replay | 524 / 204 but net $14,497.78 (Split−Merge only; conversions are a separate entity) | counts kept moving after the pin (tip 531 / 216); API $23,995 is priced, not `amount` |
| Newsom (Dem nom) | QmUoL9 79,625 / 69,306 / $4,101,164.50 vs replay 79,525 / 69,223 / $4,100,997.91 | 15,417 / 23,985 / net −$2.86M. Time range starts at market creation (2025-07-11 13:47:50 ET) but this subgraph is clearly not counting the same NegRiskAdapter event set | tip: still 79,625 splits, one extra merge |

Activity is a good third reference for **v1 CTF regulars**. It is not a usable count-oracle for Newsom’s adapter-level OI.

## 10.04 mechanism (receipts)

Time-travel / `OISnapshot` on QmUoL9 (only one snapshot after the pin, at 97,093,312) plus block-by-block count bisection:

| block | splits | amount | Δ amount |
|---:|---:|---:|---:|
| 97,090,132 (pin) | 5 | 10.04 | — |
| 97,093,179 | 6 | 2,769.04 | +2,759.00 |
| 97,093,180 | 8 | 2,792.74 | +23.70 |
| 97,093,181 | 9 | 2,794.74 | +2.00 |
| 97,093,182 | 11 | 5,600.487844 | +2,805.747844 |
| 97,093,183 | 12 | 5,621.978041 | +21.490197 |
| 97,093,312 | 13 | 5,705.978041 | +84.00 |

All eight post-pin splits were also in the activity subgraph (ids `0x8348b921…`, `0x2db7ac30…`, `0x4268fcba…`, `0xd7dcf8bc…`, `0x411289d8…`, `0x0416ad52…`, `0xdd6eeaf9…`, `0x3b8c45b8…`).

`eth_getLogs` (Tenderly; Alchemy agreed on the blocks where it was not rate-limited): every event is CTF `PositionSplit` with `parentCollectionId = 0`, `partition = [1,2]`, `collateralToken = USDC.e`. No non-zero parent, no odd partition, no unexpected collateral, no V2 PositionManager/BinaryModule path (this market is Gamma `version: "v1"`).

`eth_getTransactionReceipt` on the $2,759 mint (`0x8348b921…`, block 97,093,179, `to = CTFExchangeV2` `0xE1111800…`):

1. pUSD ERC-20 transfers and a USDC.e approve — unwrap pUSD → USDC.e.
2. CTF `TransferBatch` (mint of the YES/NO pair).
3. CTF `PositionSplit` for $2,759, stakeholder `0xada100874d00e3331d00f2007a9c336a65009718`.
4. CTF `TransferSingle` of the **NO** token (`…02763034763`) from the exchange to `0x52685279…` for $2,759.
5. CTF `TransferSingle` of the **YES** token (`…35794313606`) from the exchange to `0x84cfffc3…` for $2,759.
6. CTF Exchange V2 order-match events, plus the Polygon fee precompile.

That is the documented Exchange V2 **MINT** path: one side of the match is “mint complete set,” the adapter is the CTF stakeholder, and YES and NO are paid out to the two makers. The replay already includes these `PositionSplit` logs; it does not filter out the adapter or the exchange.

The other six 10.04 post-pin txs are the same shape (`to = CTFExchangeV2`, same contracts, same adapter). One 10.03 $200 split+merge batch went to a 124-byte proxy `0x93118ca1…` (storage slot 0 = `0xe51abdf8…`) with official `CtfCollateralAdapter` as stakeholder; the receipt contains two CTF splits, but only one is this condition (the other is a sibling market in the same batch).

`debug_traceTransaction` / `trace_transaction` were **not** available: Alchemy free tier rejects `trace_transaction`; Tenderly returned `rate limit exceeded` after the earlier log work. Receipt logs were enough to identify the call path.

Two sibling collateral adapters (same owner `0x47ebfac3…`, nearly identical bytecode, slightly different size):

- `0xAdA100Db00Ca00073811820692005400218FcE1f` — CtfCollateralAdapter (already in the mappings)
- `0xada100874d00e3331d00f2007a9c336a65009718` — newer sibling, used as stakeholder on most Exchange V2 mints
- Same pattern on neg-risk: official `0xadA20056…` and sibling `0xada200001000ef00…`

They still emit the CTF / NegRiskAdapter `PositionSplit` the subgraph already handles. No mapping change is required.

## Hypotheses (1–7), checked

1. **Exchange `matchOrders` MINT → `splitPosition` with the exchange or adapter as stakeholder.** Yes, that is exactly the post-pin 10.04 path. Those `PositionSplit` logs are in the replay when the block range includes them. Not filtered out.
2. **Non-zero `parentCollectionId` or partitions other than [1,2].** Not on these outliers (any-parent log counts matched parent=0).
3. **NegRiskAdapter / WCOL splits on a regular market.** Not on 10.04 / 10.03 / d64b.
4. **V2 PositionManager / new collateral.** 10.04/10.03/d64b are Gamma v1, USDC.e via the adapters above (pUSD is only the wrap layer). V2 `PositionsSplit` is a separate ledger the subgraph does not index; it does not appear on these receipts.
5. **A different CTF-like contract.** Receipts only show the known ConditionalTokens address.
6. **Log pagination / RPC dropping logs.** For 10.04, Tenderly and Alchemy agreed; the 5 pre-pin and 8 post-pin splits are all on both the activity subgraph and QmUoL9 once you query the right block. Newsom’s leftover is **not** a Tenderly 20k-page drop (already independently recounted).
7. **The live subgraph counting something that isn’t a split.** For 10.04/10.03/d64b, no — tip counts match chain and activity. For Newsom, the live deployment is 100 splits / 83 merges / $166.60 above raw adapter logs and the replay. Activity cannot name the extra txs.

## Validation-script fix (this commit)

`hydrate()` and `expand_universe()` queried market rows at **HEAD**. A resumed run then compared a **cached pin replay** to the **new HEAD** subgraph row (the checkpoint compared stale `prev["sg"]` to the cached replay, so it did not refresh), and wrote that mix into `results_ext.json`. `progress.json` kept the old row, which is why the two files disagreed.

This commit:

- Refetches every market’s subgraph row at the pinned block before replay.
- On resume, compares that pin row to the cached replay.
- Re-reads tip `lastUpdatedBlock` and **excludes** markets that moved after the pin from priced-OI vs data-api residuals, because `/v2/oi` and Gamma prices are tip-only.

The 100-market validation was not re-run here. Newsom’s at-pin leftover is unchanged by this fix.

## What we did not change

- No replay event-filter changes (none were needed for the 10.04/10.03/d64b gaps).
- No mapping changes for the adapter siblings (events already flow through CTF / NegRiskAdapter).
- No merge, deploy, or publish.
