import { Address, BigInt, ethereum } from "@graphprotocol/graph-ts"
import {
  ConditionPreparation,
  PositionSplit,
  PositionsMerge,
  PayoutRedemption,
  ConditionResolution,
} from "../generated/ConditionalTokens/ConditionalTokens"
import { Condition, ConditionPayout } from "../generated/schema"
import { USDC_E, ZERO_BYTES32, KIND_SPLIT, KIND_MERGE, KIND_REDEEM, MarketWrite, trackedMarket, commitWithGlobal, resolveMarket } from "./oi"

// Polymarket markets are binary conditions. Registering them here lets the
// split/merge/redeem handlers skip arbitrary third-party conditions.
export function handleConditionPreparation(event: ConditionPreparation): void {
  if (!event.params.outcomeSlotCount.equals(BigInt.fromI32(2))) return
  let condition = new Condition(event.params.conditionId.toHexString())
  condition.oracle = event.params.oracle
  condition.questionId = event.params.questionId
  condition.createdAtBlock = event.block.number
  condition.save()
}

// Shared gate for all three CTF events:
//  - the condition must be a registered binary condition;
//  - collateral must be USDC.e (6dp). Neg-risk (WrappedCollateral) is counted via
//    the NegRiskAdapter; WMATIC and other tokens are not Polymarket collateral;
//  - parentCollectionId must be zero. A nested split/merge/redeem moves outcome
//    tokens of another condition, not collateral, so it does not change OI.
// Returns the market loaded once for the whole event, or null to skip.
function counts(conditionId: string, collateral: Address, parentIsZero: boolean, event: ethereum.Event): MarketWrite | null {
  if (!parentIsZero) return null
  if (!collateral.equals(USDC_E)) return null
  return trackedMarket(conditionId, false, event)
}

// Each handler loads the market once, applies OI + supplies + counters in
// memory and saves it once (MarketWrite.commit), then moves global OI.
export function handlePositionSplit(event: PositionSplit): void {
  let w = counts(event.params.conditionId.toHexString(), event.params.collateralToken, event.params.parentCollectionId.equals(ZERO_BYTES32), event)
  if (w == null) return
  let amount = event.params.amount
  w.amount(amount, KIND_SPLIT)
  w.supplies(amount, amount, false)
  commitWithGlobal(w, amount, event)
}

export function handlePositionsMerge(event: PositionsMerge): void {
  let w = counts(event.params.conditionId.toHexString(), event.params.collateralToken, event.params.parentCollectionId.equals(ZERO_BYTES32), event)
  if (w == null) return
  let delta = event.params.amount.neg()
  w.amount(delta, KIND_MERGE)
  w.supplies(delta, delta, false)
  commitWithGlobal(w, delta, event)
}

// PayoutRedemption(indexed redeemer, indexed collateralToken, indexed parentCollectionId,
//                  conditionId, indexSets, payout). conditionId is NOT indexed.
export function handlePayoutRedemption(event: PayoutRedemption): void {
  let w = counts(event.params.conditionId.toHexString(), event.params.collateralToken, event.params.parentCollectionId.equals(ZERO_BYTES32), event)
  if (w == null) return
  let payout = event.params.payout
  if (payout.isZero()) {
    // A USDC.e redeem on a neg-risk condition (its real positions are
    // WrappedCollateral) burns nothing and pays nothing: do not count it.
    let m = w.market
    if (m != null && m.negRisk) return
  }
  w.amount(payout.neg(), KIND_REDEEM)
  // The CTF event has no token amounts: derive burns from the payout numerators.
  w.redeem(event.params.indexSets, payout)
  commitWithGlobal(w, payout.neg(), event)
}

// ConditionResolution(indexed conditionId, indexed oracle, indexed questionId,
//                     outcomeSlotCount, payoutNumerators). Fires for neg-risk
// questions too (the adapter reports payouts to the CTF in reportOutcome).
export function handleConditionResolution(event: ConditionResolution): void {
  let nums = event.params.payoutNumerators
  if (nums.length != 2) return
  let id = event.params.conditionId.toHexString()
  if (Condition.load(id) == null) return
  let r = new ConditionPayout(id)
  r.payoutNumerators = nums
  r.blockNumber = event.block.number
  r.save()
  resolveMarket(id, nums, event)
}
