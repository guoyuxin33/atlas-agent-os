import type { Candle, MarketType } from '../types'

export type BacktestStrategyKind =
  | 'ma-crossover'
  | 'rsi-reversion'
  | 'donchian-breakout'
  | 'bollinger'
  | 'atr-breakout'
  | 'supertrend'
  | 'macd-momentum'

export interface BacktestStrategyConfig {
  id: string
  name: string
  kind: BacktestStrategyKind
  primaryPeriod: number
  secondaryPeriod: number
  feeBps: number
  maType?: 'EMA' | 'SMA'
  signalPeriod?: number
  stopLossPercent?: number
  takeProfitPercent?: number
  trailingStopPercent?: number
  positionSize?: number
  positionSizePercent?: number
  leverage?: number
  slippageBps?: number
  fundingRateBpsPer8Hours?: number
  fundingBpsPer8h?: number
}

export interface BacktestOptions {
  evaluationStartIndex?: number
}

export type BacktestExitReason = 'signal' | 'stop-loss' | 'take-profit' | 'trailing-stop' | 'liquidation' | 'end-of-data'

export interface BacktestTrade {
  direction: 'long' | 'short'
  entryIndex: number
  exitIndex: number
  entryTime: number
  exitTime: number
  entryPrice: number
  exitPrice: number
  exitReason: BacktestExitReason
  quantity: number
  notionalFraction: number
  barsHeld: number
  grossPnl: number
  netPnl: number
  grossReturn: number
  netReturn: number
  entryFee: number
  exitFee: number
  slippageCost: number
  fundingCost: number
  maximumFavorableExcursion: number
  maximumAdverseExcursion: number
}

export interface BacktestEquityPoint {
  time: number
  equity: number
  drawdown: number
}

export interface BacktestResult {
  totalReturn: number
  maxDrawdown: number
  winRate: number
  tradeCount: number
  winningTrades: number
  sampleCount: number
  startedAt: number
  endedAt: number
  generatedAt: number
  grossProfit: number
  grossLoss: number
  profitFactor: number | null
  expectancy: number
  averageWin: number
  averageLoss: number
  payoffRatio: number | null
  feeDrag: number
  slippageDrag: number
  fundingDrag: number
  benchmarkReturn: number
  sharpeRatio: number | null
  totalFees: number
  totalSlippage: number
  totalFunding: number
  costDrag: number
  trades: BacktestTrade[]
  equityCurve: BacktestEquityPoint[]
  assumptions: {
    signalExecution: string
    intrabarPriority: string
    fundingModel: string
    liquidationModel: string
    positionSize: number
    leverage: number
    feeBps: number
    slippageBps: number
    fundingRateBpsPer8Hours: number
    evaluationStartIndex: number
  }
}

interface IndicatorContext {
  maFast?: Array<number | null>
  maSlow?: Array<number | null>
  rsi?: Array<number | null>
  bollinger?: Array<{ upper: number; lower: number } | null>
  atr?: Array<number | null>
  supertrendDirections?: Array<number | null>
  macdHistograms?: Array<number | null>
}

interface NormalizedExecution {
  stopLossPercent: number
  takeProfitPercent: number
  trailingStopPercent: number
  positionSize: number
  leverage: number
  feeRate: number
  slippageRate: number
  fundingRatePer8Hours: number
}

interface OpenPosition {
  direction: 1 | -1
  entryIndex: number
  entryTime: number
  entryPrice: number
  entryEquity: number
  quantity: number
  notionalFraction: number
  entryFee: number
  entrySlippage: number
  fundingCost: number
  highWater: number
  lowWater: number
  maximumFavorableExcursion: number
  maximumAdverseExcursion: number
}

interface RiskExit {
  price: number
  reason: Extract<BacktestExitReason, 'stop-loss' | 'take-profit' | 'trailing-stop' | 'liquidation'>
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value))
}

function finite(value: unknown, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

function normalizedPercent(value: unknown, fallback: number, maximum: number) {
  let parsed = finite(value, fallback)
  if (parsed > 1) parsed /= 100
  return clamp(parsed, 0, maximum)
}

function executionConfig(config: BacktestStrategyConfig, marketType: MarketType): NormalizedExecution {
  const requestedPosition = config.positionSize ?? (
    config.positionSizePercent === undefined
      ? 1
      : finite(config.positionSizePercent, 100) / 100
  )
  const leverage = marketType === 'futures'
    ? clamp(Math.round(finite(config.leverage, 1)), 1, 125)
    : 1
  return {
    stopLossPercent: normalizedPercent(config.stopLossPercent, 0, 1),
    takeProfitPercent: normalizedPercent(config.takeProfitPercent, 0, 2),
    trailingStopPercent: normalizedPercent(config.trailingStopPercent, 0, 1),
    positionSize: clamp(finite(requestedPosition, 1), 0.001, 1),
    leverage,
    feeRate: finite(config.feeBps) / 10_000,
    slippageRate: clamp(finite(config.slippageBps), 0, 100) / 10_000,
    fundingRatePer8Hours: marketType === 'futures'
      ? finite(config.fundingRateBpsPer8Hours ?? config.fundingBpsPer8h) / 10_000
      : 0,
  }
}

function smaSeries(values: number[], period: number) {
  const result: Array<number | null> = Array(values.length).fill(null)
  let sum = 0
  for (let index = 0; index < values.length; index += 1) {
    sum += values[index]
    if (index >= period) sum -= values[index - period]
    if (index >= period - 1) result[index] = sum / period
  }
  return result
}

function emaSeries(values: number[], period: number) {
  const result: Array<number | null> = Array(values.length).fill(null)
  if (values.length < period) return result
  let value = average(values.slice(0, period))
  result[period - 1] = value
  const alpha = 2 / (period + 1)
  for (let index = period; index < values.length; index += 1) {
    value = values[index] * alpha + value * (1 - alpha)
    result[index] = value
  }
  return result
}

function wilderRsiSeries(values: number[], period: number) {
  const result: Array<number | null> = Array(values.length).fill(null)
  if (values.length <= period) return result
  let averageGain = 0
  let averageLoss = 0
  for (let index = 1; index <= period; index += 1) {
    const change = values[index] - values[index - 1]
    averageGain += Math.max(0, change)
    averageLoss += Math.max(0, -change)
  }
  averageGain /= period
  averageLoss /= period
  const valueAt = () => averageLoss === 0
    ? averageGain === 0 ? 50 : 100
    : 100 - 100 / (1 + averageGain / averageLoss)
  result[period] = valueAt()
  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1]
    averageGain = ((averageGain * (period - 1)) + Math.max(0, change)) / period
    averageLoss = ((averageLoss * (period - 1)) + Math.max(0, -change)) / period
    result[index] = valueAt()
  }
  return result
}

function bollingerSeries(values: number[], period: number, standardDeviations: number) {
  const result: Array<{ upper: number; lower: number } | null> = Array(values.length).fill(null)
  for (let index = period - 1; index < values.length; index += 1) {
    const window = values.slice(index - period + 1, index + 1)
    const mean = average(window)
    const variance = average(window.map((value) => (value - mean) ** 2))
    const deviation = Math.sqrt(variance) * standardDeviations
    result[index] = { upper: mean + deviation, lower: mean - deviation }
  }
  return result
}

function wilderAtrSeries(candles: Candle[], period: number) {
  const result: Array<number | null> = Array(candles.length).fill(null)
  if (candles.length <= period) return result
  const trueRanges = candles.map((candle, index) => {
    if (index === 0) return candle.high - candle.low
    const previousClose = candles[index - 1].close
    return Math.max(candle.high - candle.low, Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose))
  })
  let atr = average(trueRanges.slice(1, period + 1))
  result[period] = atr
  for (let index = period + 1; index < candles.length; index += 1) {
    atr = ((atr * (period - 1)) + trueRanges[index]) / period
    result[index] = atr
  }
  return result
}

function supertrendDirectionSeries(candles: Candle[], period: number, multiplier: number) {
  const atr = wilderAtrSeries(candles, period)
  const directions: Array<number | null> = Array(candles.length).fill(null)
  let finalUpper: number | null = null
  let finalLower: number | null = null
  let direction = 0
  for (let index = period; index < candles.length; index += 1) {
    if (atr[index] === null) continue
    const midpoint = (candles[index].high + candles[index].low) / 2
    const basicUpper = midpoint + multiplier * atr[index]!
    const basicLower = midpoint - multiplier * atr[index]!
    if (finalUpper === null || finalLower === null) {
      finalUpper = basicUpper
      finalLower = basicLower
      direction = candles[index].close >= midpoint ? 1 : -1
    } else {
      const previousClose = candles[index - 1].close
      const nextUpper: number = basicUpper < finalUpper || previousClose > finalUpper ? basicUpper : finalUpper
      const nextLower: number = basicLower > finalLower || previousClose < finalLower ? basicLower : finalLower
      finalUpper = nextUpper
      finalLower = nextLower
      if (direction === 1 && candles[index].close < nextLower) direction = -1
      else if (direction === -1 && candles[index].close > nextUpper) direction = 1
    }
    directions[index] = direction
  }
  return directions
}

function macdHistogramSeries(values: number[], fastPeriod: number, slowPeriod: number, signalPeriod: number) {
  const fast = emaSeries(values, fastPeriod)
  const slow = emaSeries(values, slowPeriod)
  const macd: Array<number | null> = values.map((_, index) => (
    fast[index] !== null && slow[index] !== null ? fast[index]! - slow[index]! : null
  ))
  const first = macd.findIndex((value) => value !== null)
  const histogram: Array<number | null> = Array(values.length).fill(null)
  if (first < 0) return histogram
  const compact = macd.slice(first).filter((value): value is number => value !== null)
  const signal = emaSeries(compact, signalPeriod)
  signal.forEach((value, offset) => {
    if (value !== null) histogram[first + offset] = compact[offset] - value
  })
  return histogram
}

function indicatorContext(candles: Candle[], config: BacktestStrategyConfig): IndicatorContext {
  const closes = candles.map((candle) => candle.close)
  if (config.kind === 'ma-crossover') {
    const calculator = String(config.maType || 'EMA').toUpperCase() === 'SMA' ? smaSeries : emaSeries
    return {
      maFast: calculator(closes, config.primaryPeriod),
      maSlow: calculator(closes, config.secondaryPeriod),
    }
  }
  if (config.kind === 'rsi-reversion') return { rsi: wilderRsiSeries(closes, config.primaryPeriod) }
  if (config.kind === 'bollinger') return { bollinger: bollingerSeries(closes, config.primaryPeriod, config.secondaryPeriod) }
  if (config.kind === 'atr-breakout') return { atr: wilderAtrSeries(candles, config.primaryPeriod) }
  if (config.kind === 'supertrend') return { supertrendDirections: supertrendDirectionSeries(candles, config.primaryPeriod, config.secondaryPeriod) }
  if (config.kind === 'macd-momentum') {
    return { macdHistograms: macdHistogramSeries(closes, config.primaryPeriod, config.secondaryPeriod, Math.round(finite(config.signalPeriod, 9))) }
  }
  return {}
}

function targetForSignal(direction: number, marketType: MarketType) {
  return direction === -1 && marketType === 'spot' ? 0 : direction
}

function nextSignal(
  candles: Candle[],
  index: number,
  current: number,
  config: BacktestStrategyConfig,
  marketType: MarketType,
  indicators: IndicatorContext,
) {
  if (index <= 0) return current
  if (config.kind === 'ma-crossover') {
    const previousFast = indicators.maFast?.[index - 1]
    const currentFast = indicators.maFast?.[index]
    const previousSlow = indicators.maSlow?.[index - 1]
    const currentSlow = indicators.maSlow?.[index]
    if ([previousFast, currentFast, previousSlow, currentSlow].some((value) => value === null || value === undefined)) return current
    if (previousFast! <= previousSlow! && currentFast! > currentSlow!) return 1
    if (previousFast! >= previousSlow! && currentFast! < currentSlow!) return targetForSignal(-1, marketType)
    if (current === 0 && currentFast! > currentSlow!) return 1
    if (current === 0 && currentFast! < currentSlow!) return targetForSignal(-1, marketType)
    return current
  }

  if (config.kind === 'rsi-reversion') {
    const previous = indicators.rsi?.[index - 1]
    const value = indicators.rsi?.[index]
    if (previous === null || previous === undefined || value === null || value === undefined) return current
    const oversold = config.secondaryPeriod
    const overbought = 100 - oversold
    if (previous <= oversold && value > oversold) return 1
    if (previous >= overbought && value < overbought) return targetForSignal(-1, marketType)
    return current
  }

  if (config.kind === 'bollinger') {
    const previousBand = indicators.bollinger?.[index - 1]
    const currentBand = indicators.bollinger?.[index]
    if (!previousBand || !currentBand) return current
    if (candles[index - 1].close < previousBand.lower && candles[index].close >= currentBand.lower) return 1
    if (candles[index - 1].close > previousBand.upper && candles[index].close <= currentBand.upper) return targetForSignal(-1, marketType)
    return current
  }

  if (config.kind === 'atr-breakout') {
    const atr = indicators.atr?.[index]
    if (atr === null || atr === undefined || !(atr > 0)) return current
    const previousClose = candles[index - 1].close
    const close = candles[index].close
    if (close > previousClose + atr * config.secondaryPeriod) return 1
    if (close < previousClose - atr * config.secondaryPeriod) return targetForSignal(-1, marketType)
    return current
  }

  if (config.kind === 'supertrend') {
    const previous = indicators.supertrendDirections?.[index - 1]
    const direction = indicators.supertrendDirections?.[index]
    if (previous === null || previous === undefined || direction === null || direction === undefined || previous === direction) return current
    return targetForSignal(direction, marketType)
  }

  if (config.kind === 'macd-momentum') {
    const previous = indicators.macdHistograms?.[index - 1]
    const histogram = indicators.macdHistograms?.[index]
    if (previous === null || previous === undefined || histogram === null || histogram === undefined) return current
    if (previous <= 0 && histogram > 0) return 1
    if (previous >= 0 && histogram < 0) return targetForSignal(-1, marketType)
    return current
  }

  if (index < config.primaryPeriod) return current
  const entryWindow = candles.slice(index - config.primaryPeriod, index)
  const exitWindow = candles.slice(index - config.secondaryPeriod, index)
  const close = candles[index].close
  if (current === 1 && close < Math.min(...exitWindow.map((candle) => candle.low))) return 0
  if (current === -1 && close > Math.max(...exitWindow.map((candle) => candle.high))) return 0
  if (close > Math.max(...entryWindow.map((candle) => candle.high))) return 1
  if (close < Math.min(...entryWindow.map((candle) => candle.low))) return targetForSignal(-1, marketType)
  return current
}

export function validateBacktestStrategy(config: BacktestStrategyConfig) {
  if (!config.name.trim()) throw new Error('策略名称不能为空')
  if (!Number.isInteger(config.primaryPeriod) || config.primaryPeriod < 2 || config.primaryPeriod > 500) throw new Error('主周期必须是 2 到 500 的整数')
  if (['supertrend', 'bollinger', 'atr-breakout'].includes(config.kind)) {
    const minimum = config.kind === 'supertrend' || config.kind === 'bollinger' ? 0.5 : 0.1
    if (!Number.isFinite(config.secondaryPeriod) || config.secondaryPeriod < minimum || config.secondaryPeriod > 10) throw new Error('倍数参数超出允许范围')
  } else if (!Number.isInteger(config.secondaryPeriod) || config.secondaryPeriod < 2 || config.secondaryPeriod > 500) {
    throw new Error('辅助周期必须是 2 到 500 的整数')
  }
  if (config.kind === 'ma-crossover' && config.primaryPeriod >= config.secondaryPeriod) throw new Error('快线周期必须小于慢线周期')
  if (config.kind === 'rsi-reversion' && config.secondaryPeriod >= 50) throw new Error('RSI 触发阈值必须小于 50')
  if (config.kind === 'donchian-breakout' && config.secondaryPeriod > config.primaryPeriod) throw new Error('退出周期不能大于突破周期')
  if (config.kind === 'macd-momentum' && config.primaryPeriod >= config.secondaryPeriod) throw new Error('MACD 快线周期必须小于慢线周期')
  if (config.signalPeriod !== undefined && (!Number.isInteger(config.signalPeriod) || config.signalPeriod < 2 || config.signalPeriod > 100)) throw new Error('MACD 信号周期必须是 2 到 100 的整数')
  if (!Number.isFinite(config.feeBps) || config.feeBps < 0 || config.feeBps > 100) throw new Error('交易成本必须在 0 到 100 基点之间')
  executionConfig(config, 'futures')
}

function riskExit(
  position: OpenPosition,
  candle: Candle,
  settings: NormalizedExecution,
  walletEquity: number,
): RiskExit | null {
  const entry = position.entryPrice
  const long = position.direction === 1
  const fixedStop = settings.stopLossPercent > 0
    ? entry * (long ? 1 - settings.stopLossPercent : 1 + settings.stopLossPercent)
    : null
  const trailingStop = settings.trailingStopPercent > 0
    ? long
      ? position.highWater * (1 - settings.trailingStopPercent)
      : position.lowWater * (1 + settings.trailingStopPercent)
    : null
  const stop = fixedStop === null
    ? trailingStop
    : trailingStop === null
      ? fixedStop
      : long ? Math.max(fixedStop, trailingStop) : Math.min(fixedStop, trailingStop)
  const take = settings.takeProfitPercent > 0
    ? entry * (long ? 1 + settings.takeProfitPercent : 1 - settings.takeProfitPercent)
    : null
  const bankruptcy = long
    ? entry - walletEquity / position.quantity
    : entry + walletEquity / position.quantity
  const adverseCandidates: Array<{ threshold: number; reason: RiskExit['reason'] }> = []
  if (stop !== null && (long ? candle.low <= stop : candle.high >= stop)) {
    adverseCandidates.push({
      threshold: stop,
      reason: trailingStop !== null && stop === trailingStop ? 'trailing-stop' : 'stop-loss',
    })
  }
  if (bankruptcy > 0 && (long ? candle.low <= bankruptcy : candle.high >= bankruptcy)) {
    adverseCandidates.push({ threshold: bankruptcy, reason: 'liquidation' })
  }

  if (adverseCandidates.length) {
    const firstTriggered = adverseCandidates.reduce((first, candidate) => (
      long
        ? candidate.threshold > first.threshold ? candidate : first
        : candidate.threshold < first.threshold ? candidate : first
    ))
    const price = long
      ? Math.min(candle.open, firstTriggered.threshold)
      : Math.max(candle.open, firstTriggered.threshold)
    return { price, reason: firstTriggered.reason }
  }

  const takeHit = take !== null && (long ? candle.high >= take : candle.low <= take)
  if (takeHit) {
    const price = long ? Math.max(candle.open, take!) : Math.min(candle.open, take!)
    return { price, reason: 'take-profit' as const }
  }

  // A trailing threshold only becomes active after the candle that established it survives.
  position.highWater = Math.max(position.highWater, candle.high)
  position.lowWater = Math.min(position.lowWater, candle.low)
  return null
}

function excursionPrices(position: OpenPosition, candle: Candle, exit: RiskExit | null) {
  const long = position.direction === 1
  if (!exit) {
    return {
      favorable: long ? candle.high : candle.low,
      adverse: long ? candle.low : candle.high,
    }
  }
  if (exit.reason === 'take-profit') {
    const gapExit = long ? candle.open >= exit.price : candle.open <= exit.price
    return {
      favorable: exit.price,
      adverse: gapExit ? candle.open : long ? candle.low : candle.high,
    }
  }
  return { favorable: candle.open, adverse: exit.price }
}

function periodsPerYear(candles: Candle[], startIndex: number) {
  const deltas = candles
    .slice(Math.max(1, startIndex + 1))
    .map((candle, offset) => candle.time - candles[startIndex + offset].time)
    .filter((value) => value > 0)
    .sort((left, right) => left - right)
  const median = deltas.length ? deltas[Math.floor(deltas.length / 2)] : 3600
  return (365 * 24 * 60 * 60) / median
}

export function runBacktest(
  input: Candle[],
  config: BacktestStrategyConfig,
  marketType: MarketType,
  options: BacktestOptions = {},
): BacktestResult {
  validateBacktestStrategy(config)
  const candles = [...new Map(input
    .filter((candle) => (
      Number.isFinite(candle.time)
      && candle.open > 0
      && candle.close > 0
      && candle.high >= Math.max(candle.open, candle.close)
      && candle.low <= Math.min(candle.open, candle.close)
    ))
    .map((candle) => [candle.time, candle] as const)).values()]
    .sort((left, right) => left.time - right.time)
  const minimumSamples = config.kind === 'macd-momentum'
    ? config.secondaryPeriod + Math.round(finite(config.signalPeriod, 9)) + 1
    : Math.max(config.primaryPeriod, config.secondaryPeriod) + 12
  if (candles.length < minimumSamples) throw new Error('有效 K 线不足，至少需要 ' + minimumSamples + ' 根')

  const settings = executionConfig(config, marketType)
  const indicators = indicatorContext(candles, config)
  const evaluationStartIndex = options.evaluationStartIndex === undefined ? 1 : options.evaluationStartIndex
  if (!Number.isInteger(evaluationStartIndex) || evaluationStartIndex < 1 || evaluationStartIndex > candles.length - 2) {
    throw new Error('evaluationStartIndex 必须是清洗后 K 线范围内 1 到 ' + (candles.length - 2) + ' 的整数')
  }
  const trades: BacktestTrade[] = []
  const equityCurve: BacktestEquityPoint[] = []
  let realizedEquity = 1
  let peak = 1
  let maxDrawdown = 0
  let currentBarDrawdown = 0
  let position: OpenPosition | null = null
  let totalFees = 0
  let totalSlippage = 0
  let totalFunding = 0

  const markedEquity = (price: number) => (
    position
      ? realizedEquity + position.direction * (price - position.entryPrice) * position.quantity
      : realizedEquity
  )

  const observeEquity = (price: number) => {
    const equity = Math.max(0, markedEquity(price))
    peak = Math.max(peak, equity)
    const drawdown = peak > 0 ? (peak - equity) / peak : 1
    currentBarDrawdown = Math.max(currentBarDrawdown, drawdown)
    maxDrawdown = Math.max(maxDrawdown, drawdown)
    return { equity, drawdown }
  }

  const recordEquity = (index: number, price = candles[index].close) => {
    const { equity, drawdown } = observeEquity(price)
    equityCurve.push({
      time: candles[index].time * 1000,
      equity,
      drawdown: Math.max(currentBarDrawdown, drawdown),
    })
  }

  const openPosition = (direction: 1 | -1, index: number, rawPrice: number) => {
    if (!(realizedEquity > 0)) return
    const notionalFraction = settings.positionSize * settings.leverage
    const notional = realizedEquity * notionalFraction
    const quantity = notional / rawPrice
    const entryFill = rawPrice * (1 + direction * settings.slippageRate)
    const entryFee = quantity * entryFill * settings.feeRate
    const entrySlippage = quantity * Math.abs(entryFill - rawPrice)
    const entryEquity = realizedEquity
    realizedEquity -= entryFee + entrySlippage
    totalFees += entryFee
    totalSlippage += entrySlippage
    position = {
      direction,
      entryIndex: index,
      entryTime: candles[index].time * 1000,
      entryPrice: rawPrice,
      entryEquity,
      quantity,
      notionalFraction,
      entryFee,
      entrySlippage,
      fundingCost: 0,
      highWater: rawPrice,
      lowWater: rawPrice,
      maximumFavorableExcursion: 0,
      maximumAdverseExcursion: 0,
    }
  }

  const closePosition = (index: number, rawPrice: number, exitReason: BacktestExitReason) => {
    if (!position) return
    const closing = position
    const exitFill = rawPrice * (1 - closing.direction * settings.slippageRate)
    const exitNotional = closing.quantity * exitFill
    const exitFee = exitNotional * settings.feeRate
    const exitSlippage = closing.quantity * Math.abs(exitFill - rawPrice)
    const grossPnl = closing.direction * (rawPrice - closing.entryPrice) * closing.quantity
    realizedEquity = Math.max(0, realizedEquity + grossPnl - exitFee - exitSlippage)
    totalFees += exitFee
    totalSlippage += exitSlippage
    const netPnl = realizedEquity - closing.entryEquity
    const grossReturn = closing.entryEquity > 0 ? grossPnl / closing.entryEquity : 0
    const netReturn = closing.entryEquity > 0 ? netPnl / closing.entryEquity : 0
    trades.push({
      direction: closing.direction === 1 ? 'long' : 'short',
      entryIndex: closing.entryIndex,
      exitIndex: index,
      entryTime: closing.entryTime,
      exitTime: candles[index].time * 1000,
      entryPrice: closing.entryPrice,
      exitPrice: rawPrice,
      exitReason,
      quantity: closing.quantity,
      notionalFraction: closing.notionalFraction,
      barsHeld: Math.max(0, index - closing.entryIndex),
      grossPnl,
      netPnl,
      grossReturn,
      netReturn,
      entryFee: closing.entryFee,
      exitFee,
      slippageCost: closing.entrySlippage + exitSlippage,
      fundingCost: closing.fundingCost,
      maximumFavorableExcursion: closing.maximumFavorableExcursion,
      maximumAdverseExcursion: closing.maximumAdverseExcursion,
    })
    position = null
  }

  let pendingTarget = nextSignal(candles, evaluationStartIndex - 1, 0, config, marketType, indicators)
  for (let index = evaluationStartIndex; index < candles.length; index += 1) {
    const candle = candles[index]
    currentBarDrawdown = 0
    const fundedPosition = position as OpenPosition | null
    if (fundedPosition && settings.fundingRatePer8Hours !== 0) {
      const elapsedHours = Math.max(0, candle.time - candles[index - 1].time) / 3600
      const theoreticalFunding = fundedPosition.quantity * candle.open
        * settings.fundingRatePer8Hours
        * (elapsedHours / 8)
        * fundedPosition.direction
      const funding = theoreticalFunding > 0
        ? Math.min(theoreticalFunding, Math.max(0, markedEquity(candle.open)))
        : theoreticalFunding
      fundedPosition.fundingCost += funding
      totalFunding += funding
      realizedEquity -= funding
    }

    const positionAtOpen = position as OpenPosition | null
    if (positionAtOpen) {
      const openReturn = positionAtOpen.direction === 1
        ? candle.open / positionAtOpen.entryPrice - 1
        : 1 - candle.open / positionAtOpen.entryPrice
      positionAtOpen.maximumFavorableExcursion = Math.max(positionAtOpen.maximumFavorableExcursion, openReturn)
      positionAtOpen.maximumAdverseExcursion = Math.min(positionAtOpen.maximumAdverseExcursion, openReturn)
      const openEquity = observeEquity(candle.open).equity
      if (openEquity <= 0) closePosition(index, candle.open, 'liquidation')
    }

    const currentDirection = (position as OpenPosition | null)?.direction || 0
    if (pendingTarget !== currentDirection) {
      if (position) closePosition(index, candle.open, 'signal')
      if (pendingTarget !== 0 && realizedEquity > 0) openPosition(pendingTarget as 1 | -1, index, candle.open)
    }

    if ((position as OpenPosition | null) && observeEquity(candle.open).equity <= 0) {
      closePosition(index, candle.open, 'liquidation')
    }

    const activePosition = position as OpenPosition | null
    if (activePosition) {
      const exit = riskExit(activePosition, candle, settings, realizedEquity)
      const excursion = excursionPrices(activePosition, candle, exit)
      const favorable = activePosition.direction === 1
        ? excursion.favorable / activePosition.entryPrice - 1
        : 1 - excursion.favorable / activePosition.entryPrice
      const adverse = activePosition.direction === 1
        ? excursion.adverse / activePosition.entryPrice - 1
        : 1 - excursion.adverse / activePosition.entryPrice
      activePosition.maximumFavorableExcursion = Math.max(activePosition.maximumFavorableExcursion, favorable)
      activePosition.maximumAdverseExcursion = Math.min(activePosition.maximumAdverseExcursion, adverse)
      observeEquity(excursion.adverse)
      if (!exit || exit.reason === 'take-profit') observeEquity(excursion.favorable)
      if (exit) closePosition(index, exit.price, exit.reason)
    }

    if (index === candles.length - 1 && (position as OpenPosition | null)) {
      closePosition(index, candle.close, 'end-of-data')
    }
    recordEquity(index)
    if (index < candles.length - 1 && realizedEquity > 0) {
      pendingTarget = nextSignal(candles, index, (position as OpenPosition | null)?.direction || 0, config, marketType, indicators)
    }
  }

  const wins = trades.filter((trade) => trade.netPnl > 0)
  const losses = trades.filter((trade) => trade.netPnl < 0)
  const grossProfit = wins.reduce((sum, trade) => sum + trade.netPnl, 0)
  const grossLoss = losses.reduce((sum, trade) => sum + trade.netPnl, 0)
  const averageWin = wins.length ? average(wins.map((trade) => trade.netReturn)) : 0
  const averageLoss = losses.length ? average(losses.map((trade) => trade.netReturn)) : 0
  const pointReturns = equityCurve.slice(1).map((point, index) => {
    const previous = equityCurve[index].equity
    return previous > 0 ? point.equity / previous - 1 : 0
  })
  const returnMean = average(pointReturns)
  const returnVariance = average(pointReturns.map((value) => (value - returnMean) ** 2))
  const returnDeviation = Math.sqrt(returnVariance)
  const sharpeRatio = returnDeviation > 0
    ? (returnMean / returnDeviation) * Math.sqrt(periodsPerYear(candles, evaluationStartIndex))
    : null
  const feeDrag = totalFees
  const slippageDrag = totalSlippage
  const fundingDrag = totalFunding

  return {
    totalReturn: realizedEquity - 1,
    maxDrawdown,
    winRate: trades.length ? wins.length / trades.length : 0,
    tradeCount: trades.length,
    winningTrades: wins.length,
    sampleCount: candles.length - evaluationStartIndex,
    startedAt: candles[evaluationStartIndex].time * 1000,
    endedAt: candles.at(-1)!.time * 1000,
    generatedAt: Date.now(),
    grossProfit,
    grossLoss,
    profitFactor: grossLoss < 0 ? grossProfit / Math.abs(grossLoss) : null,
    expectancy: trades.length ? average(trades.map((trade) => trade.netReturn)) : 0,
    averageWin,
    averageLoss,
    payoffRatio: averageLoss < 0 ? averageWin / Math.abs(averageLoss) : null,
    feeDrag,
    slippageDrag,
    fundingDrag,
    benchmarkReturn: candles.at(-1)!.close / candles[evaluationStartIndex].open - 1,
    sharpeRatio,
    totalFees,
    totalSlippage,
    totalFunding,
    costDrag: feeDrag + slippageDrag + fundingDrag,
    trades,
    equityCurve,
    assumptions: {
      signalExecution: 'Signal confirmed at close and executed at the next candle open',
      intrabarPriority: 'Closest adverse stop or equity floor is evaluated before take-profit; trailing thresholds activate on the next candle',
      fundingModel: 'Static user-supplied rate applied to current open notional and prorated by elapsed time; historical funding is not downloaded',
      liquidationModel: 'Dynamic zero-equity floor approximation after costs and funding, not Binance maintenance-margin tiers',
      positionSize: settings.positionSize,
      leverage: settings.leverage,
      feeBps: config.feeBps,
      slippageBps: settings.slippageRate * 10_000,
      fundingRateBpsPer8Hours: settings.fundingRatePer8Hours * 10_000,
      evaluationStartIndex,
    },
  }
}
