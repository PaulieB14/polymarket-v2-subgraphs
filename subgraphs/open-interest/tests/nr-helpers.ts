// Shared helpers for neg-risk tests: build a neg-risk event, feed adapter events
// through the real handlers, and read per-question / global OI.
import { assert, newMockEvent } from "matchstick-as/assembly/index"
import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts"
import { ConditionPreparation } from "../generated/ConditionalTokens/ConditionalTokens"
import {
  MarketPrepared,
  QuestionPrepared,
  PositionsConverted,
  PositionSplit as NrSplit,
  PositionsMerge as NrMerge,
  PayoutRedemption as NrRedemption,
  OutcomeReported,
} from "../generated/NegRiskAdapter/NegRiskAdapter"
import { MarketOpenInterest, GlobalOpenInterest } from "../generated/schema"
import { handleConditionPreparation } from "../src/mapping"
import {
  handleMarketPrepared,
  handleQuestionPrepared,
  handlePositionsConverted,
  handleNegRiskPositionSplit,
  handleNegRiskPositionsMerge,
  handleNegRiskPayoutRedemption,
  handleOutcomeReported,
  negRiskQuestionId,
  binaryConditionId,
} from "../src/negRiskAdapter"

export const NRA = Address.fromString("0xd91e80cf2e7be2e162c6513ced06f1dd0da35296")
export const USER = Address.fromString("0xada100db00ca00073811820692005400218fce1f")
export const USDC: i64 = 1000000

let blockNo: i64 = 1000
let logIdx: i64 = 0

function p(name: string, v: ethereum.Value): ethereum.EventParam {
  return new ethereum.EventParam(name, v)
}
function bi(n: BigInt): ethereum.Value {
  return ethereum.Value.fromUnsignedBigInt(n)
}
function mock(): ethereum.Event {
  let e = newMockEvent()
  logIdx++
  e.block.number = BigInt.fromI64(blockNo)
  e.block.timestamp = BigInt.fromI64(1700000000 + blockNo * 2)
  e.logIndex = BigInt.fromI64(logIdx)
  return e
}
export function nextBlock(): void {
  blockNo++
}

export class NrEvent {
  marketId: Bytes
  conds: Bytes[]
  qids: Bytes[]
  constructor(marketId: Bytes) {
    this.marketId = marketId
    this.conds = []
    this.qids = []
  }
  cid(i: i32): string {
    return this.conds[i].toHexString()
  }
}

export function marketIdFor(seed: i32): Bytes {
  let b = new Bytes(32)
  for (let i = 0; i < 31; i++) b[i] = ((seed * 31 + i * 7 + 1) & 0xff) as u8
  b[31] = 0
  return b
}

export function prepareEvent(marketId: Bytes, feeBips: i32): NrEvent {
  let mp = changetype<MarketPrepared>(mock())
  mp.parameters = [
    p("marketId", ethereum.Value.fromFixedBytes(marketId)),
    p("oracle", ethereum.Value.fromAddress(USER)),
    p("feeBips", bi(BigInt.fromI32(feeBips))),
    p("data", ethereum.Value.fromBytes(Bytes.empty())),
  ]
  handleMarketPrepared(mp)
  return new NrEvent(marketId)
}

export function addQuestion(ev: NrEvent): i32 {
  let i = ev.conds.length
  let qid = negRiskQuestionId(ev.marketId, i as u8)
  let qp = changetype<QuestionPrepared>(mock())
  qp.parameters = [
    p("marketId", ethereum.Value.fromFixedBytes(ev.marketId)),
    p("questionId", ethereum.Value.fromFixedBytes(qid)),
    p("index", bi(BigInt.fromI32(i))),
    p("data", ethereum.Value.fromBytes(Bytes.empty())),
  ]
  handleQuestionPrepared(qp)
  let cid = binaryConditionId(NRA, qid)
  let cp = changetype<ConditionPreparation>(mock())
  cp.parameters = [
    p("conditionId", ethereum.Value.fromFixedBytes(cid)),
    p("oracle", ethereum.Value.fromAddress(NRA)),
    p("questionId", ethereum.Value.fromFixedBytes(qid)),
    p("outcomeSlotCount", bi(BigInt.fromI32(2))),
  ]
  handleConditionPreparation(cp)
  ev.conds.push(cid)
  ev.qids.push(qid)
  return i
}

export function setupEvent(seed: i32, questions: i32, feeBips: i32): NrEvent {
  let ev = prepareEvent(marketIdFor(seed), feeBips)
  for (let i = 0; i < questions; i++) addQuestion(ev)
  return ev
}

export function split(ev: NrEvent, q: i32, amount: BigInt): void {
  let s = changetype<NrSplit>(mock())
  s.parameters = [
    p("stakeholder", ethereum.Value.fromAddress(USER)),
    p("conditionId", ethereum.Value.fromFixedBytes(ev.conds[q])),
    p("amount", bi(amount)),
  ]
  handleNegRiskPositionSplit(s)
}
export function merge(ev: NrEvent, q: i32, amount: BigInt): void {
  let s = changetype<NrMerge>(mock())
  s.parameters = [
    p("stakeholder", ethereum.Value.fromAddress(USER)),
    p("conditionId", ethereum.Value.fromFixedBytes(ev.conds[q])),
    p("amount", bi(amount)),
  ]
  handleNegRiskPositionsMerge(s)
}
export function convert(ev: NrEvent, indexSet: BigInt, amount: BigInt): void {
  let cv = changetype<PositionsConverted>(mock())
  cv.parameters = [
    p("stakeholder", ethereum.Value.fromAddress(USER)),
    p("marketId", ethereum.Value.fromFixedBytes(ev.marketId)),
    p("indexSet", bi(indexSet)),
    p("amount", bi(amount)),
  ]
  handlePositionsConverted(cv)
}
export function redeem(ev: NrEvent, q: i32, payout: BigInt): void {
  let r = changetype<NrRedemption>(mock())
  r.parameters = [
    p("redeemer", ethereum.Value.fromAddress(USER)),
    p("conditionId", ethereum.Value.fromFixedBytes(ev.conds[q])),
    p("amounts", ethereum.Value.fromUnsignedBigIntArray([payout, BigInt.zero()])),
    p("payout", bi(payout)),
  ]
  handleNegRiskPayoutRedemption(r)
}
export function report(ev: NrEvent, q: i32, yes: boolean): void {
  let r = changetype<OutcomeReported>(mock())
  r.parameters = [
    p("marketId", ethereum.Value.fromFixedBytes(ev.marketId)),
    p("questionId", ethereum.Value.fromFixedBytes(ev.qids[q])),
    p("outcome", ethereum.Value.fromBoolean(yes)),
  ]
  handleOutcomeReported(r)
}

export function usdc(n: i64): BigInt {
  return BigInt.fromI64(n * USDC)
}
export function raw(ev: NrEvent, q: i32): BigInt {
  let m = MarketOpenInterest.load(ev.cid(q))
  return m == null ? BigInt.zero() : m.amountRaw
}
export function globalRaw(): BigInt {
  let g = GlobalOpenInterest.load("global")
  return g == null ? BigInt.zero() : g.amountRaw
}
export function marketCount(): i32 {
  let g = GlobalOpenInterest.load("global")
  return g == null ? 0 : g.marketCount
}
export function sumRaw(ev: NrEvent): BigInt {
  let s = BigInt.zero()
  for (let i = 0; i < ev.conds.length; i++) s = s.plus(raw(ev, i))
  return s
}
export function eq(expected: BigInt, actual: BigInt, what: string): void {
  assert.assertTrue(expected.equals(actual), what + ": expected " + expected.toString() + " got " + actual.toString())
}
export function noNegative(ev: NrEvent, what: string): void {
  for (let i = 0; i < ev.conds.length; i++) {
    let v = raw(ev, i)
    assert.assertTrue(!v.lt(BigInt.zero()), what + ": q" + i.toString() + " negative " + v.toString())
  }
}
// Redemption with explicit [yes, no] token amounts burned (NegRiskAdapter event semantics).
export function redeemAmounts(ev: NrEvent, q: i32, yes: BigInt, no: BigInt, payout: BigInt): void {
  let r = changetype<NrRedemption>(mock())
  r.parameters = [
    p("redeemer", ethereum.Value.fromAddress(USER)),
    p("conditionId", ethereum.Value.fromFixedBytes(ev.conds[q])),
    p("amounts", ethereum.Value.fromUnsignedBigIntArray([yes, no])),
    p("payout", bi(payout)),
  ]
  handleNegRiskPayoutRedemption(r)
}
