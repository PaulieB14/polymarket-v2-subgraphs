import { BigInt, Bytes, crypto } from "@graphprotocol/graph-ts"
import {
  MarketPrepared,
  QuestionPrepared,
  PositionSplit,
  PositionsMerge,
  PayoutRedemption,
  PositionsConverted,
} from "../generated/NegRiskAdapter/NegRiskAdapter"
import { Condition, NegRiskEvent } from "../generated/schema"
import {
  NEG_RISK_ADAPTER,
  KIND_SPLIT,
  KIND_MERGE,
  KIND_REDEEM,
  KIND_CONVERT,
  updateOpenInterest,
  updateMarket,
  updateGlobal,
} from "./oi"

const FEE_DENOMINATOR = BigInt.fromI32(10000)

// questionId = marketId with its last byte replaced by the question index
export function negRiskQuestionId(marketId: Bytes, index: u8): Bytes {
  let q = new Bytes(32)
  for (let i = 0; i < 31; i++) q[i] = marketId[i]
  q[31] = index
  return q
}

// CTF conditionId = keccak256(oracle ++ questionId ++ uint256(2))
export function binaryConditionId(oracle: Bytes, questionId: Bytes): Bytes {
  let payload = new Bytes(84)
  for (let i = 0; i < 20; i++) payload[i] = oracle[i]
  for (let i = 0; i < 32; i++) payload[20 + i] = questionId[i]
  payload[83] = 2
  return Bytes.fromByteArray(crypto.keccak256(payload))
}

export function handleMarketPrepared(event: MarketPrepared): void {
  let e = new NegRiskEvent(event.params.marketId.toHexString())
  e.feeBps = event.params.feeBips
  e.questionCount = 0
  e.save()
}

export function handleQuestionPrepared(event: QuestionPrepared): void {
  let e = NegRiskEvent.load(event.params.marketId.toHexString())
  if (e == null) return
  e.questionCount = e.questionCount + 1
  e.save()
}

// Adapter split/merge/redeem amounts are USDC (6dp): the adapter wraps USDC.e into
// WrappedCollateral 1:1 before touching the CTF.
export function handleNegRiskPositionSplit(event: PositionSplit): void {
  let id = event.params.conditionId.toHexString()
  if (Condition.load(id) == null) return
  updateOpenInterest(id, event.params.amount, KIND_SPLIT, true, event)
}

export function handleNegRiskPositionsMerge(event: PositionsMerge): void {
  let id = event.params.conditionId.toHexString()
  if (Condition.load(id) == null) return
  updateOpenInterest(id, event.params.amount.neg(), KIND_MERGE, true, event)
}

export function handleNegRiskPayoutRedemption(event: PayoutRedemption): void {
  let id = event.params.conditionId.toHexString()
  if (Condition.load(id) == null) return
  updateOpenInterest(id, event.params.payout.neg(), KIND_REDEEM, true, event)
}

// convertPositions(marketId, indexSet, amount): the caller's NO tokens on the k
// questions in indexSet are burned, and for every question NOT in indexSet the
// adapter mints WCOL and splits `amount` (YES to the caller, NO burned). So per
// market, the complementary questions gain `amount` of outstanding YES, and the
// converted questions keep their YES supply unchanged. Globally, (k-1)*amount of
// collateral is released (fee included), same as Polymarket's oi-subgraph.
// Previous version spread the release over the k NO-side questions and never
// credited the complementary questions, which shifted OI between sibling
// questions (one sibling hugely positive, the other hugely negative).
export function handlePositionsConverted(event: PositionsConverted): void {
  let e = NegRiskEvent.load(event.params.marketId.toHexString())
  if (e == null) return

  let indexSet = event.params.indexSet
  let amount = event.params.amount
  let n = e.questionCount
  let noCount = 0
  let yesIds: string[] = []
  for (let i = 0; i < n; i++) {
    let qid = negRiskQuestionId(event.params.marketId, i as u8)
    let cid = binaryConditionId(NEG_RISK_ADAPTER, qid).toHexString()
    if (indexSet.bitAnd(BigInt.fromI32(1).leftShift(i as u8)).gt(BigInt.zero())) noCount++
    else yesIds.push(cid)
  }
  if (noCount == 0 || amount.isZero()) return

  for (let i = 0; i < yesIds.length; i++) {
    updateMarket(yesIds[i], amount, KIND_CONVERT, true, event)
  }
  if (noCount > 1) {
    // same rounding as Polymarket: fee and net parts released separately
    let fee = amount.times(e.feeBps).div(FEE_DENOMINATOR)
    let multiplier = BigInt.fromI32(noCount - 1)
    updateGlobal(fee.times(multiplier).plus(amount.minus(fee).times(multiplier)).neg(), event)
  }
}
