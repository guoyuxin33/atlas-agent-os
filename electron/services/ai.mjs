import { loadVault } from './vault.mjs'
import { fetchWithProxy } from './network.mjs'
import { callMcpTool, connectMcp } from './mcp.mjs'

const DEFAULT_MODEL_TIMEOUT = 60_000
const DEFAULT_SUPERVISION_TIMEOUT = 12_000
const AGENT_SKILLS = Object.freeze({
  'market-analysis': Object.freeze({
    version: '2.0.0',
    name: '市场状态与波动率识别',
    applicability: ['spot', 'futures'],
    inputBoundary: {
      required: ['agent.marketType/symbol/interval', 'signal', 'candidateOrder', 'recentCandles (closed only)', 'derived.regime'],
      optional: ['authorized MCP market data with source timestamp'],
      prohibited: ['unfinished candle', 'unstamped external quote', 'invented order-book depth'],
    },
    instructions: [
      '目标：识别趋势、震荡、突破和异常波动状态，判断候选方向是否得到多项证据支持。',
      '检查：结合 20 根收益、ATR%、区间位置、短窗实现波动率和成交量比；不得只凭单根 K 线或一个指标批准。',
      '否决：趋势与信号相反；波动率或成交量异常且候选未体现风险收缩；闭合 K 线不足 20 根；关键输入互相矛盾。',
      '边界：所有市场判断只能来自 skillInputs.market-analysis 或已授权 MCP 返回的带时间戳数据。',
    ].join('\n'),
    assistantInstructions: '使用当前上下文里的真实市场数据区分趋势、震荡、突破和异常波动；明确列出数据周期与缺失项，不得把模型记忆当成实时行情。',
  }),
  'risk-review': Object.freeze({
    version: '2.0.0',
    name: '仓位规模与风险预算',
    applicability: ['spot', 'futures'],
    inputBoundary: {
      required: ['agent.risk', 'account equity/available balance/position', 'signal', 'candidateOrder', 'derived.riskBudget'],
      optional: ['account unrealizedPnl/todayPnl'],
      prohibited: ['unprovided stop price', 'assumed leverage', 'modified candidate quantity'],
    },
    instructions: [
      '目标：独立审查候选名义价值、可用资金占用、组合方向集中度和 Agent 风险预算。',
      '检查：候选方向必须与信号一致；名义价值不得超过 maxNotional；数量不得超过 maxQuantity；不得在可用余额不足或已有同向暴露过高时批准新增风险。',
      '否决：任一风险输入缺失或非有限数；候选突破配置上限；保证金/余额不足；订单会意外扩大而不是降低现有风险。',
      '边界：只能批准或拒绝冻结候选，不得重算、修改或建议修改任何订单字段。',
    ].join('\n'),
    assistantInstructions: '基于账户权益、可用余额、现有持仓和明确订单参数分析风险预算；没有数量、价格或止损时只说明缺失项，不得编造仓位建议。',
  }),
  'execution-quality': Object.freeze({
    version: '1.0.0',
    name: '执行质量与滑点审查',
    applicability: ['spot', 'futures'],
    inputBoundary: {
      required: ['candidateOrder type/price/marketPrice/quantity', 'recentCandles OHLCV', 'derived.execution'],
      optional: ['authorized MCP bid/ask, depth and recent trades with timestamp'],
      prohibited: ['assumed spread', 'invented fill price', 'unstamped liquidity data'],
    },
    instructions: [
      '目标：在不改变订单的前提下审查价格新鲜度、粗略流动性、潜在滑点和市场冲击。',
      '检查：比较候选名义价值与近 20 根平均报价成交额，检查最近 K 线振幅；限价单检查价格与 marketPrice 偏离，市价单在缺少盘口时只能使用成交额占比作保守代理。',
      '否决：价格无效或陈旧；候选相对近期成交额过大；限价偏离异常；声称精确滑点但未获得授权盘口数据。',
      '边界：K 线成交量不能冒充订单簿深度；没有 bid/ask 时必须明确滑点只是代理判断。',
    ].join('\n'),
    assistantInstructions: '分析价格新鲜度、成交额占比和限价偏离；没有盘口深度时必须把滑点判断标为粗略代理，不能给出伪精确成交价。',
  }),
  'futures-carry-risk': Object.freeze({
    version: '1.0.0',
    name: '资金费率与清算风险',
    applicability: ['futures'],
    inputBoundary: {
      required: ['agent.marketType/positionMode', 'candidateOrder leverage/marginType/reduceOnly', 'account.position liquidationPrice/marginRatio when a position exists', 'derived.futuresRisk'],
      optional: ['authorized MCP funding rate/next funding time/open interest with source timestamp'],
      prohibited: ['invented funding rate', 'assumed liquidation price', 'spot carry claims'],
    },
    instructions: [
      '目标：审查永续合约候选的杠杆、保证金模式、清算缓冲与资金费率方向性成本。',
      '检查：区分开仓/加仓与 reduce-only 降险；核对 positionSide、positionMode、杠杆和清算距离；资金费率只有在授权工具返回带时间戳数据时才可量化。',
      '否决：已有持仓的清算或保证金数据缺失且候选扩大风险；现有清算缓冲过窄且候选扩大风险；候选方向与持仓模式冲突；依赖未提供的资金费率结论。',
      '边界：现货候选标记为不适用，不得因此否决；reduce-only 平仓优先视为降险，但仍需检查订单字段一致性。',
    ].join('\n'),
    assistantInstructions: '仅在合约上下文中分析杠杆、保证金、清算缓冲和资金成本；资金费率必须来自带时间戳的授权数据，现货场景明确标记不适用。',
  }),
  'news-research': Object.freeze({
    version: '1.1.0',
    name: '事件与新闻研究',
    applicability: ['spot', 'futures'],
    inputBoundary: {
      required: ['authorized MCP result with source and timestamp'],
      optional: ['multiple independent sources'],
      prohibited: ['model memory presented as current news', 'unsourced sentiment'],
    },
    instructions: '只有通过已授权 MCP 工具取得带来源和时间戳的事件信息时，才能把新闻作为辅助证据。不得编造新闻，不得把情绪当作事实；来源不可用、时间过旧或互相矛盾时拒绝依赖新闻的候选。',
    assistantInstructions: '只有通过已授权 MCP 工具取得带来源和时间戳的信息时才能讨论当前事件；分开陈述事实、来源冲突和情绪推断。',
  }),
  'strategy-builder': Object.freeze({
    version: '1.1.0',
    name: '策略一致性审查',
    applicability: ['spot', 'futures'],
    inputBoundary: {
      required: ['agent.strategy/params', 'signal', 'candidateOrder'],
      optional: ['recentCandles used by the deterministic strategy'],
      prohibited: ['new strategy rules', 'changed parameters', 'replacement order'],
    },
    instructions: '审查确定性策略名称、参数、信号理由与候选订单是否逻辑一致。不得创建新策略、改变规则或替换候选订单；发现规则与信号不一致时拒绝。',
    assistantInstructions: '把策略说明拆成可验证条件、参数、输入周期和失效条件；清楚区分现有规则与用户提出但尚未实现的规则。',
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
    return {
      id,
      version: skill.version,
      name: skill.name,
      applicability: [...skill.applicability],
      inputBoundary: {
        required: [...skill.inputBoundary.required],
        optional: [...skill.inputBoundary.optional],
        prohibited: [...skill.inputBoundary.prohibited],
      },
      instructions: skill.instructions,
      assistantInstructions: skill.assistantInstructions,
    }
  })
}

export function partitionAgentSkills(skillIds = [], marketType = 'spot') {
  const selected = resolveAgentSkills(skillIds)
  const applicable = selected.filter((skill) => skill.applicability.includes(marketType))
  const skipped = selected
    .filter((skill) => !skill.applicability.includes(marketType))
    .map(({ id, version, name, applicability }) => ({
      id,
      version,
      name,
      applicability,
      status: 'NOT_APPLICABLE',
      reason: `${marketType} 市场不在 Skill 适用范围内`,
    }))
  return { applicable, skipped }
}

export function buildAgentSupervisorSystem(skillIds = []) {
  const skills = resolveAgentSkills(skillIds)
  return [
    '你是 Atlas Agent OS 的交易候选监督器。你只能批准或拒绝已经由确定性策略生成的候选订单。',
    '你绝对不能修改或建议修改 side、quantity、price、symbol、environment、marketType、positionSide、reduceOnly 或任何订单字段，也不能提交订单。',
    '硬风控在你批准后仍会再次执行；你的批准不代表订单一定成交。任何数据不足、工具失败或不确定性都必须选择 REJECT。',
    ...skills.map((skill) => [
      `[受信任 Skill ${skill.id}@${skill.version}] ${skill.name}`,
      `适用市场：${skill.applicability.join(', ')}`,
      `必需输入：${skill.inputBoundary.required.join('；')}`,
      `可选输入：${skill.inputBoundary.optional.join('；')}`,
      `禁止输入：${skill.inputBoundary.prohibited.join('；')}`,
      skill.instructions,
    ].join('\n')),
    skills.length ? `必须逐项执行全部已选 Skill；任一 Skill 否决则最终 REJECT。reason 按 ${skills.map((skill) => skill.id).join('、')} 的顺序给出 PASS/FAIL 与关键依据。` : '没有选择 Skill 时，只能按基础一致性和数据完整性规则裁决。',
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

export function buildAssistantSystem(payload, toolMappings) {
  const trustedSkills = resolveAgentSkills(payload.skills || [])
  const enabledSkills = trustedSkills.map((skill) => `${skill.name} (${skill.id}@${skill.version})`).join('、') || '未启用'
  return [
    '你是 Atlas 交易工作台中的分析助手。回答必须区分事实、推断和风险，不承诺收益。',
    '你可以分析行情和账户上下文，但不能绕过风控，也不能主动提交生产订单。',
    `已启用 Skill：${enabledSkills}。`,
    ...trustedSkills.map((skill) => `[受信任 Skill ${skill.id}@${skill.version}]\n输入边界：${skill.inputBoundary.required.join('；')}\n${skill.assistantInstructions}`),
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

async function chatWithConfig(config, payload, system = buildAssistantSystem(payload, toolMappings(payload))) {
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

function finiteMetric(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function roundedMetric(value, digits = 6) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null
}

function average(values) {
  const finite = values.filter(Number.isFinite)
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null
}

function deriveRegime(candles) {
  const recent = candles.slice(-20)
  const closes = recent.map((candle) => finiteMetric(candle.close)).filter(Number.isFinite)
  const returns = closes.slice(1).map((close, index) => closes[index] > 0 ? close / closes[index] - 1 : NaN).filter(Number.isFinite)
  const meanReturn = average(returns)
  const variance = meanReturn === null ? null : average(returns.map((value) => (value - meanReturn) ** 2))
  const latest = recent.at(-1)
  const latestClose = finiteMetric(latest?.close)
  const trueRanges = recent.map((candle, index) => {
    const high = finiteMetric(candle.high)
    const low = finiteMetric(candle.low)
    const previousClose = finiteMetric(recent[index - 1]?.close)
    if (high === null || low === null) return NaN
    return previousClose === null ? high - low : Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose))
  })
  const atr = average(trueRanges)
  const highs = recent.map((candle) => finiteMetric(candle.high)).filter(Number.isFinite)
  const lows = recent.map((candle) => finiteMetric(candle.low)).filter(Number.isFinite)
  const rangeHigh = highs.length ? Math.max(...highs) : null
  const rangeLow = lows.length ? Math.min(...lows) : null
  const volumes = recent.map((candle) => finiteMetric(candle.volume)).filter(Number.isFinite)
  const baselineVolume = average(volumes.slice(0, -1))
  return {
    closedCandleCount: candles.length,
    return20Pct: closes.length >= 2 ? roundedMetric((closes.at(-1) / closes[0] - 1) * 100) : null,
    atr20Pct: latestClose && atr !== null ? roundedMetric(atr / latestClose * 100) : null,
    realizedVolatility20Pct: variance !== null ? roundedMetric(Math.sqrt(variance) * 100) : null,
    rangePosition20: latestClose !== null && rangeHigh !== null && rangeLow !== null && rangeHigh > rangeLow ? roundedMetric((latestClose - rangeLow) / (rangeHigh - rangeLow)) : null,
    latestVolumeRatio20: baselineVolume && volumes.length ? roundedMetric(volumes.at(-1) / baselineVolume) : null,
  }
}

function deriveRiskBudget(request) {
  const order = request.candidateOrder || {}
  const account = request.account || {}
  const risk = request.agent?.risk || {}
  const quantity = finiteMetric(order.quantity)
  const price = finiteMetric(order.marketPrice ?? order.price)
  const candidateNotional = quantity !== null && price !== null ? Math.abs(quantity * price) : null
  const equity = finiteMetric(account.totalWalletBalance)
  const available = finiteMetric(account.availableBalance)
  const maxNotional = finiteMetric(risk.maxNotional)
  const maxQuantity = finiteMetric(risk.maxQuantity)
  const riskFraction = finiteMetric(risk.riskFraction)
  return {
    candidateNotional: roundedMetric(candidateNotional),
    configuredRiskBudget: equity !== null && riskFraction !== null ? roundedMetric(equity * riskFraction) : null,
    notionalLimitUsage: candidateNotional !== null && maxNotional && maxNotional > 0 ? roundedMetric(candidateNotional / maxNotional) : null,
    quantityLimitUsage: quantity !== null && maxQuantity && maxQuantity > 0 ? roundedMetric(Math.abs(quantity) / maxQuantity) : null,
    availableBalanceUsage: candidateNotional !== null && available && available > 0 ? roundedMetric(candidateNotional / available) : null,
  }
}

function deriveExecution(request, candles) {
  const order = request.candidateOrder || {}
  const riskBudget = deriveRiskBudget(request)
  const recent = candles.slice(-20)
  const quoteTurnovers = recent.map((candle) => {
    const close = finiteMetric(candle.close)
    const volume = finiteMetric(candle.volume)
    return close !== null && volume !== null ? Math.abs(close * volume) : NaN
  })
  const averageQuoteTurnover = average(quoteTurnovers)
  const latest = recent.at(-1)
  const latestHigh = finiteMetric(latest?.high)
  const latestLow = finiteMetric(latest?.low)
  const latestClose = finiteMetric(latest?.close)
  const orderPrice = finiteMetric(order.price)
  const marketPrice = finiteMetric(order.marketPrice)
  return {
    candidateNotional: riskBudget.candidateNotional,
    candidateToAverageCandleTurnover: riskBudget.candidateNotional !== null && averageQuoteTurnover && averageQuoteTurnover > 0 ? roundedMetric(riskBudget.candidateNotional / averageQuoteTurnover) : null,
    latestCandleRangePct: latestClose && latestHigh !== null && latestLow !== null ? roundedMetric((latestHigh - latestLow) / latestClose * 100) : null,
    limitDeviationPct: order.type === 'LIMIT' && orderPrice !== null && marketPrice ? roundedMetric((orderPrice / marketPrice - 1) * 100) : null,
    exactSpreadAvailable: false,
    orderBookDepthAvailable: false,
  }
}

function deriveFuturesRisk(request) {
  const position = request.account?.position || null
  const futuresConfig = request.account?.futuresConfig || null
  const markPrice = finiteMetric(position?.markPrice)
  const liquidationPrice = finiteMetric(position?.liquidationPrice)
  let liquidationBufferPct = null
  if (markPrice && liquidationPrice && markPrice > 0 && liquidationPrice > 0) {
    liquidationBufferPct = position?.side === 'SHORT'
      ? (liquidationPrice - markPrice) / markPrice * 100
      : (markPrice - liquidationPrice) / markPrice * 100
  }
  return {
    applicable: request.agent?.marketType === 'futures',
    leverage: finiteMetric(request.candidateOrder?.leverage ?? futuresConfig?.leverage ?? position?.leverage),
    marginType: request.candidateOrder?.marginType || futuresConfig?.marginType || position?.marginType || null,
    positionMode: futuresConfig?.positionMode || request.agent?.positionMode || null,
    reduceOnly: request.candidateOrder?.reduceOnly === true,
    liquidationBufferPct: roundedMetric(liquidationBufferPct),
    marginRatio: finiteMetric(position?.marginRatio),
    fundingRate: null,
    fundingRateAvailable: false,
    fundingPnlToday: finiteMetric(request.account?.fundingPnlToday),
  }
}

export function buildAgentSupervisionContext(request, connectedServers = [], resolvedSkills, skippedSkills = []) {
  const partitioned = resolvedSkills
    ? { applicable: resolvedSkills, skipped: skippedSkills }
    : partitionAgentSkills(request?.intelligence?.skills || [], request?.agent?.marketType)
  const skills = partitioned.applicable
  const recentCandles = (Array.isArray(request?.candles) ? request.candles : []).slice(-100).map((candle) => ({
    time: candle.time,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
  }))
  const availableMcpTools = connectedServers.map((server) => ({
    server: server.url,
    tools: (server.tools || []).map((tool) => ({ name: tool.name, description: tool.description || '', inputSchema: tool.inputSchema || null })),
  }))
  const skillInputs = {}
  for (const skill of skills) {
    if (skill.id === 'market-analysis') {
      skillInputs[skill.id] = { market: { marketType: request.agent.marketType, symbol: request.agent.symbol, interval: request.agent.interval }, signal: request.signal, candidateOrder: request.candidateOrder, recentCandles, derived: { regime: deriveRegime(recentCandles) } }
    } else if (skill.id === 'risk-review') {
      skillInputs[skill.id] = { configuredRisk: request.agent.risk, account: request.account, signal: request.signal, candidateOrder: request.candidateOrder, derived: { riskBudget: deriveRiskBudget(request) } }
    } else if (skill.id === 'execution-quality') {
      skillInputs[skill.id] = { candidateOrder: request.candidateOrder, recentCandles, authorizedLiquidityTools: availableMcpTools, derived: { execution: deriveExecution(request, recentCandles) } }
    } else if (skill.id === 'futures-carry-risk') {
      skillInputs[skill.id] = { market: { marketType: request.agent.marketType, symbol: request.agent.symbol, positionMode: request.agent.positionMode }, candidateOrder: request.candidateOrder, position: request.account?.position || null, authorizedCarryTools: availableMcpTools, derived: { futuresRisk: deriveFuturesRisk(request) } }
    } else if (skill.id === 'news-research') {
      skillInputs[skill.id] = { candidateOrder: request.candidateOrder, signal: request.signal, authorizedResearchTools: availableMcpTools }
    } else if (skill.id === 'strategy-builder') {
      skillInputs[skill.id] = { strategy: request.agent.strategy, params: request.agent.params, signal: request.signal, candidateOrder: request.candidateOrder, recentCandles }
    }
  }
  return {
    agent: request.agent,
    candidateOrder: request.candidateOrder,
    signal: request.signal,
    candleTime: request.candleTime,
    recentCandles,
    account: request.account,
    selectedSkills: skills.map(({ id, version, name, applicability, inputBoundary }) => ({ id, version, name, applicability, inputBoundary })),
    skippedSkills: partitioned.skipped,
    skillInputs,
    availableMcpTools,
  }
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
  const { applicable: trustedSkills, skipped: skippedSkills } = partitionAgentSkills(request.intelligence.skills || [], request.agent.marketType)
  const selectedServers = (request.intelligence.mcpServers || []).slice(0, 8)
  const discoveredServers = await Promise.all(selectedServers.map(async (url) => {
    const connection = await connectMcp({ url, timeoutMs: Math.min(timeoutMs, 8_000) })
    return { url, tools: connection.tools }
  }))
  const connectedServers = authorizeAgentMcpTools(discoveredServers, request.intelligence.mcpTools || [])
  const system = buildAgentSupervisorSystem(trustedSkills.map((skill) => skill.id))
  const context = buildAgentSupervisionContext(request, connectedServers, trustedSkills, skippedSkills)
  const response = await chatWithConfig(config, {
    messages: [{ role: 'user', content: `请审查以下冻结的交易候选，并按指定 JSON 格式裁决：\n${JSON.stringify(context)}` }],
    skills: trustedSkills.map((skill) => skill.id),
    mcpServers: connectedServers,
    timeoutMs,
  }, system)
  const decision = parseSupervisionDecision(response.content)
  return {
    ...decision,
    model: response.model || config.model,
    usage: response.usage || null,
    skillAudit: {
      applicable: trustedSkills.map(({ id, version }) => ({ id, version, status: 'APPLICABLE' })),
      skipped: skippedSkills,
    },
  }
}
