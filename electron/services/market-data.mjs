import WebSocket from 'ws'
import { exchangeInfoCatalog } from './exchange-info.mjs'
import { fetchWithProxy, webSocketOptions } from './network.mjs'

const REST_BASE = {
  spot: 'https://api.binance.com',
  futures: 'https://fapi.binance.com',
}

const WS_BASE = {
  spot: 'wss://stream.binance.com:9443/ws',
  futures: 'wss://fstream.binance.com/ws',
}

const HISTORY_CACHE_TTL = 15 * 1000
const HISTORY_CACHE_LIMIT = 24
const IPC_BATCH_INTERVAL = 16

function streamNames(symbol, interval) {
  const normalized = symbol.toLowerCase()
  return [`${normalized}@ticker`, `${normalized}@kline_${interval}`, `${normalized}@bookTicker`]
}

class MarketSocket {
  constructor(marketType, sendUpdate) {
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
    const socketUrl = WS_BASE[this.marketType]
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
      this.sendUpdate({ type: 'connection', marketType: this.marketType, connected: true, timestamp: Date.now() })
    })
    this.socket.on('message', (raw) => {
      try {
        const data = JSON.parse(raw.toString())
        if (data.e === '24hrTicker') {
          this.sendUpdate({ type: 'ticker', marketType: this.marketType, symbol: data.s, price: Number(data.c), change: Number(data.P), high: Number(data.h), low: Number(data.l), volume: Number(data.v), quoteVolume: Number(data.q), timestamp: data.E })
        } else if (data.e === 'kline') {
          this.sendUpdate({ type: 'kline', marketType: this.marketType, symbol: data.s, interval: data.k.i, candle: { time: Math.floor(data.k.t / 1000), open: Number(data.k.o), high: Number(data.k.h), low: Number(data.k.l), close: Number(data.k.c), volume: Number(data.k.v) }, closed: data.k.x, timestamp: data.E })
        } else if (data.u && data.s && data.b) {
          this.sendUpdate({ type: 'book', marketType: this.marketType, symbol: data.s, bid: Number(data.b), bidSize: Number(data.B), ask: Number(data.a), askSize: Number(data.A), timestamp: data.E || Date.now() })
        }
      } catch (error) {
        console.error('[market:parse]', error)
      }
    })
    this.socket.on('close', () => {
      this.sendUpdate({ type: 'connection', marketType: this.marketType, connected: false, timestamp: Date.now() })
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
  constructor() {
    this.clients = new Map()
    this.topicsByClient = new Map()
    this.historyCache = new Map()
    this.pendingUpdatesByClient = new Map()
    this.flushTimersByClient = new Map()
    this.internalSubscribers = new Map()
    this.sockets = {
      spot: new MarketSocket('spot', (update) => this.broadcast(update)),
      futures: new MarketSocket('futures', (update) => this.broadcast(update)),
    }
  }

  subscribe(webContents, options) {
    const marketType = options.marketType === 'futures' ? 'futures' : 'spot'
    const symbol = String(options.symbol || 'BTCUSDT').toUpperCase()
    const interval = ['1m', '5m', '15m', '1h', '4h', '1d'].includes(options.interval) ? options.interval : '15m'
    const topic = `${marketType}:${symbol}:${interval}`
    this.clients.set(webContents.id, webContents)
    const topics = this.topicsByClient.get(webContents.id) || new Set()
    if (topics.has(topic)) return { ok: true, topic }
    topics.add(topic)
    this.topicsByClient.set(webContents.id, topics)
    this.sockets[marketType].add(symbol, interval)
    this.snapshot({ marketType, symbol }).then((updates) => {
      updates.forEach((update) => this.broadcast(update))
    }).catch((error) => console.error('[market:snapshot]', error?.message || error))
    return { ok: true, topic }
  }

  unsubscribe(webContents, options) {
    const marketType = options.marketType === 'futures' ? 'futures' : 'spot'
    const symbol = String(options.symbol || 'BTCUSDT').toUpperCase()
    const interval = options.interval || '15m'
    const topic = `${marketType}:${symbol}:${interval}`
    const topics = this.topicsByClient.get(webContents.id)
    if (!topics?.delete(topic)) return { ok: true }
    this.sockets[marketType].remove(symbol, interval)
    return { ok: true }
  }

  subscribeInternal(options, callback) {
    const marketType = options.marketType === 'futures' ? 'futures' : 'spot'
    const symbol = String(options.symbol || 'BTCUSDT').toUpperCase()
    const interval = ['1m', '5m', '15m', '1h', '4h', '1d'].includes(options.interval) ? options.interval : '15m'
    const topic = `${marketType}:${symbol}:${interval}`
    const subscribers = this.internalSubscribers.get(topic) || new Set()
    if (subscribers.has(callback)) return () => {}
    subscribers.add(callback)
    this.internalSubscribers.set(topic, subscribers)
    this.sockets[marketType].add(symbol, interval)
    return () => {
      const current = this.internalSubscribers.get(topic)
      if (!current?.delete(callback)) return
      this.sockets[marketType].remove(symbol, interval)
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
      const [marketType, symbol, interval] = topic.split(':')
      this.sockets[marketType].remove(symbol, interval)
    })
  }

  queueUpdate(webContentsId, update) {
    const pending = this.pendingUpdatesByClient.get(webContentsId) || new Map()
    const updateKey = [update.type, update.marketType, update.symbol || '*', update.interval || '*'].join(':')
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
    for (const [topic, subscribers] of this.internalSubscribers) {
      const [marketType, symbol] = topic.split(':')
      const relevant = update.type === 'connection'
        ? update.marketType === marketType
        : update.marketType === marketType && update.symbol === symbol
      if (relevant) subscribers.forEach((callback) => callback(update))
    }
    for (const [id, webContents] of this.clients) {
      if (webContents.isDestroyed()) {
        this.removeClient(id)
        continue
      }
      const topics = this.topicsByClient.get(id) || new Set()
      const relevant = update.type === 'connection'
        ? [...topics].some((topic) => topic.startsWith(`${update.marketType}:`))
        : [...topics].some((topic) => topic.startsWith(`${update.marketType}:${update.symbol}:`))
      if (relevant) this.queueUpdate(id, update)
    }
  }

  async markets(options = {}) {
    const marketType = options.marketType === 'futures' ? 'futures' : 'spot'
    return exchangeInfoCatalog.markets({ marketType, baseUrl: REST_BASE[marketType] })
  }

  async history(options) {
    const marketType = options.marketType === 'futures' ? 'futures' : 'spot'
    const interval = ['1m', '5m', '15m', '1h', '4h', '1d'].includes(options.interval) ? options.interval : '15m'
    const symbol = String(options.symbol || 'BTCUSDT').toUpperCase()
    const limit = Math.min(Math.max(Number(options.limit) || 1000, 100), 5000)
    const cacheKey = `${marketType}:${symbol}:${interval}:${limit}`
    const cached = this.historyCache.get(cacheKey)
    if (cached?.data && cached.expiresAt > Date.now()) return cached.data
    if (cached?.request) return cached.request
    const path = marketType === 'futures' ? '/fapi/v1/klines' : '/api/v3/klines'
    const request = (async () => {
      let endTime
      let remaining = limit
      let rows = []
      while (remaining > 0) {
        const batchSize = Math.min(1000, remaining)
        const query = new URLSearchParams({ symbol, interval, limit: String(batchSize) })
        if (endTime) query.set('endTime', String(endTime))
        const response = await fetchWithProxy(`${REST_BASE[marketType]}${path}?${query.toString()}`)
        const batch = await response.json()
        if (!response.ok) throw new Error(batch?.msg || `History request failed (${response.status})`)
        if (!Array.isArray(batch) || !batch.length) break
        rows = [...batch, ...rows]
        remaining -= batch.length
        endTime = Number(batch[0][0]) - 1
        if (batch.length < batchSize) break
      }
      const candles = [...new Map(rows.map((row) => [Number(row[0]), row])).values()]
        .sort((left, right) => Number(left[0]) - Number(right[0]))
        .slice(-limit)
        .map((row) => ({ time: Math.floor(Number(row[0]) / 1000), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]) }))
      this.historyCache.set(cacheKey, { data: candles, expiresAt: Date.now() + HISTORY_CACHE_TTL })
      while (this.historyCache.size > HISTORY_CACHE_LIMIT) this.historyCache.delete(this.historyCache.keys().next().value)
      return candles
    })()
    this.historyCache.set(cacheKey, { request, expiresAt: 0 })
    try {
      return await request
    } catch (error) {
      if (this.historyCache.get(cacheKey)?.request === request) this.historyCache.delete(cacheKey)
      throw error
    }
  }

  async snapshot(options) {
    const marketType = options.marketType === 'futures' ? 'futures' : 'spot'
    const symbol = String(options.symbol || 'BTCUSDT').toUpperCase()
    const tickerPath = marketType === 'futures' ? '/fapi/v1/ticker/24hr' : '/api/v3/ticker/24hr'
    const bookPath = marketType === 'futures' ? '/fapi/v1/ticker/bookTicker' : '/api/v3/ticker/bookTicker'
    const [tickerResponse, bookResponse] = await Promise.all([
      fetchWithProxy(`${REST_BASE[marketType]}${tickerPath}?symbol=${encodeURIComponent(symbol)}`),
      fetchWithProxy(`${REST_BASE[marketType]}${bookPath}?symbol=${encodeURIComponent(symbol)}`),
    ])
    const [ticker, book] = await Promise.all([tickerResponse.json(), bookResponse.json()])
    if (!tickerResponse.ok) throw new Error(ticker?.msg || `Ticker snapshot failed (${tickerResponse.status})`)
    if (!bookResponse.ok) throw new Error(book?.msg || `Book snapshot failed (${bookResponse.status})`)
    const timestamp = Date.now()
    return [
      { type: 'ticker', marketType, symbol, price: Number(ticker.lastPrice), change: Number(ticker.priceChangePercent), high: Number(ticker.highPrice), low: Number(ticker.lowPrice), volume: Number(ticker.volume), quoteVolume: Number(ticker.quoteVolume), timestamp },
      { type: 'book', marketType, symbol, bid: Number(book.bidPrice), bidSize: Number(book.bidQty), ask: Number(book.askPrice), askSize: Number(book.askQty), timestamp },
    ]
  }

  reconnectAll() {
    Object.values(this.sockets).forEach((socket) => socket.reconnect())
  }
}
