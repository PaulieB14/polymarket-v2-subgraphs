import { BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts"
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
} from "../generated/NegRiskModuleV2/ModuleV2"
import { ConditionPayout, MarketOpenInterest, MigrationLink } from "../generated/schema"
import {
  NEG_RISK_MODULE_V2,
  PUSD,
  KIND_SPLIT,
  KIND_MERGE,
  KIND_REDEEM,
  KIND_MIGRATE,
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

function applySupply(positionId: BigInt, delta: BigInt, event: ethereum.Event): i32 {
  let p = decode(positionId)
  if (p == null) return 0
  let w = v2Write(p.cid, p.module == MODULE_NEG_RISK, event)
  if (p.outcome == 0) w.supplies(delta, BI_ZERO, true)
  else w.supplies(BI_ZERO, delta, true)
  return v2Commit(w)
}

function batch(ids: BigInt[], amounts: BigInt[], burn: boolean, event: ethereum.Event): void {
  let created = 0
  let n = ids.length < amounts.length ? ids.length : amounts.length
  for (let i = 0; i < n; i++) {
    created += applySupply(ids[i], burn ? amounts[i].neg() : amounts[i], event)
  }
  applyGlobal(BI_ZERO, created, false, event)
}

// The manifest topic filters already restrict these to mints (from = 0) and burns
// (to = 0); the address checks keep that true even if a node ignored the filters.
export function handleV2Mint(event: TransferSingle): void {
  if (!event.params.from.equals(ZERO_ADDRESS)) return
  applyGlobal(BI_ZERO, applySupply(event.params.id, event.params.amount, event), false, event)
}
export function handleV2Burn(event: TransferSingle): void {
  if (!event.params.to.equals(ZERO_ADDRESS)) return
  applyGlobal(BI_ZERO, applySupply(event.params.id, event.params.amount.neg(), event), false, event)
}
export function handleV2MintBatch(event: TransferBatch): void {
  if (!event.params.from.equals(ZERO_ADDRESS)) return
  batch(event.params.ids, event.params.amounts, false, event)
}
export function handleV2BurnBatch(event: TransferBatch): void {
  if (!event.params.to.equals(ZERO_ADDRESS)) return
  batch(event.params.ids, event.params.amounts, true, event)
}

// ---------------------------------------------------------------------------
// Collateral (`amount`, global), pUSD 6dp.

function v2Amount(cid: string, negRisk: boolean, delta: BigInt, kind: i32, event: ethereum.Event): void {
  let w = v2Write(cid, negRisk, event)
  w.amount(delta, kind)
  let m = w.market
  if (m != null && w.fresh) m.collateralToken = PUSD
  commitWithGlobal(w, delta, event)
}
export function handleV2Split(event: PositionsSplit): void {
  let c = event.params.conditionId
  v2Amount(idFromPrefix(c), c[0] == MODULE_NEG_RISK, event.params.amount, KIND_SPLIT, event)
}
export function handleV2Merge(event: PositionsMerged): void {
  let c = event.params.conditionId
  v2Amount(idFromPrefix(c), c[0] == MODULE_NEG_RISK, event.params.amount.neg(), KIND_MERGE, event)
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
