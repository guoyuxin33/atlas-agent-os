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
    buildBinanceSpotSnapshot,
    getAccountSnapshot,
    getFuturesConfiguration,
    getFuturesPositionMode,
    normalizeBinanceOrder,
    placeOrder,
    setFuturesLeverage,
    setFuturesMarginType,
    setFuturesPositionMode,
  } = await import('../electron/services/binance.mjs')
  const { ExchangeInfoCatalog } = await import('../electron/services/exchange-info.mjs')
  const { AgentRuntime } = await import('../electron/services/agent-runtime.mjs')

  await verify('Binance 规则缓存、精度规整与现货可用数量', async () => {
    const exchangeInfo = {
      symbols: [{
        symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', status: 'TRADING',
        filters: [
          { filterType: 'LOT_SIZE', minQty: '0.00100000', maxQty: '100.00000000', stepSize: '0.00100000' },
          { filterType: 'MARKET_LOT_SIZE', minQty: '0.01000000', maxQty: '10.00000000', stepSize: '0.01000000' },
          { filterType: 'PRICE_FILTER', minPrice: '0.10000000', maxPrice: '100000.00000000', tickSize: '0.10000000' },
          { filterType: 'MIN_NOTIONAL', minNotional: '5.00000000', applyToMarket: true },
        ],
      }],
    }
    let requests = 0
    const catalog = new ExchangeInfoCatalog({ fetcher: async () => {
      requests += 1
      return { ok: true, json: async () => exchangeInfo }
    } })
    const [markets, rules] = await Promise.all([
      catalog.markets({ marketType: 'spot', baseUrl: 'https://mock.binance' }),
      catalog.symbolRules({ marketType: 'spot', baseUrl: 'https://mock.binance', symbol: 'BTCUSDT' }),
    ])
    assert(requests === 1 && markets[0]?.symbol === 'BTCUSDT', 'exchangeInfo 并发请求没有复用缓存')

    const marketOrder = normalizeBinanceOrder(paperOrder({ symbol: 'BTCUSDT', quantity: '1.2399', marketPrice: '10' }), rules)
    assert(marketOrder.quantity === '1.23', `市价数量未按 MARKET_LOT_SIZE 规整: ${marketOrder.quantity}`)
    const sellLimit = normalizeBinanceOrder(paperOrder({ symbol: 'BTCUSDT', side: 'SELL', type: 'LIMIT', quantity: '1.2349', price: '10.01' }), rules)
    assert(sellLimit.quantity === '1.234' && sellLimit.price === '10.1', `卖出限价精度错误: ${JSON.stringify(sellLimit)}`)
    const buyLimit = normalizeBinanceOrder(paperOrder({ symbol: 'BTCUSDT', type: 'LIMIT', quantity: '1.2349', price: '10.09' }), rules)
    assert(buyLimit.price === '10', `买入限价未向下按 tick 规整: ${buyLimit.price}`)
    const minQuantityReject = await expectReject(
      () => Promise.resolve(normalizeBinanceOrder(paperOrder({ symbol: 'BTCUSDT', quantity: '0.004', marketPrice: '1000' }), rules)),
      /最小步长|最小数量/,
    )
    const minNotionalReject = await expectReject(
      () => Promise.resolve(normalizeBinanceOrder(paperOrder({ symbol: 'BTCUSDT', quantity: '0.1', marketPrice: '10' }), rules)),
      /名义价值低于最小值 5/,
    )

    const spotSnapshot = buildBinanceSpotSnapshot({
      environment: 'live', now: 123,
      account: { balances: [{ asset: 'BTC', free: '1.25', locked: '2.75' }, { asset: 'USDT', free: '100', locked: '0' }] },
      tickers: [{ symbol: 'BTCUSDT', lastPrice: '10', priceChangePercent: '1' }],
    })
    const spotPosition = spotSnapshot.portfolio[0]
    assert(spotPosition.quantity === '4' && spotPosition.availableQuantity === '1.25' && spotPosition.lockedQuantity === '2.75', `现货总量/可用量边界错误: ${JSON.stringify(spotPosition)}`)
    return { requests, marketQuantity: marketOrder.quantity, sellLimitPrice: sellLimit.price, buyLimitPrice: buyLimit.price, minQuantityReject, minNotionalReject, total: spotPosition.quantity, available: spotPosition.availableQuantity }
  })

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

  await verify('逐仓位平仓订单语义', async () => {
    const spotSymbol = 'QACLOSESPOTUSDT'
    await placeOrder(paperOrder({ symbol: spotSymbol, side: 'BUY', quantity: '4', marketPrice: '100' }))
    await placeOrder(paperOrder({ symbol: spotSymbol, side: 'SELL', quantity: '1.5', marketPrice: '110' }))
    let state = await readPaperState()
    let spotHolding = state.spot.holdings.find((holding) => holding.symbol === spotSymbol)
    assert(almostEqual(spotHolding?.quantity, 2.5), `现货部分平仓后应剩余 2.5，实际 ${spotHolding?.quantity}`)
    const spotOverCloseReject = await expectReject(
      () => placeOrder(paperOrder({ symbol: spotSymbol, side: 'SELL', quantity: '3', marketPrice: '110' })),
      /可用余额不足/,
    )
    const pendingSpotClose = await placeOrder(paperOrder({ symbol: spotSymbol, side: 'SELL', type: 'LIMIT', quantity: '2.5', price: '120', marketPrice: '110' }))
    assert(pendingSpotClose.status === 'NEW', `未触价现货平仓单应为 NEW，实际 ${pendingSpotClose.status}`)
    await getAccountSnapshot({ environment: 'paper', marketType: 'spot', symbol: spotSymbol, markPrice: 125 })
    state = await readPaperState()
    spotHolding = state.spot.holdings.find((holding) => holding.symbol === spotSymbol)
    assert(!spotHolding, '限价触发后现货仓位应全部平掉')

    const oneWaySymbol = 'QACLOSEONEWAYUSDT'
    await placeOrder(paperOrder({ symbol: oneWaySymbol, marketType: 'futures', side: 'BUY', quantity: '3', marketPrice: '100', positionSide: 'BOTH' }))
    await placeOrder(paperOrder({ symbol: oneWaySymbol, marketType: 'futures', side: 'SELL', quantity: '1', marketPrice: '110', positionSide: 'BOTH', reduceOnly: true }))
    let oneWaySnapshot = await getAccountSnapshot({ environment: 'paper', marketType: 'futures', symbol: oneWaySymbol, markPrice: 110 })
    assert(almostEqual(oneWaySnapshot.portfolio.find((position) => position.symbol === oneWaySymbol)?.quantity, 2), '单向合约部分平仓后数量错误')
    const oneWayOverCloseReject = await expectReject(
      () => placeOrder(paperOrder({ symbol: oneWaySymbol, marketType: 'futures', side: 'SELL', quantity: '3', marketPrice: '110', positionSide: 'BOTH', reduceOnly: true })),
      /只减仓数量不能超过当前持仓/,
    )
    await placeOrder(paperOrder({ symbol: oneWaySymbol, marketType: 'futures', side: 'SELL', quantity: '2', marketPrice: '110', positionSide: 'BOTH', reduceOnly: true }))
    oneWaySnapshot = await getAccountSnapshot({ environment: 'paper', marketType: 'futures', symbol: oneWaySymbol, markPrice: 110 })
    assert(!oneWaySnapshot.portfolio.some((position) => position.symbol === oneWaySymbol), '单向合约全部平仓后仍有仓位')

    const hedgeSymbol = 'QACLOSEHEDGEUSDT'
    await setFuturesPositionMode({ environment: 'paper', symbol: hedgeSymbol, positionMode: 'HEDGE' })
    await placeOrder(paperOrder({ symbol: hedgeSymbol, marketType: 'futures', side: 'SELL', quantity: '3', marketPrice: '100', positionSide: 'SHORT' }))
    await placeOrder(paperOrder({ symbol: hedgeSymbol, marketType: 'futures', side: 'BUY', quantity: '1', marketPrice: '90', positionSide: 'SHORT' }))
    let hedgeSnapshot = await getAccountSnapshot({ environment: 'paper', marketType: 'futures', symbol: hedgeSymbol, positionSide: 'SHORT', markPrice: 90 })
    assert(almostEqual(hedgeSnapshot.portfolio.find((position) => position.symbol === hedgeSymbol && position.positionSide === 'SHORT')?.quantity, 2), '双向 SHORT 部分平仓后数量错误')
    const hedgeOverCloseReject = await expectReject(
      () => placeOrder(paperOrder({ symbol: hedgeSymbol, marketType: 'futures', side: 'BUY', quantity: '3', marketPrice: '90', positionSide: 'SHORT' })),
      /平空数量不能超过 SHORT 持仓/,
    )
    await placeOrder(paperOrder({ symbol: hedgeSymbol, marketType: 'futures', side: 'BUY', quantity: '2', marketPrice: '90', positionSide: 'SHORT' }))
    hedgeSnapshot = await getAccountSnapshot({ environment: 'paper', marketType: 'futures', symbol: hedgeSymbol, positionSide: 'SHORT', markPrice: 90 })
    assert(!hedgeSnapshot.portfolio.some((position) => position.symbol === hedgeSymbol), '双向合约全部平仓后仍有仓位')
    await setFuturesPositionMode({ environment: 'paper', symbol: hedgeSymbol, positionMode: 'ONE_WAY' })

    return { spotOverCloseReject, oneWayOverCloseReject, hedgeOverCloseReject, spotLimitStatus: pendingSpotClose.status }
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

  await verify('Agent 持久化、立即评估、重启续跑与 Live 不自动下单', async () => {
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
    const manualCheck = await runtime.evaluateNow(idleAgent.id)
    assert(typeof manualCheck.evaluated === 'boolean', '立即评估没有返回结构化结果')

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
    assert(afterRestart.every((agent) => agent.status === 'running'), '重启后运行中的 Agent 没有自动续跑')
    assert(callbacks.has('BTCUSDT') && callbacks.has('ETHUSDT'), '重启后没有恢复行情订阅')
    await waitFor(async () => (await restarted.logs({ limit: 100 })).filter((event) => event.type === 'agent.resumed').length === 2)
    assert(submittedLiveOrders === 0, '重启加载期间发生 Live 自动下单')
    await restarted.close()
    return { agents: afterRestart.length, allResumed: true, immediateEvaluation: true, pendingLiveIntents: beforeRestart.find((agent) => agent.id === liveAgent.id).pendingIntents.length, liveAdapterCalls: submittedLiveOrders, stages: requiredStages }
  })

  await verify('Agent 失败重试、HEDGE 平仓与生产确认互斥', async () => {
    const crossingCandles = [100, 100, 100, 90, 110].map((close, index) => ({
      time: index + 1,
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      volume: 10,
    }))
    const createMarketHub = () => ({
      callbacks: new Map(),
      subscribeInternal(options, callback) {
        this.callbacks.set(options.symbol, callback)
        return () => this.callbacks.delete(options.symbol)
      },
      async history() {
        return crossingCandles
      },
    })

    const retryHub = createMarketHub()
    let retrySnapshots = 0
    let retryOrders = 0
    const retryRuntime = new AgentRuntime({
      dataDirectory: join(userDataDirectory, 'agents-retry-qa'),
      marketHub: retryHub,
      placeOrder: async (order) => {
        retryOrders += 1
        return { ...order, status: 'FILLED' }
      },
      getAccountSnapshot: async () => {
        retrySnapshots += 1
        if (retrySnapshots === 1) throw new Error('temporary account outage')
        return { totalWalletBalance: 25_000, availableBalance: 25_000, portfolio: [] }
      },
      isExecutionHalted: () => false,
    })
    const retryAgent = await retryRuntime.create({
      name: 'QA Retry EMA', strategy: 'ma-crossover', environment: 'paper', marketType: 'spot', symbol: 'BTCUSDT', interval: '1m',
      params: { maType: 'EMA', fastPeriod: 2, slowPeriod: 3 }, risk: { riskFraction: 0.005, maxNotional: 100 },
    })
    await retryRuntime.start(retryAgent.id)
    const failedRetryResult = await retryRuntime.evaluateNow(retryAgent.id)
    assert(failedRetryResult.evaluated === false && failedRetryResult.reason === 'error' && /temporary account outage/.test(failedRetryResult.error || ''), `立即评估失败没有返回结构化错误: ${JSON.stringify(failedRetryResult)}`)
    await waitFor(async () => (await retryRuntime.logs({ agentId: retryAgent.id })).some((event) => event.type === 'evaluation.failed'))
    let retryState = (await retryRuntime.list()).find((agent) => agent.id === retryAgent.id)
    assert(!retryState.runtime.lastEvaluatedCandle, '失败的 K 线不应被标记为已完成')
    const retryResult = await retryRuntime.evaluateNow(retryAgent.id)
    assert(retryResult.evaluated === true, `临时失败后应重试同一根 K 线，实际 ${JSON.stringify(retryResult)}`)
    retryState = (await retryRuntime.list()).find((agent) => agent.id === retryAgent.id)
    assert(retryState.runtime.lastEvaluatedCandle === crossingCandles.at(-1).time, '成功重试后没有记录已完成 K 线')
    assert(retryOrders === 1, `同一根 K 线成功重试后应只下单一次，实际 ${retryOrders}`)
    const duplicateResult = await retryRuntime.evaluateNow(retryAgent.id)
    assert(duplicateResult.reason === 'already-evaluated' && retryOrders === 1, '成功 K 线被重复执行')
    await retryRuntime.pause(retryAgent.id)
    await retryRuntime.close()

    const liveRetryHub = createMarketHub()
    let liveRetrySnapshots = 0
    let liveRetryAdapterCalls = 0
    const liveRetryRuntime = new AgentRuntime({
      dataDirectory: join(userDataDirectory, 'agents-live-retry-qa'),
      marketHub: liveRetryHub,
      placeOrder: async () => {
        liveRetryAdapterCalls += 1
        throw new Error('未确认的生产意图不应调用下单适配器')
      },
      getAccountSnapshot: async () => {
        liveRetrySnapshots += 1
        if (liveRetrySnapshots === 1) throw new Error('temporary live account outage')
        return { totalWalletBalance: 25_000, availableBalance: 25_000, futuresConfig: { positionMode: 'ONE_WAY' }, portfolio: [] }
      },
      isExecutionHalted: () => false,
    })
    const liveRetryAgent = await liveRetryRuntime.create({
      name: 'QA Live Retry EMA', strategy: 'ma-crossover', environment: 'live', marketType: 'futures', symbol: 'BTCUSDT', interval: '1m',
      params: { maType: 'EMA', fastPeriod: 2, slowPeriod: 3 }, risk: { riskFraction: 0.005, maxNotional: 100 },
    })
    await liveRetryRuntime.start(liveRetryAgent.id)
    const failedLiveRetry = await liveRetryRuntime.evaluateNow(liveRetryAgent.id)
    assert(failedLiveRetry.evaluated === false && failedLiveRetry.reason === 'error', 'Live 临时失败没有保留重试资格')
    const liveRetryResults = await Promise.all([
      liveRetryRuntime.evaluateNow(liveRetryAgent.id),
      liveRetryRuntime.evaluateNow(liveRetryAgent.id),
    ])
    assert(liveRetryResults.every((result) => result.evaluated === true), '并发重试没有复用同一次成功评估')
    const liveRetryState = (await liveRetryRuntime.list()).find((agent) => agent.id === liveRetryAgent.id)
    assert(liveRetryState.pendingIntents?.length === 1, `同一根重试 K 线生成了 ${liveRetryState.pendingIntents?.length || 0} 个生产意图`)
    assert(liveRetryAdapterCalls === 0, 'Live 重试在未确认时调用了下单适配器')
    const completedLiveRetry = await liveRetryRuntime.evaluateNow(liveRetryAgent.id)
    assert(completedLiveRetry.reason === 'already-evaluated' && liveRetryState.pendingIntents.length === 1, '完成后的 Live K 线被重复评估')
    await liveRetryRuntime.pause(liveRetryAgent.id)
    await liveRetryRuntime.close()

    const hedgeHub = createMarketHub()
    const hedgeOrders = []
    const hedgePosition = { symbol: 'BTCUSDT', marketType: 'futures', side: 'SHORT', positionSide: 'SHORT', quantity: '2', positionAmt: '-2' }
    const hedgeRuntime = new AgentRuntime({
      dataDirectory: join(userDataDirectory, 'agents-hedge-close-qa'),
      marketHub: hedgeHub,
      placeOrder: async (order) => {
        hedgeOrders.push(order)
        return { ...order, status: 'FILLED' }
      },
      getAccountSnapshot: async () => ({
        totalWalletBalance: 25_000,
        availableBalance: 0,
        futuresConfig: { positionMode: 'HEDGE' },
        portfolio: [hedgePosition],
      }),
      isExecutionHalted: () => false,
    })
    const hedgeAgent = await hedgeRuntime.create({
      name: 'QA HEDGE Close', strategy: 'ma-crossover', environment: 'paper', marketType: 'futures', symbol: 'BTCUSDT', interval: '1m',
      params: { maType: 'EMA', fastPeriod: 2, slowPeriod: 3 }, risk: { riskFraction: 0.005, maxNotional: 100 },
    })
    await hedgeRuntime.start(hedgeAgent.id)
    await waitFor(() => hedgeOrders.length === 1)
    assert(hedgeOrders[0].side === 'BUY' && hedgeOrders[0].positionSide === 'SHORT', 'HEDGE SHORT 没有使用 BUY + SHORT 平仓')
    assert(!hedgeOrders[0].reduceOnly, 'HEDGE 平仓不应向 Binance 发送 reduceOnly')
    assert(Number(hedgeOrders[0].quantity) === 2, 'HEDGE 平仓没有使用完整持仓数量')
    await hedgeRuntime.pause(hedgeAgent.id)
    await hedgeRuntime.close()

    const confirmHub = createMarketHub()
    let confirmedOrders = 0
    const confirmRuntime = new AgentRuntime({
      dataDirectory: join(userDataDirectory, 'agents-confirm-lock-qa'),
      marketHub: confirmHub,
      placeOrder: async (order) => {
        confirmedOrders += 1
        await new Promise((resolve) => setTimeout(resolve, 40))
        return { ...order, status: 'FILLED' }
      },
      getAccountSnapshot: async () => ({
        totalWalletBalance: 25_000,
        availableBalance: 25_000,
        futuresConfig: { positionMode: 'ONE_WAY' },
        portfolio: [],
      }),
      isExecutionHalted: () => false,
    })
    const confirmAgent = await confirmRuntime.create({
      name: 'QA Confirm Lock', strategy: 'ma-crossover', environment: 'live', marketType: 'futures', symbol: 'BTCUSDT', interval: '1m',
      params: { maType: 'EMA', fastPeriod: 2, slowPeriod: 3 }, risk: { riskFraction: 0.005, maxNotional: 100 },
    })
    await confirmRuntime.start(confirmAgent.id)
    await waitFor(async () => (await confirmRuntime.list()).some((agent) => agent.id === confirmAgent.id && agent.pendingIntents?.length === 1))
    const pendingIntent = (await confirmRuntime.list()).find((agent) => agent.id === confirmAgent.id).pendingIntents[0]
    const confirmations = await Promise.all([
      confirmRuntime.confirmIntent(pendingIntent.id),
      confirmRuntime.confirmIntent(pendingIntent.id),
    ])
    assert(confirmedOrders === 1, `并发确认同一生产意图调用了 ${confirmedOrders} 次下单适配器`)
    assert(confirmations[0].intent.status === 'executed' && confirmations[1].intent.status === 'executed', '并发确认没有复用同一执行结果')
    await confirmRuntime.pause(confirmAgent.id)
    await confirmRuntime.close()

    return {
      retrySnapshots,
      retryOrders,
      failedEvaluateNow: failedRetryResult.reason,
      retryLivePendingIntents: liveRetryState.pendingIntents.length,
      retryLiveAdapterCalls: liveRetryAdapterCalls,
      hedgeClose: { side: hedgeOrders[0].side, positionSide: hedgeOrders[0].positionSide, reduceOnly: Boolean(hedgeOrders[0].reduceOnly) },
      concurrentConfirmationAdapterCalls: confirmedOrders,
    }
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
