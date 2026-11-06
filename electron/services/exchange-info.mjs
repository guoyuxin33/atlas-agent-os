import { fetchWithProxy } from './network.mjs'

const DEFAULT_CACHE_TTL = 5 * 60 * 1000

function exchangeInfoPath(marketType) {
  return marketType === 'futures' ? '/fapi/v1/exchangeInfo' : '/api/v3/exchangeInfo'
}

function normalizedMarketType(value) {
  return value === 'futures' ? 'futures' : 'spot'
}

export class ExchangeInfoCatalog {
  constructor({ fetcher = fetchWithProxy, cacheTtl = DEFAULT_CACHE_TTL } = {}) {
    this.fetcher = fetcher
    this.cacheTtl = cacheTtl
    this.cache = new Map()
  }

  async exchangeInfo({ baseUrl, marketType }) {
    const normalizedType = normalizedMarketType(marketType)
    const normalizedBaseUrl = String(baseUrl || '').replace(/\/$/, '')
    if (!normalizedBaseUrl) throw new Error('Binance exchangeInfo base URL is required')
    const cacheKey = `${normalizedType}:${normalizedBaseUrl}`
    const cached = this.cache.get(cacheKey)
    if (cached?.data && cached.expiresAt > Date.now()) return cached.data
    if (cached?.request) return cached.request

    const request = (async () => {
      const response = await this.fetcher(`${normalizedBaseUrl}${exchangeInfoPath(normalizedType)}`)
      const payload = await response.json().catch(() => null)
      if (!response.ok) throw new Error(payload?.msg || `Binance exchangeInfo request failed (${response.status})`)
      if (!Array.isArray(payload?.symbols)) throw new Error('Binance exchangeInfo response is invalid')
      const data = { ...payload, symbols: payload.symbols }
      this.cache.set(cacheKey, { data, expiresAt: Date.now() + this.cacheTtl })
      return data
    })()

    this.cache.set(cacheKey, { request, expiresAt: 0 })
    try {
      return await request
    } catch (error) {
      if (this.cache.get(cacheKey)?.request === request) this.cache.delete(cacheKey)
      throw error
    }
  }

  async markets(options) {
    const marketType = normalizedMarketType(options.marketType)
    const payload = await this.exchangeInfo({ ...options, marketType })
    return payload.symbols
      .filter((market) => market.status === 'TRADING' && market.quoteAsset === 'USDT' && (marketType !== 'futures' || market.contractType === 'PERPETUAL'))
      .map((market) => ({
        symbol: market.symbol,
        baseAsset: market.baseAsset,
        quoteAsset: market.quoteAsset,
        status: market.status,
      }))
      .sort((left, right) => left.symbol.localeCompare(right.symbol))
  }

  async symbolRules(options) {
    const payload = await this.exchangeInfo(options)
    const symbol = String(options.symbol || '').trim().toUpperCase()
    const rules = payload.symbols.find((item) => item.symbol === symbol)
    if (!rules) throw new Error(`Binance exchangeInfo 中不存在交易对 ${symbol}`)
    if (rules.status !== 'TRADING') throw new Error(`${symbol} 当前不可交易 (${rules.status || 'UNKNOWN'})`)
    return rules
  }

  clear() {
    this.cache.clear()
  }
}

export const exchangeInfoCatalog = new ExchangeInfoCatalog()
