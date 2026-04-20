import { BigInt, BigDecimal, Address } from "@graphprotocol/graph-ts"
import {
  OrderFilled as CtfOrderFilledEvent,
} from "../generated/CtfExchangeV2/CtfExchangeV2"
import {
  OrderFilled as NegRiskOrderFilledEvent,
} from "../generated/NegRiskCtfExchangeV2/NegRiskCtfExchangeV2"
import {
  Account,
  UserPosition,
  Market,
} from "../generated/schema"

const USDC_UNIT = BigDecimal.fromString("1000000")
const SIDE_BUY: i32 = 0
const SIDE_SELL: i32 = 1

const CTF_EXCHANGE = Address.fromString("0xe111180000d2663c0091e4f400237545b87b996b")
const NEG_RISK_EXCHANGE = Address.fromString("0xe2222d279d744050d28e00520010520000310f59")

function isExchangeContract(addr: Address): boolean {
  return addr.equals(CTF_EXCHANGE) || addr.equals(NEG_RISK_EXCHANGE)
}

function scale(amount: BigInt): BigDecimal {
  return amount.toBigDecimal().div(USDC_UNIT)
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
    a.realizedPnl = BigDecimal.zero()
    a.lastTradedTimestamp = BigInt.zero()
  }
  return a as Account
}

function positionId(user: Address, tokenId: BigInt): string {
  return user.toHexString() + "-" + tokenId.toString()
}

function getOrCreatePosition(user: Address, tokenId: BigInt): UserPosition {
  let id = positionId(user, tokenId)
  let p = UserPosition.load(id)
  if (p == null) {
    p = new UserPosition(id)
    p.account = user.toHexString()
    p.tokenId = tokenId
    p.amount = BigInt.zero()
    p.avgPrice = BigDecimal.zero()
    p.totalBought = BigInt.zero()
    p.totalSold = BigInt.zero()
    p.realizedPnl = BigDecimal.zero()
    p.lastUpdatedTimestamp = BigInt.zero()
  }
  return p as UserPosition
}

function getOrCreateMarket(tokenId: BigInt): Market {
  let id = tokenId.toString()
  let m = Market.load(id)
  if (m == null) {
    m = new Market(id)
    m.tokenId = tokenId
    m.fills = BigInt.zero()
    m.collateralVolume = BigInt.zero()
    m.scaledCollateralVolume = BigDecimal.zero()
    m.lastPrice = BigDecimal.zero()
    m.lastActiveTimestamp = BigInt.zero()
  }
  return m as Market
}

// Apply one side of a fill to a single user. effectiveSide is that user's perspective.
// BUY  => user received tokens, paid collateral. Update cost basis (weighted avg).
// SELL => user gave tokens, received collateral. Realize P&L against existing position.
function applyTradeToUser(
  user: Address,
  effectiveSide: i32,
  collateralAmount: BigInt,
  tokenAmount: BigInt,
  price: BigDecimal,
  tokenId: BigInt,
  timestamp: BigInt
): void {
  // Skip exchange contracts — they appear as maker/taker in matchOrders flows
  if (isExchangeContract(user)) {
    return
  }

  let account = getOrCreateAccount(user)
  let position = getOrCreatePosition(user, tokenId)

  if (effectiveSide == SIDE_BUY) {
    let oldNotional = position.amount.toBigDecimal().times(position.avgPrice)
    let addNotional = tokenAmount.toBigDecimal().times(price)
    let newAmount = position.amount.plus(tokenAmount)
    position.avgPrice = newAmount.equals(BigInt.zero())
      ? BigDecimal.zero()
      : oldNotional.plus(addNotional).div(newAmount.toBigDecimal())
    position.amount = newAmount
    position.totalBought = position.totalBought.plus(tokenAmount)
    account.buysQuantity = account.buysQuantity.plus(BigInt.fromI32(1))
  } else {
    // Realized P&L clamped to current holdings to prevent negative balance
    let soldAgainstHolding = position.amount.lt(tokenAmount) ? position.amount : tokenAmount
    let pnlDelta = price.minus(position.avgPrice).times(soldAgainstHolding.toBigDecimal())
    position.realizedPnl = position.realizedPnl.plus(pnlDelta)
    account.realizedPnl = account.realizedPnl.plus(pnlDelta)
    position.amount = position.amount.minus(soldAgainstHolding)
    position.totalSold = position.totalSold.plus(tokenAmount)
    account.sellsQuantity = account.sellsQuantity.plus(BigInt.fromI32(1))
  }
  position.lastUpdatedTimestamp = timestamp
  position.save()

  account.tradesQuantity = account.tradesQuantity.plus(BigInt.fromI32(1))
  account.collateralVolume = account.collateralVolume.plus(collateralAmount)
  account.scaledCollateralVolume = scale(account.collateralVolume)
  account.lastTradedTimestamp = timestamp
  account.save()
}

function applyFill(
  maker: Address,
  taker: Address,
  makerSide: i32,
  tokenId: BigInt,
  makerAmountFilled: BigInt,
  takerAmountFilled: BigInt,
  timestamp: BigInt
): void {
  let collateralAmount = makerSide == SIDE_BUY ? makerAmountFilled : takerAmountFilled
  let tokenAmount = makerSide == SIDE_BUY ? takerAmountFilled : makerAmountFilled
  let price = tokenAmount.equals(BigInt.zero())
    ? BigDecimal.zero()
    : collateralAmount.toBigDecimal().div(tokenAmount.toBigDecimal())

  // Maker sees the trade as-is
  applyTradeToUser(maker, makerSide, collateralAmount, tokenAmount, price, tokenId, timestamp)
  // Taker sees the opposite side
  let takerSide = makerSide == SIDE_BUY ? SIDE_SELL : SIDE_BUY
  applyTradeToUser(taker, takerSide, collateralAmount, tokenAmount, price, tokenId, timestamp)

  let market = getOrCreateMarket(tokenId)
  market.fills = market.fills.plus(BigInt.fromI32(1))
  market.collateralVolume = market.collateralVolume.plus(collateralAmount)
  market.scaledCollateralVolume = scale(market.collateralVolume)
  market.lastPrice = price
  market.lastActiveTimestamp = timestamp
  market.save()
}

export function handleOrderFilled(event: CtfOrderFilledEvent): void {
  applyFill(
    event.params.maker,
    event.params.taker,
    event.params.side,
    event.params.tokenId,
    event.params.makerAmountFilled,
    event.params.takerAmountFilled,
    event.block.timestamp
  )
}

export function handleOrderFilledNegRisk(event: NegRiskOrderFilledEvent): void {
  applyFill(
    event.params.maker,
    event.params.taker,
    event.params.side,
    event.params.tokenId,
    event.params.makerAmountFilled,
    event.params.takerAmountFilled,
    event.block.timestamp
  )
}
