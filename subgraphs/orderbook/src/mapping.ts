import { BigInt, BigDecimal, Address, Bytes } from "@graphprotocol/graph-ts"
import {
  OrderFilled as CtfOrderFilledEvent,
  OrdersMatched as CtfOrdersMatchedEvent,
} from "../generated/CtfExchangeV2/CtfExchangeV2"
import {
  OrderFilled as NegRiskOrderFilledEvent,
  OrdersMatched as NegRiskOrdersMatchedEvent,
} from "../generated/NegRiskCtfExchangeV2/NegRiskCtfExchangeV2"
import {
  OrderFilledEvent,
  OrdersMatchedEvent,
  Account,
  Market,
  GlobalStats,
  Builder,
} from "../generated/schema"

const USDC_UNIT = BigDecimal.fromString("1000000")
const GLOBAL_ID = "global"
const SIDE_BUY: i32 = 0
const ZERO_BUILDER = Bytes.fromHexString("0x0000000000000000000000000000000000000000000000000000000000000000")

function scale(amount: BigInt): BigDecimal {
  return amount.toBigDecimal().div(USDC_UNIT)
}

function getOrCreateGlobal(): GlobalStats {
  let g = GlobalStats.load(GLOBAL_ID)
  if (g == null) {
    g = new GlobalStats(GLOBAL_ID)
    g.tradesQuantity = BigInt.zero()
    g.buysQuantity = BigInt.zero()
    g.sellsQuantity = BigInt.zero()
    g.collateralVolume = BigInt.zero()
    g.scaledCollateralVolume = BigDecimal.zero()
    g.collateralFees = BigInt.zero()
    g.scaledCollateralFees = BigDecimal.zero()
    g.tradersCount = BigInt.zero()
    g.marketsCount = BigInt.zero()
    g.buildersCount = BigInt.zero()
  }
  return g as GlobalStats
}

function getOrCreateAccount(address: Address): Account {
  let id = address.toHexString()
  let a = Account.load(id)
  if (a == null) {
    a = new Account(id)
    a.tradesQuantity = BigInt.zero()
    a.buysQuantity = BigInt.zero()
    a.sellsQuantity = BigInt.zero()
    a.collateralVolume = BigInt.zero()
    a.scaledCollateralVolume = BigDecimal.zero()
    a.lastTradedTimestamp = BigInt.zero()
    let g = getOrCreateGlobal()
    g.tradersCount = g.tradersCount.plus(BigInt.fromI32(1))
    g.save()
  }
  return a as Account
}

function getOrCreateMarket(tokenId: BigInt): Market {
  let id = tokenId.toString()
  let m = Market.load(id)
  if (m == null) {
    m = new Market(id)
    m.tokenId = tokenId
    m.tradesQuantity = BigInt.zero()
    m.buysQuantity = BigInt.zero()
    m.sellsQuantity = BigInt.zero()
    m.collateralVolume = BigInt.zero()
    m.scaledCollateralVolume = BigDecimal.zero()
    m.collateralFees = BigInt.zero()
    m.scaledCollateralFees = BigDecimal.zero()
    m.lastPrice = BigDecimal.zero()
    m.lastActiveTimestamp = BigInt.zero()
    let g = getOrCreateGlobal()
    g.marketsCount = g.marketsCount.plus(BigInt.fromI32(1))
    g.save()
  }
  return m as Market
}

function getOrCreateBuilder(code: Bytes, timestamp: BigInt): Builder | null {
  if (code.equals(ZERO_BUILDER)) {
    return null
  }
  let id = code.toHexString()
  let b = Builder.load(id)
  if (b == null) {
    b = new Builder(id)
    b.orderCount = BigInt.zero()
    b.volume = BigInt.zero()
    b.scaledVolume = BigDecimal.zero()
    b.fees = BigInt.zero()
    b.scaledFees = BigDecimal.zero()
    b.firstSeenTimestamp = timestamp
    b.lastSeenTimestamp = timestamp
    let g = getOrCreateGlobal()
    g.buildersCount = g.buildersCount.plus(BigInt.fromI32(1))
    g.save()
  }
  return b
}

function recordFill(
  txHash: Bytes,
  logIndex: BigInt,
  timestamp: BigInt,
  blockNumber: BigInt,
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
  let makerAccount = getOrCreateAccount(maker)
  let takerAccount = getOrCreateAccount(taker)
  let market = getOrCreateMarket(tokenId)

  // BUY:  maker pays collateral, receives tokens. makerAmount = collateral, takerAmount = tokens.
  // SELL: maker pays tokens, receives collateral. makerAmount = tokens, takerAmount = collateral.
  let collateralAmount = side == SIDE_BUY ? makerAmountFilled : takerAmountFilled
  let tokenAmount = side == SIDE_BUY ? takerAmountFilled : makerAmountFilled
  let price = tokenAmount.equals(BigInt.zero())
    ? BigDecimal.zero()
    : collateralAmount.toBigDecimal().div(tokenAmount.toBigDecimal())

  let id = txHash.toHexString() + "-" + logIndex.toString()
  let ev = new OrderFilledEvent(id)
  ev.transactionHash = txHash
  ev.timestamp = timestamp
  ev.blockNumber = blockNumber
  ev.orderHash = orderHash
  ev.maker = makerAccount.id
  ev.taker = takerAccount.id
  ev.side = side
  ev.market = market.id
  ev.tokenId = tokenId
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
  ev.save()

  market.tradesQuantity = market.tradesQuantity.plus(BigInt.fromI32(1))
  if (side == SIDE_BUY) {
    market.buysQuantity = market.buysQuantity.plus(BigInt.fromI32(1))
  } else {
    market.sellsQuantity = market.sellsQuantity.plus(BigInt.fromI32(1))
  }
  market.collateralVolume = market.collateralVolume.plus(collateralAmount)
  market.scaledCollateralVolume = scale(market.collateralVolume)
  market.collateralFees = market.collateralFees.plus(fee)
  market.scaledCollateralFees = scale(market.collateralFees)
  market.lastPrice = price
  market.lastActiveTimestamp = timestamp
  market.save()

  let accounts: Account[] = [makerAccount, takerAccount]
  for (let i = 0; i < accounts.length; i++) {
    let acc = accounts[i]
    acc.tradesQuantity = acc.tradesQuantity.plus(BigInt.fromI32(1))
    if (side == SIDE_BUY) {
      acc.buysQuantity = acc.buysQuantity.plus(BigInt.fromI32(1))
    } else {
      acc.sellsQuantity = acc.sellsQuantity.plus(BigInt.fromI32(1))
    }
    acc.collateralVolume = acc.collateralVolume.plus(collateralAmount)
    acc.scaledCollateralVolume = scale(acc.collateralVolume)
    acc.lastTradedTimestamp = timestamp
    acc.save()
  }

  let b = getOrCreateBuilder(builder, timestamp)
  if (b != null) {
    b.orderCount = b.orderCount.plus(BigInt.fromI32(1))
    b.volume = b.volume.plus(collateralAmount)
    b.scaledVolume = scale(b.volume)
    b.fees = b.fees.plus(fee)
    b.scaledFees = scale(b.fees)
    b.lastSeenTimestamp = timestamp
    b.save()
  }

  let g = getOrCreateGlobal()
  g.tradesQuantity = g.tradesQuantity.plus(BigInt.fromI32(1))
  if (side == SIDE_BUY) {
    g.buysQuantity = g.buysQuantity.plus(BigInt.fromI32(1))
  } else {
    g.sellsQuantity = g.sellsQuantity.plus(BigInt.fromI32(1))
  }
  g.collateralVolume = g.collateralVolume.plus(collateralAmount)
  g.scaledCollateralVolume = scale(g.collateralVolume)
  g.collateralFees = g.collateralFees.plus(fee)
  g.scaledCollateralFees = scale(g.collateralFees)
  g.save()
}

export function handleOrderFilled(event: CtfOrderFilledEvent): void {
  recordFill(
    event.transaction.hash,
    event.logIndex,
    event.block.timestamp,
    event.block.number,
    event.params.orderHash,
    event.params.maker,
    event.params.taker,
    event.params.side,
    event.params.tokenId,
    event.params.makerAmountFilled,
    event.params.takerAmountFilled,
    event.params.fee,
    event.params.builder,
    event.params.metadata,
    "CTF"
  )
}

export function handleOrderFilledNegRisk(event: NegRiskOrderFilledEvent): void {
  recordFill(
    event.transaction.hash,
    event.logIndex,
    event.block.timestamp,
    event.block.number,
    event.params.orderHash,
    event.params.maker,
    event.params.taker,
    event.params.side,
    event.params.tokenId,
    event.params.makerAmountFilled,
    event.params.takerAmountFilled,
    event.params.fee,
    event.params.builder,
    event.params.metadata,
    "NEG_RISK"
  )
}

function recordMatched(
  txHash: Bytes,
  logIndex: BigInt,
  timestamp: BigInt,
  blockNumber: BigInt,
  takerOrderHash: Bytes,
  takerOrderMaker: Address,
  side: i32,
  tokenId: BigInt,
  makerAmountFilled: BigInt,
  takerAmountFilled: BigInt,
  exchange: string
): void {
  let account = getOrCreateAccount(takerOrderMaker)
  let market = getOrCreateMarket(tokenId)
  let id = txHash.toHexString() + "-" + logIndex.toString()
  let ev = new OrdersMatchedEvent(id)
  ev.transactionHash = txHash
  ev.timestamp = timestamp
  ev.blockNumber = blockNumber
  ev.takerOrderHash = takerOrderHash
  ev.takerOrderMaker = account.id
  ev.side = side
  ev.market = market.id
  ev.tokenId = tokenId
  ev.makerAmountFilled = makerAmountFilled
  ev.takerAmountFilled = takerAmountFilled
  ev.exchange = exchange
  ev.save()
}

export function handleOrdersMatched(event: CtfOrdersMatchedEvent): void {
  recordMatched(
    event.transaction.hash,
    event.logIndex,
    event.block.timestamp,
    event.block.number,
    event.params.takerOrderHash,
    event.params.takerOrderMaker,
    event.params.side,
    event.params.tokenId,
    event.params.makerAmountFilled,
    event.params.takerAmountFilled,
    "CTF"
  )
}

export function handleOrdersMatchedNegRisk(event: NegRiskOrdersMatchedEvent): void {
  recordMatched(
    event.transaction.hash,
    event.logIndex,
    event.block.timestamp,
    event.block.number,
    event.params.takerOrderHash,
    event.params.takerOrderMaker,
    event.params.side,
    event.params.tokenId,
    event.params.makerAmountFilled,
    event.params.takerAmountFilled,
    "NEG_RISK"
  )
}
