import { beforeEach, clearStore, describe, newMockEvent, test, assert } from "matchstick-as/assembly/index"
import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts"
import { TransferSingle } from "../generated/PositionManagerV2Mints/PositionManagerV2"
import {
  PositionsSplit,
  PositionsMerged,
  PositionRedeemed,
  ConditionResolved,
  BridgePositionMinted,
  BridgePositionsBurned,
} from "../generated/NegRiskModuleV2/ModuleV2"
import { MarketOpenInterest } from "../generated/schema"
import {
  handleV2Mint,
  handleV2Burn,
  handleV2Split,
  handleV2Merge,
  handleV2Redeem,
  handleV2ConditionResolved,
  handleV2BridgeMinted,
  handleV2BridgeBurned,
} from "../src/v2"
import { eq, globalRaw } from "./nr-helpers"

// Ellipra review of PR #9 (head 5e4d214): cap `amount` at what circulating tokens can
// still claim, and credit module mintFromBridge / burnFromBridge like combo unwrap / wrap.

const BIN_MOD = Address.fromString("0x1000008dd9001b968442c1000017eae6e0da00ba")
const NR_MOD = Address.fromString("0x200000900045e3b6259600682756002200028933")
const COMBO = Address.fromString("0x30000034706c7d8e12009dab006be20000c031a8")
const USER = Address.fromString("0xc82f0a25aad828f59347670e63ead5ea144466a7")
const ZERO = Address.zero()
// module 1 (binary) and module 2 (neg-risk) condition ids (32-byte form, outcome byte 0)
const CID = "0x01aa11bb22cc33dd44ee55ff6600770000000300000000000000000000000000"
const CID_NR = "0x02aa11bb22cc33dd44ee55ff6600770000000300000000000000000000000100"
const H = Bytes.fromHexString("0x00000000000000000000000000000000000000000000000000000000000000a1")

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
function p(nm: string, v: ethereum.Value): ethereum.EventParam { return new ethereum.EventParam(nm, v) }
function u(x: i64): ethereum.Value { return ethereum.Value.fromUnsignedBigInt(BigInt.fromI64(x)) }
function n(x: i64): BigInt { return BigInt.fromI64(x) }
function m(id: string): MarketOpenInterest { return MarketOpenInterest.load(id)! }
function addr(a: Address): ethereum.Value { return ethereum.Value.fromAddress(a) }

function mint(operator: Address, id: BigInt, amount: i64): void {
  let e = changetype<TransferSingle>(newMockEvent())
  e.transaction.hash = H
  e.parameters = [p("operator", addr(operator)), p("from", addr(ZERO)), p("to", addr(USER)),
    p("id", ethereum.Value.fromUnsignedBigInt(id)), p("amount", u(amount))]
  handleV2Mint(e)
}
function burn(operator: Address, id: BigInt, amount: i64): void {
  let e = changetype<TransferSingle>(newMockEvent())
  e.transaction.hash = H
  e.parameters = [p("operator", addr(operator)), p("from", addr(operator)), p("to", addr(ZERO)),
    p("id", ethereum.Value.fromUnsignedBigInt(id)), p("amount", u(amount))]
  handleV2Burn(e)
}
function modFor(cid: string): Address { return cid.charAt(3) == "2" ? NR_MOD : BIN_MOD }
// split / merge in on-chain order: PositionManager mints / burns, then the module event.
function fullSplit(cid: string, amount: i64): void {
  mint(modFor(cid), pid(cid, 0), amount)
  mint(modFor(cid), pid(cid, 1), amount)
  let e = changetype<PositionsSplit>(newMockEvent())
  e.address = modFor(cid)
  e.parameters = [p("initiator", addr(USER)), p("conditionId", ethereum.Value.fromFixedBytes(b31(cid))),
    p("recipient0", addr(USER)), p("recipient1", addr(USER)), p("amount", u(amount))]
  handleV2Split(e)
}
function fullMerge(cid: string, amount: i64): void {
  burn(modFor(cid), pid(cid, 0), amount)
  burn(modFor(cid), pid(cid, 1), amount)
  let e = changetype<PositionsMerged>(newMockEvent())
  e.address = modFor(cid)
  e.parameters = [p("initiator", addr(USER)), p("conditionId", ethereum.Value.fromFixedBytes(b31(cid))),
    p("recipient", addr(USER)), p("amount", u(amount))]
  handleV2Merge(e)
}
function resolve(cid: string, yes: i64, no: i64): void {
  let e = changetype<ConditionResolved>(newMockEvent())
  e.address = modFor(cid)
  e.parameters = [p("conditionId", ethereum.Value.fromFixedBytes(b31(cid))),
    p("result", ethereum.Value.fromUnsignedBigIntArray([n(yes), n(no)]))]
  handleV2ConditionResolved(e)
}
function redeem(cid: string, outcome: i32, amount: i64, payout: i64): void {
  burn(modFor(cid), pid(cid, outcome), amount)
  let e = changetype<PositionRedeemed>(newMockEvent())
  e.address = modFor(cid)
  e.parameters = [p("initiator", addr(USER)), p("positionId", ethereum.Value.fromUnsignedBigInt(pid(cid, outcome))),
    p("recipient", addr(USER)), p("amount", u(amount)), p("payout", u(payout))]
  handleV2Redeem(e)
}
// BaseModule.mintFromBridge: PositionManager.mint (operator = module), then BridgePositionMinted.
function bridgeIn(cid: string, outcome: i32, amount: i64): void {
  mint(modFor(cid), pid(cid, outcome), amount)
  let e = changetype<BridgePositionMinted>(newMockEvent())
  e.address = modFor(cid)
  e.parameters = [p("to", addr(USER)), p("positionId", ethereum.Value.fromUnsignedBigInt(pid(cid, outcome))),
    p("amount", u(amount))]
  handleV2BridgeMinted(e)
}
// BaseModule.burnFromBridge: PositionManager.batchBurn, then BridgePositionsBurned.
function bridgeOut(cid: string, yes: i64, no: i64): void {
  let ids: BigInt[] = []
  let amts: BigInt[] = []
  if (yes > 0) { burn(modFor(cid), pid(cid, 0), yes); ids.push(pid(cid, 0)); amts.push(n(yes)) }
  if (no > 0) { burn(modFor(cid), pid(cid, 1), no); ids.push(pid(cid, 1)); amts.push(n(no)) }
  let e = changetype<BridgePositionsBurned>(newMockEvent())
  e.address = modFor(cid)
  e.parameters = [p("positionIds", ethereum.Value.fromUnsignedBigIntArray(ids)),
    p("amounts", ethereum.Value.fromUnsignedBigIntArray(amts))]
  handleV2BridgeBurned(e)
}

describe("cap amount to what circulating tokens can claim (Ellipra §2)", () => {
  beforeEach(() => { clearStore() })

  test("split 10, unwrap YES 5, merge 10, wrap YES 5: amount 0 (was +5)", () => {
    fullSplit(CID, 10000000)
    mint(COMBO, pid(CID, 0), 5000000)
    fullMerge(CID, 10000000)
    burn(COMBO, pid(CID, 0), 5000000)
    eq(n(0), m(CID).yesSupplyRaw, "yes")
    eq(n(0), m(CID).noSupplyRaw, "no")
    eq(n(0), m(CID).amountRaw, "amount")
    eq(n(0), globalRaw(), "global")
  })

  test("unwrap YES, split, merge, unwrap NO, merge: amount 0", () => {
    mint(COMBO, pid(CID, 0), 5000000)
    fullSplit(CID, 10000000)
    fullMerge(CID, 10000000)
    mint(COMBO, pid(CID, 1), 5000000)
    fullMerge(CID, 5000000)
    eq(n(0), m(CID).amountRaw, "amount")
    eq(n(0), globalRaw(), "global")
  })

  test("unwrapped losing side is released at resolution", () => {
    mint(COMBO, pid(CID, 1), 5000000)
    eq(n(5000000), m(CID).amountRaw, "credited while open")
    resolve(CID, 1000000, 0)
    eq(n(0), m(CID).amountRaw, "amount")
    eq(n(0), globalRaw(), "global")
    assert.fieldEquals("MarketOpenInterest", CID, "resolved", "true")
  })

  test("plain split / partial merge / resolve / redeem is never capped", () => {
    fullSplit(CID, 10000000)
    fullMerge(CID, 4000000)
    eq(n(6000000), m(CID).amountRaw, "after merge")
    resolve(CID, 1000000, 0)
    eq(n(6000000), m(CID).amountRaw, "resolution keeps winning claims")
    redeem(CID, 0, 2000000, 2000000)
    eq(n(4000000), m(CID).amountRaw, "after partial redeem")
    redeem(CID, 0, 4000000, 4000000)
    eq(n(0), m(CID).amountRaw, "after full redeem")
    eq(n(0), globalRaw(), "global")
    assert.fieldEquals("MarketOpenInterest", CID, "splitCount", "1")
    assert.fieldEquals("MarketOpenInterest", CID, "mergeCount", "1")
    assert.fieldEquals("MarketOpenInterest", CID, "redemptionCount", "2")
  })

  test("50/50 resolution caps at half of each side", () => {
    mint(COMBO, pid(CID, 1), 6000000)
    resolve(CID, 500000, 500000)
    eq(n(3000000), m(CID).amountRaw, "NO 6 at 0.5 claims 3")
    eq(n(3000000), globalRaw(), "global")
  })

  test("cap never raises a negative amount", () => {
    fullSplit(CID, 10000000)
    // merge event without the matching burns (supplies stay 10): not capped, goes to 0
    let e = changetype<PositionsMerged>(newMockEvent())
    e.parameters = [p("initiator", addr(USER)), p("conditionId", ethereum.Value.fromFixedBytes(b31(CID))),
      p("recipient", addr(USER)), p("amount", u(12000000))]
    handleV2Merge(e)
    eq(n(-2000000), m(CID).amountRaw, "negative stays negative")
  })

  test("V2 neg-risk is not capped (per-market amount not conserved there)", () => {
    mint(COMBO, pid(CID_NR, 1), 5000000)
    resolve(CID_NR, 1000000, 0)
    eq(n(5000000), m(CID_NR).amountRaw, "neg-risk amount untouched by the cap")
  })
})

describe("mintFromBridge / burnFromBridge credit amount (Ellipra §4)", () => {
  beforeEach(() => { clearStore() })

  test("bridged-in YES + NO then merge: amount 0, not -5", () => {
    bridgeIn(CID, 0, 5000000)
    bridgeIn(CID, 1, 5000000)
    eq(n(5000000), m(CID).amountRaw, "complete set credited once")
    fullMerge(CID, 5000000)
    eq(n(0), m(CID).amountRaw, "amount")
    eq(n(0), globalRaw(), "global")
    assert.fieldEquals("MarketOpenInterest", CID, "splitCount", "0")
  })

  test("bridged-in YES pairs with split NO, merge leaves the bridged YES claim", () => {
    fullSplit(CID, 10000000)
    bridgeIn(CID, 0, 5000000)
    eq(n(15000000), m(CID).amountRaw, "split 10 + bridged YES 5")
    fullMerge(CID, 10000000)
    eq(n(5000000), m(CID).amountRaw, "YES 5 left")
    eq(n(5000000), m(CID).yesSupplyRaw, "yes")
    eq(n(0), m(CID).noSupplyRaw, "no")
  })

  test("bridged-in neg-risk set then merge: amount 0 on module 2", () => {
    bridgeIn(CID_NR, 0, 7000000)
    bridgeIn(CID_NR, 1, 7000000)
    fullMerge(CID_NR, 7000000)
    eq(n(0), m(CID_NR).amountRaw, "amount")
    eq(n(0), globalRaw(), "global")
  })

  test("bridging a split set out of Polygon releases its claim", () => {
    fullSplit(CID, 10000000)
    bridgeOut(CID, 10000000, 10000000)
    eq(n(0), m(CID).amountRaw, "amount")
    eq(n(0), globalRaw(), "global")
  })

  test("bridge out and back in round-trips to the original amount", () => {
    fullSplit(CID, 10000000)
    bridgeOut(CID, 4000000, 4000000)
    eq(n(6000000), m(CID).amountRaw, "after out")
    bridgeIn(CID, 0, 4000000)
    bridgeIn(CID, 1, 4000000)
    eq(n(10000000), m(CID).amountRaw, "after back in")
    fullMerge(CID, 10000000)
    eq(n(0), m(CID).amountRaw, "after merge")
    eq(n(0), globalRaw(), "global")
  })

  test("module 3 ids in a bridge burn are ignored", () => {
    fullSplit(CID, 10000000)
    let e = changetype<BridgePositionsBurned>(newMockEvent())
    let combo = BigInt.fromUnsignedBytes(changetype<Bytes>(Bytes.fromHexString(
      "0x0100000000000000000000000000000000000000000000000000000000000003")))
    e.parameters = [p("positionIds", ethereum.Value.fromUnsignedBigIntArray([combo])),
      p("amounts", ethereum.Value.fromUnsignedBigIntArray([n(5000000)]))]
    handleV2BridgeBurned(e)
    eq(n(10000000), m(CID).amountRaw, "unchanged")
  })
})
