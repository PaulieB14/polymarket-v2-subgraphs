import { BigInt, BigDecimal, Address, Bytes } from "@graphprotocol/graph-ts"
import {
  ConditionPreparation,
  ConditionResolution,
  PositionSplit,
  PositionsMerge,
  PayoutRedemption,
  ConditionalTokens,
} from "../generated/ConditionalTokens/ConditionalTokens"
import {
  OrderFilled as CtfOrderFilled,
  OrdersMatched as CtfOrdersMatched,
} from "../generated/CtfExchangeV2/CtfExchangeV2"
import {
  OrderFilled as NegOrderFilled,
  OrdersMatched as NegOrdersMatched,
} from "../generated/NegRiskCtfExchangeV2/NegRiskCtfExchangeV2"
import {
  Global,
  OrdersMatchedGlobal,
  Account,
  Collateral,
  Condition,
  Split,
  Merge,
  Redemption,
  MarketData,
  MarketPosition,
  MarketProfit,
  Transaction,
  OrderFilledEvent,
  OrdersMatchedEvent,
  EnrichedOrderFilled,
  Orderbook,
  Builder,
} from "../generated/schema"

const GLOBAL_ID = ""
const USDC_UNIT = BigDecimal.fromString("1000000")
const ZERO_BD = BigDecimal.zero()
const ZERO_BI = BigInt.zero()
const ONE_BI = BigInt.fromI32(1)
const SIDE_BUY: i32 = 0
const SIDE_SELL: i32 = 1
const DAY_SECONDS = BigInt.fromI32(86400)

const CTF_ADDRESS = Address.fromString("0x4D97DCd97eC945f40cF65F87097ACe5EA0476045")
const CTF_EXCHANGE_V2 = Address.fromString("0xe111180000d2663c0091e4f400237545b87b996b")
const NEG_RISK_EXCHANGE_V2 = Address.fromString("0xe2222d279d744050d28e00520010520000310f59")
const USDC_E = Address.fromString("0x2791bca1f2de4661ed88a30c99a7a9449aa84174")
const ZERO_BYTES32 = Bytes.fromHexString("0x0000000000000000000000000000000000000000000000000000000000000000")

function isExchange(addr: Address): boolean {
  return addr.equals(CTF_EXCHANGE_V2) || addr.equals(NEG_RISK_EXCHANGE_V2)
}

function scale(amount: BigInt): BigDecimal {
  return amount.toBigDecimal().div(USDC_UNIT)
}

function getOrCreateGlobal(block_num: BigInt, block_ts: BigInt): Global {
  let g = Global.load(GLOBAL_ID)
  if (g == null) {
    g = new Global(GLOBAL_ID)
    g.numConditions = 0
    g.numOpenConditions = 0
    g.numClosedConditions = 0
    g.numTraders = ZERO_BI
    g.tradesQuantity = ZERO_BI
    g.buysQuantity = ZERO_BI
    g.sellsQuantity = ZERO_BI
    g.collateralVolume = ZERO_BI
    g.scaledCollateralVolume = ZERO_BD
    g.collateralFees = ZERO_BI
    g.scaledCollateralFees = ZERO_BD
    g.collateralBuyVolume = ZERO_BI
    g.scaledCollateralBuyVolume = ZERO_BD
    g.collateralSellVolume = ZERO_BI
    g.scaledCollateralSellVolume = ZERO_BD
    g.lastUpdatedBlock = block_num
    g.lastUpdatedTimestamp = block_ts
  }
  g.lastUpdatedBlock = block_num
  g.lastUpdatedTimestamp = block_ts
  return g as Global
}

function getOrCreateOrdersMatchedGlobal(): OrdersMatchedGlobal {
  let g = OrdersMatchedGlobal.load(GLOBAL_ID)
  if (g == null) {
    g = new OrdersMatchedGlobal(GLOBAL_ID)
    g.tradesQuantity = ZERO_BI
    g.buysQuantity = ZERO_BI
    g.sellsQuantity = ZERO_BI
    g.collateralVolume = ZERO_BD
    g.scaledCollateralVolume = ZERO_BD
    g.collateralBuyVolume = ZERO_BD
    g.scaledCollateralBuyVolume = ZERO_BD
    g.collateralSellVolume = ZERO_BD
    g.scaledCollateralSellVolume = ZERO_BD
  }
  return g as OrdersMatchedGlobal
}

function getOrCreateAccount(addr: Address, ts: BigInt): Account {
  let id = addr.toHexString()
  let a = Account.load(id)
  if (a == null) {
    a = new Account(id)
    a.creationTimestamp = ts
    a.lastSeenTimestamp = ts
    a.lastTradedTimestamp = ZERO_BI
    a.numTrades = ZERO_BI
    a.collateralVolume = ZERO_BI
    a.scaledCollateralVolume = ZERO_BD
    a.profit = ZERO_BI
    a.scaledProfit = ZERO_BD
  }
  a.lastSeenTimestamp = ts
  return a as Account
}

function getOrCreateCollateral(token: Address): Collateral {
  let id = token.toHexString()
  let c = Collateral.load(id)
  if (c == null) {
    c = new Collateral(id)
    if (token.equals(USDC_E)) {
      c.name = "USD Coin (PoS)"
      c.symbol = "USDC.e"
      c.decimals = 6
    } else {
      c.name = "Unknown"
      c.symbol = "UNKNOWN"
      c.decimals = 18
    }
  }
  return c as Collateral
}

function getOrCreateBuilder(code: Bytes, ts: BigInt): Builder | null {
  if (code.equals(ZERO_BYTES32)) return null
  let id = code.toHexString()
  let b = Builder.load(id)
  if (b == null) {
    b = new Builder(id)
    b.orderCount = ZERO_BI
    b.volume = ZERO_BI
    b.scaledVolume = ZERO_BD
    b.fees = ZERO_BI
    b.scaledFees = ZERO_BD
    b.firstSeenTimestamp = ts
    b.lastSeenTimestamp = ts
  }
  b.lastSeenTimestamp = ts
  return b
}

function getOrCreateOrderbook(tokenId: string, ts: BigInt): Orderbook {
  let ob = Orderbook.load(tokenId)
  if (ob == null) {
    ob = new Orderbook(tokenId)
    ob.tradesQuantity = ZERO_BI
    ob.buysQuantity = ZERO_BI
    ob.sellsQuantity = ZERO_BI
    ob.collateralVolume = ZERO_BI
    ob.scaledCollateralVolume = ZERO_BD
    ob.collateralBuyVolume = ZERO_BI
    ob.scaledCollateralBuyVolume = ZERO_BD
    ob.collateralSellVolume = ZERO_BI
    ob.scaledCollateralSellVolume = ZERO_BD
    ob.lastActiveDay = ZERO_BI
    ob.lastPrice = ZERO_BD
  }
  ob.lastActiveDay = ts.div(DAY_SECONDS)
  return ob as Orderbook
}

function getOrCreateMarketData(tokenId: string): MarketData {
  let m = MarketData.load(tokenId)
  if (m == null) {
    m = new MarketData(tokenId)
    m.priceOrderbook = ZERO_BD
  }
  return m as MarketData
}

function getOrCreateMarketPosition(user: Address, tokenId: string): MarketPosition {
  let id = user.toHexString() + "-" + tokenId
  let p = MarketPosition.load(id)
  if (p == null) {
    p = new MarketPosition(id)
    p.market = tokenId
    p.user = user.toHexString()
    p.quantityBought = ZERO_BI
    p.quantitySold = ZERO_BI
    p.netQuantity = ZERO_BI
    p.valueBought = ZERO_BI
    p.valueSold = ZERO_BI
    p.netValue = ZERO_BI
    p.feesPaid = ZERO_BI
  }
  return p as MarketPosition
}

function getOrCreateMarketProfit(user: Address, conditionId: string): MarketProfit {
  let id = conditionId + "-" + user.toHexString()
  let p = MarketProfit.load(id)
  if (p == null) {
    p = new MarketProfit(id)
    p.user = user.toHexString()
    p.condition = conditionId
    p.profit = ZERO_BI
    p.scaledProfit = ZERO_BD
  }
  return p as MarketProfit
}

export function handleConditionPreparation(event: ConditionPreparation): void {
  let id = event.params.conditionId.toHexString()
  let c = new Condition(id)
  c.oracle = event.params.oracle
  c.questionId = event.params.questionId
  c.outcomeSlotCount = event.params.outcomeSlotCount.toI32()
  c.preparedAtBlock = event.block.number
  c.preparedAtTimestamp = event.block.timestamp
  c.save()

  let g = getOrCreateGlobal(event.block.number, event.block.timestamp)
  g.numConditions = g.numConditions + 1
  g.numOpenConditions = g.numOpenConditions + 1
  g.save()
}

export function handleConditionResolution(event: ConditionResolution): void {
  let id = event.params.conditionId.toHexString()
  let c = Condition.load(id)
  if (c == null) {
    c = new Condition(id)
    c.oracle = event.params.oracle
    c.questionId = event.params.questionId
    c.outcomeSlotCount = event.params.outcomeSlotCount.toI32()
    c.preparedAtBlock = event.block.number
    c.preparedAtTimestamp = event.block.timestamp
  }
  c.payoutNumerators = event.params.payoutNumerators
  let denom = ZERO_BI
  for (let i = 0; i < event.params.payoutNumerators.length; i++) {
    denom = denom.plus(event.params.payoutNumerators[i])
  }
  c.payoutDenominator = denom
  if (denom.gt(ZERO_BI)) {
    let payouts: BigDecimal[] = []
    let denomBD = denom.toBigDecimal()
    for (let i = 0; i < event.params.payoutNumerators.length; i++) {
      payouts.push(event.params.payoutNumerators[i].toBigDecimal().div(denomBD))
    }
    c.payouts = payouts
  }
  c.resolutionTimestamp = event.block.timestamp
  c.resolutionHash = event.transaction.hash
  c.save()

  let g = getOrCreateGlobal(event.block.number, event.block.timestamp)
  if (g.numOpenConditions > 0) {
    g.numOpenConditions = g.numOpenConditions - 1
  }
  g.numClosedConditions = g.numClosedConditions + 1
  g.save()
}

export function handlePositionSplit(event: PositionSplit): void {
  let condId = event.params.conditionId.toHexString()
  let cond = Condition.load(condId)
  if (cond == null) return
  let collat = getOrCreateCollateral(event.params.collateralToken)
  collat.save()
  let acct = getOrCreateAccount(event.params.stakeholder, event.block.timestamp)
  acct.save()

  let id = event.transaction.hash.toHexString() + "-" + event.logIndex.toString()
  let s = new Split(id)
  s.timestamp = event.block.timestamp
  s.stakeholder = acct.id
  s.collateralToken = collat.id
  s.parentCollectionId = event.params.parentCollectionId
  s.condition = condId
  s.partition = event.params.partition
  s.amount = event.params.amount
  s.save()

  let ct = ConditionalTokens.bind(CTF_ADDRESS)
  for (let i = 0; i < event.params.partition.length; i++) {
    let indexSet = event.params.partition[i]
    let coll_res = ct.try_getCollectionId(event.params.parentCollectionId, event.params.conditionId, indexSet)
    if (!coll_res.reverted) {
      let pos_res = ct.try_getPositionId(event.params.collateralToken, coll_res.value)
      if (!pos_res.reverted) {
        let tokenId = pos_res.value.toString()
        let m = getOrCreateMarketData(tokenId)
        m.condition = condId
        m.outcomeIndex = BigInt.fromI32(i)
        m.save()
      }
    }
  }
}

export function handlePositionsMerge(event: PositionsMerge): void {
  let condId = event.params.conditionId.toHexString()
  let cond = Condition.load(condId)
  if (cond == null) return
  let collat = getOrCreateCollateral(event.params.collateralToken)
  collat.save()
  let acct = getOrCreateAccount(event.params.stakeholder, event.block.timestamp)
  acct.save()

  let id = event.transaction.hash.toHexString() + "-" + event.logIndex.toString()
  let m = new Merge(id)
  m.timestamp = event.block.timestamp
  m.stakeholder = acct.id
  m.collateralToken = collat.id
  m.parentCollectionId = event.params.parentCollectionId
  m.condition = condId
  m.partition = event.params.partition
  m.amount = event.params.amount
  m.save()
}

export function handlePayoutRedemption(event: PayoutRedemption): void {
  let condId = event.params.conditionId.toHexString()
  let cond = Condition.load(condId)
  if (cond == null) return
  let collat = getOrCreateCollateral(event.params.collateralToken)
  collat.save()
  let acct = getOrCreateAccount(event.params.redeemer, event.block.timestamp)
  acct.profit = acct.profit.plus(event.params.payout)
  acct.scaledProfit = scale(acct.profit)
  acct.save()

  let mp = getOrCreateMarketProfit(event.params.redeemer, condId)
  mp.profit = mp.profit.plus(event.params.payout)
  mp.scaledProfit = scale(mp.profit)
  mp.save()

  let id = event.transaction.hash.toHexString() + "-" + event.logIndex.toString()
  let r = new Redemption(id)
  r.timestamp = event.block.timestamp
  r.redeemer = acct.id
  r.collateralToken = collat.id
  r.parentCollectionId = event.params.parentCollectionId
  r.condition = condId
  r.indexSets = event.params.indexSets
  r.payout = event.params.payout
  r.save()
}

function applyOrderFilled(
  txHash: Bytes,
  logIndex: BigInt,
  ts: BigInt,
  blockNum: BigInt,
  orderHash: Bytes,
  maker: Address,
  taker: Address,
  side: i32,
  tokenId: BigInt,
  makerAmountFilled: BigInt,
  takerAmountFilled: BigInt,
  fee: BigInt,
  builderCode: Bytes,
  metadata: Bytes
): void {
  return; // STUB
  let collateralAmount: BigInt
  let tokenAmount: BigInt
  if (side == SIDE_BUY) {
    collateralAmount = makerAmountFilled
    tokenAmount = takerAmountFilled
  } else {
    collateralAmount = takerAmountFilled
    tokenAmount = makerAmountFilled
  }
  let price = ZERO_BD
  if (!tokenAmount.equals(ZERO_BI)) {
    price = collateralAmount.toBigDecimal().div(tokenAmount.toBigDecimal())
  }
  let tokenIdStr = tokenId.toString()

  let makerIsEx = isExchange(maker)
  let takerIsEx = isExchange(taker)
  let makerAcct: Account | null = null
  if (!makerIsEx) { makerAcct = getOrCreateAccount(maker, ts) }
  let takerAcct: Account | null = null
  if (!takerIsEx) { takerAcct = getOrCreateAccount(taker, ts) }

  let g = getOrCreateGlobal(blockNum, ts)
  if (makerAcct != null) {
    if ((makerAcct as Account).numTrades.equals(ZERO_BI)) {
      g.numTraders = g.numTraders.plus(ONE_BI)
    }
  }
  if (takerAcct != null) {
    if ((takerAcct as Account).numTrades.equals(ZERO_BI)) {
      g.numTraders = g.numTraders.plus(ONE_BI)
    }
  }

  let eventId = txHash.toHexString() + "-" + logIndex.toString()
  let raw = new OrderFilledEvent(eventId)
  raw.transactionHash = txHash
  raw.timestamp = ts
  raw.orderHash = orderHash
  let makerId = maker.toHexString()
  if (makerAcct != null) { makerId = (makerAcct as Account).id }
  let takerId = taker.toHexString()
  if (takerAcct != null) { takerId = (takerAcct as Account).id }
  raw.maker = makerId
  raw.taker = takerId
  if (side == SIDE_BUY) {
    raw.makerAssetId = "0"
    raw.takerAssetId = tokenIdStr
  } else {
    raw.makerAssetId = tokenIdStr
    raw.takerAssetId = "0"
  }
  raw.makerAmountFilled = makerAmountFilled
  raw.takerAmountFilled = takerAmountFilled
  raw.fee = fee
  raw.builder = builderCode
  raw.metadata = metadata
  raw.save()

  let ob = getOrCreateOrderbook(tokenIdStr, ts)
  ob.tradesQuantity = ob.tradesQuantity.plus(ONE_BI)
  ob.collateralVolume = ob.collateralVolume.plus(collateralAmount)
  ob.scaledCollateralVolume = scale(ob.collateralVolume)
  if (side == SIDE_BUY) {
    ob.buysQuantity = ob.buysQuantity.plus(ONE_BI)
    ob.collateralBuyVolume = ob.collateralBuyVolume.plus(collateralAmount)
    ob.scaledCollateralBuyVolume = scale(ob.collateralBuyVolume)
  } else {
    ob.sellsQuantity = ob.sellsQuantity.plus(ONE_BI)
    ob.collateralSellVolume = ob.collateralSellVolume.plus(collateralAmount)
    ob.scaledCollateralSellVolume = scale(ob.collateralSellVolume)
  }
  ob.lastPrice = price
  ob.save()

  let md = getOrCreateMarketData(tokenIdStr)
  md.priceOrderbook = price
  md.save()

  let enriched = new EnrichedOrderFilled(eventId)
  enriched.transactionHash = txHash
  enriched.timestamp = ts
  enriched.maker = makerId
  enriched.taker = takerId
  enriched.orderHash = orderHash
  enriched.market = tokenIdStr
  let enrichedSide = "Sell"
  if (side == SIDE_BUY) { enrichedSide = "Buy" }
  enriched.side = enrichedSide
  enriched.size = tokenAmount
  enriched.price = price
  enriched.save()

  if (makerAcct != null) {
    let m = makerAcct as Account
    let txn = new Transaction(eventId + "-m")
    let txnType = "Sell"
    if (side == SIDE_BUY) { txnType = "Buy" }
    txn.type = txnType
    txn.timestamp = ts
    txn.market = tokenIdStr
    txn.user = m.id
    txn.tradeAmount = collateralAmount
    txn.feeAmount = fee
    let mdOutcomeIdx = ZERO_BI
    let mdOutcome = md.outcomeIndex
    if (mdOutcome != null) { mdOutcomeIdx = mdOutcome as BigInt }
    txn.outcomeIndex = mdOutcomeIdx
    txn.outcomeTokensAmount = tokenAmount
    txn.save()

    let mp = getOrCreateMarketPosition(maker, tokenIdStr)
    if (side == SIDE_BUY) {
      mp.quantityBought = mp.quantityBought.plus(tokenAmount)
      mp.valueBought = mp.valueBought.plus(collateralAmount)
    } else {
      mp.quantitySold = mp.quantitySold.plus(tokenAmount)
      mp.valueSold = mp.valueSold.plus(collateralAmount)
    }
    mp.netQuantity = mp.quantityBought.minus(mp.quantitySold)
    mp.netValue = mp.valueBought.minus(mp.valueSold)
    mp.feesPaid = mp.feesPaid.plus(fee)
    mp.save()

    m.numTrades = m.numTrades.plus(ONE_BI)
    m.collateralVolume = m.collateralVolume.plus(collateralAmount)
    m.scaledCollateralVolume = scale(m.collateralVolume)
    m.lastTradedTimestamp = ts
    m.save()
  }

  if (takerAcct != null) {
    let t = takerAcct as Account
    let txn = new Transaction(eventId + "-t")
    let takerSide = SIDE_BUY
    if (side == SIDE_BUY) { takerSide = SIDE_SELL }
    let txnType = "Sell"
    if (takerSide == SIDE_BUY) { txnType = "Buy" }
    txn.type = txnType
    txn.timestamp = ts
    txn.market = tokenIdStr
    txn.user = t.id
    txn.tradeAmount = collateralAmount
    txn.feeAmount = ZERO_BI
    let mdOutcomeIdx2 = ZERO_BI
    let mdOutcome2 = md.outcomeIndex
    if (mdOutcome2 != null) { mdOutcomeIdx2 = mdOutcome2 as BigInt }
    txn.outcomeIndex = mdOutcomeIdx2
    txn.outcomeTokensAmount = tokenAmount
    txn.save()

    let mp = getOrCreateMarketPosition(taker, tokenIdStr)
    if (takerSide == SIDE_BUY) {
      mp.quantityBought = mp.quantityBought.plus(tokenAmount)
      mp.valueBought = mp.valueBought.plus(collateralAmount)
    } else {
      mp.quantitySold = mp.quantitySold.plus(tokenAmount)
      mp.valueSold = mp.valueSold.plus(collateralAmount)
    }
    mp.netQuantity = mp.quantityBought.minus(mp.quantitySold)
    mp.netValue = mp.valueBought.minus(mp.valueSold)
    mp.save()

    t.numTrades = t.numTrades.plus(ONE_BI)
    t.collateralVolume = t.collateralVolume.plus(collateralAmount)
    t.scaledCollateralVolume = scale(t.collateralVolume)
    t.lastTradedTimestamp = ts
    t.save()
  }

  let b = getOrCreateBuilder(builderCode, ts)
  if (b != null) {
    b.orderCount = b.orderCount.plus(ONE_BI)
    b.volume = b.volume.plus(collateralAmount)
    b.scaledVolume = scale(b.volume)
    b.fees = b.fees.plus(fee)
    b.scaledFees = scale(b.fees)
    b.save()
  }

  g.tradesQuantity = g.tradesQuantity.plus(ONE_BI)
  g.collateralVolume = g.collateralVolume.plus(collateralAmount)
  g.scaledCollateralVolume = scale(g.collateralVolume)
  g.collateralFees = g.collateralFees.plus(fee)
  g.scaledCollateralFees = scale(g.collateralFees)
  if (side == SIDE_BUY) {
    g.buysQuantity = g.buysQuantity.plus(ONE_BI)
    g.collateralBuyVolume = g.collateralBuyVolume.plus(collateralAmount)
    g.scaledCollateralBuyVolume = scale(g.collateralBuyVolume)
  } else {
    g.sellsQuantity = g.sellsQuantity.plus(ONE_BI)
    g.collateralSellVolume = g.collateralSellVolume.plus(collateralAmount)
    g.scaledCollateralSellVolume = scale(g.collateralSellVolume)
  }
  g.save()

  let omg = getOrCreateOrdersMatchedGlobal()
  omg.tradesQuantity = omg.tradesQuantity.plus(ONE_BI)
  omg.collateralVolume = omg.collateralVolume.plus(collateralAmount.toBigDecimal())
  omg.scaledCollateralVolume = omg.collateralVolume.div(USDC_UNIT)
  if (side == SIDE_BUY) {
    omg.buysQuantity = omg.buysQuantity.plus(ONE_BI)
    omg.collateralBuyVolume = omg.collateralBuyVolume.plus(collateralAmount.toBigDecimal())
    omg.scaledCollateralBuyVolume = omg.collateralBuyVolume.div(USDC_UNIT)
  } else {
    omg.sellsQuantity = omg.sellsQuantity.plus(ONE_BI)
    omg.collateralSellVolume = omg.collateralSellVolume.plus(collateralAmount.toBigDecimal())
    omg.scaledCollateralSellVolume = omg.collateralSellVolume.div(USDC_UNIT)
  }
  omg.save()
}

function applyOrdersMatched(
  txHash: Bytes,
  logIndex: BigInt,
  ts: BigInt,
  side: i32,
  tokenId: BigInt,
  makerAmountFilled: BigInt,
  takerAmountFilled: BigInt
): void {
  let id = txHash.toHexString() + "-" + logIndex.toString()
  let om = new OrdersMatchedEvent(id)
  om.timestamp = ts
  if (side == SIDE_BUY) {
    om.makerAssetID = ZERO_BI
    om.takerAssetID = tokenId
  } else {
    om.makerAssetID = tokenId
    om.takerAssetID = ZERO_BI
  }
  om.makerAmountFilled = makerAmountFilled
  om.takerAmountFilled = takerAmountFilled
  om.save()
}

export function handleOrderFilled(event: CtfOrderFilled): void {
  applyOrderFilled(
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
    event.params.metadata
  )
}

export function handleOrderFilledNegRisk(event: NegOrderFilled): void {
  applyOrderFilled(
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
    event.params.metadata
  )
}

export function handleOrdersMatched(event: CtfOrdersMatched): void {
  applyOrdersMatched(
    event.transaction.hash,
    event.logIndex,
    event.block.timestamp,
    event.params.side,
    event.params.tokenId,
    event.params.makerAmountFilled,
    event.params.takerAmountFilled
  )
}

export function handleOrdersMatchedNegRisk(event: NegOrdersMatched): void {
  applyOrdersMatched(
    event.transaction.hash,
    event.logIndex,
    event.block.timestamp,
    event.params.side,
    event.params.tokenId,
    event.params.makerAmountFilled,
    event.params.takerAmountFilled
  )
}
