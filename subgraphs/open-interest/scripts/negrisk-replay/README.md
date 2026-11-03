# negRisk real-data replay

`tests/fixtures/negrisk-real/fixture-<tag>.json` holds every NegRiskAdapter event for one
negRisk event (MarketPrepared, QuestionPrepared, PositionSplit, PositionsMerge,
PayoutRedemption, PositionsConverted, OutcomeReported), in chain order (block, logIndex).
They were pulled from the public Pinax Polygon RPC:

    python3 fetch.py <marketId> <fromBlock> <toBlock>     # writes fixture-<last6>.json

- `gen_matchstick.py <fixture> <tag> <tolerance_usdc>` generates `tests/real-<tag>.test.ts`,
  which replays the fixture through the real mapping handlers in chunks and asserts that no
  question ever goes negative, every question settles within the tolerance of $0, and
  sum(per-question) == global.
- `tri.py <fixture...>` is a fast Python port of the three allocation rules (pre-#3, #3, current)
  for side-by-side numbers. The pre-#3 port reproduces deployment QmTUZ6v7…CMu21d to the cent.

Events: `0xd5b2…384700` (7 q), `0x9e3d…787e00` (6 q), `0xa62e…2abf00` (20 q) and more as added.

## Large events (not committed)

Two bigger real events were also verified locally but are not committed (fixtures 4.4 MB and
23 MB). Regenerate them on demand into the git-ignored `large/` folder:

    cd subgraphs/open-interest
    mkdir -p tests/fixtures/negrisk-real/large && cd tests/fixtures/negrisk-real/large
    python3 ../../../../scripts/negrisk-replay/fetch.py 0xa62e2553c597d6645d4d67d8a8143bb7763f7954ce51ab35cd0afd12bd2abf00 69500000 <head>
    python3 ../../../../scripts/negrisk-replay/fetch.py 0x7ececd30ae105590c0076c8197e9255a0095f7c3aa2e07fd8bd02fd50dc68400 72500000 <head>
    cd ../../../..
    G=scripts/negrisk-replay/gen_matchstick.py; D=tests/fixtures/negrisk-real/large
    python3 $G $D/fixture-2abf00.json large-2abf00 10
    # 185k events: Matchstick runs out of wasm memory in one file, so split at a checkpoint
    python3 $G $D/fixture-c68400.json large-c68400 50000 1500 0 90000
    python3 $G $D/fixture-c68400.json large-c68400 50000 1500 90000

Then rename the generated `tests/real-large-*.test.ts` files (already git-ignored) and run Matchstick.
Results at commit time: 2abf00 (20 q, 36,281 events) settles max $4.29/question, sum $6.06 = global;
c68400 (4 q, 185,183 events) max $46,990, sum $64,617.06 = global (unredeemed winning tokens), never negative.
