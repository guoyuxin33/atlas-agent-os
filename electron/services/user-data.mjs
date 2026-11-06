import WebSocket from 'ws'
import { loadBinanceCredentials } from './binance.mjs'
import { fetchWithProxy, webSocketOptions } from './network.mjs'

const REST_BASE = {
  live: { spot: 'https://api.binance.com', futures: 'https://fapi.binance.com' },
  testnet: { spot: 'https://testnet.binance.vision', futures: 'https://testnet.binancefuture.com' },
}

const WS_BASE = {
  live: { spot: 'wss://stream.binance.com:9443/ws', futures: 'wss://fstream.binance.com/ws' },
  testnet: { spot: 'wss://stream.testnet.binance.vision/ws', futures: 'wss://stream.binancefuture.com/ws' },
}

function normalizedOptions(options) {
  return {
    environment: options.environment === 'live' ? 'live' : 'testnet',
    marketType: options.marketType === 'futures' ? 'futures' : 'spot',
  }
}

class UserDataSocket {
  constructor(options, onEvent) {
    this.options = normalizedOptions(options)
    this.onEvent = onEvent
    this.socket = null
    this.listenKey = ''
    this.keepAliveTimer = null
    this.reconnectTimer = null
    this.connectPromise = null
    this.active = true
  }

  async requestListenKey(method = 'POST') {
    const credentials = await loadBinanceCredentials(this.options.environment)
    if (!credentials?.apiKey) throw new Error(`尚未配置 Binance ${this.options.environment === 'live' ? '生产' : '测试网'}凭证`)
    const path = this.options.marketType === 'futures' ? '/fapi/v1/listenKey' : '/api/v3/userDataStream'
    const url = new URL(`${REST_BASE[this.options.environment][this.options.marketType]}${path}`)
    if (method === 'PUT' && this.listenKey) url.searchParams.set('listenKey', this.listenKey)
    const response = await fetchWithProxy(url, { method, headers: { 'X-MBX-APIKEY': credentials.apiKey }, signal: AbortSignal.timeout(10_000) })
    const data = await response.json().catch(() => null)
    if (!response.ok) throw new Error(data?.msg || `账户数据流请求失败 (${response.status})`)
    if (method === 'POST') {
      if (!data?.listenKey) throw new Error('Binance 未返回账户数据流凭证')
      this.listenKey = data.listenKey
    }
  }

  async connect() {
    if (!this.active || this.connectPromise || this.socket?.readyState === WebSocket.OPEN) return this.connectPromise
    this.connectPromise = (async () => {
      await this.requestListenKey('POST')
      const socketUrl = `${WS_BASE[this.options.environment][this.options.marketType]}/${this.listenKey}`
      const options = await webSocketOptions(socketUrl)
      this.socket = new WebSocket(socketUrl, { ...options, perMessageDeflate: false, handshakeTimeout: 8_000 })
      this.socket.on('open', () => {
        this.onEvent({ type: 'connection', connected: true, ...this.options, timestamp: Date.now() })
        this.scheduleKeepAlive()
      })
      this.socket.on('message', (raw) => {
        try {
          const data = JSON.parse(raw.toString())
          this.onEvent({ type: 'account', eventType: data.e || 'ACCOUNT_UPDATE', ...this.options, timestamp: data.E || Date.now() })
        } catch (error) {
          console.error('[account-stream:parse]', error)
        }
      })
      this.socket.on('close', () => {
        this.onEvent({ type: 'connection', connected: false, ...this.options, timestamp: Date.now() })
        this.clearKeepAlive()
        this.scheduleReconnect()
      })
      this.socket.on('error', () => this.socket?.close())
    })().finally(() => { this.connectPromise = null })
    return this.connectPromise
  }

  scheduleKeepAlive() {
    this.clearKeepAlive()
    this.keepAliveTimer = setInterval(() => {
      this.requestListenKey('PUT').catch((error) => {
        console.error('[account-stream:keepalive]', error)
        this.reconnect()
      })
    }, 30 * 60 * 1000)
  }

  clearKeepAlive() {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer)
    this.keepAliveTimer = null
  }

  scheduleReconnect() {
    if (!this.active || this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect().catch((error) => {
        console.error('[account-stream:reconnect]', error)
        this.scheduleReconnect()
      })
    }, 1800)
  }

  reconnect() {
    if (!this.active) return
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.clearKeepAlive()
    this.socket?.removeAllListeners()
    this.socket?.terminate()
    this.socket = null
    this.listenKey = ''
    this.connect().catch((error) => {
      console.error('[account-stream:connect]', error)
      this.scheduleReconnect()
    })
  }

  close() {
    this.active = false
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.clearKeepAlive()
    this.socket?.removeAllListeners()
    this.socket?.terminate()
    this.socket = null
  }
}

export class UserDataHub {
  constructor() {
    this.clients = new Map()
    this.subscriptions = new Map()
    this.sockets = new Map()
  }

  key(options) {
    const normalized = normalizedOptions(options)
    return `${normalized.environment}:${normalized.marketType}`
  }

  async subscribe(webContents, options) {
    if (options.environment === 'paper') return { ok: true, mode: 'paper' }
    const key = this.key(options)
    this.clients.set(webContents.id, webContents)
    const topics = this.subscriptions.get(webContents.id) || new Set()
    topics.add(key)
    this.subscriptions.set(webContents.id, topics)
    if (!this.sockets.has(key)) {
      const socket = new UserDataSocket(options, (event) => this.broadcast(key, event))
      this.sockets.set(key, socket)
      try {
        await socket.connect()
      } catch (error) {
        this.sockets.delete(key)
        socket.close()
        throw error
      }
    }
    return { ok: true, mode: 'websocket', topic: key }
  }

  unsubscribe(webContents, options) {
    const key = this.key(options)
    const topics = this.subscriptions.get(webContents.id)
    topics?.delete(key)
    if (!topics?.size) this.subscriptions.delete(webContents.id)
    const stillUsed = [...this.subscriptions.values()].some((set) => set.has(key))
    if (!stillUsed) {
      this.sockets.get(key)?.close()
      this.sockets.delete(key)
    }
    return { ok: true }
  }

  broadcast(key, update) {
    for (const [clientId, topics] of this.subscriptions) {
      if (!topics.has(key)) continue
      const webContents = this.clients.get(clientId)
      if (!webContents || webContents.isDestroyed()) {
        this.removeClient(clientId)
        continue
      }
      webContents.send('account:update', update)
    }
  }

  removeClient(clientId) {
    const topics = this.subscriptions.get(clientId) || new Set()
    this.subscriptions.delete(clientId)
    this.clients.delete(clientId)
    for (const key of topics) {
      const stillUsed = [...this.subscriptions.values()].some((set) => set.has(key))
      if (!stillUsed) {
        this.sockets.get(key)?.close()
        this.sockets.delete(key)
      }
    }
  }

  reconnectAll() {
    this.sockets.forEach((socket) => socket.reconnect())
  }

  close() {
    this.sockets.forEach((socket) => socket.close())
    this.sockets.clear()
  }
}
