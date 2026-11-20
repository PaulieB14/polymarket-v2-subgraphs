import { BigInt, BigDecimal, Address, Bytes, ethereum } from "@graphprotocol/graph-ts"
import { OrderFilled as CtfOrderFilledEvent } from "../generated/CtfExchangeV2/CtfExchangeV2"
import { OrderFilled as NegRiskOrderFilledEvent } from "../generated/NegRiskCtfExchangeV2/NegRiskCtfExchangeV2"
import { OrderFilled as MigratableOrderFilledEvent } from "../generated/MigratableExchange/MigratableExchange"
import {
  OrderFilledEvent,
  Account,
  Market,
  GlobalStats,
  Builder,
  Trade,
  MatchScratch,
} from "../generated/schema"
import { decodeTokenId, marketId, TokenInfo } from "./ids"

const USDC_UNIT = BigDecimal.fromString("1000000")
export const GLOBAL_ID = Bytes.fromUTF8("global")
const SIDE_BUY: i32 = 0
const ONE = BigInt.fromI32(1)
const ZERO_BUILDER = Bytes.fromHexString("0x0000000000000000000000000000000000000000000000000000000000000000")

// Matchstick (0.6.0, latest) cannot store the `Timestamp` type used by timeseries entities,
// so unit tests switch the Trade write off. Always true in deployed builds.
let tradeTimeseriesEnabled = true
export function setTradeTimeseriesEnabled(v: bool): void {
  tradeTimeseriesEnabled = v
}

export const EXCHANGE_CTF = "CTF"
export const EXCHANGE_NEG_RISK = "NEG_RISK"
export const EXCHANGE_MIGRATABLE = "MIGRATABLE"

function scale(amount: BigInt): BigDecimal {
  return amount.toBigDecimal().div(USDC_UNIT)
}

function eventId(event: ethereum.Event): Bytes {
  return event.transaction.hash.concatI32(event.logIndex.toI32())
}

function loadGlobal(): GlobalStats {
  let g = GlobalStats.load(GLOBAL_ID)
  if (g === null) {
    g = new GlobalStats(GLOBAL_ID)
    g.tradesQuantity = BigInt.zero()
    g.buysQuantity = BigInt.zero()
    g.sellsQuantity = BigInt.zero()
    g.collateralVolume = BigInt.zero()
    g.scaledCollateralVolume = BigDecimal.zero()
    g.collateralFees = BigInt.zero()
    g.scaledCollateralFees = BigDecimal.zero()
    g.takerFillsQuantity = BigInt.zero()
    g.tradersCount = BigInt.zero()
    g.marketsCount = BigInt.zero()
    g.buildersCount = BigInt.zero()
  }
  return g as GlobalStats
}

function loadAccount(address: Address, g: GlobalStats): Account {
  let a = Account.load(address)
  if (a === null) {
    a = new Account(address)
    a.tradesQuantity = BigInt.zero()
    a.buysQuantity = BigInt.zero()
    a.sellsQuantity = BigInt.zero()
    a.collateralVolume = BigInt.zero()
    a.scaledCollateralVolume = BigDecimal.zero()
    a.collateralFees = BigInt.zero()
    a.lastTradedTimestamp = BigInt.zero()
    g.tradersCount = g.tradersCount.plus(ONE)
  }
  return a as Account
}

function loadMarket(tokenId: BigInt, info: TokenInfo, g: GlobalStats): Market {
  let id = marketId(tokenId)
  let m = Market.load(id)
  if (m === null) {
    m = new Market(id)
    m.tokenId = tokenId
    m.clobTokenId = tokenId.toString()
    m.module = info.module
    m.conditionId = info.conditionId
    if (info.conditionId !== null) m.outcomeIndex = info.outcomeIndex
    m.tradesQuantity = BigInt.zero()
    m.buysQuantity = BigInt.zero()
    m.sellsQuantity = BigInt.zero()
    m.collateralVolume = BigInt.zero()
    m.scaledCollateralVolume = BigDecimal.zero()
    m.collateralFees = BigInt.zero()
    m.scaledCollateralFees = BigDecimal.zero()
    m.lastPrice = BigDecimal.zero()
    m.lastActiveTimestamp = BigInt.zero()
    m.lastActiveBlock = BigInt.zero()
    g.marketsCount = g.marketsCount.plus(ONE)
  }
  return m as Market
}

function loadScratch(exchange: Address, tx: Bytes): MatchScratch {
  let s = MatchScratch.load(exchange)
  if (s === null) {
    s = new MatchScratch(exchange)
    s.transactionHash = tx
    resetScratch(s as MatchScratch, tx)
  } else if (!s.transactionHash.equals(tx)) {
    resetScratch(s as MatchScratch, tx)
  }
  return s as MatchScratch
}

function resetScratch(s: MatchScratch, tx: Bytes): void {
  s.transactionHash = tx
  s.buyCollateral = BigInt.zero()
  s.sellCollateral = BigInt.zero()
  s.buyTokens = BigInt.zero()
  s.sellTokens = BigInt.zero()
}

export function recordFill(
  event: ethereum.Event,
  orderHash: Bytes,
  maker: Address,
  taker: Address,
  side: i32,
  tokenId: BigInt,
  makerAmountFilled: BigInt,
  takerAmountFilled: BigInt,
  fee: BigInt,
  builder: Bytes,
  metadata: Bytes,
  exchange: string
): void {
  let timestamp = event.block.timestamp
  let g = loadGlobal()
  let info = decodeTokenId(tokenId)
  let market = loadMarket(tokenId, info, g)
  let owner = loadAccount(maker, g)
  // The taker order's own OrderFilled names the exchange contract as taker.
  let isTakerFill = taker.equals(event.address)

  // BUY:  order pays collateral, receives tokens. makerAmount = collateral, takerAmount = tokens.
  // SELL: order pays tokens, receives collateral. makerAmount = tokens, takerAmount = collateral.
  let isBuy = side == SIDE_BUY
  let collateralAmount = isBuy ? makerAmountFilled : takerAmountFilled
  let tokenAmount = isBuy ? takerAmountFilled : makerAmountFilled
  let price = tokenAmount.isZero()
    ? BigDecimal.zero()
    : collateralAmount.toBigDecimal().div(tokenAmount.toBigDecimal())

  let ev = new OrderFilledEvent(eventId(event))
  ev.transactionHash = event.transaction.hash
  ev.logIndex = event.logIndex
  ev.timestamp = timestamp
  ev.blockNumber = event.block.number
  ev.orderHash = orderHash
  ev.maker = owner.id
  ev.taker = taker
  ev.isTakerFill = isTakerFill
  ev.side = side
  ev.market = market.id
  ev.tokenId = tokenId
  ev.module = info.module
  ev.conditionId = info.conditionId
  if (info.conditionId !== null) ev.outcomeIndex = info.outcomeIndex
  ev.makerAmountFilled = makerAmountFilled
  ev.takerAmountFilled = takerAmountFilled
  ev.collateralAmount = collateralAmount
  ev.tokenAmount = tokenAmount
  ev.price = price
  ev.size = scale(tokenAmount)
  ev.fee = fee
  ev.builder = builder
  ev.metadata = metadata
  ev.exchange = exchange

  // Fees: every fill (maker fees on maker fills, taker fee on the taker fill).
  market.collateralFees = market.collateralFees.plus(fee)
  market.scaledCollateralFees = scale(market.collateralFees)
  g.collateralFees = g.collateralFees.plus(fee)
  g.scaledCollateralFees = scale(g.collateralFees)
  market.lastPrice = price
  market.lastActiveTimestamp = timestamp
  market.lastActiveBlock = event.block.number

  // Net collateral this fill adds to volume.
  let scratch = loadScratch(event.address, event.transaction.hash)
  let netCollateral = collateralAmount
  let netTokens = tokenAmount
  if (isTakerFill) {
    // Complementary makers are on the opposite side of the taker; the taker fill mirrors them.
    let compCol = isBuy ? scratch.sellCollateral : scratch.buyCollateral
    let compTok = isBuy ? scratch.sellTokens : scratch.buyTokens
    netCollateral = collateralAmount.gt(compCol) ? collateralAmount.minus(compCol) : BigInt.zero()
    netTokens = tokenAmount.gt(compTok) ? tokenAmount.minus(compTok) : BigInt.zero()
    resetScratch(scratch, event.transaction.hash)
    g.takerFillsQuantity = g.takerFillsQuantity.plus(ONE)
  } else if (isBuy) {
    scratch.buyCollateral = scratch.buyCollateral.plus(collateralAmount)
    scratch.buyTokens = scratch.buyTokens.plus(tokenAmount)
  } else {
    scratch.sellCollateral = scratch.sellCollateral.plus(collateralAmount)
    scratch.sellTokens = scratch.sellTokens.plus(tokenAmount)
  }
  scratch.save()
  ev.netCollateral = netCollateral
  ev.save()

  if (!isTakerFill || !netCollateral.isZero()) {
    market.tradesQuantity = market.tradesQuantity.plus(ONE)
    g.tradesQuantity = g.tradesQuantity.plus(ONE)
    if (isBuy) {
      market.buysQuantity = market.buysQuantity.plus(ONE)
      g.buysQuantity = g.buysQuantity.plus(ONE)
    } else {
      market.sellsQuantity = market.sellsQuantity.plus(ONE)
      g.sellsQuantity = g.sellsQuantity.plus(ONE)
    }
    market.collateralVolume = market.collateralVolume.plus(netCollateral)
    market.scaledCollateralVolume = scale(market.collateralVolume)
    g.collateralVolume = g.collateralVolume.plus(netCollateral)
    g.scaledCollateralVolume = scale(g.collateralVolume)

    if (tradeTimeseriesEnabled) {
      let tr = new Trade(0)
      tr.timestamp = timestamp.toI64() * 1000000
      tr.market = market.id
      tr.module = info.module
      tr.exchange = exchange
      tr.price = price
      tr.collateral = scale(netCollateral)
      tr.tokens = scale(netTokens)
      tr.save()
    }
  }
  market.save()

  // Account = owner of the filled order (maker field). Taker is credited via its own taker fill.
  owner.tradesQuantity = owner.tradesQuantity.plus(ONE)
  if (isBuy) owner.buysQuantity = owner.buysQuantity.plus(ONE)
  else owner.sellsQuantity = owner.sellsQuantity.plus(ONE)
  owner.collateralVolume = owner.collateralVolume.plus(collateralAmount)
  owner.scaledCollateralVolume = scale(owner.collateralVolume)
  owner.collateralFees = owner.collateralFees.plus(fee)
  owner.lastTradedTimestamp = timestamp
  owner.save()

  if (!builder.equals(ZERO_BUILDER)) {
    let b = Builder.load(builder)
    if (b === null) {
      b = new Builder(builder)
      b.orderCount = BigInt.zero()
      b.volume = BigInt.zero()
      b.scaledVolume = BigDecimal.zero()
      b.fees = BigInt.zero()
      b.scaledFees = BigDecimal.zero()
      b.firstSeenTimestamp = timestamp
      g.buildersCount = g.buildersCount.plus(ONE)
    }
    b.orderCount = b.orderCount.plus(ONE)
    b.volume = b.volume.plus(collateralAmount)
    b.scaledVolume = scale(b.volume)
    b.fees = b.fees.plus(fee)
    b.scaledFees = scale(b.fees)
    b.lastSeenTimestamp = timestamp
    b.save()
  }

  g.save()
}

export function handleOrderFilled(event: CtfOrderFilledEvent): void {
  let p = event.params
  recordFill(event, p.orderHash, p.maker, p.taker, p.side, p.tokenId, p.makerAmountFilled,
    p.takerAmountFilled, p.fee, p.builder, p.metadata, EXCHANGE_CTF)
}

export function handleOrderFilledNegRisk(event: NegRiskOrderFilledEvent): void {
  let p = event.params
  recordFill(event, p.orderHash, p.maker, p.taker, p.side, p.tokenId, p.makerAmountFilled,
    p.takerAmountFilled, p.fee, p.builder, p.metadata, EXCHANGE_NEG_RISK)
}

export function handleOrderFilledMigratable(event: MigratableOrderFilledEvent): void {
  let p = event.params
  recordFill(event, p.orderHash, p.maker, p.taker, p.side, p.tokenId, p.makerAmountFilled,
    p.takerAmountFilled, p.fee, p.builder, p.metadata, EXCHANGE_MIGRATABLE)
}
