import { loadVault } from './vault.mjs'
import { fetchWithProxy } from './network.mjs'
import { callMcpTool, connectMcp } from './mcp.mjs'

const DEFAULT_MODEL_TIMEOUT = 60_000
const DEFAULT_SUPERVISION_TIMEOUT = 12_000
const AGENT_SKILLS = Object.freeze({
  'market-analysis': Object.freeze({
    version: '1.0.0',
    instructions: '只使用提供的已闭合 K 线和已授权市场工具评估趋势、波动率、成交量与关键价位。不得把未闭合走势、缺失数据或单一指标当作确定事实；证据不足时拒绝候选。',
  }),
  'risk-review': Object.freeze({
    version: '1.0.0',
    instructions: '核对候选方向与策略信号是否一致，并评估账户可用余额、现有持仓、名义价值、波动和流动性风险。不得重新计算、修改或建议修改候选订单字段；发现冲突或数据不足时拒绝。',
  }),
  'news-research': Object.freeze({
    version: '1.0.0',
    instructions: '只有通过已授权 MCP 工具取得带来源和时间戳的事件信息时，才能把新闻作为辅助证据。不得编造新闻，不得把情绪当作事实；来源不可用、时间过旧或互相矛盾时拒绝依赖新闻的候选。',
  }),
  'strategy-builder': Object.freeze({
    version: '1.0.0',
    instructions: '审查确定性策略名称、参数、信号理由与候选订单是否逻辑一致。不得创建新策略、改变规则或替换候选订单；发现规则与信号不一致时拒绝。',
  }),
})

function boundedTimeout(value, fallback = DEFAULT_MODEL_TIMEOUT) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(60_000, Math.max(1_000, Math.round(parsed)))
}

export function resolveAgentSkills(skillIds = []) {
  return [...new Set(Array.isArray(skillIds) ? skillIds : [])].map((id) => {
    const skill = AGENT_SKILLS[id]
    if (!skill) throw new Error(`Agent 请求了未知 Skill：${id}`)
    return { id, version: skill.version, instructions: skill.instructions }
  })
}

export function buildAgentSupervisorSystem(skillIds = []) {
  const skills = resolveAgentSkills(skillIds)
  return [
    '你是 Atlas Agent OS 的交易候选监督器。你只能批准或拒绝已经由确定性策略生成的候选订单。',
    '你绝对不能修改或建议修改 side、quantity、price、symbol、environment、marketType、positionSide、reduceOnly 或任何订单字段，也不能提交订单。',
    '硬风控在你批准后仍会再次执行；你的批准不代表订单一定成交。任何数据不足、工具失败或不确定性都必须选择 REJECT。',
    ...skills.map((skill) => `[受信任 Skill ${skill.id}@${skill.version}]\n${skill.instructions}`),
    '只返回一个 JSON 对象，且只能包含 decision、confidence、reason 三个字段。decision 只能是 APPROVE 或 REJECT，confidence 必须是 0 到 1 的数字。不要输出 Markdown 或额外文字。',
  ].join('\n')
}

export function authorizeAgentMcpTools(discoveredServers = [], requestedToolNames = []) {
  const requestedTools = [...new Set((Array.isArray(requestedToolNames) ? requestedToolNames : []).map((name) => String(name)))]
  const discoveredNames = new Set(discoveredServers.flatMap((server) => (server.tools || []).map((tool) => String(tool.name || ''))))
  const unknownTools = requestedTools.filter((name) => !discoveredNames.has(name))
  if (unknownTools.length) throw new Error(`Agent 请求了 MCP 服务器未提供的工具：${unknownTools.join(', ')}`)
  const authorizedNames = new Set(requestedTools)
  return discoveredServers.map((server) => ({
    ...server,
    tools: (server.tools || []).filter((tool) => authorizedNames.has(String(tool.name || ''))),
  }))
}

function endpoint(baseUrl, path) {
  const url = new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('模型地址必须使用 HTTP 或 HTTPS')
  return url
}

function modelConnectionError(config, error) {
  const message = error instanceof Error ? error.message : '模型请求失败'
  if (/本地服务 .*未启动|ECONNREFUSED/i.test(message)) {
    const target = new URL(config.baseUrl).host
    if (config.provider === 'ccswitch') {
      return new Error(`CCSwitch 本地代理未监听 ${target}。请在 CC Switch 中启用本地代理并填写实际监听地址，或在“模型连接”中切换其他厂商。`)
    }
    const provider = config.provider === 'ollama' ? 'Ollama' : config.provider === 'lmstudio' ? 'LM Studio' : '本地模型服务'
    return new Error(`${provider} 未监听 ${target}。请先启动服务，或在“模型连接”中修改 Base URL。`)
  }
  return new Error(`${config.provider || '模型'} · ${config.model} 请求失败：${message}`)
}

function buildContext(payload, toolMappings) {
  const enabledSkills = (payload.skills || []).join('、') || '市场分析、风险审查'
  return [
    '你是 Atlas 交易工作台中的分析助手。回答必须区分事实、推断和风险，不承诺收益。',
    '你可以分析行情和账户上下文，但不能绕过风控，也不能主动提交生产订单。',
    `已启用 Skill：${enabledSkills}。`,
    toolMappings.length ? `可调用 MCP 工具：${toolMappings.map((tool) => tool.originalName).join('、')}。仅在回答确实需要时调用。` : '',
    payload.context ? `当前上下文：${JSON.stringify(payload.context)}` : '',
  ].filter(Boolean).join('\n')
}

function toolMappings(payload) {
  const servers = Array.isArray(payload.mcpServers) && payload.mcpServers.length
    ? payload.mcpServers
    : payload.mcp?.url
      ? [payload.mcp]
      : []
  return servers.slice(0, 8).flatMap((server, serverIndex) => (server?.tools || []).slice(0, 32).map((tool, toolIndex) => ({
    originalName: String(tool.name || ''),
    modelName: `mcp_${serverIndex}_${toolIndex}_${String(tool.name || '').replace(/[^A-Za-z0-9_-]/g, '_')}`.slice(0, 64),
    description: tool.description || `MCP tool ${tool.name}`,
    parameters: tool.inputSchema?.type === 'object' ? tool.inputSchema : { type: 'object', properties: {} },
    serverUrl: server.url,
    headers: server.headers,
  }))).filter((tool) => tool.originalName && tool.serverUrl)
}

async function executeTool(payload, mappings, modelName, args) {
  const mapping = mappings.find((tool) => tool.modelName === modelName)
  if (!mapping) throw new Error(`模型请求了未授权工具：${modelName}`)
  if (!mapping.serverUrl) throw new Error(`MCP 尚未连接，无法执行工具：${mapping.originalName}`)
  return callMcpTool({
    url: mapping.serverUrl,
    headers: mapping.headers,
    name: mapping.originalName,
    arguments: args || {},
    timeoutMs: boundedTimeout(payload.timeoutMs, DEFAULT_SUPERVISION_TIMEOUT),
  })
}

function openAiReasoning(config) {
  const effort = config.reasoningEffort
  if (!effort || effort === 'none' || config.reasoningMode === 'model') return { temperature: 0.2 }
  if (config.reasoningMode === 'openrouter') {
    const normalized = ['minimal', 'low'].includes(effort) ? 'low' : effort === 'medium' ? 'medium' : 'high'
    return { reasoning: { effort: normalized } }
  }
  if (config.reasoningMode === 'openai') return { reasoning_effort: effort }
  return { temperature: 0.2 }
}

async function chatOpenAi(config, payload, mappings, system) {
  const url = endpoint(config.baseUrl, 'chat/completions')
  const messages = [{ role: 'system', content: system }, ...(payload.messages || []).slice(-20)]
  const tools = mappings.map((tool) => ({ type: 'function', function: { name: tool.modelName, description: tool.description, parameters: tool.parameters } }))
  const complete = async () => {
    const response = await fetchWithProxy(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
      body: JSON.stringify({
        model: config.model,
        messages,
        stream: false,
        ...openAiReasoning(config),
        ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
      }),
      signal: AbortSignal.timeout(boundedTimeout(payload.timeoutMs)),
    })
    const data = await response.json().catch(() => null)
    if (!response.ok) throw new Error(data?.error?.message || data?.message || `模型请求失败 (${response.status})`)
    return data
  }

  let data = await complete()
  const firstMessage = data.choices?.[0]?.message
  if (firstMessage?.tool_calls?.length) {
    messages.push(firstMessage)
    for (const toolCall of firstMessage.tool_calls.slice(0, 8)) {
      let args = {}
      try { args = JSON.parse(toolCall.function?.arguments || '{}') } catch { throw new Error(`工具参数不是有效 JSON：${toolCall.function?.name}`) }
      const result = await executeTool(payload, mappings, toolCall.function?.name, args)
      messages.push({ role: 'tool', tool_call_id: toolCall.id, name: toolCall.function?.name, content: JSON.stringify(result) })
    }
    data = await complete()
  }
  return {
    id: data.id,
    model: data.model || config.model,
    content: data.choices?.[0]?.message?.content || '',
    usage: data.usage || null,
  }
}

function responseText(data) {
  if (data.output_text) return data.output_text
  return (data.output || [])
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content || [])
    .filter((part) => part.type === 'output_text')
    .map((part) => part.text || '')
    .join('\n')
}

async function chatResponses(config, payload, mappings, system) {
  const url = endpoint(config.baseUrl, 'responses')
  const tools = mappings.map((tool) => ({ type: 'function', name: tool.modelName, description: tool.description, parameters: tool.parameters }))
  const initialInput = [{ role: 'system', content: system }, ...(payload.messages || []).slice(-20)]
  const reasoningEffort = config.reasoningEffort === 'minimal' ? 'low' : config.reasoningEffort
  const complete = async (input, previousResponseId) => {
    const response = await fetchWithProxy(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
      body: JSON.stringify({
        model: config.model,
        input,
        ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
        ...(reasoningEffort && reasoningEffort !== 'none' ? { reasoning: { effort: reasoningEffort } } : {}),
        ...(tools.length ? { tools } : {}),
      }),
      signal: AbortSignal.timeout(boundedTimeout(payload.timeoutMs)),
    })
    const data = await response.json().catch(() => null)
    if (!response.ok) throw new Error(data?.error?.message || data?.message || `OpenAI Responses 请求失败 (${response.status})`)
    return data
  }

  let data = await complete(initialInput)
  const calls = (data.output || []).filter((item) => item.type === 'function_call').slice(0, 8)
  if (calls.length) {
    const outputs = []
    for (const call of calls) {
      let args = {}
      try { args = JSON.parse(call.arguments || '{}') } catch { throw new Error(`工具参数不是有效 JSON：${call.name}`) }
      const result = await executeTool(payload, mappings, call.name, args)
      outputs.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result) })
    }
    data = await complete(outputs, data.id)
  }
  return { id: data.id, model: data.model || config.model, content: responseText(data), usage: data.usage || null }
}

function anthropicThinking(config) {
  if (!config.reasoningEffort || config.reasoningEffort === 'none') return {}
  const budgets = { minimal: 1024, low: 2048, medium: 4096, high: 8192, xhigh: 16384, max: 32768 }
  const budgetTokens = budgets[config.reasoningEffort] || 4096
  return { thinking: { type: 'enabled', budget_tokens: budgetTokens }, max_tokens: budgetTokens + 4096 }
}

async function chatAnthropic(config, payload, mappings, system) {
  const url = endpoint(config.baseUrl, 'messages')
  const messages = (payload.messages || []).slice(-20).map((message) => ({ role: message.role, content: message.content }))
  const tools = mappings.map((tool) => ({ name: tool.modelName, description: tool.description, input_schema: tool.parameters }))
  const complete = async () => {
    const response = await fetchWithProxy(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        ...(config.apiKey ? { 'x-api-key': config.apiKey } : {}),
      },
      body: JSON.stringify({ model: config.model, system, messages, max_tokens: 4096, ...anthropicThinking(config), ...(tools.length ? { tools } : {}) }),
      signal: AbortSignal.timeout(boundedTimeout(payload.timeoutMs)),
    })
    const data = await response.json().catch(() => null)
    if (!response.ok) throw new Error(data?.error?.message || data?.message || `Claude 请求失败 (${response.status})`)
    return data
  }

  let data = await complete()
  const toolUses = (data.content || []).filter((part) => part.type === 'tool_use').slice(0, 8)
  if (toolUses.length) {
    messages.push({ role: 'assistant', content: data.content })
    const toolResults = []
    for (const toolUse of toolUses) {
      const result = await executeTool(payload, mappings, toolUse.name, toolUse.input || {})
      toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify(result) })
    }
    messages.push({ role: 'user', content: toolResults })
    data = await complete()
  }
  return {
    id: data.id,
    model: data.model || config.model,
    content: (data.content || []).filter((part) => part.type === 'text').map((part) => part.text).join('\n'),
    usage: data.usage || null,
  }
}

function googleThinking(config) {
  const effort = config.reasoningEffort
  if (!effort || effort === 'none') return {}
  if (/gemini-3/i.test(config.model)) {
    const thinkingLevel = ['minimal', 'low'].includes(effort) ? 'LOW' : effort === 'medium' ? 'MEDIUM' : 'HIGH'
    return { thinkingConfig: { thinkingLevel } }
  }
  const budgets = { minimal: 512, low: 1024, medium: 4096, high: 8192, xhigh: 16384, max: 32768 }
  return { thinkingConfig: { thinkingBudget: budgets[effort] || 4096 } }
}

async function chatGoogle(config, payload, mappings, system) {
  const url = endpoint(config.baseUrl, `models/${encodeURIComponent(config.model)}:generateContent`)
  if (config.apiKey) url.searchParams.set('key', config.apiKey)
  const contents = (payload.messages || []).slice(-20).map((message) => ({
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: message.content }],
  }))
  const functionDeclarations = mappings.map((tool) => ({ name: tool.modelName, description: tool.description, parameters: tool.parameters }))
  const complete = async () => {
    const response = await fetchWithProxy(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(config.apiKey ? { 'x-goog-api-key': config.apiKey } : {}) },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents,
        generationConfig: { temperature: 0.2, ...googleThinking(config) },
        ...(functionDeclarations.length ? { tools: [{ functionDeclarations }] } : {}),
      }),
      signal: AbortSignal.timeout(boundedTimeout(payload.timeoutMs)),
    })
    const data = await response.json().catch(() => null)
    if (!response.ok) throw new Error(data?.error?.message || data?.message || `Gemini 请求失败 (${response.status})`)
    return data
  }

  let data = await complete()
  const candidateContent = data.candidates?.[0]?.content
  const calls = (candidateContent?.parts || []).filter((part) => part.functionCall).slice(0, 8)
  if (calls.length) {
    contents.push(candidateContent)
    const responseParts = []
    for (const part of calls) {
      const result = await executeTool(payload, mappings, part.functionCall.name, part.functionCall.args || {})
      responseParts.push({ functionResponse: { name: part.functionCall.name, response: { result } } })
    }
    contents.push({ role: 'user', parts: responseParts })
    data = await complete()
  }
  return {
    id: data.responseId,
    model: data.modelVersion || config.model,
    content: (data.candidates?.[0]?.content?.parts || []).map((part) => part.text || '').filter(Boolean).join('\n'),
    usage: data.usageMetadata || null,
  }
}

async function chatWithConfig(config, payload, system = buildContext(payload, toolMappings(payload))) {
  const mappings = toolMappings(payload)
  try {
    if (config.protocol === 'responses') return await chatResponses(config, payload, mappings, system)
    if (config.protocol === 'anthropic') return await chatAnthropic(config, payload, mappings, system)
    if (config.protocol === 'google') return await chatGoogle(config, payload, mappings, system)
    return await chatOpenAi(config, payload, mappings, system)
  } catch (error) {
    throw modelConnectionError(config, error)
  }
}

async function configuredModel(modelOverride) {
  const saved = await loadVault('model-router')
  const config = modelOverride ? { ...saved, model: String(modelOverride).trim().slice(0, 160) } : saved
  if (!config?.baseUrl || !config?.model) throw new Error('请先在“连接”中配置模型路由')
  if (config.health !== 'healthy') throw new Error('当前模型连接尚未验证，请到“连接 → 模型与推理”测试并保存')
  return config
}

function parseSupervisionDecision(content) {
  const raw = String(content || '').trim()
  const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  const source = fenced ? fenced[1] : raw
  let result
  try {
    result = JSON.parse(source)
  } catch {
    throw new Error('AI 监督响应不是有效 JSON')
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('AI 监督响应必须是 JSON 对象')
  const unexpected = Object.keys(result).filter((key) => !['decision', 'confidence', 'reason'].includes(key))
  if (unexpected.length) throw new Error(`AI 监督响应包含未授权字段：${unexpected.join(', ')}`)
  const decision = String(result.decision || '').trim().toUpperCase()
  const confidence = Number(result.confidence)
  const reason = String(result.reason || '').trim()
  if (!['APPROVE', 'REJECT'].includes(decision)) throw new Error('AI 监督 decision 必须是 APPROVE 或 REJECT')
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error('AI 监督 confidence 必须在 0 到 1 之间')
  if (!reason) throw new Error('AI 监督 reason 不能为空')
  return { decision, confidence, reason: reason.slice(0, 1000) }
}

export async function chatWithModel(payload) {
  const config = await configuredModel(payload?.model)
  return chatWithConfig(config, payload)
}

export async function superviseAgentCandidate(request) {
  if (!request?.candidateOrder || !request?.agent || request.intelligence?.mode !== 'ai-supervised') {
    throw new Error('AI 监督请求缺少不可变候选订单或 Agent 上下文')
  }
  const timeoutMs = boundedTimeout(request.timeoutMs, DEFAULT_SUPERVISION_TIMEOUT)
  const config = await configuredModel(request.intelligence.model)
  const trustedSkills = resolveAgentSkills(request.intelligence.skills || [])
  const selectedServers = (request.intelligence.mcpServers || []).slice(0, 8)
  const discoveredServers = await Promise.all(selectedServers.map(async (url) => {
    const connection = await connectMcp({ url, timeoutMs: Math.min(timeoutMs, 8_000) })
    return { url, tools: connection.tools }
  }))
  const connectedServers = authorizeAgentMcpTools(discoveredServers, request.intelligence.mcpTools || [])
  const system = buildAgentSupervisorSystem(trustedSkills.map((skill) => skill.id))
  const context = {
    agent: request.agent,
    candidateOrder: request.candidateOrder,
    signal: request.signal,
    candleTime: request.candleTime,
    recentCandles: request.candles,
    account: request.account,
    selectedSkills: trustedSkills.map(({ id, version }) => ({ id, version })),
    availableMcpTools: connectedServers.map((server) => ({
      server: server.url,
      tools: server.tools.map((tool) => ({ name: tool.name, description: tool.description || '', inputSchema: tool.inputSchema || null })),
    })),
  }
  const response = await chatWithConfig(config, {
    messages: [{ role: 'user', content: `请审查以下冻结的交易候选，并按指定 JSON 格式裁决：\n${JSON.stringify(context)}` }],
    skills: request.intelligence.skills || [],
    mcpServers: connectedServers,
    timeoutMs,
  }, system)
  return {
    ...parseSupervisionDecision(response.content),
    model: response.model || config.model,
    usage: response.usage || null,
  }
}
