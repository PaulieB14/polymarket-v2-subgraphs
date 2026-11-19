import { assert, beforeEach, clearStore, describe, newMockEvent, test } from "matchstick-as/assembly/index"
import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts"
import { TransferSingle, TransferBatch } from "../generated/PositionManagerV2Mints/PositionManagerV2"
import { PositionsSplit, PositionsMerged } from "../generated/NegRiskModuleV2/ModuleV2"
import { MarketOpenInterest } from "../generated/schema"
import { handleV2Mint, handleV2Burn, handleV2MintBatch, handleV2Split, handleV2Merge } from "../src/v2"
import { eq, globalRaw } from "./nr-helpers"

const BIN_MOD = Address.fromString("0x1000008dd9001b968442c1000017eae6e0da00ba")
const NR_MOD = Address.fromString("0x200000900045e3b6259600682756002200028933")
const COMBO = Address.fromString("0x30000034706c7d8e12009dab006be20000c031a8")
const USER = Address.fromString("0xc82f0a25aad828f59347670e63ead5ea144466a7")
const ZERO = Address.zero()

// Real condition ids from the v0.0.9 negative-amount investigation.
// Tx 0x1e8eec9395dec48a46a3087fcb4782ac6da84298b50ceec5475de30bf9b5c9c1
// (block 89,088,903): CombinatorialModule minted both sides, then NegRiskModule merged $1,000.
const CID_BOTH = "0x0266db6afe35010bc55d7675174696fc00000300000000000000000000000200"
const TX_BOTH = Bytes.fromHexString("0x1e8eec9395dec48a46a3087fcb4782ac6da84298b50ceec5475de30bf9b5c9c1")
const AMT_BOTH: i64 = 1000000000 // 1,000 pUSD, 6dp

// Tx 0x586341273f92ee3e6248becd50881caee4dc6c39e0030f33733a538f56782a91
// (block 89,119,088): NegRiskModule migrated YES, CombinatorialModule minted NO, then merge $3,786.712356.
const CID_MIG = "0x02cbfe8a5f594e8aa17b83e94aa6122200000300000000000000000000000200"
const TX_MIG = Bytes.fromHexString("0x586341273f92ee3e6248becd50881caee4dc6c39e0030f33733a538f56782a91")
const AMT_MIG: i64 = 3786712356

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
function p(n: string, v: ethereum.Value): ethereum.EventParam { return new ethereum.EventParam(n, v) }
function u(n: i64): ethereum.Value { return ethereum.Value.fromUnsignedBigInt(BigInt.fromI64(n)) }
function ub(n: BigInt): ethereum.Value { return ethereum.Value.fromUnsignedBigInt(n) }
function n(x: i64): BigInt { return BigInt.fromI64(x) }
function m(id: string): MarketOpenInterest { return MarketOpenInterest.load(id)! }

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
function merge(cid: string, amount: i64, hash: Bytes): void {
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
function split(cid: string, amount: i64, hash: Bytes): void {
  let e = changetype<PositionsSplit>(newMockEvent())
  e.transaction.hash = hash
  e.parameters = [
    p("initiator", ethereum.Value.fromAddress(USER)),
    p("conditionId", ethereum.Value.fromFixedBytes(b31(cid))),
    p("recipient0", ethereum.Value.fromAddress(USER)),
    p("recipient1", ethereum.Value.fromAddress(USER)),
    p("amount", u(amount)),
  ]
  handleV2Split(e)
}

describe("CombinatorialModule credits amount on unwrap / wrap (v0.0.10)", () => {
  beforeEach(() => { clearStore() })

  test("unwrap both sides then merge (tx 0x1e8eec93…c9c1, $1,000): amount nets to 0, not -1000", () => {
    let yes = pid(CID_BOTH, 0)
    let no = pid(CID_BOTH, 1)
    mint(COMBO, yes, AMT_BOTH, TX_BOTH)
    eq(n(AMT_BOTH), m(CID_BOTH).yesSupplyRaw, "yes supply after first combo mint")
    eq(n(AMT_BOTH), m(CID_BOTH).amountRaw, "first combo mint credits a complete-set amount")
    mint(COMBO, no, AMT_BOTH, TX_BOTH)
    eq(n(AMT_BOTH), m(CID_BOTH).noSupplyRaw, "no supply")
    eq(n(AMT_BOTH), m(CID_BOTH).amountRaw, "YES+NO in the same tx credits once, not twice")
    eq(n(AMT_BOTH), globalRaw(), "global +1000")
    burn(NR_MOD, yes, AMT_BOTH, TX_BOTH)
    burn(NR_MOD, no, AMT_BOTH, TX_BOTH)
    merge(CID_BOTH, AMT_BOTH, TX_BOTH)
    eq(n(0), m(CID_BOTH).amountRaw, "amount 0 after merge")
    eq(n(0), m(CID_BOTH).yesSupplyRaw, "yes 0")
    eq(n(0), m(CID_BOTH).noSupplyRaw, "no 0")
    eq(n(0), globalRaw(), "global 0")
    assert.fieldEquals("MarketOpenInterest", CID_BOTH, "splitCount", "0")
    assert.fieldEquals("MarketOpenInterest", CID_BOTH, "mergeCount", "1")
    assert.fieldEquals("MarketOpenInterest", CID_BOTH, "negRisk", "true")
  })

  test("migrate one side + unwrap the complement then merge (tx 0x58634127…2a91, $3,786.712356): amount nets to 0", () => {
    let yes = pid(CID_MIG, 0)
    let no = pid(CID_MIG, 1)
    // Migration mint: operator is NegRiskModule, so amount is not credited here
    // (settlement would move legacy collateral; this tx has no CTF merge).
    mint(NR_MOD, yes, AMT_MIG, TX_MIG)
    eq(n(AMT_MIG), m(CID_MIG).yesSupplyRaw, "migrated yes")
    eq(n(0), m(CID_MIG).amountRaw, "migration mint does not credit V2 amount")
    mint(COMBO, no, AMT_MIG, TX_MIG)
    eq(n(AMT_MIG), m(CID_MIG).noSupplyRaw, "combo complement no")
    eq(n(AMT_MIG), m(CID_MIG).amountRaw, "combo NO mint credits amount")
    burn(NR_MOD, yes, AMT_MIG, TX_MIG)
    burn(NR_MOD, no, AMT_MIG, TX_MIG)
    merge(CID_MIG, AMT_MIG, TX_MIG)
    eq(n(0), m(CID_MIG).amountRaw, "amount 0 after merge")
    eq(n(0), m(CID_MIG).yesSupplyRaw, "yes 0")
    eq(n(0), m(CID_MIG).noSupplyRaw, "no 0")
    eq(n(0), globalRaw(), "global 0")
    assert.fieldEquals("MarketOpenInterest", CID_MIG, "splitCount", "0")
    assert.fieldEquals("MarketOpenInterest", CID_MIG, "mergeCount", "1")
  })

  test("normal PositionsSplit then merge is not double-credited", () => {
    const cid = "0x017d1e01561c374925029c48d5249691ca000000000000000000000000000000"
    const hash = Bytes.fromHexString("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
    const amt: i64 = 1000000000
    let yes = pid(cid, 0)
    let no = pid(cid, 1)
    split(cid, amt, hash)
    eq(n(amt), m(cid).amountRaw, "split credits amount")
    // Module-operator mints (the usual split path) must not add amount again.
    mint(BIN_MOD, yes, amt, hash)
    mint(BIN_MOD, no, amt, hash)
    eq(n(amt), m(cid).amountRaw, "binary-module mints do not double-credit")
    eq(n(amt), m(cid).yesSupplyRaw, "yes supply")
    eq(n(amt), m(cid).noSupplyRaw, "no supply")
    burn(BIN_MOD, yes, amt, hash)
    burn(BIN_MOD, no, amt, hash)
    merge(cid, amt, hash)
    eq(n(0), m(cid).amountRaw, "amount 0 after split+merge")
    eq(n(0), globalRaw(), "global 0")
    assert.fieldEquals("MarketOpenInterest", cid, "splitCount", "1")
    assert.fieldEquals("MarketOpenInterest", cid, "mergeCount", "1")
    assert.fieldEquals("MarketOpenInterest", cid, "negRisk", "false")
  })

  test("partial unwrap of YES only credits that side and leaves noSupply 0", () => {
    const cid = "0x02283c1f0efd13fd95a87ce05952727100000300000000000000000000000000"
    const hash = Bytes.fromHexString("0x0c1d7c641eba138578999559a9dc5618f3af9239616949ed52c2175190c7471f")
    const amt: i64 = 1000000000
    mint(COMBO, pid(cid, 0), amt, hash)
    eq(n(amt), m(cid).amountRaw, "partial unwrap credits amount")
    eq(n(amt), m(cid).yesSupplyRaw, "yes")
    eq(n(0), m(cid).noSupplyRaw, "no still 0")
    eq(n(amt), globalRaw(), "global")
  })

  test("uneven same-tx unwrap credits max(yes, no), not the sum", () => {
    const cid = "0x01b927b8d163079155f37e7f5c5d9261ba000000000000000000000000000000"
    const hash = Bytes.fromHexString("0xd8fb9200db598d711b4f746c9ae4893e9e7c91927405c6204f6ba39c7eb447a3")
    mint(COMBO, pid(cid, 0), 3000000, hash)
    mint(COMBO, pid(cid, 1), 1000000, hash)
    eq(n(3000000), m(cid).amountRaw, "max(3, 1) = 3, not 4")
    eq(n(3000000), m(cid).yesSupplyRaw, "yes 3")
    eq(n(1000000), m(cid).noSupplyRaw, "no 1")
  })

  test("multiple merges in one tx debit each merge and leave the leftover", () => {
    const cid = CID_BOTH
    const hash = TX_BOTH
    mint(COMBO, pid(cid, 0), 2000000000, hash)
    mint(COMBO, pid(cid, 1), 2000000000, hash)
    burn(NR_MOD, pid(cid, 0), 500000000, hash)
    burn(NR_MOD, pid(cid, 1), 500000000, hash)
    merge(cid, 500000000, hash)
    burn(NR_MOD, pid(cid, 0), 700000000, hash)
    burn(NR_MOD, pid(cid, 1), 700000000, hash)
    merge(cid, 700000000, hash)
    eq(n(800000000), m(cid).amountRaw, "2000 - 500 - 700 = 800")
    eq(n(800000000), m(cid).yesSupplyRaw, "yes leftover")
    eq(n(800000000), m(cid).noSupplyRaw, "no leftover")
    assert.fieldEquals("MarketOpenInterest", cid, "mergeCount", "2")
  })

  test("zero-amount combo mint does not create a market or move global", () => {
    const cid = CID_BOTH
    const hash = TX_BOTH
    mint(COMBO, pid(cid, 0), 0, hash)
    assert.entityCount("MarketOpenInterest", 0)
    eq(n(0), globalRaw(), "global stays 0")
  })

  test("zero-amount merge on an existing market bumps mergeCount only", () => {
    mint(COMBO, pid(CID_BOTH, 0), AMT_BOTH, TX_BOTH)
    mint(COMBO, pid(CID_BOTH, 1), AMT_BOTH, TX_BOTH)
    merge(CID_BOTH, 0, TX_BOTH)
    eq(n(AMT_BOTH), m(CID_BOTH).amountRaw, "amount unchanged")
    assert.fieldEquals("MarketOpenInterest", CID_BOTH, "mergeCount", "1")
  })

  test("module 3 position ids are ignored even when the operator is CombinatorialModule", () => {
    // module byte 3, otherwise the same layout as CID_BOTH
    const comboPid = pid(CID_BOTH, 0).plus(BigInt.fromI32(1).leftShift(248)) // 0x02 -> 0x03
    mint(COMBO, comboPid, AMT_BOTH, TX_BOTH)
    assert.entityCount("MarketOpenInterest", 0)
    eq(n(0), globalRaw(), "global 0")
  })

  test("TransferBatch YES+NO from CombinatorialModule credits amount once", () => {
    const cid = CID_BOTH
    const hash = TX_BOTH
    let e = changetype<TransferBatch>(newMockEvent())
    e.transaction.hash = hash
    e.parameters = [
      p("operator", ethereum.Value.fromAddress(COMBO)),
      p("from", ethereum.Value.fromAddress(ZERO)),
      p("to", ethereum.Value.fromAddress(USER)),
      p("ids", ethereum.Value.fromUnsignedBigIntArray([pid(cid, 0), pid(cid, 1)])),
      p("amounts", ethereum.Value.fromUnsignedBigIntArray([n(AMT_BOTH), n(AMT_BOTH)])),
    ]
    handleV2MintBatch(e)
    eq(n(AMT_BOTH), m(cid).amountRaw, "batch credits once")
    eq(n(AMT_BOTH), m(cid).yesSupplyRaw, "yes")
    eq(n(AMT_BOTH), m(cid).noSupplyRaw, "no")
  })

  test("combo wrap (burn) of both sides debits amount", () => {
    const cid = CID_BOTH
    const hash = TX_BOTH
    mint(COMBO, pid(cid, 0), AMT_BOTH, hash)
    mint(COMBO, pid(cid, 1), AMT_BOTH, hash)
    burn(COMBO, pid(cid, 0), AMT_BOTH, hash)
    burn(COMBO, pid(cid, 1), AMT_BOTH, hash)
    eq(n(0), m(cid).amountRaw, "wrap returns amount to 0")
    eq(n(0), m(cid).yesSupplyRaw, "yes 0")
    eq(n(0), m(cid).noSupplyRaw, "no 0")
    eq(n(0), globalRaw(), "global 0")
  })

  test("cross-tx unwrap of YES then NO then merge nets to 0 (not leftover credit)", () => {
    // Completing a set across transactions must not double-credit the way a
    // per-transaction max() would (100 + 100 - 100 = 100 leftover).
    const cid = CID_BOTH
    const tx1 = Bytes.fromHexString("0x1111111111111111111111111111111111111111111111111111111111111111")
    const tx2 = Bytes.fromHexString("0x2222222222222222222222222222222222222222222222222222222222222222")
    const tx3 = Bytes.fromHexString("0x3333333333333333333333333333333333333333333333333333333333333333")
    mint(COMBO, pid(cid, 0), AMT_BOTH, tx1)
    eq(n(AMT_BOTH), m(cid).amountRaw, "first side")
    mint(COMBO, pid(cid, 1), AMT_BOTH, tx2)
    eq(n(AMT_BOTH), m(cid).amountRaw, "second side does not add another complete set")
    burn(NR_MOD, pid(cid, 0), AMT_BOTH, tx3)
    burn(NR_MOD, pid(cid, 1), AMT_BOTH, tx3)
    merge(cid, AMT_BOTH, tx3)
    eq(n(0), m(cid).amountRaw, "merged to 0")
    eq(n(0), globalRaw(), "global 0")
  })

  test("wrapping migrated YES more than combo-minted YES does not debit amount (0x02283c1f yesBurn 424.44)", () => {
    // After migrate YES + combo NO + merge, wrapping leftover migrated YES must
    // not reduce combo credit (those tokens were never combo-credited).
    const cid = "0x02283c1f0efd13fd95a87ce05952727100000300000000000000000000000000"
    const tx1 = Bytes.fromHexString("0x0c1d7c641eba138578999559a9dc5618f3af9239616949ed52c2175190c7471f")
    const txWrap = Bytes.fromHexString("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
    const tx3 = Bytes.fromHexString("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
    const amt: i64 = 1000000000
    const wrap: i64 = 424438214
    mint(NR_MOD, pid(cid, 0), amt, tx1)
    mint(COMBO, pid(cid, 1), amt, tx1)
    burn(NR_MOD, pid(cid, 0), amt, tx1)
    burn(NR_MOD, pid(cid, 1), amt, tx1)
    merge(cid, amt, tx1)
    eq(n(0), m(cid).amountRaw, "first migrate+combo+merge nets 0")
    // One-sided migrate of leftover YES, then wrap it through CombinatorialModule.
    mint(NR_MOD, pid(cid, 0), wrap, txWrap)
    burn(COMBO, pid(cid, 0), wrap, txWrap)
    eq(n(0), m(cid).amountRaw, "wrapping migrated YES does not debit amount")
    mint(NR_MOD, pid(cid, 0), amt, tx3)
    mint(COMBO, pid(cid, 1), amt, tx3)
    burn(NR_MOD, pid(cid, 0), amt, tx3)
    burn(NR_MOD, pid(cid, 1), amt, tx3)
    merge(cid, amt, tx3)
    eq(n(0), m(cid).amountRaw, "later migrate+combo+merge still nets 0")
    eq(n(0), globalRaw(), "global 0")
  })

  test("combo YES with migrated NO, then combo NO with migrated YES, both merge to 0 (0x01429a8f)", () => {
    // Lifetime max(mints) would credit 2500, then the second mixed-side merge
    // of 245.53 would leave amount at -245.53. Retiring open inventory on
    // merge lets the short-side combo mint still credit.
    const cid = "0x01429a8f2ca80f3be03a9a3b4def461582000000000000000000000000000000"
    const txA = Bytes.fromHexString("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
    const txB = Bytes.fromHexString("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
    const txC = Bytes.fromHexString("0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc")
    const both: i64 = 1000000000
    const yesCombo: i64 = 1500000000
    const noCombo: i64 = 245531001
    // Complete combo unwrap + merge.
    mint(COMBO, pid(cid, 0), both, txA)
    mint(COMBO, pid(cid, 1), both, txA)
    burn(BIN_MOD, pid(cid, 0), both, txA)
    burn(BIN_MOD, pid(cid, 1), both, txA)
    merge(cid, both, txA)
    eq(n(0), m(cid).amountRaw, "both-sides unwrap merged to 0")
    // Migrate NO + combo YES + merge.
    mint(BIN_MOD, pid(cid, 1), yesCombo, txB)
    mint(COMBO, pid(cid, 0), yesCombo, txB)
    burn(BIN_MOD, pid(cid, 0), yesCombo, txB)
    burn(BIN_MOD, pid(cid, 1), yesCombo, txB)
    merge(cid, yesCombo, txB)
    eq(n(0), m(cid).amountRaw, "combo YES + migrated NO merged to 0")
    // Migrate YES + combo NO + merge (the side the lifetime max() missed).
    mint(BIN_MOD, pid(cid, 0), noCombo, txC)
    mint(COMBO, pid(cid, 1), noCombo, txC)
    burn(BIN_MOD, pid(cid, 0), noCombo, txC)
    burn(BIN_MOD, pid(cid, 1), noCombo, txC)
    merge(cid, noCombo, txC)
    eq(n(0), m(cid).amountRaw, "combo NO + migrated YES also merged to 0")
    eq(n(0), globalRaw(), "global 0")
  })
})
