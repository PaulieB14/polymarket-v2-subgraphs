import { assert, describe, test, clearStore, newMockEvent, beforeEach } from "matchstick-as/assembly/index"
import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts"
import { ConditionPreparation } from "../generated/ConditionalTokens/ConditionalTokens"
import { OrderFilled } from "../generated/CtfExchangeV2/CtfExchangeV2"
import { OrderFilled as NegOrderFilled } from "../generated/NegRiskCtfExchangeV2/NegRiskCtfExchangeV2"
import { QuestionInitialized } from "../generated/UmaCtfAdapter/UmaCtfAdapter"
import { QuestionPrepared, MarketPrepared } from "../generated/NegRiskAdapter/NegRiskAdapter"
import { MarketData } from "../generated/schema"
import {
  handleConditionPreparation, handleOrderFilled, handleOrderFilledNegRisk,
  handleQuestionInitialized, handleQuestionPrepared, handleMarketPrepared,
  conditionIdFor, UMA_ADAPTER, NEG_RISK_ADAPTER,
} from "../src/mapping"
import { extractTitle, extractGammaId } from "../src/names"

const EX = Address.fromString("0xE111180000d2663C0091e4f400237545B87B996B")
const NEGEX = Address.fromString("0xe2222d279d744050d28e00520010520000310F59")
const ALICE = Address.fromString("0xdf4c6a942bd95bf903d6066b4ba7051e6f914f22")
const BOB = Address.fromString("0x5d4aba8ad45bb5eab3499a0294b42da5d1e455d3")
const CAROL = Address.fromString("0x0000000000000000000000000000000000000c0c")
const Q1 = Bytes.fromHexString("0x8e40f8a1725e0aa1bc734350d3db142b28a65f53ed4f1f39c3e644f90f0e23ea")
const Q2 = Bytes.fromHexString("0xdc5d52c57bfc9ac8e4a134fb0e369ae85390d3409356afc8ef00548a02cfdd00")
const MID = Bytes.fromHexString("0xdc5d52c57bfc9ac8e4a134fb0e369ae85390d3409356afc8ef00548a02cfdd00")
const ZERO32 = Bytes.fromHexString("0x0000000000000000000000000000000000000000000000000000000000000000")
const YES = BigInt.fromString("111")
const NO = BigInt.fromString("222")

let li: i32 = 0
function mk(): ethereum.Event {
  let e = newMockEvent(); li++
  e.logIndex = BigInt.fromI32(li)
  e.block.number = BigInt.fromI32(90000000)
  return e
}
function u(v: BigInt): ethereum.Value { return ethereum.Value.fromUnsignedBigInt(v) }
function n(v: i64): BigInt { return BigInt.fromI64(v) }
function b32(b: Bytes): ethereum.Value { return ethereum.Value.fromFixedBytes(b) }

function fillParams(e: ethereum.Event, maker: Address, taker: Address, side: i32, tok: BigInt, mA: i64, tA: i64, fee: i64): void {
  e.parameters = [
    new ethereum.EventParam("orderHash", b32(ZERO32)),
    new ethereum.EventParam("maker", ethereum.Value.fromAddress(maker)),
    new ethereum.EventParam("taker", ethereum.Value.fromAddress(taker)),
    new ethereum.EventParam("side", ethereum.Value.fromI32(side)),
    new ethereum.EventParam("tokenId", u(tok)),
    new ethereum.EventParam("makerAmountFilled", u(n(mA))),
    new ethereum.EventParam("takerAmountFilled", u(n(tA))),
    new ethereum.EventParam("fee", u(n(fee))),
    new ethereum.EventParam("builder", b32(ZERO32)),
    new ethereum.EventParam("metadata", b32(ZERO32)),
  ]
}
function fill(maker: Address, taker: Address, side: i32, tok: BigInt, mA: i64, tA: i64, fee: i64): void {
  let e = changetype<OrderFilled>(mk()); fillParams(e, maker, taker, side, tok, mA, tA, fee); handleOrderFilled(e)
}
function fillNeg(maker: Address, taker: Address, side: i32, tok: BigInt, mA: i64, tA: i64, fee: i64): void {
  let e = changetype<NegOrderFilled>(mk()); fillParams(e, maker, taker, side, tok, mA, tA, fee); handleOrderFilledNegRisk(e)
}
function prep(oracle: Address, q: Bytes): string {
  let e = changetype<ConditionPreparation>(mk())
  let cid = conditionIdFor(oracle, q, 2)
  e.parameters = [
    new ethereum.EventParam("conditionId", b32(Bytes.fromHexString(cid))),
    new ethereum.EventParam("oracle", ethereum.Value.fromAddress(oracle)),
    new ethereum.EventParam("questionId", b32(q)),
    new ethereum.EventParam("outcomeSlotCount", u(n(2))),
  ]
  handleConditionPreparation(e)
  return cid
}
function mapTokens(cid: string): void {
  let y = new MarketData(YES.toString()); y.condition = cid; y.outcomeIndex = n(0); y.save()
  let o = new MarketData(NO.toString()); o.condition = cid; o.outcomeIndex = n(1); o.save()
}
function uma(q: Bytes, text: string): void {
  let e = changetype<QuestionInitialized>(mk())
  e.parameters = [
    new ethereum.EventParam("questionID", b32(q)),
    new ethereum.EventParam("requestTimestamp", u(n(1))),
    new ethereum.EventParam("creator", ethereum.Value.fromAddress(CAROL)),
    new ethereum.EventParam("ancillaryData", ethereum.Value.fromBytes(Bytes.fromUTF8(text))),
    new ethereum.EventParam("rewardToken", ethereum.Value.fromAddress(CAROL)),
    new ethereum.EventParam("reward", u(n(0))),
    new ethereum.EventParam("proposalBond", u(n(0))),
  ]
  handleQuestionInitialized(e)
}
function nrq(q: Bytes, text: string): void {
  let e = changetype<QuestionPrepared>(mk())
  e.parameters = [
    new ethereum.EventParam("marketId", b32(MID)),
    new ethereum.EventParam("questionId", b32(q)),
    new ethereum.EventParam("index", u(n(0))),
    new ethereum.EventParam("data", ethereum.Value.fromBytes(Bytes.fromUTF8(text))),
  ]
  handleQuestionPrepared(e)
}

describe("name parsing", () => {
  test("title: up to description, keeps commas", () => {
    let t = extractTitle("q: title: XRP Up or Down - November 5, 12:40PM-12:45PM ET, description: blah, more, market_id: 42,initializer:ab", "title:") as string
    assert.stringEquals(t, "XRP Up or Down - November 5, 12:40PM-12:45PM ET")
    assert.bigIntEquals((extractGammaId("q: title: x, description: y market_id: 6683811,initializer:ac99") as BigInt), n(6683811))
  })
  test("question: prefix and trailing id", () => {
    let s = "question: Will Dominica win on 2026-11-17?, description: In the game, ok., id: 6684021"
    assert.stringEquals(extractTitle(s, "question:") as string, "Will Dominica win on 2026-11-17?")
    assert.bigIntEquals((extractGammaId(s) as BigInt), n(6684021))
  })
  test("missing description / missing prefix / empty / no id", () => {
    assert.stringEquals((extractTitle("title: Only title, here, id: 7", "title:") as string), "Only title, here")
    assert.stringEquals((extractTitle("title: Bare", "title:") as string), "Bare")
    assert.assertNull(extractTitle("no prefix here", "title:"))
    assert.assertNull(extractTitle("title:   , description: x", "title:"))
    assert.assertTrue(extractGammaId("title: x, description: y") === null)
  })
  test("odd bytes and length cap", () => {
    let raw = Bytes.fromHexString("0x7469746c653a20410042ff43")  // "title: A\0B\xffC"
    let t = extractTitle(raw.toString(), "title:")
    let ts = t as string
    assert.assertTrue(ts.startsWith("AB"))
    let long = "title: "; for (let i = 0; i < 300; i++) long += "x"
    let lt = extractTitle(long + ", description: d", "title:") as string
    assert.i32Equals(lt.length, 200)
  })
})

describe("maker/taker counting", () => {
  beforeEach(() => { clearStore() })
  test("MINT match (real tx 0xed93…960d) counted once, accounts attributed to their own token", () => {
    let cid = prep(UMA_ADAPTER, Q1); mapTokens(cid)
    // maker ALICE buys NO 8.65882 for 1.298823; taker BOB buys YES for 7.359997 (fee 0.07727)
    fill(ALICE, BOB, 0, NO, 1298823, 8658820, 0)
    fill(BOB, EX, 0, YES, 7359997, 8658820, 77270)
    assert.fieldEquals("Global", "", "tradesQuantity", "1")
    assert.fieldEquals("Global", "", "buysQuantity", "1")
    assert.fieldEquals("Global", "", "collateralVolume", "7359997")
    assert.fieldEquals("Global", "", "orderFillsQuantity", "2")
    assert.fieldEquals("Global", "", "collateralFees", "77270")
    assert.fieldEquals("Global", "", "numTraders", "2")
    assert.fieldEquals("Account", ALICE.toHexString(), "collateralVolume", "1298823")
    assert.fieldEquals("Account", BOB.toHexString(), "collateralVolume", "7359997")
    assert.fieldEquals("Account", BOB.toHexString(), "numTrades", "1")
    assert.fieldEquals("Account", BOB.toHexString(), "feesPaid", "77270")
    assert.notInStore("Account", EX.toHexString())
    assert.fieldEquals("MarketPosition", ALICE.toHexString() + "-" + NO.toString(), "quantityBought", "8658820")
    assert.fieldEquals("MarketPosition", BOB.toHexString() + "-" + YES.toString(), "quantityBought", "8658820")
    assert.notInStore("MarketPosition", BOB.toHexString() + "-" + NO.toString())
    assert.fieldEquals("Condition", cid, "tradesQuantity", "1")
    assert.fieldEquals("Condition", cid, "collateralVolume", "7359997")
    assert.fieldEquals("Orderbook", YES.toString(), "collateralVolume", "7359997")
    assert.notInStore("Orderbook", NO.toString())
    assert.entityCount("Trade", 1)
  })
  test("one taker vs two makers, COMPLEMENTARY sell, negRisk exchange", () => {
    let cid = prep(NEG_RISK_ADAPTER, Q2); mapTokens(cid)
    // taker CAROL sells 10 YES for 6.0; makers ALICE/BOB buy 4 and 6 YES at 0.6
    fillNeg(ALICE, CAROL, 0, YES, 2400000, 4000000, 0)
    fillNeg(BOB, CAROL, 0, YES, 3600000, 6000000, 1000)
    fillNeg(CAROL, NEGEX, 1, YES, 10000000, 6000000, 50000)
    assert.fieldEquals("Global", "", "tradesQuantity", "1")
    assert.fieldEquals("Global", "", "sellsQuantity", "1")
    assert.fieldEquals("Global", "", "collateralVolume", "6000000")
    assert.fieldEquals("Global", "", "collateralFees", "51000")
    assert.fieldEquals("Global", "", "numTraders", "3")
    assert.fieldEquals("Account", CAROL.toHexString(), "collateralVolume", "6000000")
    assert.fieldEquals("Account", CAROL.toHexString(), "numTrades", "1")
    assert.fieldEquals("MarketPosition", CAROL.toHexString() + "-" + YES.toString(), "quantitySold", "10000000")
    assert.fieldEquals("MarketPosition", CAROL.toHexString() + "-" + YES.toString(), "quantityBought", "0")
    assert.fieldEquals("MarketPosition", BOB.toHexString() + "-" + YES.toString(), "netQuantity", "6000000")
    assert.fieldEquals("Condition", cid, "collateralVolume", "6000000")
    assert.fieldEquals("Condition", cid, "fees", "51000")
    assert.notInStore("Account", NEGEX.toHexString())
    assert.entityCount("Trade", 1)
  })
})

describe("names on conditions, both orders", () => {
  beforeEach(() => { clearStore() })
  test("uma: prep then name", () => {
    let cid = prep(UMA_ADAPTER, Q1)
    uma(Q1, "q: title: Spread: Southport FC (-3.5), description: In the game, market_id: 6683811,initializer:ac")
    assert.fieldEquals("Condition", cid, "title", "Spread: Southport FC (-3.5)")
    assert.fieldEquals("MarketName", Q1.toHexString(), "gammaId", "6683811")
    assert.fieldEquals("MarketName", Q1.toHexString(), "kind", "uma")
    assert.fieldEquals("MarketName", Q1.toHexString(), "creator", CAROL.toHexString())
  })
  test("uma: name then prep", () => {
    uma(Q1, "q: title: A, B, description: x")
    let cid = prep(UMA_ADAPTER, Q1)
    assert.fieldEquals("Condition", cid, "title", "A, B")
  })
  test("negrisk: both orders + event title", () => {
    let me = changetype<MarketPrepared>(mk())
    me.parameters = [
      new ethereum.EventParam("marketId", b32(MID)),
      new ethereum.EventParam("oracle", ethereum.Value.fromAddress(CAROL)),
      new ethereum.EventParam("feeBips", u(n(0))),
      new ethereum.EventParam("data", ethereum.Value.fromBytes(Bytes.fromUTF8("title: Dominica vs. Cayman Islands, description: x, id: 1314851"))),
    ]
    handleMarketPrepared(me)
    let cid = prep(NEG_RISK_ADAPTER, Q2)
    nrq(Q2, "question: Will Dominica win on 2026-11-17?, description: d, id: 6684021")
    assert.fieldEquals("Condition", cid, "title", "Will Dominica win on 2026-11-17?")
    assert.fieldEquals("MarketName", Q2.toHexString(), "negRiskEvent", MID.toHexString())
    assert.fieldEquals("NegRiskEvent", MID.toHexString(), "title", "Dominica vs. Cayman Islands")
    assert.fieldEquals("NegRiskEvent", MID.toHexString(), "gammaId", "1314851")
    let q3 = Bytes.fromHexString("0xdc5d52c57bfc9ac8e4a134fb0e369ae85390d3409356afc8ef00548a02cfdd01")
    nrq(q3, "question: Draw?, description: d, id: 6684022")
    let cid3 = prep(NEG_RISK_ADAPTER, q3)
    assert.fieldEquals("Condition", cid3, "title", "Draw?")
  })
  test("conditionIdFor matches real chain ids", () => {
    assert.stringEquals(conditionIdFor(UMA_ADAPTER, Q1, 2), "0x37ac2d6a8f9a816aab0c7afc6ef38bd6297aa884514b8cb3509166657bc666fa")
  })
})
