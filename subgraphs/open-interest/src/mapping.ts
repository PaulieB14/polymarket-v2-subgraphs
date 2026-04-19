import { BigDecimal, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts"
import {
  PositionSplit,
  PositionsMerge,
  PayoutRedemption,
} from "../generated/ConditionalTokens/ConditionalTokens"
import {
  MarketOpenInterest,
  OISnapshot,
  GlobalOpenInterest,
} from "../generated/schema"

let USDC_DECIMALS = 6
let BD_ZERO = BigDecimal.zero()
let BI_ZERO = BigInt.zero()
let BI_ONE = BigInt.fromI32(1)
let HOUR_SECONDS = BigInt.fromI32(3600)

function toDecimal(amount: BigInt): BigDecimal {
  let divisor = BigInt.fromI32(10).pow(USDC_DECIMALS as u8).toBigDecimal()
  return amount.toBigDecimal().div(divisor)
}

function getOrCreateMarket(
  conditionId: Bytes,
  collateralToken: Bytes,
  event: ethereum.Event
): MarketOpenInterest {
  let id = conditionId.toHexString()
  let market = MarketOpenInterest.load(id)
  if (market == null) {
    market = new MarketOpenInterest(id)
    market.conditionId = conditionId
    market.collateralToken = collateralToken
    market.amount = BD_ZERO
    market.amountRaw = BI_ZERO
    market.splitCount = BI_ZERO
    market.mergeCount = BI_ZERO
    market.redemptionCount = BI_ZERO
    market.createdAtBlock = event.block.number
    market.createdAtTimestamp = event.block.timestamp
    market.lastUpdatedBlock = event.block.number
    market.lastUpdatedTimestamp = event.block.timestamp
  }
  return market as MarketOpenInterest
}

function getOrCreateGlobal(): GlobalOpenInterest {
  let global = GlobalOpenInterest.load("global")
  if (global == null) {
    global = new GlobalOpenInterest("global")
    global.amount = BD_ZERO
    global.amountRaw = BI_ZERO
    global.marketCount = 0
    global.lastUpdatedBlock = BI_ZERO
    global.lastUpdatedTimestamp = BI_ZERO
  }
  return global as GlobalOpenInterest
}

function createOrUpdateHourlySnapshot(
  market: MarketOpenInterest,
  event: ethereum.Event
): void {
  let hourId = event.block.timestamp.div(HOUR_SECONDS).toString()
  let snapshotId = market.id + "-" + hourId
  let snapshot = OISnapshot.load(snapshotId)
  if (snapshot == null) {
    snapshot = new OISnapshot(snapshotId)
    snapshot.market = market.id
  }
  snapshot.amount = market.amount
  snapshot.amountRaw = market.amountRaw
  snapshot.blockNumber = event.block.number
  snapshot.timestamp = event.block.timestamp
  snapshot.save()
}

export function handlePositionSplit(event: PositionSplit): void {
  let conditionId = event.params.conditionId
  let amount = event.params.amount

  let market = getOrCreateMarket(
    conditionId,
    event.params.collateralToken,
    event
  )
  let isNew = market.splitCount.equals(BI_ZERO)
  market.amountRaw = market.amountRaw.plus(amount)
  market.amount = toDecimal(market.amountRaw)
  market.splitCount = market.splitCount.plus(BI_ONE)
  market.lastUpdatedBlock = event.block.number
  market.lastUpdatedTimestamp = event.block.timestamp
  market.save()

  let global = getOrCreateGlobal()
  if (isNew) {
    global.marketCount = global.marketCount + 1
  }
  global.amountRaw = global.amountRaw.plus(amount)
  global.amount = toDecimal(global.amountRaw)
  global.lastUpdatedBlock = event.block.number
  global.lastUpdatedTimestamp = event.block.timestamp
  global.save()

  createOrUpdateHourlySnapshot(market, event)
}

export function handlePositionsMerge(event: PositionsMerge): void {
  let conditionId = event.params.conditionId
  let amount = event.params.amount

  let market = getOrCreateMarket(
    conditionId,
    event.params.collateralToken,
    event
  )
  let actualSubtracted: BigInt
  if (market.amountRaw.gt(amount)) {
    actualSubtracted = amount
    market.amountRaw = market.amountRaw.minus(amount)
  } else {
    actualSubtracted = market.amountRaw
    market.amountRaw = BI_ZERO
  }
  market.amount = toDecimal(market.amountRaw)
  market.mergeCount = market.mergeCount.plus(BI_ONE)
  market.lastUpdatedBlock = event.block.number
  market.lastUpdatedTimestamp = event.block.timestamp
  market.save()

  let global = getOrCreateGlobal()
  if (global.amountRaw.gt(actualSubtracted)) {
    global.amountRaw = global.amountRaw.minus(actualSubtracted)
  } else {
    global.amountRaw = BI_ZERO
  }
  global.amount = toDecimal(global.amountRaw)
  global.lastUpdatedBlock = event.block.number
  global.lastUpdatedTimestamp = event.block.timestamp
  global.save()

  createOrUpdateHourlySnapshot(market, event)
}

export function handlePayoutRedemption(event: PayoutRedemption): void {
  let conditionId = event.params.conditionId
  let payout = event.params.payout

  let market = getOrCreateMarket(
    conditionId,
    event.params.collateralToken,
    event
  )
  let actualSubtracted: BigInt
  if (market.amountRaw.gt(payout)) {
    actualSubtracted = payout
    market.amountRaw = market.amountRaw.minus(payout)
  } else {
    actualSubtracted = market.amountRaw
    market.amountRaw = BI_ZERO
  }
  market.amount = toDecimal(market.amountRaw)
  market.redemptionCount = market.redemptionCount.plus(BI_ONE)
  market.lastUpdatedBlock = event.block.number
  market.lastUpdatedTimestamp = event.block.timestamp
  market.save()

  let global = getOrCreateGlobal()
  if (global.amountRaw.gt(actualSubtracted)) {
    global.amountRaw = global.amountRaw.minus(actualSubtracted)
  } else {
    global.amountRaw = BI_ZERO
  }
  global.amount = toDecimal(global.amountRaw)
  global.lastUpdatedBlock = event.block.number
  global.lastUpdatedTimestamp = event.block.timestamp
  global.save()

  createOrUpdateHourlySnapshot(market, event)
}
