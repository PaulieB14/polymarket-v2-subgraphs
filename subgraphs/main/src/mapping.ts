import { BigInt } from "@graphprotocol/graph-ts"
import {
  ConditionPreparation,
  ConditionResolution,
} from "../generated/ConditionalTokens/ConditionalTokens"
import { Condition, Global } from "../generated/schema"

const GLOBAL_ID = "global"

function getOrCreateGlobal(): Global {
  let g = Global.load(GLOBAL_ID)
  if (g == null) {
    g = new Global(GLOBAL_ID)
    g.numConditions = BigInt.zero()
    g.numOpenConditions = BigInt.zero()
    g.numResolvedConditions = BigInt.zero()
    g.lastUpdatedBlock = BigInt.zero()
    g.lastUpdatedTimestamp = BigInt.zero()
  }
  return g as Global
}

export function handleConditionPreparation(event: ConditionPreparation): void {
  let id = event.params.conditionId.toHexString()
  let c = new Condition(id)
  c.conditionId = event.params.conditionId
  c.oracle = event.params.oracle
  c.questionId = event.params.questionId
  c.outcomeSlotCount = event.params.outcomeSlotCount.toI32()
  c.resolved = false
  c.preparedAtBlock = event.block.number
  c.preparedAtTimestamp = event.block.timestamp
  c.save()

  let g = getOrCreateGlobal()
  g.numConditions = g.numConditions.plus(BigInt.fromI32(1))
  g.numOpenConditions = g.numOpenConditions.plus(BigInt.fromI32(1))
  g.lastUpdatedBlock = event.block.number
  g.lastUpdatedTimestamp = event.block.timestamp
  g.save()
}

export function handleConditionResolution(event: ConditionResolution): void {
  let id = event.params.conditionId.toHexString()
  let c = Condition.load(id)
  if (c == null) {
    // Shouldn't happen — resolution without preparation — but be defensive
    c = new Condition(id)
    c.conditionId = event.params.conditionId
    c.oracle = event.params.oracle
    c.questionId = event.params.questionId
    c.outcomeSlotCount = event.params.outcomeSlotCount.toI32()
    c.preparedAtBlock = event.block.number
    c.preparedAtTimestamp = event.block.timestamp
  }
  c.resolved = true
  c.payoutNumerators = event.params.payoutNumerators
  c.resolvedAtBlock = event.block.number
  c.resolvedAtTimestamp = event.block.timestamp
  c.save()

  let g = getOrCreateGlobal()
  if (g.numOpenConditions.gt(BigInt.zero())) {
    g.numOpenConditions = g.numOpenConditions.minus(BigInt.fromI32(1))
  }
  g.numResolvedConditions = g.numResolvedConditions.plus(BigInt.fromI32(1))
  g.lastUpdatedBlock = event.block.number
  g.lastUpdatedTimestamp = event.block.timestamp
  g.save()
}
