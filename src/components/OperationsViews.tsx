import { useMemo, useState } from 'react'
import { ArrowDownRight, ArrowUpRight, BarChart3, CheckCircle2, Clock3, Filter, History, Play, Plus, RefreshCw, Search, SlidersHorizontal, Trash2 } from 'lucide-react'
import { runBacktest, validateBacktestStrategy, type BacktestResult, type BacktestStrategyConfig, type BacktestStrategyKind } from '../lib/backtest'
import type { AccountSnapshot, AgentEvent, Environment, MarketInterval, MarketTick, MarketType, TradingOrder } from '../types'
import { Modal } from './Modal'

const STRATEGY_STORAGE_KEY = 'atlas-strategy-library-v1'
const defaultStrategies: BacktestStrategyConfig[] = [
  { id: 'ma-crossover', name: '均线趋势跟随', kind: 'ma-crossover', primaryPeriod: 20, secondaryPeriod: 50, feeBps: 4 },
  { id: 'rsi-reversion', name: 'RSI 均值回归', kind: 'rsi-reversion', primaryPeriod: 14, secondaryPeriod: 30, feeBps: 4 },
  { id: 'donchian-breakout', name: 'Donchian 突破', kind: 'donchian-breakout', primaryPeriod: 20, secondaryPeriod: 10, feeBps: 4 },
  { id: 'supertrend', name: 'Supertrend 趋势', kind: 'supertrend', primaryPeriod: 10, secondaryPeriod: 3, feeBps: 4 },
  { id: 'macd-momentum', name: 'MACD 动量', kind: 'macd-momentum', primaryPeriod: 12, secondaryPeriod: 26, feeBps: 4 },
]

const backtestKinds: BacktestStrategyKind[] = ['ma-crossover', 'rsi-reversion', 'donchian-breakout', 'supertrend', 'macd-momentum']
const defaultStrategyIds = new Set(defaultStrategies.map((strategy) => strategy.id))

interface StrategyRun extends BacktestResult {
  environment: Environment
  marketType: MarketType
  symbol: string
  interval: MarketInterval
}

function loadStrategies() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STRATEGY_STORAGE_KEY) || 'null')
    if (!Array.isArray(parsed) || !parsed.length) return defaultStrategies.map((strategy) => ({ ...strategy }))
    const valid = parsed.filter((strategy): strategy is BacktestStrategyConfig => {
      try {
        validateBacktestStrategy(strategy)
        return typeof strategy.id === 'string' && backtestKinds.includes(strategy.kind)
      } catch {
        return false
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
  if (kind === 'supertrend') return 'Supertrend'
  return 'MACD 动量'
}

function periodLabels(kind: BacktestStrategyKind) {
  if (kind === 'ma-crossover') return ['快线周期', '慢线周期']
  if (kind === 'rsi-reversion') return ['RSI 周期', '超买卖阈值']
  if (kind === 'donchian-breakout') return ['突破周期', '退出周期']
  if (kind === 'supertrend') return ['ATR 周期', 'ATR 倍数']
  return ['MACD 快线周期', 'MACD 慢线周期（信号线 9）']
}

function defaultPeriods(kind: BacktestStrategyKind) {
  if (kind === 'rsi-reversion') return { primaryPeriod: 14, secondaryPeriod: 30 }
  if (kind === 'donchian-breakout') return { primaryPeriod: 20, secondaryPeriod: 10 }
  if (kind === 'supertrend') return { primaryPeriod: 10, secondaryPeriod: 3 }
  if (kind === 'macd-momentum') return { primaryPeriod: 12, secondaryPeriod: 26 }
  return { primaryPeriod: 20, secondaryPeriod: 50 }
}

function percent(value: number, signed = false) {
  return `${signed && value >= 0 ? '+' : ''}${(value * 100).toFixed(2)}%`
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
  const [strategies, setStrategies] = useState<BacktestStrategyConfig[]>(loadStrategies)
  const [results, setResults] = useState<Record<string, StrategyRun>>({})
  const [draft, setDraft] = useState<BacktestStrategyConfig | null>(null)

  const persistStrategies = (next: BacktestStrategyConfig[]) => {
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
        secondaryPeriod: draft.kind === 'supertrend' ? Number(draft.secondaryPeriod.toFixed(2)) : Math.round(draft.secondaryPeriod),
      }
      validateBacktestStrategy(normalized)
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

  const backtest = async (strategy: BacktestStrategyConfig) => {
    if (!window.atlas?.market) {
      onToast('真实历史行情需要在 Atlas 桌面应用中运行')
      return
    }
    setRunning(strategy.id)
    try {
      const candles = await window.atlas.market.history({ environment, marketType, symbol, interval, limit: 2000 })
      const result = runBacktest(candles, strategy, marketType)
      setResults((current) => ({ ...current, [strategy.id]: { ...result, environment, marketType, symbol, interval } }))
      onToast(`${strategy.name} 回测完成 · ${result.sampleCount.toLocaleString('en-US')} 根 K 线 · ${result.tradeCount} 笔交易`)
    } catch (caught) {
      onToast(caught instanceof Error ? caught.message : '历史回测失败')
    } finally {
      setRunning(null)
    }
  }

  const createStrategy = () => setDraft({ id: `strategy-${Date.now()}`, name: '新策略', kind: 'ma-crossover', primaryPeriod: 20, secondaryPeriod: 50, feeBps: 4 })

  return <main className="page">
    <section className="page-heading"><div><span className="section-kicker">可验证交易逻辑</span><h1>策略库</h1><p>使用当前 {symbol} {interval} 的真实历史 K 线进行本地回测，不提交订单</p></div><button className="primary-button" onClick={createStrategy}><Plus size={16} />新建策略</button></section>
    <div className="strategy-grid">{strategies.map((strategy) => {
      const storedResult = results[strategy.id]
      const result = storedResult?.environment === environment && storedResult.marketType === marketType && storedResult.symbol === symbol && storedResult.interval === interval ? storedResult : undefined
      return <article className="strategy-card panel" key={strategy.id}>
        <header><span className="strategy-state">{result ? `${result.sampleCount.toLocaleString('en-US')} 根 · ${new Date(result.generatedAt).toLocaleTimeString('zh-CN', { hour12: false })}` : '尚未回测'}</span><button className="icon-button" onClick={() => setDraft({ ...strategy })} aria-label={`配置${strategy.name}`} title="编辑策略参数"><SlidersHorizontal size={16} /></button></header>
        <h2>{strategy.name}</h2><p>{kindLabel(strategy.kind)} · {symbol} · {marketType === 'spot' ? '现货' : '永续'} · {interval}</p>
        <div className="strategy-metrics"><div><span>回测收益</span><strong className={result ? result.totalReturn >= 0 ? 'text-positive' : 'text-negative' : ''}>{result ? percent(result.totalReturn, true) : '--'}</strong></div><div><span>最大回撤</span><strong className="text-negative">{result ? percent(-result.maxDrawdown) : '--'}</strong></div><div><span>胜率 / 交易</span><strong>{result ? `${percent(result.winRate)} / ${result.tradeCount}` : '--'}</strong></div></div>
        <button className="secondary-button full-button" onClick={() => void backtest(strategy)} disabled={running !== null}>{running === strategy.id ? <RefreshCw className="spin" size={15} /> : <Play size={15} />}{running === strategy.id ? '读取行情并回测' : '运行真实回测'}</button>
      </article>
    })}</div>
    {draft && <Modal title={strategies.some((strategy) => strategy.id === draft.id) ? '编辑策略参数' : '新建本地策略'} subtitle="配置保存在本机，回测只读取公开历史行情" onClose={() => setDraft(null)}><div className="close-position-form">
      <label className="field-label" htmlFor="strategy-name">策略名称</label><div className="input-shell"><input id="strategy-name" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></div>
      <label className="field-label">策略逻辑</label><select className="select-field" value={draft.kind} onChange={(event) => { const kind = event.target.value as BacktestStrategyKind; setDraft({ ...draft, kind, ...defaultPeriods(kind) }) }}>{backtestKinds.map((kind) => <option key={kind} value={kind}>{kindLabel(kind)}</option>)}</select>
      <label className="field-label" htmlFor="strategy-primary">{periodLabels(draft.kind)[0]}</label><div className="input-shell"><input id="strategy-primary" type="number" min="2" max="500" value={draft.primaryPeriod} onChange={(event) => setDraft({ ...draft, primaryPeriod: Number(event.target.value) })} /><span>根</span></div>
      <label className="field-label" htmlFor="strategy-secondary">{periodLabels(draft.kind)[1]}</label><div className="input-shell"><input id="strategy-secondary" type="number" min={draft.kind === 'supertrend' ? 0.5 : 2} max={draft.kind === 'supertrend' ? 10 : 500} step={draft.kind === 'supertrend' ? 0.1 : 1} value={draft.secondaryPeriod} onChange={(event) => setDraft({ ...draft, secondaryPeriod: Number(event.target.value) })} /><span>{draft.kind === 'rsi-reversion' ? '%' : draft.kind === 'supertrend' ? 'x' : '根'}</span></div>
      <label className="field-label" htmlFor="strategy-fee">单边交易成本</label><div className="input-shell"><input id="strategy-fee" type="number" min="0" max="100" step="0.1" value={draft.feeBps} onChange={(event) => setDraft({ ...draft, feeBps: Number(event.target.value) })} /><span>bps</span></div>
      <div className="modal-actions">{strategies.some((strategy) => strategy.id === draft.id) && !defaultStrategyIds.has(draft.id) && <button className="danger-button" onClick={removeDraft}><Trash2 size={15} />删除</button>}<button className="secondary-button" onClick={() => setDraft(null)}>取消</button><button className="primary-button" onClick={saveDraft}>保存策略</button></div>
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
