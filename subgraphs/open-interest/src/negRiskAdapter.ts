import { BigInt, Bytes, crypto } from "@graphprotocol/graph-ts"
import {
  MarketPrepared,
  QuestionPrepared,
  PositionSplit,
  PositionsMerge,
  PayoutRedemption,
  PositionsConverted,
  OutcomeReported,
} from "../generated/NegRiskAdapter/NegRiskAdapter"
import { Condition, NegRiskEvent, NegRiskQuestion } from "../generated/schema"
import {
  NEG_RISK_ADAPTER,
  KIND_SPLIT,
  KIND_MERGE,
  KIND_REDEEM,
  KIND_CONVERT,
  KIND_RESOLVE,
  updateOpenInterest,
  updateMarket,
  updateGlobal,
  updateSupplies,
  bumpConvertMint,
  bumpConvertBurn,
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
  updateSupplies(id, event.params.amount, event.params.amount, true, event)
}

export function handleNegRiskPositionsMerge(event: PositionsMerge): void {
  let id = event.params.conditionId.toHexString()
  if (Condition.load(id) == null) return
  updateOpenInterest(id, event.params.amount.neg(), KIND_MERGE, true, event)
  updateSupplies(id, event.params.amount.neg(), event.params.amount.neg(), true, event)
}

export function handleNegRiskPayoutRedemption(event: PayoutRedemption): void {
  let id = event.params.conditionId.toHexString()
  if (Condition.load(id) == null) return
  updateOpenInterest(id, event.params.payout.neg(), KIND_REDEEM, true, event)
  // amounts[0] = YES tokens burned, amounts[1] = NO tokens burned
  let amounts = event.params.amounts
  let yesBurn = amounts.length > 0 ? amounts[0] : BigInt.zero()
  let noBurn = amounts.length > 1 ? amounts[1] : BigInt.zero()
  updateSupplies(id, yesBurn.neg(), noBurn.neg(), true, event)
}

// convertPositions(marketId, indexSet, amount) on an n-question event:
//  - the caller's `amount` NO on each of the k questions in indexSet is burned
//    (sent to the adapter's burn address, never redeemed);
//  - `amount` YES is minted on each of the n-k other questions (fee included: the
//    fee share of the YES goes to the vault and is still redeemable);
//  - (k-1)*amount of collateral leaves the system (global OI, unchanged rule).
// Per question we therefore:
//  - debit `amount` on each converted question (its burned NO will never be paid),
//    unless that question was already reported YES (its NO was already worthless);
//  - credit `amount` on each other question, unless it was already reported NO
//    (YES minted on a lost question is worthless from the start).
// What was debited/credited is tracked on NegRiskQuestion and settled in
// handleOutcomeReported, so every question returns to ~0 once all winning
// positions are redeemed, and sum(per-question) == global for the event.
// Circulating supplies are updated separately: +amount YES on the complement,
// -amount NO on the converted questions. OutcomeReported does not change
// supplies (tokens still exist until redeemed). Polymarket's data-api OI is
// yesSupply * p + noSupply * (1-p), not `amount`.
export function handlePositionsConverted(event: PositionsConverted): void {
  let e = NegRiskEvent.load(event.params.marketId.toHexString())
  if (e == null) return

  let indexSet = event.params.indexSet
  let amount = event.params.amount
  let n = e.questionCount
  let noIds: string[] = []
  let noQids: Bytes[] = []
  let yesIds: string[] = []
  let yesQids: Bytes[] = []
  for (let i = 0; i < n; i++) {
    let qid = negRiskQuestionId(event.params.marketId, i as u8)
    let cid = binaryConditionId(NEG_RISK_ADAPTER, qid).toHexString()
    if (indexSet.bitAnd(BigInt.fromI32(1).leftShift(i as u8)).gt(BigInt.zero())) {
      noIds.push(cid)
      noQids.push(qid)
    } else {
      yesIds.push(cid)
      yesQids.push(qid)
    }
  }
  let noCount = noIds.length
  if (noCount == 0 || amount.isZero()) return

  for (let i = 0; i < yesIds.length; i++) {
    let q = getOrCreateQuestion(yesIds[i], event.params.marketId, yesQids[i])
    if (q.outcome == OUTCOME_NO) continue
    q.mintedRaw = q.mintedRaw.plus(amount)
    q.save()
    updateMarket(yesIds[i], amount, KIND_CONVERT, true, event)
    updateSupplies(yesIds[i], amount, BigInt.zero(), true, event)
    bumpConvertMint(yesIds[i], true, event)
  }
  for (let i = 0; i < noIds.length; i++) {
    let q = getOrCreateQuestion(noIds[i], event.params.marketId, noQids[i])
    if (q.outcome == OUTCOME_YES) continue
    q.burnedRaw = q.burnedRaw.plus(amount)
    q.save()
    updateMarket(noIds[i], amount.neg(), KIND_CONVERT, true, event)
    updateSupplies(noIds[i], BigInt.zero(), amount.neg(), true, event)
    bumpConvertBurn(noIds[i], true, event)
  }
  if (noCount > 1) {
    // same rounding as Polymarket: fee and net parts released separately
    let fee = amount.times(e.feeBps).div(FEE_DENOMINATOR)
    let multiplier = BigInt.fromI32(noCount - 1)
    updateGlobal(fee.times(multiplier).plus(amount.minus(fee).times(multiplier)).neg(), event)
  }
}

// OutcomeReported(marketId, questionId, outcome): settle conversion bookkeeping.
// Reported NO: YES minted on this question by conversions is worthless -> remove it.
// Reported YES: NO burned on this question by conversions was worthless -> give the
// debit back. Global OI is not touched (no collateral moves here).
export function handleOutcomeReported(event: OutcomeReported): void {
  if (NegRiskEvent.load(event.params.marketId.toHexString()) == null) return
  let qid = event.params.questionId
  let cid = binaryConditionId(NEG_RISK_ADAPTER, qid).toHexString()
  let q = getOrCreateQuestion(cid, event.params.marketId, qid)
  if (q.outcome != OUTCOME_UNRESOLVED) return
  q.outcome = event.params.outcome ? OUTCOME_YES : OUTCOME_NO
  q.reportedAtBlock = event.block.number
  let delta = BigInt.zero()
  if (q.outcome == OUTCOME_NO) {
    delta = q.mintedRaw.neg()
    q.mintedRaw = BigInt.zero()
  } else {
    delta = q.burnedRaw
    q.burnedRaw = BigInt.zero()
  }
  q.save()
  if (!delta.isZero()) updateMarket(cid, delta, KIND_RESOLVE, true, event)
}

const OUTCOME_UNRESOLVED = 0
const OUTCOME_YES = 1
const OUTCOME_NO = 2

function getOrCreateQuestion(cid: string, marketId: Bytes, questionId: Bytes): NegRiskQuestion {
  let q = NegRiskQuestion.load(cid)
  if (q == null) {
    q = new NegRiskQuestion(cid)
    q.marketId = marketId
    q.questionId = questionId
    q.outcome = OUTCOME_UNRESOLVED
    q.mintedRaw = BigInt.zero()
    q.burnedRaw = BigInt.zero()
  }
  return q as NegRiskQuestion
}
