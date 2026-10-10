import { assert, beforeEach, clearStore, describe, newMockEvent, test } from "matchstick-as/assembly/index"
import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts"
import {
  ConditionPreparation,
  PositionSplit,
  PositionsMerge,
  PayoutRedemption,
} from "../generated/ConditionalTokens/ConditionalTokens"
import {
  MarketPrepared,
  QuestionPrepared,
  PositionsConverted,
  PositionSplit as NrSplit,
} from "../generated/NegRiskAdapter/NegRiskAdapter"
import {
  handleConditionPreparation,
  handlePositionSplit,
  handlePositionsMerge,
  handlePayoutRedemption,
} from "../src/mapping"
import {
  handleMarketPrepared,
  handleQuestionPrepared,
  handlePositionsConverted,
  handleNegRiskPositionSplit,
  negRiskQuestionId,
  binaryConditionId,
} from "../src/negRiskAdapter"

const USDC_E = Address.fromString("0x2791bca1f2de4661ed88a30c99a7a9449aa84174")
const WMATIC = Address.fromString("0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270")
const WCOL = Address.fromString("0x3a3bd7bb9528e159577f7c2e685cc81a765002e2")
const NRA = Address.fromString("0xd91e80cf2e7be2e162c6513ced06f1dd0da35296")
const USER = Address.fromString("0xada100db00ca00073811820692005400218fce1f")
const ZERO32 = Bytes.fromHexString("0x0000000000000000000000000000000000000000000000000000000000000000")
// real condition from tx 0x24bb2f2b...fa1 (block 95260011)
const COND = Bytes.fromHexString("0xd391104c756f2371defe4daec7e7fa70470ed383c6be338037aab736bca61b19")
const COND_ID = "0xd391104c756f2371defe4daec7e7fa70470ed383c6be338037aab736bca61b19"

function p(name: string, v: ethereum.Value): ethereum.EventParam {
  return new ethereum.EventParam(name, v)
}
function u(n: i64): ethereum.Value {
  return ethereum.Value.fromUnsignedBigInt(BigInt.fromI64(n))
}
function arr(xs: i32[]): ethereum.Value {
  let out: BigInt[] = []
  for (let i = 0; i < xs.length; i++) out.push(BigInt.fromI32(xs[i]))
  return ethereum.Value.fromUnsignedBigIntArray(out)
}

function prepare(cond: Bytes, slots: i32): void {
  let e = changetype<ConditionPreparation>(newMockEvent())
  e.parameters = [
    p("conditionId", ethereum.Value.fromFixedBytes(cond)),
    p("oracle", ethereum.Value.fromAddress(USER)),
    p("questionId", ethereum.Value.fromFixedBytes(ZERO32)),
    p("outcomeSlotCount", u(slots)),
  ]
  handleConditionPreparation(e)
}

function split(col: Address, parent: Bytes, cond: Bytes, amount: i64): void {
  let e = changetype<PositionSplit>(newMockEvent())
  e.parameters = [
    p("stakeholder", ethereum.Value.fromAddress(USER)),
    p("collateralToken", ethereum.Value.fromAddress(col)),
    p("parentCollectionId", ethereum.Value.fromFixedBytes(parent)),
    p("conditionId", ethereum.Value.fromFixedBytes(cond)),
    p("partition", arr([1, 2])),
    p("amount", u(amount)),
  ]
  handlePositionSplit(e)
}

function merge(col: Address, cond: Bytes, amount: i64): void {
  let e = changetype<PositionsMerge>(newMockEvent())
  e.parameters = [
    p("stakeholder", ethereum.Value.fromAddress(USER)),
    p("collateralToken", ethereum.Value.fromAddress(col)),
    p("parentCollectionId", ethereum.Value.fromFixedBytes(ZERO32)),
    p("conditionId", ethereum.Value.fromFixedBytes(cond)),
    p("partition", arr([1, 2])),
    p("amount", u(amount)),
  ]
  handlePositionsMerge(e)
}

// Parameter order/indexing as emitted by CTF:
// PayoutRedemption(indexed redeemer, indexed collateralToken, indexed parentCollectionId, conditionId, indexSets, payout)
function redeem(col: Address, cond: Bytes, payout: i64): void {
  let e = changetype<PayoutRedemption>(newMockEvent())
  e.parameters = [
    p("redeemer", ethereum.Value.fromAddress(USER)),
    p("collateralToken", ethereum.Value.fromAddress(col)),
    p("parentCollectionId", ethereum.Value.fromFixedBytes(ZERO32)),
    p("conditionId", ethereum.Value.fromFixedBytes(cond)),
    p("indexSets", arr([1, 2])),
    p("payout", u(payout)),
  ]
  handlePayoutRedemption(e)
}

describe("ConditionalTokens", () => {
  beforeEach(() => {
    clearStore()
    prepare(COND, 2)
  })

  test("redemption decodes conditionId/collateral and reduces market + global OI", () => {
    split(USDC_E, ZERO32, COND, 100000000) // 100 USDC
    merge(USDC_E, COND, 20000000) // -20
    redeem(USDC_E, COND, 14999474) // real payout from tx 0x24bb2f2b…
    assert.fieldEquals("MarketOpenInterest", COND_ID, "amountRaw", "65000526")
    assert.fieldEquals("MarketOpenInterest", COND_ID, "amount", "65.000526")
    assert.fieldEquals("MarketOpenInterest", COND_ID, "redemptionCount", "1")
    assert.fieldEquals("GlobalOpenInterest", "global", "amountRaw", "65000526")
    assert.notInStore("MarketOpenInterest", "0x0000000000000000000000000000000000000000000000000000000000000000")
  })

  test("non-USDC.e collateral (WMATIC 18dp, WCOL) is ignored", () => {
    split(USDC_E, ZERO32, COND, 1000000)
    split(WMATIC, ZERO32, COND, 1000000000000000000) // 1 WMATIC: the old code read this as $1T
    split(WCOL, ZERO32, COND, 5000000) // neg-risk: counted via the adapter instead
    redeem(WMATIC, COND, 1000000000000000000)
    assert.fieldEquals("MarketOpenInterest", COND_ID, "amountRaw", "1000000")
    assert.fieldEquals("GlobalOpenInterest", "global", "amountRaw", "1000000")
  })

  test("nested split (non-zero parentCollectionId) does not add OI", () => {
    let parent = Bytes.fromHexString("0x1111111111111111111111111111111111111111111111111111111111111111")
    split(USDC_E, parent, COND, 1000000)
    assert.notInStore("MarketOpenInterest", COND_ID)
  })

  test("unregistered or non-binary conditions are ignored", () => {
    let other = Bytes.fromHexString("0x2222222222222222222222222222222222222222222222222222222222222222")
    prepare(other, 3)
    split(USDC_E, ZERO32, other, 1000000)
    assert.notInStore("MarketOpenInterest", other.toHexString())
    assert.entityCount("GlobalOpenInterest", 0)
  })
})

describe("NegRiskAdapter", () => {
  beforeEach(() => {
    clearStore()
  })

  test("questionId/conditionId derivation matches on-chain market 0x55ab…00 index 6", () => {
    let marketId = Bytes.fromHexString("0x55ab76d092f682bf5cbb7e14f13ee12f8410ce7cc1b7906f23b8fb56c11f6500")
    let q = negRiskQuestionId(marketId, 6)
    assert.bytesEquals(q, Bytes.fromHexString("0x55ab76d092f682bf5cbb7e14f13ee12f8410ce7cc1b7906f23b8fb56c11f6506"))
    assert.bytesEquals(
      binaryConditionId(NRA, q),
      Bytes.fromHexString("0x7d0aaf81bbd3fd73b6a1651cce08a452c0cbf9c0cbb4520ce0f981065b639d88")
    )
  })

  test("conversion of 3 NO positions releases 2x amount, split across the 3 conditions", () => {
    let marketId = Bytes.fromHexString("0xabababababababababababababababababababababababababababababababab00")
    let mp = changetype<MarketPrepared>(newMockEvent())
    mp.parameters = [
      p("marketId", ethereum.Value.fromFixedBytes(marketId)),
      p("oracle", ethereum.Value.fromAddress(USER)),
      p("feeBips", u(0)),
      p("data", ethereum.Value.fromBytes(Bytes.empty())),
    ]
    handleMarketPrepared(mp)
    let conds: Bytes[] = []
    for (let i = 0; i < 4; i++) {
      let qid = negRiskQuestionId(marketId, i as u8)
      let qp = changetype<QuestionPrepared>(newMockEvent())
      qp.parameters = [
        p("marketId", ethereum.Value.fromFixedBytes(marketId)),
        p("questionId", ethereum.Value.fromFixedBytes(qid)),
        p("index", u(i)),
        p("data", ethereum.Value.fromBytes(Bytes.empty())),
      ]
      handleQuestionPrepared(qp)
      let cid = binaryConditionId(NRA, qid)
      conds.push(cid)
      // CTF registers the condition (oracle = adapter)
      let cp = changetype<ConditionPreparation>(newMockEvent())
      cp.parameters = [
        p("conditionId", ethereum.Value.fromFixedBytes(cid)),
        p("oracle", ethereum.Value.fromAddress(NRA)),
        p("questionId", ethereum.Value.fromFixedBytes(qid)),
        p("outcomeSlotCount", u(2)),
      ]
      handleConditionPreparation(cp)
      let s = changetype<NrSplit>(newMockEvent())
      s.parameters = [
        p("stakeholder", ethereum.Value.fromAddress(USER)),
        p("conditionId", ethereum.Value.fromFixedBytes(cid)),
        p("amount", u(30000000)),
      ]
      handleNegRiskPositionSplit(s)
    }
    assert.fieldEquals("GlobalOpenInterest", "global", "amountRaw", "120000000")

    let cv = changetype<PositionsConverted>(newMockEvent())
    cv.parameters = [
      p("stakeholder", ethereum.Value.fromAddress(USER)),
      p("marketId", ethereum.Value.fromFixedBytes(marketId)),
      p("indexSet", u(0x7)), // questions 0,1,2
      p("amount", u(9000000)),
    ]
    handlePositionsConverted(cv)
    // released = 2 * 9 = 18 USDC; 6 per converted condition
    assert.fieldEquals("GlobalOpenInterest", "global", "amountRaw", "102000000")
    assert.fieldEquals("MarketOpenInterest", conds[0].toHexString(), "amountRaw", "24000000")
    assert.fieldEquals("MarketOpenInterest", conds[2].toHexString(), "amountRaw", "24000000")
    assert.fieldEquals("MarketOpenInterest", conds[3].toHexString(), "amountRaw", "30000000")
    assert.fieldEquals("MarketOpenInterest", conds[0].toHexString(), "negRisk", "true")
  })
})
