import { Address, BigDecimal, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts"
import { MarketOpenInterest, OISnapshot, GlobalOpenInterest } from "../generated/schema"

// Only collateral counted at the CTF level. Everything Polymarket lists settles in
// USDC.e at the CTF (V2's CtfCollateralAdapter unwraps pUSD -> USDC.e before
// splitting). Neg-risk markets use WrappedCollateral at the CTF and are counted via
// the NegRiskAdapter instead. Anything else (WMATIC, pUSD or native USDC split
// directly on CTF, random tokens) is ignored, so every amount here has 6 decimals.
export const USDC_E = Address.fromString("0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174")
export const NEG_RISK_ADAPTER = Address.fromString("0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296")
export const ZERO_BYTES32 = Bytes.fromHexString(
  "0x0000000000000000000000000000000000000000000000000000000000000000"
)

const USDC_DECIMALS: u8 = 6
const BD_ZERO = BigDecimal.zero()
const BI_ZERO = BigInt.zero()
const BI_ONE = BigInt.fromI32(1)
const HOUR_SECONDS = BigInt.fromI32(3600)
const GLOBAL_ID = "global"

export const KIND_SPLIT = 0
export const KIND_MERGE = 1
export const KIND_REDEEM = 2
export const KIND_CONVERT = 3

function toDecimal(amount: BigInt): BigDecimal {
  return amount.toBigDecimal().div(BigInt.fromI32(10).pow(USDC_DECIMALS).toBigDecimal())
}

function getOrCreateMarket(conditionId: string, negRisk: boolean, event: ethereum.Event): MarketOpenInterest {
  let market = MarketOpenInterest.load(conditionId)
  if (market == null) {
    market = new MarketOpenInterest(conditionId)
    market.conditionId = Bytes.fromHexString(conditionId)
    market.collateralToken = USDC_E
    market.negRisk = negRisk
    market.amount = BD_ZERO
    market.amountRaw = BI_ZERO
    market.splitCount = BI_ZERO
    market.mergeCount = BI_ZERO
    market.redemptionCount = BI_ZERO
    market.conversionCount = BI_ZERO
    market.createdAtBlock = event.block.number
    market.createdAtTimestamp = event.block.timestamp
    let global = getOrCreateGlobal()
    global.marketCount = global.marketCount + 1
    global.save()
  }
  return market as MarketOpenInterest
}

function getOrCreateGlobal(): GlobalOpenInterest {
  let global = GlobalOpenInterest.load(GLOBAL_ID)
  if (global == null) {
    global = new GlobalOpenInterest(GLOBAL_ID)
    global.amount = BD_ZERO
    global.amountRaw = BI_ZERO
    global.marketCount = 0
    global.lastUpdatedBlock = BI_ZERO
    global.lastUpdatedTimestamp = BI_ZERO
  }
  return global as GlobalOpenInterest
}

function snapshot(market: MarketOpenInterest, event: ethereum.Event): void {
  let id = market.id + "-" + event.block.timestamp.div(HOUR_SECONDS).toString()
  let snap = OISnapshot.load(id)
  if (snap == null) {
    snap = new OISnapshot(id)
    snap.market = market.id
  }
  snap.amount = market.amount
  snap.amountRaw = market.amountRaw
  snap.blockNumber = event.block.number
  snap.timestamp = event.block.timestamp
  snap.save()
}

/**
 * Apply a signed OI delta (raw USDC, 6dp) to one market and bump its counter.
 * Not clamped: with full history from the CTF deployment block every decrease has
 * a matching earlier increase, and clamping would make the global sum drift from
 * the per-market sum (Polymarket's oi-subgraph does not clamp either).
 */
export function updateMarket(conditionId: string, delta: BigInt, kind: i32, negRisk: boolean, event: ethereum.Event): void {
  let market = getOrCreateMarket(conditionId, negRisk, event)
  market.amountRaw = market.amountRaw.plus(delta)
  market.amount = toDecimal(market.amountRaw)
  if (kind == KIND_SPLIT) market.splitCount = market.splitCount.plus(BI_ONE)
  else if (kind == KIND_MERGE) market.mergeCount = market.mergeCount.plus(BI_ONE)
  else if (kind == KIND_REDEEM) market.redemptionCount = market.redemptionCount.plus(BI_ONE)
  else market.conversionCount = market.conversionCount.plus(BI_ONE)
  market.lastUpdatedBlock = event.block.number
  market.lastUpdatedTimestamp = event.block.timestamp
  market.save()
  snapshot(market, event)
}

export function updateGlobal(delta: BigInt, event: ethereum.Event): void {
  let global = getOrCreateGlobal()
  global.amountRaw = global.amountRaw.plus(delta)
  global.amount = toDecimal(global.amountRaw)
  global.lastUpdatedBlock = event.block.number
  global.lastUpdatedTimestamp = event.block.timestamp
  global.save()
}

export function updateOpenInterest(conditionId: string, delta: BigInt, kind: i32, negRisk: boolean, event: ethereum.Event): void {
  updateMarket(conditionId, delta, kind, negRisk, event)
  updateGlobal(delta, event)
}
