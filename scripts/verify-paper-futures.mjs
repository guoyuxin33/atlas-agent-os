import { spawnSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
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
    aggregateOrderTrades,
    buildBinanceSpotSnapshot,
    calculateServerTimeOffset,
    cancelOrder,
    createSignedQuery,
    getAccountSnapshot,
    getFuturesConfiguration,
    getFuturesPositionMode,
    getOpenOrders,
    getOrder,
    getOrders,
    normalizeBinanceOrder,
    placeOrder,
    resetBinanceNetworkState,
    setFuturesLeverage,
    setFuturesMarginType,
    setFuturesPositionMode,
    setBinanceRequestFetcherForTests,
    requestBinanceForTests,
  } = await import('../electron/services/binance.mjs')
  const { ExchangeInfoCatalog } = await import('../electron/services/exchange-info.mjs')
  const { AgentRuntime } = await import('../electron/services/agent-runtime.mjs')
  const { authorizeAgentMcpTools, buildAgentSupervisionContext, buildAgentSupervisorSystem, buildAssistantSystem, partitionAgentSkills, resolveAgentSkills } = await import('../electron/services/ai.mjs')
  const { saveVault } = await import('../electron/services/vault.mjs')

  await verify('Binance 签名时间校准与成交聚合', async () => {
    const offset = calculateServerTimeOffset(10_250, 10_000, 10_100)
    assert(offset === 200, `服务器时间偏移计算错误: ${offset}`)
    const signed = createSignedQuery({ symbol: 'BTCUSDT', side: 'BUY' }, { timestamp: 12_345, recvWindow: 5000, apiSecret: 'qa-secret' })
    const signature = signed.get('signature')
    signed.delete('signature')
    const expected = createHmac('sha256', 'qa-secret').update(signed.toString()).digest('hex')
    assert(signature === expected && signed.get('timestamp') === '12345', 'Binance 请求签名或时间戳错误')
    const aggregates = aggregateOrderTrades([
      { orderId: 7, qty: '0.2', quoteQty: '20', realizedPnl: '1.25', commission: '0.01', commissionAsset: 'USDT' },
      { orderId: 7, qty: '0.3', quoteQty: '33', realizedPnl: '-0.25', commission: '0.02', commissionAsset: 'USDT' },
    ])
    const aggregate = aggregates.get('7')
    assert(almostEqual(aggregate.executedQty, 0.5) && almostEqual(aggregate.quoteQty, 53), '成交数量或成交额聚合错误')
    assert(almostEqual(aggregate.realizedPnl, 1) && almostEqual(aggregate.commissions.get('USDT'), 0.03), '已实现盈亏或手续费聚合错误')
    return { offset, realizedPnl: aggregate.realizedPnl, commission: aggregate.commissions.get('USDT') }
  })

  await verify('Binance REST mock 成交明细、限流熔断与校时重试', async () => {
    await saveVault('binance-testnet', { apiKey: 'qa-key', apiSecret: 'qa-secret', environment: 'testnet' })
    const response = (payload, status = 200, headers) => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json', ...(headers || {}) } })

    let restore = setBinanceRequestFetcherForTests(async (url, options = {}) => {
      const target = new URL(url)
      if (target.pathname === '/fapi/v1/time') return response({ serverTime: Date.now() })
      assert(options.headers?.['X-MBX-APIKEY'] === 'qa-key' && target.searchParams.has('signature'), '签名请求缺少 API Key 或 signature')
      if (target.pathname === '/fapi/v1/allOrders') return response([{ orderId: 77, symbol: 'BTCUSDT', side: 'SELL', type: 'MARKET', status: 'FILLED', origQty: '0.5', executedQty: '0.5', avgPrice: '0', cumQuote: '53', time: 100 }])
      if (target.pathname === '/fapi/v1/userTrades') return response([
        { orderId: 77, qty: '0.2', quoteQty: '20', price: '100', realizedPnl: '1.25', commission: '0.01', commissionAsset: 'USDT' },
        { orderId: 77, qty: '0.3', quoteQty: '33', price: '110', realizedPnl: '-0.25', commission: '0.02', commissionAsset: 'USDT' },
      ])
      throw new Error(`QA unexpected Binance request ${options.method || 'GET'} ${target.pathname}`)
    })
    let enriched
    try {
      enriched = (await getOrders({ environment: 'testnet', marketType: 'futures', symbol: 'BTCUSDT' }))[0]
      assert(enriched.realizedPnl === '1' && enriched.commission === '0.03' && enriched.avgPrice === '106', `userTrades 聚合未进入订单: ${JSON.stringify(enriched)}`)
    } finally {
      restore()
    }

    const rateLimitResults = []
    for (const status of [429, 418]) {
      let endpointCalls = 0
      restore = setBinanceRequestFetcherForTests(async (url) => {
        const target = new URL(url)
        if (target.pathname === '/api/v3/time') return response({ serverTime: Date.now() })
        endpointCalls += 1
        return response({ code: -1003, msg: 'Too many requests' }, status, { 'retry-after': '120' })
      })
      try {
        const requestOptions = { environment: 'testnet', marketType: 'spot', path: '/api/v3/account', signed: true, credentials: { apiKey: 'qa-key', apiSecret: 'qa-secret', environment: 'testnet' } }
        await expectReject(() => requestBinanceForTests(requestOptions), /暂停 REST 请求|Too many requests/)
        await expectReject(() => requestBinanceForTests(requestOptions), /暂停 REST 请求/)
        assert(endpointCalls === 1, `${status} 后仍向 Binance mock 重试了 ${endpointCalls} 次`)
        resetBinanceNetworkState()
        await expectReject(() => requestBinanceForTests(requestOptions), /暂停 REST 请求|Too many requests/)
        assert(endpointCalls === 2, `${status} 后切换网络出口未恢复 REST 探测`)
        rateLimitResults.push({ status, endpointCalls, resetRecovered: true })
      } finally {
        restore()
      }
    }

    let postCalls = 0
    let timeCalls = 0
    restore = setBinanceRequestFetcherForTests(async (url, options = {}) => {
      const target = new URL(url)
      if (target.pathname === '/fapi/v1/time') {
        timeCalls += 1
        return response({ serverTime: Date.now() + 250 })
      }
      assert(target.pathname === '/fapi/v1/order' && options.method === 'POST', '校时重试访问了非预期接口')
      postCalls += 1
      return postCalls === 1 ? response({ code: -1021, msg: 'Timestamp outside recvWindow' }, 400) : response({ orderId: 88, status: 'NEW' })
    })
    try {
      const result = await requestBinanceForTests({
        environment: 'testnet', marketType: 'futures', path: '/fapi/v1/order', method: 'POST', signed: true,
        credentials: { apiKey: 'qa-key', apiSecret: 'qa-secret', environment: 'testnet' }, params: { symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: '0.001' },
      })
      assert(result.orderId === 88 && postCalls === 2 && timeCalls === 2, `-1021 没有完成一次校时重试: ${JSON.stringify({ postCalls, timeCalls })}`)
    } finally {
      restore()
    }

    const cancelReject = await expectReject(
      () => cancelOrder({ environment: 'live', marketType: 'futures', symbol: 'BTCUSDT', orderId: '99' }),
      /生产撤单缺少二次确认/,
    )
    return { enriched: { realizedPnl: enriched.realizedPnl, commission: enriched.commission, avgPrice: enriched.avgPrice }, rateLimitResults, postCalls, timeCalls, cancelReject }
  })

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
    const firstClose = (await getOrders({ environment: 'paper', marketType: 'spot', symbol })).find((order) => order.side === 'SELL')
    assert(almostEqual(firstClose?.realizedPnl, 20) && firstClose?.avgPrice === '120', `现货订单实际盈亏未记录: ${JSON.stringify(firstClose)}`)

    await placeOrder(paperOrder({ symbol, side: 'SELL', quantity: '1', marketPrice: '90' }))
    state = await readPaperState()
    assert(almostEqual(state.spot.realizedPnl, 10), `现货平仓后已实现收益应为 10，实际 ${state.spot.realizedPnl}`)
    assert(almostEqual(state.spot.usdt, 25_010), `现货平仓后权益应为 25010，实际 ${state.spot.usdt}`)
    assert(!state.spot.holdings.some((item) => item.symbol === symbol), '现货平仓后仍残留持仓')
    return { realizedPnl: state.spot.realizedPnl, equity: state.spot.usdt, markedUnrealizedPnl: unrealizedPnl }
  })

  await verify('Paper 挂单查询与撤单', async () => {
    const symbol = 'QACANCELUSDT'
    const created = await placeOrder(paperOrder({ symbol, side: 'BUY', type: 'LIMIT', quantity: '1', price: '50', marketPrice: '100', clientOrderId: 'qa_cancel_1' }))
    assert(created.status === 'NEW', '非市价限价单应保持挂单状态')
    const open = await getOpenOrders({ environment: 'paper', marketType: 'spot', symbol })
    assert(open.length === 1 && open[0].clientOrderId === 'qa_cancel_1', '挂单列表缺少新订单')
    const queried = await getOrder({ environment: 'paper', marketType: 'spot', symbol, clientOrderId: 'qa_cancel_1' })
    assert(queried.orderId === created.orderId, '按 clientOrderId 查询订单失败')
    const cancelled = await cancelOrder({ environment: 'paper', marketType: 'spot', symbol, orderId: created.orderId })
    assert(cancelled.status === 'CANCELED', '模拟撤单状态错误')
    assert((await getOpenOrders({ environment: 'paper', marketType: 'spot', symbol })).length === 0, '撤单后仍出现在挂单列表')
    return { orderId: created.orderId, status: cancelled.status }
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
    const partialLongClose = await placeOrder(paperOrder({ symbol: longSymbol, marketType: 'futures', side: 'SELL', quantity: '1', marketPrice: '1200', positionSide: 'BOTH', reduceOnly: true }))
    assert(partialLongClose.realizedPnl === '200' && partialLongClose.avgPrice === '1200', `合约平仓订单实际盈亏未记录: ${JSON.stringify(partialLongClose)}`)

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

  await verify('Agent 持仓方向模式、现货降级与反向信号平仓', async () => {
    const upCandles = [100, 100, 100, 90, 110].map((close, index) => ({ time: index + 1, open: close, high: close + 1, low: close - 1, close, volume: 10 }))
    const downCandles = [100, 100, 100, 110, 90].map((close, index) => ({ time: index + 1, open: close, high: close + 1, low: close - 1, close, volume: 10 }))
    const establishedUptrend = [90, 92, 94, 96, 98].map((close, index) => ({ time: index + 1, open: close, high: close + 1, low: close - 1, close, volume: 10 }))
    const runDirectionCase = async ({ name, marketType = 'futures', positionMode, candles, portfolio = [], exchangePositionMode = 'ONE_WAY' }) => {
      const submitted = []
      const runtime = new AgentRuntime({
        dataDirectory: join(userDataDirectory, `agents-direction-${name}`),
        marketHub: {
          subscribeInternal() { return () => {} },
          async history() { return candles },
        },
        placeOrder: async (order) => {
          submitted.push(order)
          return { ...order, status: 'FILLED' }
        },
        getAccountSnapshot: async () => ({
          totalWalletBalance: 25_000,
          availableBalance: portfolio.length ? 0 : 25_000,
          futuresConfig: { positionMode: exchangePositionMode },
          portfolio,
        }),
        isExecutionHalted: () => false,
      })
      const agent = await runtime.create({
        name: `QA Direction ${name}`,
        strategy: 'ma-crossover',
        environment: 'paper',
        marketType,
        ...(positionMode ? { positionMode } : {}),
        symbol: 'BTCUSDT',
        interval: '1m',
        params: { maType: 'EMA', fastPeriod: 2, slowPeriod: 3 },
        risk: { riskFraction: 0.005, maxNotional: 100 },
      })
      await runtime.start(agent.id)
      await waitFor(async () => (await runtime.logs({ agentId: agent.id, limit: 100 })).some((event) => event.type === 'COMPLETED'))
      const logs = await runtime.logs({ agentId: agent.id, limit: 100 })
      const state = (await runtime.list()).find((item) => item.id === agent.id)
      await runtime.pause(agent.id)
      await runtime.close()
      return { submitted, logs, state }
    }

    const autoShort = await runDirectionCase({ name: 'auto-short', positionMode: 'auto', candles: downCandles })
    assert(autoShort.submitted.length === 1 && autoShort.submitted[0].side === 'SELL', 'AUTO 合约没有按空头信号开空')

    const regimeEntry = await runDirectionCase({ name: 'regime-entry', positionMode: 'auto', candles: establishedUptrend })
    assert(regimeEntry.submitted.length === 1 && regimeEntry.submitted[0].side === 'BUY', '均线趋势已形成时启动的空仓 Agent 没有建立初始仓位')

    const autoHedgeLong = await runDirectionCase({ name: 'auto-hedge-long', positionMode: 'auto', candles: upCandles, exchangePositionMode: 'HEDGE' })
    assert(autoHedgeLong.submitted.length === 1 && autoHedgeLong.submitted[0].side === 'BUY' && autoHedgeLong.submitted[0].positionSide === 'LONG', 'AUTO HEDGE 没有使用 BUY + LONG 开多')

    const autoHedgeShort = await runDirectionCase({ name: 'auto-hedge-short', positionMode: 'auto', candles: downCandles, exchangePositionMode: 'HEDGE' })
    assert(autoHedgeShort.submitted.length === 1 && autoHedgeShort.submitted[0].side === 'SELL' && autoHedgeShort.submitted[0].positionSide === 'SHORT', 'AUTO HEDGE 没有使用 SELL + SHORT 开空')

    const shortOnlyShort = await runDirectionCase({ name: 'short-only-short', positionMode: 'short-only', candles: downCandles })
    assert(shortOnlyShort.submitted.length === 1 && shortOnlyShort.submitted[0].side === 'SELL', 'SHORT_ONLY 合约没有允许空头开仓')

    const longOnlyFiltered = await runDirectionCase({ name: 'long-only-filter', positionMode: 'long-only', candles: downCandles })
    assert(longOnlyFiltered.submitted.length === 0 && longOnlyFiltered.logs.some((event) => event.type === 'DIRECTION_FILTERED'), 'LONG_ONLY 没有过滤空头开仓')

    const shortOnlyFiltered = await runDirectionCase({ name: 'short-only-filter', positionMode: 'short-only', candles: upCandles })
    assert(shortOnlyFiltered.submitted.length === 0 && shortOnlyFiltered.logs.some((event) => event.type === 'DIRECTION_FILTERED'), 'SHORT_ONLY 没有过滤多头开仓')

    const longPosition = { symbol: 'BTCUSDT', marketType: 'futures', side: 'LONG', positionSide: 'BOTH', quantity: '2', positionAmt: '2' }
    const longOnlyClose = await runDirectionCase({ name: 'long-only-close', positionMode: 'long-only', candles: downCandles, portfolio: [longPosition] })
    assert(longOnlyClose.submitted.length === 1 && longOnlyClose.submitted[0].side === 'SELL' && longOnlyClose.submitted[0].reduceOnly === true, 'LONG_ONLY 阻止了反向信号平多')

    const shortPosition = { symbol: 'BTCUSDT', marketType: 'futures', side: 'SHORT', positionSide: 'BOTH', quantity: '2', positionAmt: '-2' }
    const shortOnlyClose = await runDirectionCase({ name: 'short-only-close', positionMode: 'short-only', candles: upCandles, portfolio: [shortPosition] })
    assert(shortOnlyClose.submitted.length === 1 && shortOnlyClose.submitted[0].side === 'BUY' && shortOnlyClose.submitted[0].reduceOnly === true, 'SHORT_ONLY 阻止了反向信号平空')

    const spotForcedLong = await runDirectionCase({ name: 'spot-forced-long', marketType: 'spot', positionMode: 'short-only', candles: downCandles })
    assert(spotForcedLong.state.positionMode === 'long-only', `现货 Agent 未强制 long-only：${spotForcedLong.state.positionMode}`)
    assert(spotForcedLong.submitted.length === 0 && spotForcedLong.logs.some((event) => event.type === 'DIRECTION_FILTERED'), '现货 Agent 对空头信号发生了裸卖空')

    const legacyFutures = await runDirectionCase({ name: 'legacy-futures-default', candles: upCandles })
    assert(legacyFutures.state.positionMode === 'auto', `旧合约 Agent 默认模式不是 auto：${legacyFutures.state.positionMode}`)

    return {
      autoShortSide: autoShort.submitted[0].side,
      regimeEntrySide: regimeEntry.submitted[0].side,
      autoHedgeLong: { side: autoHedgeLong.submitted[0].side, positionSide: autoHedgeLong.submitted[0].positionSide },
      autoHedgeShort: { side: autoHedgeShort.submitted[0].side, positionSide: autoHedgeShort.submitted[0].positionSide },
      shortOnlyShortSide: shortOnlyShort.submitted[0].side,
      longOnlyFilteredOrders: longOnlyFiltered.submitted.length,
      shortOnlyFilteredOrders: shortOnlyFiltered.submitted.length,
      longOnlyClose: { side: longOnlyClose.submitted[0].side, reduceOnly: longOnlyClose.submitted[0].reduceOnly },
      shortOnlyClose: { side: shortOnlyClose.submitted[0].side, reduceOnly: shortOnlyClose.submitted[0].reduceOnly },
      spotEffectiveMode: spotForcedLong.state.positionMode,
      futuresLegacyMode: legacyFutures.state.positionMode,
    }
  })

  await verify('Agent 编辑版本保护、旧意图失效与重启持久化', async () => {
    const directory = join(userDataDirectory, 'agents-update-qa')
    const callbacks = new Map()
    const candles = [100, 100, 100, 90, 110].map((close, index) => ({
      time: index + 1,
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      volume: 10,
    }))
    const marketHub = {
      subscribeInternal(options, callback) {
        callbacks.set(options.symbol, callback)
        return () => callbacks.delete(options.symbol)
      },
      async history() { return candles },
    }
    let adapterCalls = 0
    const runtime = new AgentRuntime({
      dataDirectory: directory,
      marketHub,
      placeOrder: async () => { adapterCalls += 1; throw new Error('旧 Live 意图不得提交') },
      getAccountSnapshot: async () => ({ totalWalletBalance: 25_000, availableBalance: 25_000, futuresConfig: { positionMode: 'ONE_WAY' }, portfolio: [] }),
      isExecutionHalted: () => false,
    })
    const created = await runtime.create({
      name: 'QA Editable Agent', strategy: 'ma-crossover', environment: 'live', marketType: 'futures', positionMode: 'auto', symbol: 'BTCUSDT', interval: '1m',
      params: { maType: 'EMA', fastPeriod: 2, slowPeriod: 3 }, risk: { riskFraction: 0.005, maxNotional: 100 },
    })
    assert(created.revision === 1, '新 Agent 配置版本不是 1')
    await runtime.start(created.id)
    await waitFor(async () => (await runtime.list()).find((agent) => agent.id === created.id)?.pendingIntents?.length === 1)
    const oldIntent = (await runtime.list()).find((agent) => agent.id === created.id).pendingIntents[0]
    const updated = await runtime.update(created.id, {
      name: 'QA Editable Agent v2', strategy: 'ma-crossover', environment: 'paper', marketType: 'futures', positionMode: 'short-only', symbol: 'ETHUSDT', interval: '5m',
      params: { maType: 'EMA', fastPeriod: 3, slowPeriod: 8 }, risk: { riskFraction: 0.004, maxNotional: 200 },
    }, created.revision)
    assert(updated.revision === 2 && updated.status === 'paused', '编辑后没有递增版本并保持暂停')
    assert(updated.symbol === 'ETHUSDT' && updated.positionMode === 'short-only', '编辑字段没有落盘')
    assert(!callbacks.has('BTCUSDT'), '编辑运行中 Agent 后旧订阅仍存在')
    assert((await runtime.list()).find((agent) => agent.id === created.id).pendingIntents.length === 0, '编辑后旧生产意图仍可见')
    await expectReject(() => runtime.confirmIntent(oldIntent.id), /已处理|配置已更新/)
    await expectReject(() => runtime.update(created.id, {
      name: 'Stale overwrite', strategy: 'ma-crossover', environment: 'paper', marketType: 'futures', positionMode: 'auto', symbol: 'SOLUSDT', interval: '1m',
    }, created.revision), /其他操作更新/)
    const logs = await runtime.logs({ agentId: created.id, limit: 100 })
    assert(logs.some((event) => event.type === 'agent.updated') && logs.some((event) => event.type === 'INTENT_INVALIDATED'), '编辑审计日志不完整')
    await runtime.close()

    const restarted = new AgentRuntime({
      dataDirectory: directory,
      marketHub,
      placeOrder: async () => { adapterCalls += 1; throw new Error('暂停 Agent 不得提交') },
      getAccountSnapshot: async () => ({ totalWalletBalance: 25_000, availableBalance: 25_000, portfolio: [] }),
      isExecutionHalted: () => false,
    })
    const restored = (await restarted.list()).find((agent) => agent.id === created.id)
    assert(restored.revision === 2 && restored.status === 'paused' && restored.symbol === 'ETHUSDT', '重启后没有恢复编辑结果')
    await restarted.close()
    assert(adapterCalls === 0, `编辑/重启路径意外调用下单适配器 ${adapterCalls} 次`)
    return { revision: restored.revision, status: restored.status, symbol: restored.symbol, invalidatedIntent: oldIntent.id, adapterCalls }
  })

  await verify('Agent AI 监督批准、拒绝、故障关闭与 Live 待确认', async () => {
    const selectedSkillIds = ['market-analysis', 'risk-review', 'execution-quality', 'futures-carry-risk']
    const selectedSkills = resolveAgentSkills(selectedSkillIds)
    const skillSystem = buildAgentSupervisorSystem(selectedSkillIds)
    const riskSkill = selectedSkills.find((skill) => skill.id === 'risk-review')
    assert(skillSystem.includes(`[受信任 Skill risk-review@${riskSkill.version}]`) && skillSystem.includes(riskSkill.instructions), '受信任 Skill 的完整版本化指令没有注入监督 system')
    assert(selectedSkills.every((skill) => skill.inputBoundary.required.length && skill.inputBoundary.prohibited.length), '成熟 Skill 缺少明确输入边界')
    assert(skillSystem.includes('任一 Skill 否决则最终 REJECT') && skillSystem.includes('execution-quality'), '监督 system 没有要求逐项执行 Skill')
    const assistantSystem = buildAssistantSystem({ skills: ['market-analysis', 'execution-quality'], context: { symbol: 'BTCUSDT', price: 100 } }, [])
    assert(assistantSystem.includes('[受信任 Skill market-analysis@2.0.0]') && assistantSystem.includes('[受信任 Skill execution-quality@1.0.0]'), 'AI 对话没有注入版本化 Skill 指令')
    assert(assistantSystem.includes('当前上下文') && assistantSystem.includes('BTCUSDT'), 'AI 对话没有携带行情上下文')
    await expectReject(async () => resolveAgentSkills(['front-end-injected-instructions']), /未知 Skill/)
    const discoveredMcp = [{ url: 'https://mcp.example.test/rpc', tools: [{ name: 'market.read' }, { name: 'orders.submit' }] }]
    assert(authorizeAgentMcpTools(discoveredMcp, [])[0].tools.length === 0, '空 MCP 白名单不应向模型暴露任何工具')
    const authorizedMcp = authorizeAgentMcpTools(discoveredMcp, ['market.read'])
    assert(authorizedMcp[0].tools.length === 1 && authorizedMcp[0].tools[0].name === 'market.read', 'MCP 工具白名单没有精确过滤')
    await expectReject(async () => authorizeAgentMcpTools(discoveredMcp, ['unknown.tool']), /未提供的工具/)
    const skillCandles = Array.from({ length: 30 }, (_, index) => ({
      time: index + 1,
      open: 100 + index * 0.2,
      high: 101 + index * 0.2,
      low: 99 + index * 0.2,
      close: 100.5 + index * 0.2,
      volume: 100 + index,
    }))
    const supervisionContext = buildAgentSupervisionContext({
      agent: { id: 'skill-agent', strategy: 'ma-crossover', environment: 'paper', marketType: 'futures', positionMode: 'auto', symbol: 'BTCUSDT', interval: '15m', params: {}, risk: { riskFraction: 0.005, maxNotional: 500 } },
      intelligence: { mode: 'ai-supervised', skills: selectedSkillIds },
      candidateOrder: { environment: 'paper', marketType: 'futures', symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: '0.01', marketPrice: '105', leverage: 5, marginType: 'CROSSED', reduceOnly: false },
      signal: { direction: 'long', reason: '均线向上交叉' },
      candleTime: 30,
      candles: skillCandles,
      account: { totalWalletBalance: 25_000, availableBalance: 20_000, unrealizedPnl: 20, todayPnl: 15, position: { side: 'LONG', markPrice: '105', liquidationPrice: '82', leverage: '5', marginRatio: '0.08' } },
    }, authorizedMcp)
    assert(supervisionContext.selectedSkills.map((skill) => skill.id).join(',') === selectedSkillIds.join(','), '监督上下文没有携带选择的 Skill')
    assert(supervisionContext.recentCandles.length === 30 && supervisionContext.signal.direction === 'long' && supervisionContext.account.totalWalletBalance === 25_000, '监督上下文缺少行情、账户或策略信号')
    assert(supervisionContext.skillInputs['market-analysis'].derived.regime.closedCandleCount === 30, '市场状态 Skill 没有获得闭合 K 线派生指标')
    assert(supervisionContext.skillInputs['risk-review'].derived.riskBudget.candidateNotional > 0, '风险预算 Skill 没有获得候选仓位指标')
    assert(supervisionContext.skillInputs['execution-quality'].derived.execution.candidateToAverageCandleTurnover > 0, '执行质量 Skill 没有获得流动性代理指标')
    assert(supervisionContext.skillInputs['futures-carry-risk'].derived.futuresRisk.liquidationBufferPct > 0, '合约 Skill 没有获得清算缓冲指标')
    assert(supervisionContext.skillInputs['futures-carry-risk'].derived.futuresRisk.fundingRateAvailable === false, '缺失资金费率时不得伪造可用数据')
    const crossingCandles = [100, 100, 100, 90, 110].map((close, index) => ({
      time: index + 1,
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      volume: 10,
    }))
    const captureRuntimeSupervision = async ({ name, marketType, skills, snapshot }) => {
      let capturedRequest
      let adapterCalls = 0
      const runtime = new AgentRuntime({
        dataDirectory: join(userDataDirectory, `agents-ai-context-${name}`),
        marketHub: {
          subscribeInternal() { return () => {} },
          async history() { return crossingCandles },
        },
        superviseCandidate: async (request) => {
          capturedRequest = structuredClone(request)
          const partitioned = partitionAgentSkills(request.intelligence.skills, request.agent.marketType)
          return {
            decision: 'REJECT',
            confidence: 0.99,
            reason: 'QA 仅捕获监督上下文，不允许执行订单',
            skillAudit: {
              applicable: partitioned.applicable.map(({ id, version }) => ({ id, version, status: 'APPLICABLE' })),
              skipped: partitioned.skipped,
            },
          }
        },
        placeOrder: async () => { adapterCalls += 1; throw new Error('上下文 QA 不得调用订单适配器') },
        getAccountSnapshot: async () => structuredClone(snapshot),
        isExecutionHalted: () => false,
      })
      const agent = await runtime.create({
        name: `QA Skill Context ${name}`,
        strategy: 'ma-crossover',
        environment: 'paper',
        marketType,
        positionMode: marketType === 'futures' ? 'auto' : 'long-only',
        symbol: 'BTCUSDT',
        interval: '1m',
        params: { maType: 'EMA', fastPeriod: 2, slowPeriod: 3 },
        risk: { riskFraction: 0.005, maxNotional: 100 },
        intelligence: { mode: 'ai-supervised', model: 'qa-model', skills, mcpServers: [], mcpTools: [], confidenceThreshold: 0.7, failClosed: true },
      })
      await runtime.start(agent.id)
      await waitFor(async () => (await runtime.logs({ agentId: agent.id, limit: 100 })).some((event) => event.type === 'COMPLETED'))
      const logs = await runtime.logs({ agentId: agent.id, limit: 100 })
      await runtime.pause(agent.id)
      await runtime.close()
      assert(capturedRequest, `${name} 没有从 AgentRuntime 捕获监督请求`)
      assert(adapterCalls === 0, `${name} 上下文 QA 意外调用订单适配器 ${adapterCalls} 次`)
      return { request: capturedRequest, logs }
    }
    const emptyFutures = await captureRuntimeSupervision({
      name: 'empty-futures',
      marketType: 'futures',
      skills: selectedSkillIds,
      snapshot: {
        totalWalletBalance: 25_000,
        availableBalance: 24_000,
        unrealizedPnl: 0,
        todayPnl: -3,
        fundingPnlToday: -3,
        futuresConfig: { symbol: 'BTCUSDT', leverage: 12, marginType: 'ISOLATED', isolatedMargin: 0, positionAmt: 0, positionMode: 'ONE_WAY', positionSide: 'BOTH' },
        portfolio: [],
      },
    })
    assert(emptyFutures.request.candidateOrder.leverage === 12 && emptyFutures.request.candidateOrder.marginType === 'ISOLATED', '空仓合约监督候选没有从账户配置补齐杠杆和保证金模式')
    assert(emptyFutures.request.account.futuresConfig.leverage === 12 && emptyFutures.request.account.fundingPnlToday === -3, 'AgentRuntime 监督账户快照缺少 futuresConfig 或 fundingPnlToday')
    const emptyFuturesContext = buildAgentSupervisionContext(emptyFutures.request)
    const emptyFuturesRisk = emptyFuturesContext.skillInputs['futures-carry-risk'].derived.futuresRisk
    assert(emptyFuturesRisk.leverage === 12 && emptyFuturesRisk.marginType === 'ISOLATED' && emptyFuturesRisk.positionMode === 'ONE_WAY', '空仓合约 Skill 没有从账户配置正确回退')
    const spotSkipped = await captureRuntimeSupervision({
      name: 'spot-skip-futures-skill',
      marketType: 'spot',
      skills: ['market-analysis', 'futures-carry-risk'],
      snapshot: { totalWalletBalance: 25_000, availableBalance: 25_000, unrealizedPnl: 0, todayPnl: 0, portfolio: [] },
    })
    const spotContext = buildAgentSupervisionContext(spotSkipped.request)
    assert(spotContext.selectedSkills.map((skill) => skill.id).join(',') === 'market-analysis', 'Spot 监督上下文仍把合约 Skill 当作必做项')
    assert(!spotContext.skillInputs['futures-carry-risk'], 'Spot 监督上下文不应构建合约 Skill 输入')
    assert(spotContext.skippedSkills.some((skill) => skill.id === 'futures-carry-risk' && skill.status === 'NOT_APPLICABLE'), 'Spot 合约 Skill 没有确定性标记 NOT_APPLICABLE')
    const spotAuditLog = spotSkipped.logs.find((event) => event.type === 'AI_REJECTED')
    assert(spotAuditLog?.data?.skillAudit?.skipped?.some((skill) => skill.id === 'futures-carry-risk' && skill.status === 'NOT_APPLICABLE'), 'Spot 合约 Skill 的 NOT_APPLICABLE 状态没有写入运行时审计')
    const runCase = async ({ name, superviseCandidate, environment = 'paper', marketType = 'spot', confidenceThreshold = 0.7, aiTimeoutMs = 500 }) => {
      const submitted = []
      const marketHub = {
        subscribeInternal() { return () => {} },
        async history() { return crossingCandles },
      }
      const runtime = new AgentRuntime({
        dataDirectory: join(userDataDirectory, `agents-ai-${name}`),
        marketHub,
        superviseCandidate,
        aiTimeoutMs,
        placeOrder: async (order) => {
          submitted.push(order)
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
      const agent = await runtime.create({
        name: `QA AI ${name}`,
        strategy: 'ma-crossover',
        environment,
        marketType,
        symbol: 'BTCUSDT',
        interval: '1m',
        params: { maType: 'EMA', fastPeriod: 2, slowPeriod: 3 },
        risk: { riskFraction: 0.005, maxNotional: 100 },
        intelligence: {
          mode: 'ai-supervised',
          model: 'qa-model',
          skills: ['risk-review'],
          mcpServers: ['https://mcp.example.test/rpc'],
          mcpTools: ['market.read'],
          confidenceThreshold,
          failClosed: false,
        },
      })
      await runtime.start(agent.id)
      await waitFor(async () => (await runtime.logs({ agentId: agent.id, limit: 100 })).some((event) => event.type === 'COMPLETED'))
      const logs = await runtime.logs({ agentId: agent.id, limit: 100 })
      const state = (await runtime.list()).find((item) => item.id === agent.id)
      await runtime.pause(agent.id)
      await runtime.close()
      return { submitted, logs, state }
    }

    let frozenCandidate
    const approved = await runCase({
      name: 'approved',
      superviseCandidate: async (request) => {
        frozenCandidate = structuredClone(request.candidateOrder)
        return { decision: 'APPROVE', confidence: 0.96, reason: '趋势与风险条件一致', side: 'SELL', quantity: '999999' }
      },
    })
    for (const stage of ['AI_CONTEXT_READY', 'AI_REASONING', 'AI_APPROVED']) {
      assert(approved.logs.some((event) => event.type === stage), `AI 批准路径缺少阶段 ${stage}`)
    }
    assert(approved.submitted.length === 1, `AI 批准后应提交一笔 Paper 订单，实际 ${approved.submitted.length}`)
    assert(approved.submitted[0].side === frozenCandidate.side && approved.submitted[0].quantity === frozenCandidate.quantity, 'AI 返回的订单篡改字段影响了确定性候选单')

    const rejected = await runCase({
      name: 'rejected',
      superviseCandidate: async () => ({ decision: 'REJECT', confidence: 0.91, reason: '市场条件不足' }),
    })
    assert(rejected.logs.some((event) => event.type === 'AI_REJECTED') && rejected.submitted.length === 0, 'AI 明确拒绝后仍提交了订单')

    const lowConfidence = await runCase({
      name: 'low-confidence',
      confidenceThreshold: 0.8,
      superviseCandidate: async () => ({ decision: 'APPROVE', confidence: 0.79, reason: '证据强度不足' }),
    })
    assert(lowConfidence.logs.some((event) => event.type === 'AI_REJECTED' && event.data?.rejectionReason === 'LOW_CONFIDENCE'), '低置信度批准没有被拒绝')
    assert(lowConfidence.submitted.length === 0, '低置信度批准后仍提交了订单')

    const malformed = await runCase({
      name: 'malformed',
      superviseCandidate: async () => ({ decision: 'MAYBE', confidence: 0.9, reason: 'invalid' }),
    })
    assert(malformed.logs.some((event) => event.type === 'AI_FAILED') && malformed.logs.some((event) => event.type === 'AI_REJECTED'), '非法 AI 响应没有 fail-closed')
    assert(malformed.submitted.length === 0, '非法 AI 响应后仍提交了订单')

    const timedOut = await runCase({
      name: 'timeout',
      aiTimeoutMs: 100,
      superviseCandidate: async () => new Promise(() => {}),
    })
    assert(timedOut.logs.some((event) => event.type === 'AI_FAILED' && /超时/.test(event.message)), 'AI 超时没有记录失败阶段')
    assert(timedOut.submitted.length === 0, 'AI 超时后仍提交了订单')

    const mcpFailed = await runCase({
      name: 'mcp-failed',
      superviseCandidate: async () => { throw new Error('MCP unavailable') },
    })
    assert(mcpFailed.logs.some((event) => event.type === 'AI_FAILED' && /MCP unavailable/.test(event.message)), 'MCP 故障没有进入 AI_FAILED')
    assert(mcpFailed.submitted.length === 0, 'MCP 故障后仍提交了订单')

    const liveApproved = await runCase({
      name: 'live-approved',
      environment: 'live',
      marketType: 'futures',
      superviseCandidate: async () => ({ decision: 'APPROVE', confidence: 0.98, reason: '允许创建待确认意图' }),
    })
    assert(liveApproved.logs.some((event) => event.type === 'AI_APPROVED'), 'Live AI 批准阶段缺失')
    assert(liveApproved.state.pendingIntents?.length === 1, 'Live AI 批准后没有创建唯一待确认意图')
    assert(liveApproved.submitted.length === 0, 'Live AI 批准后在人工确认前调用了下单适配器')

    return {
      approvedPaperOrders: approved.submitted.length,
      rejectedOrders: rejected.submitted.length,
      lowConfidenceOrders: lowConfidence.submitted.length,
      malformedOrders: malformed.submitted.length,
      timeoutOrders: timedOut.submitted.length,
      mcpFailureOrders: mcpFailed.submitted.length,
      livePendingIntents: liveApproved.state.pendingIntents.length,
      liveAdapterCalls: liveApproved.submitted.length,
    }
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
