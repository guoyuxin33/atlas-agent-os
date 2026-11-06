import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.env.ATLAS_QA_CHILD !== '1') {
  const scriptPath = fileURLToPath(import.meta.url)
  const registerPath = fileURLToPath(new URL('./register-electron-test-loader.mjs', import.meta.url))
  const child = spawnSync(process.execPath, ['--import', registerPath, scriptPath], {
    cwd: process.cwd(),
    env: { ...process.env, ATLAS_QA_CHILD: '1' },
    stdio: 'inherit',
  })
  process.exit(child.status ?? 1)
}

const { app } = await import('electron')

const HARD_TIMEOUT_MS = 30_000
const results = []
const userDataDirectory = await mkdtemp(join(tmpdir(), 'atlas-paper-qa-'))
let exitCode = 0

app.setPath('userData', userDataDirectory)
process.stderr.write(`QA boot userData=${userDataDirectory}\n`)

const watchdog = setTimeout(() => {
  process.stderr.write(`FAIL hard timeout after ${HARD_TIMEOUT_MS}ms\n`)
  process.exit(124)
}, HARD_TIMEOUT_MS)

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function almostEqual(actual, expected, tolerance = 1e-8) {
  return Math.abs(Number(actual) - Number(expected)) <= tolerance
}

async function expectReject(action, pattern) {
  try {
    await action()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    assert(pattern.test(message), `拒绝原因不匹配: ${message}`)
    return message
  }
  throw new Error('预期操作被拒绝，但实际成功')
}

async function verify(name, action) {
  const startedAt = Date.now()
  process.stderr.write(`QA start ${name}\n`)
  const detail = await action()
  results.push({ name, ok: true, durationMs: Date.now() - startedAt, detail })
  process.stderr.write(`QA pass ${name} ${Date.now() - startedAt}ms\n`)
}

function paperOrder(overrides) {
  return {
    symbol: 'QATESTUSDT',
    side: 'BUY',
    type: 'MARKET',
    quantity: '1',
    marketPrice: '100',
    environment: 'paper',
    marketType: 'spot',
    ...overrides,
  }
}

async function readPaperState() {
  return JSON.parse(await readFile(join(userDataDirectory, 'paper', 'account.json'), 'utf8'))
}

function waitFor(predicate, timeoutMs = 3_000) {
  const startedAt = Date.now()
  return new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        if (await predicate()) return resolve()
        if (Date.now() - startedAt >= timeoutMs) return reject(new Error('等待 Agent 评估超时'))
        setTimeout(poll, 20)
      } catch (error) {
        reject(error)
      }
    }
    void poll()
  })
}

try {
  process.stderr.write('QA waiting for Electron ready\n')
  await app.whenReady()
  process.stderr.write('QA Electron ready\n')
  const {
    adjustFuturesPositionMargin,
    getAccountSnapshot,
    getFuturesConfiguration,
    getFuturesPositionMode,
    placeOrder,
    setFuturesLeverage,
    setFuturesMarginType,
    setFuturesPositionMode,
  } = await import('../electron/services/binance.mjs')
  const { AgentRuntime } = await import('../electron/services/agent-runtime.mjs')

  await verify('Paper 现货买卖与收益', async () => {
    const symbol = 'QASPOTUSDT'
    await placeOrder(paperOrder({ symbol, side: 'BUY', quantity: '2', marketPrice: '100' }))
    await placeOrder(paperOrder({ symbol, side: 'SELL', quantity: '1', marketPrice: '120' }))
    let state = await readPaperState()
    const holding = state.spot.holdings.find((item) => item.symbol === symbol)
    const unrealizedPnl = (115 - holding.entryPrice) * holding.quantity
    const equity = state.spot.usdt + holding.quantity * 115
    assert(almostEqual(state.spot.realizedPnl, 20), `现货已实现收益应为 20，实际 ${state.spot.realizedPnl}`)
    assert(almostEqual(unrealizedPnl, 15), `现货标记价 115 时未实现收益应为 15，实际 ${unrealizedPnl}`)
    assert(almostEqual(state.spot.realizedPnl + unrealizedPnl, 35), '现货当日收益应为 35')
    assert(almostEqual(equity, 25_035), `现货权益应为 25035，实际 ${equity}`)
    assert(almostEqual(state.spot.usdt, 24_920), `现货可用余额应为 24920，实际 ${state.spot.usdt}`)

    await placeOrder(paperOrder({ symbol, side: 'SELL', quantity: '1', marketPrice: '90' }))
    state = await readPaperState()
    assert(almostEqual(state.spot.realizedPnl, 10), `现货平仓后已实现收益应为 10，实际 ${state.spot.realizedPnl}`)
    assert(almostEqual(state.spot.usdt, 25_010), `现货平仓后权益应为 25010，实际 ${state.spot.usdt}`)
    assert(!state.spot.holdings.some((item) => item.symbol === symbol), '现货平仓后仍残留持仓')
    return { realizedPnl: state.spot.realizedPnl, equity: state.spot.usdt, markedUnrealizedPnl: unrealizedPnl }
  })

  await verify('Paper futures 多头、空头与只减仓', async () => {
    const longSymbol = 'QALONGUSDT'
    const shortSymbol = 'QASHORTUSDT'
    await setFuturesLeverage({ environment: 'paper', symbol: longSymbol, leverage: 10 })
    await placeOrder(paperOrder({ symbol: longSymbol, marketType: 'futures', side: 'BUY', quantity: '2', marketPrice: '1000', positionSide: 'BOTH' }))
    let state = await readPaperState()
    let longPosition = state.futures.positions.find((position) => position.symbol === longSymbol)
    const longUnrealizedPnl = (1100 - longPosition.entryPrice) * Math.abs(longPosition.quantity) * Math.sign(longPosition.quantity)
    assert(longPosition?.quantity > 0, 'Paper futures 多头方向错误')
    assert(almostEqual(longUnrealizedPnl, 200), `多头浮盈应为 200，实际 ${longUnrealizedPnl}`)

    const sameSideReject = await expectReject(
      () => placeOrder(paperOrder({ symbol: longSymbol, marketType: 'futures', side: 'BUY', quantity: '1', marketPrice: '1100', positionSide: 'BOTH', reduceOnly: true })),
      /只减仓订单不能扩大当前持仓/,
    )
    const overReduceReject = await expectReject(
      () => placeOrder(paperOrder({ symbol: longSymbol, marketType: 'futures', side: 'SELL', quantity: '3', marketPrice: '1100', positionSide: 'BOTH', reduceOnly: true })),
      /只减仓数量不能超过当前持仓/,
    )
    await placeOrder(paperOrder({ symbol: longSymbol, marketType: 'futures', side: 'SELL', quantity: '1', marketPrice: '1200', positionSide: 'BOTH', reduceOnly: true }))

    await setFuturesLeverage({ environment: 'paper', symbol: shortSymbol, leverage: 5 })
    await placeOrder(paperOrder({ symbol: shortSymbol, marketType: 'futures', side: 'SELL', quantity: '2', marketPrice: '500', positionSide: 'BOTH' }))
    state = await readPaperState()
    const shortPosition = state.futures.positions.find((position) => position.symbol === shortSymbol)
    const shortUnrealizedPnl = (450 - shortPosition.entryPrice) * Math.abs(shortPosition.quantity) * Math.sign(shortPosition.quantity)
    assert(shortPosition?.quantity < 0, 'Paper futures 空头方向错误')
    assert(almostEqual(shortUnrealizedPnl, 100), `空头浮盈应为 100，实际 ${shortUnrealizedPnl}`)

    await placeOrder(paperOrder({ symbol: longSymbol, marketType: 'futures', side: 'SELL', quantity: '1', marketPrice: '900', positionSide: 'BOTH', reduceOnly: true }))
    await placeOrder(paperOrder({ symbol: shortSymbol, marketType: 'futures', side: 'BUY', quantity: '1', marketPrice: '400', positionSide: 'BOTH', reduceOnly: true }))
    await placeOrder(paperOrder({ symbol: shortSymbol, marketType: 'futures', side: 'BUY', quantity: '1', marketPrice: '600', positionSide: 'BOTH', reduceOnly: true }))
    state = await readPaperState()
    assert(almostEqual(state.futures.realizedPnl, 100), `合约净已实现收益应为 100，实际 ${state.futures.realizedPnl}`)
    assert(almostEqual(state.futures.walletBalance, 25_100), `合约平仓后权益应为 25100，实际 ${state.futures.walletBalance}`)
    assert(!state.futures.positions.some((position) => [longSymbol, shortSymbol].includes(position.symbol)), '合约平仓后仍残留多空持仓')
    return { realizedPnl: state.futures.realizedPnl, equity: state.futures.walletBalance, longMarkedUnrealizedPnl: longUnrealizedPnl, shortMarkedUnrealizedPnl: shortUnrealizedPnl, sameSideReject, overReduceReject }
  })

  await verify('Paper futures HEDGE 双向持仓与风险字段', async () => {
    const symbol = 'QAHEDGEUSDT'
    const initialMode = await getFuturesPositionMode({ environment: 'paper', symbol })
    assert(initialMode.positionMode === 'ONE_WAY', `初始持仓模式应为 ONE_WAY，实际 ${initialMode.positionMode}`)
    let mode = await setFuturesPositionMode({ environment: 'paper', symbol, positionMode: 'HEDGE' })
    assert(mode.positionMode === 'HEDGE', `持仓模式应为 HEDGE，实际 ${mode.positionMode}`)

    await placeOrder(paperOrder({ symbol, marketType: 'futures', side: 'BUY', quantity: '1', marketPrice: '100', positionSide: 'LONG' }))
    await placeOrder(paperOrder({ symbol, marketType: 'futures', side: 'SELL', quantity: '2', marketPrice: '100', positionSide: 'SHORT' }))
    const snapshot = await getAccountSnapshot({ environment: 'paper', marketType: 'futures', symbol, positionSide: 'LONG', markPrice: 110 })
    const positions = snapshot.portfolio.filter((position) => position.symbol === symbol)
    assert(positions.length === 2, `HEDGE 同交易对应有 2 个方向持仓，实际 ${positions.length}`)
    assert(positions.some((position) => position.positionSide === 'LONG' && position.side === 'LONG'), 'HEDGE 缺少 LONG 持仓')
    assert(positions.some((position) => position.positionSide === 'SHORT' && position.side === 'SHORT'), 'HEDGE 缺少 SHORT 持仓')
    for (const position of positions) {
      assert(Number.isFinite(Number(position.liquidationPrice)), `${position.positionSide} 缺少有效 liquidationPrice`)
      assert(Number(position.initialMargin) > 0, `${position.positionSide} initialMargin 应大于 0`)
      assert(Number(position.maintMargin) > 0, `${position.positionSide} maintMargin 应大于 0`)
    }

    const bothReject = await expectReject(
      () => placeOrder(paperOrder({ symbol, marketType: 'futures', side: 'BUY', quantity: '1', marketPrice: '100', positionSide: 'BOTH' })),
      /双向持仓模式必须明确选择 LONG 或 SHORT/,
    )
    const reduceOnlyReject = await expectReject(
      () => placeOrder(paperOrder({ symbol, marketType: 'futures', side: 'SELL', quantity: '1', marketPrice: '100', positionSide: 'LONG', reduceOnly: true })),
      /双向持仓模式不支持 reduceOnly/,
    )
    const modeWithPositionReject = await expectReject(
      () => setFuturesPositionMode({ environment: 'paper', symbol, positionMode: 'ONE_WAY' }),
      /切换持仓模式前必须先平掉所有模拟合约持仓/,
    )
    await placeOrder(paperOrder({ symbol, marketType: 'futures', side: 'SELL', quantity: '1', marketPrice: '100', positionSide: 'LONG' }))
    await placeOrder(paperOrder({ symbol, marketType: 'futures', side: 'BUY', quantity: '2', marketPrice: '100', positionSide: 'SHORT' }))
    mode = await setFuturesPositionMode({ environment: 'paper', symbol, positionMode: 'ONE_WAY' })
    assert(mode.positionMode === 'ONE_WAY', `平仓后应可切回 ONE_WAY，实际 ${mode.positionMode}`)
    return { positions: positions.map((position) => ({ side: position.positionSide, liquidationPrice: position.liquidationPrice, initialMargin: position.initialMargin, maintMargin: position.maintMargin })), bothReject, reduceOnlyReject, modeWithPositionReject, finalMode: mode.positionMode }
  })

  await verify('Paper futures 杠杆、逐仓/全仓与保证金', async () => {
    const symbol = 'QAMARGINUSDT'
    let config = await setFuturesLeverage({ environment: 'paper', symbol, leverage: 10 })
    assert(config.leverage === 10, `杠杆设置应为 10x，实际 ${config.leverage}`)
    config = await setFuturesMarginType({ environment: 'paper', symbol, marginType: 'ISOLATED' })
    assert(config.marginType === 'ISOLATED', `保证金模式应为逐仓，实际 ${config.marginType}`)
    await placeOrder(paperOrder({ symbol, marketType: 'futures', side: 'BUY', quantity: '1', marketPrice: '1000', positionSide: 'BOTH' }))
    config = await getFuturesConfiguration({ environment: 'paper', symbol })
    assert(almostEqual(config.isolatedMargin, 100), `初始逐仓保证金应为 100，实际 ${config.isolatedMargin}`)

    config = await adjustFuturesPositionMargin({ environment: 'paper', symbol, amount: 50, action: 'ADD' })
    assert(almostEqual(config.isolatedMargin, 150), `增加后逐仓保证金应为 150，实际 ${config.isolatedMargin}`)
    config = await adjustFuturesPositionMargin({ environment: 'paper', symbol, amount: 25, action: 'REMOVE' })
    assert(almostEqual(config.isolatedMargin, 125), `减少后逐仓保证金应为 125，实际 ${config.isolatedMargin}`)
    const removeReject = await expectReject(
      () => adjustFuturesPositionMargin({ environment: 'paper', symbol, amount: 30, action: 'REMOVE' }),
      /最多可减少 25\.00 USDT/,
    )
    const balanceReject = await expectReject(
      () => adjustFuturesPositionMargin({ environment: 'paper', symbol, amount: 30_000, action: 'ADD' }),
      /模拟盘可用保证金不足/,
    )
    config = await setFuturesLeverage({ environment: 'paper', symbol, leverage: 20 })
    assert(config.leverage === 20 && almostEqual(config.isolatedMargin, 75), `20x 且保留额外保证金后应为 75，实际 ${config.isolatedMargin}`)
    const marginModeWithPositionReject = await expectReject(
      () => setFuturesMarginType({ environment: 'paper', symbol, marginType: 'CROSSED' }),
      /切换保证金模式前必须先平掉该交易对的模拟持仓/,
    )
    await placeOrder(paperOrder({ symbol, marketType: 'futures', side: 'SELL', quantity: '1', marketPrice: '1000', positionSide: 'BOTH', reduceOnly: true }))
    config = await setFuturesMarginType({ environment: 'paper', symbol, marginType: 'CROSSED' })
    assert(config.marginType === 'CROSSED' && almostEqual(config.isolatedMargin, 0), '平仓后切换全仓失败')
    await placeOrder(paperOrder({ symbol, marketType: 'futures', side: 'BUY', quantity: '1', marketPrice: '1000', positionSide: 'BOTH' }))
    const crossedReject = await expectReject(
      () => adjustFuturesPositionMargin({ environment: 'paper', symbol, amount: 1, action: 'ADD' }),
      /只有逐仓持仓可以增减保证金/,
    )
    await placeOrder(paperOrder({ symbol, marketType: 'futures', side: 'SELL', quantity: '1', marketPrice: '1000', positionSide: 'BOTH', reduceOnly: true }))
    config = await setFuturesMarginType({ environment: 'paper', symbol, marginType: 'ISOLATED' })
    assert(config.marginType === 'ISOLATED', '平仓后切回逐仓失败')

    const leverageSymbol = 'QALEVUSDT'
    await setFuturesLeverage({ environment: 'paper', symbol: leverageSymbol, leverage: 125 })
    await placeOrder(paperOrder({ symbol: leverageSymbol, marketType: 'futures', side: 'BUY', quantity: '1000', marketPrice: '100', positionSide: 'BOTH' }))
    const leverageReject = await expectReject(
      () => setFuturesLeverage({ environment: 'paper', symbol: leverageSymbol, leverage: 1 }),
      /降低杠杆后所需保证金超过模拟盘可用余额/,
    )
    const orderBalanceReject = await expectReject(
      () => placeOrder(paperOrder({ symbol: 'QAREJECTUSDT', marketType: 'futures', side: 'BUY', quantity: '1000', marketPrice: '100', positionSide: 'BOTH' })),
      /模拟盘可用保证金不足/,
    )
    return { leverage: config.leverage, marginType: config.marginType, isolatedMargin: config.isolatedMargin, removeReject, balanceReject, marginModeWithPositionReject, crossedReject, leverageReject, orderBalanceReject }
  })

  await verify('Agent 持久化、重启暂停、阶段日志与 Live 不自动下单', async () => {
    const agentDirectory = join(userDataDirectory, 'agents-qa')
    const callbacks = new Map()
    const histories = new Map()
    let submittedLiveOrders = 0
    const marketHub = {
      subscribeInternal(options, callback) {
        callbacks.set(options.symbol, callback)
        return () => callbacks.delete(options.symbol)
      },
      async history(options) {
        return histories.get(options.symbol) || []
      },
    }
    const account = { totalWalletBalance: 25_000, availableBalance: 25_000, portfolio: [] }
    const runtime = new AgentRuntime({
      dataDirectory: agentDirectory,
      marketHub,
      placeOrder: async () => { submittedLiveOrders += 1; throw new Error('Live mock must never be called without confirmation') },
      getAccountSnapshot: async () => account,
      isExecutionHalted: () => false,
    })

    const crossingCloses = [100, 100, 100, 90, 110]
    const crossingCandles = crossingCloses.map((close, index) => ({ time: index + 1, open: close, high: close + 1, low: close - 1, close, volume: 10 }))
    histories.set('BTCUSDT', crossingCandles)
    const liveAgent = await runtime.create({
      name: 'QA Live EMA', strategy: 'ma-crossover', environment: 'live', marketType: 'futures', symbol: 'BTCUSDT', interval: '1m',
      params: { maType: 'EMA', fastPeriod: 2, slowPeriod: 3 }, risk: { riskFraction: 0.005, maxNotional: 100 },
    })
    await runtime.start(liveAgent.id)
    callbacks.get('BTCUSDT')({ type: 'kline', closed: true, symbol: 'BTCUSDT', interval: '1m', candle: crossingCandles.at(-1) })
    await waitFor(async () => (await runtime.logs({ agentId: liveAgent.id })).some((event) => event.type === 'CONFIRM_PENDING'))

    const flatCandles = [100, 100, 100, 100, 100].map((close, index) => ({ time: index + 1, open: close, high: close + 1, low: close - 1, close, volume: 10 }))
    histories.set('ETHUSDT', flatCandles)
    const idleAgent = await runtime.create({
      name: 'QA No Action', strategy: 'ma-crossover', environment: 'paper', marketType: 'spot', symbol: 'ETHUSDT', interval: '1m',
      params: { maType: 'EMA', fastPeriod: 2, slowPeriod: 3 }, risk: { riskFraction: 0.005, maxNotional: 100 },
    })
    await runtime.start(idleAgent.id)
    callbacks.get('ETHUSDT')({ type: 'kline', closed: true, symbol: 'ETHUSDT', interval: '1m', candle: flatCandles.at(-1) })
    await waitFor(async () => (await runtime.logs({ agentId: idleAgent.id })).some((event) => event.type === 'COMPLETED'))

    const liveLogs = await runtime.logs({ agentId: liveAgent.id, limit: 100 })
    const idleLogs = await runtime.logs({ agentId: idleAgent.id, limit: 100 })
    const requiredStages = ['MARKET_SNAPSHOT', 'POSITION_RECONCILED', 'SIGNAL_EVALUATED', 'RISK_CHECKING', 'INTENT_CREATED', 'CONFIRM_PENDING', 'COMPLETED']
    for (const stage of requiredStages) assert(liveLogs.some((event) => event.type === stage), `Live Agent 缺少阶段日志 ${stage}`)
    assert(idleLogs.some((event) => event.type === 'SIGNAL_EVALUATED' && event.data?.decision === 'NO_ACTION'), '无信号 Agent 缺少 NO_ACTION 日志')
    const beforeRestart = await runtime.list()
    assert(beforeRestart.find((agent) => agent.id === liveAgent.id)?.pendingIntents?.length === 1, 'Live Agent 未生成待确认意图')
    assert(submittedLiveOrders === 0, `Live Agent 未确认前调用了下单适配器 ${submittedLiveOrders} 次`)
    await runtime.close()

    const restarted = new AgentRuntime({
      dataDirectory: agentDirectory,
      marketHub,
      placeOrder: async () => { submittedLiveOrders += 1; throw new Error('Restarted Live mock must never execute') },
      getAccountSnapshot: async () => account,
      isExecutionHalted: () => false,
    })
    const afterRestart = await restarted.list()
    assert(afterRestart.length === 2, `重启后应恢复 2 个 Agent，实际 ${afterRestart.length}`)
    assert(afterRestart.every((agent) => agent.status === 'paused'), '重启后存在未暂停 Agent')
    assert(submittedLiveOrders === 0, '重启加载期间发生 Live 自动下单')
    await restarted.close()
    return { agents: afterRestart.length, allPaused: true, pendingLiveIntents: beforeRestart.find((agent) => agent.id === liveAgent.id).pendingIntents.length, liveAdapterCalls: submittedLiveOrders, stages: requiredStages }
  })

  const persistedPaper = JSON.parse(await readFile(join(userDataDirectory, 'paper', 'account.json'), 'utf8'))
  assert(persistedPaper.version === 3, `Paper 持久化版本错误: ${persistedPaper.version}`)
  process.stdout.write(`${JSON.stringify({ ok: true, userDataIsolation: true, cases: results }, null, 2)}\n`)
} catch (error) {
  exitCode = 1
  process.stderr.write(`${JSON.stringify({ ok: false, completedCases: results, error: error instanceof Error ? error.stack : String(error) }, null, 2)}\n`)
} finally {
  clearTimeout(watchdog)
  await rm(userDataDirectory, { recursive: true, force: true }).catch(() => {})
  process.exitCode = exitCode
}
