import { assert, beforeEach, clearStore, describe, newMockEvent, test } from "matchstick-as/assembly/index"
import { Address, BigInt, Bytes, ethereum, log } from "@graphprotocol/graph-ts"
import { ConditionPreparation, PayoutRedemption as CtfRedemption } from "../generated/ConditionalTokens/ConditionalTokens"
import {
  MarketPrepared,
  QuestionPrepared,
  PositionsConverted,
  PositionSplit as NrSplit,
  PayoutRedemption as NrRedemption,
} from "../generated/NegRiskAdapter/NegRiskAdapter"
import { MarketOpenInterest, GlobalOpenInterest } from "../generated/schema"
import { handleConditionPreparation, handlePayoutRedemption } from "../src/mapping"
import {
  handleMarketPrepared,
  handleQuestionPrepared,
  handlePositionsConverted,
  handleNegRiskPositionSplit,
  handleNegRiskPayoutRedemption,
  negRiskQuestionId,
  binaryConditionId,
} from "../src/negRiskAdapter"

const NRA = Address.fromString("0xd91e80cf2e7be2e162c6513ced06f1dd0da35296")
const USDC_E = Address.fromString("0x2791bca1f2de4661ed88a30c99a7a9449aa84174")
const USER = Address.fromString("0xada100db00ca00073811820692005400218fce1f")
const ZERO32 = Bytes.fromHexString("0x0000000000000000000000000000000000000000000000000000000000000000")
const MARKET = Bytes.fromHexString("0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd00")
const USDC: i64 = 1000000

function p(name: string, v: ethereum.Value): ethereum.EventParam {
  return new ethereum.EventParam(name, v)
}
function u(n: i64): ethereum.Value {
  return ethereum.Value.fromUnsignedBigInt(BigInt.fromI64(n))
}

let conds: Bytes[] = []

function setupEvent(questions: i32, feeBips: i32): void {
  conds = []
  let mp = changetype<MarketPrepared>(newMockEvent())
  mp.parameters = [
    p("marketId", ethereum.Value.fromFixedBytes(MARKET)),
    p("oracle", ethereum.Value.fromAddress(USER)),
    p("feeBips", u(feeBips)),
    p("data", ethereum.Value.fromBytes(Bytes.empty())),
  ]
  handleMarketPrepared(mp)
  for (let i = 0; i < questions; i++) {
    let qid = negRiskQuestionId(MARKET, i as u8)
    let qp = changetype<QuestionPrepared>(newMockEvent())
    qp.parameters = [
      p("marketId", ethereum.Value.fromFixedBytes(MARKET)),
      p("questionId", ethereum.Value.fromFixedBytes(qid)),
      p("index", u(i)),
      p("data", ethereum.Value.fromBytes(Bytes.empty())),
    ]
    handleQuestionPrepared(qp)
    let cid = binaryConditionId(NRA, qid)
    conds.push(cid)
    let cp = changetype<ConditionPreparation>(newMockEvent())
    cp.parameters = [
      p("conditionId", ethereum.Value.fromFixedBytes(cid)),
      p("oracle", ethereum.Value.fromAddress(NRA)),
      p("questionId", ethereum.Value.fromFixedBytes(qid)),
      p("outcomeSlotCount", u(2)),
    ]
    handleConditionPreparation(cp)
  }
}

function nrSplit(q: i32, amount: i64): void {
  let s = changetype<NrSplit>(newMockEvent())
  s.parameters = [
    p("stakeholder", ethereum.Value.fromAddress(USER)),
    p("conditionId", ethereum.Value.fromFixedBytes(conds[q])),
    p("amount", u(amount)),
  ]
  handleNegRiskPositionSplit(s)
}

function convert(indexSet: i32, amount: i64): void {
  let cv = changetype<PositionsConverted>(newMockEvent())
  cv.parameters = [
    p("stakeholder", ethereum.Value.fromAddress(USER)),
    p("marketId", ethereum.Value.fromFixedBytes(MARKET)),
    p("indexSet", u(indexSet)),
    p("amount", u(amount)),
  ]
  handlePositionsConverted(cv)
}

function nrRedeem(cond: Bytes, payout: i64): void {
  let r = changetype<NrRedemption>(newMockEvent())
  r.parameters = [
    p("redeemer", ethereum.Value.fromAddress(USER)),
    p("conditionId", ethereum.Value.fromFixedBytes(cond)),
    p("amounts", ethereum.Value.fromUnsignedBigIntArray([BigInt.fromI64(payout), BigInt.zero()])),
    p("payout", u(payout)),
  ]
  handleNegRiskPayoutRedemption(r)
}

function raw(i: i32): BigInt {
  let m = MarketOpenInterest.load(conds[i].toHexString())
  return m == null ? BigInt.zero() : m.amountRaw
}
function globalRaw(): BigInt {
  return GlobalOpenInterest.load("global")!.amountRaw
}
function assertNoNegative(n: i32, step: string): void {
  for (let i = 0; i < n; i++) {
    assert.assertTrue(!raw(i).lt(BigInt.zero()), step + ": question " + i.toString() + " OI negative: " + raw(i).toString())
  }
}

describe("negRisk replay: splits -> single-NO convert -> multi-NO convert -> redemptions", () => {
  beforeEach(() => {
    clearStore()
  })

  test("sibling questions get the converted amount, global drops by the released amount, nothing goes negative", () => {
    // 3-question event (q0, q1, q2), 0 fee. Each question split 100 USDC.
    setupEvent(3, 0)
    nrSplit(0, 100 * USDC)
    nrSplit(1, 100 * USDC)
    nrSplit(2, 100 * USDC)
    assert.bigIntEquals(BigInt.fromI64(300 * USDC), globalRaw())

    // single NO (q0) for 40: burns 40 NO on q0, mints 40 YES on q1 and q2, releases nothing
    convert(0x1, 40 * USDC)
    assertNoNegative(3, "after single-NO convert")
    assert.bigIntEquals(BigInt.fromI64(60 * USDC), raw(0))
    assert.bigIntEquals(BigInt.fromI64(140 * USDC), raw(1))
    assert.bigIntEquals(BigInt.fromI64(140 * USDC), raw(2))
    assert.bigIntEquals(BigInt.fromI64(300 * USDC), globalRaw())

    // multi NO (q0+q1) for 30: burns 30 NO on each, mints 30 YES on q2, releases (2-1)*30 globally
    convert(0x3, 30 * USDC)
    assertNoNegative(3, "after multi-NO convert")
    assert.bigIntEquals(BigInt.fromI64(30 * USDC), raw(0))
    assert.bigIntEquals(BigInt.fromI64(110 * USDC), raw(1))
    assert.bigIntEquals(BigInt.fromI64(170 * USDC), raw(2))
    assert.bigIntEquals(BigInt.fromI64(270 * USDC), globalRaw())

    // q2 resolves YES: all 170 YES on q2 redeem; NO on q0 (100-40-30=30) and
    // NO on q1 (100-30=70) redeem for 1 each.
    nrRedeem(conds[2], 170 * USDC)
    nrRedeem(conds[0], 30 * USDC)
    nrRedeem(conds[1], 70 * USDC)
    assertNoNegative(3, "after redemptions")
    assert.bigIntEquals(BigInt.zero(), raw(2))
    assert.bigIntEquals(BigInt.zero(), raw(0))
    // q1 still carries the 40 YES minted on it, worthless once q1 is reported NO
    // (settled by OutcomeReported, see negrisk-rules.test.ts)
    assert.bigIntEquals(BigInt.fromI64(40 * USDC), raw(1))
    assert.bigIntEquals(BigInt.zero(), globalRaw())
  })

  test("invariant only: same replay never drives a sibling question negative", () => {
    setupEvent(3, 0)
    nrSplit(0, 100 * USDC)
    nrSplit(1, 100 * USDC)
    nrSplit(2, 100 * USDC)
    convert(0x1, 40 * USDC)
    convert(0x3, 30 * USDC)
    nrRedeem(conds[2], 170 * USDC)
    nrRedeem(conds[0], 30 * USDC)
    nrRedeem(conds[1], 70 * USDC)
    log.info("replay end: q0={} q1={} q2={} global={}", [raw(0).toString(), raw(1).toString(), raw(2).toString(), globalRaw().toString()])
    assertNoNegative(3, "end of replay")
  })

  test("fee-bearing multi-NO convert releases (k-1)*amount globally", () => {
    setupEvent(4, 200) // 2% fee
    for (let i = 0; i < 4; i++) nrSplit(i, 50 * USDC)
    convert(0x7, 10 * USDC) // k=3 -> releases 20
    assert.bigIntEquals(BigInt.fromI64(180 * USDC), globalRaw())
    assert.bigIntEquals(BigInt.fromI64(60 * USDC), raw(3))
    assertNoNegative(4, "fee convert")
  })
})

describe("zero-payout redemption", () => {
  beforeEach(() => {
    clearStore()
  })

  test("a $0 payout on an unseen market creates no market and does not bump marketCount", () => {
    setupEvent(2, 0)
    nrSplit(0, 10 * USDC)
    assert.fieldEquals("GlobalOpenInterest", "global", "marketCount", "1")
    // losing-side redemption on q1 (never split): payout 0
    nrRedeem(conds[1], 0)
    assert.notInStore("MarketOpenInterest", conds[1].toHexString())
    // same through the CTF path
    let r = changetype<CtfRedemption>(newMockEvent())
    r.parameters = [
      p("redeemer", ethereum.Value.fromAddress(USER)),
      p("collateralToken", ethereum.Value.fromAddress(USDC_E)),
      p("parentCollectionId", ethereum.Value.fromFixedBytes(ZERO32)),
      p("conditionId", ethereum.Value.fromFixedBytes(conds[1])),
      p("indexSets", ethereum.Value.fromUnsignedBigIntArray([BigInt.fromI32(1), BigInt.fromI32(2)])),
      p("payout", u(0)),
    ]
    handlePayoutRedemption(r)
    assert.notInStore("MarketOpenInterest", conds[1].toHexString())
    assert.entityCount("MarketOpenInterest", 1)
    assert.fieldEquals("GlobalOpenInterest", "global", "marketCount", "1")
    assert.fieldEquals("GlobalOpenInterest", "global", "amountRaw", "10000000")
  })
})
