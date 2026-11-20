import { BigInt, Bytes } from "@graphprotocol/graph-ts"

// Polymarket V2 PositionManager position ids (Polymarket/polymarket-v2-external docs/position-ids.md):
// [moduleId(8) | baseHash(128) | arity(16) | reserved(64) | resolutionChain(16) | conditionIndex(16) | outcomeIndex(8)]
// conditionId = positionId with outcomeIndex = 0 (== OI MarketOpenInterest.id).
// V1 CTF position ids are keccak-derived; ~1.2% of them have a top byte of 1..3, so the
// module byte alone is not enough. The 64 reserved bits (40..103) are zero for every V2 id
// produced by the current encoders and are uniformly random for V1 ids (false-positive
// probability ~2^-64).

export const MODULE_V1: i32 = 0
export const MODULE_BINARY: i32 = 1
export const MODULE_NEG_RISK: i32 = 2
export const MODULE_COMBINATORIAL: i32 = 3

export class TokenInfo {
  module: i32
  conditionId: Bytes | null
  outcomeIndex: i32
  constructor(module: i32, conditionId: Bytes | null, outcomeIndex: i32) {
    this.module = module
    this.conditionId = conditionId
    this.outcomeIndex = outcomeIndex
  }
}

/** 32-byte big-endian encoding of a uint256 BigInt. Returns null if it does not fit. */
export function toBytes32(v: BigInt): Bytes | null {
  // graph-ts BigInt is little-endian two's complement; may carry a sign byte.
  let le = v as Uint8Array
  let n = le.length
  while (n > 0 && le[n - 1] == 0) n--
  if (n > 32) return null
  let out = new Bytes(32)
  for (let i = 0; i < n; i++) out[31 - i] = le[i]
  return out
}

export function decodeTokenId(tokenId: BigInt): TokenInfo {
  if (tokenId.lt(BigInt.zero())) return new TokenInfo(MODULE_V1, null, -1)
  let be = toBytes32(tokenId)
  if (be === null) return new TokenInfo(MODULE_V1, null, -1)
  let b = be as Bytes
  let module = b[0] as i32
  if (module < MODULE_BINARY || module > MODULE_COMBINATORIAL) return new TokenInfo(MODULE_V1, null, -1)
  // reserved bits 40..103 -> big-endian bytes 19..26
  for (let i = 19; i <= 26; i++) {
    if (b[i] != 0) return new TokenInfo(MODULE_V1, null, -1)
  }
  let cond = new Bytes(32)
  for (let i = 0; i < 31; i++) cond[i] = b[i]
  cond[31] = 0
  return new TokenInfo(module, cond, b[31] as i32)
}
