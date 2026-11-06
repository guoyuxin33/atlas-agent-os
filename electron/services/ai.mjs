import { loadVault } from './vault.mjs'
import { fetchWithProxy } from './network.mjs'
import { callMcpTool } from './mcp.mjs'

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
  return (payload.mcp?.tools || []).slice(0, 32).map((tool, index) => ({
    originalName: tool.name,
    modelName: `mcp_${index}_${tool.name.replace(/[^A-Za-z0-9_-]/g, '_')}`.slice(0, 64),
    description: tool.description || `MCP tool ${tool.name}`,
    parameters: tool.inputSchema?.type === 'object' ? tool.inputSchema : { type: 'object', properties: {} },
  }))
}

async function executeTool(payload, mappings, modelName, args) {
  const mapping = mappings.find((tool) => tool.modelName === modelName)
  if (!mapping) throw new Error(`模型请求了未授权工具：${modelName}`)
  if (!payload.mcp?.url) throw new Error(`MCP 尚未连接，无法执行工具：${mapping.originalName}`)
  return callMcpTool({ url: payload.mcp.url, name: mapping.originalName, arguments: args || {} })
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
      signal: AbortSignal.timeout(60_000),
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
      signal: AbortSignal.timeout(60_000),
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
      signal: AbortSignal.timeout(60_000),
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
      signal: AbortSignal.timeout(60_000),
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

export async function chatWithModel(payload) {
  const config = await loadVault('model-router')
  if (!config?.baseUrl || !config?.model) throw new Error('请先在“连接”中配置模型路由')
  if (config.health !== 'healthy') throw new Error('当前模型连接尚未验证，请到“连接 → 模型与推理”测试并保存')
  const mappings = toolMappings(payload)
  const system = buildContext(payload, mappings)
  try {
    if (config.protocol === 'responses') return await chatResponses(config, payload, mappings, system)
    if (config.protocol === 'anthropic') return await chatAnthropic(config, payload, mappings, system)
    if (config.protocol === 'google') return await chatGoogle(config, payload, mappings, system)
    return await chatOpenAi(config, payload, mappings, system)
  } catch (error) {
    throw modelConnectionError(config, error)
  }
}
