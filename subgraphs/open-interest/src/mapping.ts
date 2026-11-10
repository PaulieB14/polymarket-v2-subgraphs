import { Address, BigInt } from "@graphprotocol/graph-ts"
import {
  ConditionPreparation,
  PositionSplit,
  PositionsMerge,
  PayoutRedemption,
} from "../generated/ConditionalTokens/ConditionalTokens"
import { Condition } from "../generated/schema"
import { USDC_E, ZERO_BYTES32, KIND_SPLIT, KIND_MERGE, KIND_REDEEM, isTrackedCondition, updateOpenInterest, updateSupplies } from "./oi"

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
  updateOpenInterest(id, event.params.payout.neg(), KIND_REDEEM, false, event)
  // The CTF event does not include token amounts. When payout > 0 and a single
  // index set is redeemed, payout equals tokens burned if that outcome paid $1.
  // Zero-payout (losing) redemptions cannot be reflected in supplies.
  let payout = event.params.payout
  if (!payout.isZero() && event.params.indexSets.length == 1) {
    let set = event.params.indexSets[0]
    if (set.equals(BigInt.fromI32(1))) updateSupplies(id, payout.neg(), BigInt.zero(), false, event)
    else if (set.equals(BigInt.fromI32(2))) updateSupplies(id, BigInt.zero(), payout.neg(), false, event)
  }
}
