import { assert, beforeEach, clearStore, describe, test } from "matchstick-as/assembly/index"
import { BigInt } from "@graphprotocol/graph-ts"
import { NegRiskQuestion } from "../generated/schema"
import {
  setupEvent, split, merge, convert, redeem, report, usdc, raw, globalRaw, marketCount, sumRaw, eq, noNegative, nextBlock, marketIdFor, prepareEvent, addQuestion,
} from "./nr-helpers"

function bits(n: i32): BigInt {
  return BigInt.fromI32(n)
}

describe("negRisk convert rules", () => {
  beforeEach(() => {
    clearStore()
  })

  test("single NO: converted question debited, every other question credited, global unchanged", () => {
    let ev = setupEvent(1, 3, 0)
    for (let i = 0; i < 3; i++) split(ev, i, usdc(100))
    convert(ev, bits(0x1), usdc(40))
    eq(usdc(60), raw(ev, 0), "q0")
    eq(usdc(140), raw(ev, 1), "q1")
    eq(usdc(140), raw(ev, 2), "q2")
    eq(usdc(300), globalRaw(), "global")
  })

  test("multi NO: each converted question debited, complement credited, global -(k-1)*amount", () => {
    let ev = setupEvent(2, 4, 0)
    for (let i = 0; i < 4; i++) split(ev, i, usdc(50))
    convert(ev, bits(0x7), usdc(10))
    eq(usdc(40), raw(ev, 0), "q0")
    eq(usdc(40), raw(ev, 2), "q2")
    eq(usdc(60), raw(ev, 3), "q3")
    eq(usdc(180), globalRaw(), "global")
  })

  test("all NO: every question debited, nothing credited, global -(n-1)*amount", () => {
    let ev = setupEvent(3, 3, 0)
    for (let i = 0; i < 3; i++) split(ev, i, usdc(20))
    convert(ev, bits(0x7), usdc(5))
    for (let i = 0; i < 3; i++) eq(usdc(15), raw(ev, i), "q" + i.toString())
    eq(usdc(50), globalRaw(), "global")
  })

  test("fee on/off gives identical per-question and global OI", () => {
    let a = setupEvent(4, 3, 0)
    let b = setupEvent(5, 3, 250)
    for (let i = 0; i < 3; i++) {
      split(a, i, usdc(30))
      split(b, i, usdc(30))
    }
    convert(a, bits(0x3), BigInt.fromI64(7777777))
    convert(b, bits(0x3), BigInt.fromI64(7777777))
    for (let i = 0; i < 3; i++) eq(raw(a, i), raw(b, i), "q" + i.toString())
    eq(BigInt.fromI64(2 * 90000000 - 2 * 7777777), globalRaw(), "global over both events")
  })

  test("zero amount or empty indexSet is a no-op and creates no market", () => {
    let ev = setupEvent(6, 3, 0)
    split(ev, 0, usdc(10))
    convert(ev, bits(0x1), BigInt.zero())
    convert(ev, bits(0x0), usdc(5))
    assert.notInStore("MarketOpenInterest", ev.cid(1))
    assert.notInStore("MarketOpenInterest", ev.cid(2))
    assert.entityCount("NegRiskQuestion", 0)
    eq(usdc(10), raw(ev, 0), "q0")
    assert.i32Equals(1, marketCount())
  })

  test("crediting a question with no splits creates exactly one market for it", () => {
    let ev = setupEvent(7, 3, 0)
    split(ev, 0, usdc(10))
    convert(ev, bits(0x1), usdc(4))
    convert(ev, bits(0x1), usdc(1))
    assert.i32Equals(3, marketCount())
    assert.entityCount("MarketOpenInterest", 3)
    eq(usdc(5), raw(ev, 1), "q1 minted YES")
  })

  test("large amounts (1e12 USDC per op) do not overflow", () => {
    let ev = setupEvent(8, 3, 0)
    let big = BigInt.fromString("1000000000000000000") // 1e12 USDC
    for (let i = 0; i < 3; i++) split(ev, i, big)
    convert(ev, bits(0x3), big)
    eq(BigInt.zero(), raw(ev, 0), "q0")
    eq(big.times(BigInt.fromI32(2)), raw(ev, 2), "q2")
    eq(big.times(BigInt.fromI32(2)), globalRaw(), "global")
  })
})

describe("negRisk OutcomeReported settlement", () => {
  beforeEach(() => {
    clearStore()
  })

  test("full lifecycle settles every question to 0 and matches global", () => {
    let ev = setupEvent(10, 3, 0)
    for (let i = 0; i < 3; i++) split(ev, i, usdc(100))
    convert(ev, bits(0x1), usdc(40)) // NO q0 -> YES q1,q2
    convert(ev, bits(0x3), usdc(30)) // NO q0,q1 -> YES q2
    noNegative(ev, "before resolution")
    report(ev, 0, false)
    report(ev, 1, false)
    report(ev, 2, true)
    noNegative(ev, "after reports")
    eq(globalRaw(), sumRaw(ev), "sum per-question == global after resolution")
    // user balances: YES q2 = 100+40+30 = 170 ; NO q0 = 100-40-30 = 30 ; NO q1 = 100-30 = 70
    redeem(ev, 2, usdc(170))
    redeem(ev, 0, usdc(30))
    redeem(ev, 1, usdc(70))
    for (let i = 0; i < 3; i++) eq(BigInt.zero(), raw(ev, i), "q" + i.toString())
    eq(BigInt.zero(), globalRaw(), "global")
  })

  test("winner that had NO burned gets the debit back on YES report", () => {
    let ev = setupEvent(11, 2, 0)
    split(ev, 0, usdc(10))
    split(ev, 1, usdc(10))
    convert(ev, bits(0x1), usdc(10)) // NO q0 burned -> YES q1
    eq(BigInt.zero(), raw(ev, 0), "q0 after convert")
    report(ev, 0, true) // q0 wins: its burned NO was worthless
    eq(usdc(10), raw(ev, 0), "q0 after YES report")
    let q = NegRiskQuestion.load(ev.cid(0))!
    assert.i32Equals(1, q.outcome)
    eq(BigInt.zero(), q.burnedRaw, "burned settled")
  })

  test("converting after a question has lost: no credit to the lost question", () => {
    let ev = setupEvent(12, 3, 0)
    for (let i = 0; i < 3; i++) split(ev, i, usdc(10))
    report(ev, 1, false)
    convert(ev, bits(0x1), usdc(5)) // complements q1 (lost) and q2
    eq(usdc(10), raw(ev, 1), "lost q1 not credited")
    eq(usdc(15), raw(ev, 2), "q2 credited")
    eq(usdc(5), raw(ev, 0), "q0 debited")
  })

  test("converting NO of an already-won question: no debit", () => {
    let ev = setupEvent(13, 3, 0)
    for (let i = 0; i < 3; i++) split(ev, i, usdc(10))
    report(ev, 0, true)
    report(ev, 1, false)
    convert(ev, bits(0x1), usdc(4)) // worthless NO on winner q0 -> YES on lost q1 + q2
    eq(usdc(10), raw(ev, 0), "won q0 not debited")
    eq(usdc(10), raw(ev, 1), "lost q1 not credited")
    eq(usdc(14), raw(ev, 2), "q2 credited")
  })

  test("report before any activity creates no market; later activity settles", () => {
    let ev = setupEvent(14, 2, 0)
    report(ev, 0, false)
    assert.entityCount("MarketOpenInterest", 0)
    assert.i32Equals(0, marketCount())
    split(ev, 0, usdc(5))
    split(ev, 1, usdc(5))
    convert(ev, bits(0x2), usdc(5)) // NO q1 -> YES q0 (lost: no credit)
    report(ev, 1, true)
    redeem(ev, 1, usdc(5)) // YES q1
    redeem(ev, 0, usdc(5)) // NO q0
    eq(BigInt.zero(), raw(ev, 0), "q0")
    eq(BigInt.zero(), raw(ev, 1), "q1")
    eq(BigInt.zero(), globalRaw(), "global")
    assert.i32Equals(2, marketCount())
  })

  test("duplicate or unknown-market reports are ignored", () => {
    let ev = setupEvent(15, 2, 0)
    split(ev, 0, usdc(5))
    split(ev, 1, usdc(5))
    convert(ev, bits(0x1), usdc(2))
    report(ev, 1, false)
    let after = raw(ev, 1)
    report(ev, 1, false)
    report(ev, 1, true)
    eq(after, raw(ev, 1), "second/third report ignored")
    let other = prepareEvent(marketIdFor(99), 0)
    other.marketId = marketIdFor(98) // never prepared
    addQuestion(other)
    report(other, 0, true)
    assert.notInStore("NegRiskQuestion", other.cid(0))
  })

  test("repeated conversions accumulate and settle exactly", () => {
    let ev = setupEvent(16, 4, 100)
    for (let i = 0; i < 4; i++) split(ev, i, usdc(1000))
    let yes = [1000, 1000, 1000, 1000] as i64[]
    let no = [1000, 1000, 1000, 1000] as i64[]
    for (let r = 0; r < 25; r++) {
      let set = (r % 15) + 1
      let amt: i64 = 7 + r
      for (let i = 0; i < 4; i++) {
        if ((set >> i) & 1) no[i] -= amt
        else yes[i] += amt
      }
      convert(ev, bits(set), usdc(amt))
      noNegative(ev, "round " + r.toString())
      nextBlock()
    }
    report(ev, 2, true)
    report(ev, 0, false)
    report(ev, 1, false)
    report(ev, 3, false)
    eq(globalRaw(), sumRaw(ev), "sum == global")
    redeem(ev, 2, usdc(yes[2]))
    redeem(ev, 0, usdc(no[0]))
    redeem(ev, 1, usdc(no[1]))
    redeem(ev, 3, usdc(no[3]))
    for (let i = 0; i < 4; i++) eq(BigInt.zero(), raw(ev, i), "q" + i.toString())
    eq(BigInt.zero(), globalRaw(), "global")
  })

  test("same-block ordering: report then convert (by logIndex) settles", () => {
    let ev = setupEvent(17, 3, 0)
    for (let i = 0; i < 3; i++) split(ev, i, usdc(10))
    // all in one block, report first
    report(ev, 2, false)
    convert(ev, bits(0x1), usdc(3))
    report(ev, 1, false)
    report(ev, 0, true)
    // balances: NO q0 7 (worthless), YES q0 10; q1 NO 10, YES 13 (worthless); q2 NO 10, YES 13(worthless)
    redeem(ev, 0, usdc(10))
    redeem(ev, 1, usdc(10))
    redeem(ev, 2, usdc(10))
    for (let i = 0; i < 3; i++) eq(BigInt.zero(), raw(ev, i), "q" + i.toString())
    eq(BigInt.zero(), globalRaw(), "global")
  })

  test("merge after conversion and partial redemptions stay non-negative", () => {
    let ev = setupEvent(18, 2, 0)
    split(ev, 0, usdc(10))
    split(ev, 1, usdc(10))
    convert(ev, bits(0x1), usdc(4)) // NO q0 4 burned; YES q1 +4
    merge(ev, 0, usdc(6)) // remaining NO q0 = 6 pairs with 6 YES q0
    merge(ev, 1, usdc(10))
    noNegative(ev, "after merges")
    report(ev, 1, true)
    report(ev, 0, false)
    redeem(ev, 1, usdc(2))
    redeem(ev, 1, usdc(2))
    eq(BigInt.zero(), raw(ev, 1), "q1")
    eq(BigInt.zero(), raw(ev, 0), "q0")
    eq(BigInt.zero(), globalRaw(), "global")
  })
})
