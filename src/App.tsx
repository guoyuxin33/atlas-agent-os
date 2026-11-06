import { useMemo, useState } from 'react'
import {
  Activity,
  AlertOctagon,
  ArrowUpRight,
  Bell,
  Bot,
  BrainCircuit,
  Cable,
  ChartCandlestick,
  ChevronDown,
  ChevronRight,
  CircleDollarSign,
  Command,
  FileClock,
  Gauge,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  LockKeyhole,
  Menu,
  MessageSquareText,
  MoreHorizontal,
  Network,
  Pause,
  Play,
  Plus,
  Radio,
  ReceiptText,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  SquareActivity,
  Unplug,
  WalletCards,
  X,
  Zap,
} from 'lucide-react'
import { MarketChart } from './components/MarketChart'
import { Modal } from './components/Modal'
import { activity, agents as initialAgents, positions, riskRules, type Agent } from './data'
import { useBinanceTicker } from './hooks/useBinanceTicker'
import { saveSecrets } from './lib/desktop'

type NavId = 'overview' | 'agents' | 'strategies' | 'connections' | 'risk' | 'orders' | 'review'
type ModalId = 'exchange' | 'model' | 'agent' | 'emergency' | 'notifications' | null

const navigation: Array<{ id: NavId; label: string; icon: typeof LayoutDashboard }> = [
  { id: 'overview', label: '工作台', icon: LayoutDashboard },
  { id: 'agents', label: 'Agent', icon: Bot },
  { id: 'strategies', label: '策略库', icon: BrainCircuit },
  { id: 'connections', label: '连接', icon: Cable },
  { id: 'risk', label: '风控', icon: ShieldCheck },
  { id: 'orders', label: '订单', icon: ReceiptText },
  { id: 'review', label: '复盘', icon: FileClock },
]

function formatPrice(value: number) {
  return new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)
}

function StatusDot({ live = false }: { live?: boolean }) {
  return <span className={`status-dot ${live ? 'status-dot-live' : ''}`} />
}

function Sidebar({ active, onNavigate, open, onClose }: { active: NavId; onNavigate: (id: NavId) => void; open: boolean; onClose: () => void }) {
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
        {navigation.slice(0, 4).map((item) => (
          <button
            key={item.id}
            className={`nav-item ${active === item.id ? 'nav-item-active' : ''}`}
            onClick={() => { onNavigate(item.id); onClose() }}
          >
            <item.icon size={17} />
            <span>{item.label}</span>
            {item.id === 'agents' && <span className="nav-count">3</span>}
          </button>
        ))}

        <p className="nav-label nav-label-spaced">控制与记录</p>
        {navigation.slice(4).map((item) => (
          <button
            key={item.id}
            className={`nav-item ${active === item.id ? 'nav-item-active' : ''}`}
            onClick={() => { onNavigate(item.id); onClose() }}
          >
            <item.icon size={17} />
            <span>{item.label}</span>
          </button>
        ))}
      </nav>

      <div className="sidebar-spacer" />
      <div className="account-block">
        <div className="account-line">
          <span className="exchange-logo">BN</span>
          <div><strong>Binance Testnet</strong><span><StatusDot live /> 已连接</span></div>
          <MoreHorizontal size={17} />
        </div>
        <div className="account-line model-line">
          <span className="model-logo"><Command size={15} /></span>
          <div><strong>CCSwitch Router</strong><span>Claude Sonnet 4.5</span></div>
          <ChevronRight size={16} />
        </div>
      </div>
      <p className="unslop-credit">Interface direction · unslop by @heydamir</p>
    </aside>
  )
}

function Topbar({ onMenu, onModal }: { onMenu: () => void; onModal: (id: ModalId) => void }) {
  return (
    <header className="topbar">
      <button className="menu-button" onClick={onMenu} aria-label="打开导航"><Menu size={19} /></button>
      <div className="command-search">
        <Search size={16} />
        <span>搜索 Agent、市场或订单</span>
        <kbd>⌘ K</kbd>
      </div>
      <div className="topbar-actions">
        <button className="testnet-chip"><StatusDot live /> 模拟盘</button>
        <button className="icon-button notification-button" onClick={() => onModal('notifications')} aria-label="通知">
          <Bell size={18} /><span />
        </button>
        <button className="avatar-button" aria-label="账户菜单">YX</button>
      </div>
    </header>
  )
}

function Metric({ label, value, detail, tone }: { label: string; value: string; detail: string; tone?: 'positive' | 'negative' | 'accent' }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong className={tone ? `text-${tone}` : ''}>{value}</strong>
      <small>{detail}</small>
    </div>
  )
}

function AgentRow({ agent, onToggle }: { agent: Agent; onToggle: (id: string) => void }) {
  const running = agent.status === 'running'
  return (
    <div className="agent-row">
      <div className={`agent-icon agent-icon-${agent.id}`}><Bot size={17} /></div>
      <div className="agent-main">
        <div><strong>{agent.name}</strong><span className={`agent-state state-${agent.status}`}><StatusDot live={running} />{running ? '运行中' : agent.status === 'observing' ? '观察中' : '已暂停'}</span></div>
        <span>{agent.market} · {agent.strategy}</span>
      </div>
      <div className="agent-allocation"><span>资金占用</span><strong>{agent.allocation}%</strong></div>
      <div className={`agent-pnl ${agent.pnl >= 0 ? 'text-positive' : 'text-negative'}`}>
        <span>今日</span><strong>{agent.pnl >= 0 ? '+' : ''}{agent.pnl.toFixed(2)}%</strong>
      </div>
      <button className="icon-button" onClick={() => onToggle(agent.id)} aria-label={running ? `暂停${agent.name}` : `运行${agent.name}`}>
        {running ? <Pause size={16} /> : <Play size={16} />}
      </button>
    </div>
  )
}

function Overview({ onModal, halted, agents, onToggleAgent, onToast }: {
  onModal: (id: ModalId) => void
  halted: boolean
  agents: Agent[]
  onToggleAgent: (id: string) => void
  onToast: (message: string) => void
}) {
  const tick = useBinanceTicker()
  const [orderSide, setOrderSide] = useState<'buy' | 'sell'>('buy')
  const [orderType, setOrderType] = useState<'market' | 'limit'>('limit')
  const [amount, setAmount] = useState('0.008')

  const estimated = useMemo(() => Number(amount || 0) * tick.price, [amount, tick.price])

  const placeOrder = () => {
    if (halted) {
      onToast('风控总闸已关闭，订单未提交')
      return
    }
    onToast(`模拟订单已进入风控队列 · ${orderSide === 'buy' ? '买入' : '卖出'} ${amount} BTC`)
  }

  return (
    <main className="page overview-page">
      <section className="page-heading">
        <div>
          <div className="heading-eyebrow"><StatusDot live={!halted} /> {halted ? '所有执行已停止' : '系统运行正常'}<span>最后检查 8 秒前</span></div>
          <h1>交易工作台</h1>
          <p>Agent 正在监控 12 个市场，所有订单均经过风控闸门</p>
        </div>
        <div className="heading-actions">
          <button className="secondary-button" onClick={() => onModal('exchange')}><Cable size={16} />连接交易所</button>
          <button className="primary-button" onClick={() => onModal('agent')}><Plus size={16} />新建 Agent</button>
        </div>
      </section>

      <section className="metrics-strip">
        <Metric label="账户净值" value="$24,892.40" detail="模拟盘资金" />
        <Metric label="今日盈亏" value="+$482.16" detail="+1.98% vs 00:00" tone="positive" />
        <Metric label="当前敞口" value="$2,837.20" detail="净值的 11.4%" tone="accent" />
        <Metric label="运行中 Agent" value={halted ? '0 / 3' : '1 / 3'} detail={halted ? '总闸已关闭' : '1 个等待信号'} />
      </section>

      <section className="dashboard-grid">
        <article className="panel market-panel">
          <header className="panel-header market-header">
            <div className="market-title">
              <span className="asset-mark">₿</span>
              <div><strong>BTC / USDT</strong><span>现货 · Binance</span></div>
              <button className="bare-button" aria-label="切换市场"><ChevronDown size={15} /></button>
            </div>
            <div className="market-price">
              <strong>${formatPrice(tick.price)}</strong>
              <span className={tick.change >= 0 ? 'text-positive' : 'text-negative'}>{tick.change >= 0 ? '+' : ''}{tick.change.toFixed(2)}%</span>
            </div>
            <div className="market-stat"><span>24h 高</span><strong>{formatPrice(tick.high)}</strong></div>
            <div className="market-stat"><span>24h 低</span><strong>{formatPrice(tick.low)}</strong></div>
            <div className="market-connection"><StatusDot live={tick.connected} />{tick.connected ? '实时' : '重连中'}</div>
          </header>
          <div className="chart-toolbar">
            <div className="segmented compact"><button className="active">15m</button><button>1h</button><button>4h</button><button>1D</button></div>
            <button className="bare-button"><SlidersHorizontal size={15} />指标</button>
          </div>
          <MarketChart />
        </article>

        <aside className="panel order-panel">
          <header className="panel-header"><div><h2>快速下单</h2><p>提交后先进入风控队列</p></div><LockKeyhole size={17} /></header>
          <div className="segmented order-side"><button className={orderSide === 'buy' ? 'active buy-active' : ''} onClick={() => setOrderSide('buy')}>买入</button><button className={orderSide === 'sell' ? 'active sell-active' : ''} onClick={() => setOrderSide('sell')}>卖出</button></div>
          <label className="field-label">订单类型</label>
          <div className="segmented order-type"><button className={orderType === 'limit' ? 'active' : ''} onClick={() => setOrderType('limit')}>限价</button><button className={orderType === 'market' ? 'active' : ''} onClick={() => setOrderType('market')}>市价</button></div>
          <label className="field-label" htmlFor="price">委托价格</label>
          <div className={`input-shell ${orderType === 'market' ? 'input-disabled' : ''}`}><input id="price" disabled={orderType === 'market'} defaultValue={formatPrice(tick.price)} /><span>USDT</span></div>
          <label className="field-label" htmlFor="amount">数量</label>
          <div className="input-shell"><input id="amount" value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" /><span>BTC</span></div>
          <div className="amount-presets"><button>25%</button><button>50%</button><button>75%</button><button>最大</button></div>
          <div className="order-summary"><span>预计金额</span><strong>${estimated.toFixed(2)}</strong><span>预计手续费</span><strong>$0.43</strong></div>
          <div className={`risk-gate ${halted ? 'risk-gate-closed' : ''}`}>
            <ShieldCheck size={17} />
            <div><strong>{halted ? '风控闸门已关闭' : '风控闸门待命'}</strong><span>{halted ? '所有订单将被拒绝' : '下单时检查 8 项规则'}</span></div>
          </div>
          <button className={`order-button order-${orderSide}`} onClick={placeOrder} disabled={halted}>{halted ? '执行已停止' : `${orderSide === 'buy' ? '买入' : '卖出'} BTC`}</button>
        </aside>
      </section>

      <section className="lower-grid">
        <article className="panel agent-panel">
          <header className="panel-header"><div><h2>Agent 状态</h2><p>策略、资金占用与最近动作</p></div><button className="text-button" onClick={() => onModal('agent')}>管理 Agent <ChevronRight size={15} /></button></header>
          <div className="agent-list">{agents.map((agent) => <AgentRow key={agent.id} agent={agent} onToggle={onToggleAgent} />)}</div>
        </article>
        <article className="panel activity-panel">
          <header className="panel-header"><div><h2>决策流水</h2><p>模型推理与执行审计</p></div><button className="icon-button" aria-label="筛选"><ListChecks size={17} /></button></header>
          <div className="activity-list">
            {activity.map((item) => (
              <div className="activity-row" key={item.time}>
                <div className={`timeline-mark mark-${item.status}`} />
                <div><span>{item.time} · {item.agent}</span><strong>{item.title}</strong><p>{item.detail}</p></div>
              </div>
            ))}
          </div>
        </article>
      </section>
    </main>
  )
}

function AgentsView({ agents, onToggle, onNew }: { agents: Agent[]; onToggle: (id: string) => void; onNew: () => void }) {
  return (
    <main className="page">
      <section className="page-heading"><div><span className="section-kicker">自治执行单元</span><h1>Agent</h1><p>为每个策略定义数据、模型、工具、权限和风控边界</p></div><button className="primary-button" onClick={onNew}><Plus size={16} />新建 Agent</button></section>
      <div className="agent-card-grid">
        {agents.map((agent) => (
          <article className="agent-card" key={agent.id}>
            <header><div className={`agent-icon agent-icon-${agent.id}`}><Bot size={18} /></div><span className={`agent-state state-${agent.status}`}><StatusDot live={agent.status === 'running'} />{agent.status === 'running' ? '运行中' : agent.status === 'observing' ? '观察中' : '已暂停'}</span><button className="icon-button"><MoreHorizontal size={17} /></button></header>
            <h2>{agent.name}</h2><p>{agent.strategy}</p>
            <div className="agent-card-market"><span>{agent.market}</span><span>风险 {agent.risk}</span></div>
            <div className="agent-card-stats"><div><span>今日收益</span><strong className={agent.pnl >= 0 ? 'text-positive' : 'text-negative'}>{agent.pnl >= 0 ? '+' : ''}{agent.pnl.toFixed(2)}%</strong></div><div><span>资金占用</span><strong>{agent.allocation}%</strong></div></div>
            <div className="agent-last"><span>最近动作</span><p>{agent.lastAction}</p></div>
            <button className="secondary-button full-button" onClick={() => onToggle(agent.id)}>{agent.status === 'running' ? <Pause size={16} /> : <Play size={16} />}{agent.status === 'running' ? '暂停 Agent' : '启动 Agent'}</button>
          </article>
        ))}
        <button className="new-agent-card" onClick={onNew}><span><Plus size={20} /></span><strong>创建交易 Agent</strong><p>从策略模板或空白流程开始</p></button>
      </div>
    </main>
  )
}

function ConnectionsView({ onExchange, onModel }: { onExchange: () => void; onModel: () => void }) {
  return (
    <main className="page">
      <section className="page-heading"><div><span className="section-kicker">基础设施</span><h1>连接</h1><p>交易所、模型路由与数据源的凭证和权限范围</p></div></section>
      <section className="connection-section">
        <header className="section-header"><div><h2>交易所</h2><p>交易权限与资产完全隔离，API 密钥仅保存在服务端</p></div><button className="secondary-button" onClick={onExchange}><Plus size={16} />添加交易所</button></header>
        <div className="connection-list">
          <article className="connection-row"><span className="exchange-logo large">BN</span><div className="connection-main"><div><h3>Binance Testnet</h3><span className="healthy-label"><StatusDot live />连接正常</span></div><p>现货 · 行情读取 · 交易 · 禁止提币</p></div><div className="connection-meta"><span>延迟</span><strong>82 ms</strong></div><div className="connection-meta"><span>最近同步</span><strong>8 秒前</strong></div><button className="icon-button"><Settings2 size={17} /></button></article>
          <button className="add-connection-row" onClick={onExchange}><Plus size={17} /><span><strong>连接另一个交易账户</strong><small>Binance、OKX、Bybit 或兼容 CCXT 的交易所</small></span></button>
        </div>
      </section>
      <section className="connection-section">
        <header className="section-header"><div><h2>模型与推理</h2><p>所有 Agent 通过统一路由调用模型，便于限额、回退与审计</p></div><button className="secondary-button" onClick={onModel}><Plus size={16} />添加模型</button></header>
        <div className="connection-list">
          <article className="connection-row"><span className="model-logo large"><Command size={19} /></span><div className="connection-main"><div><h3>CCSwitch Router</h3><span className="healthy-label"><StatusDot live />可用</span></div><p>OpenAI 兼容接口 · 3 个模型 · 自动回退</p></div><div className="connection-meta"><span>今日调用</span><strong>1,284</strong></div><div className="connection-meta"><span>平均延迟</span><strong>1.8 s</strong></div><button className="icon-button"><Settings2 size={17} /></button></article>
        </div>
      </section>
    </main>
  )
}

function RiskView({ halted, onEmergency }: { halted: boolean; onEmergency: () => void }) {
  return (
    <main className="page">
      <section className="page-heading"><div><span className="section-kicker">执行前强制检查</span><h1>风险控制</h1><p>规则在 Agent 和交易所之间执行，模型无法绕过</p></div><button className={`emergency-button ${halted ? 'is-halted' : ''}`} onClick={onEmergency}><AlertOctagon size={17} />{halted ? '恢复执行' : '紧急停止'}</button></section>
      <section className={`gate-status ${halted ? 'gate-stopped' : ''}`}>
        <div className="gate-rail"><span /></div>
        <div className="gate-copy"><span className="gate-icon"><ShieldCheck size={22} /></span><div><h2>{halted ? '风控总闸已关闭' : '风控总闸运行中'}</h2><p>{halted ? 'Agent 可以继续分析，但所有新订单都会被拒绝' : '所有订单必须逐项通过规则后才能提交到交易所'}</p></div></div>
        <div className="gate-stats"><div><span>今日检查</span><strong>184</strong></div><div><span>已拒绝</span><strong className="text-negative">7</strong></div><div><span>保护资金</span><strong>$1,642</strong></div></div>
      </section>
      <section className="rule-grid">{riskRules.map((rule) => <article className="rule-card" key={rule.name}><header><Gauge size={17} /><span className={rule.state.includes('触发') ? 'warning-label' : 'healthy-label'}>{rule.state}</span></header><h3>{rule.name}</h3><strong>{rule.value}</strong><p>{rule.detail}</p><button className="icon-button"><Settings2 size={16} /></button></article>)}</section>
      <section className="panel exposure-panel"><header className="panel-header"><div><h2>当前持仓敞口</h2><p>按标记价格实时计算</p></div><span className="quiet-chip">总敞口 11.4%</span></header><PositionsTable /></section>
    </main>
  )
}

function PositionsTable() {
  return <div className="data-table"><div className="table-row table-head"><span>市场</span><span>方向</span><span>持仓</span><span>开仓均价</span><span>标记价格</span><span>未实现盈亏</span></div>{positions.map((position) => <div className="table-row" key={position.market}><strong>{position.market}</strong><span>{position.side}</span><span>{position.size}</span><span>{position.entry}</span><span>{position.mark}</span><strong className={position.pnl.startsWith('+') ? 'text-positive' : 'text-negative'}>{position.pnl} <small>{position.percent}</small></strong></div>)}</div>
}

function GenericView({ active }: { active: NavId }) {
  const content = {
    strategies: { title: '策略库', kicker: '可复用交易逻辑', description: '验证、版本化并部署 Agent 使用的策略模块', icon: Network },
    orders: { title: '订单与持仓', kicker: '统一执行记录', description: '跨 Agent、账户和交易所查看订单生命周期', icon: WalletCards },
    review: { title: '复盘', kicker: '从每一次决策中学习', description: '将策略信号、模型推理、风险判断与成交结果放在同一条时间线上', icon: SquareActivity },
  }[active as 'strategies' | 'orders' | 'review']
  const Icon = content.icon
  return <main className="page"><section className="page-heading"><div><span className="section-kicker">{content.kicker}</span><h1>{content.title}</h1><p>{content.description}</p></div><button className="primary-button"><Plus size={16} />新建</button></section><section className="panel feature-preview"><div className="feature-icon"><Icon size={24} /></div><h2>{active === 'strategies' ? '策略版本与回测将在这里统一管理' : active === 'orders' ? '订单执行链路已接入统一审计' : '交易复盘将自动关联 Agent 的每一步判断'}</h2><p>{active === 'strategies' ? '从信号生成、仓位计算到退出条件，每个模块都可以独立测试和复用。' : active === 'orders' ? '模拟盘与真实账户明确分区，订单从意图、风控、提交到成交全程可追溯。' : '系统会保留当时的市场快照、提示词版本、工具调用和最终成交表现。'}</p><button className="secondary-button">查看产品路线 <ArrowUpRight size={16} /></button></section></main>
}

function ExchangeModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [environment, setEnvironment] = useState<'testnet' | 'live'>('testnet')
  const [apiKey, setApiKey] = useState('')
  const [apiSecret, setApiSecret] = useState('')
  const [saving, setSaving] = useState(false)
  const saveConnection = async () => {
    setSaving(true)
    try {
      await saveSecrets('binance-primary', { environment, apiKey, apiSecret })
      onSaved()
    } finally {
      setSaving(false)
    }
  }
  return <Modal title="连接 Binance" subtitle="密钥应只保存在本地服务端，前端不会读取账户凭证" onClose={onClose}>
    <div className="form-stack">
      <div className="notice-box"><LockKeyhole size={18} /><div><strong>推荐使用专用子账户</strong><p>仅开启读取与现货交易权限，关闭提币，并配置服务器 IP 白名单</p></div></div>
      <label className="field-label">环境</label><div className="segmented"><button className={environment === 'testnet' ? 'active' : ''} onClick={() => setEnvironment('testnet')}>Testnet 模拟盘</button><button className={environment === 'live' ? 'active' : ''} onClick={() => setEnvironment('live')}>真实账户</button></div>
      <label className="field-label" htmlFor="api-key">API Key</label><div className="input-shell"><KeyRound size={16} /><input id="api-key" type="password" placeholder="输入 Binance API Key" value={apiKey} onChange={(event) => setApiKey(event.target.value)} /></div>
      <label className="field-label" htmlFor="api-secret">Secret Key</label><div className="input-shell"><KeyRound size={16} /><input id="api-secret" type="password" placeholder="输入 Secret Key" value={apiSecret} onChange={(event) => setApiSecret(event.target.value)} /></div>
      <div className="permission-list"><div><span><Radio size={15} />读取行情与账户</span><strong className="healthy-label">必须</strong></div><div><span><CircleDollarSign size={15} />现货交易</span><label className="switch"><input type="checkbox" defaultChecked /><span /></label></div><div><span><Unplug size={15} />提币权限</span><strong className="blocked-label">始终禁用</strong></div></div>
      <div className="modal-actions"><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" onClick={saveConnection} disabled={saving}><Cable size={16} />{saving ? '加密保存中' : '测试并保存'}</button></div>
    </div>
  </Modal>
}

function ModelModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('http://127.0.0.1:3000/v1')
  const [model, setModel] = useState('claude-sonnet-4.5')
  const [saving, setSaving] = useState(false)
  const saveConnection = async () => {
    setSaving(true)
    try {
      await saveSecrets('model-router', { apiKey, baseUrl, model })
      onSaved()
    } finally {
      setSaving(false)
    }
  }
  return <Modal title="添加模型路由" subtitle="支持 CCSwitch 与所有 OpenAI 兼容接口" onClose={onClose}>
    <div className="form-stack">
      <label className="field-label" htmlFor="provider">提供方</label><select id="provider" className="select-field" defaultValue="ccswitch"><option value="ccswitch">CCSwitch</option><option value="openai">OpenAI Compatible</option><option value="anthropic">Anthropic</option><option value="local">本地模型</option></select>
      <label className="field-label" htmlFor="base-url">Base URL</label><div className="input-shell"><Network size={16} /><input id="base-url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} /></div>
      <label className="field-label" htmlFor="model-key">API Key</label><div className="input-shell"><KeyRound size={16} /><input id="model-key" type="password" placeholder="由系统加密后保存在本机" value={apiKey} onChange={(event) => setApiKey(event.target.value)} /></div>
      <label className="field-label" htmlFor="model-name">默认模型</label><div className="input-shell"><BrainCircuit size={16} /><input id="model-name" value={model} onChange={(event) => setModel(event.target.value)} /></div>
      <div className="notice-box subtle"><Zap size={18} /><div><strong>故障回退</strong><p>主模型超时后切换到备用模型；涉及下单的输出仍需结构化校验与风控确认</p></div></div>
      <div className="modal-actions"><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" onClick={saveConnection} disabled={saving}><Cable size={16} />{saving ? '加密保存中' : '测试并保存'}</button></div>
    </div>
  </Modal>
}

function AgentModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  return <Modal title="创建交易 Agent" subtitle="从策略意图开始，执行权限最后单独授予" onClose={onClose} wide>
    <div className="agent-builder">
      <div className="builder-main form-stack"><label className="field-label" htmlFor="agent-name">名称</label><div className="input-shell"><Bot size={16} /><input id="agent-name" defaultValue="BTC 趋势跟随" /></div><label className="field-label" htmlFor="objective">交易目标</label><textarea id="objective" defaultValue="监控 BTC/USDT 的 4 小时趋势，在 15 分钟级别寻找低风险入场；每笔风险不超过净值 0.5%。" /><label className="field-label">可用工具</label><div className="tool-grid"><label><input type="checkbox" defaultChecked /><ChartCandlestick size={17} /><span>实时行情</span></label><label><input type="checkbox" defaultChecked /><Activity size={17} /><span>技术指标</span></label><label><input type="checkbox" defaultChecked /><MessageSquareText size={17} /><span>新闻检索</span></label><label><input type="checkbox" /><CircleDollarSign size={17} /><span>订单执行</span></label></div></div>
      <aside className="builder-aside"><h3>执行流程</h3>{['读取市场状态', '生成结构化信号', '独立风险检查', '提交到模拟盘', '记录结果并复盘'].map((step, index) => <div className="flow-step" key={step}><span>{index + 1}</span><p>{step}</p>{index < 4 && <i />}</div>)}<div className="builder-note"><ShieldCheck size={17} /><p>新 Agent 默认只读。通过模拟盘验证后，才可申请真实交易权限。</p></div></aside>
    </div>
    <div className="modal-actions"><button className="secondary-button" onClick={onClose}>保存草稿</button><button className="primary-button" onClick={onSaved}><Play size={16} />创建并在模拟盘运行</button></div>
  </Modal>
}

export default function App() {
  const [active, setActive] = useState<NavId>('overview')
  const [modal, setModal] = useState<ModalId>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [halted, setHalted] = useState(false)
  const [agentList, setAgentList] = useState(initialAgents)
  const [toast, setToast] = useState<string | null>(null)

  const showToast = (message: string) => {
    setToast(message)
    window.setTimeout(() => setToast(null), 3200)
  }

  const toggleAgent = (id: string) => {
    setAgentList((items) => items.map((agent) => agent.id === id ? { ...agent, status: agent.status === 'running' ? 'paused' : 'running' } : agent))
  }

  const saveModal = (message: string) => {
    setModal(null)
    showToast(message)
  }

  return (
    <div className="app-shell">
      <Sidebar active={active} onNavigate={setActive} open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      {sidebarOpen && <button className="sidebar-scrim" onClick={() => setSidebarOpen(false)} aria-label="关闭导航" />}
      <div className="app-main">
        <Topbar onMenu={() => setSidebarOpen(true)} onModal={setModal} />
        {active === 'overview' && <Overview onModal={setModal} halted={halted} agents={agentList} onToggleAgent={toggleAgent} onToast={showToast} />}
        {active === 'agents' && <AgentsView agents={agentList} onToggle={toggleAgent} onNew={() => setModal('agent')} />}
        {active === 'connections' && <ConnectionsView onExchange={() => setModal('exchange')} onModel={() => setModal('model')} />}
        {active === 'risk' && <RiskView halted={halted} onEmergency={() => setModal('emergency')} />}
        {(active === 'strategies' || active === 'orders' || active === 'review') && <GenericView active={active} />}
      </div>

      {modal === 'exchange' && <ExchangeModal onClose={() => setModal(null)} onSaved={() => saveModal('Binance Testnet 连接测试通过')} />}
      {modal === 'model' && <ModelModal onClose={() => setModal(null)} onSaved={() => saveModal('模型路由连接测试通过')} />}
      {modal === 'agent' && <AgentModal onClose={() => setModal(null)} onSaved={() => saveModal('Agent 已创建并进入模拟盘观察')} />}
      {modal === 'emergency' && <Modal title={halted ? '恢复交易执行' : '紧急停止所有执行'} subtitle={halted ? '恢复后 Agent 仍需逐笔通过风控规则' : '此操作会立即拒绝所有新订单，不影响行情监控'} onClose={() => setModal(null)}><div className="emergency-dialog"><AlertOctagon size={28} /><p>{halted ? '确认风控规则和交易所连接均正常后再恢复。已暂停的 Agent 不会自动启动。' : '运行中的 Agent 将切换为只分析模式。已提交的未成交订单需要在交易所侧单独处理。'}</p><div className="modal-actions"><button className="secondary-button" onClick={() => setModal(null)}>取消</button><button className={halted ? 'primary-button' : 'danger-button'} onClick={() => { setHalted(!halted); setModal(null); showToast(halted ? '交易执行已恢复' : '已触发紧急停止，所有新订单将被拒绝') }}>{halted ? '确认恢复' : '确认停止'}</button></div></div></Modal>}
      {modal === 'notifications' && <Modal title="通知" subtitle="需要处理的系统与 Agent 事件" onClose={() => setModal(null)}><div className="notification-list"><div><span className="notification-icon warning"><AlertOctagon size={16} /></span><div><strong>事件雷达已自动暂停</strong><p>日内回撤达到 2.0% 阈值</p><small>43 分钟前</small></div></div><div><span className="notification-icon"><ShieldCheck size={16} /></span><div><strong>Binance 连接检查通过</strong><p>权限范围符合只读 + 现货交易策略</p><small>2 小时前</small></div></div></div></Modal>}

      {toast && <div className="toast"><ShieldCheck size={17} /><span>{toast}</span><button onClick={() => setToast(null)} aria-label="关闭"><X size={15} /></button></div>}
    </div>
  )
}
