import { Address, BigDecimal, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts"
import { Condition, ConditionPayout, MarketOpenInterest, OISnapshot, GlobalOpenInterest } from "../generated/schema"

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

const BD_ZERO = BigDecimal.zero()
const BI_ZERO = BigInt.zero()
const BI_ONE = BigInt.fromI32(1)
// Precomputed 1e6 so toDecimal does not call BigInt.pow on the host for every update.
const BD_1E6 = BigInt.fromI32(1000000).toBigDecimal()
const HOUR_SECONDS = BigInt.fromI32(3600)
const GLOBAL_ID = "global"

export const KIND_SPLIT = 0
export const KIND_MERGE = 1
export const KIND_REDEEM = 2
export const KIND_CONVERT = 3
// settlement of conversion bookkeeping on OutcomeReported: moves OI, bumps no counter
export const KIND_RESOLVE = 4

function toDecimal(amount: BigInt): BigDecimal {
  return amount.toBigDecimal().div(BD_1E6)
}

/** True if this condition is a registered binary Polymarket market.
 *  Once a MarketOpenInterest exists we skip Condition.load: markets are only
 *  created for registered conditions. The first touch still loads Condition so
 *  unregistered ids never reach updateGlobal (including zero-delta redemptions).
 *  This lives at the handler gate rather than only inside getOrCreateMarket so
 *  that zero-payout first touches on a registered market still update global
 *  lastUpdated, matching previous writes. */
export function isTrackedCondition(conditionId: string): boolean {
  if (MarketOpenInterest.load(conditionId) != null) return true
  return Condition.load(conditionId) != null
}

function getOrCreateMarket(conditionId: string, negRisk: boolean, event: ethereum.Event): MarketOpenInterest {
  let market = MarketOpenInterest.load(conditionId)
  if (market == null) {
    market = new MarketOpenInterest(conditionId)
    market.conditionId = Bytes.fromHexString(conditionId)
    market.collateralToken = USDC_E
    // negRisk follows the condition's oracle, not which contract touched it first
    // (a stray direct USDC.e split on a neg-risk condition used to flag it false).
    // One Condition / ConditionPayout load per market creation only.
    let cond = Condition.load(conditionId)
    market.negRisk = negRisk || (cond != null && Address.fromBytes(cond.oracle).equals(NEG_RISK_ADAPTER))
    market.resolved = false
    let payout = ConditionPayout.load(conditionId)
    if (payout != null) {
      market.resolved = true
      market.payoutNumerators = payout.payoutNumerators
      market.resolvedAtBlock = payout.blockNumber
    }
    market.amount = BD_ZERO
    market.amountRaw = BI_ZERO
    market.yesSupply = BD_ZERO
    market.yesSupplyRaw = BI_ZERO
    market.noSupply = BD_ZERO
    market.noSupplyRaw = BI_ZERO
    market.splitCount = BI_ZERO
    market.mergeCount = BI_ZERO
    market.redemptionCount = BI_ZERO
    market.conversionCount = BI_ZERO
    market.convertMintCount = BI_ZERO
    market.convertBurnCount = BI_ZERO
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
  // Deterministic id; every field is overwritten, so skip the load() and
  // construct a new entity. Same write order and values as before.
  let id = market.id + "-" + event.block.timestamp.div(HOUR_SECONDS).toString()
  let snap = new OISnapshot(id)
  snap.market = market.id
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
  // A zero-payout redemption (redeeming the losing side) on a market we have never
  // seen must not create a market: those were ~4M phantom markets in marketCount.
  if (delta.isZero() && MarketOpenInterest.load(conditionId) == null) return
  let market = getOrCreateMarket(conditionId, negRisk, event)
  market.amountRaw = market.amountRaw.plus(delta)
  market.amount = toDecimal(market.amountRaw)
  if (kind == KIND_SPLIT) market.splitCount = market.splitCount.plus(BI_ONE)
  else if (kind == KIND_MERGE) market.mergeCount = market.mergeCount.plus(BI_ONE)
  else if (kind == KIND_REDEEM) market.redemptionCount = market.redemptionCount.plus(BI_ONE)
  else if (kind == KIND_CONVERT) market.conversionCount = market.conversionCount.plus(BI_ONE)
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

/**
 * Adjust circulating YES / NO outcome-token supplies (raw 6dp). These are the
 * quantities needed to reconstruct Polymarket's data-api figure:
 *   priced OI = yesSupply * yesPrice + noSupply * (1 - yesPrice)
 * Burned-to-address NO is not circulating and must not be added here.
 */
export function updateSupplies(conditionId: string, yesDelta: BigInt, noDelta: BigInt, negRisk: boolean, event: ethereum.Event): void {
  if (yesDelta.isZero() && noDelta.isZero()) return
  // Creating a market with a zero-amount, zero-supply first touch is still
  // skipped by updateMarket; a non-zero supply delta is a real market.
  let market = getOrCreateMarket(conditionId, negRisk, event)
  // `negRisk` here says which path called: true = NegRiskAdapter (WrappedCollateral
  // positions), false = direct CTF with USDC.e. On a neg-risk condition the USDC.e
  // positions are different tokens from the ones Polymarket trades: skip them.
  if (!negRisk && market.negRisk) return
  // Resolved: a side with payout numerator 0 is worthless and pinned at 0.
  if (market.resolved) {
    let nums = market.payoutNumerators as BigInt[]
    if (nums[0].isZero()) yesDelta = BI_ZERO
    if (nums[1].isZero()) noDelta = BI_ZERO
    if (yesDelta.isZero() && noDelta.isZero()) return
  }
  market.yesSupplyRaw = market.yesSupplyRaw.plus(yesDelta)
  market.noSupplyRaw = market.noSupplyRaw.plus(noDelta)
  market.yesSupply = toDecimal(market.yesSupplyRaw)
  market.noSupply = toDecimal(market.noSupplyRaw)
  market.lastUpdatedBlock = event.block.number
  market.lastUpdatedTimestamp = event.block.timestamp
  market.save()
}

export function bumpConvertMint(conditionId: string, negRisk: boolean, event: ethereum.Event): void {
  let market = getOrCreateMarket(conditionId, negRisk, event)
  market.convertMintCount = market.convertMintCount.plus(BI_ONE)
  market.save()
}

export function bumpConvertBurn(conditionId: string, negRisk: boolean, event: ethereum.Event): void {
  let market = getOrCreateMarket(conditionId, negRisk, event)
  market.convertBurnCount = market.convertBurnCount.plus(BI_ONE)
  market.save()
}

/**
 * CTF ConditionResolution on a market we track: mark it resolved and zero the
 * worthless side(s). Does not touch `amount` or global OI.
 */
export function resolveMarket(conditionId: string, nums: BigInt[], event: ethereum.Event): void {
  let market = MarketOpenInterest.load(conditionId)
  if (market == null) return
  market.resolved = true
  market.payoutNumerators = nums
  market.resolvedAtBlock = event.block.number
  if (nums[0].isZero()) market.yesSupplyRaw = BI_ZERO
  if (nums[1].isZero()) market.noSupplyRaw = BI_ZERO
  market.yesSupply = toDecimal(market.yesSupplyRaw)
  market.noSupply = toDecimal(market.noSupplyRaw)
  market.save()
}

/**
 * Supplies for a CTF (USDC.e) PayoutRedemption, which reports only the payout.
 * Burned tokens are derived from the payout numerators: with [1,0] / [0,1] the
 * winning tokens burned == payout exactly (losing side is already 0). For split
 * payouts the burned tokens are allocated over the redeemed paying sides in
 * proportion to their supplies. Burns are clamped to the current supply.
 */
export function redeemSupplies(conditionId: string, indexSets: BigInt[], payout: BigInt, event: ethereum.Event): void {
  if (payout.isZero()) return
  let market = MarketOpenInterest.load(conditionId)
  if (market == null || !market.resolved || market.negRisk) return
  let nums = market.payoutNumerators as BigInt[]
  let den = nums[0].plus(nums[1])
  let yesIn = false
  let noIn = false
  for (let i = 0; i < indexSets.length; i++) {
    if (indexSets[i].equals(BI_ONE)) yesIn = true
    else if (indexSets[i].equals(BigInt.fromI32(2))) noIn = true
  }
  let wy = yesIn ? market.yesSupplyRaw.times(nums[0]) : BI_ZERO
  let wn = noIn ? market.noSupplyRaw.times(nums[1]) : BI_ZERO
  let weighted = wy.plus(wn)
  if (weighted.le(BI_ZERO)) return
  let yb = BI_ZERO
  let nb = BI_ZERO
  if (wy.gt(BI_ZERO)) yb = payout.times(den).times(market.yesSupplyRaw).div(weighted)
  if (wn.gt(BI_ZERO)) nb = payout.times(den).times(market.noSupplyRaw).div(weighted)
  if (yb.gt(market.yesSupplyRaw)) yb = market.yesSupplyRaw
  if (nb.gt(market.noSupplyRaw)) nb = market.noSupplyRaw
  if (yb.isZero() && nb.isZero()) return
  market.yesSupplyRaw = market.yesSupplyRaw.minus(yb)
  market.noSupplyRaw = market.noSupplyRaw.minus(nb)
  market.yesSupply = toDecimal(market.yesSupplyRaw)
  market.noSupply = toDecimal(market.noSupplyRaw)
  market.lastUpdatedBlock = event.block.number
  market.lastUpdatedTimestamp = event.block.timestamp
  market.save()
}
