import { Address, BigInt } from "@graphprotocol/graph-ts"
import {
  ConditionPreparation,
  PositionSplit,
  PositionsMerge,
  PayoutRedemption,
  ConditionResolution,
} from "../generated/ConditionalTokens/ConditionalTokens"
import { Condition, ConditionPayout, MarketOpenInterest } from "../generated/schema"
import { USDC_E, ZERO_BYTES32, KIND_SPLIT, KIND_MERGE, KIND_REDEEM, isTrackedCondition, updateOpenInterest, updateSupplies, resolveMarket, redeemSupplies } from "./oi"

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
function counts(conditionId: string, collateral: Address, parentIsZero: boolean): boolean {
  if (!parentIsZero) return false
  if (!collateral.equals(USDC_E)) return false
  return isTrackedCondition(conditionId)
}

export function handlePositionSplit(event: PositionSplit): void {
  let id = event.params.conditionId.toHexString()
  if (!counts(id, event.params.collateralToken, event.params.parentCollectionId.equals(ZERO_BYTES32))) return
  updateOpenInterest(id, event.params.amount, KIND_SPLIT, false, event)
  updateSupplies(id, event.params.amount, event.params.amount, false, event)
}

export function handlePositionsMerge(event: PositionsMerge): void {
  let id = event.params.conditionId.toHexString()
  if (!counts(id, event.params.collateralToken, event.params.parentCollectionId.equals(ZERO_BYTES32))) return
  updateOpenInterest(id, event.params.amount.neg(), KIND_MERGE, false, event)
  updateSupplies(id, event.params.amount.neg(), event.params.amount.neg(), false, event)
}

// PayoutRedemption(indexed redeemer, indexed collateralToken, indexed parentCollectionId,
//                  conditionId, indexSets, payout). conditionId is NOT indexed.
export function handlePayoutRedemption(event: PayoutRedemption): void {
  let id = event.params.conditionId.toHexString()
  if (!counts(id, event.params.collateralToken, event.params.parentCollectionId.equals(ZERO_BYTES32))) return
  let payout = event.params.payout
  if (payout.isZero()) {
    // A USDC.e redeem on a neg-risk condition (its real positions are
    // WrappedCollateral) burns nothing and pays nothing: do not count it.
    let m = MarketOpenInterest.load(id)
    if (m != null && m.negRisk) return
  }
  updateOpenInterest(id, payout.neg(), KIND_REDEEM, false, event)
  // The CTF event has no token amounts: derive burns from the payout numerators.
  redeemSupplies(id, event.params.indexSets, payout, event)
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
