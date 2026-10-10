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

// Converting `amount` NO tokens of k questions into YES tokens of the others
// releases (k-1)*amount of collateral (minus fee, which goes to the vault, also
// leaving OI). Spread evenly across the k converted conditions. Same math as
// Polymarket's oi-subgraph.
export function handlePositionsConverted(event: PositionsConverted): void {
  let e = NegRiskEvent.load(event.params.marketId.toHexString())
  if (e == null) return

  let indexSet = event.params.indexSet
  let ids: string[] = []
  let n = e.questionCount
  for (let i = 0; i < n; i++) {
    if (indexSet.bitAnd(BigInt.fromI32(1).leftShift(i as u8)).gt(BigInt.zero())) {
      let qid = negRiskQuestionId(event.params.marketId, i as u8)
      ids.push(binaryConditionId(NEG_RISK_ADAPTER, qid).toHexString())
    }
  }
  let noCount = ids.length
  if (noCount <= 1) return

  let multiplier = BigInt.fromI32(noCount - 1)
  let divisor = BigInt.fromI32(noCount)
  // released = fee*(k-1) + (amount-fee)*(k-1) = amount*(k-1); split into the same
  // two parts as Polymarket so per-market rounding matches theirs exactly.
  let amount = event.params.amount
  let fee = amount.times(e.feeBps).div(FEE_DENOMINATOR)
  let net = amount.minus(fee)
  let feeReleased = fee.times(multiplier)
  let userReleased = net.times(multiplier)
  let perMarket = feeReleased.div(divisor).plus(userReleased.div(divisor)).neg()

  for (let i = 0; i < noCount; i++) {
    updateMarket(ids[i], perMarket, KIND_CONVERT, true, event)
  }
  updateGlobal(feeReleased.plus(userReleased).neg(), event)
}
