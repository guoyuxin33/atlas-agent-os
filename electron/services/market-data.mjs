import WebSocket from 'ws'
import { ExchangeInfoCatalog } from './exchange-info.mjs'
import { fetchWithProxy, webSocketOptions } from './network.mjs'

const REST_BASE = {
  live: {
    spot: 'https://api.binance.com',
    futures: 'https://fapi.binance.com',
  },
  testnet: {
    spot: 'https://testnet.binance.vision',
    futures: 'https://testnet.binancefuture.com',
  },
}

const WS_BASE = {
  live: {
    spot: 'wss://stream.binance.com:9443/ws',
    futures: 'wss://fstream.binance.com/ws',
  },
  testnet: {
    spot: 'wss://stream.testnet.binance.vision/ws',
    futures: 'wss://stream.binancefuture.com/ws',
  },
}

const HISTORY_CACHE_LIMIT = 24
const HISTORY_SERIES_LIMIT = 5000
const IPC_BATCH_INTERVAL = 16
const MARKET_CACHE_TTL = 5 * 60 * 1000
const LATEST_UPDATE_LIMIT = 2048
const SNAPSHOT_FALLBACK_MAX_AGE = 10 * 1000

function streamNames(symbol, interval) {
  const normalized = symbol.toLowerCase()
  return [`${normalized}@ticker`, `${normalized}@kline_${interval}`, `${normalized}@bookTicker`]
}

function publicEnvironment(environment) {
  return environment === 'testnet' ? 'testnet' : 'live'
}

export function marketDataEndpoints(environment, marketType) {
  const normalizedEnvironment = publicEnvironment(environment)
  const normalizedMarketType = marketType === 'futures' ? 'futures' : 'spot'
  return {
    environment: normalizedEnvironment,
    marketType: normalizedMarketType,
    rest: REST_BASE[normalizedEnvironment][normalizedMarketType],
    websocket: WS_BASE[normalizedEnvironment][normalizedMarketType],
  }
}

function socketKey(environment, marketType) {
  return `${publicEnvironment(environment)}:${marketType}`
}

function historyKey(environment, marketType, symbol, interval) {
  return `${publicEnvironment(environment)}:${marketType}:${symbol}:${interval}`
}

function intervalSeconds(interval) {
  return { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14_400, '1d': 86_400 }[interval] || 900
}

function mergeCandles(current = [], additions = []) {
  return [...new Map([...current, ...additions].map((candle) => [Number(candle.time), candle])).values()]
    .filter((candle) => Number.isFinite(Number(candle.time)))
    .sort((left, right) => Number(left.time) - Number(right.time))
    .slice(-HISTORY_SERIES_LIMIT)
}

function hasContinuousTail(candles, requestedLimit, interval) {
  if (!candles.length) return false
  const sampleSize = Math.min(candles.length, requestedLimit)
  const start = candles.length - sampleSize
  const expectedStep = intervalSeconds(interval)
  for (let index = start + 1; index < candles.length; index += 1) {
    if (Number(candles[index].time) - Number(candles[index - 1].time) !== expectedStep) return false
  }
  return true
}

function publicRequestContext(url) {
  const target = new URL(url)
  const environment = target.hostname === 'testnet.binance.vision' || target.hostname.endsWith('.binancefuture.com') ? 'testnet' : 'live'
  const marketType = target.pathname.startsWith('/fapi/') || target.hostname.includes('fapi') || target.hostname.includes('binancefuture') ? 'futures' : 'spot'
  return { environment, marketType }
}

export function publicRateLimitDeadline(response, payload, now = Date.now()) {
  if (![418, 429].includes(Number(response?.status)) && Number(payload?.code) !== -1003) return 0
  const retryAfter = response?.headers?.get?.('retry-after')
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds)) return now + Math.max(1, seconds) * 1000
    const date = Date.parse(retryAfter)
    if (Number.isFinite(date)) return date
  }
  const bannedUntil = String(payload?.msg || '').match(/banned until\s+(\d{10,13})/i)?.[1]
  if (bannedUntil) {
    const numeric = Number(bannedUntil)
    return bannedUntil.length <= 10 ? numeric * 1000 : numeric
  }
  return now + (Number(response?.status) === 418 || Number(payload?.code) === -1003 ? 5 * 60 * 1000 : 60 * 1000)
}

class MarketSocket {
  constructor(environment, marketType, sendUpdate) {
    this.environment = environment
    this.marketType = marketType
    this.sendUpdate = sendUpdate
    this.socket = null
    this.streamRefs = new Map()
    this.reconnectTimer = null
    this.requestId = 1
    this.connecting = false
  }

  async connect() {
    if (this.connecting || (this.socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(this.socket.readyState))) return
    this.connecting = true
    const socketUrl = marketDataEndpoints(this.environment, this.marketType).websocket
    let options
    try {
      options = await webSocketOptions(socketUrl)
    } catch (error) {
      this.connecting = false
      console.error('[market:proxy]', error)
      this.scheduleReconnect()
      return
    }
    this.socket = new WebSocket(socketUrl, { ...options, perMessageDeflate: false, handshakeTimeout: 8000 })
    this.connecting = false
    this.socket.on('open', () => {
      if (this.streamRefs.size) this.socket.send(JSON.stringify({ method: 'SUBSCRIBE', params: [...this.streamRefs.keys()], id: this.requestId++ }))
      this.sendUpdate({ type: 'connection', environment: this.environment, marketType: this.marketType, connected: true, timestamp: Date.now() })
    })
    this.socket.on('message', (raw) => {
      try {
        const data = JSON.parse(raw.toString())
        if (data.e === '24hrTicker') {
          this.sendUpdate({ type: 'ticker', environment: this.environment, marketType: this.marketType, symbol: data.s, price: Number(data.c), change: Number(data.P), high: Number(data.h), low: Number(data.l), volume: Number(data.v), quoteVolume: Number(data.q), timestamp: data.E })
        } else if (data.e === 'kline') {
          this.sendUpdate({ type: 'kline', environment: this.environment, marketType: this.marketType, symbol: data.s, interval: data.k.i, candle: { time: Math.floor(data.k.t / 1000), open: Number(data.k.o), high: Number(data.k.h), low: Number(data.k.l), close: Number(data.k.c), volume: Number(data.k.v) }, closed: data.k.x, timestamp: data.E })
        } else if (data.u && data.s && data.b) {
          this.sendUpdate({ type: 'book', environment: this.environment, marketType: this.marketType, symbol: data.s, bid: Number(data.b), bidSize: Number(data.B), ask: Number(data.a), askSize: Number(data.A), timestamp: data.E || Date.now() })
        }
      } catch (error) {
        console.error('[market:parse]', error)
      }
    })
    this.socket.on('close', () => {
      this.sendUpdate({ type: 'connection', environment: this.environment, marketType: this.marketType, connected: false, timestamp: Date.now() })
      this.scheduleReconnect()
    })
    this.socket.on('error', () => this.socket?.close())
  }

  scheduleReconnect() {
    if (this.reconnectTimer || !this.streamRefs.size) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, 1800)
  }

  add(symbol, interval) {
    const additions = []
    streamNames(symbol, interval).forEach((stream) => {
      const references = this.streamRefs.get(stream) || 0
      this.streamRefs.set(stream, references + 1)
      if (references === 0) additions.push(stream)
    })
    this.connect()
    if (additions.length && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ method: 'SUBSCRIBE', params: additions, id: this.requestId++ }))
    }
  }

  remove(symbol, interval) {
    const removals = []
    streamNames(symbol, interval).forEach((stream) => {
      const references = this.streamRefs.get(stream) || 0
      if (references <= 1) {
        this.streamRefs.delete(stream)
        if (references === 1) removals.push(stream)
      } else {
        this.streamRefs.set(stream, references - 1)
      }
    })
    if (removals.length && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ method: 'UNSUBSCRIBE', params: removals, id: this.requestId++ }))
    }
  }

  reconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    if (this.socket) {
      this.socket.removeAllListeners()
      this.socket.terminate()
      this.socket = null
    }
    if (this.streamRefs.size) this.connect()
  }
}

export class MarketDataHub {
  constructor({ fetcher = fetchWithProxy, now = Date.now } = {}) {
    this.fetcher = fetcher
    this.now = now
    this.clients = new Map()
    this.topicsByClient = new Map()
    this.historyCache = new Map()
    this.marketsCache = new Map()
    this.latestUpdates = new Map()
    this.rateLimitStates = new Map()
    this.networkRevision = 0
    this.pendingUpdatesByClient = new Map()
    this.flushTimersByClient = new Map()
    this.internalSubscribers = new Map()
    this.exchangeInfoCatalog = new ExchangeInfoCatalog({ fetcher: (url, options) => this.fetchPublicResponse(url, options) })
    this.sockets = Object.fromEntries(['live', 'testnet'].flatMap((environment) => ['spot', 'futures'].map((marketType) => [
      socketKey(environment, marketType),
      new MarketSocket(environment, marketType, (update) => this.broadcast(update)),
    ])))
  }

  rateLimitKey(environment, marketType) {
    return `${publicEnvironment(environment)}:${marketType === 'futures' ? 'futures' : 'spot'}`
  }

  assertRestAvailable(environment, marketType) {
    const key = this.rateLimitKey(environment, marketType)
    const blockedUntil = this.rateLimitStates.get(key) || 0
    if (blockedUntil <= this.now()) {
      this.rateLimitStates.delete(key)
      return
    }
    const seconds = Math.max(1, Math.ceil((blockedUntil - this.now()) / 1000))
    const error = new Error(`Binance 公共行情 REST 请求频率受限，本地暂停 ${seconds} 秒 [-1003]`)
    error.code = -1003
    error.retryAfter = seconds
    throw error
  }

  async fetchPublicResponse(url, options) {
    const context = publicRequestContext(url)
    const revision = this.networkRevision
    this.assertRestAvailable(context.environment, context.marketType)
    const response = await this.fetcher(url, options)
    if (!response.ok && revision === this.networkRevision) {
      const payload = await response.clone().json().catch(() => null)
      const blockedUntil = publicRateLimitDeadline(response, payload, this.now())
      if (blockedUntil) this.rateLimitStates.set(this.rateLimitKey(context.environment, context.marketType), blockedUntil)
    }
    return response
  }

  latestUpdateKey(update) {
    return `${publicEnvironment(update.environment)}:${update.marketType}:${update.symbol}:${update.type}`
  }

  rememberUpdate(update) {
    if (['ticker', 'book'].includes(update.type) && update.symbol) {
      this.latestUpdates.set(this.latestUpdateKey(update), { update, receivedAt: this.now() })
      while (this.latestUpdates.size > LATEST_UPDATE_LIMIT) this.latestUpdates.delete(this.latestUpdates.keys().next().value)
    }
    if (update.type === 'kline' && update.symbol && update.interval && update.candle) {
      const key = historyKey(update.environment, update.marketType, update.symbol, update.interval)
      const cached = this.historyCache.get(key) || { data: [], loadedLimit: 0, exhausted: false }
      cached.data = mergeCandles(cached.data, [update.candle])
      this.historyCache.delete(key)
      this.historyCache.set(key, cached)
      while (this.historyCache.size > HISTORY_CACHE_LIMIT) this.historyCache.delete(this.historyCache.keys().next().value)
    }
  }

  snapshotFallback(environment, marketType, symbol) {
    return ['ticker', 'book']
      .map((type) => this.latestUpdates.get(`${environment}:${marketType}:${symbol}:${type}`))
      .filter((entry) => entry && this.now() - entry.receivedAt <= SNAPSHOT_FALLBACK_MAX_AGE)
      .map((entry) => entry.update)
      .filter(Boolean)
  }

  subscribe(webContents, options) {
    const environment = publicEnvironment(options.environment)
    const marketType = options.marketType === 'futures' ? 'futures' : 'spot'
    const symbol = String(options.symbol || 'BTCUSDT').toUpperCase()
    const interval = ['1m', '5m', '15m', '1h', '4h', '1d'].includes(options.interval) ? options.interval : '15m'
    const topic = `${environment}:${marketType}:${symbol}:${interval}`
    this.clients.set(webContents.id, webContents)
    const topics = this.topicsByClient.get(webContents.id) || new Set()
    if (topics.has(topic)) return { ok: true, topic }
    topics.add(topic)
    this.topicsByClient.set(webContents.id, topics)
    this.sockets[socketKey(environment, marketType)].add(symbol, interval)
    this.snapshot({ environment, marketType, symbol }).then((updates) => {
      updates.forEach((update) => this.broadcast(update))
    }).catch((error) => console.error('[market:snapshot]', error?.message || error))
    return { ok: true, topic }
  }

  unsubscribe(webContents, options) {
    const environment = publicEnvironment(options.environment)
    const marketType = options.marketType === 'futures' ? 'futures' : 'spot'
    const symbol = String(options.symbol || 'BTCUSDT').toUpperCase()
    const interval = options.interval || '15m'
    const topic = `${environment}:${marketType}:${symbol}:${interval}`
    const topics = this.topicsByClient.get(webContents.id)
    if (!topics?.delete(topic)) return { ok: true }
    this.sockets[socketKey(environment, marketType)].remove(symbol, interval)
    return { ok: true }
  }

  subscribeInternal(options, callback) {
    const environment = publicEnvironment(options.environment)
    const marketType = options.marketType === 'futures' ? 'futures' : 'spot'
    const symbol = String(options.symbol || 'BTCUSDT').toUpperCase()
    const interval = ['1m', '5m', '15m', '1h', '4h', '1d'].includes(options.interval) ? options.interval : '15m'
    const topic = `${environment}:${marketType}:${symbol}:${interval}`
    const subscribers = this.internalSubscribers.get(topic) || new Set()
    if (subscribers.has(callback)) return () => {}
    subscribers.add(callback)
    this.internalSubscribers.set(topic, subscribers)
    this.sockets[socketKey(environment, marketType)].add(symbol, interval)
    return () => {
      const current = this.internalSubscribers.get(topic)
      if (!current?.delete(callback)) return
      this.sockets[socketKey(environment, marketType)].remove(symbol, interval)
      if (!current?.size) {
        this.internalSubscribers.delete(topic)
      }
    }
  }

  removeClient(webContentsId) {
    const topics = this.topicsByClient.get(webContentsId) || new Set()
    this.topicsByClient.delete(webContentsId)
    this.clients.delete(webContentsId)
    this.pendingUpdatesByClient.delete(webContentsId)
    const flushTimer = this.flushTimersByClient.get(webContentsId)
    if (flushTimer) clearTimeout(flushTimer)
    this.flushTimersByClient.delete(webContentsId)
    topics.forEach((topic) => {
      const [environment, marketType, symbol, interval] = topic.split(':')
      this.sockets[socketKey(environment, marketType)].remove(symbol, interval)
    })
  }

  queueUpdate(webContentsId, update) {
    const pending = this.pendingUpdatesByClient.get(webContentsId) || new Map()
    const updateKey = [update.type, update.environment, update.marketType, update.symbol || '*', update.interval || '*'].join(':')
    pending.set(updateKey, update)
    this.pendingUpdatesByClient.set(webContentsId, pending)
    if (this.flushTimersByClient.has(webContentsId)) return
    const timer = setTimeout(() => this.flushUpdates(webContentsId), IPC_BATCH_INTERVAL)
    this.flushTimersByClient.set(webContentsId, timer)
  }

  flushUpdates(webContentsId) {
    this.flushTimersByClient.delete(webContentsId)
    const webContents = this.clients.get(webContentsId)
    const pending = this.pendingUpdatesByClient.get(webContentsId)
    this.pendingUpdatesByClient.delete(webContentsId)
    if (!pending?.size) return
    if (!webContents || webContents.isDestroyed()) {
      this.removeClient(webContentsId)
      return
    }
    webContents.send('market:update', [...pending.values()])
  }

  broadcast(update) {
    this.rememberUpdate(update)
    for (const [topic, subscribers] of this.internalSubscribers) {
      const [environment, marketType, symbol] = topic.split(':')
      const relevant = update.type === 'connection'
        ? update.environment === environment && update.marketType === marketType
        : update.environment === environment && update.marketType === marketType && update.symbol === symbol
      if (relevant) subscribers.forEach((callback) => callback(update))
    }
    for (const [id, webContents] of this.clients) {
      if (webContents.isDestroyed()) {
        this.removeClient(id)
        continue
      }
      const topics = this.topicsByClient.get(id) || new Set()
      const relevant = update.type === 'connection'
        ? [...topics].some((topic) => topic.startsWith(`${update.environment}:${update.marketType}:`))
        : [...topics].some((topic) => topic.startsWith(`${update.environment}:${update.marketType}:${update.symbol}:`))
      if (relevant) this.queueUpdate(id, update)
    }
  }

  async markets(options = {}) {
    const environment = publicEnvironment(options.environment)
    const marketType = options.marketType === 'futures' ? 'futures' : 'spot'
    const cacheKey = `${environment}:${marketType}`
    const cached = this.marketsCache.get(cacheKey)
    if (cached?.data && cached.expiresAt > this.now()) return cached.data
    if (cached?.request) return cached.request
    const request = this.exchangeInfoCatalog.markets({ marketType, baseUrl: REST_BASE[environment][marketType] })
    this.marketsCache.set(cacheKey, { ...(cached?.data ? { data: cached.data } : {}), expiresAt: cached?.expiresAt || 0, request })
    try {
      const data = await request
      this.marketsCache.set(cacheKey, { data, expiresAt: this.now() + MARKET_CACHE_TTL })
      return data
    } catch (error) {
      if (cached?.data) {
        this.marketsCache.set(cacheKey, { data: cached.data, expiresAt: 0 })
        return cached.data
      }
      this.marketsCache.delete(cacheKey)
      throw error
    }
  }

  async history(options) {
    const environment = publicEnvironment(options.environment)
    const marketType = options.marketType === 'futures' ? 'futures' : 'spot'
    const interval = ['1m', '5m', '15m', '1h', '4h', '1d'].includes(options.interval) ? options.interval : '15m'
    const symbol = String(options.symbol || 'BTCUSDT').toUpperCase()
    const limit = Math.min(Math.max(Number(options.limit) || 1000, 100), 5000)
    const cacheKey = historyKey(environment, marketType, symbol, interval)
    let cached = this.historyCache.get(cacheKey)
    const canUseCached = () => Boolean(
      cached?.data?.length
      && hasContinuousTail(cached.data, limit, interval)
      && (cached.exhausted || cached.loadedLimit >= limit || cached.data.length >= limit)
    )
    if (canUseCached()) return cached.data.slice(-limit)
    if (cached?.request) {
      try {
        await cached.request
      } catch (error) {
        if (canUseCached()) return cached.data.slice(-limit)
        throw error
      }
      cached = this.historyCache.get(cacheKey)
      if (canUseCached()) return cached.data.slice(-limit)
    }
    const path = marketType === 'futures' ? '/fapi/v1/klines' : '/api/v3/klines'
    const request = (async () => {
      let endTime
      let remaining = limit
      let rows = []
      let exhausted = false
      while (remaining > 0) {
        const batchSize = Math.min(1000, remaining)
        const query = new URLSearchParams({ symbol, interval, limit: String(batchSize) })
        if (endTime) query.set('endTime', String(endTime))
        const response = await this.fetchPublicResponse(`${REST_BASE[environment][marketType]}${path}?${query.toString()}`)
        const batch = await response.json()
        if (!response.ok) throw new Error(batch?.msg || `History request failed (${response.status})`)
        if (!Array.isArray(batch) || !batch.length) {
          exhausted = true
          break
        }
        rows = [...batch, ...rows]
        remaining -= batch.length
        endTime = Number(batch[0][0]) - 1
        if (batch.length < batchSize) {
          exhausted = true
          break
        }
      }
      const candles = [...new Map(rows.map((row) => [Number(row[0]), row])).values()]
        .sort((left, right) => Number(left[0]) - Number(right[0]))
        .slice(-limit)
        .map((row) => ({ time: Math.floor(Number(row[0]) / 1000), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]) }))
      const latest = this.historyCache.get(cacheKey) || cached || { data: [], loadedLimit: 0, exhausted: false }
      this.historyCache.set(cacheKey, {
        data: mergeCandles(latest.data, candles),
        loadedLimit: Math.max(Number(latest.loadedLimit) || 0, limit),
        exhausted: Boolean(latest.exhausted || exhausted),
      })
      while (this.historyCache.size > HISTORY_CACHE_LIMIT) this.historyCache.delete(this.historyCache.keys().next().value)
      return this.historyCache.get(cacheKey).data.slice(-limit)
    })()
    this.historyCache.set(cacheKey, {
      data: cached?.data || [],
      loadedLimit: Number(cached?.loadedLimit) || 0,
      exhausted: Boolean(cached?.exhausted),
      request,
    })
    try {
      return await request
    } catch (error) {
      const latest = this.historyCache.get(cacheKey)
      if (latest?.request === request) {
        const fallback = {
          data: latest.data || [],
          loadedLimit: Number(latest.loadedLimit) || 0,
          exhausted: Boolean(latest.exhausted),
        }
        if (fallback.data.length) this.historyCache.set(cacheKey, fallback)
        else this.historyCache.delete(cacheKey)
        cached = fallback
      }
      if (canUseCached()) return cached.data.slice(-limit)
      throw error
    }
  }

  async snapshot(options) {
    const environment = publicEnvironment(options.environment)
    const marketType = options.marketType === 'futures' ? 'futures' : 'spot'
    const symbol = String(options.symbol || 'BTCUSDT').toUpperCase()
    const requestedAt = this.now()
    const tickerPath = marketType === 'futures' ? '/fapi/v1/ticker/24hr' : '/api/v3/ticker/24hr'
    const bookPath = marketType === 'futures' ? '/fapi/v1/ticker/bookTicker' : '/api/v3/ticker/bookTicker'
    try {
      const [tickerResponse, bookResponse] = await Promise.all([
        this.fetchPublicResponse(`${REST_BASE[environment][marketType]}${tickerPath}?symbol=${encodeURIComponent(symbol)}`),
        this.fetchPublicResponse(`${REST_BASE[environment][marketType]}${bookPath}?symbol=${encodeURIComponent(symbol)}`),
      ])
      const [ticker, book] = await Promise.all([tickerResponse.json(), bookResponse.json()])
      if (!tickerResponse.ok) throw new Error(ticker?.msg || `Ticker snapshot failed (${tickerResponse.status})`)
      if (!bookResponse.ok) throw new Error(book?.msg || `Book snapshot failed (${bookResponse.status})`)
      const timestamp = this.now()
      const restUpdates = [
        { type: 'ticker', environment, marketType, symbol, price: Number(ticker.lastPrice), change: Number(ticker.priceChangePercent), high: Number(ticker.highPrice), low: Number(ticker.lowPrice), volume: Number(ticker.volume), quoteVolume: Number(ticker.quoteVolume), timestamp },
        { type: 'book', environment, marketType, symbol, bid: Number(book.bidPrice), bidSize: Number(book.bidQty), ask: Number(book.askPrice), askSize: Number(book.askQty), timestamp },
      ]
      return restUpdates.map((update) => {
        const latest = this.latestUpdates.get(this.latestUpdateKey(update))
        return latest?.receivedAt >= requestedAt ? latest.update : update
      })
    } catch (error) {
      const fallback = this.snapshotFallback(environment, marketType, symbol)
      if (fallback.length) return fallback
      throw error
    }
  }

  reconnectAll() {
    this.networkRevision += 1
    this.rateLimitStates.clear()
    Object.values(this.sockets).forEach((socket) => socket.reconnect())
  }
}
