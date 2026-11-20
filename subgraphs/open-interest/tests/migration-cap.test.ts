// Migration settlement after the cap (v0.0.12).
// The V2 modules settle migrated legacy positions on the CTF (merge / redeem). On the
// router path (0x17bec72f65b07cacd12000a0ba0ba162b6b7c52b) a resolved legacy position is
// migrated, the V2 token is wrapped / redeemed, and only then is the legacy position
// redeemed on the CTF. The KIND_MIGRATE credit landed after the last cap, leaving
// `amount` > 0 on resolved V2 binary markets with yes = no = 0 (160 markets, $50,791.89
// at 97,622,500). The credit is now capped to claims on resolved V2 binary markets.
import { assert, beforeEach, clearStore, describe, newMockEvent, test } from "matchstick-as/assembly/index"
import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts"
import {
  ConditionPreparation,
  PositionSplit,
  PositionsMerge,
  PayoutRedemption,
  ConditionResolution,
} from "../generated/ConditionalTokens/ConditionalTokens"
import { TransferSingle, TransferBatch } from "../generated/PositionManagerV2Mints/PositionManagerV2"
import {
  ConditionResolved,
  PositionsMerged,
  PositionRedeemed,
  MigrationConditionRegistered,
  PositionMigrated,
} from "../generated/NegRiskModuleV2/ModuleV2"
import { MarketOpenInterest } from "../generated/schema"
import {
  handleConditionPreparation,
  handlePositionSplit,
  handlePositionsMerge,
  handlePayoutRedemption,
  handleConditionResolution,
} from "../src/mapping"
import {
  handleV2Mint,
  handleV2Burn,
  handleV2MintBatch,
  handleV2Merge,
  handleV2Redeem,
  handleV2ConditionResolved,
  handleV2MigrationRegistered,
  handleV2PositionMigrated,
} from "../src/v2"
import { setupEvent, split as nrSplit, report, usdc, globalRaw, eq } from "./nr-helpers"

const USDC_E = Address.fromString("0x2791bca1f2de4661ed88a30c99a7a9449aa84174")
const WCOL = Address.fromString("0x3a3bd7bb9528e159577f7c2e685cc81a765002e2")
const BIN_MOD = Address.fromString("0x1000008dd9001b968442c1000017eae6e0da00ba")
const NR_MOD = Address.fromString("0x200000900045e3b6259600682756002200028933")
const COMBO = Address.fromString("0x30000034706c7d8e12009dab006be20000c031a8")
const ROUTER = Address.fromString("0x17bec72f65b07cacd12000a0ba0ba162b6b7c52b")
const USER = Address.fromString("0x00000000000000000000000000000000000000aa")
const ZERO = Address.zero()
const ZERO32 = Bytes.fromHexString("0x0000000000000000000000000000000000000000000000000000000000000000")
const COND = Bytes.fromHexString("0xd391104c756f2371defe4daec7e7fa70470ed383c6be338037aab736bca61b19")
const CID = "0xd391104c756f2371defe4daec7e7fa70470ed383c6be338037aab736bca61b19"
const BIN = "0x017d1e01561c374925029c48d5249691ca000000000000000000000000000000"
// Synthetic neg-risk V2 event (module 2, arity 3), as in wcol-v2.test.ts.
const NR_EVENT = "0x02aabbccddeeff00112233445566778899000300000000000000000000"

function pid(cid: string, outcome: i32): BigInt {
  let be = Bytes.fromHexString(cid)
  let le = new Bytes(32)
  for (let i = 0; i < 32; i++) le[i] = be[31 - i]
  le[0] = outcome as u8
  return BigInt.fromUnsignedBytes(changetype<Bytes>(le))
}
function b31(cid: string): Bytes {
  let b = Bytes.fromHexString(cid)
  let o = new Bytes(31)
  for (let i = 0; i < 31; i++) o[i] = b[i]
  return o
}
function nrV2(i: i32): string {
  let b = Bytes.fromHexString(NR_EVENT)
  let c = new Bytes(32)
  for (let k = 0; k < 29; k++) c[k] = b[k]
  c[30] = i as u8
  return c.toHexString()
}
function binYes(): BigInt { return pid(BIN, 0) }
function binNo(): BigInt { return pid(BIN, 1) }
function p(n: string, v: ethereum.Value): ethereum.EventParam { return new ethereum.EventParam(n, v) }
function u(n: i64): ethereum.Value { return ethereum.Value.fromUnsignedBigInt(BigInt.fromI64(n)) }
function ub(n: BigInt): ethereum.Value { return ethereum.Value.fromUnsignedBigInt(n) }
function arr(xs: i32[]): ethereum.Value {
  let out: BigInt[] = []
  for (let i = 0; i < xs.length; i++) out.push(BigInt.fromI32(xs[i]))
  return ethereum.Value.fromUnsignedBigIntArray(out)
}
function m(id: string): MarketOpenInterest { return MarketOpenInterest.load(id)! }
function n(x: i64): BigInt { return BigInt.fromI64(x) }

function prepare(cond: Bytes): void {
  let e = changetype<ConditionPreparation>(newMockEvent())
  e.parameters = [p("conditionId", ethereum.Value.fromFixedBytes(cond)), p("oracle", ethereum.Value.fromAddress(USER)),
    p("questionId", ethereum.Value.fromFixedBytes(ZERO32)), p("outcomeSlotCount", u(2))]
  handleConditionPreparation(e)
}
function ctfOp(kind: i32, cond: Bytes, coll: Address, who: Address, amount: i64): void {
  let params = [p("stakeholder", ethereum.Value.fromAddress(who)), p("collateralToken", ethereum.Value.fromAddress(coll)),
    p("parentCollectionId", ethereum.Value.fromFixedBytes(ZERO32)), p("conditionId", ethereum.Value.fromFixedBytes(cond)),
    p("partition", arr([1, 2])), p("amount", u(amount))]
  if (kind == 0) {
    let e = changetype<PositionSplit>(newMockEvent())
    e.parameters = params
    handlePositionSplit(e)
  } else {
    let e = changetype<PositionsMerge>(newMockEvent())
    e.parameters = params
    handlePositionsMerge(e)
  }
}
function ctfRedeem(cond: Bytes, coll: Address, who: Address, payout: i64): void {
  let r = changetype<PayoutRedemption>(newMockEvent())
  r.parameters = [p("redeemer", ethereum.Value.fromAddress(who)), p("collateralToken", ethereum.Value.fromAddress(coll)),
    p("parentCollectionId", ethereum.Value.fromFixedBytes(ZERO32)), p("conditionId", ethereum.Value.fromFixedBytes(cond)),
    p("indexSets", arr([1, 2])), p("payout", u(payout))]
  handlePayoutRedemption(r)
}
function ctfResolve(cond: Bytes, yes: i32, no: i32): void {
  let e = changetype<ConditionResolution>(newMockEvent())
  e.parameters = [p("conditionId", ethereum.Value.fromFixedBytes(cond)), p("oracle", ethereum.Value.fromAddress(USER)),
    p("questionId", ethereum.Value.fromFixedBytes(ZERO32)), p("outcomeSlotCount", u(2)), p("payoutNumerators", arr([yes, no]))]
  handleConditionResolution(e)
}
function single(op: Address, from: Address, to: Address, id: BigInt, amount: i64): TransferSingle {
  let e = changetype<TransferSingle>(newMockEvent())
  e.parameters = [p("operator", ethereum.Value.fromAddress(op)), p("from", ethereum.Value.fromAddress(from)),
    p("to", ethereum.Value.fromAddress(to)), p("id", ub(id)), p("amount", u(amount))]
  return e
}
function mintBatch(op: Address, ids: BigInt[], amounts: BigInt[]): void {
  let e = changetype<TransferBatch>(newMockEvent())
  e.parameters = [p("operator", ethereum.Value.fromAddress(op)), p("from", ethereum.Value.fromAddress(ZERO)),
    p("to", ethereum.Value.fromAddress(ROUTER)), p("ids", ethereum.Value.fromUnsignedBigIntArray(ids)),
    p("amounts", ethereum.Value.fromUnsignedBigIntArray(amounts))]
  handleV2MintBatch(e)
}
function v2Merge(cid: string, amount: i64): void {
  let e = changetype<PositionsMerged>(newMockEvent())
  e.parameters = [p("initiator", ethereum.Value.fromAddress(USER)), p("conditionId", ethereum.Value.fromFixedBytes(b31(cid))),
    p("recipient", ethereum.Value.fromAddress(USER)), p("amount", u(amount))]
  handleV2Merge(e)
}
function v2Redeem(id: BigInt, amount: i64, payout: i64): void {
  let e = changetype<PositionRedeemed>(newMockEvent())
  e.parameters = [p("initiator", ethereum.Value.fromAddress(ROUTER)), p("positionId", ub(id)),
    p("recipient", ethereum.Value.fromAddress(ROUTER)), p("amount", u(amount)), p("payout", u(payout))]
  handleV2Redeem(e)
}
function v2Resolve(cid: string, yes: i64, no: i64): void {
  let r = changetype<ConditionResolved>(newMockEvent())
  r.parameters = [p("conditionId", ethereum.Value.fromFixedBytes(b31(cid))),
    p("result", ethereum.Value.fromUnsignedBigIntArray([BigInt.fromI64(yes), BigInt.fromI64(no)]))]
  handleV2ConditionResolved(r)
}
function register(v2: string, legacy: Bytes): void {
  let e = changetype<MigrationConditionRegistered>(newMockEvent())
  e.parameters = [p("v2ConditionId", ethereum.Value.fromFixedBytes(b31(v2))), p("legacyConditionId", ethereum.Value.fromFixedBytes(legacy))]
  handleV2MigrationRegistered(e)
}
function migrated(module: Address, v2: string, outcome: i32, amount: i64): void {
  let e = changetype<PositionMigrated>(newMockEvent())
  e.address = module
  e.parameters = [p("from", ethereum.Value.fromAddress(ROUTER)), p("conditionId", ethereum.Value.fromFixedBytes(b31(v2))),
    p("positionId", ub(pid(v2, outcome))), p("outcomeIndex", u(outcome)), p("amount", u(amount))]
  handleV2PositionMigrated(e)
}
// Legacy USDC.e market with 10 / 10 supplies, linked to BIN, both resolved.
function resolvedPair(yes: i32, no: i32): void {
  prepare(COND)
  ctfOp(0, COND, USDC_E, USER, 10000000)
  register(BIN, COND)
  ctfResolve(COND, yes, no)
  v2Resolve(BIN, (yes as i64) * 1000000, (no as i64) * 1000000)
}

describe("migration settlement credit lands after the cap (router path)", () => {
  beforeEach(() => { clearStore() })

  test("resolved YES: migrate 4 YES, combo wrap burns them, then legacy redeem settles 4 -> V2 amount 0", () => {
    resolvedPair(1, 0)
    let g0 = globalRaw()
    mintBatch(BIN_MOD, [binYes()], [n(4000000)])
    migrated(BIN_MOD, BIN, 0, 4000000)
    handleV2Burn(single(COMBO, COMBO, ZERO, binYes(), 4000000)) // router wraps into combo: cap runs here (amount 0)
    eq(BigInt.zero(), m(BIN).yesSupplyRaw, "v2 yes burned")
    ctfRedeem(COND, USDC_E, BIN_MOD, 4000000) // KIND_MIGRATE credit after the cap
    eq(BigInt.zero(), m(BIN).amountRaw, "v2 amount capped to claims (was 4)")
    eq(n(6000000), m(CID).amountRaw, "legacy amount 10 - 4")
    eq(g0.minus(n(4000000)), globalRaw(), "global releases the capped 4")
  })

  test("resolved NO, yes = no = 0 (0x017b1f1d pattern): settlement after the combo wrap -> amount 0", () => {
    resolvedPair(0, 1)
    let g0 = globalRaw()
    mintBatch(BIN_MOD, [binNo()], [n(5000000)])
    migrated(BIN_MOD, BIN, 1, 5000000)
    handleV2Burn(single(COMBO, COMBO, ZERO, binNo(), 5000000)) // router wraps the NO into combo
    eq(BigInt.zero(), m(BIN).noSupplyRaw, "no burned")
    eq(BigInt.zero(), m(BIN).yesSupplyRaw, "yes pinned")
    ctfRedeem(COND, USDC_E, BIN_MOD, 5000000)
    eq(BigInt.zero(), m(BIN).amountRaw, "amount 0, never above claims")
    eq(g0.minus(n(5000000)), globalRaw(), "global: capped 5 leaves OI, no phantom")
  })

  test("partial: settlement larger than the remaining claim is capped to the claim", () => {
    resolvedPair(1, 0)
    mintBatch(BIN_MOD, [binYes()], [n(4000000)])
    migrated(BIN_MOD, BIN, 0, 4000000)
    handleV2Burn(single(COMBO, COMBO, ZERO, binYes(), 3000000)) // 1 YES left
    ctfRedeem(COND, USDC_E, BIN_MOD, 4000000)
    eq(n(1000000), m(BIN).amountRaw, "capped to the 1 YES claim")
  })

  test("amount never exceeds claims after each settlement in repeated router migrations", () => {
    resolvedPair(1, 0)
    for (let i = 0; i < 3; i++) {
      mintBatch(BIN_MOD, [binYes()], [n(2000000)])
      migrated(BIN_MOD, BIN, 0, 2000000)
      handleV2Burn(single(COMBO, COMBO, ZERO, binYes(), 2000000))
      ctfRedeem(COND, USDC_E, BIN_MOD, 2000000)
      assert.assertTrue(m(BIN).amountRaw.le(m(BIN).yesSupplyRaw))
    }
    eq(BigInt.zero(), m(BIN).amountRaw, "0 after 3 router migrations")
    eq(n(4000000), m(CID).amountRaw, "legacy 10 - 6")
  })
})

describe("migration cap regressions: unchanged behaviour", () => {
  beforeEach(() => { clearStore() })

  test("resolved, tokens still held: settlement equals claims, not capped", () => {
    resolvedPair(1, 0)
    let g0 = globalRaw()
    mintBatch(BIN_MOD, [binYes()], [n(4000000)])
    ctfRedeem(COND, USDC_E, BIN_MOD, 4000000)
    migrated(BIN_MOD, BIN, 0, 4000000)
    eq(n(4000000), m(BIN).amountRaw, "v2 amount 4")
    eq(g0, globalRaw(), "global unchanged")
    v2Redeem(binYes(), 4000000, 4000000)
    eq(BigInt.zero(), m(BIN).amountRaw, "v2 redeemed")
    eq(g0.minus(n(4000000)), globalRaw(), "global -4 on V2 exit")
  })

  test("open market: settlement before the V2 mints is not capped (mints may come later)", () => {
    prepare(COND)
    ctfOp(0, COND, USDC_E, USER, 10000000)
    register(BIN, COND)
    let g0 = globalRaw()
    ctfOp(1, COND, USDC_E, BIN_MOD, 3000000)
    eq(n(3000000), m(BIN).amountRaw, "open: credit kept")
    mintBatch(BIN_MOD, [binYes(), binNo()], [n(3000000), n(3000000)])
    eq(n(3000000), m(BIN).amountRaw, "still 3 once minted")
    eq(g0, globalRaw(), "global unchanged")
  })

  test("normal V2 binary merge unchanged (cap only lowers)", () => {
    let g0 = globalRaw()
    mintBatch(BIN_MOD, [binYes(), binNo()], [n(5000000), n(5000000)])
    v2Merge(BIN, 2000000)
    eq(n(-2000000), m(BIN).amountRaw, "merge without a tracked split: not raised")
    eq(g0.minus(n(2000000)), globalRaw(), "global")
  })

  test("combo unwrap credit and resolution cap unchanged", () => {
    handleV2Mint(single(COMBO, ZERO, USER, binYes(), 3000000))
    eq(n(3000000), m(BIN).amountRaw, "unwrap credits 3")
    v2Resolve(BIN, 0, 1000000)
    eq(BigInt.zero(), m(BIN).amountRaw, "losing YES: resolution cap releases")
  })

  test("neg-risk: resolved V2 neg-risk settlement is never capped", () => {
    let ev = setupEvent(81, 2, 0)
    nrSplit(ev, 0, usdc(10))
    let v2 = nrV2(0)
    register(v2, ev.conds[0])
    ctfResolve(ev.conds[0], 1, 0)
    report(ev, 0, true)
    v2Resolve(v2, 1000000, 0)
    let g0 = globalRaw()
    ctfRedeem(ev.conds[0], WCOL, NR_MOD, 2000000)
    eq(n(2000000), m(v2).amountRaw, "neg-risk: credit kept (cap not applied to neg-risk)")
    eq(g0, globalRaw(), "global unchanged")
  })
})
