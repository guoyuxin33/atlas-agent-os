import {
  runBacktest,
  type BacktestStrategyConfig,
  type BacktestStrategyKind,
} from '../src/lib/backtest-engine'
import type { Candle } from '../src/types'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function assertClose(actual: number, expected: number, tolerance: number, message: string) {
  assert(Math.abs(actual - expected) <= tolerance, `${message}: expected ${expected}, got ${actual}`)
}

function assertThrows(run: () => unknown, expectedMessage: string, message: string) {
  try {
    run()
  } catch (error) {
    assert(error instanceof Error && error.message.includes(expectedMessage), `${message}: 异常消息不包含 ${expectedMessage}`)
    return
  }
  throw new Error(`${message}: 未抛出异常`)
}

function candlesFromCloses(closes: number[], intervalSeconds = 3600): Candle[] {
  return closes.map((close, index) => ({
    time: 1_700_000_000 + index * intervalSeconds,
    open: close,
    high: close + 0.5,
    low: close - 0.5,
    close,
    volume: 100 + index,
  }))
}

function maConfig(overrides: Partial<BacktestStrategyConfig> = {}): BacktestStrategyConfig {
  return {
    id: 'ma',
    name: 'MA',
    kind: 'ma-crossover',
    primaryPeriod: 2,
    secondaryPeriod: 4,
    feeBps: 0,
    maType: 'EMA',
    ...overrides,
  }
}

const rising = candlesFromCloses(Array.from({ length: 80 }, (_, index) => 100 + index))
const falling = candlesFromCloses(Array.from({ length: 80 }, (_, index) => 200 - index))

const nextOpen = runBacktest(rising, maConfig(), 'spot', { evaluationStartIndex: 20 })
assert(nextOpen.trades[0]?.entryIndex === 20, '信号必须在留出区间首根开盘成交')
assert(nextOpen.trades[0]?.entryPrice === rising[20].open, '成交价必须使用下一根开盘价')
assert(nextOpen.sampleCount === 60 && nextOpen.startedAt === rising[20].time * 1000, 'evaluationStartIndex 样本边界错误')

const defaultEvaluationStart = runBacktest(rising, maConfig(), 'spot')
const firstEvaluationStart = runBacktest(rising, maConfig(), 'spot', { evaluationStartIndex: 1 })
const lastEvaluationStart = runBacktest(rising, maConfig(), 'spot', { evaluationStartIndex: rising.length - 2 })
assert(defaultEvaluationStart.assumptions.evaluationStartIndex === 1, 'undefined evaluationStartIndex 应使用默认值 1')
assert(firstEvaluationStart.sampleCount === rising.length - 1, 'evaluationStartIndex=1 应通过并保留正确样本数')
assert(lastEvaluationStart.sampleCount === 2, 'evaluationStartIndex=len-2 应通过并保留最后两根 K 线')
for (const invalidStart of [Number.NaN, Number.POSITIVE_INFINITY, 20.5, 0, rising.length - 1, rising.length]) {
  assertThrows(
    () => runBacktest(rising, maConfig(), 'spot', { evaluationStartIndex: invalidStart }),
    'evaluationStartIndex',
    `非法 evaluationStartIndex=${String(invalidStart)} 必须被拒绝`,
  )
}

const spotShort = runBacktest(falling, maConfig(), 'spot', { evaluationStartIndex: 20 })
const futuresShort = runBacktest(falling, maConfig(), 'futures', { evaluationStartIndex: 20 })
assert(spotShort.tradeCount === 0, '现货回测不得建立裸空头')
assert(futuresShort.trades[0]?.direction === 'short' && futuresShort.totalReturn > 0, '合约下降趋势应允许开空')

const ambiguous = rising.map((candle) => ({ ...candle }))
ambiguous[20] = {
  ...ambiguous[20],
  open: 120,
  close: 120,
  high: 125,
  low: 115,
}
const stopFirst = runBacktest(
  ambiguous,
  maConfig({ stopLossPercent: 0.01, takeProfitPercent: 0.01 }),
  'spot',
  { evaluationStartIndex: 20 },
)
assert(stopFirst.trades[0]?.exitReason === 'stop-loss', '同根同时触发止损止盈时必须按保守止损优先')

const gapStopCandles = rising.map((candle) => ({ ...candle }))
gapStopCandles[21] = {
  ...gapStopCandles[21],
  open: 100,
  close: 100,
  high: 200,
  low: 50,
}
const gapStop = runBacktest(
  gapStopCandles,
  maConfig({ stopLossPercent: 0.05 }),
  'spot',
  { evaluationStartIndex: 20 },
)
assert(gapStop.trades[0]?.exitReason === 'stop-loss' && gapStop.trades[0]?.exitIndex === 21, '多头跳空止损场景未按预期成交')
assertClose(
  gapStop.trades[0].maximumFavorableExcursion,
  gapStopCandles[20].high / gapStopCandles[20].open - 1,
  1e-10,
  '止损后的当根高点不得计入 MFE',
)
assertClose(
  gapStop.trades[0].maximumAdverseExcursion,
  gapStopCandles[21].open / gapStopCandles[20].open - 1,
  1e-10,
  '跳空止损后的当根低点不得计入 MAE',
)

const gapTakeProfitCandles = rising.map((candle) => ({ ...candle }))
gapTakeProfitCandles[21] = {
  ...gapTakeProfitCandles[21],
  open: 130,
  close: 130,
  high: 200,
  low: 60,
}
const gapTakeProfit = runBacktest(
  gapTakeProfitCandles,
  maConfig({ takeProfitPercent: 0.05 }),
  'spot',
  { evaluationStartIndex: 20 },
)
assert(gapTakeProfit.trades[0]?.exitReason === 'take-profit' && gapTakeProfit.trades[0]?.exitIndex === 21, '多头跳空止盈场景未按预期成交')
assertClose(
  gapTakeProfit.trades[0].maximumFavorableExcursion,
  gapTakeProfitCandles[21].open / gapTakeProfitCandles[20].open - 1,
  1e-10,
  '跳空止盈后的当根高点不得计入 MFE',
)
assertClose(
  gapTakeProfit.trades[0].maximumAdverseExcursion,
  gapTakeProfitCandles[20].low / gapTakeProfitCandles[20].open - 1,
  1e-10,
  '跳空止盈后的当根低点不得计入 MAE',
)

const trailingLookaheadCandles = rising.map((candle) => ({ ...candle }))
trailingLookaheadCandles[20] = {
  ...trailingLookaheadCandles[20],
  open: 120,
  close: 121,
  high: 140,
  low: 119,
}
const trailingWithoutLookahead = runBacktest(
  trailingLookaheadCandles,
  maConfig({ trailingStopPercent: 0.05 }),
  'spot',
  { evaluationStartIndex: 20 },
)
assert(trailingWithoutLookahead.trades[0]?.exitIndex === 21, '追踪止损不得用当根新高回溯并在同一根 K 线成交')
assert(trailingWithoutLookahead.trades[0]?.exitReason === 'trailing-stop', '下一根 K 线应触发前一根收紧后的追踪止损')

const liquidationCandles = rising.map((candle) => ({ ...candle }))
liquidationCandles[20] = { ...liquidationCandles[20], open: 120, close: 120, high: 121, low: 100 }
const liquidated = runBacktest(
  liquidationCandles,
  maConfig({ positionSize: 1, leverage: 10 }),
  'futures',
  { evaluationStartIndex: 20 },
)
assert(liquidated.trades[0]?.exitReason === 'liquidation', '高杠杆权益下限穿越未触发保守爆仓')

const stopBeforeLiquidationCandles = rising.map((candle) => ({ ...candle }))
stopBeforeLiquidationCandles[20] = {
  ...stopBeforeLiquidationCandles[20],
  open: 120,
  close: 120,
  high: 121,
  low: 100,
}
const stopBeforeLiquidation = runBacktest(
  stopBeforeLiquidationCandles,
  maConfig({ positionSize: 1, leverage: 10, stopLossPercent: 0.05 }),
  'futures',
  { evaluationStartIndex: 20 },
)
assert(stopBeforeLiquidation.trades[0]?.exitReason === 'stop-loss', '止损与爆仓同时穿越时应先执行更接近开盘价的止损')
assertClose(stopBeforeLiquidation.trades[0]?.exitPrice ?? 0, 114, 1e-10, '多头止损应在爆仓价之前成交')

const trailingBeforeLiquidationCandles = falling.map((candle) => ({ ...candle }))
trailingBeforeLiquidationCandles[20] = {
  ...trailingBeforeLiquidationCandles[20],
  open: 180,
  close: 180,
  high: 205,
  low: 179,
}
const trailingBeforeLiquidation = runBacktest(
  trailingBeforeLiquidationCandles,
  maConfig({ positionSize: 1, leverage: 10, trailingStopPercent: 0.05 }),
  'futures',
  { evaluationStartIndex: 20 },
)
assert(trailingBeforeLiquidation.trades[0]?.exitReason === 'trailing-stop', '空头追踪止损与爆仓同时穿越时应先执行追踪止损')
assertClose(trailingBeforeLiquidation.trades[0]?.exitPrice ?? 0, 189, 1e-10, '空头追踪止损应在爆仓价之前成交')

const noCost = runBacktest(rising, maConfig(), 'spot', { evaluationStartIndex: 20 })
const withCost = runBacktest(
  rising,
  maConfig({ feeBps: 10, slippageBps: 5 }),
  'spot',
  { evaluationStartIndex: 20 },
)
assert(withCost.totalReturn < noCost.totalReturn, '手续费和滑点必须降低净收益')
assert(withCost.feeDrag > 0 && withCost.slippageDrag > 0 && withCost.costDrag > 0, '成本拖累指标未计入')

const fillCostFeeRate = 100 / 10_000
const fillCostSlippageRate = 100 / 10_000
const fillCost = runBacktest(
  rising,
  maConfig({ feeBps: 100, slippageBps: 100 }),
  'spot',
  { evaluationStartIndex: 20 },
)
const fillCostTrade = fillCost.trades[0]
const expectedEntryFee = fillCostTrade.quantity
  * fillCostTrade.entryPrice
  * (1 + fillCostSlippageRate)
  * fillCostFeeRate
const expectedExitFee = fillCostTrade.quantity
  * fillCostTrade.exitPrice
  * (1 - fillCostSlippageRate)
  * fillCostFeeRate
assertClose(fillCostTrade.entryFee, expectedEntryFee, 1e-12, '多头开仓手续费必须按不利滑点后的 fill notional 计算')
assertClose(fillCostTrade.exitFee, expectedExitFee, 1e-12, '多头平仓手续费必须按不利滑点后的 fill notional 计算')
assert(fillCostTrade.entryFee > fillCostTrade.quantity * fillCostTrade.entryPrice * fillCostFeeRate, '多头开仓手续费仍在使用 raw price')
assert(fillCostTrade.exitFee < fillCostTrade.quantity * fillCostTrade.exitPrice * fillCostFeeRate, '多头平仓手续费仍在使用 raw price')

const leveraged = runBacktest(
  rising,
  maConfig({ positionSize: 0.5, leverage: 2 }),
  'futures',
  { evaluationStartIndex: 20 },
)
const unleveraged = runBacktest(
  rising,
  maConfig({ positionSize: 0.5, leverage: 1 }),
  'futures',
  { evaluationStartIndex: 20 },
)
assert(leveraged.totalReturn > unleveraged.totalReturn, '上涨趋势中杠杆未放大收益')

const fundedLong = runBacktest(
  rising,
  maConfig({ fundingRateBpsPer8Hours: 1 }),
  'futures',
  { evaluationStartIndex: 20 },
)
const fundedShort = runBacktest(
  falling,
  maConfig({ fundingRateBpsPer8Hours: 1 }),
  'futures',
  { evaluationStartIndex: 20 },
)
assert(fundedLong.fundingDrag > 0, '正资金费率下多头应支付资金费')
assert(fundedShort.fundingDrag < 0, '正资金费率下空头应收到资金费')

const fundingInsolvencyCandles = rising.map((candle) => ({ ...candle }))
for (let index = 22; index < fundingInsolvencyCandles.length; index += 1) {
  const price = 300 + index - 22
  fundingInsolvencyCandles[index] = {
    ...fundingInsolvencyCandles[index],
    open: price,
    close: price,
    high: price + 0.5,
    low: price - 0.5,
  }
}
const fundingInsolvency = runBacktest(
  fundingInsolvencyCandles,
  maConfig({ positionSize: 1, leverage: 1, fundingRateBpsPer8Hours: 100_000 }),
  'futures',
  { evaluationStartIndex: 20 },
)
assertClose(fundingInsolvency.totalReturn, -1, 1e-10, '资金费耗尽权益后账户不得因后续行情复活')
assert(fundingInsolvency.trades[0]?.exitReason === 'liquidation', '资金费导致权益耗尽时应立即结束仓位')
const firstZeroEquity = fundingInsolvency.equityCurve.findIndex((point) => point.equity === 0)
assert(firstZeroEquity >= 0, '资金费破产场景应记录零权益')
assert(fundingInsolvency.equityCurve.slice(firstZeroEquity).every((point) => point.equity === 0), '账户归零后的权益曲线不得恢复')

const intrabarDrawdownCandles = rising.map((candle) => ({ ...candle }))
intrabarDrawdownCandles[20] = {
  ...intrabarDrawdownCandles[20],
  open: 120,
  close: 120,
  high: 121,
  low: 60,
}
const intrabarDrawdown = runBacktest(
  intrabarDrawdownCandles,
  maConfig(),
  'spot',
  { evaluationStartIndex: 20 },
)
assert(intrabarDrawdown.maxDrawdown >= 0.5 - 1e-10, '最大回撤必须计入持仓期间的盘中不利价格，而不只采样收盘价')

const favorablePeakDrawdownCandles = rising.map((candle) => ({ ...candle }))
favorablePeakDrawdownCandles[20] = {
  ...favorablePeakDrawdownCandles[20],
  open: 120,
  close: 120,
  high: 240,
  low: 120,
}
favorablePeakDrawdownCandles[21] = {
  ...favorablePeakDrawdownCandles[21],
  open: 120,
  close: 120,
  high: 120,
  low: 60,
}
const favorablePeakDrawdown = runBacktest(
  favorablePeakDrawdownCandles,
  maConfig(),
  'spot',
  { evaluationStartIndex: 20 },
)
assertClose(
  favorablePeakDrawdown.maxDrawdown,
  0.75,
  1e-10,
  '最大回撤必须从幸存 K 线的盘中峰值权益 2 回撤至下一根盘中权益 0.5',
)

const reversalCandles = candlesFromCloses([
  ...Array.from({ length: 50 }, (_, index) => 100 + index),
  ...Array.from({ length: 50 }, (_, index) => 149 - index * 2),
])
const reversal = runBacktest(reversalCandles, maConfig({ feeBps: 4, slippageBps: 3 }), 'futures', { evaluationStartIndex: 20 })
assert(reversal.trades.length >= 2, '均线反转数据未产生多空两笔交易')
assert(reversal.trades[0].exitReason === 'signal', '反向信号未关闭原仓位')
assert(reversal.trades[0].exitIndex === reversal.trades[1].entryIndex, '反向信号应在同一开盘先平后开')
assertClose(reversal.trades[0].exitPrice, reversal.trades[1].entryPrice, 1e-10, '反转平仓与反向开仓必须使用同一根 K 线开盘价')
assertClose(reversal.trades[0].exitPrice, reversalCandles[reversal.trades[0].exitIndex].open, 1e-10, '反转成交价必须是下一根开盘价')
assert(reversal.trades[0].exitFee > 0 && reversal.trades[1].entryFee > 0, '反转必须同时收取旧仓平仓费和新仓开仓费')
assert(reversal.trades[0].slippageCost > 0 && reversal.trades[1].slippageCost > 0, '反转两侧都必须计入滑点成本')
assertClose(
  reversal.totalFees,
  reversal.trades.reduce((sum, trade) => sum + trade.entryFee + trade.exitFee, 0),
  1e-10,
  '总手续费必须覆盖反转的平仓与开仓两侧',
)
assertClose(
  reversal.totalSlippage,
  reversal.trades.reduce((sum, trade) => sum + trade.slippageCost, 0),
  1e-10,
  '总滑点必须覆盖反转的平仓与开仓两侧',
)

const longSignalMacdConfig: BacktestStrategyConfig = {
  id: 'macd-long-signal',
  name: 'MACD long signal warmup',
  kind: 'macd-momentum',
  primaryPeriod: 12,
  secondaryPeriod: 26,
  signalPeriod: 50,
  feeBps: 0,
}
const macdWarmupMinimum = longSignalMacdConfig.secondaryPeriod + longSignalMacdConfig.signalPeriod! + 1
const macdWarmupSource = candlesFromCloses(Array.from(
  { length: macdWarmupMinimum },
  (_, index) => 100 + Math.sin(index / 3) * 4 + index * 0.05,
))
assertThrows(
  () => runBacktest(macdWarmupSource.slice(0, -1), longSignalMacdConfig, 'futures', { evaluationStartIndex: 40 }),
  String(macdWarmupMinimum),
  'MACD 最小样本数必须覆盖慢线与信号线完整预热及下一开盘成交',
)
const macdWarmupReady = runBacktest(macdWarmupSource, longSignalMacdConfig, 'futures', { evaluationStartIndex: 40 })
assert(macdWarmupReady.sampleCount === macdWarmupMinimum - 40, 'MACD 达到完整预热样本数后应可运行')

const strategyConfigs: Record<BacktestStrategyKind, BacktestStrategyConfig> = {
  'ma-crossover': maConfig(),
  'rsi-reversion': { id: 'rsi', name: 'RSI', kind: 'rsi-reversion', primaryPeriod: 14, secondaryPeriod: 30, feeBps: 4 },
  'donchian-breakout': { id: 'donchian', name: 'Donchian', kind: 'donchian-breakout', primaryPeriod: 20, secondaryPeriod: 10, feeBps: 4 },
  bollinger: { id: 'bollinger', name: 'Bollinger', kind: 'bollinger', primaryPeriod: 20, secondaryPeriod: 2, feeBps: 4 },
  'atr-breakout': { id: 'atr', name: 'ATR', kind: 'atr-breakout', primaryPeriod: 14, secondaryPeriod: 1.5, feeBps: 4 },
  supertrend: { id: 'supertrend', name: 'Supertrend', kind: 'supertrend', primaryPeriod: 10, secondaryPeriod: 3, feeBps: 4 },
  'macd-momentum': { id: 'macd', name: 'MACD', kind: 'macd-momentum', primaryPeriod: 12, secondaryPeriod: 26, signalPeriod: 9, feeBps: 4 },
}

const oscillating = candlesFromCloses(Array.from({ length: 240 }, (_, index) => 120 + Math.sin(index / 5) * 12 + index * 0.03))
for (const [kind, config] of Object.entries(strategyConfigs)) {
  const result = runBacktest(oscillating, config, 'futures', { evaluationStartIndex: 80 })
  assert(Number.isFinite(result.totalReturn), kind + ' 总收益不是有限数')
  assert(Number.isFinite(result.maxDrawdown), kind + ' 最大回撤不是有限数')
  assert(result.sampleCount === 160, kind + ' 留出样本数错误')
  assert(Array.isArray(result.trades) && Array.isArray(result.equityCurve), kind + ' 缺少逐笔或权益曲线')
}

process.stdout.write(JSON.stringify({
  ok: true,
  nextOpen: { entryIndex: nextOpen.trades[0].entryIndex, entryPrice: nextOpen.trades[0].entryPrice },
  evaluationStartIndex: { default: 1, maximum: rising.length - 2 },
  spotShortTrades: spotShort.tradeCount,
  futuresShortReturn: futuresShort.totalReturn,
  stopPriority: stopFirst.trades[0].exitReason,
  exitExcursions: {
    stop: { mfe: gapStop.trades[0].maximumFavorableExcursion, mae: gapStop.trades[0].maximumAdverseExcursion },
    takeProfit: { mfe: gapTakeProfit.trades[0].maximumFavorableExcursion, mae: gapTakeProfit.trades[0].maximumAdverseExcursion },
  },
  trailingWithoutLookahead: { exitIndex: trailingWithoutLookahead.trades[0].exitIndex },
  liquidation: liquidated.trades[0].exitReason,
  adverseThreshold: {
    fixed: stopBeforeLiquidation.trades[0].exitReason,
    trailing: trailingBeforeLiquidation.trades[0].exitReason,
  },
  fundingInsolvency: fundingInsolvency.totalReturn,
  intrabarDrawdown: intrabarDrawdown.maxDrawdown,
  favorablePeakDrawdown: favorablePeakDrawdown.maxDrawdown,
  macdWarmupMinimum,
  reversal: { trades: reversal.tradeCount, index: reversal.trades[0].exitIndex },
  costDrag: withCost.costDrag,
  fillNotionalFees: { entry: fillCostTrade.entryFee, exit: fillCostTrade.exitFee },
  leverage: { one: unleveraged.totalReturn, two: leveraged.totalReturn },
  funding: { long: fundedLong.fundingDrag, short: fundedShort.fundingDrag },
  strategies: Object.keys(strategyConfigs),
}, null, 2) + '\n')
