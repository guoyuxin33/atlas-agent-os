import { AgentRuntime, evaluateAgentStrategy } from '../electron/services/agent-runtime.mjs'
import {
  agentStrategyDefaults,
  createAgentParameterDraft,
  mergeAgentParameters,
  validateAgentParameterDraft,
} from '../src/lib/agent-params.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function candlesFromCloses(closes) {
  return closes.map((close, index) => ({
    time: index + 1,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 100 + index,
  }))
}

function agent(strategy, position = 'flat', params = {}) {
  return { strategy, params, runtime: { position } }
}

const strategies = ['ma-crossover', 'donchian', 'rsi', 'bollinger', 'atr-breakout', 'supertrend', 'macd-momentum']
assert(Object.keys(agentStrategyDefaults).length === strategies.length, '策略参数默认值未覆盖全部策略')
for (const strategy of strategies) {
  const result = validateAgentParameterDraft(strategy, createAgentParameterDraft(strategy))
  assert(result.ok, `${strategy} 默认参数未通过表单校验: ${JSON.stringify(result)}`)
  assert(
    Object.keys(result.params).sort().join(',') === Object.keys(agentStrategyDefaults[strategy]).sort().join(','),
    `${strategy} 默认参数字段不完整: ${JSON.stringify(result.params)}`,
  )
}

const savedMaParams = { maType: 'SMA', fastPeriod: 5, slowPeriod: 34, stopPercent: 0.025, futureMode: 'guarded' }
const editedMaDraft = createAgentParameterDraft('ma-crossover', savedMaParams)
assert(editedMaDraft.maType === 'SMA' && editedMaDraft.fastPeriod === '5' && editedMaDraft.slowPeriod === '34', '编辑均线参数未回显已保存值')
assert(editedMaDraft.stopPercent === '2.5', `止损百分比回显换算错误: ${editedMaDraft.stopPercent}`)
assert(createAgentParameterDraft('ma-crossover', { ...savedMaParams, stopPercent: 0.0175 }).stopPercent === '1.75', '止损百分比回显存在浮点噪声')
const editedMaResult = validateAgentParameterDraft('ma-crossover', editedMaDraft)
assert(editedMaResult.ok && editedMaResult.params.stopPercent === 0.025, `止损百分比提交换算错误: ${JSON.stringify(editedMaResult)}`)
const mergedMaParams = mergeAgentParameters('ma-crossover', 'ma-crossover', savedMaParams, editedMaResult.params)
assert(mergedMaParams.futureMode === 'guarded', `同策略编辑丢失未知扩展参数: ${JSON.stringify(mergedMaParams)}`)

const switchedDraft = createAgentParameterDraft('supertrend')
const switchedResult = validateAgentParameterDraft('supertrend', switchedDraft)
assert(switchedResult.ok && switchedResult.params.atrPeriod === 10 && switchedResult.params.multiplier === 3, '切换策略未加载新策略默认值')
const switchedParams = mergeAgentParameters('supertrend', 'ma-crossover', savedMaParams, switchedResult.params)
assert(!('futureMode' in switchedParams) && !('fastPeriod' in switchedParams), `切换策略夹带旧参数: ${JSON.stringify(switchedParams)}`)

const invalidMa = validateAgentParameterDraft('ma-crossover', { ...createAgentParameterDraft('ma-crossover'), fastPeriod: '30', slowPeriod: '20' })
assert(!invalidMa.ok && /慢线周期/.test(invalidMa.error), `均线周期关系未被拒绝: ${JSON.stringify(invalidMa)}`)
for (const multiplier of ['0.4', '10.1']) {
  const invalidSupertrend = validateAgentParameterDraft('supertrend', { ...createAgentParameterDraft('supertrend'), multiplier })
  assert(!invalidSupertrend.ok && /倍数/.test(invalidSupertrend.error), `Supertrend 倍数 ${multiplier} 未被拒绝`)
}

const descendingBase = Array.from({ length: 60 }, (_, index) => 160 - index)
const ascendingBase = Array.from({ length: 60 }, (_, index) => 100 + index)
const bullishReversal = candlesFromCloses([...descendingBase, descendingBase.at(-1) + 10])
const bearishReversal = candlesFromCloses([...ascendingBase, ascendingBase.at(-1) - 10])
const noTrend = candlesFromCloses(Array(80).fill(100))

const supertrendLong = evaluateAgentStrategy(agent('supertrend'), bullishReversal)
const supertrendShort = evaluateAgentStrategy(agent('supertrend'), bearishReversal)
const supertrendNoSignal = evaluateAgentStrategy(agent('supertrend'), noTrend)
assert(supertrendLong?.direction === 'long' && /Supertrend/.test(supertrendLong.reason), `Supertrend 多头信号错误: ${JSON.stringify(supertrendLong)}`)
assert(supertrendShort?.direction === 'short' && /Supertrend/.test(supertrendShort.reason), `Supertrend 空头信号错误: ${JSON.stringify(supertrendShort)}`)
assert(supertrendLong.stopDistance > 0 && supertrendShort.stopDistance > 0, 'Supertrend 未提供有效 ATR 止损距离')
assert(supertrendNoSignal === null, `Supertrend 同向持仓不应重复发信号: ${JSON.stringify(supertrendNoSignal)}`)

const macdLong = evaluateAgentStrategy(agent('macd-momentum'), bullishReversal)
const macdShort = evaluateAgentStrategy(agent('macd-momentum'), bearishReversal)
const macdNoSignal = evaluateAgentStrategy(agent('macd-momentum'), noTrend)
assert(macdLong?.direction === 'long' && /MACD/.test(macdLong.reason), `MACD 多头信号错误: ${JSON.stringify(macdLong)}`)
assert(macdShort?.direction === 'short' && /MACD/.test(macdShort.reason), `MACD 空头信号错误: ${JSON.stringify(macdShort)}`)
assert(macdNoSignal === null, `MACD 同向持仓不应重复发信号: ${JSON.stringify(macdNoSignal)}`)

const insufficient = candlesFromCloses([100, 101, 102, 103, 104])
assert(evaluateAgentStrategy(agent('supertrend'), insufficient) === null, 'Supertrend 数据不足时必须无信号')
assert(evaluateAgentStrategy(agent('macd-momentum'), insufficient) === null, 'MACD 数据不足时必须无信号')

const dataDirectory = await mkdtemp(join(tmpdir(), 'atlas-strategy-qa-'))
let orderCalls = 0
try {
  const runtime = new AgentRuntime({
    dataDirectory,
    marketHub: { subscribeInternal() { return () => {} }, async history() { return [] } },
    placeOrder: async () => { orderCalls += 1; throw new Error('策略验证不得触发订单') },
    getAccountSnapshot: async () => ({ totalWalletBalance: 25_000, availableBalance: 25_000, portfolio: [] }),
    isExecutionHalted: () => false,
  })
  const supertrendAgent = await runtime.create({ strategy: 'supertrend', symbol: 'BTCUSDT', marketType: 'spot' })
  const macdAgent = await runtime.create({ strategy: 'macd-momentum', symbol: 'BTCUSDT', marketType: 'futures' })
  assert(supertrendAgent.params.atrPeriod === 10 && supertrendAgent.params.multiplier === 3, `Supertrend 默认参数错误: ${JSON.stringify(supertrendAgent.params)}`)
  assert(macdAgent.params.fastPeriod === 12 && macdAgent.params.slowPeriod === 26 && macdAgent.params.signalPeriod === 9, `MACD 默认参数错误: ${JSON.stringify(macdAgent.params)}`)
  await runtime.close()
} finally {
  await rm(dataDirectory, { recursive: true, force: true })
}
assert(orderCalls === 0, `策略验证意外调用下单适配器 ${orderCalls} 次`)

process.stdout.write(`${JSON.stringify({
  ok: true,
  supertrend: {
    long: supertrendLong.reason,
    short: supertrendShort.reason,
    noSignal: true,
  },
  macd: {
    long: macdLong.reason,
    short: macdShort.reason,
    noSignal: true,
  },
  defaultParametersPersisted: true,
  parameterEditor: {
    strategiesCovered: strategies.length,
    savedValuesRestored: true,
    unknownParametersPreserved: true,
    strategySwitchResetsDefaults: true,
    invalidRangesRejected: true,
    percentageConversion: true,
  },
  orderAdapterCalls: orderCalls,
}, null, 2)}\n`)
