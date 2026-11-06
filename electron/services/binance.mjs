import { createHmac, randomUUID } from 'node:crypto'
import { app } from 'electron'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { exchangeInfoCatalog } from './exchange-info.mjs'
import { loadVault } from './vault.mjs'
import { fetchWithProxy } from './network.mjs'

const simulationOrders = []
const simulationOrdersByClientId = new Map()
const PAPER_STARTING_BALANCE = 25_000
const DEFAULT_FUTURES_LEVERAGE = 3
const PAPER_MAINTENANCE_MARGIN_RATE = 0.005
const paperAccounts = {
  spot: { usdt: PAPER_STARTING_BALANCE, holdings: new Map(), realizedPnl: 0 },
  futures: { walletBalance: PAPER_STARTING_BALANCE, positions: new Map(), configurations: new Map(), positionMode: 'ONE_WAY', realizedPnl: 0 },
}
const tickerCaches = {
  spot: { expiresAt: 0, rows: [] },
  futures: { expiresAt: 0, rows: [] },
}
const futuresPositionModeCaches = {
  testnet: { expiresAt: 0, value: 'ONE_WAY' },
  live: { expiresAt: 0, value: 'ONE_WAY' },
}
const serverTimeStates = new Map()
const rateLimitStates = new Map()
const pendingLiveOrders = new Map()
const SERVER_TIME_TTL = 5 * 60 * 1000
const SIGNED_RECV_WINDOW = 5000
let binanceRequestFetcher = fetchWithProxy
let networkRevision = 0
let paperLoaded = false
let paperLoadPromise = null
let paperPersistQueue = Promise.resolve()

function paperStatePath() {
  return join(app.getPath('userData'), 'paper', 'account.json')
}

async function ensurePaperLoaded() {
  if (paperLoaded) return
  if (!paperLoadPromise) {
    paperLoadPromise = (async () => {
      try {
        const saved = JSON.parse(await readFile(paperStatePath(), 'utf8'))
        if (![1, 2, 3].includes(saved?.version)) return
        paperAccounts.spot.usdt = finiteNumber(saved.spot?.usdt, PAPER_STARTING_BALANCE)
        paperAccounts.spot.realizedPnl = finiteNumber(saved.spot?.realizedPnl)
        paperAccounts.spot.holdings = new Map((saved.spot?.holdings || []).filter((item) => item?.symbol).map((item) => [item.symbol, item]))
        paperAccounts.futures.walletBalance = finiteNumber(saved.futures?.walletBalance, PAPER_STARTING_BALANCE)
        paperAccounts.futures.realizedPnl = finiteNumber(saved.futures?.realizedPnl)
        paperAccounts.futures.positionMode = saved.futures?.positionMode === 'HEDGE' ? 'HEDGE' : 'ONE_WAY'
        paperAccounts.futures.positions = new Map((saved.futures?.positions || []).filter((item) => item?.symbol).map((item) => {
          const positionSide = item.positionSide === 'LONG' || item.positionSide === 'SHORT' ? item.positionSide : 'BOTH'
          return [paperFuturesPositionKey(item.symbol, positionSide), {
          ...item,
          positionSide,
          leverage: Math.max(1, finiteNumber(item.leverage, DEFAULT_FUTURES_LEVERAGE)),
          marginType: item.marginType === 'ISOLATED' ? 'ISOLATED' : 'CROSSED',
          isolatedMargin: Math.max(0, finiteNumber(item.isolatedMargin)),
          }]
        }))
        paperAccounts.futures.configurations = new Map((saved.futures?.configurations || []).filter((item) => item?.symbol).map((item) => [item.symbol, {
          symbol: item.symbol,
          leverage: Math.max(1, finiteNumber(item.leverage, DEFAULT_FUTURES_LEVERAGE)),
          marginType: item.marginType === 'ISOLATED' ? 'ISOLATED' : 'CROSSED',
        }]))
        simulationOrders.splice(0, simulationOrders.length, ...(saved.orders || []).slice(0, 200))
        simulationOrdersByClientId.clear()
        simulationOrders.forEach((order) => { if (order.clientOrderId) simulationOrdersByClientId.set(order.clientOrderId, order) })
      } catch (error) {
        if (error?.code !== 'ENOENT') console.error('[paper:load]', error)
      } finally {
        paperLoaded = true
      }
    })()
  }
  await paperLoadPromise
}

function persistPaperAccounts() {
  paperPersistQueue = paperPersistQueue.then(async () => {
    const filePath = paperStatePath()
    const directory = join(app.getPath('userData'), 'paper')
    const temporaryPath = `${filePath}.tmp`
    const payload = {
      version: 3,
      spot: { usdt: paperAccounts.spot.usdt, realizedPnl: paperAccounts.spot.realizedPnl, holdings: [...paperAccounts.spot.holdings.values()] },
      futures: {
        walletBalance: paperAccounts.futures.walletBalance,
        realizedPnl: paperAccounts.futures.realizedPnl,
        positions: [...paperAccounts.futures.positions.values()],
        configurations: [...paperAccounts.futures.configurations.values()],
        positionMode: paperAccounts.futures.positionMode,
      },
      orders: simulationOrders.slice(0, 200),
      updatedAt: Date.now(),
    }
    await mkdir(directory, { recursive: true })
    await writeFile(temporaryPath, JSON.stringify(payload), { mode: 0o600 })
    await rename(temporaryPath, filePath)
  })
  return paperPersistQueue
}

function apiBase(environment, marketType) {
  if (marketType === 'futures') {
    return environment === 'live' ? 'https://fapi.binance.com' : 'https://testnet.binancefuture.com'
  }
  return environment === 'live' ? 'https://api.binance.com' : 'https://testnet.binance.vision'
}

function serverTimeKey(environment, marketType) {
  return `${environment}:${marketType}`
}

export function calculateServerTimeOffset(serverTime, startedAt, endedAt) {
  const server = Number(serverTime)
  const started = Number(startedAt)
  const ended = Number(endedAt)
  if (![server, started, ended].every(Number.isFinite) || ended < started) throw new Error('Binance server time response is invalid')
  return Math.round(server - ((started + ended) / 2))
}

export function createSignedQuery(params, { timestamp, recvWindow = SIGNED_RECV_WINDOW, apiSecret }) {
  if (!apiSecret) throw new Error('Binance API Secret is required')
  if (!Number.isFinite(Number(timestamp))) throw new Error('Binance timestamp is invalid')
  const query = new URLSearchParams()
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value))
  })
  query.set('timestamp', String(Math.round(Number(timestamp))))
  query.set('recvWindow', String(recvWindow))
  query.set('signature', createHmac('sha256', apiSecret).update(query.toString()).digest('hex'))
  return query
}

async function synchronizeServerTime(environment, marketType, force = false) {
  const key = serverTimeKey(environment, marketType)
  const existing = serverTimeStates.get(key)
  if (!force && existing?.expiresAt > Date.now()) return existing.offset
  if (existing?.request) return existing.request
  assertRateLimitAvailable(environment, marketType)

  const revision = networkRevision
  const requestPromise = (async () => {
    const startedAt = Date.now()
    const timePath = marketType === 'futures' ? '/fapi/v1/time' : '/api/v3/time'
    const response = await binanceRequestFetcher(`${apiBase(environment, marketType)}${timePath}`, { signal: AbortSignal.timeout(8000) })
    const payload = await response.json().catch(() => null)
    if (!response.ok || !Number.isFinite(Number(payload?.serverTime))) {
      const blockedUntil = revision === networkRevision ? recordRateLimit(environment, marketType, response, payload) : null
      const retryMessage = blockedUntil ? `，${Math.max(1, Math.ceil((blockedUntil - Date.now()) / 1000))} 秒后重试` : ''
      throw new BinanceApiError(`${payload?.msg || `Binance 时间同步失败 (${response.status})`}${retryMessage}`, {
        code: payload?.code,
        status: response.status,
        retryAfter: blockedUntil ? Math.max(1, Math.ceil((blockedUntil - Date.now()) / 1000)) : undefined,
      })
    }
    const offset = calculateServerTimeOffset(payload.serverTime, startedAt, Date.now())
    serverTimeStates.set(key, { offset, expiresAt: Date.now() + SERVER_TIME_TTL })
    return offset
  })()
  serverTimeStates.set(key, { offset: existing?.offset || 0, expiresAt: 0, request: requestPromise })
  try {
    return await requestPromise
  } catch (error) {
    serverTimeStates.delete(key)
    throw error
  }
}

class BinanceApiError extends Error {
  constructor(message, { code, status, retryAfter } = {}) {
    super(message)
    this.name = 'BinanceApiError'
    this.code = code
    this.status = status
    this.retryAfter = retryAfter
  }
}

function rateLimitKey(environment, marketType) {
  return `${environment}:${marketType}`
}

function retryAfterTimestamp(response, payload) {
  const retryAfter = response.headers.get('retry-after')
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds)) return Date.now() + Math.max(1, seconds) * 1000
    const date = Date.parse(retryAfter)
    if (Number.isFinite(date)) return date
  }
  const bannedUntil = String(payload?.msg || '').match(/banned until\s+(\d{10,13})/i)?.[1]
  if (bannedUntil) {
    const numeric = Number(bannedUntil)
    return bannedUntil.length <= 10 ? numeric * 1000 : numeric
  }
  return Date.now() + (response.status === 418 || Number(payload?.code) === -1003 ? 5 * 60 * 1000 : 60 * 1000)
}

function recordRateLimit(environment, marketType, response, payload) {
  if (![418, 429].includes(response.status) && Number(payload?.code) !== -1003) return null
  const blockedUntil = retryAfterTimestamp(response, payload)
  rateLimitStates.set(rateLimitKey(environment, marketType), blockedUntil)
  return blockedUntil
}

function assertRateLimitAvailable(environment, marketType) {
  const key = rateLimitKey(environment, marketType)
  const blockedUntil = rateLimitStates.get(key) || 0
  if (blockedUntil <= Date.now()) {
    rateLimitStates.delete(key)
    return
  }
  const retryAfterSeconds = Math.max(1, Math.ceil((blockedUntil - Date.now()) / 1000))
  throw new BinanceApiError(`Binance 请求频率受限，本地已暂停 REST 请求，${retryAfterSeconds} 秒后重试 [-1003]`, {
    code: -1003,
    status: 429,
    retryAfter: retryAfterSeconds,
  })
}

export async function loadBinanceCredentials(environment) {
  const credentials = await loadVault(`binance-${environment}`)
  if (credentials) return credentials
  const legacy = await loadVault('binance-primary')
  return legacy?.environment === environment ? legacy : null
}

function assertOrder(order) {
  if (!['paper', 'testnet', 'live'].includes(order.environment)) throw new Error('Invalid environment')
  if (!['spot', 'futures'].includes(order.marketType)) throw new Error('Invalid market type')
  if (!/^[\p{L}\p{N}_-]{2,40}$/u.test(order.symbol)) throw new Error('Invalid symbol')
  if (!['BUY', 'SELL'].includes(order.side)) throw new Error('Invalid side')
  if (!['MARKET', 'LIMIT'].includes(order.type)) throw new Error('Invalid order type')
  if (!(Number(order.quantity) > 0)) throw new Error('Quantity must be positive')
  if (order.type === 'LIMIT' && !(Number(order.price) > 0)) throw new Error('Limit price must be positive')
  if (order.marketType === 'futures' && !['LONG', 'SHORT', 'BOTH'].includes(order.positionSide || 'BOTH')) throw new Error('Invalid position side')
  if (order.clientOrderId && !/^[A-Za-z0-9_-]{1,36}$/.test(order.clientOrderId)) throw new Error('Invalid client order id')
}

function expandDecimal(value) {
  const input = String(value ?? '').trim()
  const match = input.match(/^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/)
  if (!match || (!match[2] && !match[3])) throw new Error(`无效数值 ${input || '(empty)'}`)
  const sign = match[1] === '-' ? '-' : ''
  const whole = match[2] || ''
  const fraction = match[3] || ''
  const exponent = Number(match[4] || 0)
  const digits = `${whole}${fraction}` || '0'
  const decimalIndex = whole.length + exponent
  let expanded
  if (decimalIndex <= 0) expanded = `0.${'0'.repeat(-decimalIndex)}${digits}`
  else if (decimalIndex >= digits.length) expanded = `${digits}${'0'.repeat(decimalIndex - digits.length)}`
  else expanded = `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`
  const [integerPart, decimalPart = ''] = expanded.split('.')
  const integer = integerPart.replace(/^0+(?=\d)/, '') || '0'
  const decimal = decimalPart.replace(/0+$/, '')
  const normalized = decimal ? `${integer}.${decimal}` : integer
  return normalized === '0' ? '0' : `${sign}${normalized}`
}

function decimalScale(value) {
  const normalized = expandDecimal(value)
  return normalized.includes('.') ? normalized.length - normalized.indexOf('.') - 1 : 0
}

function decimalUnits(value, scale) {
  const normalized = expandDecimal(value)
  const negative = normalized.startsWith('-')
  const unsigned = negative ? normalized.slice(1) : normalized
  const [integer, fraction = ''] = unsigned.split('.')
  const units = BigInt(`${integer}${fraction.padEnd(scale, '0')}`)
  return negative ? -units : units
}

function decimalFromUnits(units, scale) {
  const negative = units < 0n
  const digits = (negative ? -units : units).toString().padStart(scale + 1, '0')
  const raw = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits
  const normalized = expandDecimal(raw)
  return negative && normalized !== '0' ? `-${normalized}` : normalized
}

function compareDecimals(left, right) {
  const scale = Math.max(decimalScale(left), decimalScale(right))
  const leftUnits = decimalUnits(left, scale)
  const rightUnits = decimalUnits(right, scale)
  return leftUnits === rightUnits ? 0 : leftUnits > rightUnits ? 1 : -1
}

function gcd(left, right) {
  let a = left < 0n ? -left : left
  let b = right < 0n ? -right : right
  while (b) [a, b] = [b, a % b]
  return a
}

function combinedStep(values) {
  const active = values.filter((value) => value !== undefined && compareDecimals(value, '0') > 0)
  if (!active.length) return null
  const scale = Math.max(...active.map(decimalScale))
  const units = active.map((value) => decimalUnits(value, scale))
  const step = units.reduce((current, value) => current / gcd(current, value) * value)
  return decimalFromUnits(step, scale)
}

function clampToStep(value, step, direction = 'down') {
  if (!step || compareDecimals(step, '0') <= 0) return expandDecimal(value)
  const scale = Math.max(decimalScale(value), decimalScale(step))
  const valueUnits = decimalUnits(value, scale)
  const stepUnits = decimalUnits(step, scale)
  const quotient = valueUnits / stepUnits
  const remainder = valueUnits % stepUnits
  const normalizedUnits = direction === 'up' && remainder ? (quotient + 1n) * stepUnits : quotient * stepUnits
  return decimalFromUnits(normalizedUnits, scale)
}

function minimumPositive(values) {
  return values.filter((value) => value !== undefined && compareDecimals(value, '0') > 0)
    .reduce((minimum, value) => minimum === null || compareDecimals(value, minimum) < 0 ? expandDecimal(value) : minimum, null)
}

function maximumPositive(values) {
  return values.filter((value) => value !== undefined && compareDecimals(value, '0') > 0)
    .reduce((maximum, value) => maximum === null || compareDecimals(value, maximum) > 0 ? expandDecimal(value) : maximum, null)
}

function decimalProduct(left, right) {
  const leftScale = decimalScale(left)
  const rightScale = decimalScale(right)
  return { units: decimalUnits(left, leftScale) * decimalUnits(right, rightScale), scale: leftScale + rightScale }
}

function compareProductToDecimal(product, value) {
  const scale = Math.max(product.scale, decimalScale(value))
  const productUnits = product.units * (10n ** BigInt(scale - product.scale))
  const valueUnits = decimalUnits(value, scale)
  return productUnits === valueUnits ? 0 : productUnits > valueUnits ? 1 : -1
}

function filterByType(rules, type) {
  return (Array.isArray(rules?.filters) ? rules.filters : []).find((filter) => filter.filterType === type)
}

function activeNotionalLimits(order, rules) {
  const minNotional = filterByType(rules, 'MIN_NOTIONAL')
  const notional = filterByType(rules, 'NOTIONAL')
  const market = order.type === 'MARKET'
  const minimums = []
  const maximums = []
  if (minNotional && (!market || minNotional.applyToMarket !== false)) minimums.push(minNotional.minNotional ?? minNotional.notional)
  if (notional && (!market || notional.applyMinToMarket !== false)) minimums.push(notional.minNotional)
  if (notional && (!market || notional.applyMaxToMarket !== false)) maximums.push(notional.maxNotional)
  return { minimum: maximumPositive(minimums), maximum: minimumPositive(maximums) }
}

export function normalizeBinanceOrder(order, rules) {
  const lotSize = filterByType(rules, 'LOT_SIZE')
  const marketLotSize = order.type === 'MARKET' ? filterByType(rules, 'MARKET_LOT_SIZE') : null
  const lotFilters = [lotSize, marketLotSize].filter(Boolean)
  const quantityStep = combinedStep(lotFilters.map((filter) => filter.stepSize))
  const minimumQuantity = maximumPositive(lotFilters.map((filter) => filter.minQty))
  const maximumQuantity = minimumPositive(lotFilters.map((filter) => filter.maxQty))
  const requestedQuantity = expandDecimal(order.quantity)
  const quantity = clampToStep(requestedQuantity, quantityStep, 'down')
  if (compareDecimals(quantity, '0') <= 0) throw new Error(`${order.symbol} 数量低于 Binance 最小步长 ${quantityStep || minimumQuantity || 'unknown'}`)
  if (minimumQuantity && compareDecimals(quantity, minimumQuantity) < 0) throw new Error(`${order.symbol} 数量 ${quantity} 低于最小数量 ${minimumQuantity}`)
  if (maximumQuantity && compareDecimals(requestedQuantity, maximumQuantity) > 0) throw new Error(`${order.symbol} 数量 ${requestedQuantity} 超过单笔最大数量 ${maximumQuantity}`)

  let price = order.price
  if (order.type === 'LIMIT') {
    const priceFilter = filterByType(rules, 'PRICE_FILTER')
    const tickSize = priceFilter?.tickSize && compareDecimals(priceFilter.tickSize, '0') > 0 ? priceFilter.tickSize : null
    price = clampToStep(order.price, tickSize, order.side === 'SELL' ? 'up' : 'down')
    if (priceFilter?.minPrice && compareDecimals(priceFilter.minPrice, '0') > 0 && compareDecimals(price, priceFilter.minPrice) < 0) {
      throw new Error(`${order.symbol} 限价 ${price} 低于最小价格 ${expandDecimal(priceFilter.minPrice)}`)
    }
    if (priceFilter?.maxPrice && compareDecimals(priceFilter.maxPrice, '0') > 0 && compareDecimals(price, priceFilter.maxPrice) > 0) {
      throw new Error(`${order.symbol} 限价 ${price} 超过最大价格 ${expandDecimal(priceFilter.maxPrice)}`)
    }
  }

  const notionalLimits = activeNotionalLimits(order, rules)
  const validationPrice = order.type === 'LIMIT' ? price : order.marketPrice
  if ((notionalLimits.minimum || notionalLimits.maximum) && !(Number(validationPrice) > 0)) {
    throw new Error(`${order.symbol} 缺少有效市场价格，无法校验 Binance 名义价值规则`)
  }
  if (validationPrice) {
    const product = decimalProduct(quantity, validationPrice)
    if (notionalLimits.minimum && compareProductToDecimal(product, notionalLimits.minimum) < 0) {
      throw new Error(`${order.symbol} 订单名义价值低于最小值 ${expandDecimal(notionalLimits.minimum)}`)
    }
    if (notionalLimits.maximum && compareProductToDecimal(product, notionalLimits.maximum) > 0) {
      throw new Error(`${order.symbol} 订单名义价值超过最大值 ${expandDecimal(notionalLimits.maximum)}`)
    }
  }
  return { ...order, quantity, price: order.type === 'LIMIT' ? price : undefined }
}

async function getLiveTickers(marketType = 'spot') {
  const normalizedMarketType = marketType === 'futures' ? 'futures' : 'spot'
  const tickerCache = tickerCaches[normalizedMarketType]
  if (tickerCache.expiresAt > Date.now()) return tickerCache.rows
  const endpoint = normalizedMarketType === 'futures'
    ? 'https://fapi.binance.com/fapi/v1/ticker/24hr'
    : 'https://api.binance.com/api/v3/ticker/24hr'
  const response = await fetchWithProxy(endpoint)
  const rows = await response.json().catch(() => null)
  if (!response.ok || !Array.isArray(rows)) throw new Error(rows?.msg || 'Binance ticker request failed')
  tickerCaches[normalizedMarketType] = { expiresAt: Date.now() + 1000, rows }
  return rows
}

async function getOrderValidationPrice(environment, marketType, symbol) {
  const path = marketType === 'futures' ? '/fapi/v1/ticker/price' : '/api/v3/ticker/price'
  const ticker = await request({ environment, marketType, path, params: { symbol } })
  const price = ticker?.price
  if (!(Number(price) > 0)) throw new Error(`${symbol} 无法获取有效市场价格`)
  return String(price)
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function normalizeFuturesSymbol(symbol) {
  const normalized = String(symbol || 'BTCUSDT').trim().toUpperCase()
  if (!/^[\p{L}\p{N}_-]{2,40}$/u.test(normalized)) throw new Error('Invalid futures symbol')
  return normalized
}

function normalizePositionSide(positionSide, fallback = 'BOTH') {
  return ['LONG', 'SHORT', 'BOTH'].includes(positionSide) ? positionSide : fallback
}

function normalizePositionMode(positionMode) {
  if (positionMode === 'HEDGE' || positionMode === true || positionMode === 'true') return 'HEDGE'
  if (positionMode === 'ONE_WAY' || positionMode === false || positionMode === 'false') return 'ONE_WAY'
  throw new Error('持仓模式必须是单向或双向')
}

function paperFuturesPositionKey(symbol, positionSide = 'BOTH') {
  const normalized = normalizeFuturesSymbol(symbol)
  const side = normalizePositionSide(positionSide)
  return side === 'BOTH' ? normalized : `${normalized}:${side}`
}

function paperFuturesPositionsForSymbol(symbol) {
  const normalized = normalizeFuturesSymbol(symbol)
  return [...paperAccounts.futures.positions.values()].filter((position) => position.symbol === normalized)
}

function paperFuturesPositionFor(symbol, positionSide) {
  const mode = paperAccounts.futures.positionMode
  const side = mode === 'HEDGE' ? normalizePositionSide(positionSide, '') : 'BOTH'
  if (mode === 'HEDGE' && !['LONG', 'SHORT'].includes(side)) {
    const openPositions = paperFuturesPositionsForSymbol(symbol)
    return openPositions.length === 1 ? openPositions[0] : undefined
  }
  return paperAccounts.futures.positions.get(paperFuturesPositionKey(symbol, side))
}

function paperFuturesConfiguration(symbol, positionSide) {
  const normalized = normalizeFuturesSymbol(symbol)
  const position = paperFuturesPositionFor(normalized, positionSide)
  const configured = paperAccounts.futures.configurations.get(normalized)
  return {
    symbol: normalized,
    leverage: Math.max(1, finiteNumber(position?.leverage ?? configured?.leverage, DEFAULT_FUTURES_LEVERAGE)),
    marginType: (position?.marginType ?? configured?.marginType) === 'ISOLATED' ? 'ISOLATED' : 'CROSSED',
    isolatedMargin: Math.max(0, finiteNumber(position?.isolatedMargin)),
    positionAmt: finiteNumber(position?.quantity),
    positionMode: paperAccounts.futures.positionMode,
    positionSide: position?.positionSide || (paperAccounts.futures.positionMode === 'ONE_WAY' ? 'BOTH' : normalizePositionSide(positionSide, 'LONG')),
  }
}

function paperFuturesPositionMargin(position) {
  const leverage = Math.max(1, finiteNumber(position.leverage, DEFAULT_FUTURES_LEVERAGE))
  const markPrice = finiteNumber(position.markPrice, position.entryPrice)
  const initialMargin = Math.abs(finiteNumber(position.quantity)) * markPrice / leverage
  return position.marginType === 'ISOLATED'
    ? Math.max(initialMargin, finiteNumber(position.isolatedMargin))
    : initialMargin
}

function paperFuturesUsedMargin(excludedPositionKey) {
  return [...paperAccounts.futures.positions.entries()].reduce((sum, [key, position]) => (
    key === excludedPositionKey ? sum : sum + paperFuturesPositionMargin(position)
  ), 0)
}

function paperFuturesLiquidationPrice(position) {
  const quantity = Math.abs(finiteNumber(position.quantity))
  const entryPrice = finiteNumber(position.entryPrice)
  if (!(quantity > 0) || !(entryPrice > 0)) return 0
  const direction = finiteNumber(position.quantity) >= 0 ? 1 : -1
  let availableMargin
  let otherMaintenanceMargin = 0
  if (position.marginType === 'ISOLATED') {
    availableMargin = Math.max(0, finiteNumber(position.isolatedMargin))
  } else {
    availableMargin = paperAccounts.futures.walletBalance
    for (const other of paperAccounts.futures.positions.values()) {
      if (other === position) continue
      const otherQuantity = Math.abs(finiteNumber(other.quantity))
      const otherMark = finiteNumber(other.markPrice, other.entryPrice)
      const otherDirection = finiteNumber(other.quantity) >= 0 ? 1 : -1
      availableMargin += (otherMark - finiteNumber(other.entryPrice)) * otherQuantity * otherDirection
      otherMaintenanceMargin += otherQuantity * otherMark * PAPER_MAINTENANCE_MARGIN_RATE
    }
  }
  const price = direction > 0
    ? (entryPrice * quantity + otherMaintenanceMargin - availableMargin) / (quantity * (1 - PAPER_MAINTENANCE_MARGIN_RATE))
    : (availableMargin + entryPrice * quantity - otherMaintenanceMargin) / (quantity * (1 + PAPER_MAINTENANCE_MARGIN_RATE))
  return Math.max(0, price)
}

function paperPosition({ symbol, marketType, side, quantity, entryPrice, markPrice, leverage = 1, marginType = 'CROSSED', isolatedMargin = 0, positionSide = 'BOTH', liquidationPrice = 0, accountMarginBalance }) {
  const signedDirection = side === 'SHORT' ? -1 : 1
  const unrealizedPnl = (markPrice - entryPrice) * quantity * signedDirection
  const notional = quantity * markPrice
  const initialMargin = notional / leverage
  const maintenanceMargin = marketType === 'futures' ? notional * PAPER_MAINTENANCE_MARGIN_RATE : 0
  const marginBalance = finiteNumber(accountMarginBalance, marginType === 'ISOLATED' ? isolatedMargin + unrealizedPnl : paperAccounts.futures.walletBalance + unrealizedPnl)
  const cost = quantity * entryPrice / leverage
  return {
    symbol,
    asset: symbol.endsWith('USDT') ? symbol.slice(0, -4) : symbol,
    marketType,
    side,
    quantity: String(quantity),
    positionAmt: String(quantity * signedDirection),
    entryPrice: String(entryPrice),
    markPrice: String(markPrice),
    marketValue: String(quantity * markPrice),
    unrealizedPnl: String(unrealizedPnl),
    unrealizedProfit: String(unrealizedPnl),
    returnRate: String(cost > 0 ? unrealizedPnl / cost * 100 : 0),
    returnBasis: marketType === 'futures' ? 'margin' : 'cost',
    leverage: String(leverage),
    ...(marketType === 'futures' ? {
      marginType,
      isolatedMargin: String(isolatedMargin),
      isolatedWallet: String(isolatedMargin),
      positionSide,
      notional: String(notional),
      initialMargin: String(initialMargin),
      maintMargin: String(maintenanceMargin),
      marginBalance: String(marginBalance),
      marginRatio: String(marginBalance > 0 ? maintenanceMargin / marginBalance * 100 : 0),
      liquidationPrice: String(liquidationPrice),
      liquidationPriceEstimated: true,
    } : {}),
  }
}

async function paperTickerMap(marketType, options = {}) {
  let rows = []
  const hasStreamMark = Boolean(options.symbol) && finiteNumber(options.markPrice) > 0
  if (!hasStreamMark) {
    try {
      rows = await getLiveTickers(marketType)
    } catch {
      // Keep the last executable mark when Binance is temporarily unavailable.
    }
  }
  const map = new Map(rows.map((ticker) => [ticker.symbol, finiteNumber(ticker.lastPrice)]))
  if (options.symbol && finiteNumber(options.markPrice) > 0) map.set(options.symbol, finiteNumber(options.markPrice))
  return map
}

async function getPaperSpotSnapshot(options) {
  const account = paperAccounts.spot
  const tickers = await paperTickerMap('spot', options)
  await matchPaperOrders('spot', tickers)
  const portfolio = []
  let holdingsValue = 0
  let unrealizedPnl = 0

  for (const holding of account.holdings.values()) {
    const markPrice = tickers.get(holding.symbol) || holding.markPrice || holding.entryPrice
    holding.markPrice = markPrice
    const position = paperPosition({
      symbol: holding.symbol,
      marketType: 'spot',
      side: 'LONG',
      quantity: holding.quantity,
      entryPrice: holding.entryPrice,
      markPrice,
    })
    portfolio.push(position)
    holdingsValue += finiteNumber(position.marketValue)
    unrealizedPnl += finiteNumber(position.unrealizedPnl)
  }

  const balances = [
    { asset: 'USDT', free: account.usdt.toFixed(8), locked: '0.00000000' },
    ...[...account.holdings.values()].map((holding) => ({ asset: holding.asset, free: holding.quantity.toFixed(8), locked: '0.00000000' })),
  ]
  return {
    source: 'paper',
    environment: 'paper',
    marketType: 'spot',
    totalWalletBalance: account.usdt + holdingsValue,
    availableBalance: account.usdt,
    unrealizedPnl,
    realizedPnl: account.realizedPnl,
    todayPnl: account.realizedPnl + unrealizedPnl,
    balances,
    positions: [],
    portfolio,
    updatedAt: Date.now(),
  }
}

async function getPaperFuturesSnapshot(options) {
  const account = paperAccounts.futures
  const tickers = await paperTickerMap('futures', options)
  await matchPaperOrders('futures', tickers)
  const portfolio = []
  let unrealizedPnl = 0
  let usedMargin = 0

  for (const positionState of account.positions.values()) {
    const markPrice = tickers.get(positionState.symbol) || positionState.markPrice || positionState.entryPrice
    positionState.markPrice = markPrice
    unrealizedPnl += (markPrice - positionState.entryPrice) * Math.abs(positionState.quantity) * (positionState.quantity >= 0 ? 1 : -1)
  }

  const crossMarginBalance = account.walletBalance + unrealizedPnl
  for (const positionState of account.positions.values()) {
    const markPrice = positionState.markPrice || positionState.entryPrice
    const positionUnrealizedPnl = (markPrice - positionState.entryPrice) * Math.abs(positionState.quantity) * (positionState.quantity >= 0 ? 1 : -1)
    const position = paperPosition({
      symbol: positionState.symbol,
      marketType: 'futures',
      side: positionState.quantity >= 0 ? 'LONG' : 'SHORT',
      quantity: Math.abs(positionState.quantity),
      entryPrice: positionState.entryPrice,
      markPrice,
      leverage: positionState.leverage,
      marginType: positionState.marginType,
      isolatedMargin: positionState.isolatedMargin,
      positionSide: positionState.positionSide,
      liquidationPrice: paperFuturesLiquidationPrice(positionState),
      accountMarginBalance: positionState.marginType === 'ISOLATED' ? positionState.isolatedMargin + positionUnrealizedPnl : crossMarginBalance,
    })
    portfolio.push(position)
    usedMargin += paperFuturesPositionMargin(positionState)
  }

  return {
    source: 'paper',
    environment: 'paper',
    marketType: 'futures',
    totalWalletBalance: account.walletBalance + unrealizedPnl,
    availableBalance: Math.max(0, account.walletBalance + unrealizedPnl - usedMargin),
    unrealizedPnl,
    realizedPnl: account.realizedPnl,
    todayPnl: account.realizedPnl + unrealizedPnl,
    balances: [{ asset: 'USDT', walletBalance: String(account.walletBalance), availableBalance: String(Math.max(0, account.walletBalance - usedMargin)) }],
    positions: portfolio,
    portfolio,
    futuresConfig: paperFuturesConfiguration(options.symbol, options.positionSide),
    updatedAt: Date.now(),
  }
}

async function resolvePaperFillPrice(order) {
  const directPrice = finiteNumber(order.marketPrice)
  if (directPrice > 0) return directPrice
  const tickers = await paperTickerMap(order.marketType)
  const price = tickers.get(order.symbol)
  if (!(price > 0)) throw new Error('无法获取模拟成交价，请等待实时行情')
  return price
}

function isPaperOrderMarketable(order, markPrice) {
  if (order.type === 'MARKET') return true
  const limitPrice = finiteNumber(order.price)
  return order.side === 'BUY' ? markPrice <= limitPrice : markPrice >= limitPrice
}

function validatePendingPaperOrder(order) {
  const quantity = finiteNumber(order.quantity)
  if (order.marketType === 'spot') {
    const account = paperAccounts.spot
    if (order.side === 'BUY' && quantity * finiteNumber(order.price) > account.usdt + 1e-8) throw new Error('模拟盘 USDT 可用余额不足')
    if (order.side === 'SELL' && quantity > (account.holdings.get(order.symbol)?.quantity || 0) + 1e-8) throw new Error(`模拟盘 ${order.symbol.slice(0, -4)} 可用余额不足`)
  }
}

async function matchPaperOrders(marketType, tickers) {
  let changed = false
  for (const order of simulationOrders) {
    if (order.environment !== 'paper' || order.marketType !== marketType || order.status !== 'NEW') continue
    const markPrice = tickers.get(order.symbol)
    if (!(markPrice > 0) || !isPaperOrderMarketable(order, markPrice)) continue
    try {
      const fillPrice = finiteNumber(order.price, markPrice)
      const execution = marketType === 'futures'
        ? fillPaperFuturesOrder(order, fillPrice)
        : fillPaperSpotOrder(order, fillPrice)
      order.status = 'FILLED'
      order.executedQty = String(order.quantity)
      order.avgPrice = String(fillPrice)
      order.realizedPnl = String(execution.realizedPnl)
      order.commission = '0'
      order.commissionAsset = 'USDT'
      order.updateTime = Date.now()
    } catch (error) {
      order.status = 'REJECTED'
      order.rejectReason = error instanceof Error ? error.message : '模拟撮合失败'
      order.updateTime = Date.now()
    }
    changed = true
  }
  if (changed) await persistPaperAccounts()
}

function fillPaperSpotOrder(order, fillPrice) {
  const account = paperAccounts.spot
  const quantity = finiteNumber(order.quantity)
  const asset = order.symbol.slice(0, -4)
  const existing = account.holdings.get(order.symbol)

  if (order.side === 'BUY') {
    const cost = quantity * fillPrice
    if (cost > account.usdt + 1e-8) throw new Error('模拟盘 USDT 可用余额不足')
    const currentQuantity = existing?.quantity || 0
    const nextQuantity = currentQuantity + quantity
    const entryPrice = ((existing?.entryPrice || 0) * currentQuantity + fillPrice * quantity) / nextQuantity
    account.usdt -= cost
    account.holdings.set(order.symbol, { symbol: order.symbol, asset, quantity: nextQuantity, entryPrice, markPrice: fillPrice })
    return { realizedPnl: 0 }
  }

  if (!existing || quantity > existing.quantity + 1e-8) throw new Error(`模拟盘 ${asset} 可用余额不足`)
  const realizedPnl = (fillPrice - existing.entryPrice) * quantity
  account.usdt += quantity * fillPrice
  account.realizedPnl += realizedPnl
  const nextQuantity = existing.quantity - quantity
  if (nextQuantity <= 1e-10) account.holdings.delete(order.symbol)
  else account.holdings.set(order.symbol, { ...existing, quantity: nextQuantity, markPrice: fillPrice })
  return { realizedPnl }
}

function paperFuturesOrderContext(order) {
  const positionMode = paperAccounts.futures.positionMode
  const requestedSide = normalizePositionSide(order.positionSide)
  if (positionMode === 'ONE_WAY' && requestedSide !== 'BOTH') throw new Error('单向持仓模式只能使用 BOTH positionSide')
  if (positionMode === 'HEDGE' && !['LONG', 'SHORT'].includes(requestedSide)) throw new Error('双向持仓模式必须明确选择 LONG 或 SHORT')
  if (positionMode === 'HEDGE' && order.reduceOnly) throw new Error('双向持仓模式不支持 reduceOnly，请用相反方向和平仓仓位方向')
  const positionSide = positionMode === 'HEDGE' ? requestedSide : 'BOTH'
  const positionKey = paperFuturesPositionKey(order.symbol, positionSide)
  const existing = paperAccounts.futures.positions.get(positionKey)
  const currentQuantity = existing?.quantity || 0
  const orderQuantity = finiteNumber(order.quantity) * (order.side === 'BUY' ? 1 : -1)

  if (positionMode === 'ONE_WAY' && order.reduceOnly) {
    if (currentQuantity === 0) throw new Error('当前没有可平仓的模拟持仓')
    if (Math.sign(currentQuantity) === Math.sign(orderQuantity)) throw new Error('只减仓订单不能扩大当前持仓')
    if (Math.abs(orderQuantity) > Math.abs(currentQuantity) + 1e-8) throw new Error('只减仓数量不能超过当前持仓')
  }
  if (positionMode === 'HEDGE') {
    const nextQuantity = currentQuantity + orderQuantity
    const closesLong = positionSide === 'LONG' && order.side === 'SELL'
    const closesShort = positionSide === 'SHORT' && order.side === 'BUY'
    if ((closesLong || closesShort) && currentQuantity === 0) throw new Error(`当前没有可平的 ${positionSide} 仓位`)
    if (positionSide === 'LONG' && nextQuantity < -1e-8) throw new Error('平多数量不能超过 LONG 持仓')
    if (positionSide === 'SHORT' && nextQuantity > 1e-8) throw new Error('平空数量不能超过 SHORT 持仓')
  }
  return { existing, currentQuantity, orderQuantity, positionKey, positionMode, positionSide }
}

function fillPaperFuturesOrder(order, fillPrice) {
  const account = paperAccounts.futures
  const { existing, currentQuantity, orderQuantity, positionKey, positionSide } = paperFuturesOrderContext(order)
  const configured = paperFuturesConfiguration(order.symbol)
  const previousWalletBalance = account.walletBalance
  const previousRealizedPnl = account.realizedPnl
  let orderRealizedPnl = 0

  let entryPrice = existing?.entryPrice || fillPrice
  if (currentQuantity === 0 || Math.sign(currentQuantity) === Math.sign(orderQuantity)) {
    const nextAbsoluteQuantity = Math.abs(currentQuantity) + Math.abs(orderQuantity)
    entryPrice = ((entryPrice * Math.abs(currentQuantity)) + (fillPrice * Math.abs(orderQuantity))) / nextAbsoluteQuantity
  } else {
    const closedQuantity = Math.min(Math.abs(currentQuantity), Math.abs(orderQuantity))
    orderRealizedPnl = (fillPrice - entryPrice) * closedQuantity * Math.sign(currentQuantity)
    account.realizedPnl += orderRealizedPnl
    account.walletBalance += orderRealizedPnl
    if (Math.abs(orderQuantity) > Math.abs(currentQuantity)) entryPrice = fillPrice
  }

  const nextQuantity = currentQuantity + orderQuantity
  if (Math.abs(nextQuantity) <= 1e-10) account.positions.delete(positionKey)
  else {
    const leverage = Math.max(1, finiteNumber(existing?.leverage ?? configured.leverage, DEFAULT_FUTURES_LEVERAGE))
    const marginType = (existing?.marginType ?? configured.marginType) === 'ISOLATED' ? 'ISOLATED' : 'CROSSED'
    const previousInitialMargin = Math.abs(currentQuantity) * finiteNumber(existing?.entryPrice, fillPrice) / leverage
    const additionalMargin = Math.max(0, finiteNumber(existing?.isolatedMargin) - previousInitialMargin)
    const isolatedMargin = marginType === 'ISOLATED'
      ? Math.abs(nextQuantity) * entryPrice / leverage + additionalMargin
      : 0
    const nextPosition = { symbol: order.symbol, positionSide, quantity: nextQuantity, entryPrice, markPrice: fillPrice, leverage, marginType, isolatedMargin }
    if (paperFuturesUsedMargin(positionKey) + paperFuturesPositionMargin(nextPosition) > account.walletBalance + 1e-8) {
      account.walletBalance = previousWalletBalance
      account.realizedPnl = previousRealizedPnl
      throw new Error('模拟盘可用保证金不足')
    }
    account.positions.set(positionKey, nextPosition)
  }
  return { realizedPnl: orderRealizedPnl }
}

async function request({ environment, marketType, path, method = 'GET', params = {}, signed = false, credentials: credentialOverride }) {
  const revision = networkRevision
  assertRateLimitAvailable(environment, marketType)
  const credentials = credentialOverride || await loadBinanceCredentials(environment)
  const headers = {}
  if (signed) {
    if (!credentials?.apiKey || !credentials?.apiSecret) throw new Error('尚未配置 Binance API Key')
    if (credentials.environment && credentials.environment !== environment) {
      throw new Error(`当前凭证属于 ${credentials.environment === 'live' ? '生产' : '测试网'}，请重新配置所选环境`)
    }
    headers['X-MBX-APIKEY'] = credentials.apiKey
  }

  let timeOffset = signed ? await synchronizeServerTime(environment, marketType) : 0
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const query = signed
      ? createSignedQuery(params, { timestamp: Date.now() + timeOffset, apiSecret: credentials.apiSecret })
      : new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== '').map(([key, value]) => [key, String(value)]))
    const suffix = query.size ? `?${query.toString()}` : ''
    const response = await binanceRequestFetcher(`${apiBase(environment, marketType)}${path}${suffix}`, { method, headers, signal: AbortSignal.timeout(10_000) })
    const data = await response.json().catch(() => null)
    if (response.ok) return data
    const blockedUntil = revision === networkRevision ? recordRateLimit(environment, marketType, response, data) : null
    if (signed && Number(data?.code) === -1021 && attempt === 0) {
      timeOffset = await synchronizeServerTime(environment, marketType, true)
      continue
    }
    const retryAfter = blockedUntil
      ? Math.max(1, Math.ceil((blockedUntil - Date.now()) / 1000))
      : response.headers.get('retry-after')
    const codeSuffix = data?.code !== undefined ? ` [${data.code}]` : ''
    const retrySuffix = blockedUntil ? `；本地已暂停 REST 请求，${retryAfter} 秒后重试` : ''
    throw new BinanceApiError(`${data?.msg || `Binance request failed (${response.status})`}${codeSuffix}${retrySuffix}`, {
      code: data?.code,
      status: response.status,
      retryAfter: retryAfter ? Number(retryAfter) : undefined,
    })
  }
  throw new Error('Binance 时间同步重试失败')
}

export function resetBinanceNetworkState() {
  networkRevision += 1
  rateLimitStates.clear()
  serverTimeStates.clear()
}

export function setBinanceRequestFetcherForTests(fetcher) {
  if (process.env.ATLAS_QA_CHILD !== '1') throw new Error('Binance test transport is only available in the isolated QA process')
  if (typeof fetcher !== 'function') throw new Error('Binance test transport must be a function')
  binanceRequestFetcher = fetcher
  resetBinanceNetworkState()
  return () => {
    binanceRequestFetcher = fetchWithProxy
    resetBinanceNetworkState()
  }
}

export async function requestBinanceForTests(options) {
  if (process.env.ATLAS_QA_CHILD !== '1') throw new Error('Binance test request is only available in the isolated QA process')
  return request(options)
}

function binancePositionKey(position) {
  return `${position.symbol}:${normalizePositionSide(position.positionSide)}`
}

async function getBinancePositionMode(environment, force = false) {
  const cache = futuresPositionModeCaches[environment]
  if (!force && cache?.expiresAt > Date.now()) return cache.value
  const result = await request({ environment, marketType: 'futures', path: '/fapi/v1/positionSide/dual', signed: true })
  const value = result?.dualSidePosition === true || result?.dualSidePosition === 'true' ? 'HEDGE' : 'ONE_WAY'
  futuresPositionModeCaches[environment] = { expiresAt: Date.now() + 30_000, value }
  return value
}

async function getBinancePositionRisk(environment) {
  try {
    const rows = await request({ environment, marketType: 'futures', path: '/fapi/v3/positionRisk', signed: true })
    return { rows: Array.isArray(rows) ? rows : [], markPrices: new Map(), exact: true }
  } catch {
    const premiumIndex = await request({ environment, marketType: 'futures', path: '/fapi/v1/premiumIndex' }).catch(() => [])
    return {
      rows: [],
      markPrices: new Map((Array.isArray(premiumIndex) ? premiumIndex : []).map((item) => [item.symbol, finiteNumber(item.markPrice)])),
      exact: false,
    }
  }
}

export async function testBinanceConnection(options) {
  const environment = options.environment === 'live' ? 'live' : 'testnet'
  const marketTypes = options.marketTypes?.length ? options.marketTypes : ['spot']
  const startedAt = Date.now()
  const results = []
  const credentials = options.apiKey && options.apiSecret ? { apiKey: options.apiKey, apiSecret: options.apiSecret, environment } : null
  for (const marketType of marketTypes) {
    const path = marketType === 'futures' ? '/fapi/v3/account' : '/api/v3/account'
    const account = await request({ environment, marketType, path, signed: true, credentials })
    results.push({ marketType, canTrade: account.canTrade !== false })
  }
  return { ok: true, environment, latency: Date.now() - startedAt, results }
}

export async function getAccountSnapshot(options) {
  const environment = options.environment === 'live' ? 'live' : 'testnet'
  const marketType = options.marketType === 'futures' ? 'futures' : 'spot'

  if (options.environment === 'paper') {
    await ensurePaperLoaded()
    return marketType === 'futures' ? getPaperFuturesSnapshot(options) : getPaperSpotSnapshot(options)
  }
  const credentials = await loadBinanceCredentials(environment)
  if (!credentials?.apiKey || !credentials?.apiSecret) throw new Error(`请先配置 Binance ${environment === 'live' ? '生产' : '测试网'}凭证`)

  if (marketType === 'futures') {
    const startOfDay = new Date()
    startOfDay.setUTCHours(0, 0, 0, 0)
    const [account, positionRisk, positionMode, income] = await Promise.all([
      request({ environment, marketType, path: '/fapi/v3/account', signed: true }),
      getBinancePositionRisk(environment),
      getBinancePositionMode(environment),
      request({ environment, marketType, path: '/fapi/v1/income', params: { startTime: startOfDay.getTime(), limit: 1000 }, signed: true }).catch(() => []),
    ])
    const incomeRows = Array.isArray(income) ? income : []
    const realizedToday = incomeRows.filter((item) => item.incomeType === 'REALIZED_PNL').reduce((sum, item) => sum + finiteNumber(item.income), 0)
    const commissionToday = incomeRows.filter((item) => item.incomeType === 'COMMISSION').reduce((sum, item) => sum + finiteNumber(item.income), 0)
    const fundingPnlToday = incomeRows.filter((item) => item.incomeType === 'FUNDING_FEE').reduce((sum, item) => sum + finiteNumber(item.income), 0)
    const unrealizedPnl = Number(account.totalUnrealizedProfit)
    const riskByPosition = new Map(positionRisk.rows.map((position) => [binancePositionKey(position), position]))
    const positions = (account.positions || []).map((position) => {
      const risk = riskByPosition.get(binancePositionKey(position))
      return {
        ...position,
        ...(risk || {}),
        markPrice: risk?.markPrice || position.markPrice || positionRisk.markPrices.get(position.symbol) || '0',
        riskDataExact: Boolean(risk),
      }
    })
    const portfolio = positions.filter((position) => Number(position.positionAmt) !== 0).map((position) => {
      const quantity = Math.abs(finiteNumber(position.positionAmt))
      const entryPrice = finiteNumber(position.entryPrice)
      const markPrice = finiteNumber(position.markPrice)
      const leverage = Math.max(1, finiteNumber(position.leverage, 1))
      const positionPnl = finiteNumber(position.unrealizedProfit)
      const initialMargin = finiteNumber(position.positionInitialMargin, quantity * markPrice / leverage)
      const maintenanceMargin = finiteNumber(position.maintMargin)
      const isolatedMargin = finiteNumber(position.isolatedWallet)
      const marginBalance = position.isolated ? isolatedMargin + positionPnl : finiteNumber(account.totalMarginBalance)
      return {
        symbol: position.symbol,
        asset: position.symbol?.endsWith('USDT') ? position.symbol.slice(0, -4) : position.symbol,
        marketType: 'futures',
        side: finiteNumber(position.positionAmt) >= 0 ? 'LONG' : 'SHORT',
        quantity: String(quantity),
        positionAmt: position.positionAmt,
        entryPrice: String(entryPrice),
        markPrice: String(markPrice),
        marketValue: String(quantity * markPrice),
        unrealizedPnl: String(positionPnl),
        unrealizedProfit: String(positionPnl),
        returnRate: String(initialMargin > 0 ? positionPnl / initialMargin * 100 : 0),
        returnBasis: 'margin',
        leverage: String(leverage),
        marginType: position.isolated ? 'ISOLATED' : 'CROSSED',
        isolatedMargin: String(isolatedMargin),
        isolatedWallet: String(isolatedMargin),
        positionSide: normalizePositionSide(position.positionSide),
        notional: String(finiteNumber(position.notional, quantity * markPrice)),
        initialMargin: String(initialMargin),
        maintMargin: String(maintenanceMargin),
        marginBalance: String(marginBalance),
        marginRatio: String(marginBalance > 0 ? maintenanceMargin / marginBalance * 100 : 0),
        liquidationPrice: String(finiteNumber(position.liquidationPrice)),
        liquidationPriceEstimated: !position.riskDataExact,
      }
    })
    const selectedSymbol = normalizeFuturesSymbol(options.symbol)
    const requestedPositionSide = normalizePositionSide(options.positionSide, '')
    const selectedPositions = positions.filter((position) => position.symbol === selectedSymbol)
    const selectedPosition = selectedPositions.find((position) => requestedPositionSide && position.positionSide === requestedPositionSide)
      || selectedPositions.find((position) => Number(position.positionAmt) !== 0)
      || selectedPositions[0]
    return {
      source: 'binance',
      environment,
      marketType,
      totalWalletBalance: finiteNumber(account.totalMarginBalance, finiteNumber(account.totalWalletBalance)),
      availableBalance: Number(account.availableBalance),
      unrealizedPnl,
      realizedPnl: realizedToday,
      commissionToday,
      fundingPnlToday,
      todayPnl: realizedToday + commissionToday + fundingPnlToday + unrealizedPnl,
      balances: account.assets?.filter((asset) => Number(asset.walletBalance) !== 0) || [],
      positions: positions.filter((position) => Number(position.positionAmt) !== 0),
      portfolio,
      futuresConfig: {
        symbol: selectedSymbol,
        leverage: Math.max(1, finiteNumber(selectedPosition?.leverage, DEFAULT_FUTURES_LEVERAGE)),
        marginType: selectedPosition?.isolated ? 'ISOLATED' : 'CROSSED',
        isolatedMargin: Math.max(0, finiteNumber(selectedPosition?.isolatedWallet)),
        positionAmt: finiteNumber(selectedPosition?.positionAmt),
        positionMode,
        positionSide: normalizePositionSide(selectedPosition?.positionSide, positionMode === 'HEDGE' ? 'LONG' : 'BOTH'),
      },
      updatedAt: Date.now(),
    }
  }

  const account = await request({ environment, marketType, path: '/api/v3/account', signed: true })
  const tickers = await getLiveTickers('spot')
  return buildBinanceSpotSnapshot({ account, tickers, environment })
}

export function buildBinanceSpotSnapshot({ account, tickers, environment = 'live', now = Date.now() }) {
  const balances = (account.balances || []).filter((balance) => Number(balance.free) !== 0 || Number(balance.locked) !== 0)
  const tickerBySymbol = new Map(tickers.map((ticker) => [ticker.symbol, ticker]))
  let totalWalletBalance = 0
  let todayPnl = 0
  const portfolio = []
  for (const balance of balances) {
    const quantity = Number(balance.free) + Number(balance.locked)
    if (['USDT', 'USDC', 'FDUSD', 'TUSD'].includes(balance.asset)) {
      totalWalletBalance += quantity
      continue
    }
    const ticker = tickerBySymbol.get(`${balance.asset}USDT`)
    if (!ticker) continue
    const value = quantity * Number(ticker.lastPrice)
    const changePercent = Number(ticker.priceChangePercent)
    totalWalletBalance += value
    if (Number.isFinite(changePercent) && changePercent > -100) todayPnl += value - value / (1 + changePercent / 100)
    portfolio.push({
      symbol: `${balance.asset}USDT`,
      asset: balance.asset,
      marketType: 'spot',
      side: 'LONG',
      quantity: String(quantity),
      availableQuantity: String(Number(balance.free) || 0),
      lockedQuantity: String(Number(balance.locked) || 0),
      entryPrice: '',
      markPrice: ticker.lastPrice,
      marketValue: String(value),
      unrealizedPnl: '',
      unrealizedProfit: '',
      returnRate: String(changePercent),
      returnBasis: '24h',
      leverage: '1',
    })
  }
  return {
    source: 'binance',
    environment,
    marketType: 'spot',
    balances,
    positions: [],
    portfolio,
    totalWalletBalance,
    availableBalance: Number(account.balances.find((balance) => balance.asset === 'USDT')?.free || 0),
    unrealizedPnl: 0,
    todayPnl,
    updatedAt: now,
  }
}

function futuresContext(options) {
  const symbol = normalizeFuturesSymbol(options.symbol)
  const environment = options.environment === 'live' ? 'live' : options.environment === 'paper' ? 'paper' : 'testnet'
  return { symbol, environment }
}

function assertFuturesAccountMutation(options) {
  const context = futuresContext(options)
  const { environment } = context
  if (environment === 'live' && options.confirmation !== 'LIVE_ACCOUNT_CONFIRMED') {
    throw new Error('生产合约账户调整缺少二次确认')
  }
  return context
}

export async function getFuturesConfiguration(options) {
  const { symbol, environment } = futuresContext(options)
  if (environment === 'paper') {
    await ensurePaperLoaded()
    return { ...paperFuturesConfiguration(symbol, options.positionSide), source: 'paper', environment }
  }
  const [account, positionMode] = await Promise.all([
    request({ environment, marketType: 'futures', path: '/fapi/v3/account', signed: true }),
    getBinancePositionMode(environment),
  ])
  const requestedPositionSide = normalizePositionSide(options.positionSide, '')
  const symbolPositions = (account.positions || []).filter((item) => item.symbol === symbol)
  const position = symbolPositions.find((item) => requestedPositionSide && item.positionSide === requestedPositionSide)
    || symbolPositions.find((item) => Number(item.positionAmt) !== 0)
    || symbolPositions[0]
  return {
    symbol,
    leverage: Math.max(1, finiteNumber(position?.leverage, DEFAULT_FUTURES_LEVERAGE)),
    marginType: position?.isolated ? 'ISOLATED' : 'CROSSED',
    isolatedMargin: Math.max(0, finiteNumber(position?.isolatedWallet)),
    positionAmt: finiteNumber(position?.positionAmt),
    positionMode,
    positionSide: normalizePositionSide(position?.positionSide, positionMode === 'HEDGE' ? 'LONG' : 'BOTH'),
    source: 'binance',
    environment,
  }
}

export async function getFuturesPositionMode(options) {
  const { environment } = futuresContext(options)
  if (environment === 'paper') {
    await ensurePaperLoaded()
    return { positionMode: paperAccounts.futures.positionMode, source: 'paper', environment }
  }
  return { positionMode: await getBinancePositionMode(environment), source: 'binance', environment }
}

export async function setFuturesPositionMode(options) {
  const { environment } = assertFuturesAccountMutation(options)
  const positionMode = normalizePositionMode(options.positionMode)
  if (environment === 'paper') {
    await ensurePaperLoaded()
    if (paperAccounts.futures.positionMode === positionMode) return { positionMode, source: 'paper', environment }
    if (paperAccounts.futures.positions.size > 0) throw new Error('切换持仓模式前必须先平掉所有模拟合约持仓')
    if (simulationOrders.some((order) => order.environment === 'paper' && order.marketType === 'futures' && order.status === 'NEW')) {
      throw new Error('切换持仓模式前必须先撤销所有模拟合约挂单')
    }
    paperAccounts.futures.positionMode = positionMode
    await persistPaperAccounts()
    return { positionMode, source: 'paper', environment }
  }

  try {
    await request({
      environment,
      marketType: 'futures',
      path: '/fapi/v1/positionSide/dual',
      method: 'POST',
      params: { dualSidePosition: positionMode === 'HEDGE' ? 'true' : 'false' },
      signed: true,
    })
  } catch (error) {
    if (Number(error?.code) !== -4059 && !String(error?.message || '').toLowerCase().includes('no need to change position side')) throw error
  }
  futuresPositionModeCaches[environment] = { expiresAt: Date.now() + 30_000, value: positionMode }
  return { positionMode, source: 'binance', environment }
}

export async function setFuturesLeverage(options) {
  const { symbol, environment } = assertFuturesAccountMutation(options)
  const leverage = Math.round(finiteNumber(options.leverage))
  if (leverage < 1 || leverage > 125) throw new Error('杠杆必须在 1x 到 125x 之间')

  if (environment === 'paper') {
    await ensurePaperLoaded()
    const current = paperFuturesConfiguration(symbol, options.positionSide)
    const positions = paperFuturesPositionsForSymbol(symbol)
    const previousPositions = positions.map((position) => ({ position, leverage: position.leverage, isolatedMargin: position.isolatedMargin }))
    paperAccounts.futures.configurations.set(symbol, { symbol, leverage, marginType: current.marginType })
    for (const position of positions) {
      const previousInitialMargin = Math.abs(position.quantity) * position.entryPrice / position.leverage
      const additionalMargin = Math.max(0, finiteNumber(position.isolatedMargin) - previousInitialMargin)
      position.leverage = leverage
      if (position.marginType === 'ISOLATED') position.isolatedMargin = Math.abs(position.quantity) * position.entryPrice / leverage + additionalMargin
    }
    if (paperFuturesUsedMargin() > paperAccounts.futures.walletBalance + 1e-8) {
      previousPositions.forEach((previous) => Object.assign(previous.position, { leverage: previous.leverage, isolatedMargin: previous.isolatedMargin }))
      paperAccounts.futures.configurations.set(symbol, { symbol, leverage: current.leverage, marginType: current.marginType })
      throw new Error('降低杠杆后所需保证金超过模拟盘可用余额')
    }
    await persistPaperAccounts()
    return { ...paperFuturesConfiguration(symbol, options.positionSide), source: 'paper', environment }
  }

  const result = await request({ environment, marketType: 'futures', path: '/fapi/v1/leverage', method: 'POST', params: { symbol, leverage }, signed: true })
  const configuration = await getFuturesConfiguration(options)
  return { ...configuration, leverage: finiteNumber(result.leverage, leverage) }
}

export async function setFuturesMarginType(options) {
  const { symbol, environment } = assertFuturesAccountMutation(options)
  const marginType = options.marginType === 'ISOLATED' ? 'ISOLATED' : options.marginType === 'CROSSED' ? 'CROSSED' : null
  if (!marginType) throw new Error('保证金模式必须是逐仓或全仓')

  if (environment === 'paper') {
    await ensurePaperLoaded()
    const current = paperFuturesConfiguration(symbol, options.positionSide)
    if (current.marginType === marginType) return { ...current, source: 'paper', environment }
    if (paperFuturesPositionsForSymbol(symbol).length > 0) throw new Error('切换保证金模式前必须先平掉该交易对的模拟持仓')
    if (simulationOrders.some((order) => order.environment === 'paper' && order.marketType === 'futures' && order.symbol === symbol && order.status === 'NEW')) {
      throw new Error('切换保证金模式前必须先撤销该交易对的模拟挂单')
    }
    paperAccounts.futures.configurations.set(symbol, { symbol, leverage: current.leverage, marginType })
    await persistPaperAccounts()
    return { ...paperFuturesConfiguration(symbol, options.positionSide), source: 'paper', environment }
  }

  try {
    await request({ environment, marketType: 'futures', path: '/fapi/v1/marginType', method: 'POST', params: { symbol, marginType }, signed: true })
  } catch (error) {
    if (Number(error?.code) !== -4046 && !String(error?.message || '').toLowerCase().includes('no need to change margin type')) throw error
  }
  return { ...(await getFuturesConfiguration(options)), marginType }
}

export async function adjustFuturesPositionMargin(options) {
  const { symbol, environment } = assertFuturesAccountMutation(options)
  const amount = finiteNumber(options.amount)
  const action = options.action === 'REMOVE' ? 'REMOVE' : options.action === 'ADD' ? 'ADD' : null
  if (!(amount > 0)) throw new Error('保证金调整金额必须大于 0')
  if (!action) throw new Error('保证金调整方向无效')

  if (environment === 'paper') {
    await ensurePaperLoaded()
    const position = paperFuturesPositionFor(symbol, options.positionSide)
    if (!position) throw new Error('当前交易对没有可调整的模拟持仓')
    if (position.marginType !== 'ISOLATED') throw new Error('只有逐仓持仓可以增减保证金')
    const minimumMargin = Math.abs(position.quantity) * finiteNumber(position.markPrice, position.entryPrice) / position.leverage
    const currentMargin = Math.max(minimumMargin, finiteNumber(position.isolatedMargin))
    const nextMargin = action === 'ADD' ? currentMargin + amount : currentMargin - amount
    if (nextMargin + 1e-8 < minimumMargin) throw new Error(`最多可减少 ${(currentMargin - minimumMargin).toFixed(2)} USDT`)
    const positionKey = paperFuturesPositionKey(symbol, position.positionSide)
    const otherUsedMargin = paperFuturesUsedMargin(positionKey)
    if (action === 'ADD' && otherUsedMargin + nextMargin > paperAccounts.futures.walletBalance + 1e-8) throw new Error('模拟盘可用保证金不足')
    position.isolatedMargin = nextMargin
    await persistPaperAccounts()
    return { ...paperFuturesConfiguration(symbol, position.positionSide), amount, action, source: 'paper', environment }
  }

  const positionMode = await getBinancePositionMode(environment)
  const positionSide = normalizePositionSide(options.positionSide)
  if (positionMode === 'HEDGE' && !['LONG', 'SHORT'].includes(positionSide)) throw new Error('双向持仓模式调整保证金时必须选择 LONG 或 SHORT')
  if (positionMode === 'ONE_WAY' && positionSide !== 'BOTH') throw new Error('单向持仓模式调整保证金只能使用 BOTH')
  const result = await request({
    environment,
    marketType: 'futures',
    path: '/fapi/v1/positionMargin',
    method: 'POST',
    params: { symbol, amount, type: action === 'ADD' ? 1 : 2, positionSide: positionMode === 'HEDGE' ? positionSide : undefined },
    signed: true,
  })
  const configuration = await getFuturesConfiguration({ ...options, positionSide })
  return { ...configuration, amount, action, code: result.code, message: result.msg }
}

export function aggregateOrderTrades(trades) {
  const aggregates = new Map()
  for (const trade of Array.isArray(trades) ? trades : []) {
    const orderId = String(trade.orderId ?? '')
    if (!orderId) continue
    const current = aggregates.get(orderId) || { executedQty: 0, quoteQty: 0, realizedPnl: 0, commissions: new Map(), trades: 0 }
    const quantity = finiteNumber(trade.qty)
    current.executedQty += quantity
    current.quoteQty += finiteNumber(trade.quoteQty, finiteNumber(trade.price) * quantity)
    current.realizedPnl += finiteNumber(trade.realizedPnl)
    const commissionAsset = String(trade.commissionAsset || '').trim()
    if (commissionAsset) current.commissions.set(commissionAsset, (current.commissions.get(commissionAsset) || 0) + finiteNumber(trade.commission))
    current.trades += 1
    aggregates.set(orderId, current)
  }
  return aggregates
}

function enrichBinanceOrder(order, aggregate, environment, marketType) {
  const executedQty = finiteNumber(order.executedQty, aggregate?.executedQty)
  const quoteQty = finiteNumber(order.cumQuote ?? order.cummulativeQuoteQty, aggregate?.quoteQty)
  const commissionDetails = aggregate
    ? [...aggregate.commissions.entries()].map(([asset, amount]) => ({ asset, amount: String(amount) }))
    : []
  const singleCommission = commissionDetails.length === 1 ? commissionDetails[0] : null
  const exchangeAverage = finiteNumber(order.avgPrice)
  const avgPrice = exchangeAverage > 0
    ? String(exchangeAverage)
    : executedQty > 0 && quoteQty > 0
      ? String(quoteQty / executedQty)
      : '0'
  return {
    ...order,
    environment,
    marketType,
    quantity: order.origQty,
    executedQty: String(order.executedQty ?? aggregate?.executedQty ?? '0'),
    avgPrice,
    transactTime: order.time || order.updateTime,
    ...(aggregate ? {
      commission: singleCommission?.amount,
      commissionAsset: singleCommission?.asset,
      commissionDetails,
      ...(marketType === 'futures' ? { realizedPnl: String(aggregate.realizedPnl) } : {}),
    } : {}),
  }
}

export async function getOrders(options) {
  const environment = options.environment === 'live' ? 'live' : 'testnet'
  const marketType = options.marketType === 'futures' ? 'futures' : 'spot'
  if (options.environment === 'paper') {
    await ensurePaperLoaded()
    return simulationOrders.filter((order) => order.marketType === marketType && (!options.symbol || order.symbol === options.symbol)).slice(0, 100)
  }
  const symbol = normalizeFuturesSymbol(options.symbol || 'BTCUSDT')
  const path = marketType === 'futures' ? '/fapi/v1/allOrders' : '/api/v3/allOrders'
  const tradesPath = marketType === 'futures' ? '/fapi/v1/userTrades' : '/api/v3/myTrades'
  const [rows, trades] = await Promise.all([
    request({ environment, marketType, path, params: { symbol, limit: 100 }, signed: true }),
    request({ environment, marketType, path: tradesPath, params: { symbol, limit: 1000 }, signed: true }).catch(() => null),
  ])
  const aggregates = aggregateOrderTrades(trades)
  return rows.map((order) => enrichBinanceOrder(order, aggregates.get(String(order.orderId)), environment, marketType))
}

function orderIdentifierParams(options) {
  const symbol = normalizeFuturesSymbol(options.symbol)
  const orderId = String(options.orderId ?? '').trim()
  const clientOrderId = String(options.clientOrderId || '').trim()
  if (!orderId && !clientOrderId) throw new Error('查询订单必须提供 orderId 或 clientOrderId')
  if (orderId && !/^\d+$/.test(orderId)) throw new Error('Invalid order id')
  if (clientOrderId && !/^[A-Za-z0-9_-]{1,36}$/.test(clientOrderId)) throw new Error('Invalid client order id')
  return { symbol, orderId: orderId || undefined, origClientOrderId: clientOrderId || undefined }
}

export async function getOpenOrders(options) {
  const marketType = options.marketType === 'futures' ? 'futures' : 'spot'
  if (options.environment === 'paper') {
    await ensurePaperLoaded()
    return simulationOrders.filter((order) => order.marketType === marketType && order.status === 'NEW' && (!options.symbol || order.symbol === options.symbol))
  }
  const environment = options.environment === 'live' ? 'live' : 'testnet'
  const symbol = normalizeFuturesSymbol(options.symbol || 'BTCUSDT')
  const path = marketType === 'futures' ? '/fapi/v1/openOrders' : '/api/v3/openOrders'
  const rows = await request({ environment, marketType, path, params: { symbol }, signed: true })
  return rows.map((order) => enrichBinanceOrder(order, null, environment, marketType))
}

export async function getOrder(options) {
  const marketType = options.marketType === 'futures' ? 'futures' : 'spot'
  const params = orderIdentifierParams(options)
  if (options.environment === 'paper') {
    await ensurePaperLoaded()
    const order = simulationOrders.find((item) => item.marketType === marketType && item.symbol === params.symbol && (
      (params.orderId && String(item.orderId) === params.orderId) || (params.origClientOrderId && item.clientOrderId === params.origClientOrderId)
    ))
    if (!order) throw new Error('未找到模拟订单')
    return order
  }
  const environment = options.environment === 'live' ? 'live' : 'testnet'
  const path = marketType === 'futures' ? '/fapi/v1/order' : '/api/v3/order'
  const order = await request({ environment, marketType, path, params, signed: true })
  return enrichBinanceOrder(order, null, environment, marketType)
}

export async function cancelOrder(options) {
  const marketType = options.marketType === 'futures' ? 'futures' : 'spot'
  const params = orderIdentifierParams(options)
  if (options.environment === 'paper') {
    await ensurePaperLoaded()
    const order = simulationOrders.find((item) => item.marketType === marketType && item.symbol === params.symbol && (
      (params.orderId && String(item.orderId) === params.orderId) || (params.origClientOrderId && item.clientOrderId === params.origClientOrderId)
    ))
    if (!order) throw new Error('未找到模拟订单')
    if (order.status !== 'NEW') throw new Error('只有未成交挂单可以撤销')
    order.status = 'CANCELED'
    order.updateTime = Date.now()
    await persistPaperAccounts()
    return order
  }
  const environment = options.environment === 'live' ? 'live' : 'testnet'
  if (environment === 'live' && options.confirmation !== 'LIVE_CANCEL_CONFIRMED') throw new Error('生产撤单缺少二次确认')
  const path = marketType === 'futures' ? '/fapi/v1/order' : '/api/v3/order'
  const order = await request({ environment, marketType, path, method: 'DELETE', params, signed: true })
  return enrichBinanceOrder(order, null, environment, marketType)
}

export async function prepareBinanceOrder(order) {
  assertOrder(order)
  if (order.environment === 'paper') return { ...order }
  const environment = order.environment === 'live' ? 'live' : 'testnet'
  const marketType = order.marketType === 'futures' ? 'futures' : 'spot'
  const rules = await exchangeInfoCatalog.symbolRules({
    baseUrl: apiBase(environment, marketType),
    marketType,
    symbol: order.symbol,
  })
  const notionalLimits = activeNotionalLimits(order, rules)
  const needsMarketPrice = order.type === 'MARKET' && (notionalLimits.minimum || notionalLimits.maximum) && !(Number(order.marketPrice) > 0)
  const marketPrice = needsMarketPrice
    ? await getOrderValidationPrice(environment, marketType, order.symbol)
    : order.marketPrice
  return normalizeBinanceOrder({ ...order, marketPrice }, rules)
}

export async function placeOrder(order) {
  assertOrder(order)
  if (order.environment === 'paper') {
    await ensurePaperLoaded()
    if (order.clientOrderId && simulationOrdersByClientId.has(order.clientOrderId)) return simulationOrdersByClientId.get(order.clientOrderId)
    if (order.marketType === 'futures') paperFuturesOrderContext(order)
    const fillPrice = await resolvePaperFillPrice(order)
    const marketable = isPaperOrderMarketable(order, fillPrice)
    let execution = { realizedPnl: 0 }
    if (marketable) {
      execution = order.marketType === 'futures'
        ? fillPaperFuturesOrder(order, fillPrice)
        : fillPaperSpotOrder(order, fillPrice)
    } else {
      validatePendingPaperOrder(order)
    }
    const created = {
      ...order,
      id: randomUUID(),
      orderId: Date.now(),
      status: marketable ? 'FILLED' : 'NEW',
      executedQty: marketable ? String(order.quantity) : '0',
      price: order.type === 'LIMIT' ? String(order.price) : String(fillPrice),
      avgPrice: marketable ? String(fillPrice) : '0',
      realizedPnl: marketable ? String(execution.realizedPnl) : undefined,
      commission: marketable ? '0' : undefined,
      commissionAsset: marketable ? 'USDT' : undefined,
      transactTime: Date.now(),
    }
    simulationOrders.unshift(created)
    if (order.clientOrderId) simulationOrdersByClientId.set(order.clientOrderId, created)
    await persistPaperAccounts()
    return created
  }

  const environment = order.environment === 'live' ? 'live' : 'testnet'
  if (environment === 'live' && order.confirmation !== 'LIVE_ORDER_CONFIRMED') {
    throw new Error('生产订单缺少二次确认')
  }
  const preparedOrder = await prepareBinanceOrder(order)
  const marketType = preparedOrder.marketType === 'futures' ? 'futures' : 'spot'
  let positionMode
  let positionSide
  if (marketType === 'futures') {
    positionMode = await getBinancePositionMode(environment)
    positionSide = normalizePositionSide(preparedOrder.positionSide)
    if (positionMode === 'HEDGE' && !['LONG', 'SHORT'].includes(positionSide)) throw new Error('双向持仓模式下单时必须选择 LONG 或 SHORT')
    if (positionMode === 'HEDGE' && preparedOrder.reduceOnly) throw new Error('双向持仓模式不能发送 reduceOnly，请用 positionSide 和相反方向平仓')
    if (positionMode === 'ONE_WAY' && positionSide !== 'BOTH') throw new Error('单向持仓模式只能使用 BOTH positionSide')
  }
  const path = marketType === 'futures' ? '/fapi/v1/order' : '/api/v3/order'
  const clientOrderId = preparedOrder.clientOrderId || `atlas_${randomUUID().replaceAll('-', '').slice(0, 26)}`
  const params = {
    symbol: preparedOrder.symbol,
    side: preparedOrder.side,
    type: preparedOrder.type,
    quantity: preparedOrder.quantity,
    price: preparedOrder.type === 'LIMIT' ? preparedOrder.price : undefined,
    timeInForce: preparedOrder.type === 'LIMIT' ? 'GTC' : undefined,
    positionSide: marketType === 'futures' && positionMode === 'HEDGE' ? positionSide : undefined,
    reduceOnly: marketType === 'futures' && preparedOrder.reduceOnly ? 'true' : undefined,
    newClientOrderId: clientOrderId,
    newOrderRespType: marketType === 'futures' ? 'RESULT' : 'FULL',
  }
  const pendingKey = `${environment}:${marketType}:${clientOrderId}`
  if (pendingLiveOrders.has(pendingKey)) return pendingLiveOrders.get(pendingKey)
  const submission = request({ environment, marketType, path, method: 'POST', params, signed: true })
    .catch(async (error) => {
      const ambiguous = !(error instanceof BinanceApiError)
        || Number(error.status) >= 500
        || Number(error.code) === -1007
        || (Number(error.code) === -2010 && /duplicate/i.test(String(error.message)))
      if (!ambiguous) throw error
      try {
        return await request({
          environment,
          marketType,
          path,
          params: { symbol: preparedOrder.symbol, origClientOrderId: clientOrderId },
          signed: true,
        })
      } catch {
        throw error
      }
    })
    .finally(() => pendingLiveOrders.delete(pendingKey))
  pendingLiveOrders.set(pendingKey, submission)
  return submission
}
