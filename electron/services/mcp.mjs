import { fetchWithProxy } from './network.mjs'

const sessions = new Map()

function parseResponse(contentType, text) {
  if (contentType.includes('text/event-stream')) {
    const dataLine = text.split('\n').find((line) => line.startsWith('data:'))
    if (!dataLine) throw new Error('MCP 服务未返回有效 SSE 数据')
    return JSON.parse(dataLine.slice(5).trim())
  }
  return JSON.parse(text)
}

function boundedTimeout(value, fallback = 15_000) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(60_000, Math.max(500, Math.round(parsed)))
}

async function rpc(url, method, params = {}, headers = {}, timeoutMs) {
  const endpoint = new URL(url)
  if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('MCP 地址必须使用 HTTP 或 HTTPS')
  const session = sessions.get(url)
  const response = await fetchWithProxy(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(session ? { 'Mcp-Session-Id': session } : {}),
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
    signal: AbortSignal.timeout(boundedTimeout(timeoutMs)),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`MCP 请求失败 (${response.status})`)
  const sessionId = response.headers.get('mcp-session-id')
  if (sessionId) sessions.set(url, sessionId)
  const result = parseResponse(response.headers.get('content-type') || '', text)
  if (result.error) throw new Error(result.error.message || 'MCP RPC error')
  return result.result
}

export async function connectMcp(options) {
  const serverInfo = await rpc(options.url, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'Atlas Agent OS', version: '0.2.0' },
  }, options.headers, options.timeoutMs)
  const tools = await rpc(options.url, 'tools/list', {}, options.headers, options.timeoutMs)
  return { ok: true, serverInfo, tools: tools.tools || [], sessionId: sessions.get(options.url) || null }
}

export async function callMcpTool(options) {
  return rpc(options.url, 'tools/call', { name: options.name, arguments: options.arguments || {} }, options.headers, options.timeoutMs)
}
