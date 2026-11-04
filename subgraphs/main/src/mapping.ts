import { BigInt, BigDecimal, Address, Bytes, crypto, ethereum } from "@graphprotocol/graph-ts"
import {
  ConditionPreparation,
  ConditionResolution,
  PositionSplit,
  PositionsMerge,
  PayoutRedemption,
  ConditionalTokens,
} from "../generated/ConditionalTokens/ConditionalTokens"
import { OrderFilled as CtfOrderFilled } from "../generated/CtfExchangeV2/CtfExchangeV2"
import { OrderFilled as NegOrderFilled } from "../generated/NegRiskCtfExchangeV2/NegRiskCtfExchangeV2"
import { QuestionInitialized } from "../generated/UmaCtfAdapter/UmaCtfAdapter"
import { QuestionPrepared, MarketPrepared } from "../generated/NegRiskAdapter/NegRiskAdapter"
import {
  Global,
  Account,
  Collateral,
  Condition,
  MarketData,
  MarketPosition,
  MarketProfit,
  Trade,
  Orderbook,
  Builder,
  ConditionCollateralMap,
  MarketName,
  NegRiskEvent,
} from "../generated/schema"
import { extractTitle, extractGammaId, bytesToText } from "./names"

const GLOBAL_ID = ""
const USDC_UNIT = BigDecimal.fromString("1000000")
const ZERO_BD = BigDecimal.zero()
const ZERO_BI = BigInt.zero()
const ONE_BI = BigInt.fromI32(1)
const SIDE_BUY: i32 = 0
const DAY_SECONDS = BigInt.fromI32(86400)

const CTF_ADDRESS = Address.fromString("0x4D97DCd97eC945f40cF65F87097ACe5EA0476045")
const CTF_EXCHANGE_V2 = Address.fromString("0xe111180000d2663c0091e4f400237545b87b996b")
const NEG_RISK_EXCHANGE_V2 = Address.fromString("0xe2222d279d744050d28e00520010520000310f59")
export const UMA_ADAPTER = Address.fromString("0x65070be91477460d8a7aeeb94ef92fe056c2f2a7")
export const NEG_RISK_ADAPTER = Address.fromString("0xd91e80cf2e7be2e162c6513ced06f1dd0da35296")
const USDC_E = Address.fromString("0x2791bca1f2de4661ed88a30c99a7a9449aa84174")
const PUSD = Address.fromString("0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb")
const ZERO_BYTES32 = Bytes.fromHexString("0x0000000000000000000000000000000000000000000000000000000000000000")

export function isExchange(addr: Address): boolean {
  return addr.equals(CTF_EXCHANGE_V2) || addr.equals(NEG_RISK_EXCHANGE_V2)
}

function scale(amount: BigInt): BigDecimal {
  return amount.toBigDecimal().div(USDC_UNIT)
}

// CTF conditionId = keccak256(abi.encodePacked(oracle, questionId, outcomeSlotCount))
export function conditionIdFor(oracle: Address, questionId: Bytes, slots: i32): string {
  let packed = new Bytes(20 + 32 + 32)
  for (let i = 0; i < 20; i++) packed[i] = oracle[i]
  for (let i = 0; i < 32; i++) packed[20 + i] = questionId[i]
  for (let i = 0; i < 31; i++) packed[52 + i] = 0
  packed[83] = slots as u8
  return Bytes.fromByteArray(crypto.keccak256(packed)).toHexString()
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
    g.orderFillsQuantity = ZERO_BI
    g.splitCount = ZERO_BI
    g.splitVolume = ZERO_BI
    g.mergeCount = ZERO_BI
    g.mergeVolume = ZERO_BI
    g.redemptionCount = ZERO_BI
    g.redemptionPayout = ZERO_BI
  }
  g.lastUpdatedBlock = block_num
  g.lastUpdatedTimestamp = block_ts
  return g as Global
}

function getOrCreateAccount(addr: Address, ts: BigInt): Account {
  let id = addr.toHexString()
  let a = Account.load(id)
  if (a == null) {
    a = new Account(id)
    a.creationTimestamp = ts
    a.lastTradedTimestamp = ZERO_BI
    a.numTrades = ZERO_BI
    a.collateralVolume = ZERO_BI
    a.scaledCollateralVolume = ZERO_BD
    a.feesPaid = ZERO_BI
    a.splitCount = ZERO_BI
    a.mergeCount = ZERO_BI
    a.redemptionCount = ZERO_BI
    a.profit = ZERO_BI
    a.scaledProfit = ZERO_BD
  }
  a.lastSeenTimestamp = ts
  return a as Account
}

function initConditionStats(c: Condition): void {
  c.tradesQuantity = ZERO_BI
  c.collateralVolume = ZERO_BI
  c.scaledCollateralVolume = ZERO_BD
  c.fees = ZERO_BI
  c.splitCount = ZERO_BI
  c.splitVolume = ZERO_BI
  c.mergeCount = ZERO_BI
  c.mergeVolume = ZERO_BI
  c.redemptionCount = ZERO_BI
  c.redemptionPayout = ZERO_BI
}

function attachName(c: Condition): void {
  if (c.questionId === null || c.title !== null) return
  let n = MarketName.load((c.questionId as Bytes).toHexString())
  if (n != null) {
    c.title = n.title
    c.name = n.id
  }
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
    } else if (token.equals(PUSD)) {
      c.name = "Polymarket USD"
      c.symbol = "pUSD"
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

// Condition prepared before startBlock but active now: stub it (oracle/questionId null).
function loadOrStubCondition(conditionId: Bytes, blockNum: BigInt, blockTs: BigInt): Condition {
  let id = conditionId.toHexString()
  let c = Condition.load(id)
  if (c == null) {
    c = new Condition(id)
    let ctInfo = ConditionalTokens.bind(CTF_ADDRESS)
    let slotRes = ctInfo.try_getOutcomeSlotCount(conditionId)
    c.outcomeSlotCount = slotRes.reverted ? 0 : slotRes.value.toI32()
    c.preparedAtBlock = blockNum
    c.preparedAtTimestamp = blockTs
    initConditionStats(c)
  }
  return c as Condition
}

export function handleConditionPreparation(event: ConditionPreparation): void {
  let id = event.params.conditionId.toHexString()
  let c = Condition.load(id)
  if (c == null) {
    c = new Condition(id)
    initConditionStats(c)
  }
  c.oracle = event.params.oracle
  c.questionId = event.params.questionId
  c.outcomeSlotCount = event.params.outcomeSlotCount.toI32()
  c.preparedAtBlock = event.block.number
  c.preparedAtTimestamp = event.block.timestamp
  attachName(c)
  c.save()

  let g = getOrCreateGlobal(event.block.number, event.block.timestamp)
  g.numConditions = g.numConditions + 1
  g.numOpenConditions = g.numOpenConditions + 1
  g.save()
}

export function handleConditionResolution(event: ConditionResolution): void {
  let id = event.params.conditionId.toHexString()
  let c = Condition.load(id)
  let firstSeenAtResolution = false
  if (c == null) {
    c = new Condition(id)
    c.outcomeSlotCount = event.params.outcomeSlotCount.toI32()
    c.preparedAtBlock = event.block.number
    c.preparedAtTimestamp = event.block.timestamp
    initConditionStats(c)
    firstSeenAtResolution = true
  }
  if (c.oracle === null) {
    c.oracle = event.params.oracle
    c.questionId = event.params.questionId
  }
  attachName(c)
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
  if (firstSeenAtResolution) {
    g.numConditions = g.numConditions + 1
  } else if (g.numOpenConditions > 0) {
    g.numOpenConditions = g.numOpenConditions - 1
  }
  g.numClosedConditions = g.numClosedConditions + 1
  g.save()
}

export function handlePositionSplit(event: PositionSplit): void {
  let c = loadOrStubCondition(event.params.conditionId, event.block.number, event.block.timestamp)
  c.splitCount = c.splitCount.plus(ONE_BI)
  c.splitVolume = c.splitVolume.plus(event.params.amount)
  c.save()
  let condId = c.id
  getOrCreateCollateral(event.params.collateralToken).save()
  let acct = getOrCreateAccount(event.params.stakeholder, event.block.timestamp)
  acct.splitCount = acct.splitCount.plus(ONE_BI)
  acct.save()
  let g = getOrCreateGlobal(event.block.number, event.block.timestamp)
  g.splitCount = g.splitCount.plus(ONE_BI)
  g.splitVolume = g.splitVolume.plus(event.params.amount)
  g.save()

  // positionIds are fixed per (condition, collateral, parent): derive once.
  let mapKey = condId + "-" + event.params.collateralToken.toHexString() + "-" + event.params.parentCollectionId.toHexString()
  if (ConditionCollateralMap.load(mapKey) == null) {
    let ct = ConditionalTokens.bind(CTF_ADDRESS)
    for (let i = 0; i < event.params.partition.length; i++) {
      let indexSet = event.params.partition[i]
      let coll_res = ct.try_getCollectionId(event.params.parentCollectionId, event.params.conditionId, indexSet)
      if (!coll_res.reverted) {
        let pos_res = ct.try_getPositionId(event.params.collateralToken, coll_res.value)
        if (!pos_res.reverted) {
          let m = getOrCreateMarketData(pos_res.value.toString())
          m.condition = condId
          m.outcomeIndex = BigInt.fromI32(i)
          m.save()
        }
      }
    }
    new ConditionCollateralMap(mapKey).save()
  }
}

export function handlePositionsMerge(event: PositionsMerge): void {
  let c = loadOrStubCondition(event.params.conditionId, event.block.number, event.block.timestamp)
  c.mergeCount = c.mergeCount.plus(ONE_BI)
  c.mergeVolume = c.mergeVolume.plus(event.params.amount)
  c.save()
  getOrCreateCollateral(event.params.collateralToken).save()
  let acct = getOrCreateAccount(event.params.stakeholder, event.block.timestamp)
  acct.mergeCount = acct.mergeCount.plus(ONE_BI)
  acct.save()
  let g = getOrCreateGlobal(event.block.number, event.block.timestamp)
  g.mergeCount = g.mergeCount.plus(ONE_BI)
  g.mergeVolume = g.mergeVolume.plus(event.params.amount)
  g.save()
}

export function handlePayoutRedemption(event: PayoutRedemption): void {
  let c = loadOrStubCondition(event.params.conditionId, event.block.number, event.block.timestamp)
  c.redemptionCount = c.redemptionCount.plus(ONE_BI)
  c.redemptionPayout = c.redemptionPayout.plus(event.params.payout)
  c.save()
  getOrCreateCollateral(event.params.collateralToken).save()
  let acct = getOrCreateAccount(event.params.redeemer, event.block.timestamp)
  acct.redemptionCount = acct.redemptionCount.plus(ONE_BI)
  acct.profit = acct.profit.plus(event.params.payout)
  acct.scaledProfit = scale(acct.profit)
  acct.save()

  let mp = getOrCreateMarketProfit(event.params.redeemer, c.id)
  mp.profit = mp.profit.plus(event.params.payout)
  mp.scaledProfit = scale(mp.profit)
  mp.save()

  let g = getOrCreateGlobal(event.block.number, event.block.timestamp)
  g.redemptionCount = g.redemptionCount.plus(ONE_BI)
  g.redemptionPayout = g.redemptionPayout.plus(event.params.payout)
  g.save()
}

// Every OrderFilled describes ONE order's fill from its owner's (`maker`) perspective:
//  - maker-order fills: maker = resting order owner, taker = taker-order owner
//  - taker summary fill: maker = taker-order owner, taker = the exchange contract
// So: attribute per-account stats to `maker` only (each order once, with its own token and
// side — correct even for MINT/MERGE matches where the two sides hold different tokens), and
// count platform/market/token volume only from the taker summary (once per match).
function applyOrderFilled(
  event: ethereum.Event,
  orderHash: Bytes,
  maker: Address,
  taker: Address,
  side: i32,
  tokenId: BigInt,
  makerAmountFilled: BigInt,
  takerAmountFilled: BigInt,
  fee: BigInt,
  builderCode: Bytes,
  negRisk: boolean
): void {
  let ts = event.block.timestamp
  let collateralAmount = takerAmountFilled
  let tokenAmount = makerAmountFilled
  if (side == SIDE_BUY) {
    collateralAmount = makerAmountFilled
    tokenAmount = takerAmountFilled
  }
  let price = ZERO_BD
  if (!tokenAmount.equals(ZERO_BI)) {
    price = collateralAmount.toBigDecimal().div(tokenAmount.toBigDecimal())
  }
  let tokenIdStr = tokenId.toString()
  let isTakerSummary = isExchange(taker)

  let g = getOrCreateGlobal(event.block.number, ts)
  g.orderFillsQuantity = g.orderFillsQuantity.plus(ONE_BI)
  g.collateralFees = g.collateralFees.plus(fee)
  g.scaledCollateralFees = scale(g.collateralFees)

  let md = getOrCreateMarketData(tokenIdStr)
  md.priceOrderbook = price
  md.save()

  // ── per-account (order owner) ──
  if (!isExchange(maker)) {
    let isNew = Account.load(maker.toHexString()) == null
    if (isNew) g.numTraders = g.numTraders.plus(ONE_BI)
    let acct = getOrCreateAccount(maker, ts)
    acct.numTrades = acct.numTrades.plus(ONE_BI)
    acct.collateralVolume = acct.collateralVolume.plus(collateralAmount)
    acct.scaledCollateralVolume = scale(acct.collateralVolume)
    acct.feesPaid = acct.feesPaid.plus(fee)
    acct.lastTradedTimestamp = ts
    acct.save()

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
  }

  // ── once per match ──
  if (isTakerSummary) {
    g.tradesQuantity = g.tradesQuantity.plus(ONE_BI)
    g.collateralVolume = g.collateralVolume.plus(collateralAmount)
    g.scaledCollateralVolume = scale(g.collateralVolume)

    let ob = getOrCreateOrderbook(tokenIdStr, ts)
    ob.tradesQuantity = ob.tradesQuantity.plus(ONE_BI)
    ob.collateralVolume = ob.collateralVolume.plus(collateralAmount)
    ob.scaledCollateralVolume = scale(ob.collateralVolume)
    if (side == SIDE_BUY) {
      g.buysQuantity = g.buysQuantity.plus(ONE_BI)
      g.collateralBuyVolume = g.collateralBuyVolume.plus(collateralAmount)
      g.scaledCollateralBuyVolume = scale(g.collateralBuyVolume)
      ob.buysQuantity = ob.buysQuantity.plus(ONE_BI)
      ob.collateralBuyVolume = ob.collateralBuyVolume.plus(collateralAmount)
      ob.scaledCollateralBuyVolume = scale(ob.collateralBuyVolume)
    } else {
      g.sellsQuantity = g.sellsQuantity.plus(ONE_BI)
      g.collateralSellVolume = g.collateralSellVolume.plus(collateralAmount)
      g.scaledCollateralSellVolume = scale(g.collateralSellVolume)
      ob.sellsQuantity = ob.sellsQuantity.plus(ONE_BI)
      ob.collateralSellVolume = ob.collateralSellVolume.plus(collateralAmount)
      ob.scaledCollateralSellVolume = scale(ob.collateralSellVolume)
    }
    ob.lastPrice = price
    ob.save()

    let t = new Trade(event.transaction.hash.toHexString() + "-" + event.logIndex.toString())
    t.transactionHash = event.transaction.hash
    t.timestamp = ts
    t.blockNumber = event.block.number
    t.orderHash = orderHash
    t.taker = maker.toHexString()
    t.market = tokenIdStr
    t.side = side == SIDE_BUY ? "Buy" : "Sell"
    t.collateralAmount = collateralAmount
    t.tokenAmount = tokenAmount
    t.price = price
    t.fee = fee
    if (!builderCode.equals(ZERO_BYTES32)) t.builder = builderCode
    t.negRisk = negRisk

    if (md.condition !== null) {
      let c = Condition.load(md.condition as string)
      if (c != null) {
        c.tradesQuantity = c.tradesQuantity.plus(ONE_BI)
        c.collateralVolume = c.collateralVolume.plus(collateralAmount)
        c.scaledCollateralVolume = scale(c.collateralVolume)
        c.fees = c.fees.plus(fee)
        c.save()
        t.condition = c.id
      }
    }
    t.save()
  } else if (md.condition !== null && fee.gt(ZERO_BI)) {
    // maker fees still belong to the market
    let c = Condition.load(md.condition as string)
    if (c != null) {
      c.fees = c.fees.plus(fee)
      c.save()
    }
  }
  g.save()

  let b = getOrCreateBuilder(builderCode, ts)
  if (b != null) {
    let bb = b as Builder
    bb.orderCount = bb.orderCount.plus(ONE_BI)
    bb.volume = bb.volume.plus(collateralAmount)
    bb.scaledVolume = scale(bb.volume)
    bb.fees = bb.fees.plus(fee)
    bb.scaledFees = scale(bb.fees)
    bb.save()
  }
}

export function handleOrderFilled(event: CtfOrderFilled): void {
  let p = event.params
  applyOrderFilled(event, p.orderHash, p.maker, p.taker, p.side, p.tokenId,
    p.makerAmountFilled, p.takerAmountFilled, p.fee, p.builder, false)
}

export function handleOrderFilledNegRisk(event: NegOrderFilled): void {
  let p = event.params
  applyOrderFilled(event, p.orderHash, p.maker, p.taker, p.side, p.tokenId,
    p.makerAmountFilled, p.takerAmountFilled, p.fee, p.builder, true)
}

// ── Names ──────────────────────────────────────────────────────────────────

function saveName(
  questionId: Bytes, title: string, text: string, creator: Bytes | null, kind: string,
  negRiskEvent: string | null, oracle: Address, block: ethereum.Block
): void {
  let id = questionId.toHexString()
  if (MarketName.load(id) != null) return
  let n = new MarketName(id)
  n.title = title
  n.creator = creator
  n.gammaId = extractGammaId(text)
  n.kind = kind
  n.negRiskEvent = negRiskEvent
  n.createdAtBlock = block.number
  n.createdAtTimestamp = block.timestamp
  n.save()
  // Condition may already exist (ConditionPreparation precedes the name event in the same tx)
  let c = Condition.load(conditionIdFor(oracle, questionId, 2))
  if (c != null && c.title === null) {
    c.title = title
    c.name = id
    c.save()
  }
}

export function handleQuestionInitialized(event: QuestionInitialized): void {
  let text = bytesToText(event.params.ancillaryData)
  let title = extractTitle(text, "title:")
  if (title === null) return
  saveName(event.params.questionID, title as string, text, event.params.creator, "uma", null, UMA_ADAPTER, event.block)
}

export function handleQuestionPrepared(event: QuestionPrepared): void {
  let text = bytesToText(event.params.data)
  let title = extractTitle(text, "question:")
  if (title === null) return
  let ev = event.params.marketId.toHexString()
  let evRef: string | null = NegRiskEvent.load(ev) != null ? ev : null
  saveName(event.params.questionId, title as string, text, null, "negrisk", evRef, NEG_RISK_ADAPTER, event.block)
}

export function handleMarketPrepared(event: MarketPrepared): void {
  let id = event.params.marketId.toHexString()
  if (NegRiskEvent.load(id) != null) return
  let text = bytesToText(event.params.data)
  let title = extractTitle(text, "title:")
  if (title === null) return
  let e = new NegRiskEvent(id)
  e.title = title as string
  e.gammaId = extractGammaId(text)
  e.createdAtBlock = event.block.number
  e.save()
}
