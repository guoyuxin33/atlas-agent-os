import type { AgentStrategy } from '../types'

type AgentParameter = string | number | boolean

export type AgentParameterDraft = Record<string, string>
export type AgentParameters = Record<string, AgentParameter>

export const agentStrategyDefaults = {
  'ma-crossover': { maType: 'EMA', fastPeriod: 9, slowPeriod: 21, stopPercent: 0.01 },
  donchian: { entryPeriod: 20, exitPeriod: 10, stopPercent: 0.01 },
  rsi: { period: 14, oversold: 30, overbought: 70, stopPercent: 0.01 },
  bollinger: { period: 20, stdDev: 2, stopPercent: 0.01 },
  'atr-breakout': { atrPeriod: 14, atrMultiple: 1.5 },
  supertrend: { atrPeriod: 10, multiplier: 3 },
  'macd-momentum': { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, stopPercent: 0.01 },
} satisfies Record<AgentStrategy, AgentParameters>

const parameterKeys = Object.fromEntries(
  Object.entries(agentStrategyDefaults).map(([strategy, defaults]) => [strategy, Object.keys(defaults)]),
) as Record<AgentStrategy, string[]>

export function createAgentParameterDraft(strategy: AgentStrategy, savedParams?: AgentParameters): AgentParameterDraft {
  const defaults = agentStrategyDefaults[strategy]
  return Object.fromEntries(parameterKeys[strategy].map((key) => {
    const rawValue = savedParams?.[key] ?? defaults[key as keyof typeof defaults]
    const displayValue = key === 'stopPercent' && Number.isFinite(Number(rawValue))
      ? Number((Number(rawValue) * 100).toFixed(4))
      : rawValue
    return [key, String(displayValue)]
  }))
}

export function mergeAgentParameters(
  strategy: AgentStrategy,
  previousStrategy: AgentStrategy | undefined,
  savedParams: AgentParameters | undefined,
  validatedParams: AgentParameters,
): AgentParameters {
  return {
    ...(strategy === previousStrategy ? savedParams : {}),
    ...validatedParams,
  }
}

type ValidationResult =
  | { ok: true; params: AgentParameters }
  | { ok: false; error: string }

function numericValue(
  draft: AgentParameterDraft,
  key: string,
  label: string,
  minimum: number,
  maximum: number,
  integer = false,
): number | string {
  const value = Number(draft[key])
  if (!Number.isFinite(value)) return `${label}必须是有效数字`
  if (integer && !Number.isInteger(value)) return `${label}必须是整数`
  if (value < minimum || value > maximum) return `${label}必须在 ${minimum} 到 ${maximum} 之间`
  return value
}

function stopPercent(draft: AgentParameterDraft): number | string {
  const percent = numericValue(draft, 'stopPercent', '止损比例', 0.1, 20)
  return typeof percent === 'string' ? percent : percent / 100
}

export function validateAgentParameterDraft(strategy: AgentStrategy, draft: AgentParameterDraft): ValidationResult {
  if (strategy === 'ma-crossover') {
    const maType = String(draft.maType || '').toUpperCase()
    if (!['EMA', 'SMA'].includes(maType)) return { ok: false, error: '均线类型必须是 EMA 或 SMA' }
    const fastPeriod = numericValue(draft, 'fastPeriod', '快线周期', 2, 499, true)
    if (typeof fastPeriod === 'string') return { ok: false, error: fastPeriod }
    const slowPeriod = numericValue(draft, 'slowPeriod', '慢线周期', 3, 500, true)
    if (typeof slowPeriod === 'string') return { ok: false, error: slowPeriod }
    if (slowPeriod <= fastPeriod) return { ok: false, error: '慢线周期必须大于快线周期' }
    const stop = stopPercent(draft)
    if (typeof stop === 'string') return { ok: false, error: stop }
    return { ok: true, params: { maType, fastPeriod, slowPeriod, stopPercent: stop } }
  }

  if (strategy === 'donchian') {
    const entryPeriod = numericValue(draft, 'entryPeriod', '入场周期', 3, 500, true)
    if (typeof entryPeriod === 'string') return { ok: false, error: entryPeriod }
    const exitPeriod = numericValue(draft, 'exitPeriod', '退出周期', 2, 499, true)
    if (typeof exitPeriod === 'string') return { ok: false, error: exitPeriod }
    if (exitPeriod >= entryPeriod) return { ok: false, error: '退出周期必须小于入场周期' }
    const stop = stopPercent(draft)
    if (typeof stop === 'string') return { ok: false, error: stop }
    return { ok: true, params: { entryPeriod, exitPeriod, stopPercent: stop } }
  }

  if (strategy === 'rsi') {
    const period = numericValue(draft, 'period', 'RSI 周期', 2, 500, true)
    if (typeof period === 'string') return { ok: false, error: period }
    const oversold = numericValue(draft, 'oversold', '超卖阈值', 1, 49)
    if (typeof oversold === 'string') return { ok: false, error: oversold }
    const overbought = numericValue(draft, 'overbought', '超买阈值', 51, 99)
    if (typeof overbought === 'string') return { ok: false, error: overbought }
    const stop = stopPercent(draft)
    if (typeof stop === 'string') return { ok: false, error: stop }
    return { ok: true, params: { period, oversold, overbought, stopPercent: stop } }
  }

  if (strategy === 'bollinger') {
    const period = numericValue(draft, 'period', '布林带周期', 2, 500, true)
    if (typeof period === 'string') return { ok: false, error: period }
    const stdDev = numericValue(draft, 'stdDev', '标准差倍数', 0.5, 5)
    if (typeof stdDev === 'string') return { ok: false, error: stdDev }
    const stop = stopPercent(draft)
    if (typeof stop === 'string') return { ok: false, error: stop }
    return { ok: true, params: { period, stdDev, stopPercent: stop } }
  }

  if (strategy === 'atr-breakout') {
    const atrPeriod = numericValue(draft, 'atrPeriod', 'ATR 周期', 2, 500, true)
    if (typeof atrPeriod === 'string') return { ok: false, error: atrPeriod }
    const atrMultiple = numericValue(draft, 'atrMultiple', '突破倍数', 0.1, 10)
    if (typeof atrMultiple === 'string') return { ok: false, error: atrMultiple }
    return { ok: true, params: { atrPeriod, atrMultiple } }
  }

  if (strategy === 'supertrend') {
    const atrPeriod = numericValue(draft, 'atrPeriod', 'ATR 周期', 2, 100, true)
    if (typeof atrPeriod === 'string') return { ok: false, error: atrPeriod }
    const multiplier = numericValue(draft, 'multiplier', 'Supertrend 倍数', 0.5, 10)
    if (typeof multiplier === 'string') return { ok: false, error: multiplier }
    return { ok: true, params: { atrPeriod, multiplier } }
  }

  const fastPeriod = numericValue(draft, 'fastPeriod', '快线周期', 2, 100, true)
  if (typeof fastPeriod === 'string') return { ok: false, error: fastPeriod }
  const slowPeriod = numericValue(draft, 'slowPeriod', '慢线周期', 3, 300, true)
  if (typeof slowPeriod === 'string') return { ok: false, error: slowPeriod }
  if (slowPeriod <= fastPeriod) return { ok: false, error: '慢线周期必须大于快线周期' }
  const signalPeriod = numericValue(draft, 'signalPeriod', '信号周期', 2, 100, true)
  if (typeof signalPeriod === 'string') return { ok: false, error: signalPeriod }
  const stop = stopPercent(draft)
  if (typeof stop === 'string') return { ok: false, error: stop }
  return { ok: true, params: { fastPeriod, slowPeriod, signalPeriod, stopPercent: stop } }
}
