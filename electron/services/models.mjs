import { createHash } from 'node:crypto'
import { fetchWithProxy } from './network.mjs'

const modelCache = new Map()
const CACHE_TTL = 5 * 60 * 1000

function modelDirectoryError(config, error) {
  const message = error instanceof Error ? error.message : '模型目录请求失败'
  if (/本地服务 .*未启动|ECONNREFUSED/i.test(message)) {
    const target = new URL(config.baseUrl).host
    if (config.provider === 'ccswitch') {
      return new Error(`CCSwitch 本地代理未监听 ${target}。请先在 CC Switch 中启用本地代理，确认端口后再测试。`)
    }
    return new Error(`本地模型服务未监听 ${target}。请启动服务或修改 Base URL 后再测试。`)
  }
  return error instanceof Error ? error : new Error(message)
}

function normalizedBaseUrl(value) {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('模型地址必须使用 HTTP 或 HTTPS')
  return url.toString().replace(/\/$/, '')
}

function endpointFor(config) {
  const baseUrl = normalizedBaseUrl(config.baseUrl)
  if (config.protocol === 'google') {
    const url = new URL(`${baseUrl}/models`)
    if (config.apiKey) url.searchParams.set('key', config.apiKey)
    return url
  }
  return new URL(`${baseUrl}/models`)
}

function headersFor(config) {
  if (config.protocol === 'anthropic') {
    return {
      'anthropic-version': '2023-06-01',
      ...(config.apiKey ? { 'x-api-key': config.apiKey } : {}),
    }
  }
  return config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}
}

function parseModels(config, data) {
  const rows = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : []
  return rows
    .filter((item) => {
      if (config.protocol !== 'google') return true
      return !item.supportedGenerationMethods || item.supportedGenerationMethods.includes('generateContent')
    })
    .map((item) => {
      const id = String(item.id || item.name || '').replace(/^models\//, '')
      return {
        id,
        name: item.displayName || item.name || item.id || id,
        ownedBy: item.owned_by || item.ownedBy || config.provider || '',
      }
    })
    .filter((item) => item.id)
    .sort((left, right) => left.id.localeCompare(right.id, 'en'))
}

export async function listModels(config, options = {}) {
  if (!config?.baseUrl) throw new Error('请先选择模型厂商并填写 Base URL')
  const endpoint = endpointFor(config)
  const cacheKey = createHash('sha256')
    .update(`${config.provider || 'custom'}:${config.protocol || 'openai'}:${endpoint.origin}${endpoint.pathname}:${config.apiKey || ''}:${(config.fallbackModels || []).join(',')}`)
    .digest('hex')
  const cached = modelCache.get(cacheKey)
  if (!options.force && cached?.expiresAt > Date.now()) return { ...cached.value, cached: true }

  const startedAt = Date.now()
  let response
  try {
    response = await fetchWithProxy(endpoint, {
      headers: headersFor(config),
      signal: AbortSignal.timeout(12_000),
    })
  } catch (error) {
    throw modelDirectoryError(config, error)
  }
  const data = await response.json().catch(() => null)
  if (!response.ok) {
    const message = data?.error?.message || data?.message || `模型目录请求失败 (${response.status})`
    throw new Error(message)
  }
  const models = parseModels(config, data)
  const fallbackModels = config.provider === 'ccswitch'
    ? (config.fallbackModels || []).map((id) => ({ id, name: id, ownedBy: 'ccswitch' }))
    : []
  const availableModels = models.length ? models : fallbackModels
  if (!availableModels.length) throw new Error('接口连接成功，但没有返回可用模型')
  const value = { models: availableModels, latency: Date.now() - startedAt, source: models.length ? 'remote' : 'preset' }
  modelCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL, value })
  return { ...value, cached: false }
}
