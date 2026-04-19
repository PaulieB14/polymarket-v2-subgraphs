import { BigInt, BigDecimal, Address, Bytes } from "@graphprotocol/graph-ts"
import {
  OrderFilled as CtfOrderFilledEvent,
} from "../generated/CtfExchangeV2/CtfExchangeV2"
import {
  OrderFilled as NegRiskOrderFilledEvent,
} from "../generated/NegRiskCtfExchangeV2/NegRiskCtfExchangeV2"
import {
  TransferSingle,
} from "../generated/ConditionalTokens/ConditionalTokens"
import {
  Account,
  UserPosition,
  MarketStats,
} from "../generated/schema"

const USDC_UNIT = BigDecimal.fromString("1000000")
const SIDE_BUY: i32 = 0

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

function getOrCreateMarket(tokenId: BigInt): MarketStats {
  let id = tokenId.toString()
  let m = MarketStats.load(id)
  if (m == null) {
    m = new MarketStats(id)
    m.tokenId = tokenId
    m.fills = BigInt.zero()
    m.collateralVolume = BigInt.zero()
    m.scaledCollateralVolume = BigDecimal.zero()
    m.lastPrice = BigDecimal.zero()
    m.lastActiveTimestamp = BigInt.zero()
  }
  return m as MarketStats
}

// Apply a buy/sell against the buyer's position.
// side==BUY:  buyer pays collateral, receives tokens. maker's buyer state = buying.
// side==SELL: buyer sells tokens, receives collateral.
// NOTE: Polymarket has both makers and takers. We update the MAKER's position here;
// the taker position flows through TransferSingle on the CTF contract naturally.
function applyFill(
  maker: Address,
  side: i32,
  tokenId: BigInt,
  makerAmountFilled: BigInt,
  takerAmountFilled: BigInt,
  fee: BigInt,
  timestamp: BigInt
): void {
  let account = getOrCreateAccount(maker)
  let position = getOrCreatePosition(maker, tokenId)
  let market = getOrCreateMarket(tokenId)

  let collateralAmount: BigInt
  let tokenAmount: BigInt
  if (side == SIDE_BUY) {
    collateralAmount = makerAmountFilled
    tokenAmount = takerAmountFilled
  } else {
    collateralAmount = takerAmountFilled
    tokenAmount = makerAmountFilled
  }

  let price = tokenAmount.equals(BigInt.zero())
    ? BigDecimal.zero()
    : collateralAmount.toBigDecimal().div(tokenAmount.toBigDecimal())

  if (side == SIDE_BUY) {
    // weighted avg cost basis
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
    // realized P&L on the portion sold (clamped to current holdings to avoid negative balance)
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
    event.params.side,
    event.params.tokenId,
    event.params.makerAmountFilled,
    event.params.takerAmountFilled,
    event.params.fee,
    event.block.timestamp
  )
}

export function handleOrderFilledNegRisk(event: NegRiskOrderFilledEvent): void {
  applyFill(
    event.params.maker,
    event.params.side,
    event.params.tokenId,
    event.params.makerAmountFilled,
    event.params.takerAmountFilled,
    event.params.fee,
    event.block.timestamp
  )
}

// Track non-trade position moves (merges, redemptions, P2P transfers).
// Only updates EXISTING positions — we don't create new UserPosition rows for tokens
// that have never been traded, to avoid indexing every CTF 1155 holder ever.
export function handleTransferSingle(event: TransferSingle): void {
  let from = event.params.from
  let to = event.params.to
  let tokenId = event.params.id
  let value = event.params.value
  let zero = Address.zero()

  if (!from.equals(zero)) {
    let fromPos = UserPosition.load(positionId(from, tokenId))
    if (fromPos != null) {
      fromPos.amount = fromPos.amount.minus(value)
      if (fromPos.amount.lt(BigInt.zero())) {
        fromPos.amount = BigInt.zero()
      }
      fromPos.lastUpdatedTimestamp = event.block.timestamp
      fromPos.save()
    }
  }

  if (!to.equals(zero)) {
    let toPos = UserPosition.load(positionId(to, tokenId))
    if (toPos != null) {
      toPos.amount = toPos.amount.plus(value)
      toPos.lastUpdatedTimestamp = event.block.timestamp
      toPos.save()
    }
  }
}
