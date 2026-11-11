import { assert, beforeEach, clearStore, describe, newMockEvent, test } from "matchstick-as/assembly/index"
import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts"
import {
  ConditionPreparation,
  PositionSplit,
  PayoutRedemption,
  ConditionResolution,
} from "../generated/ConditionalTokens/ConditionalTokens"
import { MarketOpenInterest } from "../generated/schema"
import { handleConditionPreparation, handlePositionSplit, handlePayoutRedemption, handleConditionResolution } from "../src/mapping"
import { setupEvent, split as nrSplit, convert, report, redeemAmounts, usdc, raw, globalRaw, eq, NrEvent } from "./nr-helpers"

const USDC_E = Address.fromString("0x2791bca1f2de4661ed88a30c99a7a9449aa84174")
const NRA = Address.fromString("0xd91e80cf2e7be2e162c6513ced06f1dd0da35296")
const USER = Address.fromString("0xada100db00ca00073811820692005400218fce1f")
const ZERO32 = Bytes.fromHexString("0x0000000000000000000000000000000000000000000000000000000000000000")
const COND = Bytes.fromHexString("0xd391104c756f2371defe4daec7e7fa70470ed383c6be338037aab736bca61b19")
const CID = "0xd391104c756f2371defe4daec7e7fa70470ed383c6be338037aab736bca61b19"

function p(name: string, v: ethereum.Value): ethereum.EventParam { return new ethereum.EventParam(name, v) }
function u(n: i64): ethereum.Value { return ethereum.Value.fromUnsignedBigInt(BigInt.fromI64(n)) }
function arr(xs: i32[]): ethereum.Value {
  let out: BigInt[] = []
  for (let i = 0; i < xs.length; i++) out.push(BigInt.fromI32(xs[i]))
  return ethereum.Value.fromUnsignedBigIntArray(out)
}
function prepare(cond: Bytes): void {
  let e = changetype<ConditionPreparation>(newMockEvent())
  e.parameters = [
    p("conditionId", ethereum.Value.fromFixedBytes(cond)),
    p("oracle", ethereum.Value.fromAddress(USER)),
    p("questionId", ethereum.Value.fromFixedBytes(ZERO32)),
    p("outcomeSlotCount", u(2)),
  ]
  handleConditionPreparation(e)
}
function ctfSplit(cond: Bytes, amount: i64): void {
  let e = changetype<PositionSplit>(newMockEvent())
  e.parameters = [
    p("stakeholder", ethereum.Value.fromAddress(USER)),
    p("collateralToken", ethereum.Value.fromAddress(USDC_E)),
    p("parentCollectionId", ethereum.Value.fromFixedBytes(ZERO32)),
    p("conditionId", ethereum.Value.fromFixedBytes(cond)),
    p("partition", arr([1, 2])),
    p("amount", u(amount)),
  ]
  handlePositionSplit(e)
}
function ctfRedeem(cond: Bytes, sets: i32[], payout: i64): void {
  let e = changetype<PayoutRedemption>(newMockEvent())
  e.parameters = [
    p("redeemer", ethereum.Value.fromAddress(USER)),
    p("collateralToken", ethereum.Value.fromAddress(USDC_E)),
    p("parentCollectionId", ethereum.Value.fromFixedBytes(ZERO32)),
    p("conditionId", ethereum.Value.fromFixedBytes(cond)),
    p("indexSets", arr(sets)),
    p("payout", u(payout)),
  ]
  handlePayoutRedemption(e)
}
function resolve(cond: Bytes, yes: i32, no: i32, oracle: Address): void {
  let e = changetype<ConditionResolution>(newMockEvent())
  e.parameters = [
    p("conditionId", ethereum.Value.fromFixedBytes(cond)),
    p("oracle", ethereum.Value.fromAddress(oracle)),
    p("questionId", ethereum.Value.fromFixedBytes(ZERO32)),
    p("outcomeSlotCount", u(2)),
    p("payoutNumerators", arr([yes, no])),
  ]
  handleConditionResolution(e)
}
function m(id: string): MarketOpenInterest { return MarketOpenInterest.load(id)! }
function ys(id: string): BigInt { return m(id).yesSupplyRaw }
function ns(id: string): BigInt { return m(id).noSupplyRaw }
function n(x: i64): BigInt { return BigInt.fromI64(x) }

describe("regular market resolution (issue 1)", () => {
  beforeEach(() => { clearStore(); prepare(COND) })

  test("YES wins: losing NO -> 0, two-sided [1,2] redemptions lower YES by payout; amount unchanged semantics", () => {
    ctfSplit(COND, 100000000)
    resolve(COND, 1, 0, USER)
    assert.fieldEquals("MarketOpenInterest", CID, "resolved", "true")
    eq(n(100000000), ys(CID), "yes after resolve")
    eq(BigInt.zero(), ns(CID), "losing no zeroed")
    ctfRedeem(COND, [1, 2], 60000000)
    eq(n(40000000), ys(CID), "yes after redeem")
    eq(BigInt.zero(), ns(CID), "no stays 0")
    eq(n(40000000), m(CID).amountRaw, "amount = unredeemed collateral")
    ctfRedeem(COND, [1, 2], 0) // loser redeems worthless NO: counted, supplies unchanged
    assert.fieldEquals("MarketOpenInterest", CID, "redemptionCount", "2")
    ctfRedeem(COND, [1, 2], 40000000)
    eq(BigInt.zero(), ys(CID), "fully redeemed")
    eq(BigInt.zero(), m(CID).amountRaw, "amount 0")
  })

  test("NO wins: single-set [2] redemption lowers NO", () => {
    ctfSplit(COND, 50000000)
    resolve(COND, 0, 1, USER)
    ctfRedeem(COND, [2], 20000000)
    eq(BigInt.zero(), ys(CID), "yes zeroed")
    eq(n(30000000), ns(CID), "no")
  })

  test("50/50 payout: burns allocated proportionally, priced value tracks amount", () => {
    ctfSplit(COND, 100000000)
    resolve(COND, 1, 1, USER)
    ctfRedeem(COND, [1, 2], 30000000) // 60 tokens burned
    eq(n(70000000), ys(CID), "yes")
    eq(n(70000000), ns(CID), "no")
    eq(n(70000000), m(CID).amountRaw, "amount == 0.5*yes + 0.5*no")
  })

  test("over-redemption is clamped at 0", () => {
    ctfSplit(COND, 10000000)
    resolve(COND, 1, 0, USER)
    ctfRedeem(COND, [1, 2], 15000000)
    eq(BigInt.zero(), ys(CID), "clamped")
  })

  test("market first touched after resolution starts resolved", () => {
    resolve(COND, 0, 1, USER)
    assert.notInStore("MarketOpenInterest", CID)
    ctfSplit(COND, 10000000)
    assert.fieldEquals("MarketOpenInterest", CID, "resolved", "true")
    eq(BigInt.zero(), ys(CID), "yes pinned")
    eq(n(10000000), ns(CID), "no")
  })

  test("unregistered condition resolution writes nothing", () => {
    resolve(Bytes.fromHexString("0x" + "11".repeat(32)), 1, 0, USER)
    assert.entityCount("ConditionPayout", 0)
  })
})

function nrResolve(ev: NrEvent, q: i32, yes: boolean): void {
  // adapter.reportOutcome -> CTF ConditionResolution then adapter OutcomeReported
  resolve(ev.conds[q], yes ? 1 : 0, yes ? 0 : 1, NRA)
  report(ev, q, yes)
}

describe("neg-risk resolution (issue 2)", () => {
  beforeEach(() => { clearStore() })

  test("NO-resolved: YES pinned at 0 through later conversions and $0 YES redemptions", () => {
    let ev = setupEvent(60, 3, 0)
    for (let i = 0; i < 3; i++) nrSplit(ev, i, usdc(10))
    nrResolve(ev, 1, false)
    eq(BigInt.zero(), ys(ev.cid(1)), "yes zeroed at resolution")
    convert(ev, BigInt.fromI32(0x1), usdc(50))
    eq(BigInt.zero(), ys(ev.cid(1)), "conversion mint ignored")
    redeemAmounts(ev, 1, usdc(60), BigInt.zero(), BigInt.zero())
    eq(BigInt.zero(), ys(ev.cid(1)), "never negative")
    redeemAmounts(ev, 1, BigInt.zero(), usdc(4), usdc(4))
    eq(usdc(6), ns(ev.cid(1)), "winning NO decreases by exact amount")
    eq(usdc(60), ys(ev.cid(2)), "open question unaffected")
  })

  test("YES-resolved: NO pinned at 0, YES redeemed exactly", () => {
    let ev = setupEvent(61, 2, 0)
    nrSplit(ev, 0, usdc(10))
    nrSplit(ev, 1, usdc(10))
    nrResolve(ev, 0, true)
    convert(ev, BigInt.fromI32(0x1), usdc(3))
    eq(BigInt.zero(), ns(ev.cid(0)), "no pinned")
    redeemAmounts(ev, 0, usdc(10), BigInt.zero(), usdc(10))
    eq(BigInt.zero(), ys(ev.cid(0)), "yes")
    eq(usdc(13), ys(ev.cid(1)), "other question credited")
  })
})

describe("stray USDC.e CTF activity on neg-risk conditions (issues 3, 4)", () => {
  beforeEach(() => { clearStore() })

  test("direct USDC.e split first: market flagged negRisk, supplies untouched, amount still counted", () => {
    let ev = setupEvent(62, 2, 0)
    let g0 = globalRaw()
    ctfSplit(ev.conds[0], 5000000)
    assert.fieldEquals("MarketOpenInterest", ev.cid(0), "negRisk", "true")
    eq(BigInt.zero(), ys(ev.cid(0)), "yes untouched")
    eq(BigInt.zero(), ns(ev.cid(0)), "no untouched")
    eq(n(5000000), raw(ev, 0), "amount counts USDC.e collateral (unchanged rule)")
    eq(g0.plus(n(5000000)), globalRaw(), "global unchanged rule")
    nrSplit(ev, 0, usdc(10))
    eq(usdc(10), ys(ev.cid(0)), "adapter supplies")
  })

  test("zero-payout USDC.e redemption on a neg-risk condition is not counted", () => {
    let ev = setupEvent(63, 2, 0)
    nrSplit(ev, 0, usdc(10))
    nrResolve(ev, 0, false)
    ctfRedeem(ev.conds[0], [1, 2], 0)
    ctfRedeem(ev.conds[0], [1, 2], 0)
    assert.fieldEquals("MarketOpenInterest", ev.cid(0), "redemptionCount", "0")
    redeemAmounts(ev, 0, BigInt.zero(), usdc(10), usdc(10))
    assert.fieldEquals("MarketOpenInterest", ev.cid(0), "redemptionCount", "1")
  })

  test("zero-payout redemption on a regular market still counts", () => {
    prepare(COND)
    ctfSplit(COND, 1000000)
    resolve(COND, 1, 0, USER)
    ctfRedeem(COND, [2], 0)
    assert.fieldEquals("MarketOpenInterest", CID, "redemptionCount", "1")
  })
})
