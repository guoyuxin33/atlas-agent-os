import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertOctagon,
  Bell,
  Bot,
  BrainCircuit,
  Cable,
  ChevronRight,
  CircleX,
  CircleDollarSign,
  Command,
  FileClock,
  Gauge,
  KeyRound,
  LayoutDashboard,
  LockKeyhole,
  Menu,
  MessageSquareText,
  Minus,
  Network,
  Plus,
  Radio,
  ReceiptText,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Unplug,
  WalletCards,
  Wrench,
  X,
  Zap,
} from 'lucide-react'
import { AgentCreateModal, AgentsView, OverviewAgentsPanel } from './components/AgentsView'
import { AssistantView } from './components/AssistantView'
import { CommandPalette } from './components/CommandPalette'
import { MarketChart } from './components/MarketChart'
import { MarketSelector } from './components/MarketSelector'
import { Modal } from './components/Modal'
import { OrdersView, ReviewView, StrategiesView } from './components/OperationsViews'
import { SkillsView } from './components/SkillsView'
import { MarketEnvironmentContext } from './contexts/MarketEnvironmentContext'
import { useMarketData } from './hooks/useMarketData'
import { getVaultStatus, saveSecrets } from './lib/desktop'
import { getModelProvider, modelProviders } from './modelProviders'
import { builtInSkills } from './skills'
import type { AccountSnapshot, AgentCreateInput, AgentDefinition, AgentEvent, AgentIntent, Environment, McpConnection, MarketBook, MarketInterval, MarketTick, MarketType, PortfolioPosition, TradingOrder } from './types'

type NavId = 'overview' | 'assistant' | 'agents' | 'strategies' | 'skills' | 'connections' | 'risk' | 'orders' | 'review'
type ModalId = 'exchange' | 'model' | 'network' | 'agent' | 'emergency' | 'notifications' | null

interface AppNotification {
  id: string
  title: string
  detail: string
  timestamp?: number
  navigateTo: NavId
  tone: 'warning' | 'healthy'
}

const navigation: Array<{ id: NavId; label: string; icon: typeof LayoutDashboard; group: 'run' | 'control' }> = [
  { id: 'overview', label: '工作台', icon: LayoutDashboard, group: 'run' },
  { id: 'assistant', label: 'AI 助手', icon: MessageSquareText, group: 'run' },
  { id: 'agents', label: 'Agent', icon: Bot, group: 'run' },
  { id: 'strategies', label: '策略库', icon: BrainCircuit, group: 'run' },
  { id: 'skills', label: 'Skill / MCP', icon: Wrench, group: 'run' },
  { id: 'connections', label: '连接', icon: Cable, group: 'control' },
  { id: 'risk', label: '风控', icon: ShieldCheck, group: 'control' },
  { id: 'orders', label: '订单与持仓', icon: ReceiptText, group: 'control' },
  { id: 'review', label: '复盘', icon: FileClock, group: 'control' },
]

const intervals: MarketInterval[] = ['1m', '5m', '15m', '1h', '4h', '1d']
function environmentLabel(environment: Environment) {
  return environment === 'paper' ? '模拟盘' : environment === 'testnet' ? '测试网' : '生产'
}

function formatPrice(value: number) {
  if (!(value > 0)) return '--'
  const digits = value < 1 ? 6 : value < 100 ? 4 : 2
  return new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: digits }).format(value)
}

function formatQuantity(value: number) {
  if (!(value > 0)) return '--'
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 }).format(value)
}

function relativeTime(timestamp?: number) {
  if (!timestamp) return '当前状态'
  const elapsed = Math.max(0, Date.now() - timestamp)
  if (elapsed < 60_000) return '刚刚'
  if (elapsed < 60 * 60_000) return `${Math.floor(elapsed / 60_000)} 分钟前`
  if (elapsed < 24 * 60 * 60_000) return `${Math.floor(elapsed / (60 * 60_000))} 小时前`
  return new Date(timestamp).toLocaleDateString('zh-CN')
}

function StatusDot({ live = false, danger = false }: { live?: boolean; danger?: boolean }) {
  return <span className={`status-dot ${live ? 'status-dot-live' : ''} ${danger ? 'status-dot-danger' : ''}`} />
}

function Sidebar({ active, onNavigate, open, onClose, environment, binanceConfigured, modelConfigured, agentCount }: {
  active: NavId
  onNavigate: (id: NavId) => void
  open: boolean
  onClose: () => void
  environment: Environment
  binanceConfigured: boolean
  modelConfigured: boolean
  agentCount: number
}) {
  const renderGroup = (group: 'run' | 'control') => navigation.filter((item) => item.group === group).map((item) => (
    <button key={item.id} className={`nav-item ${active === item.id ? 'nav-item-active' : ''}`} onClick={() => { onNavigate(item.id); onClose() }}>
      <item.icon size={17} />
      <span>{item.label}</span>
      {item.id === 'agents' && <span className="nav-count">{agentCount}</span>}
    </button>
  ))

  return (
    <aside className={`sidebar ${open ? 'sidebar-open' : ''}`}>
      <div className="brand-row">
        <div className="brand-mark" aria-hidden="true"><span /><span /><span /></div>
        <span className="brand-name">Atlas</span>
        <span className="brand-edition">Agent OS</span>
        <button className="mobile-close" onClick={onClose} aria-label="关闭导航"><X size={18} /></button>
      </div>
      <nav className="nav-list" aria-label="主导航">
        <p className="nav-label">运行中心</p>
        {renderGroup('run')}
        <p className="nav-label nav-label-spaced">控制与记录</p>
        {renderGroup('control')}
      </nav>
      <div className="sidebar-spacer" />
      <div className="account-block">
        <div className="account-line">
          <span className="exchange-logo">BN</span>
          <div><strong>Binance · {environmentLabel(environment)}</strong><span><StatusDot live={environment === 'paper' || binanceConfigured} danger={environment === 'live' && !binanceConfigured} />{environment === 'paper' ? '本地撮合' : binanceConfigured ? '凭证已配置' : '等待配置'}</span></div>
          <WalletCards size={17} />
        </div>
        <div className="account-line model-line">
          <span className="model-logo"><Command size={15} /></span>
          <div><strong>模型路由</strong><span>{modelConfigured ? 'OpenAI 兼容接口已配置' : '等待配置'}</span></div>
          <ChevronRight size={16} />
        </div>
      </div>
      <p className="unslop-credit">Interface direction · unslop by @heydamir</p>
    </aside>
  )
}

function Topbar({ environment, marketType, refreshing, lastRefreshedAt, notificationCount, onEnvironment, onMarketType, onMenu, onModal, onSearch, onRefresh, onAccount }: {
  environment: Environment
  marketType: MarketType
  refreshing: boolean
  lastRefreshedAt: number | null
  notificationCount: number
  onEnvironment: (value: Environment) => void
  onMarketType: (value: MarketType) => void
  onMenu: () => void
  onModal: (id: ModalId) => void
  onSearch: () => void
  onRefresh: () => void
  onAccount: () => void
}) {
  const refreshTitle = lastRefreshedAt
    ? `刷新账户、订单、行情和 Agent（上次 ${new Date(lastRefreshedAt).toLocaleTimeString('zh-CN', { hour12: false })}）`
    : '刷新账户、订单、行情和 Agent'
  return (
    <header className="topbar">
      <button className="menu-button" onClick={onMenu} aria-label="打开导航"><Menu size={19} /></button>
      <button className="command-search" onClick={onSearch}><Search size={16} /><span>搜索页面或操作</span><kbd>⌘ K</kbd></button>
      <div className="topbar-mode segmented compact" aria-label="市场类型"><button className={marketType === 'spot' ? 'active' : ''} onClick={() => onMarketType('spot')}>现货</button><button className={marketType === 'futures' ? 'active' : ''} onClick={() => onMarketType('futures')}>永续</button></div>
      <div className="environment-switch segmented compact" aria-label="账户环境">{(['paper', 'testnet', 'live'] as Environment[]).map((value) => <button key={value} className={`${environment === value ? 'active' : ''} ${value === 'live' ? 'live-mode' : ''}`} onClick={() => onEnvironment(value)}>{environmentLabel(value)}</button>)}</div>
      <div className="topbar-actions"><button className="icon-button refresh-all-button" onClick={onRefresh} disabled={refreshing} aria-label={refreshing ? '正在刷新实时数据' : '刷新全部实时数据'} aria-busy={refreshing} title={refreshing ? '正在刷新账户、订单、行情和 Agent' : refreshTitle}><RefreshCw className={refreshing ? 'spin' : ''} size={17} /></button><button className="icon-button notification-button" onClick={() => onModal('notifications')} aria-label={notificationCount ? `通知，${notificationCount} 条待处理` : '通知，无待处理事项'}><Bell size={18} />{notificationCount > 0 && <span />}</button><button className="avatar-button" onClick={onAccount} aria-label="账户菜单">YX</button></div>
    </header>
  )
}

function Metric({ label, value, detail, tone }: { label: string; value: string; detail: string; tone?: 'positive' | 'negative' | 'accent' }) {
  return <div className="metric"><span>{label}</span><strong className={tone ? `text-${tone}` : ''}>{value}</strong><small>{detail}</small></div>
}

function PortfolioTable({ positions, updatedAt, halted, onClosePosition }: { positions: PortfolioPosition[]; updatedAt?: number; halted: boolean; onClosePosition: (position: PortfolioPosition) => void }) {
  const money = (value: string) => {
    const number = Number(value)
    if (!Number.isFinite(number)) return '--'
    return `$${number === 0 ? '0.00' : formatPrice(Math.abs(number))}`
  }
  const signedMoney = (value: string) => {
    const number = Number(value)
    if (!Number.isFinite(number)) return '--'
    return `${number >= 0 ? '+' : '-'}${money(String(number))}`
  }
  const quantity = (value: string) => Number(value).toLocaleString('en-US', { maximumFractionDigits: 8 })
  const riskValue = (value?: string) => Number(value) > 0 ? money(value || '0') : '--'

  return <section className="panel portfolio-panel"><header className="panel-header"><div><h2>当前持仓与实时收益</h2><p>标记价、保证金率和强平价随账户快照更新</p></div><span className="portfolio-updated"><StatusDot live />{updatedAt ? new Date(updatedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '等待同步'}</span></header>{positions.length ? <div className="portfolio-table-scroll"><div className="portfolio-table"><div className="portfolio-row portfolio-head"><span>交易对</span><span>市场 / 方向</span><span>数量</span><span>成本 / 标记</span><span>名义价值</span><span>初始 / 维持保证金</span><span>强平价 / 保证金率</span><span>未实现盈亏</span><span>收益率</span><span>操作</span></div>{positions.map((position) => { const pnl = Number(position.unrealizedPnl); const rate = Number(position.returnRate); const marginRatio = Number(position.marginRatio); const tone = pnl >= 0 ? 'text-positive' : 'text-negative'; return <div className="portfolio-row" key={`${position.marketType}:${position.symbol}:${position.positionSide || position.side}`}><strong>{position.symbol.replace('USDT', '/USDT')}</strong><span>{position.marketType === 'spot' ? '现货' : `${position.leverage}x ${position.marginType === 'ISOLATED' ? '逐仓' : '全仓'}`} · <i className={position.side === 'LONG' ? 'text-positive' : 'text-negative'}>{position.side === 'LONG' ? '多' : '空'}</i></span><span>{quantity(position.quantity)}</span><span>{position.entryPrice ? money(position.entryPrice) : '--'}<small>标记 {money(position.markPrice)}</small></span><span>{money(position.marketValue)}</span><span>{riskValue(position.initialMargin)}<small>维持 {riskValue(position.maintMargin)}</small></span><span>{riskValue(position.liquidationPrice)}<small>{Number.isFinite(marginRatio) && position.marketType === 'futures' ? `保证金率 ${marginRatio.toFixed(2)}%${position.liquidationPriceEstimated ? ' · 估算' : ''}` : '--'}</small></span><strong className={tone}>{signedMoney(position.unrealizedPnl)}</strong><strong className={rate >= 0 ? 'text-positive' : 'text-negative'}>{rate >= 0 ? '+' : ''}{rate.toFixed(2)}% <small>{position.returnBasis === '24h' ? '24h' : position.returnBasis === 'margin' ? '保证金' : '成本'}</small></strong><button className="position-close-button" disabled={halted} onClick={() => onClosePosition(position)} title={halted ? '风控总闸已关闭' : `平仓 ${position.symbol}`}><CircleX size={13} />平仓</button></div> })}</div></div> : <div className="portfolio-empty"><WalletCards size={22} /><div><strong>当前市场还没有持仓</strong><p>在模拟盘提交买入或合约开仓后，会在这里显示成本价、实时盈亏、保证金率和强平价</p></div></div>}</section>
}

function ClosePositionModal({ environment, position, halted, onClose, onSubmit }: { environment: Environment; position: PortfolioPosition; halted: boolean; onClose: () => void; onSubmit: (order: TradingOrder) => Promise<boolean> }) {
  const totalQuantity = Number(position.quantity)
  const maxQuantity = position.marketType === 'spot' && environment !== 'paper'
    ? Number(position.availableQuantity || 0)
    : totalQuantity
  const markPrice = Number(position.markPrice)
  const [orderType, setOrderType] = useState<'MARKET' | 'LIMIT'>('MARKET')
  const [amount, setAmount] = useState(String(maxQuantity || ''))
  const [price, setPrice] = useState(Number.isFinite(markPrice) && markPrice > 0 ? String(markPrice) : '')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isHedgePosition = position.marketType === 'futures' && (position.positionSide === 'LONG' || position.positionSide === 'SHORT')
  const side: 'BUY' | 'SELL' = position.marketType === 'spot' || position.side === 'LONG' ? 'SELL' : 'BUY'
  const baseAsset = position.symbol.replace(/USDT$/, '')
  const estimatedValue = Number(amount) * (orderType === 'LIMIT' ? Number(price) : markPrice)

  const applyRatio = (ratio: number) => {
    const next = maxQuantity * ratio
    setAmount(next > 0 ? String(Number(next.toFixed(8))) : '')
    setError(null)
  }

  const submit = async () => {
    const quantity = Number(amount)
    const limitPrice = Number(price)
    if (!(quantity > 0)) return setError('平仓数量必须大于 0')
    if (quantity > maxQuantity + 1e-10) return setError(`平仓数量不能超过当前持仓 ${maxQuantity}`)
    if (orderType === 'LIMIT' && !(limitPrice > 0)) return setError('限价平仓必须输入有效价格')
    if (!(markPrice > 0)) return setError('当前持仓缺少有效标记价格')
    setSubmitting(true)
    setError(null)
    try {
      const submitted = await onSubmit({
        environment,
        marketType: position.marketType,
        symbol: position.symbol,
        side,
        type: orderType,
        quantity: String(quantity),
        price: orderType === 'LIMIT' ? String(limitPrice) : undefined,
        marketPrice: String(markPrice),
        positionSide: position.marketType === 'futures' ? isHedgePosition ? position.positionSide : 'BOTH' : undefined,
        reduceOnly: position.marketType === 'futures' && !isHedgePosition ? true : undefined,
        leverage: position.marketType === 'futures' ? Number(position.leverage || 1) : undefined,
        marginType: position.marketType === 'futures' ? position.marginType : undefined,
        clientOrderId: `atlas_close_${Date.now().toString(36)}`.slice(0, 36),
      })
      if (submitted) onClose()
    } finally {
      setSubmitting(false)
    }
  }

  return <Modal title={`平仓 ${position.symbol}`} subtitle={`${environmentLabel(environment)} · ${position.marketType === 'spot' ? '现货卖出' : `${position.positionSide || 'BOTH'} ${position.side === 'LONG' ? '平多' : '平空'}`}`} onClose={onClose}><div className="close-position-form"><div className="close-position-summary"><span>{position.marketType === 'spot' && environment !== 'paper' ? '总持仓 / 可用' : '当前持仓'}<strong>{position.marketType === 'spot' && environment !== 'paper' ? `${totalQuantity.toLocaleString('en-US', { maximumFractionDigits: 8 })} / ` : ''}{maxQuantity.toLocaleString('en-US', { maximumFractionDigits: 8 })} {baseAsset}</strong></span><span>标记价格<strong>{markPrice > 0 ? `$${formatPrice(markPrice)}` : '--'}</strong></span><span>未实现盈亏<strong className={Number(position.unrealizedPnl) >= 0 ? 'text-positive' : 'text-negative'}>{Number(position.unrealizedPnl) >= 0 ? '+' : ''}${Number(position.unrealizedPnl || 0).toFixed(2)}</strong></span></div><label className="field-label">订单类型</label><div className="segmented order-type"><button className={orderType === 'MARKET' ? 'active' : ''} onClick={() => setOrderType('MARKET')}>市价</button><button className={orderType === 'LIMIT' ? 'active' : ''} onClick={() => setOrderType('LIMIT')}>限价</button></div><label className="field-label" htmlFor="close-amount">平仓数量</label><div className="input-shell"><input id="close-amount" value={amount} onChange={(event) => { setAmount(event.target.value); setError(null) }} inputMode="decimal" /><span>{baseAsset}</span></div><div className="amount-presets">{[0.25, 0.5, 0.75, 1].map((ratio) => <button key={ratio} onClick={() => applyRatio(ratio)}>{ratio === 1 ? position.marketType === 'spot' && environment !== 'paper' ? '全部可用' : '全部' : `${ratio * 100}%`}</button>)}</div>{orderType === 'LIMIT' && <><label className="field-label" htmlFor="close-price">委托价格</label><div className="input-shell"><input id="close-price" value={price} onChange={(event) => { setPrice(event.target.value); setError(null) }} inputMode="decimal" /><span>USDT</span></div></>}<div className="order-summary"><span>预计价值</span><strong>{Number.isFinite(estimatedValue) && estimatedValue > 0 ? `$${estimatedValue.toFixed(2)}` : '--'}</strong><span>平仓方向</span><strong>{side === 'SELL' ? 'SELL' : 'BUY'}{isHedgePosition ? ` · ${position.positionSide}` : position.marketType === 'futures' ? ' · Reduce Only' : ''}</strong></div>{error && <p className="form-error">{error}</p>}<div className="modal-actions"><button className="secondary-button" onClick={onClose}>取消</button><button className="danger-button" disabled={halted || submitting || !(maxQuantity > 0)} onClick={submit}>{halted ? '执行已停止' : !(maxQuantity > 0) ? '没有可用数量' : submitting ? '提交中' : environment === 'live' ? '进入生产确认' : orderType === 'MARKET' ? '确认市价平仓' : '提交限价平仓'}</button></div></div></Modal>
}

function Overview({ environment, marketType, symbol, interval, marketRefreshKey, account, tick, book, halted, agents, agentLogs, agentsLoading, busyAgentIds, onSymbol, onInterval, onModal, onToggleAgent, onManageAgents, onPlaceOrder, onRefreshAccount, onToast }: {
  environment: Environment
  marketType: MarketType
  symbol: string
  interval: MarketInterval
  marketRefreshKey: number
  account: AccountSnapshot | null
  tick: MarketTick
  book: MarketBook
  halted: boolean
  agents: AgentDefinition[]
  agentLogs: AgentEvent[]
  agentsLoading: boolean
  busyAgentIds: Set<string>
  onSymbol: (value: string) => void
  onInterval: (value: MarketInterval) => void
  onModal: (id: ModalId) => void
  onToggleAgent: (agent: AgentDefinition) => Promise<void>
  onManageAgents: () => void
  onPlaceOrder: (order: TradingOrder) => Promise<boolean>
  onRefreshAccount: () => Promise<boolean>
  onToast: (message: string) => void
}) {
  const [orderSide, setOrderSide] = useState<'BUY' | 'SELL'>('BUY')
  const [orderType, setOrderType] = useState<'MARKET' | 'LIMIT'>('LIMIT')
  const [amount, setAmount] = useState('')
  const [price, setPrice] = useState('')
  const [showMA, setShowMA] = useState(true)
  const [reduceOnly, setReduceOnly] = useState(false)
  const [positionSide, setPositionSide] = useState<'LONG' | 'SHORT'>('LONG')
  const [submitting, setSubmitting] = useState(false)
  const [configuringFutures, setConfiguringFutures] = useState(false)
  const [marginAmount, setMarginAmount] = useState('')
  const [closingPosition, setClosingPosition] = useState<PortfolioPosition | null>(null)
  const futuresConfig = account?.futuresConfig
  const positionMode = futuresConfig?.positionMode || 'ONE_WAY'
  const configuredLeverage = Number(futuresConfig?.leverage || 3)
  const leverageDraftKey = `${symbol}:${configuredLeverage}`
  const [leverageDraft, setLeverageDraft] = useState({ key: leverageDraftKey, value: String(configuredLeverage) })
  const leverageInput = leverageDraft.key === leverageDraftKey ? leverageDraft.value : String(configuredLeverage)
  const setLeverageInput = (value: string) => setLeverageDraft({ key: leverageDraftKey, value })
  const leverage = Math.max(1, Number(futuresConfig?.leverage || leverageInput || 1))
  const effectivePrice = orderType === 'MARKET' ? tick.price : Number(price)
  const estimated = useMemo(() => Number(amount || 0) * effectivePrice, [amount, effectivePrice])
  const livePortfolio = useMemo(() => (account?.portfolio || []).map((position) => {
    if (!tick.connected || tick.symbol !== position.symbol || position.returnBasis === '24h') return position
    const entryPrice = Number(position.entryPrice)
    const quantity = Number(position.quantity)
    const leverage = Math.max(1, Number(position.leverage || 1))
    if (!(entryPrice > 0) || !(quantity > 0)) return position
    const direction = position.side === 'SHORT' ? -1 : 1
    const unrealizedPnl = (tick.price - entryPrice) * quantity * direction
    const cost = entryPrice * quantity / leverage
    return { ...position, markPrice: String(tick.price), marketValue: String(tick.price * quantity), unrealizedPnl: String(unrealizedPnl), unrealizedProfit: String(unrealizedPnl), returnRate: String(cost > 0 ? unrealizedPnl / cost * 100 : 0) }
  }), [account?.portfolio, tick.connected, tick.price, tick.symbol])
  const livePnlDelta = useMemo(() => livePortfolio.reduce((sum, position, index) => sum + Number(position.unrealizedPnl || 0) - Number(account?.portfolio[index]?.unrealizedPnl || 0), 0), [account?.portfolio, livePortfolio])
  const selectedFuturesPosition = livePortfolio.find((position) => position.marketType === 'futures' && position.symbol === symbol && (positionMode === 'ONE_WAY' || position.positionSide === positionSide))
  const balance = Number(account?.availableBalance || 0)
  const pnl = Number(account?.todayPnl || 0) + livePnlDelta
  const equity = Number(account?.totalWalletBalance || account?.availableBalance || 0) + livePnlDelta
  const baseAsset = symbol.replace(/USDT$/, '')

  const applyPreset = (ratio: number) => {
    const baseBalance = Number(account?.balances.find((item) => item.asset === baseAsset)?.free || 0)
    const quantity = marketType === 'spot' && orderSide === 'SELL'
      ? baseBalance * ratio
      : (balance * ratio * (marketType === 'futures' ? leverage : 1)) / Math.max(effectivePrice, 1)
    setAmount(quantity > 0 ? quantity.toFixed(symbol.startsWith('BTC') ? 6 : 4) : '0')
  }

  const futuresMutationOptions = () => {
    if (environment !== 'live') return { environment, symbol }
    const confirmed = window.confirm(`确认调整 Binance 生产账户的 ${symbol} 合约参数？该操作会立即生效。`)
    return confirmed ? { environment, symbol, confirmation: 'LIVE_ACCOUNT_CONFIRMED' as const } : null
  }

  const runFuturesMutation = async (mutation: (options: { environment: Environment; symbol: string; confirmation?: 'LIVE_ACCOUNT_CONFIRMED' }) => Promise<unknown>, success: string) => {
    if (!window.atlas || configuringFutures) return
    const options = futuresMutationOptions()
    if (!options) return
    setConfiguringFutures(true)
    try {
      await mutation(options)
      await onRefreshAccount()
      onToast(success)
    } catch (caught) {
      onToast(caught instanceof Error ? caught.message : '合约参数更新失败')
    } finally {
      setConfiguringFutures(false)
    }
  }

  const updateLeverage = () => {
    const nextLeverage = Math.round(Number(leverageInput))
    if (nextLeverage < 1 || nextLeverage > 125) return onToast('杠杆必须在 1x 到 125x 之间')
    return runFuturesMutation(
      (options) => window.atlas!.binance.setFuturesLeverage({ ...options, leverage: nextLeverage }),
      `${symbol} 杠杆已更新为 ${nextLeverage}x`,
    )
  }

  const updateMarginType = (marginType: 'CROSSED' | 'ISOLATED') => runFuturesMutation(
    (options) => window.atlas!.binance.setFuturesMarginType({ ...options, marginType }),
    `${symbol} 已切换为${marginType === 'ISOLATED' ? '逐仓' : '全仓'}`,
  )

  const updatePositionMode = (nextMode: 'ONE_WAY' | 'HEDGE') => {
    setReduceOnly(false)
    setPositionSide('LONG')
    return runFuturesMutation(
      (options) => window.atlas!.binance.setFuturesPositionMode({ ...options, positionMode: nextMode }),
      `持仓模式已切换为${nextMode === 'HEDGE' ? '双向持仓' : '单向持仓'}`,
    )
  }

  const adjustMargin = (action: 'ADD' | 'REMOVE') => {
    const amountValue = Number(marginAmount)
    if (!(amountValue > 0)) return onToast('请输入有效的保证金金额')
    return runFuturesMutation(
      (options) => window.atlas!.binance.adjustFuturesMargin({ ...options, amount: amountValue, action, positionSide: positionMode === 'HEDGE' ? positionSide : 'BOTH' }),
      `${symbol} 逐仓保证金已${action === 'ADD' ? '增加' : '减少'} ${amountValue.toFixed(2)} USDT`,
    )
  }

  const futuresActionLabel = positionMode === 'HEDGE'
    ? positionSide === 'LONG'
      ? orderSide === 'BUY' ? '开多' : '平多'
      : orderSide === 'SELL' ? '开空' : '平空'
    : reduceOnly
      ? orderSide === 'BUY' ? '平空' : '平多'
      : orderSide === 'BUY' ? '做多' : '做空'

  const placeOrder = async () => {
    if (halted) return onToast('风控总闸已关闭，订单未提交')
    if (!tick.connected) return onToast('等待所选交易对的真实实时行情后再下单')
    if (!(Number(amount) > 0)) return onToast('请输入有效的下单数量')
    if (orderType === 'LIMIT' && !(Number(price) > 0)) return onToast('限价单必须明确输入委托价格')
    setSubmitting(true)
    try {
      await onPlaceOrder({ environment, marketType, symbol, side: orderSide, type: orderType, quantity: amount, price: orderType === 'LIMIT' ? price : undefined, marketPrice: String(tick.price), positionSide: marketType === 'futures' ? positionMode === 'HEDGE' ? positionSide : 'BOTH' : undefined, reduceOnly: marketType === 'futures' && positionMode === 'ONE_WAY' ? reduceOnly : undefined, leverage: marketType === 'futures' ? leverage : undefined, marginType: marketType === 'futures' ? futuresConfig?.marginType || 'CROSSED' : undefined, clientOrderId: crypto.randomUUID().replaceAll('-', '').slice(0, 32) })
    } finally { setSubmitting(false) }
  }

  return (
    <main className="page overview-page">
      <section className="page-heading"><div><div className="heading-eyebrow"><StatusDot live={!halted} />{halted ? '所有执行已停止' : '系统运行正常'}<span>{environmentLabel(environment)} · {marketType === 'spot' ? '现货' : 'USDT 永续'}</span></div><h1>交易工作台</h1><p>共享 WebSocket 行情、账户收益和订单执行在同一条风险边界内</p></div><div className="heading-actions"><button className="secondary-button" onClick={() => onModal('exchange')}><Cable size={16} />连接交易所</button><button className="primary-button" onClick={() => onModal('agent')}><Plus size={16} />新建 Agent</button></div></section>
      <section className="metrics-strip"><Metric label="账户权益" value={`$${equity.toLocaleString('en-US', { maximumFractionDigits: 2 })}`} detail={account?.source === 'binance' ? 'Binance 实时账户' : '本地模拟资金'} /><Metric label="今日盈亏" value={`${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`} detail={`未实现盈亏 ${Number(account?.unrealizedPnl || 0).toFixed(2)}`} tone={pnl >= 0 ? 'positive' : 'negative'} /><Metric label="可用余额" value={`$${balance.toLocaleString('en-US', { maximumFractionDigits: 2 })}`} detail={`${account?.positions.length || 0} 个合约持仓`} tone="accent" /><Metric label="运行中 Agent" value={`${halted ? 0 : agents.filter((agent) => agent.status === 'running').length} / ${agents.length}`} detail={halted ? '总闸已关闭' : '逐笔通过风险规则'} /></section>
      <section className="dashboard-grid">
      <article className="panel market-panel"><header className="panel-header market-header"><div className="market-title"><span className="asset-mark">{baseAsset.slice(0, 1)}</span><div><MarketSelector marketType={marketType} value={symbol} onChange={onSymbol} /><span>{marketType === 'spot' ? '现货' : 'USDT 永续'} · Binance</span></div></div><div className="market-price"><strong>{tick.price > 0 ? `$${formatPrice(tick.price)}` : '--'}</strong><span className={tick.change >= 0 ? 'text-positive' : 'text-negative'}>{tick.connected ? `${tick.change >= 0 ? '+' : ''}${tick.change.toFixed(2)}%` : '等待行情'}</span></div><div className="market-stat"><span>24h 高</span><strong>{formatPrice(tick.high)}</strong></div><div className="market-stat"><span>24h 低</span><strong>{formatPrice(tick.low)}</strong></div><div className="market-connection"><StatusDot live={tick.connected} />{tick.connected ? '实时' : '重连中'}</div></header><div className="chart-toolbar"><div className="segmented compact">{intervals.map((item) => <button key={item} className={interval === item ? 'active' : ''} onClick={() => onInterval(item)}>{item === '1d' ? '1D' : item}</button>)}</div><div className="chart-market-tools"><div className="best-book" aria-label={`${symbol} 最优买卖盘口`}><span><i>买一</i><strong className="text-positive">{formatPrice(book.bid)}</strong><small>{formatQuantity(book.bidSize)} {baseAsset}</small></span><span><i>卖一</i><strong className="text-negative">{formatPrice(book.ask)}</strong><small>{formatQuantity(book.askSize)} {baseAsset}</small></span></div><button className={`bare-button ${showMA ? 'indicator-active' : ''}`} onClick={() => setShowMA((value) => !value)}><SlidersHorizontal size={15} />MA20</button></div></div><MarketChart marketType={marketType} symbol={symbol} interval={interval} showMA={showMA} refreshKey={marketRefreshKey} /></article>
        <aside className="panel order-panel">
          <header className="panel-header"><div><h2>快速下单</h2><p>{environmentLabel(environment)} · {marketType === 'spot' ? '现货' : '永续合约'}</p></div><LockKeyhole size={17} /></header>
          <div className="segmented order-side"><button className={orderSide === 'BUY' ? 'active buy-active' : ''} onClick={() => setOrderSide('BUY')}>{marketType === 'spot' ? '买入' : positionMode === 'HEDGE' ? positionSide === 'LONG' ? '开多' : '平空' : reduceOnly ? '平空' : '做多'}</button><button className={orderSide === 'SELL' ? 'active sell-active' : ''} onClick={() => setOrderSide('SELL')}>{marketType === 'spot' ? '卖出' : positionMode === 'HEDGE' ? positionSide === 'LONG' ? '平多' : '开空' : reduceOnly ? '平多' : '做空'}</button></div>
          <label className="field-label">订单类型</label>
          <div className="segmented order-type"><button className={orderType === 'LIMIT' ? 'active' : ''} onClick={() => setOrderType('LIMIT')}>限价</button><button className={orderType === 'MARKET' ? 'active' : ''} onClick={() => setOrderType('MARKET')}>市价</button></div>
          {marketType === 'futures' && (
            <div className="futures-controls">
              <div className="futures-control-row">
                <span>持仓模式</span>
                <div className="segmented compact">
                  <button disabled={configuringFutures} className={positionMode === 'ONE_WAY' ? 'active' : ''} onClick={() => updatePositionMode('ONE_WAY')}>单向</button>
                  <button disabled={configuringFutures} className={positionMode === 'HEDGE' ? 'active' : ''} onClick={() => updatePositionMode('HEDGE')}>双向</button>
                </div>
              </div>
              {positionMode === 'HEDGE' && <div className="futures-control-row">
                <span>仓位方向</span>
                <div className="segmented compact">
                  <button className={positionSide === 'LONG' ? 'active buy-active' : ''} onClick={() => { setPositionSide('LONG'); setOrderSide('BUY') }}>多仓 LONG</button>
                  <button className={positionSide === 'SHORT' ? 'active sell-active' : ''} onClick={() => { setPositionSide('SHORT'); setOrderSide('SELL') }}>空仓 SHORT</button>
                </div>
              </div>}
              <div className="futures-control-row">
                <span>保证金模式</span>
                <div className="segmented compact">
                  <button disabled={configuringFutures} className={futuresConfig?.marginType !== 'ISOLATED' ? 'active' : ''} onClick={() => updateMarginType('CROSSED')}>全仓</button>
                  <button disabled={configuringFutures} className={futuresConfig?.marginType === 'ISOLATED' ? 'active' : ''} onClick={() => updateMarginType('ISOLATED')}>逐仓</button>
                </div>
              </div>
              <div className="futures-control-row">
                <label htmlFor="leverage">杠杆</label>
                <div className="leverage-stepper">
                  <button type="button" aria-label="降低杠杆" onClick={() => setLeverageInput(String(Math.max(1, Number(leverageInput || 1) - 1)))}><Minus size={13} /></button>
                  <input id="leverage" type="number" min="1" max="125" value={leverageInput} onChange={(event) => setLeverageInput(event.target.value)} />
                  <span>x</span>
                  <button type="button" aria-label="提高杠杆" onClick={() => setLeverageInput(String(Math.min(125, Number(leverageInput || 1) + 1)))}><Plus size={13} /></button>
                  <button type="button" className="apply-leverage" disabled={configuringFutures || Number(leverageInput) === futuresConfig?.leverage} onClick={updateLeverage}>应用</button>
                </div>
              </div>
              {futuresConfig?.marginType === 'ISOLATED' && selectedFuturesPosition && (
                <div className="isolated-margin-control">
                  <div><span>{positionMode === 'HEDGE' ? `${positionSide} 逐仓保证金` : '逐仓保证金'}</span><strong>{Number(selectedFuturesPosition.isolatedMargin || futuresConfig.isolatedMargin || 0).toFixed(2)} USDT</strong></div>
                  <div className="isolated-margin-actions"><input value={marginAmount} onChange={(event) => setMarginAmount(event.target.value)} inputMode="decimal" placeholder="金额" /><button disabled={configuringFutures} onClick={() => adjustMargin('ADD')}>增加</button><button disabled={configuringFutures} onClick={() => adjustMargin('REMOVE')}>减少</button></div>
                </div>
              )}
              {positionMode === 'ONE_WAY' && <label className="reduce-only-control"><span><ShieldCheck size={14} />只减仓</span><span className="switch"><input type="checkbox" checked={reduceOnly} onChange={(event) => setReduceOnly(event.target.checked)} /><span /></span></label>}
            </div>
          )}
          <label className="field-label" htmlFor="price">委托价格</label>
          <div className={`input-shell ${orderType === 'MARKET' ? 'input-disabled' : ''}`}><input id="price" disabled={orderType === 'MARKET'} value={price} placeholder={formatPrice(tick.price)} onChange={(event) => setPrice(event.target.value)} inputMode="decimal" /><span>USDT</span></div>
          <label className="field-label" htmlFor="amount">数量</label>
          <div className="input-shell"><input id="amount" value={amount} placeholder="0.00" onChange={(event) => setAmount(event.target.value)} inputMode="decimal" /><span>{baseAsset}</span></div>
          <div className="amount-presets">{[0.25, 0.5, 0.75, 1].map((ratio) => <button key={ratio} onClick={() => applyPreset(ratio)}>{ratio === 1 ? '最大' : `${ratio * 100}%`}</button>)}</div>
          <div className="order-summary"><span>{marketType === 'futures' ? '预计保证金' : '预计金额'}</span><strong>{effectivePrice > 0 ? `$${(marketType === 'futures' ? estimated / leverage : estimated).toFixed(2)}` : '--'}</strong><span>可用余额</span><strong>${balance.toFixed(2)}</strong></div>
          <div className={`risk-gate ${halted ? 'risk-gate-closed' : ''}`}><ShieldCheck size={17} /><div><strong>{halted ? '风控闸门已关闭' : tick.connected ? '风控闸门待命' : '等待真实行情'}</strong><span>{environment === 'live' ? '生产订单需要二次确认' : '下单时检查确定性规则'}</span></div></div>
          <button className={`order-button ${orderSide === 'BUY' ? 'order-buy' : 'order-sell'}`} onClick={placeOrder} disabled={halted || !tick.connected || submitting}>{halted ? '执行已停止' : !tick.connected ? '等待行情' : submitting ? '提交中' : `${marketType === 'spot' ? (orderSide === 'BUY' ? '买入' : '卖出') : futuresActionLabel} ${baseAsset}`}</button>
        </aside>
      </section>
      <PortfolioTable positions={livePortfolio} updatedAt={account?.updatedAt} halted={halted} onClosePosition={setClosingPosition} />
      <OverviewAgentsPanel agents={agents} logs={agentLogs} account={account} currentEnvironment={environment} loading={agentsLoading} busyAgentIds={busyAgentIds} onToggle={onToggleAgent} onManage={onManageAgents} onNew={() => onModal('agent')} />
      {closingPosition && <ClosePositionModal environment={environment} position={closingPosition} halted={halted} onClose={() => setClosingPosition(null)} onSubmit={onPlaceOrder} />}
    </main>
  )
}

function ConnectionsView({ environment, binanceConfigured, modelConfigured, modelConfig, proxyUrl, onExchange, onModel, onNetwork, onToast }: { environment: Environment; binanceConfigured: boolean; modelConfigured: boolean; modelConfig: Record<string, string>; proxyUrl: string; onExchange: () => void; onModel: () => void; onNetwork: () => void; onToast: (message: string) => void }) {
  const provider = getModelProvider(modelConfig.provider || 'custom')
  return <main className="page"><section className="page-heading"><div><span className="section-kicker">基础设施</span><h1>连接</h1><p>交易所、模型路由、MCP 与网络出口的配置状态</p></div></section><section className="connection-section"><header className="section-header"><div><h2>交易所</h2><p>凭证加密保存在本机主进程，渲染层无法读取 Secret</p></div><button className="secondary-button" onClick={onExchange}><Plus size={16} />配置 Binance</button></header><div className="connection-list"><article className="connection-row"><span className="exchange-logo large">BN</span><div className="connection-main"><div><h3>Binance · {environmentLabel(environment)}</h3><span className={environment === 'paper' || binanceConfigured ? 'healthy-label' : 'warning-label'}><StatusDot live={environment === 'paper' || binanceConfigured} />{environment === 'paper' ? '本地模拟可用' : binanceConfigured ? '凭证已配置' : '尚未配置'}</span></div><p>现货 · USDT 永续 · 禁止提币 · 生产订单二次确认</p></div><div className="connection-meta"><span>行情</span><strong>共享 WS</strong></div><div className="connection-meta"><span>订单</span><strong>签名 REST</strong></div><button className="icon-button" onClick={onExchange} aria-label="配置 Binance"><Settings2 size={17} /></button></article></div></section><section className="connection-section"><header className="section-header"><div><h2>模型与推理</h2><p>原生 Claude / Gemini 与 OpenAI 兼容路由统一接入 AI 助手</p></div><button className="secondary-button" onClick={onModel}><Plus size={16} />配置模型</button></header><div className="connection-list"><article className="connection-row"><span className="model-logo large"><Command size={19} /></span><div className="connection-main"><div><h3>{modelConfig.model ? `${provider.label} · ${modelConfig.model}` : '模型路由'}</h3><span className={modelConfigured ? 'healthy-label' : 'warning-label'}><StatusDot live={modelConfigured} />{modelConfigured ? '连接已验证' : modelConfig.model ? '需要重新测试' : '等待配置'}</span></div><p>{modelConfig.baseUrl || '支持主流厂商、本地模型和自定义兼容接口'}</p></div><div className="connection-meta"><span>推理强度</span><strong>{modelConfig.reasoningEffort || '--'}</strong></div><div className="connection-meta"><span>最近延迟</span><strong>{modelConfig.lastLatency ? `${modelConfig.lastLatency} ms` : '--'}</strong></div><button className="icon-button" onClick={onModel} aria-label="配置模型"><Settings2 size={17} /></button></article></div></section><section className="connection-section"><header className="section-header"><div><h2>网络出口</h2><p>Binance、远程模型和远程 MCP 共用；本地服务自动直连</p></div><button className="secondary-button" onClick={onNetwork}><Network size={16} />配置代理</button></header><div className="connection-list"><article className="connection-row"><span className="model-logo large"><Network size={19} /></span><div className="connection-main"><div><h3>{proxyUrl ? 'HTTP / HTTPS 代理' : '系统直连'}</h3><span className="healthy-label"><StatusDot live />已启用</span></div><p>{proxyUrl || '未配置应用级代理'}</p></div><div className="connection-meta"><span>本地服务</span><strong>自动绕过</strong></div><div className="connection-meta"><span>变更后</span><strong>立即重连</strong></div><button className="icon-button" onClick={onNetwork} aria-label="配置代理"><Settings2 size={17} /></button></article></div><button className="connection-help" onClick={() => onToast('代理只接受 HTTP / HTTPS URL，不记录代理请求内容')}>网络出口说明</button></section></main>
}

function HoldingsTable({ account, marketType }: { account: AccountSnapshot | null; marketType: MarketType }) {
  if (marketType === 'futures' && account?.positions.length) return <div className="data-table"><div className="table-row table-head"><span>市场</span><span>方向</span><span>持仓</span><span>开仓均价</span><span>标记价格</span><span>未实现盈亏</span></div>{account.positions.map((position, index) => <div className="table-row" key={`${position.symbol}-${index}`}><strong>{position.symbol}</strong><span>{Number(position.positionAmt) >= 0 ? '多' : '空'}</span><span>{position.positionAmt}</span><span>{position.entryPrice}</span><span>{position.markPrice || '--'}</span><strong className={Number(position.unrealizedProfit) >= 0 ? 'text-positive' : 'text-negative'}>{Number(position.unrealizedProfit || 0).toFixed(2)}</strong></div>)}</div>
  if (marketType === 'spot' && account?.balances.length) return <div className="data-table"><div className="table-row holdings-row table-head"><span>资产</span><span>可用</span><span>冻结</span><span>账户来源</span></div>{account.balances.map((balance) => <div className="table-row holdings-row" key={balance.asset}><strong>{balance.asset}</strong><span>{Number(balance.free || 0).toFixed(6)}</span><span>{Number(balance.locked || 0).toFixed(6)}</span><span>{account.source === 'binance' ? 'Binance' : '模拟盘'}</span></div>)}</div>
  return <div className="table-empty"><WalletCards size={22} /><strong>{account ? '当前没有持仓' : '账户数据尚未载入'}</strong><p>{marketType === 'futures' ? '建立合约仓位后会显示方向、均价和实时盈亏' : '非零现货资产会显示在这里'}</p></div>
}

function RiskView({ halted, account, marketType, agents, logs, onEmergency }: { halted: boolean; account: AccountSnapshot | null; marketType: MarketType; agents: AgentDefinition[]; logs: AgentEvent[]; onEmergency: () => void }) {
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const todayLogs = logs.filter((event) => event.timestamp >= todayStart.getTime())
  const checks = todayLogs.filter((event) => event.type === 'RISK_CHECKING').length
  const rejected = todayLogs.filter((event) => ['RISK_REJECTED', 'AI_REJECTED', 'REJECTED'].includes(event.type)).length
  const equity = Number(account?.totalWalletBalance || 0)
  const grossExposure = (account?.portfolio || []).reduce((sum, position) => sum + Math.abs(Number(position.notional || position.marketValue || 0)), 0)
  const exposureRate = equity > 0 ? grossExposure / equity : 0
  const maxRiskFraction = agents.reduce((maximum, agent) => Math.max(maximum, Number(agent.risk.riskFraction) || 0), 0)
  const maxNotional = agents.reduce((maximum, agent) => Math.max(maximum, Number(agent.risk.maxNotional) || 0), 0)
  const pendingLiveIntents = agents.reduce((sum, agent) => sum + (agent.pendingIntents?.filter((intent) => intent.status === 'pending').length || 0), 0)
  const rules = [
    { name: 'Agent 单笔风险', value: agents.length ? `${(maxRiskFraction * 100).toFixed(2)}%` : '--', state: '后端强制', detail: agents.length ? `${agents.length} 个 Agent 中的最高配置，上限 1% 净值` : '创建 Agent 后显示最高配置' },
    { name: 'Agent 名义上限', value: agents.length ? `$${maxNotional.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : '--', state: '逐单校验', detail: '开仓订单在主进程再次检查' },
    { name: '当前总敞口', value: account ? `${(exposureRate * 100).toFixed(2)}%` : '--', state: '实时计算', detail: account ? `$${grossExposure.toLocaleString('en-US', { maximumFractionDigits: 2 })} / 权益 $${equity.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : '等待账户快照' },
    { name: '生产待确认', value: String(pendingLiveIntents), state: pendingLiveIntents ? '需要处理' : '当前为零', detail: '生产 Agent 意图必须在 30 秒内逐笔确认' },
  ]
  return <main className="page"><section className="page-heading"><div><span className="section-kicker">执行前强制检查</span><h1>风险控制</h1><p>规则在 Agent 和交易所之间执行，模型无法绕过</p></div><button className={`emergency-button ${halted ? 'is-halted' : ''}`} onClick={onEmergency}><AlertOctagon size={17} />{halted ? '恢复执行' : '紧急停止'}</button></section><section className={`gate-status ${halted ? 'gate-stopped' : ''}`}><div className="gate-rail"><span /></div><div className="gate-copy"><span className="gate-icon"><ShieldCheck size={22} /></span><div><h2>{halted ? '风控总闸已关闭' : '风控总闸运行中'}</h2><p>{halted ? 'Agent 可以继续分析，但所有新订单都会被拒绝' : '所有订单必须逐项通过规则后才能提交到交易所'}</p></div></div><div className="gate-stats"><div><span>今日检查</span><strong>{checks}</strong></div><div><span>拒绝事件</span><strong className={rejected ? 'text-negative' : ''}>{rejected}</strong></div><div><span>实时盈亏</span><strong className={Number(account?.unrealizedPnl || 0) >= 0 ? 'text-positive' : 'text-negative'}>{Number(account?.unrealizedPnl || 0).toFixed(2)}</strong></div></div></section><section className="rule-grid">{rules.map((rule) => <article className="rule-card" key={rule.name}><header><Gauge size={17} /><span className={rule.state === '需要处理' ? 'warning-label' : 'healthy-label'}>{rule.state}</span></header><h3>{rule.name}</h3><strong>{rule.value}</strong><p>{rule.detail}</p></article>)}</section><section className="panel exposure-panel"><header className="panel-header"><div><h2>{marketType === 'spot' ? '现货资产' : '当前持仓敞口'}</h2><p>按账户最新快照计算</p></div><span className="quiet-chip">{account?.source === 'binance' ? 'Binance 实时' : '模拟数据'}</span></header><HoldingsTable account={account} marketType={marketType} /></section></main>
}

function ExchangeModal({ initialEnvironment, onClose, onSaved }: { initialEnvironment: Environment; onClose: () => void; onSaved: (environment: Environment) => void }) {
  const [environment, setEnvironment] = useState<Environment>(initialEnvironment)
  const [apiKey, setApiKey] = useState('')
  const [apiSecret, setApiSecret] = useState('')
  const [spot, setSpot] = useState(true)
  const [futures, setFutures] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const saveConnection = async () => {
    if (environment !== 'paper' && (!apiKey.trim() || !apiSecret.trim())) return setError('API Key 和 Secret Key 均不能为空')
    if (!spot && !futures) return setError('至少选择一个市场权限')
    setSaving(true); setError(null)
    try {
      if (environment !== 'paper') {
        const marketTypes = [...(spot ? ['spot'] : []), ...(futures ? ['futures'] : [])]
        if (!window.atlas) throw new Error('交易所连接测试需要在桌面应用中运行')
        await window.atlas.binance.test({ environment, marketTypes, apiKey: apiKey.trim(), apiSecret: apiSecret.trim() })
        await saveSecrets(`binance-${environment}`, { environment, apiKey: apiKey.trim(), apiSecret: apiSecret.trim(), marketTypes: marketTypes.join(','), health: 'healthy', lastTestedAt: String(Date.now()) })
      }
      onSaved(environment)
    } catch (caught) { setError(caught instanceof Error ? caught.message : '连接测试失败') } finally { setSaving(false) }
  }
  return <Modal title="连接 Binance" subtitle="凭证仅由 Electron 主进程解密，提币能力不会暴露给工作台" onClose={onClose}><div className="form-stack"><div className="notice-box"><LockKeyhole size={18} /><div><strong>使用专用子账户和 IP 白名单</strong><p>生产 API 只开放读取与交易权限，始终关闭提币</p></div></div><label className="field-label">环境</label><div className="segmented">{(['paper', 'testnet', 'live'] as Environment[]).map((value) => <button key={value} className={environment === value ? 'active' : ''} onClick={() => setEnvironment(value)}>{environmentLabel(value)}</button>)}</div>{environment === 'live' && <div className="production-warning"><AlertOctagon size={16} /><span>正在配置真实资金环境；所有生产订单仍需逐笔二次确认</span></div>}{environment !== 'paper' && <><label className="field-label" htmlFor="api-key">API Key</label><div className="input-shell"><KeyRound size={16} /><input id="api-key" type="password" placeholder="输入 Binance API Key" value={apiKey} onChange={(event) => setApiKey(event.target.value)} /></div><label className="field-label" htmlFor="api-secret">Secret Key</label><div className="input-shell"><KeyRound size={16} /><input id="api-secret" type="password" placeholder="输入 Secret Key" value={apiSecret} onChange={(event) => setApiSecret(event.target.value)} /></div></>}<div className="permission-list"><div><span><Radio size={15} />现货交易</span><label className="switch"><input type="checkbox" checked={spot} onChange={(event) => setSpot(event.target.checked)} /><span /></label></div><div><span><CircleDollarSign size={15} />USDT 永续</span><label className="switch"><input type="checkbox" checked={futures} onChange={(event) => setFutures(event.target.checked)} /><span /></label></div><div><span><Unplug size={15} />提币权限</span><strong className="blocked-label">始终禁用</strong></div></div>{error && <p className="form-error">{error}</p>}<div className="modal-actions"><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" onClick={saveConnection} disabled={saving}><Cable size={16} />{saving ? '正在验证' : environment === 'paper' ? '启用模拟盘' : '测试并保存'}</button></div></div></Modal>
}

function ModelModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [provider, setProvider] = useState('ccswitch')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('http://127.0.0.1:15721/v1')
  const [model, setModel] = useState('claude-sonnet-5-5')
  const [reasoningEffort, setReasoningEffort] = useState('medium')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [remoteModels, setRemoteModels] = useState<Array<{ id: string; name: string }>>([])
  const [testResult, setTestResult] = useState<{ signature: string; latency: number; count: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const providerDefinition = getModelProvider(provider)
  const signature = `${provider}|${providerDefinition.protocol}|${baseUrl.trim()}`
  const availableModels = useMemo(() => [...new Set([...providerDefinition.models, ...remoteModels.map((item) => item.id)])], [providerDefinition.models, remoteModels])

  useEffect(() => {
    let cancelled = false
    getVaultStatus('model-router').then((status) => {
      if (cancelled || !status.config) return
      const config = status.config
      const nextProvider = config.provider || 'custom'
      const legacyCcswitch = nextProvider === 'ccswitch' && /^https?:\/\/(127\.0\.0\.1|localhost):3000(?:\/v1)?\/?$/i.test(config.baseUrl || '')
      const nextBaseUrl = legacyCcswitch ? 'http://127.0.0.1:15721/v1' : config.baseUrl || getModelProvider(nextProvider).baseUrl
      setProvider(nextProvider)
      setBaseUrl(nextBaseUrl)
      setModel(config.model || '')
      setReasoningEffort(config.reasoningEffort || 'medium')
      if (!legacyCcswitch && config.health === 'healthy') setTestResult({ signature: `${nextProvider}|${config.protocol}|${nextBaseUrl}`, latency: Number(config.lastLatency || 0), count: Number(config.modelCount || 0) })
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [])

  const validate = () => {
    if (!baseUrl.trim()) { setError('Base URL 不能为空'); return false }
    try {
      const url = new URL(baseUrl)
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error()
    } catch { setError('请输入有效的 HTTP 或 HTTPS 地址'); return false }
    return true
  }

  const testConnection = async () => {
    if (!validate()) return
    if (!window.atlas) return setError('模型连接测试需要在 Atlas 桌面应用中运行')
    setTesting(true); setError(null); setTestResult(null)
    try {
      const result = await window.atlas.ai.models({ provider, protocol: providerDefinition.protocol, baseUrl: baseUrl.trim(), apiKey: apiKey.trim() || undefined, fallbackModels: providerDefinition.models, force: true })
      setRemoteModels(result.models)
      const nextModels = result.models.map((item) => item.id)
      if (!model.trim() && nextModels[0]) setModel(nextModels[0])
      setTestResult({ signature, latency: result.latency, count: result.models.length })
    } catch (caught) { setError(caught instanceof Error ? caught.message : '模型连接测试失败') } finally { setTesting(false) }
  }

  const saveConnection = async () => {
    if (!validate() || !model.trim()) return setError('Base URL 和模型名称不能为空')
    if (!testResult || testResult.signature !== signature) return setError('请先测试当前厂商和 Base URL，确认模型目录可用')
    setSaving(true); setError(null)
    try {
      const values: Record<string, string> = {
        provider,
        protocol: providerDefinition.protocol,
        reasoningMode: providerDefinition.reasoningMode,
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        reasoningEffort,
        health: 'healthy',
        lastTestedAt: String(Date.now()),
        lastLatency: String(testResult.latency),
        modelCount: String(testResult.count),
      }
      if (apiKey.trim()) values.apiKey = apiKey.trim()
      await saveSecrets('model-router', values)
      onSaved()
    } catch (caught) { setError(caught instanceof Error ? caught.message : '模型配置保存失败') } finally { setSaving(false) }
  }
  const applyProvider = (value: string) => {
    const definition = getModelProvider(value)
    setProvider(value)
    setBaseUrl(definition.baseUrl)
    setModel(definition.defaultModel)
    setApiKey('')
    setRemoteModels([])
    setTestResult(null)
    setError(null)
  }
  return <Modal title="配置模型路由" subtitle="主流厂商原生协议、聚合路由与本地模型统一配置" onClose={onClose}><div className="form-stack"><label className="field-label" htmlFor="provider">模型厂商</label><select id="provider" className="select-field" value={provider} onChange={(event) => applyProvider(event.target.value)}>{modelProviders.map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}</select><p className="model-provider-note">{providerDefinition.note}</p><label className="field-label" htmlFor="base-url">Base URL</label><div className="input-shell"><Network size={16} /><input id="base-url" list="base-url-options" value={baseUrl} onChange={(event) => { setBaseUrl(event.target.value); setTestResult(null) }} /></div><datalist id="base-url-options">{modelProviders.map((item) => <option value={item.baseUrl} key={item.id} />)}</datalist><label className="field-label" htmlFor="model-key">API Key</label><div className="input-shell"><KeyRound size={16} /><input id="model-key" type="password" placeholder={providerDefinition.keyOptional ? '本地服务可留空；已保存密钥会保持不变' : '输入 API Key；留空保持已保存密钥'} value={apiKey} onChange={(event) => { setApiKey(event.target.value); setTestResult(null) }} /></div><div className="model-config-grid"><div><label className="field-label" htmlFor="model-name">默认模型</label><div className="input-shell"><BrainCircuit size={16} /><input id="model-name" list="model-options" value={model} onChange={(event) => setModel(event.target.value)} placeholder="选择或输入模型 ID" /></div><datalist id="model-options">{availableModels.map((modelId) => <option value={modelId} key={modelId} />)}</datalist></div><div><label className="field-label" htmlFor="reasoning-effort">推理强度</label><select id="reasoning-effort" className="select-field" value={reasoningEffort} onChange={(event) => setReasoningEffort(event.target.value)}><option value="none">无</option><option value="minimal">最低</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="xhigh">极高</option><option value="max">最高</option></select></div></div><div className="model-test-row"><button className="secondary-button" onClick={testConnection} disabled={testing}><RefreshCw size={15} />{testing ? '正在读取模型' : '测试连接并刷新模型'}</button>{testResult?.signature === signature && <span className="model-test-result"><StatusDot live />{testResult.count} 个模型 · {testResult.latency} ms</span>}</div><div className="notice-box subtle"><Zap size={18} /><div><strong>执行隔离</strong><p>模型只生成分析和交易意图，不能绕过订单确认与风险规则</p></div></div>{error && <p className="form-error">{error}</p>}<div className="modal-actions"><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" onClick={saveConnection} disabled={saving || testing}><Cable size={16} />{saving ? '加密保存中' : '保存已验证连接'}</button></div></div></Modal>
}

function NetworkModal({ initialProxyUrl, onClose, onSaved }: { initialProxyUrl: string; onClose: () => void; onSaved: (proxyUrl: string, latency: number) => void }) {
  const [proxyUrl, setProxyUrl] = useState(initialProxyUrl)
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const testAndSave = async () => {
    setTesting(true); setError(null)
    try {
      if (!window.atlas) throw new Error('网络测试需要在桌面应用中运行')
      const result = await window.atlas.network.test({ proxyUrl: proxyUrl.trim() || undefined })
      await saveSecrets('network', { proxyUrl: proxyUrl.trim() })
      onSaved(proxyUrl.trim(), result.latency)
    } catch (caught) { setError(caught instanceof Error ? caught.message : '网络测试失败') } finally { setTesting(false) }
  }
  return <Modal title="网络出口" subtitle="为远程 REST、WebSocket、模型和 MCP 配置统一代理" onClose={onClose}><div className="form-stack"><div className="notice-box subtle"><Network size={18} /><div><strong>本地服务保持直连</strong><p>localhost 与 127.0.0.1 的 CCSwitch、模型和 MCP 不经过代理</p></div></div><label className="field-label" htmlFor="proxy-url">HTTP / HTTPS 代理</label><div className="input-shell"><Network size={16} /><input id="proxy-url" value={proxyUrl} onChange={(event) => setProxyUrl(event.target.value)} placeholder="留空使用系统直连，例如 http://127.0.0.1:7890" /></div>{error && <p className="form-error">{error}</p>}<div className="modal-actions"><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" onClick={testAndSave} disabled={testing}><Network size={16} />{testing ? '正在测试' : '测试并应用'}</button></div></div></Modal>
}

function tradingOrderAction(order: TradingOrder) {
  if (order.marketType === 'spot') return order.side === 'BUY' ? '买入' : '卖出'
  if (order.positionSide === 'LONG') return order.side === 'BUY' ? '开多' : '平多'
  if (order.positionSide === 'SHORT') return order.side === 'SELL' ? '开空' : '平空'
  if (order.reduceOnly) return order.side === 'BUY' ? '平空' : '平多'
  return order.side === 'BUY' ? '做多' : '做空'
}

function LiveOrderModal({ order, onClose, onConfirm }: { order: TradingOrder; onClose: () => void; onConfirm: () => Promise<void> }) {
  const [confirmation, setConfirmation] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const confirm = async () => { if (submitting) return; setSubmitting(true); try { await onConfirm() } finally { setSubmitting(false) } }
  return <Modal title="确认生产订单" subtitle="该操作将向 Binance 生产环境提交真实订单" onClose={onClose}><div className="live-order-confirm"><div className="production-warning"><AlertOctagon size={18} /><span>真实资金操作不可撤销。请核对市场、方向、类型、数量和价格。</span></div><dl><div><dt>市场</dt><dd>{order.symbol} · {order.marketType === 'spot' ? '现货' : 'USDT 永续'}</dd></div><div><dt>方向</dt><dd className={order.side === 'BUY' ? 'text-positive' : 'text-negative'}>{tradingOrderAction(order)} · {order.side}{order.positionSide ? ` · ${order.positionSide}` : ''}</dd></div><div><dt>类型</dt><dd>{order.type === 'MARKET' ? '市价' : `限价 ${order.price} USDT`}</dd></div><div><dt>数量</dt><dd>{order.quantity}</dd></div></dl><label className="field-label" htmlFor="live-confirm">输入 LIVE 确认</label><div className="input-shell"><LockKeyhole size={16} /><input id="live-confirm" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder="LIVE" autoComplete="off" /></div><div className="modal-actions"><button className="secondary-button" onClick={onClose}>取消</button><button className="danger-button" onClick={confirm} disabled={confirmation !== 'LIVE' || submitting}>{submitting ? '提交中' : '提交真实订单'}</button></div></div></Modal>
}

export default function App() {
  const [active, setActive] = useState<NavId>('overview')
  const [modal, setModal] = useState<ModalId>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [commandOpen, setCommandOpen] = useState(false)
  const [halted, setHalted] = useState(false)
  const [agentList, setAgentList] = useState<AgentDefinition[]>([])
  const [agentLogs, setAgentLogs] = useState<AgentEvent[]>([])
  const [editingAgent, setEditingAgent] = useState<AgentDefinition | null>(null)
  const [agentsLoading, setAgentsLoading] = useState(true)
  const [agentsError, setAgentsError] = useState<string | null>(null)
  const [busyAgentIds, setBusyAgentIds] = useState<Set<string>>(new Set())
  const [evaluatingAgentIds, setEvaluatingAgentIds] = useState<Set<string>>(new Set())
  const [busyIntentIds, setBusyIntentIds] = useState<Set<string>>(new Set())
  const [toast, setToast] = useState<string | null>(null)
  const [environment, setEnvironment] = useState<Environment>('paper')
  const [marketType, setMarketType] = useState<MarketType>('spot')
  const [symbolsByMarket, setSymbolsByMarket] = useState<Record<MarketType, string>>({ spot: 'BTCUSDT', futures: 'BTCUSDT' })
  const [interval, setInterval] = useState<MarketInterval>('15m')
  const [account, setAccount] = useState<AccountSnapshot | null>(null)
  const [enabledSkills, setEnabledSkills] = useState(new Set(builtInSkills.slice(0, 2).map((skill) => skill.id)))
  const [mcpConnection, setMcpConnection] = useState<McpConnection | null>(null)
  const [binanceEnvironments, setBinanceEnvironments] = useState({ testnet: false, live: false })
  const [modelConfigured, setModelConfigured] = useState(false)
  const [modelConfig, setModelConfig] = useState<Record<string, string>>({})
  const [proxyUrl, setProxyUrl] = useState('')
  const [connectionRevision, setConnectionRevision] = useState(0)
  const [pendingLiveOrder, setPendingLiveOrder] = useState<TradingOrder | null>(null)
  const [orders, setOrders] = useState<TradingOrder[]>([])
  const [ordersLoading, setOrdersLoading] = useState(false)
  const [refreshingAll, setRefreshingAll] = useState(false)
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null)
  const [marketRefreshKey, setMarketRefreshKey] = useState(0)
  const accountRequestId = useRef(0)
  const ordersRequestId = useRef(0)
  const symbol = symbolsByMarket[marketType]
  const { tick, book } = useMarketData(environment, marketType, symbol, interval, marketRefreshKey)
  const binanceConfigured = environment === 'paper' ? true : binanceEnvironments[environment]
  const latestTick = useRef(tick)
  useEffect(() => { latestTick.current = tick }, [tick])

  const showToast = useCallback((message: string) => {
    setToast(message)
    window.setTimeout(() => setToast(null), 3200)
  }, [])

  const refreshAgents = useCallback(async () => {
    if (!window.atlas?.agents) {
      setAgentsLoading(false)
      setAgentsError('Agent 运行时桥接尚未载入，请重新启动 Atlas 桌面开发版')
      return false
    }
    setAgentsLoading(true)
    try {
      const [definitions, events] = await Promise.all([
        window.atlas.agents.list(),
        window.atlas.agents.logs({ limit: 500 }),
      ])
      setAgentList(definitions)
      setAgentLogs(events)
      setAgentsError(null)
      return true
    } catch (caught) {
      setAgentsError(caught instanceof Error ? caught.message : 'Agent 运行时同步失败')
      return false
    } finally {
      setAgentsLoading(false)
    }
  }, [])

  useEffect(() => {
    let active = true
    let inFlight = false
    const poll = async () => {
      if (!active || inFlight) return
      inFlight = true
      try { await refreshAgents() } finally { inFlight = false }
    }
    void poll()
    const timer = window.setInterval(poll, 1800)
    return () => { active = false; window.clearInterval(timer) }
  }, [refreshAgents])

  const changeSymbol = useCallback((value: string) => {
    accountRequestId.current += 1
    ordersRequestId.current += 1
    setAccount(null)
    setOrders([])
    setPendingLiveOrder(null)
    setSymbolsByMarket((current) => current[marketType] === value ? current : { ...current, [marketType]: value })
  }, [marketType])

  useEffect(() => {
    const keyHandler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setCommandOpen(true) }
      if (event.key === 'Escape') setCommandOpen(false)
    }
    window.addEventListener('keydown', keyHandler)
    return () => window.removeEventListener('keydown', keyHandler)
  }, [])

  useEffect(() => {
    window.atlas?.risk?.status().then((result) => setHalted(result.halted))
  }, [])

  useEffect(() => {
    let cancelled = false
    Promise.all([getVaultStatus('binance-testnet'), getVaultStatus('binance-live'), getVaultStatus('binance-primary'), getVaultStatus('model-router'), getVaultStatus('network')]).then(([testnet, live, legacy, model, network]) => {
      if (!cancelled) {
        setBinanceEnvironments({
          testnet: testnet.config?.health === 'healthy' || (legacy.config?.environment === 'testnet' && legacy.configured),
          live: live.config?.health === 'healthy' || (legacy.config?.environment === 'live' && legacy.configured),
        })
        setModelConfig(model.config || {})
        setModelConfigured(model.config?.health === 'healthy')
        setProxyUrl(network.config?.proxyUrl || '')
      }
    })
    return () => { cancelled = true }
  }, [connectionRevision])

  const refreshAccount = useCallback(async () => {
    const requestId = ++accountRequestId.current
    if (!window.atlas?.binance || (environment !== 'paper' && !binanceConfigured)) {
      if (requestId === accountRequestId.current) setAccount(null)
      return false
    }
    try {
      const currentTick = latestTick.current
      const snapshot = await window.atlas.binance.account({
        environment,
        marketType,
        symbol,
        markPrice: currentTick.symbol === symbol && currentTick.connected ? currentTick.price : undefined,
      })
      if (requestId !== accountRequestId.current) return false
      if (snapshot && snapshot.environment === environment && snapshot.marketType === marketType) {
        setAccount(snapshot)
        return true
      }
      return false
    } catch (caught) {
      if (requestId === accountRequestId.current) {
        setAccount(null)
        showToast(caught instanceof Error ? caught.message : '账户同步失败')
      }
      return false
    }
  }, [binanceConfigured, environment, marketType, showToast, symbol])

  const refreshOrders = useCallback(async (notify = false) => {
    const requestId = ++ordersRequestId.current
    if (!window.atlas?.binance || (environment !== 'paper' && !binanceConfigured)) {
      setOrders([])
      setOrdersLoading(false)
      if (notify) showToast(window.atlas?.binance ? `请先配置 Binance ${environmentLabel(environment)}凭证` : '订单同步需要在 Atlas 桌面应用中运行')
      return false
    }
    setOrdersLoading(true)
    try {
      const data = await window.atlas.binance.orders({ environment, marketType, symbol })
      if (requestId !== ordersRequestId.current) return false
      setOrders(data)
      if (notify) showToast(`订单已同步 · ${data.length} 条`)
      return true
    } catch (caught) {
      if (requestId === ordersRequestId.current && notify) showToast(caught instanceof Error ? caught.message : '订单同步失败')
      return false
    } finally {
      if (requestId === ordersRequestId.current) setOrdersLoading(false)
    }
  }, [binanceConfigured, environment, marketType, showToast, symbol])

  useEffect(() => {
    const timer = window.setTimeout(() => { void refreshOrders() }, 0)
    return () => window.clearTimeout(timer)
  }, [refreshOrders])

  useEffect(() => {
    if (active !== 'orders') return
    const timer = window.setInterval(() => { void refreshOrders() }, 3000)
    return () => window.clearInterval(timer)
  }, [active, refreshOrders])

  useEffect(() => {
    if (environment === 'paper' || !binanceConfigured || !window.atlas) return
    const options = { environment, marketType }
    let refreshTimer: number | null = null
    const off = window.atlas.binance.onAccountUpdate((update) => {
      if (update.type !== 'account' || update.environment !== environment || update.marketType !== marketType) return
      if (refreshTimer) window.clearTimeout(refreshTimer)
      refreshTimer = window.setTimeout(refreshAccount, 100)
    })
    window.atlas.binance.subscribeAccount(options).catch((caught) => showToast(caught instanceof Error ? caught.message : '账户实时数据流连接失败'))
    return () => {
      off()
      if (refreshTimer) window.clearTimeout(refreshTimer)
      window.atlas?.binance.unsubscribeAccount(options)
    }
  }, [binanceConfigured, environment, marketType, refreshAccount, showToast])

  useEffect(() => {
    if (!binanceConfigured) return
    let active = true
    let inFlight = false
    const refresh = async () => {
      if (!active || inFlight) return
      inFlight = true
      try { await refreshAccount() } finally { inFlight = false }
    }
    void refresh()
    const timer = window.setInterval(refresh, environment === 'paper' ? 1000 : 5000)
    return () => { active = false; window.clearInterval(timer) }
  }, [binanceConfigured, environment, refreshAccount])

  const toggleAgent = useCallback(async (agent: AgentDefinition) => {
    if (!window.atlas?.agents || busyAgentIds.has(agent.id)) {
      if (!window.atlas?.agents) showToast('Agent 运行时桥接尚未载入，请重新启动 Atlas 桌面开发版')
      return
    }
    setBusyAgentIds((current) => new Set(current).add(agent.id))
    try {
      if (agent.status === 'running') await window.atlas.agents.pause(agent.id)
      else await window.atlas.agents.start(agent.id)
      await refreshAgents()
      showToast(`${agent.name} 已${agent.status === 'running' ? '暂停' : '启动'}`)
    } catch (caught) {
      showToast(caught instanceof Error ? caught.message : 'Agent 状态更新失败')
    } finally {
      setBusyAgentIds((current) => { const next = new Set(current); next.delete(agent.id); return next })
    }
  }, [busyAgentIds, refreshAgents, showToast])

  const evaluateAgent = useCallback(async (agent: AgentDefinition) => {
    if (!window.atlas?.agents || evaluatingAgentIds.has(agent.id)) return
    setEvaluatingAgentIds((current) => new Set(current).add(agent.id))
    try {
      const result = await window.atlas.agents.evaluateNow(agent.id)
      await refreshAgents()
      if (result.error) showToast(`${agent.name} 评估失败：${result.error}`)
      else showToast(result.evaluated ? `${agent.name} 已完成最新闭合 K 线评估` : `${agent.name} 已检查，正在等待新闭合 K 线`)
    } catch (caught) {
      showToast(caught instanceof Error ? caught.message : 'Agent 立即评估失败')
    } finally {
      setEvaluatingAgentIds((current) => { const next = new Set(current); next.delete(agent.id); return next })
    }
  }, [evaluatingAgentIds, refreshAgents, showToast])

  const createAgent = useCallback(async (definition: AgentCreateInput) => {
    if (!window.atlas?.agents) throw new Error('Agent 运行时桥接尚未载入，请重新启动 Atlas 桌面开发版')
    const created = await window.atlas.agents.create(definition)
    await refreshAgents()
    setModal(null)
    setEditingAgent(null)
    setActive('agents')
    showToast(`${created.name} 已创建，当前保持暂停`)
  }, [refreshAgents, showToast])

  const updateAgent = useCallback(async (definition: AgentCreateInput) => {
    if (!window.atlas?.agents) throw new Error('Agent 运行时桥接尚未载入，请重新启动 Atlas 桌面开发版')
    if (!editingAgent) throw new Error('没有可编辑的 Agent')
    const updated = await window.atlas.agents.update(editingAgent.id, definition, editingAgent.revision)
    await refreshAgents()
    setModal(null)
    setEditingAgent(null)
    setActive('agents')
    showToast(`${updated.name} 已保存并暂停，请确认配置后重新启动`)
  }, [editingAgent, refreshAgents, showToast])

  const openNewAgent = useCallback(() => {
    setEditingAgent(null)
    setModal('agent')
  }, [])

  const openEditAgent = useCallback((agent: AgentDefinition) => {
    setEditingAgent(agent)
    setModal('agent')
  }, [])

  const closeAgentModal = useCallback(() => {
    setModal(null)
    setEditingAgent(null)
  }, [])

  const confirmAgentIntent = useCallback(async (intent: AgentIntent) => {
    if (!window.atlas?.agents || busyIntentIds.has(intent.id)) {
      if (!window.atlas?.agents) showToast('Agent 运行时桥接尚未载入，请重新启动 Atlas 桌面开发版')
      return
    }
    setBusyIntentIds((current) => new Set(current).add(intent.id))
    try {
      const result = await window.atlas.agents.confirmIntent(intent.id)
      showToast(`生产订单已提交 · ${result.order.status || 'NEW'} · ${result.order.symbol}`)
    } catch (caught) {
      showToast(caught instanceof Error ? caught.message : '生产订单确认失败')
    } finally {
      await refreshAgents()
      setBusyIntentIds((current) => { const next = new Set(current); next.delete(intent.id); return next })
    }
  }, [busyIntentIds, refreshAgents, showToast])
  const toggleSkill = (id: string) => setEnabledSkills((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next })

  const placeOrder = useCallback(async (order: TradingOrder) => {
    try {
      if (!window.atlas) throw new Error('订单执行需要在 Atlas 桌面应用中运行')
      if (order.environment === 'live') {
        const preparedOrder = await window.atlas.binance.prepareOrder(order)
        setPendingLiveOrder(preparedOrder)
        return true
      }
      const result = await window.atlas.binance.placeOrder(order)
      await Promise.all([refreshAccount(), refreshOrders()])
      showToast(`${environmentLabel(order.environment)}订单已提交 · ${result.status || 'NEW'} · ${order.symbol}`)
      return true
    } catch (caught) {
      showToast(caught instanceof Error ? caught.message : '订单提交失败')
      return false
    }
  }, [refreshAccount, refreshOrders, showToast])

  const confirmLiveOrder = async () => {
    if (!pendingLiveOrder) return
    try {
      const result = await window.atlas?.binance.placeOrder({ ...pendingLiveOrder, confirmation: 'LIVE_ORDER_CONFIRMED' })
      await Promise.all([refreshAccount(), refreshOrders()])
      setPendingLiveOrder(null)
      showToast(`生产订单已提交 · ${result?.status || 'NEW'} · ${pendingLiveOrder.symbol}`)
    } catch (caught) { showToast(caught instanceof Error ? caught.message : '生产订单提交失败') }
  }

  const changeEnvironment = (value: Environment) => {
    if (value === environment) return
    accountRequestId.current += 1
    ordersRequestId.current += 1
    setAccount(null)
    setOrders([])
    setPendingLiveOrder(null)
    setEnvironment(value)
    showToast(value === 'live' ? '已切换到生产环境，真实订单需要逐笔确认' : `已切换到${environmentLabel(value)}`)
  }

  const changeMarketType = (value: MarketType) => {
    if (value === marketType) return
    accountRequestId.current += 1
    ordersRequestId.current += 1
    setAccount(null)
    setOrders([])
    setPendingLiveOrder(null)
    setMarketType(value)
    showToast(`已切换到${value === 'spot' ? '现货' : 'USDT 永续'}`)
  }

  const navigate = (id: string) => {
    if (navigation.some((item) => item.id === id)) setActive(id as NavId)
  }

  const refreshAll = useCallback(async () => {
    if (refreshingAll) return
    setRefreshingAll(true)
    setMarketRefreshKey((key) => key + 1)
    try {
      const results = await Promise.all([refreshAccount(), refreshOrders(), refreshAgents()])
      const succeeded = results.filter(Boolean).length
      const refreshedAt = Date.now()
      setLastRefreshedAt(refreshedAt)
      showToast(succeeded === results.length
        ? `实时数据已刷新 · ${new Date(refreshedAt).toLocaleTimeString('zh-CN', { hour12: false })}`
        : `已刷新 ${succeeded}/${results.length} 个数据模块，请检查连接状态`)
    } finally {
      setRefreshingAll(false)
    }
  }, [refreshAccount, refreshAgents, refreshingAll, refreshOrders, showToast])

  const notifications = useMemo<AppNotification[]>(() => {
    const items: AppNotification[] = []
    if (halted) items.push({ id: 'execution-halted', title: '交易执行已停止', detail: '风控总闸正在拒绝所有新订单', navigateTo: 'risk', tone: 'warning' })
    if (environment !== 'paper' && !binanceConfigured) items.push({ id: 'binance-unconfigured', title: `Binance ${environmentLabel(environment)}尚未配置`, detail: '账户、订单和 Agent 执行保持禁用', navigateTo: 'connections', tone: 'warning' })
    if (!modelConfigured) items.push({ id: 'model-unconfigured', title: '模型路由尚未验证', detail: 'AI 助手和 AI 监督 Agent 暂不可用', navigateTo: 'connections', tone: 'warning' })
    ;[...agentLogs]
      .filter((event) => event.level !== 'info')
      .sort((left, right) => right.timestamp - left.timestamp)
      .slice(0, 3)
      .forEach((event) => items.push({ id: `agent-${event.id}`, title: event.type.startsWith('AI_') ? 'AI 监督需要检查' : 'Agent 运行事件', detail: event.message, timestamp: event.timestamp, navigateTo: 'agents', tone: 'warning' }))
    if (!items.length) items.push({ id: 'healthy', title: '当前没有待处理事项', detail: '交易所、模型和 Agent 未报告告警', navigateTo: 'overview', tone: 'healthy' })
    return items
  }, [agentLogs, binanceConfigured, environment, halted, modelConfigured])
  const notificationCount = notifications.filter((item) => item.tone === 'warning').length

  return (
    <MarketEnvironmentContext.Provider value={environment}>
    <div className="app-shell">
      <Sidebar active={active} onNavigate={setActive} open={sidebarOpen} onClose={() => setSidebarOpen(false)} environment={environment} binanceConfigured={binanceConfigured} modelConfigured={modelConfigured} agentCount={agentList.length} />
      {sidebarOpen && <button className="sidebar-scrim" onClick={() => setSidebarOpen(false)} aria-label="关闭导航" />}
      <div className="app-main">
        <Topbar environment={environment} marketType={marketType} refreshing={refreshingAll} lastRefreshedAt={lastRefreshedAt} notificationCount={notificationCount} onEnvironment={changeEnvironment} onMarketType={changeMarketType} onMenu={() => setSidebarOpen(true)} onModal={setModal} onSearch={() => setCommandOpen(true)} onRefresh={() => void refreshAll()} onAccount={() => showToast('本地工作区用户 · 凭证由系统钥匙串保护')} />
        {active === 'overview' && <Overview key={`${environment}:${marketType}:${symbol}`} environment={environment} marketType={marketType} symbol={symbol} interval={interval} marketRefreshKey={marketRefreshKey} account={account} tick={tick} book={book} halted={halted} agents={agentList} agentLogs={agentLogs} agentsLoading={agentsLoading} busyAgentIds={busyAgentIds} onSymbol={changeSymbol} onInterval={setInterval} onModal={(id) => { if (id === 'agent') openNewAgent(); else setModal(id) }} onToggleAgent={toggleAgent} onManageAgents={() => setActive('agents')} onPlaceOrder={placeOrder} onRefreshAccount={refreshAccount} onToast={showToast} />}
        {active === 'assistant' && <AssistantView environment={environment} marketType={marketType} symbol={symbol} tick={tick} account={account} halted={halted} enabledSkills={[...enabledSkills]} mcpConnection={mcpConnection} onOpenConnections={() => setModal('model')} />}
        {active === 'agents' && <AgentsView agents={agentList} logs={agentLogs} account={account} currentEnvironment={environment} loading={agentsLoading} error={agentsError} busyAgentIds={busyAgentIds} evaluatingAgentIds={evaluatingAgentIds} busyIntentIds={busyIntentIds} onToggle={toggleAgent} onEvaluate={evaluateAgent} onConfirmIntent={confirmAgentIntent} onRefresh={async () => { await refreshAgents() }} onNew={openNewAgent} onEdit={openEditAgent} />}
        {active === 'strategies' && <StrategiesView environment={environment} marketType={marketType} symbol={symbol} interval={interval} onToast={showToast} />}
        {active === 'skills' && <SkillsView enabled={enabledSkills} onToggle={toggleSkill} onToast={showToast} mcpConnection={mcpConnection} onMcpConnection={setMcpConnection} />}
        {active === 'connections' && <ConnectionsView environment={environment} binanceConfigured={binanceConfigured} modelConfigured={modelConfigured} modelConfig={modelConfig} proxyUrl={proxyUrl} onExchange={() => setModal('exchange')} onModel={() => setModal('model')} onNetwork={() => setModal('network')} onToast={showToast} />}
        {active === 'risk' && <RiskView halted={halted} account={account} marketType={marketType} agents={agentList} logs={agentLogs} onEmergency={() => setModal('emergency')} />}
        {active === 'orders' && <OrdersView environment={environment} marketType={marketType} symbol={symbol} tick={tick} account={account} orders={orders} loading={ordersLoading} onRefresh={() => refreshOrders(true)} onToast={showToast} />}
        {active === 'review' && <ReviewView orders={orders} agentLogs={agentLogs} onToast={showToast} />}
      </div>

      {commandOpen && <CommandPalette onClose={() => setCommandOpen(false)} onNavigate={navigate} />}
      {modal === 'exchange' && <ExchangeModal initialEnvironment={environment} onClose={() => setModal(null)} onSaved={(value) => { setModal(null); changeEnvironment(value); setConnectionRevision((revision) => revision + 1); showToast(value === 'paper' ? '模拟盘已启用' : `Binance ${environmentLabel(value)}连接测试通过`) }} />}
      {modal === 'model' && <ModelModal onClose={() => setModal(null)} onSaved={() => { setModal(null); setConnectionRevision((revision) => revision + 1); showToast('模型路由已保存，可在 AI 助手中发起真实请求') }} />}
      {modal === 'network' && <NetworkModal initialProxyUrl={proxyUrl} onClose={() => setModal(null)} onSaved={(value, latency) => { setProxyUrl(value); setModal(null); setConnectionRevision((revision) => revision + 1); showToast(`网络出口测试通过 · ${latency} ms · 行情正在重连`) }} />}
      {modal === 'agent' && <AgentCreateModal agent={editingAgent} initialEnvironment={environment} initialMarketType={marketType} initialSymbol={symbol} enabledSkills={[...enabledSkills]} mcpConnection={mcpConnection} modelConfigured={modelConfigured} modelName={modelConfig.model} onClose={closeAgentModal} onSubmit={editingAgent ? updateAgent : createAgent} />}
      {modal === 'emergency' && <Modal title={halted ? '恢复交易执行' : '紧急停止所有执行'} subtitle={halted ? '恢复后 Agent 仍需逐笔通过风控规则' : '立即拒绝所有新订单，不影响行情监控'} onClose={() => setModal(null)}><div className="emergency-dialog"><AlertOctagon size={28} /><p>{halted ? '确认风控规则和交易所连接均正常后再恢复。已暂停的 Agent 不会自动启动。' : '运行中的 Agent 将切换为只分析模式。已提交的未成交订单需要在交易所侧单独处理。'}</p><div className="modal-actions"><button className="secondary-button" onClick={() => setModal(null)}>取消</button><button className={halted ? 'primary-button' : 'danger-button'} onClick={async () => { const next = !halted; try { await window.atlas?.risk?.setHalted(next); setHalted(next); setModal(null); showToast(next ? '已触发紧急停止，主进程将拒绝所有新订单' : '交易执行已恢复') } catch (caught) { showToast(caught instanceof Error ? caught.message : '风控总闸更新失败') } }}>{halted ? '确认恢复' : '确认停止'}</button></div></div></Modal>}
      {modal === 'notifications' && <Modal title="通知" subtitle={`${notificationCount} 条待处理 · 来自当前连接与 Agent 日志`} onClose={() => setModal(null)}><div className="notification-list">{notifications.map((item) => <button key={item.id} onClick={() => { setModal(null); setActive(item.navigateTo) }}><span className={`notification-icon ${item.tone === 'warning' ? 'warning' : ''}`}>{item.tone === 'warning' ? <AlertOctagon size={16} /> : <ShieldCheck size={16} />}</span><div><strong>{item.title}</strong><p>{item.detail}</p><small>{relativeTime(item.timestamp)}</small></div></button>)}</div></Modal>}
      {pendingLiveOrder && <LiveOrderModal order={pendingLiveOrder} onClose={() => setPendingLiveOrder(null)} onConfirm={confirmLiveOrder} />}
      {toast && <div className="toast"><ShieldCheck size={17} /><span>{toast}</span><button onClick={() => setToast(null)} aria-label="关闭"><X size={15} /></button></div>}
    </div>
    </MarketEnvironmentContext.Provider>
  )
}
