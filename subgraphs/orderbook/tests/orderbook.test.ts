import { assert, beforeEach, clearStore, describe, newMockEvent, test } from "matchstick-as/assembly/index"
import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts"
import { OrderFilled as CtfFilled, OrdersMatched as CtfMatched } from "../generated/CtfExchangeV2/CtfExchangeV2"
import { OrderFilled as NrFilled } from "../generated/NegRiskCtfExchangeV2/NegRiskCtfExchangeV2"
import { OrderFilled as MgFilled, OrdersMatched as MgMatched } from "../generated/MigratableExchange/MigratableExchange"
import {
  handleOrderFilled, handleOrdersMatched, handleOrderFilledNegRisk,
  handleOrderFilledMigratable, handleOrdersMatchedMigratable, setTradeTimeseriesEnabled,
} from "../src/mapping"
import { decodeTokenId, toBytes32 } from "../src/ids"

const CTF_EX = Address.fromString("0xe111180000d2663c0091e4f400237545b87b996b")
const NR_EX = Address.fromString("0xe2222d279d744050d28e00520010520000310f59")
const MG_EX = Address.fromString("0xe3333700ca9d93003f00f0f71f8515005f6c00aa")
const ALICE = Address.fromString("0x00000000000000000000000000000000000a11ce")
const BOB = Address.fromString("0x0000000000000000000000000000000000000b0b")
const CAROL = Address.fromString("0x00000000000000000000000000000000000ca401")
const ZERO32 = Bytes.fromHexString("0x0000000000000000000000000000000000000000000000000000000000000000")
const BUILDER = Bytes.fromHexString("0x00000000000000000000000000000000000000000000000000000000000000b1")
const GLOBAL = "0x676c6f62616c"
const TX = Bytes.fromHexString("0x1111111111111111111111111111111111111111111111111111111111111111")

// Real token ids
// polyv2 binary seed nba-cle-nyk YES (module 1)
const BIN_YES = "673375820099379269761014006244372837799090532969111081655717424084258127872"
const BIN_COND = "0x017d1e01561c374925029c48d5249691ca000000000000000000000000000000"
// neg-risk NYC Oct 30 68-69F (module 2)
const NR_TOK = "1056161234059696262103638593071164169636008086984931975163686004493492683776"
const NR_COND = "0x0255c41d747588b4a9dbaba984a4093111000c00000000000000000000000400"
// combinatorial token from MigratableExchange fills (module 3)
const COMBO_TOK_HEX = "0x031a0905ba1a97372a4be534811851def1000000000000000000000000000001"
// V1 CTF token whose top byte happens to be 0x02 (Gamma: will-candidate-a-be-the-next-ceo-of-nvidia)
const V1_TOP02 = "1235542575596688477313848611478957797754574132778744552334368030605653599770"
const V1_SMALL = "41499178610623210757481064737916800824730720740770471809720325999078886418043"

function bi(s: string): BigInt { return BigInt.fromString(s) }
function hexToBI(h: string): BigInt {
  // big-endian hex -> BigInt
  let be = Bytes.fromHexString(h)
  let le = new Bytes(be.length + 1)
  for (let i = 0; i < be.length; i++) le[i] = be[be.length - 1 - i]
  le[be.length] = 0
  return BigInt.fromUnsignedBytes(le)
}

function fillParams(e: ethereum.Event, maker: Address, taker: Address, side: i32, tokenId: BigInt,
  makerAmt: i64, takerAmt: i64, fee: i64, builder: Bytes): void {
  e.parameters = [
    new ethereum.EventParam("orderHash", ethereum.Value.fromFixedBytes(ZERO32)),
    new ethereum.EventParam("maker", ethereum.Value.fromAddress(maker)),
    new ethereum.EventParam("taker", ethereum.Value.fromAddress(taker)),
    new ethereum.EventParam("side", ethereum.Value.fromI32(side)),
    new ethereum.EventParam("tokenId", ethereum.Value.fromUnsignedBigInt(tokenId)),
    new ethereum.EventParam("makerAmountFilled", ethereum.Value.fromUnsignedBigInt(BigInt.fromI64(makerAmt))),
    new ethereum.EventParam("takerAmountFilled", ethereum.Value.fromUnsignedBigInt(BigInt.fromI64(takerAmt))),
    new ethereum.EventParam("fee", ethereum.Value.fromUnsignedBigInt(BigInt.fromI64(fee))),
    new ethereum.EventParam("builder", ethereum.Value.fromFixedBytes(builder)),
    new ethereum.EventParam("metadata", ethereum.Value.fromFixedBytes(ZERO32)),
  ]
}
function prep(e: ethereum.Event, ex: Address, logIndex: i32): void {
  e.address = ex
  e.transaction.hash = TX
  e.logIndex = BigInt.fromI32(logIndex)
  e.block.number = BigInt.fromI32(97600000)
  e.block.timestamp = BigInt.fromI32(1779900000)
}
function ctfFill(maker: Address, taker: Address, side: i32, tokenId: BigInt, mA: i64, tA: i64, fee: i64, li: i32, builder: Bytes = ZERO32): void {
  let e = changetype<CtfFilled>(newMockEvent()); prep(e, CTF_EX, li)
  fillParams(e, maker, taker, side, tokenId, mA, tA, fee, builder); handleOrderFilled(e)
}
function mgFill(maker: Address, taker: Address, side: i32, tokenId: BigInt, mA: i64, tA: i64, fee: i64, li: i32): void {
  let e = changetype<MgFilled>(newMockEvent()); prep(e, MG_EX, li)
  fillParams(e, maker, taker, side, tokenId, mA, tA, fee, ZERO32); handleOrderFilledMigratable(e)
}
function fid(li: i32): string { return TX.concatI32(li).toHexString() }

describe("token id decoding", () => {
  test("binary V2: module 1, conditionId = id & ~0xff, outcome 0/1", () => {
    let y = decodeTokenId(bi(BIN_YES))
    assert.i32Equals(1, y.module)
    assert.stringEquals(BIN_COND, (y.conditionId as Bytes).toHexString())
    assert.i32Equals(0, y.outcomeIndex)
    let n = decodeTokenId(bi(BIN_YES).plus(BigInt.fromI32(1)))
    assert.stringEquals(BIN_COND, (n.conditionId as Bytes).toHexString())
    assert.i32Equals(1, n.outcomeIndex)
  })
  test("neg-risk V2: module 2, arity/conditionIndex preserved", () => {
    let x = decodeTokenId(bi(NR_TOK))
    assert.i32Equals(2, x.module)
    assert.stringEquals(NR_COND, (x.conditionId as Bytes).toHexString())
    assert.i32Equals(0, x.outcomeIndex)
  })
  test("combinatorial V2: module 3", () => {
    let x = decodeTokenId(hexToBI(COMBO_TOK_HEX))
    assert.i32Equals(3, x.module)
    assert.stringEquals("0x031a0905ba1a97372a4be534811851def1000000000000000000000000000000", (x.conditionId as Bytes).toHexString())
    assert.i32Equals(1, x.outcomeIndex)
  })
  test("V1 CTF id with top byte 0x02 is NOT treated as V2 (reserved bits non-zero)", () => {
    let x = decodeTokenId(bi(V1_TOP02))
    assert.i32Equals(0, x.module)
    assert.assertTrue(x.conditionId === null)
  })
  test("ordinary V1 CTF id -> module 0, null conditionId", () => {
    let x = decodeTokenId(bi(V1_SMALL))
    assert.i32Equals(0, x.module)
    assert.assertTrue(x.conditionId === null)
  })
  test("toBytes32 left-pads and round-trips", () => {
    assert.stringEquals("0x0000000000000000000000000000000000000000000000000000000000000100", (toBytes32(BigInt.fromI32(256)) as Bytes).toHexString())
    assert.stringEquals(BIN_COND.slice(0, 64), (toBytes32(bi(BIN_YES)) as Bytes).toHexString().slice(0, 64))
  })
})

describe("fill accounting", () => {
  beforeEach(() => { clearStore(); setTradeTimeseriesEnabled(false) })

  test("COMPLEMENTARY maker fill + taker fill: volume/trades counted once (old mapping double-counted), fees from both, exchange is not an Account", () => {
    let tok = bi(V1_SMALL)
    // Alice (maker) SELLs 100 tokens @0.60 to Bob; Bob's taker BUY order fill (taker = exchange).
    ctfFill(ALICE, BOB, 1, tok, 100000000, 60000000, 1000, 10)
    ctfFill(BOB, CTF_EX, 0, tok, 60000000, 100000000, 2000, 11)
    assert.fieldEquals("GlobalStats", GLOBAL, "tradesQuantity", "1")
    assert.fieldEquals("GlobalStats", GLOBAL, "takerFillsQuantity", "1")
    assert.fieldEquals("GlobalStats", GLOBAL, "collateralVolume", "60000000")
    assert.fieldEquals("GlobalStats", GLOBAL, "collateralFees", "3000")
    assert.fieldEquals("GlobalStats", GLOBAL, "tradersCount", "2")
    assert.fieldEquals("Market", V1_SMALL, "tradesQuantity", "1")
    assert.fieldEquals("Market", V1_SMALL, "sellsQuantity", "1")
    assert.fieldEquals("Market", V1_SMALL, "collateralVolume", "60000000")
    assert.fieldEquals("Market", V1_SMALL, "collateralFees", "3000")
    assert.fieldEquals("Market", V1_SMALL, "lastPrice", "0.6")
    assert.fieldEquals("Market", V1_SMALL, "module", "0")
    assert.notInStore("Account", CTF_EX.toHexString())
    assert.fieldEquals("Account", ALICE.toHexString(), "tradesQuantity", "1")
    assert.fieldEquals("Account", ALICE.toHexString(), "sellsQuantity", "1")
    assert.fieldEquals("Account", ALICE.toHexString(), "collateralVolume", "60000000")
    assert.fieldEquals("Account", BOB.toHexString(), "tradesQuantity", "1")
    assert.fieldEquals("Account", BOB.toHexString(), "buysQuantity", "1")
    assert.fieldEquals("Account", BOB.toHexString(), "collateralVolume", "60000000")
    assert.fieldEquals("Account", BOB.toHexString(), "collateralFees", "2000")
    assert.fieldEquals("OrderFilledEvent", fid(10), "isTakerFill", "false")
    assert.fieldEquals("OrderFilledEvent", fid(11), "isTakerFill", "true")
    assert.fieldEquals("OrderFilledEvent", fid(11), "taker", CTF_EX.toHexString())
    assert.fieldEquals("OrderFilledEvent", fid(10), "netCollateral", "60000000")
    assert.fieldEquals("OrderFilledEvent", fid(11), "netCollateral", "0")
    assert.fieldEquals("OrderFilledEvent", fid(10), "exchange", "CTF")
  })

  test("two makers vs one taker: trades = 2, volume = sum of maker fills", () => {
    let tok = bi(V1_SMALL)
    ctfFill(ALICE, BOB, 1, tok, 50000000, 25000000, 0, 1)
    ctfFill(CAROL, BOB, 1, tok, 50000000, 26000000, 0, 2)
    ctfFill(BOB, CTF_EX, 0, tok, 51000000, 100000000, 0, 3)
    assert.fieldEquals("GlobalStats", GLOBAL, "tradesQuantity", "2")
    assert.fieldEquals("GlobalStats", GLOBAL, "collateralVolume", "51000000")
    assert.fieldEquals("Account", BOB.toHexString(), "collateralVolume", "51000000")
    assert.fieldEquals("Account", BOB.toHexString(), "tradesQuantity", "1")
    assert.fieldEquals("Market", V1_SMALL, "lastPrice", "0.51")
  })

  test("neg-risk exchange tags NEG_RISK and taker detection uses the emitting exchange", () => {
    let e = changetype<NrFilled>(newMockEvent()); prep(e, NR_EX, 5)
    fillParams(e, ALICE, NR_EX, 0, bi(NR_TOK), 30000000, 100000000, 0, ZERO32); handleOrderFilledNegRisk(e)
    assert.fieldEquals("OrderFilledEvent", fid(5), "exchange", "NEG_RISK")
    assert.fieldEquals("OrderFilledEvent", fid(5), "isTakerFill", "true")
    assert.fieldEquals("OrderFilledEvent", fid(5), "conditionId", NR_COND)
    assert.fieldEquals("Market", NR_TOK, "module", "2")
    // a taker fill with no preceding maker fills is all net
    assert.fieldEquals("GlobalStats", GLOBAL, "tradesQuantity", "1")
    assert.fieldEquals("GlobalStats", GLOBAL, "collateralVolume", "30000000")
  })

  test("MERGE (both SELL, complement tokens): taker proceeds are new volume", () => {
    let yes = bi(BIN_YES); let no = yes.plus(BigInt.fromI32(1))
    // Alice sells 10 NO for 3.5; Bob (taker) sells 10 YES for 6.5
    ctfFill(ALICE, BOB, 1, no, 10000000, 3500000, 0, 1)
    ctfFill(BOB, CTF_EX, 1, yes, 10000000, 6500000, 0, 2)
    assert.fieldEquals("GlobalStats", GLOBAL, "collateralVolume", "10000000")
    assert.fieldEquals("GlobalStats", GLOBAL, "tradesQuantity", "2")
    assert.fieldEquals("Market", no.toString(), "collateralVolume", "3500000")
    assert.fieldEquals("Market", yes.toString(), "collateralVolume", "6500000")
  })

  test("mixed match: complementary part mirrored, MINT part counted", () => {
    let yes = bi(BIN_YES); let no = yes.plus(BigInt.fromI32(1))
    // taker Bob buys 100 YES for 57.5: Alice sells 50 YES for 30 (complementary),
    // Carol buys 50 NO for 22.5 (mint; Bob pays 27.5 of the split)
    ctfFill(ALICE, BOB, 1, yes, 50000000, 30000000, 0, 1)
    ctfFill(CAROL, BOB, 0, no, 22500000, 50000000, 0, 2)
    ctfFill(BOB, CTF_EX, 0, yes, 57500000, 100000000, 0, 3)
    assert.fieldEquals("OrderFilledEvent", fid(3), "netCollateral", "27500000")
    assert.fieldEquals("GlobalStats", GLOBAL, "collateralVolume", "80000000")
    assert.fieldEquals("Market", yes.toString(), "collateralVolume", "57500000")
    assert.fieldEquals("Market", no.toString(), "collateralVolume", "22500000")
  })

  test("scratch resets across transactions and after each taker fill", () => {
    let tok = bi(V1_SMALL)
    ctfFill(ALICE, BOB, 1, tok, 10000000, 6000000, 0, 1)
    ctfFill(BOB, CTF_EX, 0, tok, 6000000, 10000000, 0, 2)
    // second match in the same tx: pure taker fill must not reuse the first match's makers
    ctfFill(CAROL, CTF_EX, 0, tok, 4000000, 10000000, 0, 3)
    assert.fieldEquals("OrderFilledEvent", fid(3), "netCollateral", "4000000")
    assert.fieldEquals("GlobalStats", GLOBAL, "collateralVolume", "10000000")
  })

  test("builder stats: per order fill, taker fill included", () => {
    let tok = bi(V1_SMALL)
    ctfFill(ALICE, BOB, 1, tok, 100000000, 60000000, 0, 1)
    ctfFill(BOB, CTF_EX, 0, tok, 60000000, 100000000, 500, 2, BUILDER)
    assert.fieldEquals("Builder", BUILDER.toHexString(), "orderCount", "1")
    assert.fieldEquals("Builder", BUILDER.toHexString(), "volume", "60000000")
    assert.fieldEquals("Builder", BUILDER.toHexString(), "fees", "500")
    assert.fieldEquals("GlobalStats", GLOBAL, "buildersCount", "1")
  })

  test("zero tokenAmount -> price 0, no crash", () => {
    ctfFill(ALICE, BOB, 0, bi(V1_SMALL), 0, 0, 0, 1)
    assert.fieldEquals("OrderFilledEvent", fid(1), "price", "0")
  })

  test("self-trade (maker == taker) counts the account once and tradersCount once", () => {
    ctfFill(ALICE, ALICE, 1, bi(V1_SMALL), 10000000, 5000000, 0, 1)
    assert.fieldEquals("Account", ALICE.toHexString(), "tradesQuantity", "1")
    assert.fieldEquals("GlobalStats", GLOBAL, "tradersCount", "1")
  })
})

describe("MigratableExchange (V2 PositionManager tokens)", () => {
  beforeEach(() => { clearStore(); setTradeTimeseriesEnabled(false) })

  test("binary V2 fill: MIGRATABLE tag, conditionId joins OI MarketOpenInterest.id", () => {
    let yes = bi(BIN_YES)
    mgFill(ALICE, BOB, 1, yes, 10000000, 4200000, 0, 7)
    assert.fieldEquals("OrderFilledEvent", fid(7), "exchange", "MIGRATABLE")
    assert.fieldEquals("OrderFilledEvent", fid(7), "module", "1")
    assert.fieldEquals("OrderFilledEvent", fid(7), "conditionId", BIN_COND)
    assert.fieldEquals("OrderFilledEvent", fid(7), "outcomeIndex", "0")
    assert.fieldEquals("Market", BIN_YES, "conditionId", BIN_COND)
    assert.fieldEquals("Market", BIN_YES, "outcomeIndex", "0")
    assert.fieldEquals("Market", BIN_YES, "lastPrice", "0.42")
  })

  test("real MINT tx 0x6fe9737d (block 97610012): 3 maker BUYs on NO + taker BUY on YES = 1313.424277 volume", () => {
    let yes = hexToBI("0x03c5d864783f9f182ff1df6886ed6026b7000000000000000000000000000000")
    let no = yes.plus(BigInt.fromI32(1))
    let m1 = Address.fromString("0x4f288a89cab0aa1673eacc96be43868a887ae9f3")
    let m2 = Address.fromString("0x0e879626cb4c130bf24b96e874f149bc299a2171")
    let m3 = Address.fromString("0x7a0da16a1205ee51a56fa862e8baa61e350eff14")
    let tk = Address.fromString("0x810595730183751c3c3f65824518f46cd5723287")
    mgFill(m1, tk, 0, no, 6197984, 24440000, 0, 264)
    mgFill(m2, tk, 0, no, 3471648, 13760000, 0, 266)
    mgFill(m3, tk, 0, no, 316000576, 1275224277, 0, 268)
    mgFill(tk, MG_EX, 0, yes, 987754069, 1313424277, 12245930, 280)
    assert.fieldEquals("GlobalStats", GLOBAL, "collateralVolume", "1313424277")
    assert.fieldEquals("GlobalStats", GLOBAL, "tradesQuantity", "4")
    assert.fieldEquals("GlobalStats", GLOBAL, "collateralFees", "12245930")
    assert.fieldEquals("Market", yes.toString(), "collateralVolume", "987754069")
    assert.fieldEquals("Market", yes.toString(), "module", "3")
    assert.fieldEquals("Account", tk.toHexString(), "collateralVolume", "987754069")
    assert.notInStore("Account", MG_EX.toHexString())
  })

  test("combinatorial fill + matched: module 3, no crash, OrdersMatched creates no Account", () => {
    let combo = hexToBI(COMBO_TOK_HEX)
    mgFill(ALICE, BOB, 0, combo, 4991977, 5510000, 0, 1)
    mgFill(BOB, MG_EX, 1, combo, 5510000, 4991977, 0, 2)
    let m = changetype<MgMatched>(newMockEvent()); prep(m, MG_EX, 3)
    m.parameters = [
      new ethereum.EventParam("takerOrderHash", ethereum.Value.fromFixedBytes(ZERO32)),
      new ethereum.EventParam("takerOrderMaker", ethereum.Value.fromAddress(CAROL)),
      new ethereum.EventParam("side", ethereum.Value.fromI32(1)),
      new ethereum.EventParam("tokenId", ethereum.Value.fromUnsignedBigInt(combo)),
      new ethereum.EventParam("makerAmountFilled", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(5510000))),
      new ethereum.EventParam("takerAmountFilled", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(4991977))),
    ]
    handleOrdersMatchedMigratable(m)
    let id = combo.toString()
    assert.fieldEquals("Market", id, "module", "3")
    assert.fieldEquals("Market", id, "tradesQuantity", "1")
    assert.fieldEquals("OrdersMatchedEvent", fid(3), "exchange", "MIGRATABLE")
    assert.fieldEquals("OrdersMatchedEvent", fid(3), "market", id)
    assert.notInStore("Account", CAROL.toHexString())
    assert.notInStore("Account", MG_EX.toHexString())
  })
})

describe("CTF OrdersMatched", () => {
  beforeEach(() => { clearStore(); setTradeTimeseriesEnabled(false) })
  test("stores Bytes id, takerOrderMaker as Bytes", () => {
    let m = changetype<CtfMatched>(newMockEvent()); prep(m, CTF_EX, 9)
    m.parameters = [
      new ethereum.EventParam("takerOrderHash", ethereum.Value.fromFixedBytes(ZERO32)),
      new ethereum.EventParam("takerOrderMaker", ethereum.Value.fromAddress(BOB)),
      new ethereum.EventParam("side", ethereum.Value.fromI32(0)),
      new ethereum.EventParam("tokenId", ethereum.Value.fromUnsignedBigInt(bi(V1_SMALL))),
      new ethereum.EventParam("makerAmountFilled", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(1))),
      new ethereum.EventParam("takerAmountFilled", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(2))),
    ]
    handleOrdersMatched(m)
    assert.fieldEquals("OrdersMatchedEvent", fid(9), "takerOrderMaker", BOB.toHexString())
    assert.fieldEquals("OrdersMatchedEvent", fid(9), "exchange", "CTF")
  })
})
