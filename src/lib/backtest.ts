import type { Candle, MarketType } from '../types'

export type BacktestStrategyKind = 'ma-crossover' | 'rsi-reversion' | 'donchian-breakout'

export interface BacktestStrategyConfig {
  id: string
  name: string
  kind: BacktestStrategyKind
  primaryPeriod: number
  secondaryPeriod: number
  feeBps: number
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
}

function average(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function rsi(candles: Candle[], index: number, period: number) {
  let gains = 0
  let losses = 0
  for (let cursor = index - period + 1; cursor <= index; cursor += 1) {
    const change = candles[cursor].close - candles[cursor - 1].close
    if (change >= 0) gains += change
    else losses -= change
  }
  if (losses === 0) return gains === 0 ? 50 : 100
  const relativeStrength = (gains / period) / (losses / period)
  return 100 - (100 / (1 + relativeStrength))
}

function nextSignal(candles: Candle[], index: number, current: number, config: BacktestStrategyConfig, marketType: MarketType) {
  const shortAllowed = marketType === 'futures'
  if (config.kind === 'ma-crossover') {
    if (index + 1 < config.secondaryPeriod) return 0
    const fast = average(candles.slice(index - config.primaryPeriod + 1, index + 1).map((candle) => candle.close))
    const slow = average(candles.slice(index - config.secondaryPeriod + 1, index + 1).map((candle) => candle.close))
    return fast > slow ? 1 : fast < slow && shortAllowed ? -1 : 0
  }

  if (config.kind === 'rsi-reversion') {
    if (index < config.primaryPeriod) return 0
    const value = rsi(candles, index, config.primaryPeriod)
    const threshold = config.secondaryPeriod
    if (value <= threshold) return 1
    if (value >= 100 - threshold) return shortAllowed ? -1 : 0
    if (current === 1 && value >= 50) return 0
    if (current === -1 && value <= 50) return 0
    return current
  }

  if (index < config.primaryPeriod) return 0
  const entryWindow = candles.slice(index - config.primaryPeriod, index)
  const exitWindow = candles.slice(index - config.secondaryPeriod, index)
  const close = candles[index].close
  if (close > Math.max(...entryWindow.map((candle) => candle.high))) return 1
  if (close < Math.min(...entryWindow.map((candle) => candle.low))) return shortAllowed ? -1 : 0
  if (current === 1 && close < Math.min(...exitWindow.map((candle) => candle.low))) return 0
  if (current === -1 && close > Math.max(...exitWindow.map((candle) => candle.high))) return 0
  return current
}

export function validateBacktestStrategy(config: BacktestStrategyConfig) {
  if (!config.name.trim()) throw new Error('策略名称不能为空')
  if (!Number.isInteger(config.primaryPeriod) || config.primaryPeriod < 2 || config.primaryPeriod > 500) throw new Error('主周期必须是 2 到 500 的整数')
  if (!Number.isInteger(config.secondaryPeriod) || config.secondaryPeriod < 2 || config.secondaryPeriod > 500) throw new Error('辅助周期必须是 2 到 500 的整数')
  if (config.kind === 'ma-crossover' && config.primaryPeriod >= config.secondaryPeriod) throw new Error('快线周期必须小于慢线周期')
  if (config.kind === 'rsi-reversion' && config.secondaryPeriod >= 50) throw new Error('RSI 触发阈值必须小于 50')
  if (config.kind === 'donchian-breakout' && config.secondaryPeriod > config.primaryPeriod) throw new Error('退出周期不能大于突破周期')
  if (!Number.isFinite(config.feeBps) || config.feeBps < 0 || config.feeBps > 100) throw new Error('交易成本必须在 0 到 100 基点之间')
}

export function runBacktest(input: Candle[], config: BacktestStrategyConfig, marketType: MarketType): BacktestResult {
  validateBacktestStrategy(config)
  const candles = input
    .filter((candle) => Number.isFinite(candle.time) && candle.close > 0 && candle.high > 0 && candle.low > 0)
    .sort((left, right) => left.time - right.time)
  const minimumSamples = Math.max(config.primaryPeriod, config.secondaryPeriod) + 2
  if (candles.length < minimumSamples) throw new Error(`有效 K 线不足，至少需要 ${minimumSamples} 根`)

  let equity = 1
  let peak = 1
  let maxDrawdown = 0
  let position = 0
  let entryEquity = 1
  let tradeCount = 0
  let winningTrades = 0
  const feeRate = config.feeBps / 10_000

  const recordClosedTrade = () => {
    if (!position) return
    const tradeReturn = equity / entryEquity - 1
    tradeCount += 1
    if (tradeReturn > 0) winningTrades += 1
  }

  const updateDrawdown = () => {
    peak = Math.max(peak, equity)
    maxDrawdown = Math.max(maxDrawdown, peak > 0 ? (peak - equity) / peak : 1)
  }

  for (let index = 1; index < candles.length; index += 1) {
    const marketReturn = candles[index].close / candles[index - 1].close - 1
    equity *= Math.max(0, 1 + position * marketReturn)
    updateDrawdown()

    const target = nextSignal(candles, index, position, config, marketType)
    if (target === position) continue
    if (position) {
      equity *= Math.max(0, 1 - feeRate)
      updateDrawdown()
      recordClosedTrade()
    }
    if (target) {
      entryEquity = equity
      equity *= Math.max(0, 1 - feeRate)
      updateDrawdown()
    }
    position = target
  }

  if (position) {
    equity *= Math.max(0, 1 - feeRate)
    updateDrawdown()
    recordClosedTrade()
  }

  return {
    totalReturn: equity - 1,
    maxDrawdown,
    winRate: tradeCount ? winningTrades / tradeCount : 0,
    tradeCount,
    winningTrades,
    sampleCount: candles.length,
    startedAt: candles[0].time * 1000,
    endedAt: candles.at(-1)!.time * 1000,
    generatedAt: Date.now(),
  }
}
