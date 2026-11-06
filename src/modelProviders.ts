export type ModelProtocol = 'openai' | 'responses' | 'anthropic' | 'google'
export type ReasoningMode = 'openai' | 'openrouter' | 'model'

export interface ModelProviderDefinition {
  id: string
  label: string
  protocol: ModelProtocol
  reasoningMode: ReasoningMode
  baseUrl: string
  defaultModel: string
  models: string[]
  keyOptional?: boolean
  note: string
}

export const modelProviders: ModelProviderDefinition[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    protocol: 'responses',
    reasoningMode: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-6.1-sol',
    models: ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna'],
    note: '官方 API · GPT-6 系列 · 支持推理强度',
  },
  {
    id: 'anthropic',
    label: 'Anthropic Claude',
    protocol: 'anthropic',
    reasoningMode: 'model',
    baseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-sonnet-5-5',
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'],
    note: '原生 Messages API · 扩展思考按档位映射',
  },
  {
    id: 'google',
    label: 'Google Gemini',
    protocol: 'google',
    reasoningMode: 'model',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: 'gemini-3.6-flash',
    models: ['gemini-4-argon', 'gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'],
    note: '原生 Gemini API · 生产默认稳定版',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    protocol: 'openai',
    reasoningMode: 'model',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-flash',
    models: ['deepseek-v4-pro', 'deepseek-flash'],
    note: 'OpenAI 兼容 · 推理由模型类型决定',
  },
  {
    id: 'qwen',
    label: 'Alibaba Qwen',
    protocol: 'openai',
    reasoningMode: 'model',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen3.7-plus',
    models: ['qwen3.8-max', 'qwen3.7-plus', 'qwen3.8-flash'],
    note: 'DashScope 兼容接口 · 海外或 Workspace 请修改地址',
  },
  {
    id: 'moonshot',
    label: 'Moonshot Kimi',
    protocol: 'openai',
    reasoningMode: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'kimi-k3.1-pro',
    models: ['kimi-k3.1-pro', 'kimi-k3.1-pro-highspeed', 'kimi-k3'],
    note: '国内 API · Kimi K3.1 系列',
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    protocol: 'openai',
    reasoningMode: 'model',
    baseUrl: 'https://api.minimax.io/v1',
    defaultModel: 'MiniMax-M3.1-Flash',
    models: ['MiniMax-M3.1-Flash', 'MiniMax-M3'],
    note: 'OpenAI 兼容 · M3.1 Flash 强制思考',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    protocol: 'openai',
    reasoningMode: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openrouter/auto',
    models: ['openrouter/auto', 'anthropic/claude-sonnet-5.5'],
    note: '聚合路由 · 交易审计建议选择固定模型',
  },
  {
    id: 'ccswitch',
    label: 'CCSwitch',
    protocol: 'openai',
    reasoningMode: 'openai',
    baseUrl: 'http://127.0.0.1:15721/v1',
    defaultModel: 'claude-sonnet-5-5',
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-6.1-sol', 'gemini-3.6-flash', 'deepseek-v4-pro'],
    keyOptional: true,
    note: '本地统一路由 · 模型由当前渠道决定',
  },
  {
    id: 'ollama',
    label: 'Ollama',
    protocol: 'openai',
    reasoningMode: 'model',
    baseUrl: 'http://127.0.0.1:11434/v1',
    defaultModel: 'qwen3:8b',
    models: ['qwen3:8b', 'gpt-oss:20b'],
    keyOptional: true,
    note: '本地模型 · 以已安装模型列表为准',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    protocol: 'openai',
    reasoningMode: 'model',
    baseUrl: 'http://127.0.0.1:1234/v1',
    defaultModel: 'ibm/granite-4-micro',
    models: ['ibm/granite-4-micro'],
    keyOptional: true,
    note: '本地服务 · 以已加载模型列表为准',
  },
  {
    id: 'custom',
    label: '自定义兼容接口',
    protocol: 'openai',
    reasoningMode: 'openai',
    baseUrl: 'http://127.0.0.1:8000/v1',
    defaultModel: '',
    models: [],
    keyOptional: true,
    note: '任意 OpenAI Chat Completions 兼容服务',
  },
]

export function getModelProvider(id: string) {
  return modelProviders.find((provider) => provider.id === id) || modelProviders[0]
}
