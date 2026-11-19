import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts"
import { TransferSingle, TransferBatch } from "../generated/PositionManagerV2Mints/PositionManagerV2"
import {
  ConditionResolved,
  PositionsSplit,
  PositionsMerged,
  PositionRedeemed,
  HorizontalSplit,
  HorizontalMerge,
  RemainingConditionsDerivableAsNo,
  SyntheticConditionDerivableAsYes,
  MigrationConditionRegistered,
  PositionMigrated,
  BridgePositionMinted,
  BridgePositionsBurned,
} from "../generated/NegRiskModuleV2/ModuleV2"
import { ConditionPayout, MarketOpenInterest, MigrationLink, V2ComboCredit } from "../generated/schema"
import {
  NEG_RISK_MODULE_V2,
  COMBINATORIAL_MODULE_V2,
  PUSD,
  KIND_SPLIT,
  KIND_MERGE,
  KIND_REDEEM,
  KIND_MIGRATE,
  KIND_COMBO,
  MarketWrite,
  applyGlobal,
  commitWithGlobal,
  resolveMarket,
} from "./oi"

// Polymarket V2 (Polymarket/polymarket-v2-external, docs/position-ids.md):
//   positionId = [moduleId(8) | baseHash(128) | arity(16) | reserved(64) |
//                 resolutionChain(16) | conditionIndex(16) | outcomeIndex(8)]
//   ConditionId = bytes31 (positionId without the outcome byte), EventId = bytes29.
// MarketOpenInterest.id for a V2 market is the 32-byte hex Gamma calls conditionId
// (ConditionId left-aligned, outcome byte 0); clobTokenIds are the positionIds.
const RESULT_DENOMINATOR = BigInt.fromI32(1000000)
const MODULE_BINARY: u8 = 1
const MODULE_NEG_RISK: u8 = 2
const BI_ZERO = BigInt.zero()
const ZERO_ADDRESS = Bytes.fromHexString("0x0000000000000000000000000000000000000000")

function idFromPrefix(b: Bytes): string {
  let out = new Bytes(32)
  for (let i = 0; i < b.length && i < 31; i++) out[i] = b[i]
  return out.toHexString()
}

class V2Pos {
  cid: string = ""
  module: u8 = 0
  outcome: u8 = 0
}

// graph-ts BigInt bytes are little-endian two's complement: [0] = outcomeIndex,
// [31] = moduleId. Module ids 1..3 keep the top bit clear, so graph-node hands a module
// position id over as exactly 32 bytes (a 33rd zero byte is tolerated).
function decode(positionId: BigInt): V2Pos | null {
  let le = changetype<Bytes>(positionId)
  if (le.length != 32 && !(le.length == 33 && le[32] == 0)) return null
  let module = le[31]
  let outcome = le[0]
  // Combinatorial (3) and unknown modules are not binary markets.
  if ((module != MODULE_BINARY && module != MODULE_NEG_RISK) || outcome > 1) return null
  let be = new Bytes(32)
  for (let i = 1; i < 32; i++) be[31 - i] = le[i] // be[31] = 0: outcome byte cleared
  let p = new V2Pos()
  p.cid = be.toHexString()
  p.module = module
  p.outcome = outcome
  return p
}

/** MarketWrite for a V2 market: no CTF Condition to load; neg-risk from the module byte. */
function v2Write(cid: string, negRisk: boolean, event: ethereum.Event): MarketWrite {
  let w = new MarketWrite(cid, MarketOpenInterest.load(cid), negRisk, event)
  w.condLoaded = true
  return w
}

function v2Commit(w: MarketWrite): i32 {
  let m = w.market
  if (m != null && w.fresh) m.collateralToken = PUSD
  return w.commit()
}

function isNegRiskId(cid: string): boolean {
  // "0x02…": module byte of the condition id
  return cid.charCodeAt(2) == 48 && cid.charCodeAt(3) == 50
}

// ---------------------------------------------------------------------------
// Supplies: every V2 path (split, merge, redeem, convert, horizontal, migration,
// bridge) mints or burns through the PositionManager, so supplies are exact.

function maxBI(a: BigInt, b: BigInt): BigInt {
  return a.gt(b) ? a : b
}
function minBI(a: BigInt, b: BigInt): BigInt {
  return a.lt(b) ? a : b
}

function comboCredit(cid: string): V2ComboCredit {
  let c = V2ComboCredit.load(cid)
  if (c == null) {
    c = new V2ComboCredit(cid)
    c.yesMint = BI_ZERO
    c.noMint = BI_ZERO
    c.yesBurn = BI_ZERO
    c.noBurn = BI_ZERO
    c.yesOpen = BI_ZERO
    c.noOpen = BI_ZERO
    c.applied = BI_ZERO
  }
  return c
}

/**
 * CombinatorialModule unwrap (mint) / wrap (burn) and module mintFromBridge /
 * burnFromBridge mint or burn Binary and NegRisk tokens without BinaryModule /
 * NegRiskModule PositionsSplit or PositionsMerged (extract / inject only touch
 * module 3 ids). Credit or debit `amount` for those tokens, pairing YES and NO
 * so a complete set is counted once (max of the two still-held sides).
 * Same-transaction and cross-transaction unwraps use the same accumulator; a
 * per-transaction max() would double-credit a set completed in a later tx
 * (YES in tx1 + NO in tx2 + merge = leftover amount).
 *
 * Lifetime max(mints)-max(burns) is not enough: wrapping migrated (non-combo)
 * tokens would debit credit those tokens never received, and combo mints on
 * both sides that each pair with a migrated complement would stop increasing
 * max() and go negative at the second merge. Open inventory (minted, not
 * wrapped, not yet merged) is the pairing pool; PositionsMerged retires it
 * without a second debit.
 * Mints from BinaryModule / NegRiskModule are already covered by PositionsSplit
 * or migration settlement and must not be credited here.
 */
function applyComboAmount(cid: string, negRisk: boolean, outcome: u8, delta: BigInt, event: ethereum.Event): void {
  if (delta.isZero()) return
  let c = comboCredit(cid)
  let before = maxBI(c.yesOpen, c.noOpen)
  if (delta.gt(BI_ZERO)) {
    if (outcome == 0) {
      c.yesMint = c.yesMint.plus(delta)
      c.yesOpen = c.yesOpen.plus(delta)
    } else {
      c.noMint = c.noMint.plus(delta)
      c.noOpen = c.noOpen.plus(delta)
    }
  } else {
    let burn = delta.neg()
    if (outcome == 0) {
      c.yesBurn = c.yesBurn.plus(burn)
      c.yesOpen = c.yesOpen.minus(minBI(c.yesOpen, burn))
    } else {
      c.noBurn = c.noBurn.plus(burn)
      c.noOpen = c.noOpen.minus(minBI(c.noOpen, burn))
    }
  }
  let after = maxBI(c.yesOpen, c.noOpen)
  let diff = after.minus(before)
  c.applied = c.applied.plus(diff)
  c.save()
  // No credit move, but a burn may still have left `amount` above what the remaining
  // tokens can claim (e.g. wrapping combo YES whose open inventory a merge retired).
  if (diff.isZero()) {
    if (delta.lt(BI_ZERO)) capToClaims(cid, negRisk, event)
    return
  }
  v2Amount(cid, negRisk, diff, KIND_COMBO, event)
}

/** Retire still-held combo tokens that a V2 merge just burned. No amount change. */
function consumeComboOpen(cid: string, amount: BigInt): void {
  if (amount.isZero()) return
  let c = V2ComboCredit.load(cid)
  if (c == null) return
  // Nothing open: skip the write (and its PoI entry) on every later merge.
  if (c.yesOpen.isZero() && c.noOpen.isZero()) return
  c.yesOpen = c.yesOpen.minus(minBI(c.yesOpen, amount))
  c.noOpen = c.noOpen.minus(minBI(c.noOpen, amount))
  c.save()
}

function applySupply(positionId: BigInt, delta: BigInt, event: ethereum.Event, operator: Address): i32 {
  let p = decode(positionId)
  if (p == null) return 0
  let w = v2Write(p.cid, p.module == MODULE_NEG_RISK, event)
  if (p.outcome == 0) w.supplies(delta, BI_ZERO, true)
  else w.supplies(BI_ZERO, delta, true)
  let created = v2Commit(w)
  if (operator.equals(COMBINATORIAL_MODULE_V2) && !delta.isZero()) {
    applyComboAmount(p.cid, p.module == MODULE_NEG_RISK, p.outcome, delta, event)
  }
  return created
}

function batch(ids: BigInt[], amounts: BigInt[], burn: boolean, event: ethereum.Event, operator: Address): void {
  let created = 0
  let n = ids.length < amounts.length ? ids.length : amounts.length
  for (let i = 0; i < n; i++) {
    created += applySupply(ids[i], burn ? amounts[i].neg() : amounts[i], event, operator)
  }
  applyGlobal(BI_ZERO, created, false, event)
}

// The manifest topic filters already restrict these to mints (from = 0) and burns
// (to = 0); the address checks keep that true even if a node ignored the filters.
export function handleV2Mint(event: TransferSingle): void {
  if (!event.params.from.equals(ZERO_ADDRESS)) return
  applyGlobal(BI_ZERO, applySupply(event.params.id, event.params.amount, event, event.params.operator), false, event)
}
export function handleV2Burn(event: TransferSingle): void {
  if (!event.params.to.equals(ZERO_ADDRESS)) return
  applyGlobal(BI_ZERO, applySupply(event.params.id, event.params.amount.neg(), event, event.params.operator), false, event)
}
export function handleV2MintBatch(event: TransferBatch): void {
  if (!event.params.from.equals(ZERO_ADDRESS)) return
  batch(event.params.ids, event.params.amounts, false, event, event.params.operator)
}
export function handleV2BurnBatch(event: TransferBatch): void {
  if (!event.params.to.equals(ZERO_ADDRESS)) return
  batch(event.params.ids, event.params.amounts, true, event, event.params.operator)
}

// ---------------------------------------------------------------------------
// Collateral (`amount`, global), pUSD 6dp.

// ---------------------------------------------------------------------------
// Cap to claims (V2 binary only). Fungible tokens make any per-token attribution of
// combo / bridge inventory inexact, and some sequences end with `amount` above zero
// and no tokens left (split 10, unwrap YES 5, merge 10, wrap YES 5 -> +5). `amount`
// can never exceed what the circulating tokens can still claim:
//   open:     max(yesSupply, noSupply)   (a complete set needs both sides)
//   resolved: (yesSupply * n0 + noSupply * n1) / (n0 + n1)
// so after every debit / combo move, and at resolution, the excess is released
// (market and global). It only lowers `amount`, never raises it. V2 supplies are
// exact (every path mints / burns through the PositionManager).
// Not applied to V2 neg-risk: convert and horizontal split / merge move YES without
// a per-market credit, so per-market `amount` is not conserved there (use supplies).

function claimBound(m: MarketOpenInterest): BigInt {
  if (m.resolved && m.payoutNumerators != null) {
    let nums = m.payoutNumerators as BigInt[]
    let den = nums[0].plus(nums[1])
    if (den.isZero()) return maxBI(m.yesSupplyRaw, m.noSupplyRaw)
    let y = m.yesSupplyRaw.gt(BI_ZERO) ? m.yesSupplyRaw : BI_ZERO
    let n = m.noSupplyRaw.gt(BI_ZERO) ? m.noSupplyRaw : BI_ZERO
    return y.times(nums[0]).plus(n.times(nums[1])).div(den)
  }
  let b = maxBI(m.yesSupplyRaw, m.noSupplyRaw)
  return b.gt(BI_ZERO) ? b : BI_ZERO
}

/** Excess of `amount` over claimBound on a V2 binary market, else 0. */
function claimExcess(m: MarketOpenInterest | null, negRisk: boolean): BigInt {
  if (m == null || negRisk || m.negRisk) return BI_ZERO
  let excess = m.amountRaw.minus(claimBound(m))
  return excess.gt(BI_ZERO) ? excess : BI_ZERO
}

/** Release the excess of `amount` over what the tokens can claim (own write). */
function capToClaims(cid: string, negRisk: boolean, event: ethereum.Event): void {
  if (negRisk) return
  let m = MarketOpenInterest.load(cid)
  let excess = claimExcess(m, negRisk)
  if (excess.isZero()) return
  let w = v2Write(cid, negRisk, event)
  w.amount(excess.neg(), KIND_COMBO)
  commitWithGlobal(w, excess.neg(), event)
}

function v2Amount(cid: string, negRisk: boolean, delta: BigInt, kind: i32, event: ethereum.Event): void {
  let w = v2Write(cid, negRisk, event)
  w.amount(delta, kind)
  let m = w.market
  if (m != null && w.fresh) m.collateralToken = PUSD
  // Cap after debits and combo / bridge moves, in the same write (one save). Splits
  // and migration credits are not capped (their mints may come later in the tx).
  if (delta.lt(BI_ZERO) || kind == KIND_COMBO) {
    let excess = claimExcess(m, negRisk)
    if (!excess.isZero()) {
      w.amount(excess.neg(), KIND_COMBO)
      delta = delta.minus(excess)
    }
  }
  commitWithGlobal(w, delta, event)
}
export function handleV2Split(event: PositionsSplit): void {
  let c = event.params.conditionId
  v2Amount(idFromPrefix(c), c[0] == MODULE_NEG_RISK, event.params.amount, KIND_SPLIT, event)
}
export function handleV2Merge(event: PositionsMerged): void {
  let c = event.params.conditionId
  let cid = idFromPrefix(c)
  v2Amount(cid, c[0] == MODULE_NEG_RISK, event.params.amount.neg(), KIND_MERGE, event)
  consumeComboOpen(cid, event.params.amount)
}
export function handleV2Redeem(event: PositionRedeemed): void {
  let p = decode(event.params.positionId)
  if (p == null) return
  v2Amount(p.cid, p.module == MODULE_NEG_RISK, event.params.payout.neg(), KIND_REDEEM, event)
}
// Horizontal split / merge spread one collateral amount over every YES of a neg-risk
// event (arity + 1 conditions, including the synthetic Other): global only, no
// per-market attribution. Convert (one NO -> YES on every other condition) moves no
// collateral, so it has no handler; its supplies come from the mints / burns.
export function handleV2HorizontalSplit(event: HorizontalSplit): void {
  applyGlobal(event.params.amount, 0, true, event)
}
export function handleV2HorizontalMerge(event: HorizontalMerge): void {
  applyGlobal(event.params.amount.neg(), 0, true, event)
}

// ---------------------------------------------------------------------------
// Resolution, written once per condition (ConditionPayout is immutable), so a market
// first touched after resolution starts resolved (newMarket reads ConditionPayout).

function writePayout(cid: string, nums: BigInt[], event: ethereum.Event): void {
  if (nums.length != 2 || ConditionPayout.load(cid) != null) return
  let r = new ConditionPayout(cid)
  r.payoutNumerators = nums
  r.blockNumber = event.block.number
  r.save()
  resolveMarket(cid, nums, event)
  // Tokens on the losing side no longer claim anything (e.g. an unwrapped combo NO when
  // YES wins: the combo YES redeems in module 3).
  capToClaims(cid, isNegRiskId(cid), event)
}
export function handleV2ConditionResolved(event: ConditionResolved): void {
  writePayout(idFromPrefix(event.params.conditionId), event.params.result, event)
}
// Emitted right after a YES result is stored (NegRiskModule._finalizeNegriskResolution):
// every other real condition and the synthetic Other (index = arity) derive NO without
// their own ConditionResolved. Stored results (the YES, earlier NOs) are skipped.
export function handleV2RemainingNo(event: RemainingConditionsDerivableAsNo): void {
  let e = event.params.eventId // bytes29
  if (e.length < 29) return
  let arity = ((e[17] as i32) << 8) | (e[18] as i32) // bits 104-119
  for (let i = 0; i <= arity; i++) {
    let c = new Bytes(32)
    for (let k = 0; k < 29; k++) c[k] = e[k]
    c[29] = ((i >> 8) & 0xff) as u8 // conditionIndex, bits 8-23
    c[30] = (i & 0xff) as u8
    writePayout(c.toHexString(), [BI_ZERO, RESULT_DENOMINATOR], event)
  }
}
// Every real condition resolved NO: the synthetic Other derives YES.
export function handleV2OtherYes(event: SyntheticConditionDerivableAsYes): void {
  writePayout(idFromPrefix(event.params.conditionId), [RESULT_DENOMINATOR, BI_ZERO], event)
}

// ---------------------------------------------------------------------------
// Migration of legacy CTF / NegRiskAdapter positions into V2.
//
// migratePositions: legacy tokens move from the user to the module (escrow), the module
// batch-mints the V2 positions (supplies via handleV2MintBatch), merges complete legacy
// sets or redeems resolved ones on the CTF, and emits PositionMigrated per position.
//  - PositionMigrated: the escrowed legacy tokens leave the legacy market's supplies (they
//    back the V2 tokens now; counting both would double count priced OI).
//  - module CTF merge / redeem (mapping.ts -> migrationSettlement): the released collateral
//    moves from the legacy market's `amount` to the V2 market's; global OI is unchanged
//    (the collateral is settled into the V2 vault, and leaves OI when V2 positions redeem).

export function handleV2MigrationRegistered(event: MigrationConditionRegistered): void {
  let v2 = idFromPrefix(event.params.v2ConditionId)
  let legacy = event.params.legacyConditionId
  let a = new MigrationLink(v2)
  a.counterpart = legacy
  a.save()
  let b = new MigrationLink(legacy.toHexString())
  b.counterpart = Bytes.fromHexString(v2)
  b.save()
}

export function handleV2PositionMigrated(event: PositionMigrated): void {
  let link = MigrationLink.load(idFromPrefix(event.params.conditionId))
  if (link == null) return
  let legacy = link.counterpart.toHexString()
  let m = MarketOpenInterest.load(legacy)
  if (m == null) return
  let w = new MarketWrite(legacy, m, m.negRisk, event)
  let amount = event.params.amount.neg()
  // NegRiskModule escrows the WCOL (traded) tokens; BinaryModule escrows USDC.e tokens,
  // which on a neg-risk condition are not the traded ones (supplies() skips them).
  let traded = event.address.equals(NEG_RISK_MODULE_V2)
  if (event.params.outcomeIndex.isZero()) w.supplies(amount, BI_ZERO, traded)
  else w.supplies(BI_ZERO, amount, traded)
  w.commit()
}

/**
 * Called from the CTF handlers when a V2 module merges or redeems escrowed legacy
 * positions. `w` already holds the legacy amount decrease and counter. Moves `released`
 * to the linked V2 market. Returns false (caller falls back to the normal path) when the
 * legacy condition has no migration link.
 */
export function migrationSettlement(w: MarketWrite, released: BigInt, event: ethereum.Event): boolean {
  let link = MigrationLink.load(w.id)
  if (link == null) return false
  let created = w.commit()
  if (!released.isZero()) {
    let v2 = link.counterpart.toHexString()
    let v = v2Write(v2, isNegRiskId(v2), event)
    v.amount(released, KIND_MIGRATE)
    created += v2Commit(v)
  }
  applyGlobal(BI_ZERO, created, false, event)
  return true
}

// ---------------------------------------------------------------------------
// Bridge (BaseModule.mintFromBridge / burnFromBridge). Polygon is the hub: a bridge mints
// positions through the PositionManager with the module as operator (no PositionsSplit)
// and burns them on the way out (no PositionsMerged). Same accumulator and pairing as the
// combo path, so a bridged-in position followed by a merge does not drive `amount`
// negative, and a bridged-out position releases its claim (cap). Supplies come from the
// PositionManager mint / burn emitted before these events.

export function handleV2BridgeMinted(event: BridgePositionMinted): void {
  let p = decode(event.params.positionId)
  if (p == null || event.params.amount.isZero()) return
  applyComboAmount(p.cid, p.module == MODULE_NEG_RISK, p.outcome, event.params.amount, event)
}

export function handleV2BridgeBurned(event: BridgePositionsBurned): void {
  let ids = event.params.positionIds
  let amounts = event.params.amounts
  let n = ids.length < amounts.length ? ids.length : amounts.length
  for (let i = 0; i < n; i++) {
    let p = decode(ids[i])
    if (p == null || amounts[i].isZero()) continue
    applyComboAmount(p.cid, p.module == MODULE_NEG_RISK, p.outcome, amounts[i].neg(), event)
  }
}
