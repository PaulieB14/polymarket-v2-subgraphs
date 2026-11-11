import { Address, BigDecimal, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts"
import { Condition, ConditionPayout, MarketOpenInterest, OISnapshot, GlobalOpenInterest } from "../generated/schema"

// Only collateral counted at the CTF level. Everything Polymarket lists settles in
// USDC.e at the CTF (V2's CtfCollateralAdapter unwraps pUSD -> USDC.e before
// splitting). Neg-risk markets use WrappedCollateral at the CTF and are counted via
// the NegRiskAdapter instead. Anything else (WMATIC, pUSD or native USDC split
// directly on CTF, random tokens) is ignored, so every amount here has 6 decimals.
// Address constants are built from bytes (no host call at module init).
export const USDC_E = Address.fromBytes(Bytes.fromHexString("0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"))
export const NEG_RISK_ADAPTER = Address.fromBytes(Bytes.fromHexString("0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296"))
// NegRiskAdapter.wcol() on Polygon: WrappedCollateral, the CTF collateral of neg-risk positions.
export const WCOL = Address.fromBytes(Bytes.fromHexString("0x3A3BD7bb9528E159577F7C2e685CC81A765002E2"))
// Polymarket V2 modules (PositionManager ModuleAdded ids 1 and 2). Both also migrate legacy
// positions: they call the CTF directly (BinaryModule with USDC.e, NegRiskModule with WCOL)
// to merge / redeem the legacy positions users hand over.
export const BINARY_MODULE_V2 = Address.fromBytes(Bytes.fromHexString("0x1000008dD9001B968442c1000017eaE6E0dA00Ba"))
export const NEG_RISK_MODULE_V2 = Address.fromBytes(Bytes.fromHexString("0x200000900045e3B6259600682756002200028933"))
// pUSD (V2 CollateralToken): 6 decimals, 1:1 USD.
export const PUSD = Address.fromBytes(Bytes.fromHexString("0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB"))
export const ZERO_BYTES32 = Bytes.fromHexString(
  "0x0000000000000000000000000000000000000000000000000000000000000000"
)

const BD_ZERO = BigDecimal.zero()
const BI_ZERO = BigInt.zero()
const BI_ONE = BigInt.fromI32(1)
const BI_TWO = BigInt.fromI32(2)
// Precomputed 1e6 so toDecimal does not call BigInt.pow on the host for every update.
const BD_1E6 = BigInt.fromI32(1000000).toBigDecimal()
const GLOBAL_ID = "global"

export const KIND_SPLIT = 0
export const KIND_MERGE = 1
export const KIND_REDEEM = 2
export const KIND_CONVERT = 3
// settlement of conversion bookkeeping on OutcomeReported: moves OI, bumps no counter
export const KIND_RESOLVE = 4
// V2 migration: legacy collateral released by a V2 module moves to the V2 market (no counter)
export const KIND_MIGRATE = 5

function toDecimal(amount: BigInt): BigDecimal {
  return amount.toBigDecimal().div(BD_1E6)
}

function newMarket(conditionId: string, negRisk: boolean, cond: Condition | null, event: ethereum.Event): MarketOpenInterest {
  let market = new MarketOpenInterest(conditionId)
  market.conditionId = Bytes.fromHexString(conditionId)
  market.collateralToken = USDC_E
  // negRisk follows the condition's oracle, not which contract touched it first
  // (a stray direct USDC.e split on a neg-risk condition used to flag it false).
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
  return market
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
  // hour id from i64 arithmetic: same string as timestamp.div(3600).toString(), no host calls
  let id = market.id + "-" + (event.block.timestamp.toI64() / 3600).toString()
  let snap = new OISnapshot(id)
  snap.market = market.id
  snap.amount = market.amount
  snap.amountRaw = market.amountRaw
  snap.blockNumber = event.block.number
  snap.timestamp = event.block.timestamp
  snap.save()
}

/**
 * All changes one event makes to one MarketOpenInterest. The market is loaded
 * (or created) once, every delta is applied in memory, decimals are derived once
 * from the final *Raw values and the entity is saved once in commit(). The
 * per-step rules are the same as the former updateMarket / updateSupplies /
 * redeemSupplies / bumpConvert* helpers, which each loaded and saved the market.
 */
export class MarketWrite {
  id: string
  market: MarketOpenInterest | null
  negRisk: boolean
  event: ethereum.Event
  cond: Condition | null = null
  condLoaded: boolean = false
  fresh: boolean = false
  dirty: boolean = false
  amountDirty: boolean = false
  suppliesDirty: boolean = false
  touched: boolean = false
  snap: boolean = false
  /** CTF event in WrappedCollateral by a caller other than the NegRiskAdapter (direct split /
   *  merge / redeem of the traded neg-risk tokens). Its supplies count like adapter ones. */
  wcol: boolean = false

  constructor(id: string, market: MarketOpenInterest | null, negRisk: boolean, event: ethereum.Event) {
    this.id = id
    this.market = market
    this.negRisk = negRisk
    this.event = event
  }

  /** Neg-risk per the stored market, or per the condition's oracle before creation. */
  isNegRisk(): boolean {
    let m = this.market
    if (m != null) return m.negRisk
    let c = this.cond
    if (c == null) return false
    return Address.fromBytes(c.oracle).equals(NEG_RISK_ADAPTER)
  }

  private ensure(): MarketOpenInterest {
    let m = this.market
    if (m == null) {
      if (!this.condLoaded) {
        this.cond = Condition.load(this.id)
        this.condLoaded = true
      }
      m = newMarket(this.id, this.negRisk, this.cond, this.event)
      this.market = m
      this.fresh = true
    }
    return m as MarketOpenInterest
  }

  private touch(m: MarketOpenInterest): void {
    m.lastUpdatedBlock = this.event.block.number
    m.lastUpdatedTimestamp = this.event.block.timestamp
    this.touched = true
  }

  /**
   * Signed OI delta (raw USDC, 6dp) and the matching counter. Not clamped: with
   * full history every decrease has a matching earlier increase, and clamping
   * would make the global sum drift from the per-market sum.
   * A zero delta on a market we have never seen does not create it (zero-payout
   * losing-side redemptions were ~4M phantom markets).
   */
  amount(delta: BigInt, kind: i32): void {
    if (delta.isZero() && this.market == null) return
    let m = this.ensure()
    if (!delta.isZero()) {
      m.amountRaw = m.amountRaw.plus(delta)
      this.amountDirty = true
    }
    if (kind == KIND_SPLIT) m.splitCount = m.splitCount.plus(BI_ONE)
    else if (kind == KIND_MERGE) m.mergeCount = m.mergeCount.plus(BI_ONE)
    else if (kind == KIND_REDEEM) m.redemptionCount = m.redemptionCount.plus(BI_ONE)
    else if (kind == KIND_CONVERT) m.conversionCount = m.conversionCount.plus(BI_ONE)
    this.touch(m)
    this.dirty = true
    this.snap = true
  }

  /**
   * Circulating YES / NO outcome-token supplies (raw 6dp):
   *   priced OI = yesSupply * yesPrice + noSupply * (1 - yesPrice)
   * `adapter` says which path called: true = NegRiskAdapter (WrappedCollateral
   * positions), false = direct CTF with USDC.e. On a neg-risk condition the
   * USDC.e positions are different tokens from the ones Polymarket trades: skip.
   */
  supplies(yesDelta: BigInt, noDelta: BigInt, adapter: boolean): void {
    if (yesDelta.isZero() && noDelta.isZero()) return
    let m = this.ensure()
    if (!adapter && m.negRisk) return
    // Resolved: a side with payout numerator 0 is worthless and pinned at 0.
    if (m.resolved) {
      let nums = m.payoutNumerators as BigInt[]
      if (nums[0].isZero()) yesDelta = BI_ZERO
      if (nums[1].isZero()) noDelta = BI_ZERO
      if (yesDelta.isZero() && noDelta.isZero()) return
    }
    m.yesSupplyRaw = m.yesSupplyRaw.plus(yesDelta)
    m.noSupplyRaw = m.noSupplyRaw.plus(noDelta)
    this.suppliesDirty = true
    this.touch(m)
    this.dirty = true
  }

  /**
   * Supplies for a CTF (USDC.e) PayoutRedemption, which reports only the payout.
   * Burned tokens are derived from the payout numerators: with [1,0] / [0,1] the
   * winning tokens burned == payout exactly (losing side is already 0). For split
   * payouts the burned tokens are allocated over the redeemed paying sides in
   * proportion to their supplies. Burns are clamped to the current supply.
   */
  redeem(indexSets: BigInt[], payout: BigInt): void {
    if (payout.isZero()) return
    let m = this.market
    // Neg-risk positions are WCOL: only a direct (non-adapter) WCOL redemption burns them here.
    if (m == null || !m.resolved || (m.negRisk && !this.wcol)) return
    let nums = m.payoutNumerators as BigInt[]
    let yesIn = false
    let noIn = false
    for (let i = 0; i < indexSets.length; i++) {
      if (indexSets[i].equals(BI_ONE)) yesIn = true
      else if (indexSets[i].equals(BI_TWO)) noIn = true
    }
    // [1,0] / [0,1]: the winning tokens burned == payout (losing side is pinned at 0).
    // Same result as the proportional formula below, without the BigInt host calls.
    if (nums[0].isZero() || nums[1].isZero()) {
      let yesWins = nums[1].isZero()
      if (yesWins ? !yesIn : !noIn) return
      let supply = yesWins ? m.yesSupplyRaw : m.noSupplyRaw
      let burned = payout.gt(supply) ? supply : payout
      if (burned.le(BI_ZERO)) return
      if (yesWins) m.yesSupplyRaw = m.yesSupplyRaw.minus(burned)
      else m.noSupplyRaw = m.noSupplyRaw.minus(burned)
      this.suppliesDirty = true
      this.touch(m)
      this.dirty = true
      return
    }
    let den = nums[0].plus(nums[1])
    let wy = yesIn ? m.yesSupplyRaw.times(nums[0]) : BI_ZERO
    let wn = noIn ? m.noSupplyRaw.times(nums[1]) : BI_ZERO
    let weighted = wy.plus(wn)
    if (weighted.le(BI_ZERO)) return
    let yb = BI_ZERO
    let nb = BI_ZERO
    if (wy.gt(BI_ZERO)) yb = payout.times(den).times(m.yesSupplyRaw).div(weighted)
    if (wn.gt(BI_ZERO)) nb = payout.times(den).times(m.noSupplyRaw).div(weighted)
    if (yb.gt(m.yesSupplyRaw)) yb = m.yesSupplyRaw
    if (nb.gt(m.noSupplyRaw)) nb = m.noSupplyRaw
    if (yb.isZero() && nb.isZero()) return
    m.yesSupplyRaw = m.yesSupplyRaw.minus(yb)
    m.noSupplyRaw = m.noSupplyRaw.minus(nb)
    this.suppliesDirty = true
    this.touch(m)
    this.dirty = true
  }

  convertMint(): void {
    let m = this.ensure()
    m.convertMintCount = m.convertMintCount.plus(BI_ONE)
    this.dirty = true
  }

  convertBurn(): void {
    let m = this.ensure()
    m.convertBurnCount = m.convertBurnCount.plus(BI_ONE)
    this.dirty = true
  }

  /** Single save (plus the hourly snapshot when OI was applied). Returns 1 when
   *  a new market was stored, for GlobalOpenInterest.marketCount. */
  commit(): i32 {
    let m = this.market
    if (m == null || !this.dirty) return 0
    // A market first created by a counter-only step (e.g. a conversion minting
    // YES on a question already resolved NO) still needs lastUpdated set.
    if (this.fresh && !this.touched) this.touch(m)
    if (this.amountDirty) m.amount = toDecimal(m.amountRaw)
    if (this.suppliesDirty) {
      m.yesSupply = toDecimal(m.yesSupplyRaw)
      m.noSupply = toDecimal(m.noSupplyRaw)
    }
    m.save()
    if (this.snap) snapshot(m, this.event)
    return this.fresh ? 1 : 0
  }
}

/** MarketWrite for a CTF / adapter split, merge or redemption, or null when the
 *  condition is not a registered binary Polymarket market. Once a
 *  MarketOpenInterest exists Condition.load is skipped; on the first touch the
 *  loaded Condition is reused when the market is created. Unregistered ids never
 *  reach updateGlobal (including zero-delta redemptions). */
export function trackedMarket(conditionId: string, negRisk: boolean, event: ethereum.Event): MarketWrite | null {
  let m = MarketOpenInterest.load(conditionId)
  let w = new MarketWrite(conditionId, m, negRisk, event)
  if (m == null) {
    let cond = Condition.load(conditionId)
    if (cond == null) return null
    w.cond = cond
    w.condLoaded = true
  }
  return w
}

/** Apply a global OI delta and count newly stored markets in one save.
 *  `touch` = false only for marketCount-only changes (no OI moved), which never
 *  updated lastUpdated before either. */
export function applyGlobal(delta: BigInt, newMarkets: i32, touch: boolean, event: ethereum.Event): void {
  if (!touch && newMarkets == 0) return
  let global = getOrCreateGlobal()
  if (newMarkets > 0) global.marketCount = global.marketCount + newMarkets
  if (touch) {
    global.amountRaw = global.amountRaw.plus(delta)
    global.amount = toDecimal(global.amountRaw)
    global.lastUpdatedBlock = event.block.number
    global.lastUpdatedTimestamp = event.block.timestamp
  }
  global.save()
}

export function updateGlobal(delta: BigInt, event: ethereum.Event): void {
  applyGlobal(delta, 0, true, event)
}

/** Commit a split / merge / redemption and move global OI by the same delta. */
export function commitWithGlobal(w: MarketWrite, delta: BigInt, event: ethereum.Event): void {
  applyGlobal(delta, w.commit(), true, event)
}

/** Per-market OI change with no global move (OutcomeReported settlement). */
export function updateMarket(conditionId: string, delta: BigInt, kind: i32, negRisk: boolean, event: ethereum.Event): void {
  let w = new MarketWrite(conditionId, MarketOpenInterest.load(conditionId), negRisk, event)
  w.amount(delta, kind)
  applyGlobal(BI_ZERO, w.commit(), false, event)
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
