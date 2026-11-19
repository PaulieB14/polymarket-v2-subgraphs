import { assert, beforeEach, clearStore, describe, newMockEvent, test } from "matchstick-as/assembly/index"
import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts"
import {
  ConditionPreparation,
  PositionSplit,
  PositionsMerge,
  PayoutRedemption,
  ConditionResolution,
} from "../generated/ConditionalTokens/ConditionalTokens"
import { MarketOpenInterest } from "../generated/schema"
import {
  handleConditionPreparation,
  handlePositionSplit,
  handlePositionsMerge,
  handlePayoutRedemption,
  handleConditionResolution,
} from "../src/mapping"
import { eq, globalRaw } from "./nr-helpers"

const USDC_E = Address.fromString("0x2791bca1f2de4661ed88a30c99a7a9449aa84174")
const USER = Address.fromString("0xdebf5b75a2cf1b0ce1d13eb32d0b6ebce1391c58")
const UMA = Address.fromString("0x65070be91477460d8a7aeeb94ef92fe056c2f2a7")
const ZERO32 = Bytes.fromHexString("0x0000000000000000000000000000000000000000000000000000000000000000")
// CS2: HOTU vs ALGO, voided [1,1] at block 83,222,474. Real on-chain logs through
// the 5.0 merge in tx 0x7804d66d…b4fe (block 84,643,732).
const COND = Bytes.fromHexString("0x5c6df6f8acb119f774d59a2bb05e45eace000f69c4a255a6c59067ade0ff3df5")
const CID = "0x5c6df6f8acb119f774d59a2bb05e45eace000f69c4a255a6c59067ade0ff3df5"
const REPLAY = "S:3571427;S:39470000;S:1410000;S:5000000;S:5000000;S:10000000;S:10000000;M:3570000;S:37970000;M:37970000;S:3448274;S:33330000;S:32690000;S:30000000;S:6430000;S:5190895;M:6430000;M:6690800;S:26315787;S:3680000;S:6320000;S:6320000;S:2000000;S:2000000;S:1315787;S:17290000;S:30000000;S:34090000;S:5320000;S:2000000;S:39470000;S:30300000;S:100000000;S:55384614;S:21530000;S:28300000;S:38360000;S:49576491;S:100000000;S:30000000;S:3246752;S:32960000;S:12000000;S:30300000;S:34620000;S:34610000;S:32600000;S:32960000;S:2000000;S:100000000;S:2000000;S:114925372;S:83070000;S:130000000;S:10000000;S:7000000;S:160000000;S:20000000;S:5000000;S:7000000;S:15000000;S:252000000;S:15000000;S:5000000;S:16000000;S:5000000;S:40000000;S:105000000;S:1333332;S:15000000;S:145000000;S:5000000;S:7000000;S:5000000;S:5000000;S:7000000;S:5054053;S:34940000;S:6940000;S:90410000;S:30000000;S:32600000;S:30300000;S:28890000;S:60000000;S:33330000;S:36140000;S:37970000;S:48000000;S:39748850;S:5000000;S:5000000;S:6320000;S:90000000;S:43470000;S:5000000;S:1315787;M:1320000;S:5770000;S:160000000;S:129230000;S:13513511;S:357250000;S:330000000;S:33000000;S:35000000;S:100000000;S:450000000;S:116000000;S:7000000;S:298950000;S:5000000;S:6000000;S:195000000;S:5000000;S:250000000;M:10000000;M:267000000;M:346900000;M:403100000;S:3960783;M:305967400;S:3921567;S:39215685;S:5882351;S:7843136;S:20000000;S:20000000;S:30000000;S:10000000;S:1960783;M:110000000;S:70000000;S:2940000;S:18294116;S:5000000;S:5000000;S:5000000;S:5000000;O;R3:3000000;R3:30000;R3:34000000;R3:870415000;R3:0;R3:10000000;R3:471125000;R3:150000000;R3:1324559;R3:0;R3:0;R3:287143819;R3:0;R3:25500000;R3:4901959;R3:50000000;R3:24735000;R3:3645000;R3:19607842;R3:5000000;R3:5000000;R3:20000000;R3:80000000;R3:0;R3:0;R3:254634425;R3:2500000;R3:2941175;R3:240000000;R3:3500000;R3:705000;R3:1785713;R3:18000000;R3:1815391;R3:76995000;R3:152000000;R3:1960783;R3:0;R1:3500000;R3:13157893;R3:242804191;R3:107462686;R3:1724137;R3:0;R3:24000000;R3:41535000;R3:0;R3:6000000;R3:657893;R2:113590320;R3:77302893;R3:0;R3:6756755;R3:0;R3:5000000;R3:5035000;R3:83810447;R3:65000000;R3:612563377;R3:3000000;R3:30000000;R3:705000;R3:1980391;M:5000000"

function p(name: string, v: ethereum.Value): ethereum.EventParam { return new ethereum.EventParam(name, v) }
function u(n: i64): ethereum.Value { return ethereum.Value.fromUnsignedBigInt(BigInt.fromI64(n)) }
function ub(n: BigInt): ethereum.Value { return ethereum.Value.fromUnsignedBigInt(n) }
function arr(xs: i32[]): ethereum.Value {
  let out: BigInt[] = []
  for (let i = 0; i < xs.length; i++) out.push(BigInt.fromI32(xs[i]))
  return ethereum.Value.fromUnsignedBigIntArray(out)
}
function n(x: i64): BigInt { return BigInt.fromI64(x) }
function m(id: string): MarketOpenInterest { return MarketOpenInterest.load(id)! }

function prepare(): void {
  let e = changetype<ConditionPreparation>(newMockEvent())
  e.parameters = [
    p("conditionId", ethereum.Value.fromFixedBytes(COND)),
    p("oracle", ethereum.Value.fromAddress(UMA)),
    p("questionId", ethereum.Value.fromFixedBytes(ZERO32)),
    p("outcomeSlotCount", u(2)),
  ]
  handleConditionPreparation(e)
}
function ctfSplit(amount: BigInt): void {
  let e = changetype<PositionSplit>(newMockEvent())
  e.parameters = [
    p("stakeholder", ethereum.Value.fromAddress(USER)),
    p("collateralToken", ethereum.Value.fromAddress(USDC_E)),
    p("parentCollectionId", ethereum.Value.fromFixedBytes(ZERO32)),
    p("conditionId", ethereum.Value.fromFixedBytes(COND)),
    p("partition", arr([1, 2])),
    p("amount", ub(amount)),
  ]
  handlePositionSplit(e)
}
function ctfMerge(amount: BigInt): void {
  let e = changetype<PositionsMerge>(newMockEvent())
  e.parameters = [
    p("stakeholder", ethereum.Value.fromAddress(USER)),
    p("collateralToken", ethereum.Value.fromAddress(USDC_E)),
    p("parentCollectionId", ethereum.Value.fromFixedBytes(ZERO32)),
    p("conditionId", ethereum.Value.fromFixedBytes(COND)),
    p("partition", arr([1, 2])),
    p("amount", ub(amount)),
  ]
  handlePositionsMerge(e)
}
function ctfRedeem(sets: i32[], payout: BigInt): void {
  let e = changetype<PayoutRedemption>(newMockEvent())
  e.parameters = [
    p("redeemer", ethereum.Value.fromAddress(USER)),
    p("collateralToken", ethereum.Value.fromAddress(USDC_E)),
    p("parentCollectionId", ethereum.Value.fromFixedBytes(ZERO32)),
    p("conditionId", ethereum.Value.fromFixedBytes(COND)),
    p("indexSets", arr(sets)),
    p("payout", ub(payout)),
  ]
  handlePayoutRedemption(e)
}
function resolve11(): void {
  let e = changetype<ConditionResolution>(newMockEvent())
  e.parameters = [
    p("conditionId", ethereum.Value.fromFixedBytes(COND)),
    p("oracle", ethereum.Value.fromAddress(UMA)),
    p("questionId", ethereum.Value.fromFixedBytes(ZERO32)),
    p("outcomeSlotCount", u(2)),
    p("payoutNumerators", arr([1, 1])),
  ]
  handleConditionResolution(e)
}

function play(chunk: string): void {
  let rows = chunk.split(";")
  for (let r = 0; r < rows.length; r++) {
    let row = rows[r]
    let k = row.charAt(0)
    if (k == "O") {
      resolve11()
      continue
    }
    if (k == "S") {
      ctfSplit(BigInt.fromString(row.substr(2)))
    } else if (k == "M") {
      ctfMerge(BigInt.fromString(row.substr(2)))
    } else if (k == "R") {
      let colon = 0
      for (let i = 0; i < row.length; i++) {
        if (row.charAt(i) == ":") { colon = i; break }
      }
      let flags = I32.parseInt(row.substr(1, colon - 1))
      let payout = BigInt.fromString(row.substr(colon + 1))
      let sets: i32[] = []
      if ((flags & 1) != 0) sets.push(1)
      if ((flags & 2) != 0) sets.push(2)
      if (sets.length == 0) { sets.push(1); sets.push(2) }
      ctfRedeem(sets, payout)
    }
  }
}

describe("voided [1,1] markets (known supply approximation, amount exact)", () => {
  beforeEach(() => { clearStore(); prepare() })

  test("real market 0x5c6df6f8…3df5: amount stays 0.069504 after the 5.0 merge; noSupply goes negative", () => {
    play(REPLAY)
    eq(n(69504), m(CID).amountRaw, "amount = splits - merges - payouts")
    eq(n(698226), m(CID).yesSupplyRaw, "subgraph yes after unclamped merge")
    eq(n(-559199), m(CID).noSupplyRaw, "subgraph no after unclamped merge (known bug)")
    assert.fieldEquals("MarketOpenInterest", CID, "splitCount", "128")
    assert.fieldEquals("MarketOpenInterest", CID, "mergeCount", "12")
    assert.fieldEquals("MarketOpenInterest", CID, "redemptionCount", "63")
    eq(n(69504), globalRaw(), "global follows amount, not supplies")
  })

  test("first post-resolution redeem (tx 0x158c4c6f…e3d2 pattern): [1,2] payout 3 allocates 3/3 even when only YES was burned on chain", () => {
    ctfSplit(n(10000000))
    resolve11()
    ctfRedeem([1, 2], n(3000000))
    eq(n(7000000), m(CID).amountRaw, "amount -= payout (correct)")
    eq(n(7000000), m(CID).yesSupplyRaw, "subgraph burns payout of YES")
    eq(n(7000000), m(CID).noSupplyRaw, "subgraph also burns payout of NO (on-chain burned 0 NO)")
  })

  test("[1,2] redeem on equal supplies burns payout from each side; amount drops by payout", () => {
    ctfSplit(n(10000000))
    resolve11()
    ctfRedeem([1, 2], n(1000000))
    eq(n(9000000), m(CID).amountRaw, "amount")
    eq(n(9000000), m(CID).yesSupplyRaw, "yes")
    eq(n(9000000), m(CID).noSupplyRaw, "no")
  })

  test("single-indexSet [1] redeem on [1,1] burns 2x payout of YES only", () => {
    // Each token is worth 0.5, so payout 2 requires burning 4 YES. NO is untouched.
    ctfSplit(n(10000000))
    resolve11()
    ctfRedeem([1], n(2000000))
    eq(n(8000000), m(CID).amountRaw, "amount -= payout")
    eq(n(6000000), m(CID).yesSupplyRaw, "yes -= 2*payout")
    eq(n(10000000), m(CID).noSupplyRaw, "no unchanged")
  })

  test("single-indexSet [2] redeem on [1,1] burns 2x payout of NO only", () => {
    ctfSplit(n(10000000))
    resolve11()
    ctfRedeem([2], n(2000000))
    eq(n(8000000), m(CID).amountRaw, "amount -= payout")
    eq(n(10000000), m(CID).yesSupplyRaw, "yes unchanged")
    eq(n(6000000), m(CID).noSupplyRaw, "no -= 2*payout")
  })

  test("zero-payout redeem after [1,1] resolution bumps redemptionCount only", () => {
    ctfSplit(n(10000000))
    resolve11()
    ctfRedeem([1, 2], n(0))
    eq(n(10000000), m(CID).amountRaw, "amount unchanged")
    eq(n(10000000), m(CID).yesSupplyRaw, "yes unchanged")
    eq(n(10000000), m(CID).noSupplyRaw, "no unchanged")
    assert.fieldEquals("MarketOpenInterest", CID, "redemptionCount", "1")
  })

  test("amount remains splits - merges - payouts through a short [1,1] lifecycle", () => {
    ctfSplit(n(10000000))
    ctfSplit(n(5000000))
    ctfMerge(n(2000000))
    resolve11()
    ctfRedeem([1, 2], n(4000000))
    ctfRedeem([1], n(1000000))
    ctfMerge(n(3000000))
    eq(n(5000000), m(CID).amountRaw, "15 - 2 - 4 - 1 - 3 = 5")
    eq(n(5000000), globalRaw(), "global")
    assert.fieldEquals("MarketOpenInterest", CID, "resolved", "true")
  })

  test("use amount, not supplies, as remaining payout value when sides diverge", () => {
    ctfSplit(n(10000000))
    resolve11()
    ctfRedeem([1], n(3000000))
    ctfRedeem([1, 2], n(1000000))
    // amount is exact; yes and no have diverged under the [1,1] allocation
    eq(n(6000000), m(CID).amountRaw, "amount exact")
    assert.assertTrue(m(CID).yesSupplyRaw.notEqual(m(CID).noSupplyRaw), "supplies diverged")
  })
})
