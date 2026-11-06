import { MarketDataHub, marketDataEndpoints, publicRateLimitDeadline } from '../electron/services/market-data.mjs'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json', ...headers } })
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

process.stdout.write(`${JSON.stringify({
  ok: true,
  markets: { paper: paperMarkets.length, live: liveMarkets.length, testnet: testnetMarkets.length, testnetFutures: testnetFutures.length },
  rollingHistory: rollingHistory.length,
  restCallsAfterBootstrap: futuresHistoryCalls,
  restCallsAfter429: limitedCalls,
  snapshotFallback: fallbackSnapshot.map((item) => item.type),
  staleSnapshotRejected,
  websocketWinsRace: delayedSnapshot.map((item) => item.type),
}, null, 2)}\n`)
