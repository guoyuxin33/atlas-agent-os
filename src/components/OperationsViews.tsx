import { useMemo, useState } from 'react'
import { ArrowDownRight, ArrowUpRight, BarChart3, CheckCircle2, ChevronDown, Clock3, Filter, History, Play, Plus, RefreshCw, Search, SlidersHorizontal, Trash2 } from 'lucide-react'
import { runBacktest, validateBacktestStrategy, type BacktestResult, type BacktestStrategyConfig, type BacktestStrategyKind } from '../lib/backtest'
import type { AccountSnapshot, AgentEvent, Environment, MarketInterval, MarketTick, MarketType, TradingOrder } from '../types'
import { Modal } from './Modal'

const STRATEGY_STORAGE_KEY = 'atlas-strategy-library-v1'

interface BacktestRiskConfig {
  stopLossPercent: number
  takeProfitPercent: number
  trailingStopPercent: number
  positionSize: number
  leverage: number
  slippageBps: number
  fundingRateBpsPer8Hours: number
}

type StrategyConfig = BacktestStrategyConfig & BacktestRiskConfig
type RichBacktestResult = BacktestResult

const defaultRiskConfig: BacktestRiskConfig = {
  stopLossPercent: 0.01,
  takeProfitPercent: 0,
  trailingStopPercent: 0,
  positionSize: 1,
  leverage: 1,
  slippageBps: 2,
  fundingRateBpsPer8Hours: 1,
}

const defaultStrategies: StrategyConfig[] = [
  { id: 'ma-crossover', name: '均线趋势跟随', kind: 'ma-crossover', primaryPeriod: 9, secondaryPeriod: 21, maType: 'EMA', feeBps: 4, ...defaultRiskConfig },
  { id: 'rsi-reversion', name: 'RSI 均值回归', kind: 'rsi-reversion', primaryPeriod: 14, secondaryPeriod: 30, feeBps: 4, ...defaultRiskConfig },
  { id: 'donchian-breakout', name: 'Donchian 突破', kind: 'donchian-breakout', primaryPeriod: 20, secondaryPeriod: 10, feeBps: 4, ...defaultRiskConfig },
  { id: 'bollinger', name: '布林带均值回归', kind: 'bollinger', primaryPeriod: 20, secondaryPeriod: 2, feeBps: 4, ...defaultRiskConfig },
  { id: 'atr-breakout', name: 'ATR 波动突破', kind: 'atr-breakout', primaryPeriod: 14, secondaryPeriod: 1.5, feeBps: 4, ...defaultRiskConfig },
  { id: 'supertrend', name: 'Supertrend 趋势', kind: 'supertrend', primaryPeriod: 10, secondaryPeriod: 3, feeBps: 4, ...defaultRiskConfig },
  { id: 'macd-momentum', name: 'MACD 动量', kind: 'macd-momentum', primaryPeriod: 12, secondaryPeriod: 26, signalPeriod: 9, feeBps: 4, ...defaultRiskConfig },
]

const backtestKinds: BacktestStrategyKind[] = ['ma-crossover', 'donchian-breakout', 'rsi-reversion', 'bollinger', 'atr-breakout', 'supertrend', 'macd-momentum']
const defaultStrategyIds = new Set(defaultStrategies.map((strategy) => strategy.id))

type StrategyRun = RichBacktestResult & {
  environment: Environment
  marketType: MarketType
  symbol: string
  interval: MarketInterval
  sampleLimit: number
  validationSplit: number
  receivedCandles: number
  excludedOpenCandles: number
  gapCount: number
  training: RichBacktestResult
  outOfSample: RichBacktestResult
}

function normalizeStrategy(strategy: BacktestStrategyConfig & Partial<BacktestRiskConfig>): StrategyConfig {
  return { ...defaultRiskConfig, ...strategy }
}

function loadStrategies() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STRATEGY_STORAGE_KEY) || 'null')
    if (!Array.isArray(parsed) || !parsed.length) return defaultStrategies.map((strategy) => ({ ...strategy }))
    const valid = parsed.flatMap((strategy): StrategyConfig[] => {
      try {
        const normalized = normalizeStrategy(strategy)
        validateBacktestStrategy(normalized)
        validateRiskConfig(normalized)
        return typeof normalized.id === 'string' && backtestKinds.includes(normalized.kind) ? [normalized] : []
      } catch {
        return []
      }
    })
    if (!valid.length) return defaultStrategies.map((strategy) => ({ ...strategy }))
    const savedIds = new Set(valid.map((strategy) => strategy.id))
    return [...valid, ...defaultStrategies.filter((strategy) => !savedIds.has(strategy.id)).map((strategy) => ({ ...strategy }))]
  } catch {
    return defaultStrategies.map((strategy) => ({ ...strategy }))
  }
}

function kindLabel(kind: BacktestStrategyKind) {
  if (kind === 'ma-crossover') return '均线交叉'
  if (kind === 'rsi-reversion') return 'RSI 回归'
  if (kind === 'donchian-breakout') return 'Donchian 突破'
  if (kind === 'bollinger') return '布林带回归'
  if (kind === 'atr-breakout') return 'ATR 突破'
  if (kind === 'supertrend') return 'Supertrend'
  return 'MACD 动量'
}

function periodLabels(kind: BacktestStrategyKind) {
  if (kind === 'ma-crossover') return ['快线周期', '慢线周期']
  if (kind === 'rsi-reversion') return ['RSI 周期', '超买卖阈值']
  if (kind === 'donchian-breakout') return ['突破周期', '退出周期']
  if (kind === 'bollinger') return ['布林带周期', '标准差倍数']
  if (kind === 'atr-breakout') return ['ATR 周期', '突破倍数']
  if (kind === 'supertrend') return ['ATR 周期', 'ATR 倍数']
  return ['MACD 快线周期', 'MACD 慢线周期（信号线 9）']
}

function defaultPeriods(kind: BacktestStrategyKind) {
  if (kind === 'rsi-reversion') return { primaryPeriod: 14, secondaryPeriod: 30 }
  if (kind === 'donchian-breakout') return { primaryPeriod: 20, secondaryPeriod: 10 }
  if (kind === 'bollinger') return { primaryPeriod: 20, secondaryPeriod: 2 }
  if (kind === 'atr-breakout') return { primaryPeriod: 14, secondaryPeriod: 1.5 }
  if (kind === 'supertrend') return { primaryPeriod: 10, secondaryPeriod: 3 }
  if (kind === 'macd-momentum') return { primaryPeriod: 12, secondaryPeriod: 26 }
  return { primaryPeriod: 9, secondaryPeriod: 21 }
}

function secondaryPeriodControl(kind: BacktestStrategyKind) {
  if (kind === 'rsi-reversion') return { min: 2, max: 49, step: 1, suffix: '%' }
  if (kind === 'bollinger') return { min: 0.5, max: 10, step: 0.1, suffix: 'σ' }
  if (kind === 'atr-breakout') return { min: 0.1, max: 10, step: 0.1, suffix: 'ATR' }
  if (kind === 'supertrend') return { min: 0.5, max: 10, step: 0.1, suffix: 'ATR' }
  return { min: 2, max: 500, step: 1, suffix: '根' }
}

function usesFractionalSecondaryPeriod(kind: BacktestStrategyKind) {
  return kind === 'bollinger' || kind === 'atr-breakout' || kind === 'supertrend'
}

function percent(value: number, signed = false) {
  return `${signed && value >= 0 ? '+' : ''}${(value * 100).toFixed(2)}%`
}

const intervalMilliseconds: Record<MarketInterval, number> = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
}

function sampleSpan(interval: MarketInterval, count: number) {
  const days = (intervalMilliseconds[interval] * count) / 86_400_000
  if (days >= 730) return `约 ${(days / 365).toFixed(1)} 年`
  if (days >= 2) return `约 ${Math.round(days)} 天`
  return `约 ${Math.max(1, Math.round(days * 24))} 小时`
}

function dateRange(result: BacktestResult) {
  const options: Intl.DateTimeFormatOptions = { year: '2-digit', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }
  return `${new Date(result.startedAt).toLocaleString('zh-CN', options)} - ${new Date(result.endedAt).toLocaleString('zh-CN', options)}`
}

function marketDataSource(environment: Environment) {
  return environment === 'testnet' ? 'Binance Testnet 公共行情' : 'Binance Live 公共行情'
}

function exitReasonLabel(reason: BacktestResult['trades'][number]['exitReason']) {
  if (reason === 'stop-loss') return '固定止损'
  if (reason === 'take-profit') return '固定止盈'
  if (reason === 'trailing-stop') return '移动止损'
  if (reason === 'liquidation') return '权益归零'
  if (reason === 'end-of-data') return '数据结束'
  return '反向/离场信号'
}

function EquityCurve({ result }: { result: BacktestResult }) {
  const width = 720
  const height = 168
  const padding = 12
  const values = result.equityCurve.map((point) => point.equity)
  const minimum = Math.min(...values, 1)
  const maximum = Math.max(...values, 1)
  const range = Math.max(maximum - minimum, 0.0001)
  const points = values.map((value, index) => {
    const x = padding + (index / Math.max(1, values.length - 1)) * (width - padding * 2)
    const y = height - padding - ((value - minimum) / range) * (height - padding * 2)
    return `${x.toFixed(2)},${y.toFixed(2)}`
  }).join(' ')
  const baselineY = height - padding - ((1 - minimum) / range) * (height - padding * 2)

  return <div className="backtest-equity-chart">
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="留出区间权益曲线">
      <line x1={padding} x2={width - padding} y1={baselineY} y2={baselineY} />
      <polyline points={points} />
    </svg>
    <div><span>{percent(maximum - 1, true)} 峰值收益</span><span>{percent(minimum - 1, true)} 最低收益</span></div>
  </div>
}

function finiteMetric(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function ratio(value: number | null | undefined) {
  const metric = finiteMetric(value)
  return metric === null ? '--' : metric.toFixed(2)
}

function profitFactor(result: BacktestResult | undefined) {
  if (!result || !result.tradeCount) return '--'
  return result.profitFactor === null ? result.grossProfit > 0 ? '∞' : '--' : ratio(result.profitFactor)
}

function validateRiskConfig(config: StrategyConfig) {
  if (!Number.isFinite(config.stopLossPercent) || config.stopLossPercent < 0 || config.stopLossPercent > 1) throw new Error('固定止损必须在 0% 到 100% 之间')
  if (!Number.isFinite(config.takeProfitPercent) || config.takeProfitPercent < 0 || config.takeProfitPercent > 2) throw new Error('固定止盈必须在 0% 到 200% 之间')
  if (!Number.isFinite(config.trailingStopPercent) || config.trailingStopPercent < 0 || config.trailingStopPercent > 1) throw new Error('移动止损必须在 0% 到 100% 之间')
  if (!Number.isFinite(config.positionSize) || config.positionSize <= 0 || config.positionSize > 1) throw new Error('仓位必须大于 0% 且不超过 100%')
  if (!Number.isInteger(config.leverage) || config.leverage < 1 || config.leverage > 125) throw new Error('合约杠杆必须是 1 到 125 的整数')
  if (!Number.isFinite(config.slippageBps) || config.slippageBps < 0 || config.slippageBps > 100) throw new Error('滑点必须在 0 到 100 bps 之间')
  if (!Number.isFinite(config.fundingRateBpsPer8Hours) || Math.abs(config.fundingRateBpsPer8Hours) > 100) throw new Error('每 8 小时资金费率估算必须在 -100 到 100 bps 之间')
}

interface StrategiesViewProps {
  environment: Environment
  marketType: MarketType
  symbol: string
  interval: MarketInterval
  onToast: (message: string) => void
}

export function StrategiesView({ environment, marketType, symbol, interval, onToast }: StrategiesViewProps) {
  const [running, setRunning] = useState<string | null>(null)
  const [strategies, setStrategies] = useState<StrategyConfig[]>(loadStrategies)
  const [results, setResults] = useState<Record<string, StrategyRun>>({})
  const [detail, setDetail] = useState<{ strategy: StrategyConfig; result: StrategyRun } | null>(null)
  const [draft, setDraft] = useState<StrategyConfig | null>(null)
  const [backtestInterval, setBacktestInterval] = useState<MarketInterval>(interval === '1m' ? '15m' : interval)
  const [sampleLimit, setSampleLimit] = useState(5000)
  const [validationSplit, setValidationSplit] = useState(30)

  const persistStrategies = (next: StrategyConfig[]) => {
    setStrategies(next)
    try {
      window.localStorage.setItem(STRATEGY_STORAGE_KEY, JSON.stringify(next))
    } catch {
      onToast('策略已更新，但本地存储不可用')
    }
  }

  const saveDraft = () => {
    if (!draft) return
    try {
      const normalized = {
        ...draft,
        name: draft.name.trim(),
        primaryPeriod: Math.round(draft.primaryPeriod),
        secondaryPeriod: usesFractionalSecondaryPeriod(draft.kind) ? Number(draft.secondaryPeriod.toFixed(2)) : Math.round(draft.secondaryPeriod),
        stopLossPercent: Number(draft.stopLossPercent.toFixed(4)),
        takeProfitPercent: Number(draft.takeProfitPercent.toFixed(4)),
        trailingStopPercent: Number(draft.trailingStopPercent.toFixed(4)),
        positionSize: Number(draft.positionSize.toFixed(4)),
        leverage: Math.round(draft.leverage),
        slippageBps: Number(draft.slippageBps.toFixed(2)),
        fundingRateBpsPer8Hours: Number(draft.fundingRateBpsPer8Hours.toFixed(4)),
      }
      validateBacktestStrategy(normalized)
      validateRiskConfig(normalized)
      const exists = strategies.some((strategy) => strategy.id === normalized.id)
      persistStrategies(exists ? strategies.map((strategy) => strategy.id === normalized.id ? normalized : strategy) : [...strategies, normalized])
      setResults((current) => {
        const next = { ...current }
        delete next[normalized.id]
        return next
      })
      setDraft(null)
      onToast(`${normalized.name} 已保存，请重新运行回测`)
    } catch (caught) {
      onToast(caught instanceof Error ? caught.message : '策略参数无效')
    }
  }

  const removeDraft = () => {
    if (!draft || !strategies.some((strategy) => strategy.id === draft.id)) return
    persistStrategies(strategies.filter((strategy) => strategy.id !== draft.id))
    setResults((current) => {
      const next = { ...current }
      delete next[draft.id]
      return next
    })
    setDraft(null)
    onToast(`${draft.name} 已从本地策略库删除`)
  }

  const backtest = async (strategy: StrategyConfig) => {
    if (!window.atlas?.market) {
      onToast('真实历史行情需要在 Atlas 桌面应用中运行')
      return
    }
    setRunning(strategy.id)
    try {
      const configuredStrategy = { ...strategy, leverage: marketType === 'spot' ? 1 : strategy.leverage } as StrategyConfig
      validateRiskConfig(configuredStrategy)
      const received = await window.atlas.market.history({ environment, marketType, symbol, interval: backtestInterval, limit: sampleLimit + 1 })
      const closedBefore = Date.now()
      const closedCandles = received.filter((candle) => candle.time * 1000 + intervalMilliseconds[backtestInterval] <= closedBefore)
      const candles = closedCandles.slice(-sampleLimit)
      const excludedOpenCandles = received.length - closedCandles.length
      const expectedStep = intervalMilliseconds[backtestInterval] / 1000
      const gapCount = candles.slice(1).filter((candle, index) => candle.time - candles[index].time !== expectedStep).length
      const splitIndex = Math.floor(candles.length * (1 - validationSplit / 100))
      const trainingCandles = candles.slice(0, splitIndex)
      const training = runBacktest(trainingCandles, configuredStrategy, marketType)
      const outOfSample = runBacktest(candles, configuredStrategy, marketType, { evaluationStartIndex: splitIndex })
      const result = runBacktest(candles, configuredStrategy, marketType)
      setResults((current) => ({
        ...current,
        [strategy.id]: {
          ...result,
          environment,
          marketType,
          symbol,
          interval: backtestInterval,
          sampleLimit,
          validationSplit,
          receivedCandles: candles.length,
          excludedOpenCandles,
          gapCount,
          training,
          outOfSample,
        },
      }))
      onToast(`${strategy.name} 留出验证完成 · ${outOfSample.sampleCount.toLocaleString('en-US')} 根验证 K 线 · ${outOfSample.tradeCount} 笔交易`)
    } catch (caught) {
      onToast(caught instanceof Error ? caught.message : '历史回测失败')
    } finally {
      setRunning(null)
    }
  }

  const createStrategy = () => setDraft({ id: `strategy-${Date.now()}`, name: '新策略', kind: 'ma-crossover', primaryPeriod: 9, secondaryPeriod: 21, maType: 'EMA', feeBps: 4, ...defaultRiskConfig })
  const detailValidation = detail?.result.outOfSample
  const detailLongTrades = detailValidation?.trades.filter((trade) => trade.direction === 'long').length || 0
  const detailShortTrades = detailValidation?.trades.filter((trade) => trade.direction === 'short').length || 0
  const detailExitCounts = detailValidation?.trades.reduce((counts, trade) => {
    counts[trade.exitReason] += 1
    return counts
  }, { signal: 0, 'stop-loss': 0, 'take-profit': 0, 'trailing-stop': 0, liquidation: 0, 'end-of-data': 0 })

  return <main className="page">
    <section className="page-heading"><div><span className="section-kicker">可验证交易逻辑</span><h1>策略库</h1><p>使用 {symbol} {backtestInterval} 公开历史 K 线进行本地留出验证，不提交订单</p></div><button className="primary-button" onClick={createStrategy}><Plus size={16} />新建策略</button></section>
    <section className="backtest-controls panel">
      <div className="backtest-control-copy"><strong>{symbol} · {marketType === 'spot' ? '现货' : 'USDT 永续'}</strong><span>{sampleLimit.toLocaleString('en-US')} 根 {backtestInterval} K 线 · {sampleSpan(backtestInterval, sampleLimit)} · 后 {validationSplit}% 留出验证</span></div>
      <div className="backtest-control-fields">
        <label><span>回测周期</span><select className="select-field" value={backtestInterval} onChange={(event) => setBacktestInterval(event.target.value as MarketInterval)}>{(['1m', '5m', '15m', '1h', '4h', '1d'] as MarketInterval[]).map((value) => <option value={value} key={value}>{value}</option>)}</select></label>
        <label><span>样本区间</span><select className="select-field" value={sampleLimit} onChange={(event) => setSampleLimit(Number(event.target.value))}>{[1000, 2000, 5000, 10000].map((value) => <option value={value} key={value}>{value.toLocaleString('en-US')} 根 · {sampleSpan(backtestInterval, value)}</option>)}</select></label>
        <label><span>留出区间</span><select className="select-field" value={validationSplit} onChange={(event) => setValidationSplit(Number(event.target.value))}>{[20, 30, 40].map((value) => <option value={value} key={value}>后 {value}% 验证集</option>)}</select></label>
      </div>
    </section>
    <div className="strategy-grid">{strategies.map((strategy) => {
      const storedResult = results[strategy.id]
      const result = storedResult?.environment === environment
        && storedResult.marketType === marketType
        && storedResult.symbol === symbol
        && storedResult.interval === backtestInterval
        && storedResult.sampleLimit === sampleLimit
        && storedResult.validationSplit === validationSplit
        ? storedResult
        : undefined
      const validation = result?.outOfSample
      const drag = validation ? validation.costDrag : null
      const hasTrades = Boolean(validation?.tradeCount)
      const lowSample = Boolean(validation && validation.tradeCount < 30)
      return <article className="strategy-card panel" key={strategy.id}>
        <header><span className="strategy-state">{result ? `后 ${result.validationSplit}% 探索性留出 · ${new Date(result.generatedAt).toLocaleTimeString('zh-CN', { hour12: false })}` : '等待探索性留出回测'}</span><button className="icon-button" onClick={() => setDraft({ ...strategy })} aria-label={`配置${strategy.name}`} title="编辑策略参数"><SlidersHorizontal size={16} /></button></header>
        <h2>{strategy.name}</h2><p>{kindLabel(strategy.kind)} · {symbol} · {marketType === 'spot' ? '现货' : `${strategy.leverage}x 永续`} · {backtestInterval}</p>
        {result && <div className="backtest-sample">
          <div><strong>样本内 {100 - result.validationSplit}% · {result.training.sampleCount.toLocaleString('en-US')} 根 · {sampleSpan(result.interval, result.training.sampleCount)}</strong><span>{dateRange(result.training)}</span></div>
          <div><strong>探索性留出 {result.validationSplit}% · {validation!.sampleCount.toLocaleString('en-US')} 根 · {sampleSpan(result.interval, validation!.sampleCount)}</strong><span>{dateRange(validation!)}</span></div>
          <small>本地时区 · {marketDataSource(result.environment)} · 已闭合 {result.receivedCandles.toLocaleString('en-US')} 根 · 1 根信号预热 · 缺口 {result.gapCount} · 排除未闭合 {result.excludedOpenCandles}</small>
        </div>}
        {validation && <div className="backtest-assumptions">
          <span>单边手续费 {validation.assumptions.feeBps.toFixed(1)} bps</span>
          <span>滑点 {validation.assumptions.slippageBps.toFixed(1)} bps</span>
          <span>仓位 {percent(validation.assumptions.positionSize)}</span>
          <span>有效敞口 {(validation.assumptions.positionSize * validation.assumptions.leverage).toFixed(2)}x</span>
          {marketType === 'futures' && <span>资金费 {validation.assumptions.fundingRateBpsPer8Hours.toFixed(1)} bps / 8h</span>}
        </div>}
        {lowSample && <div className="backtest-warning">{hasTrades ? `留出区间仅 ${validation!.tradeCount} 笔交易，胜率与年化 Sharpe 不稳定` : '留出区间没有成交，胜率、期望与 Sharpe 不可计算'}</div>}
        {result && result.gapCount > 0 && <div className="backtest-warning">历史序列检测到 {result.gapCount} 处 K 线缺口，本次结果可能低估滑点、风险或信号变化。</div>}
        <div className="strategy-metrics">
          <div><span>留出净收益</span><strong className={validation ? validation.totalReturn >= 0 ? 'text-positive' : 'text-negative' : ''}>{validation ? percent(validation.totalReturn, true) : '--'}</strong></div>
          <div><span title="同期标的 1x 多头，不计手续费、滑点和资金费">标的 1x 多头基准</span><strong className={validation ? (validation.benchmarkReturn || 0) >= 0 ? 'text-positive' : 'text-negative' : ''}>{validation ? percent(validation.benchmarkReturn || 0, true) : '--'}</strong></div>
          <div><span title="包含持仓期间盘中不利价格的最大权益回撤">最大回撤</span><strong className={validation ? 'text-negative' : ''}>{validation ? percent(-validation.maxDrawdown) : '--'}</strong></div>
          <div><span title="盈利交易数 / 已平仓交易数">胜率</span><strong>{hasTrades ? percent(validation!.winRate) : '--'}</strong></div>
          <div><span title="净盈利总额 / 净亏损绝对值；无亏损交易时为无穷大">Profit factor</span><strong>{profitFactor(validation)}</strong></div>
          <div><span title="每笔已平仓交易净收益率的算术平均">单笔期望</span><strong>{hasTrades && finiteMetric(validation!.expectancy) !== null ? percent(validation!.expectancy, true) : '--'}</strong></div>
          <div><span title="平均盈利 / 平均亏损绝对值">盈亏比</span><strong>{hasTrades ? ratio(validation!.payoffRatio) : '--'}</strong></div>
          <div><span>成本拖累</span><strong className={drag === null ? '' : drag > 0 ? 'text-negative' : 'text-positive'}>{drag === null ? '--' : percent(-drag, true)}</strong></div>
          <div><span>交易数</span><strong>{validation ? validation.tradeCount.toLocaleString('en-US') : '--'}</strong></div>
          <div><span title="按 K 线权益收益年化，无风险利率按 0；短样本不稳定">Sharpe</span><strong>{hasTrades ? ratio(validation!.sharpeRatio) : '--'}</strong></div>
          <div><span>平均盈利</span><strong className={hasTrades ? 'text-positive' : ''}>{validation?.winningTrades ? percent(validation.averageWin, true) : '--'}</strong></div>
          <div><span>平均亏损</span><strong className={hasTrades ? 'text-negative' : ''}>{validation && validation.tradeCount > validation.winningTrades ? percent(validation.averageLoss, true) : '--'}</strong></div>
        </div>
        {marketType === 'futures' && validation && <p className="backtest-model-note">近似零权益强平模型，不区分逐仓/全仓，也不等同于 Binance 维持保证金档位。</p>}
        <div className="strategy-card-actions">
          {result && <button className="secondary-button" onClick={() => setDetail({ strategy, result })}>逐笔与权益<ChevronDown size={15} /></button>}
          <button className="secondary-button" onClick={() => void backtest(strategy)} disabled={running !== null}>{running === strategy.id ? <RefreshCw className="spin" size={15} /> : <Play size={15} />}{running === strategy.id ? `读取 ${sampleLimit.toLocaleString('en-US')} 根 K 线` : '运行探索性留出'}</button>
        </div>
      </article>
    })}</div>
    {detail && detailValidation && <Modal title={`${detail.strategy.name} · 留出区间明细`} subtitle={`${detail.result.symbol} ${detail.result.interval} · ${marketDataSource(detail.result.environment)} · 本地计算，不提交订单`} onClose={() => setDetail(null)} wide>
      <div className="backtest-detail">
        <div className="backtest-detail-summary">
          <div><span>净收益</span><strong className={detailValidation.totalReturn >= 0 ? 'text-positive' : 'text-negative'}>{percent(detailValidation.totalReturn, true)}</strong></div>
          <div><span>盘中最大回撤</span><strong className="text-negative">{percent(-detailValidation.maxDrawdown)}</strong></div>
          <div><span>多 / 空交易</span><strong>{detailLongTrades} / {detailShortTrades}</strong></div>
          <div><span>退出分布 · 合计 {detailValidation.tradeCount}</span><strong>信号 {detailExitCounts?.signal} · 固止 {detailExitCounts?.['stop-loss']} · 移止 {detailExitCounts?.['trailing-stop']} · 止盈 {detailExitCounts?.['take-profit']} · 归零 {detailExitCounts?.liquidation} · 结束 {detailExitCounts?.['end-of-data']}</strong></div>
        </div>
        <section className="backtest-detail-section">
          <header><div><h3>权益曲线</h3><p>{dateRange(detailValidation)} · 收盘权益点；最大回撤额外计入盘中不利价格</p></div></header>
          <EquityCurve result={detailValidation} />
        </section>
        <section className="backtest-detail-section">
          <header><div><h3>成交与风险假设</h3><p>下一根开盘参考价成交，滑点和手续费按不利成交价计入</p></div></header>
          <div className="backtest-detail-assumptions">
            <span>仓位 {percent(detailValidation.assumptions.positionSize)}</span>
            <span>杠杆 {detailValidation.assumptions.leverage}x</span>
            <span>有效敞口 {(detailValidation.assumptions.positionSize * detailValidation.assumptions.leverage).toFixed(2)}x</span>
            <span>手续费 {detailValidation.assumptions.feeBps.toFixed(1)} bps / 边</span>
            <span>滑点 {detailValidation.assumptions.slippageBps.toFixed(1)} bps / 边</span>
            {detail.result.marketType === 'futures' && <span>静态资金费 {detailValidation.assumptions.fundingRateBpsPer8Hours.toFixed(1)} bps / 8h</span>}
          </div>
        </section>
        <section className="backtest-detail-section">
          <header><div><h3>逐笔交易</h3><p>价格为策略参考价；净收益已扣手续费、滑点与资金费</p></div><strong>{detailValidation.tradeCount} 笔</strong></header>
          {detailValidation.trades.length ? <div className="backtest-trade-table"><table>
            <thead><tr><th>方向</th><th>入场</th><th>出场</th><th>持有</th><th>净收益</th><th>MFE / MAE</th><th>退出原因</th></tr></thead>
            <tbody>{detailValidation.trades.map((trade, index) => <tr key={`${trade.entryTime}-${index}`}>
              <td>{trade.direction === 'long' ? '多' : '空'}</td>
              <td><strong>{trade.entryPrice.toLocaleString('en-US', { maximumFractionDigits: 6 })}</strong><span>{new Date(trade.entryTime).toLocaleString('zh-CN', { hour12: false })}</span></td>
              <td><strong>{trade.exitPrice.toLocaleString('en-US', { maximumFractionDigits: 6 })}</strong><span>{new Date(trade.exitTime).toLocaleString('zh-CN', { hour12: false })}</span></td>
              <td>{trade.barsHeld} 根</td>
              <td className={trade.netReturn >= 0 ? 'text-positive' : 'text-negative'}>{percent(trade.netReturn, true)}</td>
              <td>{percent(trade.maximumFavorableExcursion, true)} / {percent(trade.maximumAdverseExcursion, true)}</td>
              <td>{exitReasonLabel(trade.exitReason)}</td>
            </tr>)}</tbody>
          </table></div> : <div className="backtest-detail-empty">该留出区间没有产生交易。</div>}
        </section>
      </div>
    </Modal>}
    {draft && <Modal title={strategies.some((strategy) => strategy.id === draft.id) ? '编辑策略参数' : '新建本地策略'} subtitle="配置保存在本机；手续费、滑点与资金费率均为回测假设" onClose={() => setDraft(null)} wide><div className="strategy-config-grid">
      <div className="strategy-field-wide"><label className="field-label" htmlFor="strategy-name">策略名称</label><div className="input-shell"><input id="strategy-name" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></div></div>
      <div className="strategy-field-wide"><label className="field-label" htmlFor="strategy-kind">策略逻辑</label><select id="strategy-kind" className="select-field" value={draft.kind} onChange={(event) => { const kind = event.target.value as BacktestStrategyKind; setDraft({ ...draft, kind, ...defaultPeriods(kind), maType: kind === 'ma-crossover' ? draft.maType || 'EMA' : undefined, signalPeriod: kind === 'macd-momentum' ? draft.signalPeriod || 9 : undefined }) }}>{backtestKinds.map((kind) => <option key={kind} value={kind}>{kindLabel(kind)}</option>)}</select></div>
      <div><label className="field-label" htmlFor="strategy-primary">{periodLabels(draft.kind)[0]}</label><div className="input-shell"><input id="strategy-primary" type="number" min="2" max="500" value={draft.primaryPeriod} onChange={(event) => setDraft({ ...draft, primaryPeriod: Number(event.target.value) })} /><span>根</span></div></div>
      <div><label className="field-label" htmlFor="strategy-secondary">{periodLabels(draft.kind)[1]}</label><div className="input-shell"><input id="strategy-secondary" type="number" min={secondaryPeriodControl(draft.kind).min} max={secondaryPeriodControl(draft.kind).max} step={secondaryPeriodControl(draft.kind).step} value={draft.secondaryPeriod} onChange={(event) => setDraft({ ...draft, secondaryPeriod: Number(event.target.value) })} /><span>{secondaryPeriodControl(draft.kind).suffix}</span></div></div>
      {draft.kind === 'ma-crossover' && <div><label className="field-label" htmlFor="strategy-ma-type">均线类型</label><select id="strategy-ma-type" className="select-field" value={draft.maType || 'EMA'} onChange={(event) => setDraft({ ...draft, maType: event.target.value as 'EMA' | 'SMA' })}><option value="EMA">EMA 指数均线</option><option value="SMA">SMA 简单均线</option></select></div>}
      {draft.kind === 'macd-momentum' && <div><label className="field-label" htmlFor="strategy-signal-period">MACD 信号周期</label><div className="input-shell"><input id="strategy-signal-period" type="number" min="2" max="100" step="1" value={draft.signalPeriod || 9} onChange={(event) => setDraft({ ...draft, signalPeriod: Number(event.target.value) })} /><span>根</span></div></div>}
      <header className="strategy-config-heading"><strong>风险与成交假设</strong><span>{marketType === 'spot' ? '现货 · 1x' : 'USDT 永续'}</span></header>
      <div><label className="field-label" htmlFor="strategy-stop-loss">固定止损</label><div className="input-shell"><input id="strategy-stop-loss" type="number" min="0" max="100" step="0.1" value={Number((draft.stopLossPercent * 100).toFixed(4))} onChange={(event) => setDraft({ ...draft, stopLossPercent: Number(event.target.value) / 100 })} /><span>%</span></div></div>
      <div><label className="field-label" htmlFor="strategy-take-profit">固定止盈</label><div className="input-shell"><input id="strategy-take-profit" type="number" min="0" max="200" step="0.1" value={Number((draft.takeProfitPercent * 100).toFixed(4))} onChange={(event) => setDraft({ ...draft, takeProfitPercent: Number(event.target.value) / 100 })} /><span>%</span></div></div>
      <div><label className="field-label" htmlFor="strategy-trailing-stop">移动止损</label><div className="input-shell"><input id="strategy-trailing-stop" type="number" min="0" max="100" step="0.1" value={Number((draft.trailingStopPercent * 100).toFixed(4))} onChange={(event) => setDraft({ ...draft, trailingStopPercent: Number(event.target.value) / 100 })} /><span>%</span></div></div>
      <div><label className="field-label" htmlFor="strategy-position-size">仓位比例</label><div className="input-shell"><input id="strategy-position-size" type="number" min="0.1" max="100" step="0.1" value={Number((draft.positionSize * 100).toFixed(4))} onChange={(event) => setDraft({ ...draft, positionSize: Number(event.target.value) / 100 })} /><span>% 净值</span></div></div>
      <div><label className="field-label" htmlFor="strategy-leverage">合约杠杆</label><div className={`input-shell ${marketType === 'spot' ? 'input-disabled' : ''}`}><input id="strategy-leverage" type="number" min="1" max="125" step="1" value={marketType === 'spot' ? 1 : draft.leverage} onChange={(event) => setDraft({ ...draft, leverage: Number(event.target.value) })} disabled={marketType === 'spot'} /><span>x</span></div></div>
      <div><label className="field-label" htmlFor="strategy-fee">单边手续费</label><div className="input-shell"><input id="strategy-fee" type="number" min="0" max="100" step="0.1" value={draft.feeBps} onChange={(event) => setDraft({ ...draft, feeBps: Number(event.target.value) })} /><span>bps</span></div></div>
      <div><label className="field-label" htmlFor="strategy-slippage">单边滑点</label><div className="input-shell"><input id="strategy-slippage" type="number" min="0" max="100" step="0.1" value={draft.slippageBps} onChange={(event) => setDraft({ ...draft, slippageBps: Number(event.target.value) })} /><span>bps</span></div></div>
      <div><label className="field-label" htmlFor="strategy-funding">资金费率估算（每 8 小时）</label><div className={`input-shell ${marketType === 'spot' ? 'input-disabled' : ''}`}><input id="strategy-funding" type="number" min="-100" max="100" step="0.1" value={marketType === 'spot' ? 0 : draft.fundingRateBpsPer8Hours} onChange={(event) => setDraft({ ...draft, fundingRateBpsPer8Hours: Number(event.target.value) })} disabled={marketType === 'spot'} /><span>bps</span></div></div>
      <div className="modal-actions strategy-field-wide">{strategies.some((strategy) => strategy.id === draft.id) && !defaultStrategyIds.has(draft.id) && <button className="danger-button" onClick={removeDraft}><Trash2 size={15} />删除</button>}<button className="secondary-button" onClick={() => setDraft(null)}>取消</button><button className="primary-button" onClick={saveDraft}>保存策略</button></div>
    </div></Modal>}
  </main>
}

interface OrdersViewProps {
  environment: Environment
  marketType: MarketType
  symbol: string
  tick: MarketTick
  account: AccountSnapshot | null
  orders: TradingOrder[]
  loading: boolean
  onRefresh: () => Promise<boolean>
  onToast: (message: string) => void
}

function finiteValue(value: string | number | undefined) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function isClosingOrder(order: TradingOrder) {
  if (order.marketType === 'spot') return order.side === 'SELL'
  if (order.reduceOnly) return true
  if (order.positionSide === 'LONG') return order.side === 'SELL'
  if (order.positionSide === 'SHORT') return order.side === 'BUY'
  return false
}

function orderFillPrice(order: TradingOrder) {
  const executed = finiteValue(order.executedQty)
  const quote = finiteValue(order.cummulativeQuoteQty)
  if (executed && quote) return quote / executed
  return finiteValue(order.avgPrice) || finiteValue(order.price) || finiteValue(order.marketPrice)
}

function orderPnl(order: TradingOrder, markPrice: number, allocatedQuantity: number) {
  const explicitNet = finiteValue(order.netPnl)
  const explicitRealized = finiteValue(order.realizedPnl)
  const explicitUnrealized = finiteValue(order.unrealizedPnl)
  const closing = isClosingOrder(order)
  if (explicitNet !== null) return { value: explicitNet, label: '净已实现', estimated: false }
  if (explicitRealized !== null && (closing || Math.abs(explicitRealized) > 1e-12)) return { value: explicitRealized, label: '已实现', estimated: false }
  if (explicitUnrealized !== null) return { value: explicitUnrealized, label: '浮动', estimated: false }
  if (order.status !== 'FILLED') return null
  if (closing) return explicitRealized !== null ? { value: explicitRealized, label: '已实现', estimated: false } : null
  const fillPrice = orderFillPrice(order)
  if (!(fillPrice && allocatedQuantity > 0 && markPrice > 0)) return null
  const direction = order.side === 'BUY' ? 1 : -1
  return { value: (markPrice - fillPrice) * allocatedQuantity * direction, label: '持仓分摊估算', estimated: true }
}

function OrderPnl({ order, markPrice, allocatedQuantity = finiteValue(order.remainingOpenQty) || 0 }: { order: TradingOrder; markPrice: number; allocatedQuantity?: number }) {
  const pnl = orderPnl(order, markPrice, allocatedQuantity)
  if (!pnl) {
    const detail = order.status !== 'FILLED'
      ? '待成交'
      : !isClosingOrder(order) && allocatedQuantity <= 0
        ? '无匹配持仓'
        : order.marketType === 'spot'
          ? '需成本账本'
          : '需成交明细'
    return <span className="order-pnl unavailable" title="Binance 订单接口无法把该笔成交安全归属到当前持仓盈亏，不展示推测数字">--<small>{detail}</small></span>
  }
  const commission = finiteValue(order.commission)
  return <span className={`order-pnl ${pnl.value >= 0 ? 'text-positive' : 'text-negative'}`} title={pnl.estimated ? `仅将当前持仓覆盖到该笔最近成交的 ${allocatedQuantity} 数量按标记价估算，未扣手续费；不是交易所成本账本` : `${pnl.label}${commission ? `；手续费 ${commission} ${order.commissionAsset || ''}` : ''}`}><strong>{pnl.value >= 0 ? '+' : '-'}${Math.abs(pnl.value).toFixed(2)}</strong><small>{pnl.label}{commission ? ` · 费 ${commission}` : ''}</small></span>
}

function openingPositionKey(order: TradingOrder) {
  if (isClosingOrder(order)) return null
  if (order.marketType === 'spot') return 'LONG'
  if (order.positionSide === 'LONG' || order.positionSide === 'SHORT') return order.positionSide
  return order.side === 'BUY' ? 'LONG' : 'SHORT'
}

function allocateCurrentPosition(orders: TradingOrder[], account: AccountSnapshot | null, symbol: string) {
  const remainingBySide = new Map<'LONG' | 'SHORT', number>()
  account?.portfolio.filter((position) => position.symbol === symbol).forEach((position) => {
    const side = position.side
    remainingBySide.set(side, (remainingBySide.get(side) || 0) + Math.abs(Number(position.quantity) || 0))
  })
  const allocations = new Map<string, number>()
  const newestFirst = [...orders].sort((left, right) => Number(right.transactTime || right.updateTime || 0) - Number(left.transactTime || left.updateTime || 0))
  newestFirst.forEach((order) => {
    if (order.status !== 'FILLED' || order.symbol !== symbol) return
    const side = openingPositionKey(order)
    if (!side) return
    const available = remainingBySide.get(side) || 0
    const backendRemaining = finiteValue(order.remainingOpenQty)
    const filled = finiteValue(order.executedQty) || finiteValue(order.quantity) || 0
    const allocated = Math.min(available, Math.max(0, backendRemaining ?? filled))
    allocations.set(String(order.orderId || order.id), allocated)
    remainingBySide.set(side, Math.max(0, available - allocated))
  })
  return allocations
}

function orderStatusLabel(status?: string) {
  if (status === 'FILLED') return '已成交'
  if (status === 'NEW') return '挂单中'
  if (status === 'PARTIALLY_FILLED') return '部分成交'
  if (status === 'CANCELED') return '已撤销'
  if (status === 'REJECTED') return '已拒绝'
  if (status === 'EXPIRED') return '已过期'
  return status || '未知'
}

export function OrdersView({ environment, marketType, symbol, tick, account, orders, loading, onRefresh, onToast }: OrdersViewProps) {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('ALL')
  const [descending, setDescending] = useState(true)

  const refresh = async () => {
    await onRefresh()
  }
  const positionAllocations = useMemo(() => allocateCurrentPosition(orders, account, symbol), [account, orders, symbol])
  const visible = useMemo(() => orders
    .filter((order) => (status === 'ALL' || order.status === status) && order.symbol.toLowerCase().includes(query.toLowerCase()))
    .sort((left, right) => (Number(right.transactTime || right.updateTime || 0) - Number(left.transactTime || left.updateTime || 0)) * (descending ? 1 : -1))
    .map((order) => ({ ...order, remainingOpenQty: String(positionAllocations.get(String(order.orderId || order.id)) || 0) })), [descending, orders, positionAllocations, query, status])

  const holdings = marketType === 'futures' ? account?.positions ?? [] : account?.balances ?? []
  const markPrice = tick.symbol === symbol && tick.connected ? tick.price : Number(account?.portfolio.find((position) => position.symbol === symbol)?.markPrice || 0)
  return <main className="page"><section className="page-heading"><div><span className="section-kicker">统一执行记录</span><h1>订单与持仓</h1><p>{environment === 'paper' ? '模拟盘' : environment === 'testnet' ? '测试网' : '生产'} · {marketType === 'spot' ? '现货' : 'USDT 永续'} · {symbol}</p></div><button className="secondary-button" onClick={refresh} disabled={loading}><RefreshCw className={loading ? 'spin' : ''} size={16} />{loading ? '同步中' : '刷新订单'}</button></section><section className="portfolio-strip"><div><span>账户权益</span><strong>${Number(account?.totalWalletBalance || account?.availableBalance || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}</strong></div><div><span>可用余额</span><strong>${Number(account?.availableBalance || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}</strong></div><div><span>未实现盈亏</span><strong className={Number(account?.unrealizedPnl || 0) >= 0 ? 'text-positive' : 'text-negative'}>{Number(account?.unrealizedPnl || 0) >= 0 ? '+' : ''}${Number(account?.unrealizedPnl || 0).toFixed(2)}</strong></div><div><span>{marketType === 'spot' ? '非零资产' : '持仓'}</span><strong>{holdings.length}</strong></div></section><section className="panel orders-panel"><header className="orders-toolbar"><div className="table-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="筛选交易对" /></div><div className="segmented compact"><button className={status === 'ALL' ? 'active' : ''} onClick={() => setStatus('ALL')}>全部</button><button className={status === 'NEW' ? 'active' : ''} onClick={() => setStatus('NEW')}>挂单</button><button className={status === 'FILLED' ? 'active' : ''} onClick={() => setStatus('FILLED')}>已成交</button></div><button className="icon-button" onClick={() => { setDescending((value) => !value); onToast(`订单已按时间${descending ? '正序' : '倒序'}排列`) }} aria-label={descending ? '改为最早订单优先' : '改为最新订单优先'} title={descending ? '当前最新优先，点击切换' : '当前最早优先，点击切换'}><Filter size={16} /></button></header><div className="data-table order-table-scroll"><div className="table-row order-table-row table-head"><span>时间</span><span>市场</span><span>方向 / 类型</span><span>成交数量</span><span>成交均价</span><span>状态</span><span>交易盈亏</span></div>{visible.length ? visible.map((order) => <div className="table-row order-table-row" key={String(order.orderId || order.id)}><span>{order.transactTime || order.updateTime ? new Date(Number(order.transactTime || order.updateTime)).toLocaleTimeString('zh-CN', { hour12: false }) : '--'}</span><strong>{order.symbol}</strong><span><i className={order.side === 'BUY' ? 'text-positive' : 'text-negative'}>{order.side === 'BUY' ? '买入' : '卖出'}</i><small>{order.type === 'MARKET' ? '市价' : '限价'}{order.reduceOnly ? ' · 只减仓' : ''}</small></span><span>{order.executedQty || order.quantity}<small>委托 {order.quantity}</small></span><span>{orderFillPrice(order)?.toLocaleString('en-US', { maximumFractionDigits: 8 }) || '市价'}<small>{markPrice > 0 ? `标记 ${markPrice.toLocaleString('en-US', { maximumFractionDigits: 8 })}` : '等待标记价'}</small></span><span>{orderStatusLabel(order.status)}</span><OrderPnl order={order} markPrice={markPrice} /></div>) : <div className="table-empty"><History size={22} /><strong>当前筛选下没有订单</strong><p>从工作台提交模拟、测试网或生产订单后会出现在这里</p></div>}</div></section></main>
}

interface ReviewViewProps {
  orders: TradingOrder[]
  agentLogs: AgentEvent[]
  onToast: (message: string) => void
}

function currentWeekStart(now = new Date()) {
  const start = new Date(now)
  const day = start.getDay() || 7
  start.setDate(start.getDate() - day + 1)
  start.setHours(0, 0, 0, 0)
  return start.getTime()
}

function reviewOrderPnl(order: TradingOrder) {
  const net = finiteValue(order.netPnl)
  if (net !== null) return net
  const realized = finiteValue(order.realizedPnl)
  if (realized === null) return null
  const commission = finiteValue(order.commission) || 0
  const commissionAsset = String(order.commissionAsset || 'USDT').toUpperCase()
  const stableCommission = ['USDT', 'USDC', 'BUSD', 'FDUSD'].includes(commissionAsset) ? commission : 0
  return realized - stableCommission
}

function isRiskInterception(event: AgentEvent) {
  const source = `${event.type} ${event.message}`
  return event.level !== 'info' && /(risk|风控|reject|拒绝|blocked|拦截|halt|停止)/i.test(source)
}

function orderTimestamp(order: TradingOrder) {
  return Number(order.transactTime || order.updateTime || 0)
}

export function ReviewView({ orders, agentLogs, onToast }: ReviewViewProps) {
  const [filter, setFilter] = useState<'all' | 'trades' | 'risk'>('all')
  const [selected, setSelected] = useState<{ title: string; subtitle: string; payload: unknown } | null>(null)
  const weekStart = currentWeekStart()
  const weeklyOrders = useMemo(() => orders.filter((order) => orderTimestamp(order) >= weekStart), [orders, weekStart])
  const weeklyLogs = useMemo(() => agentLogs.filter((event) => event.timestamp >= weekStart), [agentLogs, weekStart])
  const closedTrades = useMemo(() => weeklyOrders.filter((order) => order.status === 'FILLED' && isClosingOrder(order) && reviewOrderPnl(order) !== null), [weeklyOrders])
  const riskInterceptions = useMemo(() => weeklyLogs.filter(isRiskInterception), [weeklyLogs])
  const netPnl = closedTrades.reduce((sum, order) => sum + (reviewOrderPnl(order) || 0), 0)
  const winningTrades = closedTrades.filter((order) => (reviewOrderPnl(order) || 0) > 0).length
  const winRate = closedTrades.length ? winningTrades / closedTrades.length : 0

  const rows = useMemo(() => {
    const tradeRows = orders.map((order, index) => {
      const pnl = reviewOrderPnl(order)
      const timestamp = orderTimestamp(order)
      return {
        id: `order-${order.orderId || order.id || `${timestamp}-${index}`}`,
        kind: 'trade' as const,
        timestamp,
        title: order.symbol,
        subtitle: `${timestamp ? new Date(timestamp).toLocaleString('zh-CN', { hour12: false }) : '时间未知'} · ${order.environment === 'paper' ? '模拟盘' : order.environment === 'testnet' ? '测试网' : '生产'}`,
        verdict: `${order.side === 'BUY' ? '买入' : '卖出'} · ${order.type === 'MARKET' ? '市价' : '限价'} · ${orderStatusLabel(order.status)}`,
        result: pnl === null ? orderStatusLabel(order.status) : `${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}`,
        good: pnl === null ? order.status !== 'REJECTED' : pnl >= 0,
        payload: order,
      }
    })
    const riskRows = agentLogs.filter(isRiskInterception).map((event) => ({
      id: `event-${event.id}`,
      kind: 'risk' as const,
      timestamp: event.timestamp,
      title: 'Agent 风控事件',
      subtitle: `${new Date(event.timestamp).toLocaleString('zh-CN', { hour12: false })} · ${event.agentId}`,
      verdict: event.message,
      result: event.type,
      good: false,
      payload: event,
    }))
    return [...tradeRows, ...riskRows]
      .filter((row) => filter === 'all' || row.kind === (filter === 'trades' ? 'trade' : 'risk'))
      .sort((left, right) => right.timestamp - left.timestamp)
      .slice(0, 50)
  }, [agentLogs, filter, orders])

  const cycleFilter = () => {
    const next = filter === 'all' ? 'trades' : filter === 'trades' ? 'risk' : 'all'
    setFilter(next)
    onToast(`复盘记录：${next === 'all' ? '全部' : next === 'trades' ? '仅交易' : '仅风控拦截'}`)
  }

  const downloadReport = () => {
    const report = {
      generatedAt: new Date().toISOString(),
      weekStartedAt: new Date(weekStart).toISOString(),
      summary: { netPnl, tradeCount: closedTrades.length, winningTrades, winRate, riskInterceptions: riskInterceptions.length, auditEvents: weeklyLogs.length },
      orders: weeklyOrders,
      agentEvents: weeklyLogs,
    }
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `atlas-review-${new Date().toISOString().slice(0, 10)}.json`
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
    onToast(`本周复盘已导出 · ${closedTrades.length} 笔平仓 · ${weeklyLogs.length} 条审计事件`)
  }

  return <main className="page">
    <section className="page-heading"><div><span className="section-kicker">决策与结果对照</span><h1>复盘</h1><p>基于已同步订单和 Agent 审计日志生成，不补造缺失的交易成本</p></div><button className="secondary-button" onClick={downloadReport}><BarChart3 size={16} />生成周报</button></section>
    <section className="review-summary"><div><span>本周平仓</span><strong>{closedTrades.length}</strong><small>胜率 {percent(winRate)}</small></div><div><span>净收益</span><strong className={netPnl >= 0 ? 'text-positive' : 'text-negative'}>{netPnl >= 0 ? '+' : '-'}${Math.abs(netPnl).toFixed(2)}</strong><small>已实现盈亏减可计价手续费</small></div><div><span>风控拦截</span><strong>{riskInterceptions.length}</strong><small>来自 Agent 审计日志</small></div><div><span>审计事件</span><strong>{weeklyLogs.length}</strong><small>本周持久化事件</small></div></section>
    <section className="panel review-list"><header className="panel-header"><div><h2>真实执行记录</h2><p>{filter === 'all' ? '交易与风控事件' : filter === 'trades' ? '仅交易订单' : '仅风控拦截'}</p></div><button className="icon-button" onClick={cycleFilter} aria-label="切换复盘筛选" title="全部、交易、风控循环切换"><Filter size={16} /></button></header>
      {rows.length ? rows.map((row) => <article className="review-row" key={row.id}><span className={`review-direction ${row.good ? 'review-good' : 'review-bad'}`}>{row.good ? <ArrowUpRight size={16} /> : <ArrowDownRight size={16} />}</span><div><strong>{row.title}</strong><span>{row.subtitle}</span></div><p>{row.verdict}</p><strong className={row.good ? 'text-positive' : 'text-negative'}>{row.result}</strong><button className="secondary-button" onClick={() => setSelected({ title: row.title, subtitle: row.subtitle, payload: row.payload })}><Clock3 size={14} />查看详情</button></article>) : <div className="table-empty"><History size={22} /><strong>当前筛选下没有真实记录</strong><p>同步订单或运行 Agent 后会显示在这里</p></div>}
    </section>
    <div className="review-principle"><CheckCircle2 size={18} /><p>仅以明确的已实现盈亏统计胜率；缺少成本账本的订单不会被推测为盈利或亏损。</p></div>
    {selected && <Modal title={selected.title} subtitle={selected.subtitle} onClose={() => setSelected(null)}><div className="data-table"><pre>{JSON.stringify(selected.payload, null, 2)}</pre></div><div className="modal-actions"><button className="secondary-button" onClick={() => setSelected(null)}>关闭</button></div></Modal>}
  </main>
}
