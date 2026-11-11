import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts"
import {
  ConditionPreparation,
  PositionSplit,
  PositionsMerge,
  PayoutRedemption,
  ConditionResolution,
} from "../generated/ConditionalTokens/ConditionalTokens"
import { Condition, ConditionPayout } from "../generated/schema"
import {
  USDC_E,
  WCOL,
  NEG_RISK_ADAPTER,
  BINARY_MODULE_V2,
  NEG_RISK_MODULE_V2,
  ZERO_BYTES32,
  KIND_SPLIT,
  KIND_MERGE,
  KIND_REDEEM,
  MarketWrite,
  trackedMarket,
  commitWithGlobal,
  resolveMarket,
} from "./oi"
import { migrationSettlement } from "./v2"

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
//  - parentCollectionId must be zero. A nested split/merge/redeem moves outcome
//    tokens of another condition, not collateral, so it does not change OI;
//  - USDC.e (6dp) always counts (on a neg-risk condition only in `amount`: those
//    USDC.e positions are not the traded tokens, see MarketWrite.supplies);
//  - WrappedCollateral counts only when the CTF caller is not the NegRiskAdapter and
//    the condition is neg-risk: the adapter's own CTF calls are mirrored by its events
//    (handled in negRiskAdapter.ts), anyone else's are not (direct split / merge /
//    redeem of the traded neg-risk tokens). WMATIC and other tokens are ignored.
// Returns the market loaded once for the whole event, or null to skip.
function counts(conditionId: Bytes, collateral: Address, parentIsZero: boolean, caller: Address, event: ethereum.Event): MarketWrite | null {
  if (!parentIsZero) return null
  if (collateral.equals(USDC_E)) return trackedMarket(conditionId.toHexString(), false, event)
  if (!collateral.equals(WCOL) || caller.equals(NEG_RISK_ADAPTER)) return null
  let w = trackedMarket(conditionId.toHexString(), true, event)
  if (w == null || !w.isNegRisk()) return null
  w.wcol = true
  return w
}

// A V2 module merging / redeeming legacy positions it received through migratePositions
// (BinaryModule with USDC.e, NegRiskModule with WCOL). The collateral moves from the legacy
// market to its V2 market; global OI is unchanged. Supplies are untouched: the migrated
// tokens already left the legacy supplies at PositionMigrated (see v2.ts).
function isMigrationCaller(caller: Address, w: MarketWrite): boolean {
  return w.wcol ? caller.equals(NEG_RISK_MODULE_V2) : caller.equals(BINARY_MODULE_V2)
}

// Each handler loads the market once, applies OI + supplies + counters in
// memory and saves it once (MarketWrite.commit), then moves global OI.
export function handlePositionSplit(event: PositionSplit): void {
  let w = counts(event.params.conditionId, event.params.collateralToken, event.params.parentCollectionId.equals(ZERO_BYTES32), event.params.stakeholder, event)
  if (w == null) return
  let amount = event.params.amount
  w.amount(amount, KIND_SPLIT)
  w.supplies(amount, amount, w.wcol)
  commitWithGlobal(w, amount, event)
}

export function handlePositionsMerge(event: PositionsMerge): void {
  let w = counts(event.params.conditionId, event.params.collateralToken, event.params.parentCollectionId.equals(ZERO_BYTES32), event.params.stakeholder, event)
  if (w == null) return
  let delta = event.params.amount.neg()
  w.amount(delta, KIND_MERGE)
  if (isMigrationCaller(event.params.stakeholder, w) && migrationSettlement(w, event.params.amount, event)) return
  w.supplies(delta, delta, w.wcol)
  commitWithGlobal(w, delta, event)
}

// PayoutRedemption(indexed redeemer, indexed collateralToken, indexed parentCollectionId,
//                  conditionId, indexSets, payout). conditionId is NOT indexed.
export function handlePayoutRedemption(event: PayoutRedemption): void {
  let w = counts(event.params.conditionId, event.params.collateralToken, event.params.parentCollectionId.equals(ZERO_BYTES32), event.params.redeemer, event)
  if (w == null) return
  let payout = event.params.payout
  if (payout.isZero()) {
    // A USDC.e redeem on a neg-risk condition (its real positions are
    // WrappedCollateral) burns nothing and pays nothing: do not count it.
    let m = w.market
    if (m != null && m.negRisk && !w.wcol) return
  }
  w.amount(payout.neg(), KIND_REDEEM)
  if (isMigrationCaller(event.params.redeemer, w) && migrationSettlement(w, payout, event)) return
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
