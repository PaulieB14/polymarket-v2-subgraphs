import { BigInt } from "@graphprotocol/graph-ts"
import {
  ConditionPreparation,
  PositionSplit,
  PositionsMerge,
  PayoutRedemption,
} from "../generated/ConditionalTokens/ConditionalTokens"
import { Condition } from "../generated/schema"
import { USDC_E, ZERO_BYTES32, KIND_SPLIT, KIND_MERGE, KIND_REDEEM, updateOpenInterest } from "./oi"

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
function counts(conditionId: string, collateral: string, parentIsZero: boolean): boolean {
  if (!parentIsZero) return false
  if (collateral != USDC_E.toHexString()) return false
  return Condition.load(conditionId) != null
}

export function handlePositionSplit(event: PositionSplit): void {
  let id = event.params.conditionId.toHexString()
  if (!counts(id, event.params.collateralToken.toHexString(), event.params.parentCollectionId.equals(ZERO_BYTES32))) return
  updateOpenInterest(id, event.params.amount, KIND_SPLIT, false, event)
}

export function handlePositionsMerge(event: PositionsMerge): void {
  let id = event.params.conditionId.toHexString()
  if (!counts(id, event.params.collateralToken.toHexString(), event.params.parentCollectionId.equals(ZERO_BYTES32))) return
  updateOpenInterest(id, event.params.amount.neg(), KIND_MERGE, false, event)
}

// PayoutRedemption(indexed redeemer, indexed collateralToken, indexed parentCollectionId,
//                  conditionId, indexSets, payout). conditionId is NOT indexed.
export function handlePayoutRedemption(event: PayoutRedemption): void {
  let id = event.params.conditionId.toHexString()
  if (!counts(id, event.params.collateralToken.toHexString(), event.params.parentCollectionId.equals(ZERO_BYTES32))) return
  updateOpenInterest(id, event.params.payout.neg(), KIND_REDEEM, false, event)
}
