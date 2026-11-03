// Property-style randomized tests: random but token-valid sequences of splits,
// merges, conversions (single/multi/all NO, before and after reports), outcome
// reports in random order, and full redemption. Invariants checked:
//  P1 no question ever goes negative (after every event)
//  P2 after every question is reported, sum(per-question) == global
//  P3 after full redemption every question and the global are exactly 0
//  P4 global always equals the token-model collateral (splits - merges - released - payouts)
import { assert, clearStore, describe, test, log } from "matchstick-as/assembly/index"
import { BigInt } from "@graphprotocol/graph-ts"
import { setupEvent, split, merge, convert, redeem, report, raw, globalRaw, sumRaw, eq, noNegative, nextBlock, NrEvent } from "./nr-helpers"

let seed: u64 = 0x9e3779b97f4a7c15
function rnd(n: i32): i32 {
  seed ^= seed << 13
  seed ^= seed >> 7
  seed ^= seed << 17
  return (seed % (n as u64)) as i32
}
function amountUpTo(max: i64): i64 {
  if (max <= 0) return 0
  let pick = rnd(4)
  let a: i64 = pick == 0 ? 1 : pick == 1 ? (rnd(1000000) as i64) + 1 : (((rnd(1000000) as i64) + 1) * ((rnd(1000) as i64) + 1))
  return a > max ? max : a
}

function runTrial(trial: i32): void {
  clearStore()
  let n = 2 + rnd(7) // 2..8 questions
  let fee = rnd(3) == 0 ? rnd(500) : 0
  let ev: NrEvent = setupEvent(trial, n, fee)
  let yes: i64[] = []
  let no: i64[] = []
  let outcome: i32[] = [] // 0 open, 1 won, 2 lost
  for (let i = 0; i < n; i++) {
    yes.push(0)
    no.push(0)
    outcome.push(0)
  }
  let winner = rnd(n)
  let collateral: i64 = 0
  let reported = 0
  let steps = 40 + rnd(80)
  for (let s = 0; s < steps; s++) {
    let op = rnd(10)
    if (op < 4) {
      let q = rnd(n)
      let a = amountUpTo(1000000000000)
      if (a == 0) continue
      yes[q] += a
      no[q] += a
      collateral += a
      split(ev, q, BigInt.fromI64(a))
    } else if (op < 5) {
      let q = rnd(n)
      let m = yes[q] < no[q] ? yes[q] : no[q]
      let a = amountUpTo(m)
      if (a == 0) continue
      yes[q] -= a
      no[q] -= a
      collateral -= a
      merge(ev, q, BigInt.fromI64(a))
    } else if (op < 8) {
      let set = 0
      let minNo: i64 = 9223372036854775807
      let k = 0
      let mode = rnd(3) // 0 single, 1 random subset, 2 all
      for (let i = 0; i < n; i++) {
        let inSet = mode == 2 ? true : mode == 0 ? false : rnd(2) == 1
        if (inSet) {
          set |= 1 << i
          k++
          if (no[i] < minNo) minNo = no[i]
        }
      }
      if (mode == 0) {
        let i = rnd(n)
        set = 1 << i
        k = 1
        minNo = no[i]
      }
      if (k == 0) continue
      let a = amountUpTo(minNo)
      if (a == 0) continue
      for (let i = 0; i < n; i++) {
        if ((set >> i) & 1) no[i] -= a
        else yes[i] += a
      }
      collateral -= (k - 1) * a
      convert(ev, BigInt.fromI32(set), BigInt.fromI64(a))
    } else if (op < 9 && reported < n) {
      // report a random open question (winner reported YES)
      let q = rnd(n)
      if (outcome[q] != 0) continue
      outcome[q] = q == winner ? 1 : 2
      reported++
      report(ev, q, q == winner)
    } else {
      // partial redemption on a reported question
      let q = rnd(n)
      if (outcome[q] == 0) continue
      let bal = outcome[q] == 1 ? yes[q] : no[q]
      let a = amountUpTo(bal)
      if (a == 0) continue
      if (outcome[q] == 1) yes[q] -= a
      else no[q] -= a
      collateral -= a
      redeem(ev, q, BigInt.fromI64(a))
    }
    noNegative(ev, "trial " + trial.toString() + " step " + s.toString())
    eq(BigInt.fromI64(collateral), globalRaw(), "P4 trial " + trial.toString())
    if (rnd(3) == 0) nextBlock()
  }
  for (let q = 0; q < n; q++) {
    if (outcome[q] == 0) {
      outcome[q] = q == winner ? 1 : 2
      report(ev, q, q == winner)
      noNegative(ev, "trial " + trial.toString() + " late report")
    }
  }
  eq(globalRaw(), sumRaw(ev), "P2 trial " + trial.toString())
  for (let q = 0; q < n; q++) {
    let bal = outcome[q] == 1 ? yes[q] : no[q]
    if (bal > 0) {
      collateral -= bal
      redeem(ev, q, BigInt.fromI64(bal))
    }
  }
  for (let q = 0; q < n; q++) eq(BigInt.zero(), raw(ev, q), "P3 trial " + trial.toString() + " q" + q.toString())
  eq(BigInt.zero(), globalRaw(), "P3 global trial " + trial.toString())
  assert.assertTrue(collateral == 0, "token model collateral returns to 0")
}

describe("negRisk randomized sequences", () => {
  test("300 random events: P1-P4 hold", () => {
    for (let t = 0; t < 300; t++) runTrial(t)
    log.info("ran 300 randomized neg-risk events", [])
  })
})
