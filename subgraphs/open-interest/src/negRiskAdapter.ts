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
import { MarketOpenInterest, NegRiskEvent, NegRiskQuestion } from "../generated/schema"
import {
  NEG_RISK_ADAPTER,
  KIND_SPLIT,
  KIND_MERGE,
  KIND_REDEEM,
  KIND_CONVERT,
  KIND_RESOLVE,
  MarketWrite,
  trackedMarket,
  commitWithGlobal,
  applyGlobal,
  updateMarket,
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
  let w = trackedMarket(event.params.conditionId.toHexString(), true, event)
  if (w == null) return
  let amount = event.params.amount
  w.amount(amount, KIND_SPLIT)
  w.supplies(amount, amount, true)
  commitWithGlobal(w, amount, event)
}

export function handleNegRiskPositionsMerge(event: PositionsMerge): void {
  let w = trackedMarket(event.params.conditionId.toHexString(), true, event)
  if (w == null) return
  let delta = event.params.amount.neg()
  w.amount(delta, KIND_MERGE)
  w.supplies(delta, delta, true)
  commitWithGlobal(w, delta, event)
}

export function handleNegRiskPayoutRedemption(event: PayoutRedemption): void {
  let w = trackedMarket(event.params.conditionId.toHexString(), true, event)
  if (w == null) return
  // amounts[0] = YES tokens burned, amounts[1] = NO tokens burned
  let amounts = event.params.amounts
  let yesBurn = amounts.length > 0 ? amounts[0] : BigInt.zero()
  let noBurn = amounts.length > 1 ? amounts[1] : BigInt.zero()
  // redeemPositions pays out the adapter's whole WCOL balance, so WCOL left in the adapter
  // is swept to the redeemer on top of the burned tokens' value (e.g. tx 0x24bbad6a…4cdc,
  // amounts [0,0], payout $816.84). Only the burned tokens' value leaves this market's OI.
  let paid = event.params.payout
  let m = w.market
  if (m != null && m.resolved) {
    let nums = m.payoutNumerators as BigInt[]
    let den = nums[0].plus(nums[1])
    if (!den.isZero()) {
      let value = yesBurn.times(nums[0]).plus(noBurn.times(nums[1])).div(den)
      if (paid.gt(value)) paid = value
    }
  }
  let delta = paid.neg()
  w.amount(delta, KIND_REDEEM)
  w.supplies(yesBurn.neg(), noBurn.neg(), true)
  commitWithGlobal(w, delta, event)
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

  // Each question appears once per event (yes/no sides are disjoint), so each
  // market is loaded once, updated in memory and saved once.
  let created = 0
  for (let i = 0; i < yesIds.length; i++) {
    let w = new MarketWrite(yesIds[i], MarketOpenInterest.load(yesIds[i]), true, event)
    // YES is minted on chain even after the question was reported NO (worthless,
    // but later redeemed for $0 and subtracted), so supplies always move.
    w.supplies(amount, BigInt.zero(), true)
    w.convertMint()
    let q = getOrCreateQuestion(yesIds[i], event.params.marketId, yesQids[i])
    if (q.outcome != OUTCOME_NO) {
      q.mintedRaw = q.mintedRaw.plus(amount)
      q.save()
      w.amount(amount, KIND_CONVERT)
    }
    created += w.commit()
  }
  for (let i = 0; i < noIds.length; i++) {
    let w = new MarketWrite(noIds[i], MarketOpenInterest.load(noIds[i]), true, event)
    // NO is burned on chain even after the question was reported YES.
    w.supplies(BigInt.zero(), amount.neg(), true)
    w.convertBurn()
    let q = getOrCreateQuestion(noIds[i], event.params.marketId, noQids[i])
    if (q.outcome != OUTCOME_YES) {
      q.burnedRaw = q.burnedRaw.plus(amount)
      q.save()
      w.amount(amount.neg(), KIND_CONVERT)
    }
    created += w.commit()
  }
  if (noCount > 1) {
    // same rounding as Polymarket: fee and net parts released separately
    let fee = amount.times(e.feeBps).div(FEE_DENOMINATOR)
    let multiplier = BigInt.fromI32(noCount - 1)
    applyGlobal(fee.times(multiplier).plus(amount.minus(fee).times(multiplier)).neg(), created, true, event)
  } else {
    applyGlobal(BigInt.zero(), created, false, event)
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
