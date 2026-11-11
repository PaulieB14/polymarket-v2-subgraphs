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
  PositionsSplit,
  PositionsMerged,
  PositionRedeemed,
  HorizontalSplit,
  RemainingConditionsDerivableAsNo,
  SyntheticConditionDerivableAsYes,
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
  handleV2BurnBatch,
  handleV2Split,
  handleV2Merge,
  handleV2Redeem,
  handleV2HorizontalSplit,
  handleV2ConditionResolved,
  handleV2RemainingNo,
  handleV2OtherYes,
  handleV2MigrationRegistered,
  handleV2PositionMigrated,
} from "../src/v2"
import { NrEvent, setupEvent, split as nrSplit, convert, report, redeemAmounts, usdc, raw, globalRaw, eq } from "./nr-helpers"

const USDC_E = Address.fromString("0x2791bca1f2de4661ed88a30c99a7a9449aa84174")
const WCOL = Address.fromString("0x3a3bd7bb9528e159577f7c2e685cc81a765002e2")
const NRA = Address.fromString("0xd91e80cf2e7be2e162c6513ced06f1dd0da35296")
const BIN_MOD = Address.fromString("0x1000008dd9001b968442c1000017eae6e0da00ba")
const NR_MOD = Address.fromString("0x200000900045e3b6259600682756002200028933")
const USER = Address.fromString("0x00000000000000000000000000000000000000aa")
const ZERO = Address.zero()
const ZERO32 = Bytes.fromHexString("0x0000000000000000000000000000000000000000000000000000000000000000")
const COND = Bytes.fromHexString("0xd391104c756f2371defe4daec7e7fa70470ed383c6be338037aab736bca61b19")
const CID = "0xd391104c756f2371defe4daec7e7fa70470ed383c6be338037aab736bca61b19"

// Gamma polyv2-nba-cle-nyk-2026-11-11: conditionId and clobTokenIds (verified on-chain:
// PositionManager mints of these ids sum to the data-api /v2/oi value, 37.022537).
const BIN = "0x017d1e01561c374925029c48d5249691ca000000000000000000000000000000"
const BIN_YES = BigInt.fromString("673375820099379269761014006244372837799090532969111081655717424084258127872")
const BIN_NO = BIN_YES.plus(BigInt.fromI32(1))
// Synthetic neg-risk event: module 2, arity 3 (bytes 17-18), conditions 0..2 + Other (3).
const NR_EVENT = "0x02aabbccddeeff00112233445566778899000300000000000000000000"
function nrCid(i: i32): string {
  let b = Bytes.fromHexString(NR_EVENT)
  let c = new Bytes(32)
  for (let k = 0; k < 29; k++) c[k] = b[k]
  c[30] = i as u8
  return c.toHexString()
}
function pid(cid: string, outcome: i32): BigInt {
  let be = Bytes.fromHexString(cid)
  let le = new Bytes(32) // module ids < 0x80: unsigned and exactly 32 bytes
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

function p(n: string, v: ethereum.Value): ethereum.EventParam { return new ethereum.EventParam(n, v) }
function u(n: i64): ethereum.Value { return ethereum.Value.fromUnsignedBigInt(BigInt.fromI64(n)) }
function ub(n: BigInt): ethereum.Value { return ethereum.Value.fromUnsignedBigInt(n) }
function arr(xs: i32[]): ethereum.Value {
  let out: BigInt[] = []
  for (let i = 0; i < xs.length; i++) out.push(BigInt.fromI32(xs[i]))
  return ethereum.Value.fromUnsignedBigIntArray(out)
}
function m(id: string): MarketOpenInterest { return MarketOpenInterest.load(id)! }
function ys(id: string): BigInt { return m(id).yesSupplyRaw }
function ns(id: string): BigInt { return m(id).noSupplyRaw }
function n(x: i64): BigInt { return BigInt.fromI64(x) }

function prepare(cond: Bytes, oracle: Address): void {
  let e = changetype<ConditionPreparation>(newMockEvent())
  e.parameters = [p("conditionId", ethereum.Value.fromFixedBytes(cond)), p("oracle", ethereum.Value.fromAddress(oracle)),
    p("questionId", ethereum.Value.fromFixedBytes(ZERO32)), p("outcomeSlotCount", u(2))]
  handleConditionPreparation(e)
}
// kind 0 = split, 1 = merge
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
function nrResolve(ev: NrEvent, q: i32, yes: boolean): void {
  ctfResolve(ev.conds[q], yes ? 1 : 0, yes ? 0 : 1)
  report(ev, q, yes)
}


function xfer(from: Address, to: Address, id: BigInt, amount: i64): TransferSingle {
  let e = changetype<TransferSingle>(newMockEvent())
  e.parameters = [p("operator", ethereum.Value.fromAddress(BIN_MOD)), p("from", ethereum.Value.fromAddress(from)),
    p("to", ethereum.Value.fromAddress(to)), p("id", ub(id)), p("amount", u(amount))]
  return e
}
function xferBatch(from: Address, to: Address, ids: BigInt[], amounts: BigInt[]): TransferBatch {
  let e = changetype<TransferBatch>(newMockEvent())
  e.parameters = [p("operator", ethereum.Value.fromAddress(BIN_MOD)), p("from", ethereum.Value.fromAddress(from)),
    p("to", ethereum.Value.fromAddress(to)), p("ids", ethereum.Value.fromUnsignedBigIntArray(ids)),
    p("amounts", ethereum.Value.fromUnsignedBigIntArray(amounts))]
  return e
}
function v2Split(cid: string, amount: i64): void {
  let e = changetype<PositionsSplit>(newMockEvent())
  e.parameters = [p("initiator", ethereum.Value.fromAddress(USER)), p("conditionId", ethereum.Value.fromFixedBytes(b31(cid))),
    p("recipient0", ethereum.Value.fromAddress(USER)), p("recipient1", ethereum.Value.fromAddress(USER)), p("amount", u(amount))]
  handleV2Split(e)
}
function v2Merge(cid: string, amount: i64): void {
  let e = changetype<PositionsMerged>(newMockEvent())
  e.parameters = [p("initiator", ethereum.Value.fromAddress(USER)), p("conditionId", ethereum.Value.fromFixedBytes(b31(cid))),
    p("recipient", ethereum.Value.fromAddress(USER)), p("amount", u(amount))]
  handleV2Merge(e)
}
function v2Redeem(id: BigInt, amount: i64, payout: i64): void {
  let e = changetype<PositionRedeemed>(newMockEvent())
  e.parameters = [p("initiator", ethereum.Value.fromAddress(USER)), p("positionId", ub(id)),
    p("recipient", ethereum.Value.fromAddress(USER)), p("amount", u(amount)), p("payout", u(payout))]
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
  e.parameters = [p("from", ethereum.Value.fromAddress(USER)), p("conditionId", ethereum.Value.fromFixedBytes(b31(v2))),
    p("positionId", ub(pid(v2, outcome))), p("outcomeIndex", u(outcome)), p("amount", u(amount))]
  handleV2PositionMigrated(e)
}

describe("direct WrappedCollateral CTF activity on neg-risk conditions (A.1)", () => {
  beforeEach(() => { clearStore() })

  test("direct WCOL split then adapter exit: NO back to 0, not negative ('-1533' pattern)", () => {
    let ev = setupEvent(74, 2, 0)
    nrSplit(ev, 0, usdc(10))
    ctfOp(0, ev.conds[0], WCOL, NRA, 10000000) // the adapter's own CTF mirror: ignored
    eq(usdc(10), ns(ev.cid(0)), "mirror ignored")
    let g0 = globalRaw()
    ctfOp(0, ev.conds[0], WCOL, USER, 7000000) // direct split, no adapter event
    eq(usdc(17), ys(ev.cid(0)), "yes +7")
    eq(usdc(17), ns(ev.cid(0)), "no +7")
    eq(g0.plus(n(7000000)), globalRaw(), "global +7")
    assert.fieldEquals("MarketOpenInterest", ev.cid(0), "splitCount", "2")
    nrResolve(ev, 0, false)
    redeemAmounts(ev, 0, BigInt.zero(), usdc(17), usdc(17))
    eq(BigInt.zero(), ns(ev.cid(0)), "no == 0 (was -7)")
    eq(BigInt.zero(), raw(ev, 0), "amount == 0")
  })

  test("direct WCOL merge and direct WCOL redemption lower supplies", () => {
    let ev = setupEvent(75, 2, 0)
    nrSplit(ev, 1, usdc(10))
    ctfOp(1, ev.conds[1], WCOL, USER, 4000000)
    eq(usdc(6), ys(ev.cid(1)), "yes")
    eq(usdc(6), ns(ev.cid(1)), "no")
    nrResolve(ev, 1, true) // NO pinned at 0
    ctfRedeem(ev.conds[1], WCOL, USER, 6000000)
    eq(BigInt.zero(), ys(ev.cid(1)), "yes redeemed exactly")
    eq(BigInt.zero(), raw(ev, 1), "amount 0")
    assert.fieldEquals("MarketOpenInterest", ev.cid(1), "redemptionCount", "1")
  })

  test("adapter's own WCOL redemption on the CTF is ignored", () => {
    let ev = setupEvent(76, 2, 0)
    nrSplit(ev, 0, usdc(10))
    nrResolve(ev, 0, true)
    ctfRedeem(ev.conds[0], WCOL, NRA, 10000000)
    eq(usdc(10), ys(ev.cid(0)), "unchanged")
    assert.fieldEquals("MarketOpenInterest", ev.cid(0), "redemptionCount", "0")
  })

  test("WCOL on a regular (non-adapter) condition is ignored", () => {
    prepare(COND, USER)
    ctfOp(0, COND, WCOL, USER, 5000000)
    assert.notInStore("MarketOpenInterest", CID)
  })
})

describe("adapter redemption sweeping stray WCOL (A.5)", () => {
  beforeEach(() => { clearStore() })

  test("amounts [0,0] with payout > 0: amount and global unchanged", () => {
    let ev = setupEvent(77, 2, 0)
    nrSplit(ev, 0, usdc(10))
    nrResolve(ev, 0, false)
    let a0 = raw(ev, 0)
    let g0 = globalRaw()
    redeemAmounts(ev, 0, BigInt.zero(), BigInt.zero(), n(816840507)) // tx 0x24bbad6a…4cdc
    eq(a0, raw(ev, 0), "amount unchanged")
    eq(g0, globalRaw(), "global unchanged")
    assert.fieldEquals("MarketOpenInterest", ev.cid(0), "redemptionCount", "1")
  })

  test("payout above the burned value is capped; normal payout untouched", () => {
    let ev = setupEvent(78, 2, 0)
    nrSplit(ev, 0, usdc(10))
    nrResolve(ev, 0, true)
    redeemAmounts(ev, 0, usdc(4), BigInt.zero(), usdc(4))
    eq(usdc(6), raw(ev, 0), "normal")
    redeemAmounts(ev, 0, usdc(1), BigInt.zero(), usdc(3)) // $2 swept on top
    eq(usdc(5), raw(ev, 0), "capped at 1")
  })
})

describe("rules behind validation fixes A.3 / A.4 (A.6)", () => {
  beforeEach(() => { clearStore() })

  test("stray USDC.e split counts in amount and splitCount, never in supplies (issue 4 pattern)", () => {
    let ev = setupEvent(63, 2, 0)
    nrSplit(ev, 0, usdc(10))
    ctfOp(0, ev.conds[0], USDC_E, USER, 1660000)
    eq(usdc(10), ys(ev.cid(0)), "yes = adapter only")
    eq(usdc(10), ns(ev.cid(0)), "no = adapter only")
    assert.fieldEquals("MarketOpenInterest", ev.cid(0), "splitCount", "2")
    eq(n(11660000), raw(ev, 0), "amount = adapter + stray")
  })

  test("post-report complement conversion: converted NO goes to the burn address", () => {
    let ev = setupEvent(64, 3, 0)
    for (let i = 0; i < 3; i++) nrSplit(ev, i, usdc(10))
    nrResolve(ev, 1, false)
    convert(ev, BigInt.fromI32(0x1), usdc(5))
    eq(usdc(5), ns(ev.cid(0)), "converted q0 NO burned (10 - 5)")
    eq(usdc(10), ns(ev.cid(1)), "complement q1 NO supply unchanged")
  })
})

describe("Polymarket V2 PositionManager markets (A.2)", () => {
  beforeEach(() => { clearStore() })

  test("binary mint/burn tracks YES/NO under the Gamma conditionId", () => {
    handleV2Mint(xfer(ZERO, USER, BIN_YES, 18816311))
    handleV2Mint(xfer(ZERO, USER, BIN_NO, 18816311))
    assert.fieldEquals("MarketOpenInterest", BIN, "yesSupplyRaw", "18816311")
    assert.fieldEquals("MarketOpenInterest", BIN, "noSupplyRaw", "18816311")
    assert.fieldEquals("MarketOpenInterest", BIN, "negRisk", "false")
    assert.fieldEquals("MarketOpenInterest", BIN, "collateralToken", "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb")
    assert.fieldEquals("GlobalOpenInterest", "global", "marketCount", "1")
    handleV2Burn(xfer(BIN_MOD, ZERO, BIN_NO, 5000000))
    assert.fieldEquals("MarketOpenInterest", BIN, "noSupplyRaw", "13816311")
  })

  test("id encoding helper matches the Gamma clobTokenIds", () => {
    eq(BIN_YES, pid(BIN, 0), "yes id")
    eq(BIN_NO, pid(BIN, 1), "no id")
  })

  test("transfers that are not mints/burns are ignored even without topic filters", () => {
    handleV2Mint(xfer(USER, BIN_MOD, BIN_YES, 1000000))
    handleV2Burn(xfer(USER, BIN_MOD, BIN_YES, 1000000))
    assert.entityCount("MarketOpenInterest", 0)
  })

  test("batch mint / burn", () => {
    handleV2MintBatch(xferBatch(ZERO, USER, [BIN_YES, BIN_NO], [n(3000000), n(2000000)]))
    handleV2BurnBatch(xferBatch(BIN_MOD, ZERO, [BIN_YES], [n(1000000)]))
    assert.fieldEquals("MarketOpenInterest", BIN, "yesSupplyRaw", "2000000")
    assert.fieldEquals("MarketOpenInterest", BIN, "noSupplyRaw", "2000000")
  })

  test("combinatorial positions (moduleId 3) are ignored", () => {
    let combo = BIN_YES.plus(BigInt.fromI32(2).leftShift(248)) // top byte 1 -> 3
    handleV2Mint(xfer(ZERO, USER, combo, 1000000))
    assert.entityCount("MarketOpenInterest", 0)
  })

  test("split / merge / redeem move amount and global; resolution pins the loser", () => {
    let g0 = globalRaw()
    v2Split(BIN, 10000000)
    handleV2Mint(xfer(ZERO, USER, BIN_YES, 10000000))
    handleV2Mint(xfer(ZERO, USER, BIN_NO, 10000000))
    v2Merge(BIN, 2000000)
    handleV2Burn(xfer(BIN_MOD, ZERO, BIN_YES, 2000000))
    handleV2Burn(xfer(BIN_MOD, ZERO, BIN_NO, 2000000))
    eq(n(8000000), m(BIN).amountRaw, "amount")
    eq(g0.plus(n(8000000)), globalRaw(), "global")
    v2Resolve(BIN, 1000000, 0)
    assert.fieldEquals("MarketOpenInterest", BIN, "resolved", "true")
    eq(BigInt.zero(), ns(BIN), "losing NO pinned")
    v2Redeem(BIN_YES, 8000000, 8000000)
    handleV2Burn(xfer(BIN_MOD, ZERO, BIN_YES, 8000000))
    eq(BigInt.zero(), m(BIN).amountRaw, "amount 0")
    eq(BigInt.zero(), ys(BIN), "yes 0")
    eq(g0, globalRaw(), "global back")
  })

  test("horizontal split moves global only", () => {
    let g0 = globalRaw()
    let e = changetype<HorizontalSplit>(newMockEvent())
    e.parameters = [p("initiator", ethereum.Value.fromAddress(USER)), p("eventId", ethereum.Value.fromFixedBytes(Bytes.fromHexString(NR_EVENT))),
      p("recipient", ethereum.Value.fromAddress(USER)), p("amount", u(5000000))]
    handleV2HorizontalSplit(e)
    eq(g0.plus(n(5000000)), globalRaw(), "global +5")
    assert.entityCount("MarketOpenInterest", 0)
  })

  test("neg-risk YES at index 1 derives NO on every sibling and on Other", () => {
    handleV2Mint(xfer(ZERO, USER, pid(nrCid(1), 0), 5000000))
    handleV2Mint(xfer(ZERO, USER, pid(nrCid(2), 1), 3000000))
    assert.fieldEquals("MarketOpenInterest", nrCid(1), "negRisk", "true")
    v2Resolve(nrCid(1), 1000000, 0)
    let d = changetype<RemainingConditionsDerivableAsNo>(newMockEvent())
    d.parameters = [p("eventId", ethereum.Value.fromFixedBytes(Bytes.fromHexString(NR_EVENT)))]
    handleV2RemainingNo(d)
    assert.fieldEquals("ConditionPayout", nrCid(1), "payoutNumerators", "[1000000, 0]")
    assert.fieldEquals("ConditionPayout", nrCid(0), "payoutNumerators", "[0, 1000000]")
    assert.fieldEquals("ConditionPayout", nrCid(3), "payoutNumerators", "[0, 1000000]")
    assert.entityCount("ConditionPayout", 4) // 3 real + Other
    assert.fieldEquals("MarketOpenInterest", nrCid(1), "resolved", "true")
    assert.fieldEquals("MarketOpenInterest", nrCid(2), "resolved", "true")
    assert.fieldEquals("MarketOpenInterest", nrCid(2), "noSupplyRaw", "3000000")
  })

  test("all real NO: synthetic Other derives YES", () => {
    let e = changetype<SyntheticConditionDerivableAsYes>(newMockEvent())
    e.parameters = [p("eventId", ethereum.Value.fromFixedBytes(Bytes.fromHexString(NR_EVENT))),
      p("conditionId", ethereum.Value.fromFixedBytes(b31(nrCid(3))))]
    handleV2OtherYes(e)
    assert.fieldEquals("ConditionPayout", nrCid(3), "payoutNumerators", "[1000000, 0]")
  })

  test("market first minted after resolution starts resolved", () => {
    v2Resolve(BIN, 0, 1000000)
    handleV2Mint(xfer(ZERO, USER, BIN_YES, 1000000))
    handleV2Mint(xfer(ZERO, USER, BIN_NO, 1000000))
    assert.fieldEquals("MarketOpenInterest", BIN, "resolved", "true")
    eq(BigInt.zero(), ys(BIN), "losing YES pinned")
    eq(n(1000000), ns(BIN), "winning NO")
  })
})

describe("V2 migration of legacy positions", () => {
  beforeEach(() => { clearStore() })

  test("binary: escrowed legacy tokens leave legacy supplies; module merge moves collateral to V2, global unchanged", () => {
    prepare(COND, USER)
    ctfOp(0, COND, USDC_E, USER, 10000000) // legacy market: 10 / 10
    register(BIN, COND)
    let g0 = globalRaw()
    // user A migrates 4 YES: V2 mint, no merge yet
    handleV2MintBatch(xferBatch(ZERO, USER, [BIN_YES], [n(4000000)]))
    migrated(BIN_MOD, BIN, 0, 4000000)
    eq(n(6000000), ys(CID), "legacy yes 10 - 4")
    eq(n(10000000), ns(CID), "legacy no")
    eq(n(4000000), ys(BIN), "v2 yes")
    eq(g0, globalRaw(), "global unchanged")
    // user B migrates 3 NO: module now holds 4 YES + 3 NO and merges 3 on the CTF
    handleV2MintBatch(xferBatch(ZERO, USER, [BIN_NO], [n(3000000)]))
    ctfOp(1, COND, USDC_E, BIN_MOD, 3000000)
    migrated(BIN_MOD, BIN, 1, 3000000)
    eq(n(6000000), ys(CID), "legacy yes unchanged by the module merge")
    eq(n(7000000), ns(CID), "legacy no 10 - 3")
    eq(n(7000000), m(CID).amountRaw, "legacy amount 10 - 3")
    eq(n(3000000), m(BIN).amountRaw, "v2 amount +3")
    eq(g0, globalRaw(), "global unchanged")
    assert.fieldEquals("MarketOpenInterest", CID, "mergeCount", "1")
  })

  test("binary: module redemption of resolved legacy moves the payout to V2", () => {
    prepare(COND, USER)
    ctfOp(0, COND, USDC_E, USER, 10000000)
    register(BIN, COND)
    ctfResolve(COND, 1, 0)
    v2Resolve(BIN, 1000000, 0)
    let g0 = globalRaw()
    handleV2MintBatch(xferBatch(ZERO, USER, [BIN_YES], [n(4000000)]))
    ctfRedeem(COND, USDC_E, BIN_MOD, 4000000)
    migrated(BIN_MOD, BIN, 0, 4000000)
    eq(n(6000000), ys(CID), "legacy yes 10 - 4 (escrowed), not burned twice")
    eq(n(6000000), m(CID).amountRaw, "legacy amount")
    eq(n(4000000), m(BIN).amountRaw, "v2 amount")
    eq(g0, globalRaw(), "global unchanged")
    v2Redeem(BIN_YES, 4000000, 4000000)
    eq(BigInt.zero(), m(BIN).amountRaw, "v2 redeemed")
    eq(g0.minus(n(4000000)), globalRaw(), "global -4 on V2 exit")
  })

  test("neg-risk: NegRiskModule WCOL merge is a migration settlement, not an A.1 exit", () => {
    let ev = setupEvent(79, 2, 0)
    nrSplit(ev, 0, usdc(10))
    let v2 = nrCid(0)
    register(v2, ev.conds[0])
    let g0 = globalRaw()
    handleV2MintBatch(xferBatch(ZERO, USER, [pid(v2, 0), pid(v2, 1)], [n(2000000), n(2000000)]))
    ctfOp(1, ev.conds[0], WCOL, NR_MOD, 2000000)
    migrated(NR_MOD, v2, 0, 2000000)
    migrated(NR_MOD, v2, 1, 2000000)
    eq(usdc(8), ys(ev.cid(0)), "legacy yes")
    eq(usdc(8), ns(ev.cid(0)), "legacy no")
    eq(usdc(8), raw(ev, 0), "legacy amount")
    eq(n(2000000), m(v2).amountRaw, "v2 amount")
    eq(g0, globalRaw(), "global unchanged")
  })

  test("module CTF op on a condition with no migration link falls back to the normal path", () => {
    prepare(COND, USER)
    ctfOp(0, COND, USDC_E, USER, 10000000)
    ctfOp(1, COND, USDC_E, BIN_MOD, 1000000)
    eq(n(9000000), ys(CID), "normal merge")
    eq(n(9000000), m(CID).amountRaw, "amount")
  })
})
