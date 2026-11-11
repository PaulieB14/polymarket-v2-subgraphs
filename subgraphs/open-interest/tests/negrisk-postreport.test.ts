import { assert, beforeEach, clearStore, describe, test } from "matchstick-as/assembly/index"
import { BigInt } from "@graphprotocol/graph-ts"
import { MarketOpenInterest } from "../generated/schema"
import { setupEvent, split, convert, report, redeemAmounts, usdc, raw, globalRaw, eq } from "./nr-helpers"

function yes(cid: string): BigInt { return MarketOpenInterest.load(cid)!.yesSupplyRaw }
function no(cid: string): BigInt { return MarketOpenInterest.load(cid)!.noSupplyRaw }

// Reproduces 0xb623c291... (Polygon): q reported NO at block 52037643, then 66
// conversions minted 99,390.98 YES on it that the mapping skipped; holders later
// redeemed that YES for $0 and yesSupply went to -97,992.95.
describe("supplies after OutcomeReported", () => {
  beforeEach(() => { clearStore() })

  test("YES minted by a conversion after NO report is credited, so $0 redemption cannot go negative", () => {
    let ev = setupEvent(40, 3, 0)
    for (let i = 0; i < 3; i++) split(ev, i, usdc(10))
    report(ev, 1, false)
    convert(ev, BigInt.fromI32(0x1), usdc(50)) // NO q0 -> YES q1 (already lost), YES q2
    let amtBefore = raw(ev, 1)
    redeemAmounts(ev, 1, usdc(60), BigInt.zero(), BigInt.zero()) // worthless YES redeemed for $0
    eq(BigInt.zero(), yes(ev.cid(1)), "q1 yesSupply")
    eq(usdc(10), no(ev.cid(1)), "q1 noSupply")
    eq(amtBefore, raw(ev, 1), "q1 collateral amount unchanged by the supply fix")
    assert.assertTrue(!yes(ev.cid(1)).lt(BigInt.zero()), "no negative yes")
    eq(usdc(30), globalRaw(), "global unchanged")
  })

  test("NO burned by a conversion after YES report is debited from noSupply", () => {
    let ev = setupEvent(41, 2, 0)
    split(ev, 0, usdc(10))
    split(ev, 1, usdc(10))
    report(ev, 0, true)
    convert(ev, BigInt.fromI32(0x1), usdc(4)) // NO q0 (already worthless) burned
    eq(usdc(6), no(ev.cid(0)), "q0 noSupply")
    eq(usdc(14), yes(ev.cid(1)), "q1 yesSupply")
  })
})
