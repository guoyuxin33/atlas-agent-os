import { MarketDataHub, marketDataEndpoints, publicRateLimitDeadline } from '../electron/services/market-data.mjs'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json', ...headers } })
}

function klineRows(count, startTime = 1_700_000_000_000, step = 60_000) {
  return Array.from({ length: count }, (_, index) => {
    const openTime = startTime + index * step
    const price = 100 + index / 10
    return [openTime, String(price), String(price + 1), String(price - 1), String(price + 0.5), String(10 + index), openTime + step - 1]
  })
}

function paginateKlines(rows, target) {
  const limit = Number(target.searchParams.get('limit') || 500)
  const startTime = target.searchParams.has('startTime') ? Number(target.searchParams.get('startTime')) : undefined
  const endTime = target.searchParams.has('endTime') ? Number(target.searchParams.get('endTime')) : undefined
  const eligible = rows.filter((row) => (startTime === undefined || row[0] >= startTime) && (endTime === undefined || row[0] <= endTime))
  return startTime === undefined ? eligible.slice(-limit) : eligible.slice(0, limit)
}

function assertSortedUnique(candles, message) {
  assert(candles.every((candle, index) => index === 0 || candle.time > candles[index - 1].time), message)
}

let now = 1_000_000
assert(marketDataEndpoints('paper', 'spot').websocket === 'wss://stream.binance.com:9443/ws', 'Paper 未路由到生产现货 WS')
assert(marketDataEndpoints('live', 'futures').websocket === 'wss://fstream.binance.com/ws', 'Live 未路由到生产永续 WS')
assert(marketDataEndpoints('testnet', 'spot').websocket === 'wss://stream.testnet.binance.vision/ws', 'Testnet 现货 WS 地址错误')
assert(marketDataEndpoints('testnet', 'futures').websocket === 'wss://stream.binancefuture.com/ws', 'Testnet 永续 WS 地址错误')
const requests = []
let futuresHistoryCalls = 0
const hub = new MarketDataHub({
  now: () => now,
  fetcher: async (url) => {
    const target = new URL(url)
    requests.push(target)
    if (target.pathname.endsWith('/exchangeInfo')) {
      if (target.pathname.startsWith('/fapi/')) {
        return jsonResponse({ symbols: [
          { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', status: 'TRADING', contractType: 'PERPETUAL' },
          { symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT', status: 'TRADING', contractType: 'PERPETUAL' },
          { symbol: 'BTCUSDT_250101', baseAsset: 'BTC', quoteAsset: 'USDT', status: 'TRADING', contractType: 'CURRENT_QUARTER' },
        ] })
      }
      return jsonResponse({ symbols: [
        { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', status: 'TRADING' },
        { symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT', status: 'TRADING' },
        { symbol: 'BTCFDUSD', baseAsset: 'BTC', quoteAsset: 'FDUSD', status: 'TRADING' },
        { symbol: 'OLDUSDT', baseAsset: 'OLD', quoteAsset: 'USDT', status: 'BREAK' },
      ] })
    }
    if (target.pathname === '/fapi/v1/klines') {
      futuresHistoryCalls += 1
      if (futuresHistoryCalls === 1) return jsonResponse([[900_000, '1', '2', '0.5', '1.5', '10']])
      return jsonResponse({ code: -1003, msg: 'Too many requests' }, 429, { 'retry-after': '120' })
    }
    throw new Error(`Unexpected market-data request ${target.toString()}`)
  },
})

const paperMarkets = await hub.markets({ environment: 'paper', marketType: 'spot' })
const liveMarkets = await hub.markets({ environment: 'live', marketType: 'spot' })
const testnetMarkets = await hub.markets({ environment: 'testnet', marketType: 'spot' })
const testnetFutures = await hub.markets({ environment: 'testnet', marketType: 'futures' })
assert(paperMarkets.length === 2 && liveMarkets.length === 2 && testnetMarkets.length === 2, '现货 USDT 交易对目录过滤错误')
assert(testnetFutures.length === 2, '永续合约目录未排除交割合约')
assert(requests.some((url) => url.origin === 'https://api.binance.com'), 'Paper/Live 未使用生产现货 REST')
assert(requests.some((url) => url.origin === 'https://testnet.binance.vision'), 'Testnet 现货未使用测试网 REST')
assert(requests.some((url) => url.origin === 'https://testnet.binancefuture.com'), 'Testnet 永续未使用测试网 REST')

const historyOptions = { environment: 'testnet', marketType: 'futures', symbol: 'BTCUSDT', interval: '1m', limit: 100 }
const initialHistory = await hub.history(historyOptions)
now += 20_000
hub.broadcast({ type: 'kline', environment: 'testnet', marketType: 'futures', symbol: 'BTCUSDT', interval: '1m', candle: { time: 960, open: 1.5, high: 2, low: 1, close: 1.75, volume: 12 }, closed: true, timestamp: now })
const rollingHistory = await hub.history(historyOptions)
const sharedShortHistory = await hub.history({ ...historyOptions, limit: 10 })
assert(initialHistory.length === 1 && rollingHistory.at(-1).close === 1.75 && sharedShortHistory.at(-1).close === 1.75, 'WebSocket K 线未合并到共享历史缓存')
assert(futuresHistoryCalls === 1, `历史已启动补齐后仍重复访问 REST: ${futuresHistoryCalls}`)

let limitedCalls = 0
const limitedHub = new MarketDataHub({
  now: () => now,
  fetcher: async () => {
    limitedCalls += 1
    return jsonResponse({ code: -1003, msg: 'Too many requests' }, 429, { 'retry-after': '120' })
  },
})
for (let attempt = 0; attempt < 2; attempt += 1) {
  try { await limitedHub.history(historyOptions) } catch {}
}
assert(limitedCalls === 1, `429 熔断后仍访问 REST: ${limitedCalls}`)
assert(limitedHub.rateLimitStates.size === 1, '429 未写入公共 REST 熔断状态')
hub.reconnectAll()
assert(hub.rateLimitStates.size === 0, '切换网络出口后未清除旧 IP 的 REST 熔断状态')

const fallbackHub = new MarketDataHub({ now: () => now, fetcher: async () => { throw new Error('offline') } })
fallbackHub.broadcast({ type: 'ticker', environment: 'live', marketType: 'spot', symbol: 'BTCUSDT', price: 101, change: 1, high: 102, low: 99, volume: 10, quoteVolume: 1000, timestamp: now })
fallbackHub.broadcast({ type: 'book', environment: 'live', marketType: 'spot', symbol: 'BTCUSDT', bid: 100, bidSize: 2, ask: 101, askSize: 3, timestamp: now })
const fallbackSnapshot = await fallbackHub.snapshot({ environment: 'paper', marketType: 'spot', symbol: 'BTCUSDT' })
assert(fallbackSnapshot.find((item) => item.type === 'ticker')?.price === 101, 'REST 失败时未回退 WS ticker')
assert(fallbackSnapshot.find((item) => item.type === 'book')?.bid === 100, 'REST 失败时未回退 WS book')
now += 10_001
let staleSnapshotRejected = false
try {
  await fallbackHub.snapshot({ environment: 'paper', marketType: 'spot', symbol: 'BTCUSDT' })
} catch (error) {
  staleSnapshotRejected = error instanceof Error && error.message === 'offline'
}
assert(staleSnapshotRejected, '超龄 WS 缓存仍被当作实时快照返回')

let resolveTicker
let resolveBook
const delayedHub = new MarketDataHub({
  now: () => now,
  fetcher: (url) => new Promise((resolve) => {
    if (String(url).includes('/ticker/24hr')) resolveTicker = () => resolve(jsonResponse({ lastPrice: '90', priceChangePercent: '0', highPrice: '91', lowPrice: '89', volume: '1', quoteVolume: '90' }))
    else resolveBook = () => resolve(jsonResponse({ bidPrice: '89', bidQty: '1', askPrice: '90', askQty: '1' }))
  }),
})
const delayedSnapshotPromise = delayedHub.snapshot({ environment: 'testnet', marketType: 'spot', symbol: 'BTCUSDT' })
await Promise.resolve()
now += 1
delayedHub.broadcast({ type: 'ticker', environment: 'testnet', marketType: 'spot', symbol: 'BTCUSDT', price: 110, change: 2, high: 111, low: 100, volume: 20, quoteVolume: 2200, timestamp: now })
delayedHub.broadcast({ type: 'book', environment: 'testnet', marketType: 'spot', symbol: 'BTCUSDT', bid: 109, bidSize: 4, ask: 110, askSize: 5, timestamp: now })
resolveTicker()
resolveBook()
const delayedSnapshot = await delayedSnapshotPromise
assert(delayedSnapshot.find((item) => item.type === 'ticker')?.price === 110, '较旧 REST ticker 覆盖了较新的 WS 行情')
assert(delayedSnapshot.find((item) => item.type === 'book')?.bid === 109, '较旧 REST book 覆盖了较新的 WS 盘口')

const deadline429 = publicRateLimitDeadline(jsonResponse({}, 429, { 'retry-after': '30' }), { code: -1003 }, now)
const deadline418 = publicRateLimitDeadline(jsonResponse({}, 418), { code: -1003 }, now)
assert(deadline429 === now + 30_000 && deadline418 === now + 5 * 60_000, '429/418 退避时间计算错误')

const deepRows = klineRows(10_050)
const deepRequests = []
const deepHistoryHub = new MarketDataHub({
  fetcher: async (url) => {
    const target = new URL(url)
    deepRequests.push(target)
    assert(target.origin === 'https://api.binance.com' && target.pathname === '/api/v3/klines', `生产现货历史地址错误: ${target}`)
    const page = paginateKlines(deepRows, target)
    if (page.length < 1000) return jsonResponse([...page].reverse().concat(page.at(-1) ? [page.at(-1)] : []))
    return jsonResponse(page)
  },
})
const firstDeepHistory = await deepHistoryHub.history({ environment: 'paper', marketType: 'spot', symbol: 'ETHUSDT', interval: '1m', limit: 2505 })
assert(firstDeepHistory.length === 2505, `2,505 根分页数量错误: ${firstDeepHistory.length}`)
assertSortedUnique(firstDeepHistory, '2,505 根分页未去重升序')
assert(deepRequests.length === 3, `2,505 根历史应分 3 页: ${deepRequests.length}`)
assert(deepRequests.map((request) => request.searchParams.get('limit')).join(',') === '1000,1000,505', '现货分页 limit 参数错误')
assert(!deepRequests[0].searchParams.has('endTime') && deepRequests.slice(1).every((request) => request.searchParams.has('endTime')), '向后分页 endTime 游标错误')

const requestsBeforeExpansion = deepRequests.length
const expandedHistory = await deepHistoryHub.history({ environment: 'live', marketType: 'spot', symbol: 'ETHUSDT', interval: '1m', limit: 10_000 })
const expansionRequests = deepRequests.slice(requestsBeforeExpansion)
assert(expandedHistory.length === 10_000, `10,000 根扩展历史数量错误: ${expandedHistory.length}`)
assertSortedUnique(expandedHistory, '10,000 根扩展历史未去重升序')
assert(expansionRequests.length === 8, `缓存扩展到 10,000 根应只补 8 页: ${expansionRequests.length}`)
assert(expansionRequests[0].searchParams.has('endTime'), '扩大 limit 时重复请求了最新页')
const requestsBeforeCacheHit = deepRequests.length
const cachedDeepHistory = await deepHistoryHub.history({ environment: 'paper', marketType: 'spot', symbol: 'ETHUSDT', interval: '1m', limit: 10_000 })
assert(cachedDeepHistory.length === 10_000 && deepRequests.length === requestsBeforeCacheHit, '10,000 根缓存命中仍重复访问 REST')

let pagedRateLimitCalls = 0
const pagedRateLimitRequests = []
const pagedRateLimitHub = new MarketDataHub({
  now: () => now,
  fetcher: async (url) => {
    pagedRateLimitCalls += 1
    const target = new URL(url)
    pagedRateLimitRequests.push(target)
    if (pagedRateLimitCalls === 2) return jsonResponse({ code: -1003, msg: 'Too many requests' }, 429, { 'retry-after': '45' })
    return jsonResponse(paginateKlines(deepRows, target))
  },
})
let pagedRateLimitError
try {
  await pagedRateLimitHub.history({ environment: 'live', marketType: 'spot', symbol: 'XRPUSDT', interval: '1m', limit: 2500 })
} catch (error) {
  pagedRateLimitError = error
}
assert(pagedRateLimitCalls === 2 && pagedRateLimitError?.code === -1003 && pagedRateLimitError?.retryAfter === 45, '分页 429 未停止并返回退避信息')
try {
  await pagedRateLimitHub.history({ environment: 'paper', marketType: 'spot', symbol: 'XRPUSDT', interval: '1m', limit: 2500 })
} catch {}
assert(pagedRateLimitCalls === 2, '分页 429 熔断后仍继续访问 REST')
now += 45_000
const recoveredHistory = await pagedRateLimitHub.history({ environment: 'paper', marketType: 'spot', symbol: 'XRPUSDT', interval: '1m', limit: 2500 })
assert(recoveredHistory.length === 2500 && pagedRateLimitCalls === 4, '分页 429 退避结束后未从部分缓存恢复')
assert(pagedRateLimitRequests[2].searchParams.has('endTime'), '分页 429 恢复后重复请求了已缓存的最新页')

const routeRows = klineRows(3000, 1_710_000_000_000)
const routeRequests = []
const routeHub = new MarketDataHub({
  fetcher: async (url) => {
    const target = new URL(url)
    routeRequests.push(target)
    return jsonResponse(paginateKlines(routeRows, target))
  },
})
const routeCases = [
  { environment: 'paper', marketType: 'spot', origin: 'https://api.binance.com', path: '/api/v3/klines', symbol: 'BTCUSDT' },
  { environment: 'live', marketType: 'futures', origin: 'https://fapi.binance.com', path: '/fapi/v1/klines', symbol: 'ETHUSDT' },
  { environment: 'testnet', marketType: 'spot', origin: 'https://testnet.binance.vision', path: '/api/v3/klines', symbol: 'BNBUSDT' },
  { environment: 'testnet', marketType: 'futures', origin: 'https://testnet.binancefuture.com', path: '/fapi/v1/klines', symbol: 'SOLUSDT' },
]
for (const routeCase of routeCases) {
  const result = await routeHub.history({ ...routeCase, interval: '5m', limit: 1 })
  assert(result.length === 1, `${routeCase.environment}/${routeCase.marketType} 历史数量错误`)
  const request = routeRequests.at(-1)
  assert(request.origin === routeCase.origin && request.pathname === routeCase.path, `${routeCase.environment}/${routeCase.marketType} K 线地址错误: ${request}`)
  assert(request.searchParams.get('symbol') === routeCase.symbol && request.searchParams.get('interval') === '5m' && request.searchParams.get('limit') === '1', 'K 线基础参数错误')
}

const rangeStart = routeRows[250][0]
const rangeEnd = routeRows[2749][0]
const rangeRequestOffset = routeRequests.length
const rangedHistory = await routeHub.history({ environment: 'testnet', marketType: 'futures', symbol: 'ADAUSDT', interval: '1m', limit: 2200, startTime: rangeStart, endTime: rangeEnd })
const rangeRequests = routeRequests.slice(rangeRequestOffset)
assert(rangedHistory.length === 2200, `时间区间分页数量错误: ${rangedHistory.length}`)
assertSortedUnique(rangedHistory, '时间区间分页未去重升序')
assert(rangeRequests.length === 3 && rangeRequests.every((request) => request.origin === 'https://testnet.binancefuture.com' && request.pathname === '/fapi/v1/klines'), '测试网合约时间区间分页地址错误')
assert(rangeRequests[0].searchParams.get('startTime') === String(rangeStart) && rangeRequests.every((request) => request.searchParams.get('endTime') === String(rangeEnd)), '时间区间边界参数错误')
assert(rangeRequests[1].searchParams.get('startTime') === String(routeRows[1249][0] + 1), '时间区间向前分页游标错误')

const endOnlyRequestOffset = routeRequests.length
const endOnlyHistory = await routeHub.history({ environment: 'testnet', marketType: 'spot', symbol: 'DOGEUSDT', interval: '1m', limit: 1200, endTime: routeRows[1800][0] })
const endOnlyRequests = routeRequests.slice(endOnlyRequestOffset)
assert(endOnlyHistory.length === 1200 && endOnlyHistory.at(-1).time === routeRows[1800][0] / 1000, '仅 endTime 的向后区间分页结果错误')
assertSortedUnique(endOnlyHistory, '仅 endTime 的区间分页未去重升序')
assert(endOnlyRequests.length === 2 && endOnlyRequests.every((request) => !request.searchParams.has('startTime') && request.searchParams.has('endTime')), '仅 endTime 的向后分页参数错误')

let invalidRangeRejected = false
try {
  await routeHub.history({ environment: 'live', marketType: 'spot', symbol: 'BTCUSDT', interval: '1m', startTime: rangeEnd, endTime: rangeStart })
} catch (error) {
  invalidRangeRejected = error instanceof Error && /startTime/.test(error.message)
}
assert(invalidRangeRejected, '反向时间区间未在请求前拒绝')

process.stdout.write(`${JSON.stringify({
  ok: true,
  markets: { paper: paperMarkets.length, live: liveMarkets.length, testnet: testnetMarkets.length, testnetFutures: testnetFutures.length },
  rollingHistory: rollingHistory.length,
  restCallsAfterBootstrap: futuresHistoryCalls,
  restCallsAfter429: limitedCalls,
  snapshotFallback: fallbackSnapshot.map((item) => item.type),
  staleSnapshotRejected,
  websocketWinsRace: delayedSnapshot.map((item) => item.type),
  pagination: { first: firstDeepHistory.length, expanded: expandedHistory.length, totalRequests: deepRequests.length },
  pagedRateLimit: { calls: pagedRateLimitCalls, retryAfter: pagedRateLimitError?.retryAfter },
  rangePagination: { candles: rangedHistory.length, requests: rangeRequests.length, endOnlyCandles: endOnlyHistory.length },
  historyRoutes: routeCases.map(({ environment, marketType }) => `${environment}:${marketType}`),
  invalidRangeRejected,
}, null, 2)}\n`)
