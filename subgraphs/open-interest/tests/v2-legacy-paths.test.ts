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
  PositionsSplit,
  PositionsMerged,
  PositionRedeemed,
  HorizontalMerge,
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
  handleV2HorizontalMerge,
} from "../src/v2"
import { NrEvent, setupEvent, split as nrSplit, convert, report, redeemAmounts, usdc, raw, globalRaw, eq } from "./nr-helpers"

const USDC_E = Address.fromString("0x2791bca1f2de4661ed88a30c99a7a9449aa84174")
const WCOL = Address.fromString("0x3a3bd7bb9528e159577f7c2e685cc81a765002e2")
const BIN_MOD = Address.fromString("0x1000008dd9001b968442c1000017eae6e0da00ba")
const NR_MOD = Address.fromString("0x200000900045e3b6259600682756002200028933")
const COMBO = Address.fromString("0x30000034706c7d8e12009dab006be20000c031a8")
const USER = Address.fromString("0xc82f0a25aad828f59347670e63ead5ea144466a7")
const ZERO = Address.zero()
const ZERO32 = Bytes.fromHexString("0x0000000000000000000000000000000000000000000000000000000000000000")
const COND = Bytes.fromHexString("0xd391104c756f2371defe4daec7e7fa70470ed383c6be338037aab736bca61b19")
const CID = "0xd391104c756f2371defe4daec7e7fa70470ed383c6be338037aab736bca61b19"

// Real V2 condition ids / txs from the v0.0.9 negative-amount investigation.
const CID_02283 = "0x02283c1f0efd13fd95a87ce05952727100000300000000000000000000000000"
const TX_02283 = Bytes.fromHexString("0x0c1d7c641eba138578999559a9dc5618f3af9239616949ed52c2175190c7471f")
const CID_01B9 = "0x01b927b8d163079155f37e7f5c5d9261ba000000000000000000000000000000"
const TX_01B9 = Bytes.fromHexString("0xd8fb9200db598d711b4f746c9ae4893e9e7c91927405c6204f6ba39c7eb447a3")
const AMT_510: i64 = 510442867
const BIN = "0x017d1e01561c374925029c48d5249691ca000000000000000000000000000000"

function p(name: string, v: ethereum.Value): ethereum.EventParam { return new ethereum.EventParam(name, v) }
function u(n: i64): ethereum.Value { return ethereum.Value.fromUnsignedBigInt(BigInt.fromI64(n)) }
function ub(n: BigInt): ethereum.Value { return ethereum.Value.fromUnsignedBigInt(n) }
function arr(xs: i32[]): ethereum.Value {
  let out: BigInt[] = []
  for (let i = 0; i < xs.length; i++) out.push(BigInt.fromI32(xs[i]))
  return ethereum.Value.fromUnsignedBigIntArray(out)
}
function n(x: i64): BigInt { return BigInt.fromI64(x) }
function mkt(id: string): MarketOpenInterest { return MarketOpenInterest.load(id)! }

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

function prepare(cond: Bytes): void {
  let e = changetype<ConditionPreparation>(newMockEvent())
  e.parameters = [
    p("conditionId", ethereum.Value.fromFixedBytes(cond)),
    p("oracle", ethereum.Value.fromAddress(USER)),
    p("questionId", ethereum.Value.fromFixedBytes(ZERO32)),
    p("outcomeSlotCount", u(2)),
  ]
  handleConditionPreparation(e)
}
function ctfSplit(col: Address, parent: Bytes, cond: Bytes, amount: i64, stakeholder: Address = USER): void {
  let e = changetype<PositionSplit>(newMockEvent())
  e.parameters = [
    p("stakeholder", ethereum.Value.fromAddress(stakeholder)),
    p("collateralToken", ethereum.Value.fromAddress(col)),
    p("parentCollectionId", ethereum.Value.fromFixedBytes(parent)),
    p("conditionId", ethereum.Value.fromFixedBytes(cond)),
    p("partition", arr([1, 2])),
    p("amount", u(amount)),
  ]
  handlePositionSplit(e)
}
function ctfMerge(col: Address, cond: Bytes, amount: i64, stakeholder: Address = USER): void {
  let e = changetype<PositionsMerge>(newMockEvent())
  e.parameters = [
    p("stakeholder", ethereum.Value.fromAddress(stakeholder)),
    p("collateralToken", ethereum.Value.fromAddress(col)),
    p("parentCollectionId", ethereum.Value.fromFixedBytes(ZERO32)),
    p("conditionId", ethereum.Value.fromFixedBytes(cond)),
    p("partition", arr([1, 2])),
    p("amount", u(amount)),
  ]
  handlePositionsMerge(e)
}
function ctfRedeem(col: Address, cond: Bytes, payout: i64, redeemer: Address = USER): void {
  let e = changetype<PayoutRedemption>(newMockEvent())
  e.parameters = [
    p("redeemer", ethereum.Value.fromAddress(redeemer)),
    p("collateralToken", ethereum.Value.fromAddress(col)),
    p("parentCollectionId", ethereum.Value.fromFixedBytes(ZERO32)),
    p("conditionId", ethereum.Value.fromFixedBytes(cond)),
    p("indexSets", arr([1, 2])),
    p("payout", u(payout)),
  ]
  handlePayoutRedemption(e)
}
function ctfResolve(cond: Bytes, yes: i32, no: i32): void {
  let e = changetype<ConditionResolution>(newMockEvent())
  e.parameters = [
    p("conditionId", ethereum.Value.fromFixedBytes(cond)),
    p("oracle", ethereum.Value.fromAddress(USER)),
    p("questionId", ethereum.Value.fromFixedBytes(ZERO32)),
    p("outcomeSlotCount", u(2)),
    p("payoutNumerators", arr([yes, no])),
  ]
  handleConditionResolution(e)
}

function mint(operator: Address, id: BigInt, amount: i64, hash: Bytes): void {
  let e = changetype<TransferSingle>(newMockEvent())
  e.transaction.hash = hash
  e.parameters = [
    p("operator", ethereum.Value.fromAddress(operator)),
    p("from", ethereum.Value.fromAddress(ZERO)),
    p("to", ethereum.Value.fromAddress(USER)),
    p("id", ub(id)),
    p("amount", u(amount)),
  ]
  handleV2Mint(e)
}
function burn(operator: Address, id: BigInt, amount: i64, hash: Bytes): void {
  let e = changetype<TransferSingle>(newMockEvent())
  e.transaction.hash = hash
  e.parameters = [
    p("operator", ethereum.Value.fromAddress(operator)),
    p("from", ethereum.Value.fromAddress(operator)),
    p("to", ethereum.Value.fromAddress(ZERO)),
    p("id", ub(id)),
    p("amount", u(amount)),
  ]
  handleV2Burn(e)
}
function v2Merge(cid: string, amount: i64, hash: Bytes): void {
  let e = changetype<PositionsMerged>(newMockEvent())
  e.transaction.hash = hash
  e.parameters = [
    p("initiator", ethereum.Value.fromAddress(USER)),
    p("conditionId", ethereum.Value.fromFixedBytes(b31(cid))),
    p("recipient", ethereum.Value.fromAddress(USER)),
    p("amount", u(amount)),
  ]
  handleV2Merge(e)
}
function v2Split(cid: string, amount: i64, hash: Bytes): void {
  let e = changetype<PositionsSplit>(newMockEvent())
  e.parameters = [
    p("initiator", ethereum.Value.fromAddress(USER)),
    p("conditionId", ethereum.Value.fromFixedBytes(b31(cid))),
    p("recipient0", ethereum.Value.fromAddress(USER)),
    p("recipient1", ethereum.Value.fromAddress(USER)),
    p("amount", u(amount)),
  ]
  e.transaction.hash = hash
  handleV2Split(e)
}
function nrResolve(ev: NrEvent, q: i32, yes: boolean): void {
  ctfResolve(ev.conds[q], yes ? 1 : 0, yes ? 0 : 1)
  report(ev, q, yes)
}

function v2Redeem(positionId: BigInt, payout: i64): void {
  let e = changetype<PositionRedeemed>(newMockEvent())
  e.parameters = [
    p("initiator", ethereum.Value.fromAddress(USER)),
    p("positionId", ub(positionId)),
    p("recipient", ethereum.Value.fromAddress(USER)),
    p("amount", u(payout)),
    p("payout", u(payout)),
  ]
  handleV2Redeem(e)
}

describe("legacy CTF split / merge / redeem", () => {
  beforeEach(() => { clearStore(); prepare(COND) })

  test("split then merge then redeem nets amount and global", () => {
    ctfSplit(USDC_E, ZERO32, COND, 100000000)
    ctfMerge(USDC_E, COND, 25000000)
    ctfResolve(COND, 1, 0)
    ctfRedeem(USDC_E, COND, 14999474) // real payout shape from tx 0x24bb2f2b…
    eq(n(60000526), mkt(CID).amountRaw, "100 - 25 - 14.999474")
    eq(n(60000526), globalRaw(), "global")
    assert.fieldEquals("MarketOpenInterest", CID, "splitCount", "1")
    assert.fieldEquals("MarketOpenInterest", CID, "mergeCount", "1")
    assert.fieldEquals("MarketOpenInterest", CID, "redemptionCount", "1")
  })

  test("zero-amount split does not create a market", () => {
    ctfSplit(USDC_E, ZERO32, COND, 0)
    assert.entityCount("MarketOpenInterest", 0)
    eq(n(0), globalRaw(), "global 0")
  })

  test("zero-amount merge on an existing legacy market bumps mergeCount only", () => {
    ctfSplit(USDC_E, ZERO32, COND, 5000000)
    ctfMerge(USDC_E, COND, 0)
    eq(n(5000000), mkt(CID).amountRaw, "unchanged")
    assert.fieldEquals("MarketOpenInterest", CID, "mergeCount", "1")
  })

  test("two splits and two merges in one logical flow accumulate", () => {
    ctfSplit(USDC_E, ZERO32, COND, 8000000)
    ctfSplit(USDC_E, ZERO32, COND, 2000000)
    ctfMerge(USDC_E, COND, 1000000)
    ctfMerge(USDC_E, COND, 3000000)
    eq(n(6000000), mkt(CID).amountRaw, "8+2-1-3")
    assert.fieldEquals("MarketOpenInterest", CID, "splitCount", "2")
    assert.fieldEquals("MarketOpenInterest", CID, "mergeCount", "2")
  })

  test("nested parentCollectionId split is ignored; root split still counts", () => {
    let parent = Bytes.fromHexString("0x1111111111111111111111111111111111111111111111111111111111111111")
    ctfSplit(USDC_E, parent, COND, 4000000)
    ctfSplit(USDC_E, ZERO32, COND, 2000000)
    eq(n(2000000), mkt(CID).amountRaw, "only root")
  })
})

describe("direct WCOL and A.5 sweep cap", () => {
  beforeEach(() => { clearStore() })

  test("direct WCOL split on a neg-risk condition adds amount and supplies", () => {
    let ev = setupEvent(80, 2, 0)
    ctfSplit(WCOL, ZERO32, ev.conds[0], 7000000)
    eq(n(7000000), raw(ev, 0), "amount")
    assert.fieldEquals("MarketOpenInterest", ev.cid(0), "yesSupplyRaw", "7000000")
    assert.fieldEquals("MarketOpenInterest", ev.cid(0), "noSupplyRaw", "7000000")
    assert.fieldEquals("MarketOpenInterest", ev.cid(0), "splitCount", "1")
  })

  test("direct WCOL merge after a direct split returns amount to 0", () => {
    let ev = setupEvent(81, 2, 0)
    ctfSplit(WCOL, ZERO32, ev.conds[0], 7000000)
    ctfMerge(WCOL, ev.conds[0], 7000000)
    eq(n(0), raw(ev, 0), "amount 0")
    assert.fieldEquals("MarketOpenInterest", ev.cid(0), "yesSupplyRaw", "0")
    assert.fieldEquals("MarketOpenInterest", ev.cid(0), "noSupplyRaw", "0")
  })

  test("A.5: payout exactly equal to burned value is not capped further", () => {
    let ev = setupEvent(82, 2, 0)
    nrSplit(ev, 0, usdc(10))
    report(ev, 0, true)
    redeemAmounts(ev, 0, usdc(4), BigInt.zero(), usdc(4))
    eq(usdc(6), raw(ev, 0), "paid == burned value")
  })

  test("A.5: amounts [0,0] payout is ignored even after a prior normal redeem", () => {
    let ev = setupEvent(83, 2, 0)
    nrSplit(ev, 0, usdc(10))
    nrResolve(ev, 0, true)
    redeemAmounts(ev, 0, usdc(2), BigInt.zero(), usdc(2))
    let a0 = raw(ev, 0)
    redeemAmounts(ev, 0, BigInt.zero(), BigInt.zero(), n(816840507)) // tx 0x24bbad6a…4cdc shape
    eq(a0, raw(ev, 0), "sweep does not move amount")
    assert.fieldEquals("MarketOpenInterest", ev.cid(0), "redemptionCount", "2")
  })

  test("A.5: payout above burned YES+NO value is capped on a [1,1] resolution", () => {
    let ev = setupEvent(84, 2, 0)
    nrSplit(ev, 0, usdc(10))
    nrResolve(ev, 0, true) // YES wins: burned value is the YES amount
    redeemAmounts(ev, 0, usdc(3), BigInt.zero(), usdc(9))
    eq(usdc(7), raw(ev, 0), "capped at burned value 3, leftover 7")
  })

  test("neg-risk convert of one NO credits the complement and leaves global unchanged", () => {
    let ev = setupEvent(85, 2, 0)
    nrSplit(ev, 0, usdc(10))
    nrSplit(ev, 1, usdc(10))
    let g0 = globalRaw()
    convert(ev, BigInt.fromI32(0x1), usdc(4))
    eq(usdc(6), raw(ev, 0), "q0 debited")
    eq(usdc(14), raw(ev, 1), "q1 credited")
    eq(g0, globalRaw(), "global unchanged for single-NO convert")
  })
})

describe("V2 split / merge / redeem / unwrap paths", () => {
  beforeEach(() => { clearStore() })

  test("tx 0x0c1d7c64…471f: migrate YES + combo NO $1,000 then merge nets to 0", () => {
    // On-chain: NegRiskModule minted YES (no amount credit), CombinatorialModule minted $1,000 NO, then merge $1,000.
    mint(NR_MOD, pid(CID_02283, 0), 1000000000, TX_02283)
    mint(COMBO, pid(CID_02283, 1), 1000000000, TX_02283)
    burn(NR_MOD, pid(CID_02283, 0), 1000000000, TX_02283)
    burn(NR_MOD, pid(CID_02283, 1), 1000000000, TX_02283)
    v2Merge(CID_02283, 1000000000, TX_02283)
    eq(n(0), mkt(CID_02283).amountRaw, "nets to 0")
    eq(n(0), globalRaw(), "global 0")
    assert.fieldEquals("MarketOpenInterest", CID_02283, "negRisk", "true")
  })

  test("tx 0xd8fb9200…47a3: binary both-sides unwrap $510.442867 then merge nets to 0", () => {
    mint(COMBO, pid(CID_01B9, 0), AMT_510, TX_01B9)
    mint(COMBO, pid(CID_01B9, 1), AMT_510, TX_01B9)
    burn(BIN_MOD, pid(CID_01B9, 0), AMT_510, TX_01B9)
    burn(BIN_MOD, pid(CID_01B9, 1), AMT_510, TX_01B9)
    v2Merge(CID_01B9, AMT_510, TX_01B9)
    eq(n(0), mkt(CID_01B9).amountRaw, "nets to 0")
    eq(n(0), globalRaw(), "global 0")
    assert.fieldEquals("MarketOpenInterest", CID_01B9, "negRisk", "false")
  })

  test("zero-amount V2 split does not create a market", () => {
    v2Split(BIN, 0, TX_01B9)
    assert.entityCount("MarketOpenInterest", 0)
  })

  test("V2 split then merge then redeem returns amount and global to 0", () => {
    const hash = TX_01B9
    v2Split(BIN, 8000000, hash)
    mint(BIN_MOD, pid(BIN, 0), 8000000, hash)
    mint(BIN_MOD, pid(BIN, 1), 8000000, hash)
    v2Merge(BIN, 2000000, hash)
    burn(BIN_MOD, pid(BIN, 0), 2000000, hash)
    burn(BIN_MOD, pid(BIN, 1), 2000000, hash)
    eq(n(6000000), mkt(BIN).amountRaw, "after merge")
    v2Redeem(pid(BIN, 0), 6000000)
    burn(BIN_MOD, pid(BIN, 0), 6000000, hash)
    eq(n(0), mkt(BIN).amountRaw, "redeemed")
    eq(n(0), globalRaw(), "global 0")
    assert.fieldEquals("MarketOpenInterest", BIN, "redemptionCount", "1")
  })

  test("normal V2 split plus a later combo unwrap of the leftover complement does not double-count the split", () => {
    const hash1 = Bytes.fromHexString("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
    const hash2 = Bytes.fromHexString("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
    v2Split(BIN, 5000000, hash1)
    mint(BIN_MOD, pid(BIN, 0), 5000000, hash1)
    mint(BIN_MOD, pid(BIN, 1), 5000000, hash1)
    mint(COMBO, pid(BIN, 0), 2000000, hash2)
    eq(n(7000000), mkt(BIN).amountRaw, "split 5 + combo leftover 2")
    eq(n(7000000), mkt(BIN).yesSupplyRaw, "yes 7")
    eq(n(5000000), mkt(BIN).noSupplyRaw, "no 5")
  })

  test("uneven unwrap then merge of the smaller side leaves max-min leftover", () => {
    const hash = TX_02283
    mint(COMBO, pid(CID_02283, 0), 5000000, hash)
    mint(COMBO, pid(CID_02283, 1), 2000000, hash)
    burn(NR_MOD, pid(CID_02283, 0), 2000000, hash)
    burn(NR_MOD, pid(CID_02283, 1), 2000000, hash)
    v2Merge(CID_02283, 2000000, hash)
    eq(n(3000000), mkt(CID_02283).amountRaw, "max(5,2)-2 = 3")
    eq(n(3000000), mkt(CID_02283).yesSupplyRaw, "yes leftover")
    eq(n(0), mkt(CID_02283).noSupplyRaw, "no 0")
  })

  test("TransferBatch combo wrap (burn) of both sides debits amount once", () => {
    const cid = CID_01B9
    const hash = TX_01B9
    mint(COMBO, pid(cid, 0), AMT_510, hash)
    mint(COMBO, pid(cid, 1), AMT_510, hash)
    let e = changetype<TransferBatch>(newMockEvent())
    e.transaction.hash = hash
    e.parameters = [
      p("operator", ethereum.Value.fromAddress(COMBO)),
      p("from", ethereum.Value.fromAddress(COMBO)),
      p("to", ethereum.Value.fromAddress(ZERO)),
      p("ids", ethereum.Value.fromUnsignedBigIntArray([pid(cid, 0), pid(cid, 1)])),
      p("amounts", ethereum.Value.fromUnsignedBigIntArray([n(AMT_510), n(AMT_510)])),
    ]
    handleV2BurnBatch(e)
    eq(n(0), mkt(cid).amountRaw, "batch wrap debits once")
    eq(n(0), globalRaw(), "global 0")
  })

  test("one-sided combo wrap burns only that side's credit", () => {
    const cid = CID_01B9
    const hash = TX_01B9
    mint(COMBO, pid(cid, 0), 4000000, hash)
    burn(COMBO, pid(cid, 0), 4000000, hash)
    eq(n(0), mkt(cid).amountRaw, "wrap YES only")
    eq(n(0), mkt(cid).yesSupplyRaw, "yes 0")
  })

  test("horizontal merge lowers only global", () => {
    v2Split(BIN, 5000000, TX_01B9)
    let g0 = globalRaw()
    let e = changetype<HorizontalMerge>(newMockEvent())
    e.parameters = [
      p("initiator", ethereum.Value.fromAddress(USER)),
      p("eventId", ethereum.Value.fromFixedBytes(Bytes.fromHexString("0x02aabbccddeeff00112233445566778899000300000000000000000000"))),
      p("recipient", ethereum.Value.fromAddress(USER)),
      p("amount", u(2000000)),
    ]
    handleV2HorizontalMerge(e)
    eq(g0.minus(n(2000000)), globalRaw(), "global -2")
    eq(n(5000000), mkt(BIN).amountRaw, "per-market amount unchanged")
  })

  test("module 3 PositionManager ids are ignored on batch mint too", () => {
    let comboYes = pid(BIN, 0).plus(BigInt.fromI32(2).leftShift(248))
    let comboNo = pid(BIN, 1).plus(BigInt.fromI32(2).leftShift(248))
    let e = changetype<TransferBatch>(newMockEvent())
    e.parameters = [
      p("operator", ethereum.Value.fromAddress(COMBO)),
      p("from", ethereum.Value.fromAddress(ZERO)),
      p("to", ethereum.Value.fromAddress(USER)),
      p("ids", ethereum.Value.fromUnsignedBigIntArray([comboYes, comboNo])),
      p("amounts", ethereum.Value.fromUnsignedBigIntArray([n(1000000), n(1000000)])),
    ]
    handleV2MintBatch(e)
    assert.entityCount("MarketOpenInterest", 0)
    eq(n(0), globalRaw(), "global 0")
  })

  test("zero-amount V2 redeem on an existing market bumps redemptionCount only", () => {
    const hash = TX_01B9
    v2Split(BIN, 1000000, hash)
    mint(BIN_MOD, pid(BIN, 0), 1000000, hash)
    mint(BIN_MOD, pid(BIN, 1), 1000000, hash)
    v2Redeem(pid(BIN, 0), 0)
    eq(n(1000000), mkt(BIN).amountRaw, "unchanged")
    assert.fieldEquals("MarketOpenInterest", BIN, "redemptionCount", "1")
  })
})
