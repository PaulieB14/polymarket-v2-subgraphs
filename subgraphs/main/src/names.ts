import { BigInt, Bytes } from "@graphprotocol/graph-ts"

export const TITLE_MAX = 200

function isDigit(c: i32): boolean { return c >= 48 && c <= 57 }

// Earliest index >= from of any terminator, or -1.
function firstOf(s: string, terms: string[], from: i32): i32 {
  let best = -1
  for (let i = 0; i < terms.length; i++) {
    let j = s.indexOf(terms[i], from)
    if (j >= 0 && (best < 0 || j < best)) best = j
  }
  return best
}

// Cap length without leaving a dangling UTF-16 high surrogate.
export function capTitle(s: string): string {
  if (s.length <= TITLE_MAX) return s
  let out = s.substring(0, TITLE_MAX)
  let last = out.charCodeAt(out.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) out = out.substring(0, out.length - 1)
  return out
}

// Extract the title after `prefix` (e.g. "title:" or "question:") up to ", description:".
// Never splits on a plain comma: titles contain commas ("… - November 5, 12:40PM-12:45PM ET").
// If there is no description, stops at a trailing ", id:", ", market_id:" or ",initializer:".
export function extractTitle(text: string, prefix: string): string | null {
  let p = text.indexOf(prefix)
  if (p < 0) return null
  let start = p + prefix.length
  let end = text.indexOf(", description:", start)
  if (end < 0) {
    end = firstOf(text, [", market_id:", ", id:", ",initializer:", ", initializer:"], start)
  }
  if (end < 0) end = text.length
  let t = text.substring(start, end).trim()
  // drop NULs / control chars from odd bytes
  let clean = ""
  for (let i = 0; i < t.length; i++) {
    let c = t.charCodeAt(i)
    if (c >= 32 && c != 127) clean += t.charAt(i)
  }
  clean = clean.trim()
  if (clean.length == 0) return null
  return capTitle(clean)
}

// Gamma id: "market_id: <n>" (UMA) or a trailing ", id: <n>" (negRisk). Last occurrence wins.
export function extractGammaId(text: string): BigInt | null {
  let key = "market_id:"
  let p = text.lastIndexOf(key)
  if (p < 0) {
    key = ", id:"
    p = text.lastIndexOf(key)
  }
  if (p < 0) return null
  let i = p + key.length
  while (i < text.length && text.charCodeAt(i) == 32) i++
  let j = i
  while (j < text.length && j - i < 20 && isDigit(text.charCodeAt(j))) j++
  if (j == i) return null
  return BigInt.fromString(text.substring(i, j))
}

export function bytesToText(b: Bytes): string {
  return b.toString()
}
