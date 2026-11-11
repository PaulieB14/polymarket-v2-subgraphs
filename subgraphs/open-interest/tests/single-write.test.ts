// One load + one save per market per event (indexer feedback): values must be
// exactly what the former multi-save helpers produced.
import { assert, beforeEach, clearStore, describe, newMockEvent, test } from "matchstick-as/assembly/index"
import { BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts"
import { ConditionResolution } from "../generated/ConditionalTokens/ConditionalTokens"
import { MarketOpenInterest } from "../generated/schema"
import { handleConditionResolution } from "../src/mapping"
import { setupEvent, split, convert, report, usdc, globalRaw, marketCount, eq, NrEvent, NRA } from "./nr-helpers"

const ZERO32 = Bytes.fromHexString("0x0000000000000000000000000000000000000000000000000000000000000000")

function nrResolve(ev: NrEvent, q: i32, yes: boolean): void {
  let e = changetype<ConditionResolution>(newMockEvent())
  let nums: BigInt[] = [BigInt.fromI32(yes ? 1 : 0), BigInt.fromI32(yes ? 0 : 1)]
  e.parameters = [
    new ethereum.EventParam("conditionId", ethereum.Value.fromFixedBytes(ev.conds[q])),
    new ethereum.EventParam("oracle", ethereum.Value.fromAddress(NRA)),
    new ethereum.EventParam("questionId", ethereum.Value.fromFixedBytes(ZERO32)),
    new ethereum.EventParam("outcomeSlotCount", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(2))),
    new ethereum.EventParam("payoutNumerators", ethereum.Value.fromUnsignedBigIntArray(nums)),
  ]
  handleConditionResolution(e)
  report(ev, q, yes)
}

function mkt(ev: NrEvent, q: i32): MarketOpenInterest {
  return MarketOpenInterest.load(ev.cid(q))!
}

function expectMarket(ev: NrEvent, q: i32, amount: i64, yes: i64, no: i64, conv: i32, mint: i32, burn: i32): void {
  let id = ev.cid(q)
  let m = mkt(ev, q)
  eq(usdc(amount), m.amountRaw, "q" + q.toString() + " amountRaw")
  eq(usdc(yes), m.yesSupplyRaw, "q" + q.toString() + " yesSupplyRaw")
  eq(usdc(no), m.noSupplyRaw, "q" + q.toString() + " noSupplyRaw")
  assert.fieldEquals("MarketOpenInterest", id, "amount", amount.toString())
  assert.fieldEquals("MarketOpenInterest", id, "yesSupply", yes.toString())
  assert.fieldEquals("MarketOpenInterest", id, "noSupply", no.toString())
  assert.fieldEquals("MarketOpenInterest", id, "conversionCount", conv.toString())
  assert.fieldEquals("MarketOpenInterest", id, "convertMintCount", mint.toString())
  assert.fieldEquals("MarketOpenInterest", id, "convertBurnCount", burn.toString())
}

describe("single save per market per event", () => {
  beforeEach(() => { clearStore() })

  test("repeated conversions in one block: amounts, supplies, decimals, counters and snapshot as before", () => {
    let ev = setupEvent(71, 3, 0)
    for (let i = 0; i < 3; i++) split(ev, i, usdc(100))
    convert(ev, BigInt.fromI32(0x1), usdc(10))
    expectMarket(ev, 0, 90, 100, 90, 1, 0, 1)
    expectMarket(ev, 1, 110, 110, 100, 1, 1, 0)
    expectMarket(ev, 2, 110, 110, 100, 1, 1, 0)
    eq(usdc(300), globalRaw(), "global after single-NO convert")
    convert(ev, BigInt.fromI32(0x3), usdc(20))
    expectMarket(ev, 0, 70, 100, 70, 2, 0, 2)
    expectMarket(ev, 1, 90, 110, 80, 2, 1, 1)
    expectMarket(ev, 2, 130, 130, 100, 2, 2, 0)
    eq(usdc(280), globalRaw(), "global after 2-NO convert releases (k-1)*amount")
    assert.i32Equals(3, marketCount())
    // hourly snapshot carries the post-event amount
    let m2 = mkt(ev, 2)
    let snapId = m2.id + "-" + m2.lastUpdatedTimestamp.div(BigInt.fromI32(3600)).toString()
    assert.fieldEquals("OISnapshot", snapId, "amountRaw", usdc(130).toString())
    assert.fieldEquals("OISnapshot", snapId, "amount", "130")
  })

  test("conversion minting YES on an untouched question already resolved NO: created once, lastUpdated set", () => {
    let ev = setupEvent(72, 3, 0)
    split(ev, 0, usdc(10))
    split(ev, 2, usdc(10))
    nrResolve(ev, 1, false)
    assert.assertNull(MarketOpenInterest.load(ev.cid(1)))
    convert(ev, BigInt.fromI32(0x1), usdc(5))
    let m1 = mkt(ev, 1)
    assert.assertTrue(m1.resolved, "starts resolved from ConditionPayout")
    eq(BigInt.zero(), m1.yesSupplyRaw, "YES pinned at 0")
    eq(BigInt.zero(), m1.amountRaw, "no OI credited on a lost question")
    eq(m1.createdAtBlock, m1.lastUpdatedBlock, "lastUpdatedBlock set on creation")
    assert.fieldEquals("MarketOpenInterest", ev.cid(1), "convertMintCount", "1")
    assert.fieldEquals("MarketOpenInterest", ev.cid(1), "conversionCount", "0")
    assert.i32Equals(3, marketCount())
  })
})
