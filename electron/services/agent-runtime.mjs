import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ATR, BollingerBands, EMA, RSI, SMA } from 'technicalindicators'

const STRATEGIES = new Set(['ma-crossover', 'donchian', 'rsi', 'bollinger', 'atr-breakout'])
const ENVIRONMENTS = new Set(['paper', 'testnet', 'live'])
const INTERVALS = new Set(['1m', '5m', '15m', '1h', '4h', '1d'])
const MAX_LOGS_IN_MEMORY = 10_000
const LIVE_INTENT_TTL = 30_000
const MAX_CONFIRMATION_PRICE_DEVIATION = 0.005

const STRATEGY_DEFAULTS = {
  'ma-crossover': { maType: 'EMA', fastPeriod: 9, slowPeriod: 21, stopPercent: 0.01 },
  donchian: { entryPeriod: 20, exitPeriod: 10, stopPercent: 0.01 },
  rsi: { period: 14, oversold: 30, overbought: 70, stopPercent: 0.01 },
  bollinger: { period: 20, stdDev: 2, stopPercent: 0.01 },
  'atr-breakout': { atrPeriod: 14, atrMultiple: 1.5 },
}

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function integer(value, fallback, minimum = 2, maximum = 500) {
  return Math.min(maximum, Math.max(minimum, Math.round(finiteNumber(value, fallback))))
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value))
}

function normalizeSymbol(value) {
  const symbol = String(value || 'BTCUSDT').trim().toUpperCase()
  if (!/^[A-Z0-9_-]{2,40}$/.test(symbol)) throw new Error('Agent 币种格式无效')
  return symbol
}

function cleanParams(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).filter(([, item]) => ['string', 'number', 'boolean'].includes(typeof item)))
}

function normalizeAgent(input = {}) {
  const strategy = STRATEGIES.has(input.strategy) ? input.strategy : 'ma-crossover'
  const environment = ENVIRONMENTS.has(input.environment) ? input.environment : 'paper'
  const marketType = input.marketType === 'futures' ? 'futures' : 'spot'
  const interval = INTERVALS.has(input.interval) ? input.interval : '15m'
  const name = String(input.name || `${normalizeSymbol(input.symbol)} ${strategy}`).trim().slice(0, 80)
  const maxNotional = clamp(finiteNumber(input.risk?.maxNotional, 100), 1, 10_000_000)
  const maxQuantity = finiteNumber(input.risk?.maxQuantity)
  const now = Date.now()
  return {
    id: randomUUID(),
    name: name || `Agent ${strategy}`,
    strategy,
    environment,
    marketType,
    symbol: normalizeSymbol(input.symbol),
    interval,
    status: 'paused',
    params: { ...STRATEGY_DEFAULTS[strategy], ...cleanParams(input.params) },
    risk: {
      riskFraction: clamp(finiteNumber(input.risk?.riskFraction, 0.005), 0.0001, 0.01),
      maxNotional,
      ...(maxQuantity > 0 ? { maxQuantity } : {}),
    },
    runtime: {
      position: 'flat',
    },
    createdAt: now,
    updatedAt: now,
  }
}

function safeAgent(saved) {
  if (!saved?.id || !STRATEGIES.has(saved.strategy)) return null
  try {
    const normalized = normalizeAgent(saved)
    return {
      ...normalized,
      id: String(saved.id),
      name: String(saved.name || normalized.name).slice(0, 80),
      status: 'paused',
      runtime: saved.runtime && typeof saved.runtime === 'object' ? { ...saved.runtime } : { position: 'flat' },
      createdAt: finiteNumber(saved.createdAt, normalized.createdAt),
      updatedAt: Date.now(),
    }
  } catch {
    return null
  }
}

function tail(values, offset = 0) {
  return values[values.length - 1 - offset]
}

function movingAverage(type, values, period) {
  return (type === 'SMA' ? SMA : EMA).calculate({ values, period })
}

function evaluateStrategy(agent, candles) {
  const closes = candles.map((candle) => finiteNumber(candle.close))
  if (closes.some((close) => !(close > 0))) return null
  const params = agent.params || {}

  if (agent.strategy === 'ma-crossover') {
    const fastPeriod = integer(params.fastPeriod, 9)
    const slowPeriod = integer(params.slowPeriod, 21, fastPeriod + 1)
    if (closes.length < slowPeriod + 2) return null
    const type = String(params.maType || 'EMA').toUpperCase() === 'SMA' ? 'SMA' : 'EMA'
    const fast = movingAverage(type, closes, fastPeriod)
    const slow = movingAverage(type, closes, slowPeriod)
    const previousFast = tail(fast, 1)
    const currentFast = tail(fast)
    const previousSlow = tail(slow, 1)
    const currentSlow = tail(slow)
    if ([previousFast, currentFast, previousSlow, currentSlow].some((value) => !Number.isFinite(value))) return null
    if (previousFast <= previousSlow && currentFast > currentSlow) return { direction: 'long', reason: `${type} ${fastPeriod}/${slowPeriod} 金叉` }
    if (previousFast >= previousSlow && currentFast < currentSlow) return { direction: 'short', reason: `${type} ${fastPeriod}/${slowPeriod} 死叉` }
    return null
  }

  if (agent.strategy === 'donchian') {
    const entryPeriod = integer(params.entryPeriod, 20)
    const exitPeriod = integer(params.exitPeriod, 10)
    const required = Math.max(entryPeriod, exitPeriod) + 1
    if (candles.length < required) return null
    const current = tail(candles)
    const entryWindow = candles.slice(-(entryPeriod + 1), -1)
    const exitWindow = candles.slice(-(exitPeriod + 1), -1)
    const entryHigh = Math.max(...entryWindow.map((candle) => candle.high))
    const entryLow = Math.min(...entryWindow.map((candle) => candle.low))
    const exitHigh = Math.max(...exitWindow.map((candle) => candle.high))
    const exitLow = Math.min(...exitWindow.map((candle) => candle.low))
    if (agent.runtime?.position === 'long' && current.close < exitLow) return { direction: 'short', exitOnly: true, reason: `跌破 Donchian ${exitPeriod} 周期退出通道` }
    if (agent.runtime?.position === 'short' && current.close > exitHigh) return { direction: 'long', exitOnly: true, reason: `突破 Donchian ${exitPeriod} 周期退出通道` }
    if (current.close > entryHigh) return { direction: 'long', reason: `突破 Donchian ${entryPeriod} 周期上轨` }
    if (current.close < entryLow) return { direction: 'short', reason: `跌破 Donchian ${entryPeriod} 周期下轨` }
    return null
  }

  if (agent.strategy === 'rsi') {
    const period = integer(params.period, 14)
    if (closes.length < period + 3) return null
    const values = RSI.calculate({ values: closes, period })
    const previous = tail(values, 1)
    const current = tail(values)
    const oversold = clamp(finiteNumber(params.oversold, 30), 1, 49)
    const overbought = clamp(finiteNumber(params.overbought, 70), 51, 99)
    if (previous <= oversold && current > oversold) return { direction: 'long', reason: `RSI 从超卖区 ${oversold} 上穿` }
    if (previous >= overbought && current < overbought) return { direction: 'short', reason: `RSI 从超买区 ${overbought} 下穿` }
    return null
  }

  if (agent.strategy === 'bollinger') {
    const period = integer(params.period, 20)
    if (closes.length < period + 2) return null
    const stdDev = clamp(finiteNumber(params.stdDev, 2), 0.5, 5)
    const bands = BollingerBands.calculate({ values: closes, period, stdDev })
    const previousBand = tail(bands, 1)
    const currentBand = tail(bands)
    const previousClose = tail(closes, 1)
    const currentClose = tail(closes)
    if (previousClose < previousBand.lower && currentClose >= currentBand.lower) return { direction: 'long', reason: '价格从布林下轨外重新收回通道' }
    if (previousClose > previousBand.upper && currentClose <= currentBand.upper) return { direction: 'short', reason: '价格从布林上轨外重新收回通道' }
    return null
  }

  const atrPeriod = integer(params.atrPeriod, 14)
  if (candles.length < atrPeriod + 2) return null
  const atrValues = ATR.calculate({
    high: candles.map((candle) => candle.high),
    low: candles.map((candle) => candle.low),
    close: closes,
    period: atrPeriod,
  })
  const atr = tail(atrValues)
  const previousClose = tail(closes, 1)
  const currentClose = tail(closes)
  const multiple = clamp(finiteNumber(params.atrMultiple, 1.5), 0.1, 10)
  if (!(atr > 0)) return null
  if (currentClose > previousClose + atr * multiple) return { direction: 'long', stopDistance: atr * multiple, reason: `向上突破 ${multiple} ATR` }
  if (currentClose < previousClose - atr * multiple) return { direction: 'short', stopDistance: atr * multiple, reason: `向下突破 ${multiple} ATR` }
  return null
}

function formatQuantity(value) {
  return (Math.floor(value * 1e8) / 1e8).toString()
}

function eventIntent(event) {
  const intent = event?.data?.intent
  if (!intent?.id || !intent?.agentId) return null
  return intent
}

export class AgentRuntime {
  constructor({ dataDirectory, marketHub, placeOrder, getAccountSnapshot, isExecutionHalted }) {
    if (!dataDirectory) throw new Error('Agent runtime data directory is required')
    this.dataDirectory = dataDirectory
    this.marketHub = marketHub
    this.placeOrder = placeOrder
    this.getAccountSnapshot = getAccountSnapshot
    this.isExecutionHalted = isExecutionHalted || (() => false)
    this.definitionsPath = join(dataDirectory, 'definitions.json')
    this.eventsPath = join(dataDirectory, 'events.ndjson')
    this.agents = new Map()
    this.intents = new Map()
    this.events = []
    this.subscriptions = new Map()
    this.evaluationQueues = new Map()
    this.writeQueue = Promise.resolve()
    this.initialization = null
  }

  initialize() {
    if (this.initialization) return this.initialization
    this.initialization = this.#initialize()
    return this.initialization
  }

  async #initialize() {
    await mkdir(this.dataDirectory, { recursive: true })
    try {
      const saved = JSON.parse(await readFile(this.definitionsPath, 'utf8'))
      const definitions = Array.isArray(saved) ? saved : saved?.agents
      for (const candidate of definitions || []) {
        const agent = safeAgent(candidate)
        if (agent) this.agents.set(agent.id, agent)
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') console.error('[agents:definitions:load]', error)
    }

    try {
      const lines = (await readFile(this.eventsPath, 'utf8')).split('\n').filter(Boolean)
      const parsedEvents = lines.flatMap((line) => {
        try { return [JSON.parse(line)] } catch { return [] }
      })
      this.events = parsedEvents.slice(-MAX_LOGS_IN_MEMORY)
      for (const event of parsedEvents) {
        const intent = eventIntent(event)
        if (intent) this.intents.set(intent.id, intent)
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') console.error('[agents:events:load]', error)
    }

    if (this.agents.size) await this.#persistDefinitions()
  }

  async create(input) {
    await this.initialize()
    const agent = normalizeAgent(input)
    this.agents.set(agent.id, agent)
    await this.#persistDefinitions()
    await this.#log(agent.id, 'agent.created', 'info', 'Agent 已创建，默认保持暂停', { strategy: agent.strategy })
    return structuredClone(agent)
  }

  async start(agentId) {
    await this.initialize()
    const agent = this.#requireAgent(agentId)
    if (agent.status === 'running' && this.subscriptions.has(agent.id)) return structuredClone(agent)
    const unsubscribe = this.marketHub.subscribeInternal(agent, (update) => {
      if (update.type !== 'kline' || !update.closed || update.symbol !== agent.symbol || update.interval !== agent.interval) return
      const previous = this.evaluationQueues.get(agent.id) || Promise.resolve()
      const queued = previous.catch(() => {}).then(() => this.#evaluate(agent.id, update)).catch((error) => {
        console.error('[agents:evaluate]', error)
      })
      this.evaluationQueues.set(agent.id, queued)
    })
    this.subscriptions.get(agent.id)?.()
    this.subscriptions.set(agent.id, unsubscribe)
    agent.status = 'running'
    agent.updatedAt = Date.now()
    await this.#persistDefinitions()
    await this.#log(agent.id, 'agent.started', 'info', `Agent 已订阅 ${agent.symbol} ${agent.interval}`)
    return structuredClone(agent)
  }

  async pause(agentId) {
    await this.initialize()
    const agent = this.#requireAgent(agentId)
    this.subscriptions.get(agent.id)?.()
    this.subscriptions.delete(agent.id)
    agent.status = 'paused'
    agent.updatedAt = Date.now()
    await this.#persistDefinitions()
    await this.#log(agent.id, 'agent.paused', 'info', 'Agent 已暂停')
    return structuredClone(agent)
  }

  async list() {
    await this.initialize()
    for (const intent of this.intents.values()) {
      if (intent.status === 'pending' && Date.now() > intent.expiresAt) {
        await this.#updateIntent(intent, 'expired', { error: '交易意图已过期' })
      }
    }
    return [...this.agents.values()].map((agent) => ({
      ...structuredClone(agent),
      pendingIntents: [...this.intents.values()].filter((intent) => intent.agentId === agent.id && intent.status === 'pending').map((intent) => structuredClone(intent)),
    }))
  }

  async logs(options = {}) {
    await this.initialize()
    const limit = clamp(integer(options.limit, 200, 1, 1000), 1, 1000)
    return this.events
      .filter((event) => !options.agentId || event.agentId === options.agentId)
      .filter((event) => !options.after || event.timestamp > Number(options.after))
      .slice(-limit)
      .reverse()
      .map((event) => structuredClone(event))
  }

  async confirmIntent(intentId) {
    await this.initialize()
    const intent = this.intents.get(String(intentId))
    if (!intent) throw new Error('待确认交易不存在')
    if (intent.status !== 'pending') throw new Error('该交易意图已处理')
    if (intent.environment !== 'live') throw new Error('只有生产订单需要逐单确认')
    const agent = this.#requireAgent(intent.agentId)
    if (Date.now() > intent.expiresAt) {
      await this.#updateIntent(intent, 'expired', { error: '交易意图已过期' })
      await this.#log(agent.id, 'REJECTED', 'warning', '生产交易确认已过期', { intentId: intent.id })
      await this.#log(agent.id, 'COMPLETED', 'info', '确认流程结束：EXPIRED', { intentId: intent.id })
      throw new Error('交易意图已过期，请等待 Agent 生成新信号')
    }
    await this.#log(agent.id, 'CONFIRM_ACCEPTED', 'warning', '已收到生产订单逐单确认', { intentId: intent.id })
    await this.#log(agent.id, 'RISK_CHECKING', 'info', '确认前重新执行主进程风控', { intentId: intent.id })

    let submitting = false
    try {
      if (this.isExecutionHalted()) throw new Error('风控总闸已关闭，交易意图不能执行')
      const history = await this.marketHub.history({ marketType: agent.marketType, symbol: agent.symbol, interval: agent.interval, limit: 100 })
      const latestPrice = finiteNumber(history.at(-1)?.close)
      const intendedPrice = finiteNumber(intent.order.marketPrice)
      if (!(latestPrice > 0) || !(intendedPrice > 0)) throw new Error('确认前无法获得有效的最新价格')
      const deviation = Math.abs(latestPrice - intendedPrice) / intendedPrice
      if (deviation > MAX_CONFIRMATION_PRICE_DEVIATION) throw new Error(`价格偏离已超过 ${(MAX_CONFIRMATION_PRICE_DEVIATION * 100).toFixed(1)}%，请等待新信号`)
      const order = { ...intent.order, marketPrice: String(latestPrice), confirmation: 'LIVE_ORDER_CONFIRMED' }
      await this.#log(agent.id, 'MARKET_SNAPSHOT', 'info', '确认时行情快照已刷新', { intentId: intent.id, intendedPrice, latestPrice, deviation })
      await this.#validatePreparedOrder(agent, order)
      await this.#log(agent.id, 'ORDER_SUBMITTING', 'warning', `正在提交生产订单：${order.side} ${order.quantity} ${order.symbol}`, { intentId: intent.id, order })
      submitting = true
      const result = await this.placeOrder(order)
      await this.#log(agent.id, 'ACKED', 'info', '交易所已响应生产订单', { intentId: intent.id, result })
      await this.#logOrderOutcome(agent, result, intent.id)
      await this.#updateIntent(intent, 'executed', { result })
      await this.#reconcilePosition(agent, latestPrice, intent.id)
      await this.#log(agent.id, 'COMPLETED', 'info', '生产订单确认与提交流程结束', { intentId: intent.id })
      return { intent: structuredClone(intent), order: result }
    } catch (error) {
      await this.#updateIntent(intent, 'rejected', { error: error instanceof Error ? error.message : String(error) })
      if (!submitting) await this.#log(agent.id, 'RISK_REJECTED', 'error', error instanceof Error ? error.message : '生产订单风控失败', { intentId: intent.id })
      await this.#log(agent.id, 'REJECTED', 'error', error instanceof Error ? error.message : '生产订单提交失败', { intentId: intent.id })
      await this.#log(agent.id, 'COMPLETED', 'info', '生产订单确认流程结束：REJECTED', { intentId: intent.id })
      throw error
    }
  }

  async close() {
    this.subscriptions.forEach((unsubscribe) => unsubscribe())
    this.subscriptions.clear()
    await Promise.allSettled([...this.evaluationQueues.values()])
    await this.writeQueue.catch(() => {})
  }

  #requireAgent(agentId) {
    const agent = this.agents.get(String(agentId))
    if (!agent) throw new Error('Agent 不存在')
    return agent
  }

  async #evaluate(agentId, update) {
    const agent = this.agents.get(agentId)
    if (!agent || agent.status !== 'running') return
    const candleTime = finiteNumber(update.candle?.time)
    if (!(candleTime > 0) || agent.runtime?.lastEvaluatedCandle === candleTime) return
    agent.runtime = { ...agent.runtime, lastEvaluatedCandle: candleTime }
    agent.updatedAt = Date.now()
    await this.#persistDefinitions()

    try {
      const history = await this.marketHub.history({ marketType: agent.marketType, symbol: agent.symbol, interval: agent.interval, limit: 500 })
      if (agent.status !== 'running') return
      const byTime = new Map(history.filter((candle) => candle.time <= candleTime).map((candle) => [candle.time, candle]))
      byTime.set(candleTime, update.candle)
      const candles = [...byTime.values()].sort((left, right) => left.time - right.time)
      const snapshot = await this.getAccountSnapshot({ environment: agent.environment, marketType: agent.marketType, symbol: agent.symbol, markPrice: update.candle.close })
      await this.#log(agent.id, 'MARKET_SNAPSHOT', 'info', '闭合 K 线与账户快照已就绪', {
        candleTime,
        close: update.candle.close,
        candleCount: candles.length,
        equity: snapshot.totalWalletBalance,
        available: snapshot.availableBalance,
      })
      const matchingPositions = snapshot.portfolio?.filter((item) => item.symbol === agent.symbol) || []
      const position = (agent.runtime?.position === 'short' ? matchingPositions.find((item) => item.side === 'SHORT') : null)
        || (agent.runtime?.position === 'long' ? matchingPositions.find((item) => item.side === 'LONG') : null)
        || matchingPositions[0]
      agent.runtime.position = position?.side === 'SHORT' ? 'short' : position ? 'long' : 'flat'
      await this.#log(agent.id, 'POSITION_RECONCILED', 'info', `当前策略持仓：${agent.runtime.position}`, { candleTime, position: position || null })
      const signal = evaluateStrategy(agent, candles)
      if (!signal) {
        await this.#log(agent.id, 'SIGNAL_EVALUATED', 'info', '本根闭合 K 线无交易信号', { candleTime, decision: 'NO_ACTION', strategy: agent.strategy })
        await this.#persistDefinitions()
        await this.#log(agent.id, 'COMPLETED', 'info', '闭合 K 线评估结束：NO_ACTION', { candleTime })
        return
      }
      await this.#log(agent.id, 'SIGNAL_EVALUATED', 'info', signal.reason, { candleTime, decision: signal.direction.toUpperCase(), signal })
      await this.#log(agent.id, 'RISK_CHECKING', 'info', '正在计算仓位并执行主进程风控', { candleTime })
      let prepared
      try {
        prepared = this.#prepareOrder(agent, snapshot, signal, update.candle.close, candleTime, position)
      } catch (error) {
        await this.#log(agent.id, 'RISK_REJECTED', 'warning', error instanceof Error ? error.message : '仓位风控未通过', { candleTime })
        await this.#log(agent.id, 'COMPLETED', 'info', '闭合 K 线评估结束：RISK_REJECTED', { candleTime })
        return
      }
      if (!prepared) {
        await this.#log(agent.id, 'SIGNAL_EVALUATED', 'info', '信号与当前持仓方向一致，无需下单', { candleTime, decision: 'NO_ACTION', position: agent.runtime.position })
        await this.#log(agent.id, 'COMPLETED', 'info', '闭合 K 线评估结束：NO_ACTION', { candleTime })
        return
      }
      await this.#dispatch(agent, prepared, signal.reason, candleTime)
    } catch (error) {
      await this.#log(agent.id, 'evaluation.failed', 'error', error instanceof Error ? error.message : '策略评估失败', { candleTime })
    }
  }

  #prepareOrder(agent, snapshot, signal, marketPrice, candleTime, position) {
    if (this.isExecutionHalted()) throw new Error('风控总闸已关闭，Agent 拒绝生成订单')
    if (!(marketPrice > 0)) throw new Error('实时市场价格无效')
    const currentPosition = position?.side === 'SHORT' ? 'short' : position ? 'long' : 'flat'
    let side
    let reduceOnly = false
    let quantity
    const hedgeMode = agent.marketType === 'futures' && snapshot.futuresConfig?.positionMode === 'HEDGE'

    if (signal.direction === 'long') {
      if (currentPosition === 'long') return null
      side = 'BUY'
      reduceOnly = currentPosition === 'short'
    } else {
      if (currentPosition === 'short') return null
      if (agent.marketType === 'spot' && currentPosition === 'flat') return null
      side = 'SELL'
      reduceOnly = currentPosition === 'long'
    }
    if (signal.exitOnly && currentPosition === 'flat') return null

    if (reduceOnly) {
      quantity = finiteNumber(position?.quantity || position?.positionAmt)
    } else {
      const equity = finiteNumber(snapshot.totalWalletBalance)
      const available = finiteNumber(snapshot.availableBalance)
      if (!(equity > 0) || !(available > 0)) throw new Error('账户权益或可用余额不足')
      const riskFraction = clamp(finiteNumber(agent.risk.riskFraction, 0.005), 0.0001, 0.01)
      const riskBudget = equity * riskFraction
      const fallbackStop = marketPrice * clamp(finiteNumber(agent.params.stopPercent, 0.01), 0.001, 0.2)
      const stopDistance = finiteNumber(signal.stopDistance, fallbackStop)
      quantity = riskBudget / stopDistance
      quantity = Math.min(quantity, finiteNumber(agent.risk.maxNotional, 100) / marketPrice)
      if (agent.marketType === 'spot') quantity = Math.min(quantity, available / marketPrice)
      if (finiteNumber(agent.risk.maxQuantity) > 0) quantity = Math.min(quantity, finiteNumber(agent.risk.maxQuantity))
    }
    if (!(quantity > 0)) throw new Error('风控计算出的下单数量无效')

    const positionSide = agent.marketType === 'futures'
      ? hedgeMode
        ? reduceOnly
          ? position?.side === 'SHORT' ? 'SHORT' : 'LONG'
          : signal.direction === 'short' ? 'SHORT' : 'LONG'
        : 'BOTH'
      : undefined
    return {
      symbol: agent.symbol,
      side,
      type: 'MARKET',
      quantity: formatQuantity(quantity),
      marketPrice: String(marketPrice),
      environment: agent.environment,
      marketType: agent.marketType,
      ...(positionSide ? { positionSide } : {}),
      ...(reduceOnly && !hedgeMode ? { reduceOnly: true } : {}),
      clientOrderId: `atlas_${agent.id.replaceAll('-', '').slice(0, 8)}_${candleTime}`.slice(0, 36),
    }
  }

  async #dispatch(agent, order, reason, candleTime) {
    try {
      if (this.isExecutionHalted()) throw new Error('风控总闸已关闭，Agent 拒绝执行订单')
      await this.#validatePreparedOrder(agent, order)
    } catch (error) {
      await this.#log(agent.id, 'RISK_REJECTED', 'warning', error instanceof Error ? error.message : '订单风控未通过', { candleTime, order })
      await this.#log(agent.id, 'REJECTED', 'warning', '订单未进入提交阶段', { candleTime })
      await this.#log(agent.id, 'COMPLETED', 'info', '闭合 K 线评估结束：RISK_REJECTED', { candleTime })
      return null
    }
    if (agent.environment === 'live') {
      const duplicate = [...this.intents.values()].find((intent) => intent.agentId === agent.id && intent.candleTime === candleTime && intent.status === 'pending')
      if (duplicate) {
        await this.#log(agent.id, 'CONFIRM_PENDING', 'warning', '该闭合 K 线已有待确认生产意图', { candleTime, intentId: duplicate.id })
        await this.#log(agent.id, 'COMPLETED', 'info', '闭合 K 线评估结束：CONFIRM_PENDING', { candleTime })
        return duplicate
      }
      const intent = {
        id: randomUUID(),
        agentId: agent.id,
        environment: 'live',
        status: 'pending',
        order,
        reason,
        candleTime,
        createdAt: Date.now(),
        expiresAt: Date.now() + LIVE_INTENT_TTL,
      }
      this.intents.set(intent.id, intent)
      await this.#log(agent.id, 'INTENT_CREATED', 'warning', `生产交易意图已创建：${order.side} ${order.quantity} ${order.symbol}`, { intent })
      await this.#log(agent.id, 'CONFIRM_PENDING', 'warning', '生产交易必须在 30 秒内逐单确认', { intentId: intent.id, expiresAt: intent.expiresAt })
      await this.#log(agent.id, 'COMPLETED', 'info', '闭合 K 线评估结束：CONFIRM_PENDING', { candleTime, intentId: intent.id })
      return intent
    }

    await this.#log(agent.id, 'ORDER_SUBMITTING', 'info', `${agent.environment === 'paper' ? '模拟盘' : '测试网'}订单正在提交`, { candleTime, order })
    try {
      const result = await this.placeOrder(order)
      await this.#log(agent.id, 'ACKED', 'info', '订单适配器已返回响应', { candleTime, result })
      await this.#logOrderOutcome(agent, result)
      await this.#reconcilePosition(agent, finiteNumber(order.marketPrice))
      await this.#log(agent.id, 'COMPLETED', 'info', '闭合 K 线交易流程结束', { candleTime })
      return result
    } catch (error) {
      await this.#log(agent.id, 'REJECTED', 'error', error instanceof Error ? error.message : '订单提交失败', { candleTime, order })
      await this.#log(agent.id, 'COMPLETED', 'info', '闭合 K 线交易流程结束：REJECTED', { candleTime })
      return null
    }
  }

  async #logOrderOutcome(agent, result, intentId) {
    const status = String(result?.status || '').toUpperCase()
    if (status === 'FILLED') {
      await this.#log(agent.id, 'FILLED', 'info', '订单已成交', { ...(intentId ? { intentId } : {}), result })
      return
    }
    if (['REJECTED', 'EXPIRED', 'CANCELED'].includes(status)) {
      await this.#log(agent.id, 'REJECTED', 'error', `订单状态：${status}`, { ...(intentId ? { intentId } : {}), result })
      return
    }
    await this.#log(agent.id, 'UNKNOWN', 'warning', status ? `订单尚未终态：${status}` : '交易所响应中没有明确订单状态', { ...(intentId ? { intentId } : {}), result })
  }

  async #reconcilePosition(agent, markPrice, intentId) {
    try {
      const snapshot = await this.getAccountSnapshot({ environment: agent.environment, marketType: agent.marketType, symbol: agent.symbol, markPrice })
      const matchingPositions = snapshot.portfolio?.filter((item) => item.symbol === agent.symbol) || []
      const position = (agent.runtime?.position === 'short' ? matchingPositions.find((item) => item.side === 'SHORT') : null)
        || (agent.runtime?.position === 'long' ? matchingPositions.find((item) => item.side === 'LONG') : null)
        || matchingPositions[0]
      agent.runtime.position = position?.side === 'SHORT' ? 'short' : position ? 'long' : 'flat'
      agent.updatedAt = Date.now()
      await this.#persistDefinitions()
      await this.#log(agent.id, 'POSITION_RECONCILED', 'info', `订单后持仓：${agent.runtime.position}`, { ...(intentId ? { intentId } : {}), position: position || null })
    } catch (error) {
      await this.#log(agent.id, 'POSITION_RECONCILED', 'warning', error instanceof Error ? error.message : '订单后持仓同步失败', { ...(intentId ? { intentId } : {}) })
    }
  }

  async #validatePreparedOrder(agent, order) {
    if (this.isExecutionHalted()) throw new Error('风控总闸已关闭，订单被拒绝')
    const price = finiteNumber(order.marketPrice || order.price)
    const quantity = finiteNumber(order.quantity)
    if (!(price > 0) || !(quantity > 0)) throw new Error('订单价格或数量无效')
    if (quantity * price > finiteNumber(agent.risk.maxNotional, 100) + 1e-8 && !order.reduceOnly) throw new Error('订单名义价值超过 Agent 上限')
    const snapshot = await this.getAccountSnapshot({ environment: agent.environment, marketType: agent.marketType, symbol: agent.symbol, markPrice: price })
    if (!(finiteNumber(snapshot.totalWalletBalance) > 0)) throw new Error('账户权益无效')
    if (!order.reduceOnly && !(finiteNumber(snapshot.availableBalance) > 0)) throw new Error('账户可用余额不足')
    if (agent.marketType === 'spot' && order.side === 'SELL') {
      const position = snapshot.portfolio?.find((item) => item.symbol === agent.symbol)
      if (!position || finiteNumber(position.quantity) + 1e-8 < quantity) throw new Error('现货 Agent 不允许裸卖空')
    }
    return snapshot
  }

  async #updateIntent(intent, status, extra = {}) {
    Object.assign(intent, extra, { status, updatedAt: Date.now() })
    await this.#log(intent.agentId, 'intent.updated', status === 'executed' ? 'info' : 'warning', `交易意图状态：${status}`, { intent })
  }

  async #persistDefinitions() {
    const payload = JSON.stringify({ version: 1, agents: [...this.agents.values()] }, null, 2)
    await this.#queueWrite(async () => {
      await mkdir(this.dataDirectory, { recursive: true })
      const temporaryPath = `${this.definitionsPath}.tmp`
      await writeFile(temporaryPath, payload, { mode: 0o600 })
      await rename(temporaryPath, this.definitionsPath)
    })
  }

  async #log(agentId, type, level, message, data) {
    const event = { id: randomUUID(), agentId, type, level, message, ...(data ? { data: structuredClone(data) } : {}), timestamp: Date.now() }
    this.events.push(event)
    if (this.events.length > MAX_LOGS_IN_MEMORY) this.events.splice(0, this.events.length - MAX_LOGS_IN_MEMORY)
    await this.#queueWrite(async () => {
      await mkdir(this.dataDirectory, { recursive: true })
      await appendFile(this.eventsPath, `${JSON.stringify(event)}\n`, { mode: 0o600 })
    })
    return event
  }

  #queueWrite(task) {
    const next = this.writeQueue.catch(() => {}).then(task)
    this.writeQueue = next
    return next
  }
}
