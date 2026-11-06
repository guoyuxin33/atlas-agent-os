import { HttpsProxyAgent } from 'https-proxy-agent'
import { fetch as undiciFetch, ProxyAgent } from 'undici'

const dispatchers = new Map()
const socketAgents = new Map()

function validateProxyUrl(value) {
  if (!value) return null
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('代理地址必须使用 HTTP 或 HTTPS')
  return url.toString()
}

function isLocalUrl(value) {
  const hostname = new URL(value).hostname
  return ['127.0.0.1', 'localhost', '::1'].includes(hostname)
}

function connectionErrorMessage(target, error) {
  const reason = error?.cause?.code || error?.code
  const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError'
  if (timeout) return `请求 ${target.host} 超时`
  if (isLocalUrl(target) && reason === 'ECONNREFUSED') {
    return `本地服务 ${target.host} 未启动或未监听该端口 (ECONNREFUSED)`
  }
  return `无法连接 ${target.host}${reason ? ` (${reason})` : ''}`
}

export async function getProxyUrl() {
  const environmentProxy = process.env.ATLAS_PROXY_URL || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || ''
  if (environmentProxy) return validateProxyUrl(environmentProxy)
  const { loadVault } = await import('./vault.mjs')
  const config = await loadVault('network')
  return validateProxyUrl(config?.proxyUrl || '')
}

function getDispatcher(proxyUrl) {
  if (!dispatchers.has(proxyUrl)) dispatchers.set(proxyUrl, new ProxyAgent(proxyUrl))
  return dispatchers.get(proxyUrl)
}

export async function fetchWithProxy(url, options = {}) {
  try {
    const proxyUrl = isLocalUrl(url) ? null : await getProxyUrl()
    const signal = options.signal || AbortSignal.timeout(15_000)
    return await undiciFetch(url, { ...options, signal, ...(proxyUrl ? { dispatcher: getDispatcher(proxyUrl) } : {}) })
  } catch (error) {
    const target = new URL(url)
    throw new Error(connectionErrorMessage(target, error))
  }
}

export async function webSocketOptions(url) {
  const proxyUrl = isLocalUrl(url) ? null : await getProxyUrl()
  if (!proxyUrl) return {}
  if (!socketAgents.has(proxyUrl)) socketAgents.set(proxyUrl, new HttpsProxyAgent(proxyUrl))
  return { agent: socketAgents.get(proxyUrl) }
}

export async function testNetwork(options = {}) {
  const proxyUrl = validateProxyUrl(options.proxyUrl || '')
  const startedAt = Date.now()
  const response = await undiciFetch('https://api.binance.com/api/v3/ping', {
    ...(proxyUrl ? { dispatcher: getDispatcher(proxyUrl) } : {}),
    signal: AbortSignal.timeout(8000),
  })
  if (!response.ok) throw new Error(`网络测试失败 (${response.status})`)
  return { ok: true, latency: Date.now() - startedAt, proxy: Boolean(proxyUrl) }
}
