import {
  Activity,
  AlertOctagon,
  Bot,
  BrainCircuit,
  Clock3,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Settings2,
  ShieldCheck,
  WalletCards,
  Wrench,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type {
  AccountSnapshot,
  AgentCreateInput,
  AgentDefinition,
  AgentEvent,
  AgentIntelligenceMode,
  AgentIntent,
  AgentPositionMode,
  AgentStrategy,
  Environment,
  MarketInterval,
  MarketType,
  McpConnection,
  PortfolioPosition,
} from '../types'
import { MarketSelector } from './MarketSelector'
import { Modal } from './Modal'
import { builtInSkills } from '../skills'
import {
  createAgentParameterDraft,
  mergeAgentParameters,
  validateAgentParameterDraft,
  type AgentParameterDraft,
} from '../lib/agent-params'

const strategyLabels: Record<AgentStrategy, string> = {
  'ma-crossover': '均线交叉',
  donchian: 'Donchian 突破',
  rsi: 'RSI 反转',
  bollinger: '布林带回归',
  'atr-breakout': 'ATR 突破',
  supertrend: 'Supertrend 趋势',
  'macd-momentum': 'MACD 动量',
}

interface AgentParameterFieldProps {
  id: string
  label: string
  value: string
  suffix?: string
  min: number
  max: number
  step?: number
  onChange: (value: string) => void
}

function AgentParameterField({ id, label, value, suffix, min, max, step = 1, onChange }: AgentParameterFieldProps) {
  return <div>
    <label className="field-label" htmlFor={id}>{label}</label>
    <div className="input-shell">
      <input id={id} type="number" value={value} min={min} max={max} step={step} onChange={(event) => onChange(event.target.value)} />
      {suffix && <span>{suffix}</span>}
    </div>
  </div>
}

interface AgentStrategyParameterFieldsProps {
  strategy: AgentStrategy
  draft: AgentParameterDraft
  onChange: (key: string, value: string) => void
}

function AgentStrategyParameterFields({ strategy, draft, onChange }: AgentStrategyParameterFieldsProps) {
  const field = (key: string) => ({ value: draft[key] || '', onChange: (value: string) => onChange(key, value) })

  if (strategy === 'ma-crossover') return <>
    <div><label className="field-label" htmlFor="agent-ma-type">均线类型</label><select id="agent-ma-type" className="select-field" value={draft.maType || 'EMA'} onChange={(event) => onChange('maType', event.target.value)}><option value="EMA">EMA 指数均线</option><option value="SMA">SMA 简单均线</option></select></div>
    <AgentParameterField id="agent-fast-period" label="快线周期" min={2} max={499} suffix="K 线" {...field('fastPeriod')} />
    <AgentParameterField id="agent-slow-period" label="慢线周期" min={3} max={500} suffix="K 线" {...field('slowPeriod')} />
    <AgentParameterField id="agent-stop-percent" label="固定止损" min={0.1} max={20} step={0.1} suffix="%" {...field('stopPercent')} />
  </>

  if (strategy === 'donchian') return <>
    <AgentParameterField id="agent-entry-period" label="入场通道" min={3} max={500} suffix="K 线" {...field('entryPeriod')} />
    <AgentParameterField id="agent-exit-period" label="退出通道" min={2} max={499} suffix="K 线" {...field('exitPeriod')} />
    <AgentParameterField id="agent-stop-percent" label="固定止损" min={0.1} max={20} step={0.1} suffix="%" {...field('stopPercent')} />
  </>

  if (strategy === 'rsi') return <>
    <AgentParameterField id="agent-rsi-period" label="RSI 周期" min={2} max={500} suffix="K 线" {...field('period')} />
    <AgentParameterField id="agent-rsi-oversold" label="超卖阈值" min={1} max={49} step={0.1} {...field('oversold')} />
    <AgentParameterField id="agent-rsi-overbought" label="超买阈值" min={51} max={99} step={0.1} {...field('overbought')} />
    <AgentParameterField id="agent-stop-percent" label="固定止损" min={0.1} max={20} step={0.1} suffix="%" {...field('stopPercent')} />
  </>

  if (strategy === 'bollinger') return <>
    <AgentParameterField id="agent-bollinger-period" label="布林带周期" min={2} max={500} suffix="K 线" {...field('period')} />
    <AgentParameterField id="agent-bollinger-deviation" label="标准差倍数" min={0.5} max={5} step={0.1} suffix="σ" {...field('stdDev')} />
    <AgentParameterField id="agent-stop-percent" label="固定止损" min={0.1} max={20} step={0.1} suffix="%" {...field('stopPercent')} />
  </>

  if (strategy === 'atr-breakout') return <>
    <AgentParameterField id="agent-atr-period" label="ATR 周期" min={2} max={500} suffix="K 线" {...field('atrPeriod')} />
    <AgentParameterField id="agent-atr-multiple" label="突破倍数" min={0.1} max={10} step={0.1} suffix="ATR" {...field('atrMultiple')} />
  </>

  if (strategy === 'supertrend') return <>
    <AgentParameterField id="agent-supertrend-period" label="ATR 周期" min={2} max={100} suffix="K 线" {...field('atrPeriod')} />
    <AgentParameterField id="agent-supertrend-multiplier" label="趋势倍数" min={0.5} max={10} step={0.1} suffix="ATR" {...field('multiplier')} />
  </>

  return <>
    <AgentParameterField id="agent-macd-fast" label="快线周期" min={2} max={100} suffix="K 线" {...field('fastPeriod')} />
    <AgentParameterField id="agent-macd-slow" label="慢线周期" min={3} max={300} suffix="K 线" {...field('slowPeriod')} />
    <AgentParameterField id="agent-macd-signal" label="信号周期" min={2} max={100} suffix="K 线" {...field('signalPeriod')} />
    <AgentParameterField id="agent-stop-percent" label="固定止损" min={0.1} max={20} step={0.1} suffix="%" {...field('stopPercent')} />
  </>
}

const eventLabels: Record<string, string> = {
  'agent.created': '已创建',
  'agent.updated': '配置已更新',
  'agent.started': '已启动',
  'agent.resumed': '已恢复',
  'agent.checked': '运行检查',
  'agent.paused': '已暂停',
  'market.connected': '行情已连接',
  'market.disconnected': '行情重连中',
  'evaluation.failed': '评估失败',
  MARKET_SNAPSHOT: '市场快照',
  POSITION_RECONCILED: '持仓同步',
  SIGNAL_EVALUATED: '信号评估',
  DIRECTION_FILTERED: '方向限制已过滤',
  NO_ACTION: '本轮无交易动作',
  AI_CONTEXT_READY: 'AI 上下文',
  AI_REASONING: 'AI 推理',
  AI_APPROVED: 'AI 批准',
  AI_REJECTED: 'AI 拒绝',
  AI_FAILED: 'AI 失败',
  RISK_CHECKING: '风控检查',
  RISK_REJECTED: '风控拒绝',
  INTENT_CREATED: '交易意图',
  INTENT_INVALIDATED: '旧交易意图已失效',
  CONFIRM_PENDING: '等待确认',
  CONFIRM_ACCEPTED: '确认受理',
  ORDER_SUBMITTING: '订单提交',
  ACKED: '交易所响应',
  FILLED: '订单成交',
  REJECTED: '执行拒绝',
  COMPLETED: '流程完成',
  UNKNOWN: '状态待定',
  'intent.updated': '意图更新',
}

function environmentLabel(environment: Environment) {
  return environment === 'paper' ? '模拟盘' : environment === 'testnet' ? '测试网' : '生产'
}

function marketLabel(marketType: MarketType) {
  return marketType === 'spot' ? '现货' : 'USDT 永续'
}

function positionModeLabel(mode: AgentPositionMode) {
  return mode === 'long-only' ? '仅做多' : mode === 'short-only' ? '仅做空' : '自动多空'
}

function formatTime(timestamp?: number) {
  if (!timestamp) return '尚未运行'
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

function formatNumber(value: number, maximumFractionDigits = 2) {
  if (!Number.isFinite(value)) return '--'
  return new Intl.NumberFormat('en-US', { maximumFractionDigits }).format(value)
}

function StatusDot({ live = false, danger = false }: { live?: boolean; danger?: boolean }) {
  return <span className={`status-dot ${live ? 'status-dot-live' : ''} ${danger ? 'status-dot-danger' : ''}`} />
}

function matchingPosition(agent: AgentDefinition, account: AccountSnapshot | null, currentEnvironment: Environment) {
  if (!account || account.environment !== agent.environment || currentEnvironment !== agent.environment || account.marketType !== agent.marketType) return null
  return account.portfolio.find((position) => position.symbol === agent.symbol && position.marketType === agent.marketType) || null
}

function PositionPnl({ position }: { position: PortfolioPosition | null }) {
  if (!position) return <strong className="agent-value-muted">--</strong>
  const pnl = Number(position.unrealizedPnl)
  const rate = Number(position.returnRate)
  return (
    <strong className={pnl >= 0 ? 'text-positive' : 'text-negative'}>
      {pnl >= 0 ? '+' : '-'}${formatNumber(Math.abs(pnl))}
      <small>{rate >= 0 ? '+' : ''}{formatNumber(rate)}%</small>
    </strong>
  )
}

function AgentState({ agent }: { agent: AgentDefinition }) {
  return (
    <span className={`agent-state state-${agent.status}`}>
      <StatusDot live={agent.status === 'running'} />
      {agent.status === 'running' ? '运行中' : '已暂停'}
    </span>
  )
}

function intelligenceModeLabel(mode?: AgentIntelligenceMode) {
  return mode === 'ai-supervised' ? 'AI 监督' : '纯策略'
}

function intelligenceFor(agent: AgentDefinition) {
  return agent.intelligence || {
    mode: 'strategy' as const,
    skills: [],
    mcpServers: [],
    mcpTools: [],
    confidenceThreshold: 0.7,
    failClosed: true,
  }
}

function AgentEmpty({ onNew }: { onNew: () => void }) {
  return (
    <div className="agent-empty">
      <Bot size={22} />
      <div>
        <strong>还没有交易 Agent</strong>
        <p>创建后会先保持暂停，由你明确启动行情订阅和策略执行</p>
      </div>
      <button className="secondary-button" onClick={onNew}><Plus size={15} />新建 Agent</button>
    </div>
  )
}

interface OverviewAgentsPanelProps {
  agents: AgentDefinition[]
  logs: AgentEvent[]
  account: AccountSnapshot | null
  currentEnvironment: Environment
  loading: boolean
  busyAgentIds: Set<string>
  onToggle: (agent: AgentDefinition) => Promise<void>
  onManage: () => void
  onNew: () => void
}

export function OverviewAgentsPanel({ agents, logs, account, currentEnvironment, loading, busyAgentIds, onToggle, onManage, onNew }: OverviewAgentsPanelProps) {
  const visibleAgents = useMemo(
    () => [...agents].sort((left, right) => Number(right.status === 'running') - Number(left.status === 'running') || right.updatedAt - left.updatedAt).slice(0, 4),
    [agents],
  )
  const agentNames = useMemo(() => new Map(agents.map((agent) => [agent.id, agent.name])), [agents])
  const visibleLogs = logs.slice(0, 6)

  return (
    <section className="lower-grid">
      <article className="panel agent-panel">
        <header className="panel-header">
          <div><h2>Agent 状态</h2><p>真实运行状态、风控额度与关联持仓</p></div>
          <button className="text-button" onClick={onManage}>管理 Agent</button>
        </header>
        {loading && !agents.length ? <div className="agent-loading"><RefreshCw size={16} />正在读取 Agent 运行时</div> : visibleAgents.length ? (
          <div className="agent-list">
            {visibleAgents.map((agent) => {
              const position = matchingPosition(agent, account, currentEnvironment)
              const busy = busyAgentIds.has(agent.id)
              return (
                <div className="agent-row" key={agent.id}>
                  <div className="agent-icon"><Bot size={17} /></div>
                  <div className="agent-main">
                    <div><strong>{agent.name}</strong><AgentState agent={agent} /></div>
                    <span>{agent.symbol} · {marketLabel(agent.marketType)} · {strategyLabels[agent.strategy]} · {intelligenceModeLabel(agent.intelligence?.mode)} · {agent.interval}</span>
                  </div>
                  <div className="agent-allocation"><span>单笔风险</span><strong>{formatNumber(agent.risk.riskFraction * 100)}%</strong></div>
                  <div className="agent-pnl"><span>实时盈亏</span><PositionPnl position={position} /></div>
                  <button className="icon-button" disabled={busy} onClick={() => void onToggle(agent)} aria-label={agent.status === 'running' ? `暂停${agent.name}` : `启动${agent.name}`}>
                    {busy ? <RefreshCw className="spin" size={16} /> : agent.status === 'running' ? <Pause size={16} /> : <Play size={16} />}
                  </button>
                </div>
              )
            })}
          </div>
        ) : <AgentEmpty onNew={onNew} />}
      </article>

      <article className="panel activity-panel">
        <header className="panel-header">
          <div><h2>决策流水</h2><p>来自主进程的持久化执行日志</p></div>
          <span className="runtime-count">{logs.length}</span>
        </header>
        {visibleLogs.length ? <div className="activity-list">{visibleLogs.map((event) => (
          <div className="activity-row" key={event.id}>
            <div className={`timeline-mark mark-${event.level}`} />
            <div>
              <span>{formatTime(event.timestamp)} · {agentNames.get(event.agentId) || '未知 Agent'}</span>
              <strong>{eventLabels[event.type] || event.type}</strong>
              <p>{event.message}</p>
            </div>
          </div>
        ))}</div> : <div className="activity-empty"><Activity size={18} />启动 Agent 后，决策步骤会实时记录在这里</div>}
      </article>
    </section>
  )
}

interface AgentsViewProps {
  agents: AgentDefinition[]
  logs: AgentEvent[]
  account: AccountSnapshot | null
  currentEnvironment: Environment
  loading: boolean
  error: string | null
  busyAgentIds: Set<string>
  evaluatingAgentIds: Set<string>
  busyIntentIds: Set<string>
  onToggle: (agent: AgentDefinition) => Promise<void>
  onEvaluate: (agent: AgentDefinition) => Promise<void>
  onConfirmIntent: (intent: AgentIntent) => Promise<void>
  onRefresh: () => Promise<void>
  onNew: () => void
  onEdit: (agent: AgentDefinition) => void
}

function IntentPanel({ intent, busy, now, onConfirm }: { intent: AgentIntent; busy: boolean; now: number; onConfirm: (intent: AgentIntent) => Promise<void> }) {
  const remaining = Math.max(0, Math.ceil((intent.expiresAt - (now || intent.createdAt)) / 1000))
  const price = Number(intent.order.marketPrice || intent.order.price)
  const quantity = Number(intent.order.quantity)
  const notional = price * quantity
  const expired = remaining === 0

  return (
    <section className="agent-intent">
      <header><div><AlertOctagon size={16} /><strong>生产订单待确认</strong></div><span>{expired ? '已过期' : `${remaining}s 后过期`}</span></header>
      <p>{intent.reason}</p>
      <dl>
        <div><dt>市场</dt><dd>{intent.order.symbol} · {marketLabel(intent.order.marketType)}</dd></div>
        <div><dt>方向</dt><dd className={intent.order.side === 'BUY' ? 'text-positive' : 'text-negative'}>{intent.order.side === 'BUY' ? '买入 / 做多' : '卖出 / 做空'}</dd></div>
        <div><dt>类型</dt><dd>{intent.order.type === 'MARKET' ? '市价' : '限价'}</dd></div>
        <div><dt>数量</dt><dd>{intent.order.quantity}</dd></div>
        <div><dt>信号价格</dt><dd>{price > 0 ? `${formatNumber(price, 8)} USDT` : '--'}</dd></div>
        <div><dt>名义价值</dt><dd>{notional > 0 ? `${formatNumber(notional)} USDT` : '--'}</dd></div>
      </dl>
      <div className="agent-intent-footer">
        <span><Clock3 size={14} />{formatTime(intent.expiresAt)}</span>
        <button className="danger-button" disabled={busy || expired} onClick={() => void onConfirm(intent)}>
          {busy ? <RefreshCw className="spin" size={15} /> : <ShieldCheck size={15} />}
          {busy ? '确认中' : expired ? '确认已过期' : '确认真实订单'}
        </button>
      </div>
    </section>
  )
}

export function AgentsView({ agents, logs, account, currentEnvironment, loading, error, busyAgentIds, evaluatingAgentIds, busyIntentIds, onToggle, onEvaluate, onConfirmIntent, onRefresh, onNew, onEdit }: AgentsViewProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [now, setNow] = useState(0)

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const selected = agents.find((agent) => agent.id === selectedId) || agents[0] || null
  const selectedLogs = selected ? logs.filter((event) => event.agentId === selected.id).slice(0, 100) : []
  const position = selected ? matchingPosition(selected, account, currentEnvironment) : null
  const runningCount = agents.filter((agent) => agent.status === 'running').length
  const pendingCount = agents.reduce((total, agent) => total + (agent.pendingIntents?.length || 0), 0)

  return (
    <main className="page agents-runtime-page">
      <section className="page-heading">
        <div><span className="section-kicker">本机执行运行时</span><h1>Agent</h1><p>策略在主进程订阅闭合 K 线，所有决策、风控和订单结果均持久化</p></div>
        <div className="heading-actions">
          <button className="secondary-button" onClick={() => void onRefresh()} disabled={loading}><RefreshCw className={loading ? 'spin' : ''} size={16} />刷新</button>
          <button className="primary-button" onClick={onNew}><Plus size={16} />新建 Agent</button>
        </div>
      </section>

      <section className="agent-runtime-summary">
        <div><span>Agent 总数</span><strong>{agents.length}</strong></div>
        <div><span>正在运行</span><strong className={runningCount ? 'text-positive' : ''}>{runningCount}</strong></div>
        <div><span>待确认生产意图</span><strong className={pendingCount ? 'text-negative' : ''}>{pendingCount}</strong></div>
        <div><span>审计事件</span><strong>{logs.length}</strong></div>
      </section>

      {error && <div className="agent-runtime-error"><AlertOctagon size={16} /><span>{error}</span><button onClick={() => void onRefresh()}>重试</button></div>}

      {!agents.length && !loading ? <section className="panel"><AgentEmpty onNew={onNew} /></section> : (
        <section className="agent-runtime-layout">
          <aside className="panel agent-roster">
            <header className="panel-header"><div><h2>运行单元</h2><p>选择 Agent 查看实时状态</p></div><span className="runtime-count">{agents.length}</span></header>
            <div className="agent-roster-list">
              {agents.map((agent) => (
                <button className={agent.id === selected?.id ? 'selected' : ''} key={agent.id} onClick={() => setSelectedId(agent.id)}>
                  <span className="agent-icon"><Bot size={16} /></span>
                  <span className="agent-roster-copy"><strong>{agent.name}</strong><small>{agent.symbol} · {agent.interval} · {environmentLabel(agent.environment)} · {intelligenceModeLabel(agent.intelligence?.mode)}</small></span>
                  <AgentState agent={agent} />
                  {!!agent.pendingIntents?.length && <span className="intent-count">{agent.pendingIntents.length}</span>}
                </button>
              ))}
            </div>
          </aside>

          {selected && <div className="agent-runtime-detail">
            <section className="panel agent-detail-head">
              <header>
                <div className="agent-detail-title"><span className="agent-icon"><Bot size={18} /></span><div><h2>{selected.name}</h2><p>{selected.symbol} · {marketLabel(selected.marketType)} · {strategyLabels[selected.strategy]}</p></div></div>
                <div className="agent-detail-actions">
                  <button className="secondary-button" onClick={() => onEdit(selected)}>
                    <Settings2 size={16} />
                    编辑配置
                  </button>
                  <button className="secondary-button" disabled={selected.status !== 'running' || evaluatingAgentIds.has(selected.id)} onClick={() => void onEvaluate(selected)}>
                    <Activity className={evaluatingAgentIds.has(selected.id) ? 'spin' : ''} size={16} />
                    {evaluatingAgentIds.has(selected.id) ? '评估中' : '立即评估'}
                  </button>
                  <button className="secondary-button" disabled={busyAgentIds.has(selected.id)} onClick={() => void onToggle(selected)}>
                    {busyAgentIds.has(selected.id) ? <RefreshCw className="spin" size={16} /> : selected.status === 'running' ? <Pause size={16} /> : <Play size={16} />}
                    {busyAgentIds.has(selected.id) ? '处理中' : selected.status === 'running' ? '暂停 Agent' : '启动 Agent'}
                  </button>
                </div>
              </header>
              <div className="agent-detail-grid">
                <div><span>运行状态</span><AgentState agent={selected} /></div>
                <div><span>环境</span><strong>{environmentLabel(selected.environment)}</strong></div>
                <div><span>周期</span><strong>{selected.interval}</strong></div>
                <div><span>持仓方向</span><strong>{positionModeLabel(selected.positionMode)}</strong></div>
                <div><span>决策模式</span><strong>{intelligenceModeLabel(selected.intelligence?.mode)}</strong></div>
                <div><span>策略持仓</span><strong>{selected.runtime.position === 'long' ? '多头' : selected.runtime.position === 'short' ? '空头' : '空仓'}</strong></div>
                <div><span>单笔风险</span><strong>{formatNumber(selected.risk.riskFraction * 100)}%</strong></div>
                <div><span>名义上限</span><strong>{formatNumber(selected.risk.maxNotional)} USDT</strong></div>
                <div><span>最近评估</span><strong>{formatTime(selected.runtime.lastEvaluatedAt)}</strong></div>
                <div><span>运行心跳</span><strong>{formatTime(selected.runtime.lastHeartbeatAt || selected.runtime.lastCheckAt)}</strong></div>
                <div><span>下次检查</span><strong>{selected.status === 'running' ? formatTime(selected.runtime.nextEvaluationAt) : '--'}</strong></div>
                <div><span>行情链路</span><strong className={selected.runtime.marketConnected ? 'text-positive' : 'agent-value-muted'}>{selected.status !== 'running' ? '未订阅' : selected.runtime.marketConnected ? '实时' : '重连 / REST 补偿'}</strong></div>
                <div><span>关联持仓盈亏</span><PositionPnl position={position} /></div>
              </div>
              {selected.runtime.lastError
                ? <div className="agent-runtime-error"><AlertOctagon size={16} /><span><strong>{selected.status === 'running' ? '自动执行受阻' : '上次运行错误'}</strong> · {selected.runtime.lastError}</span></div>
                : selected.status === 'running' && <p className="agent-position-note"><Clock3 size={14} />自动执行已启用，等待下一根闭合 K 线 · 下次检查 {formatTime(selected.runtime.nextEvaluationAt)}</p>}
              {!position && <p className="agent-position-note"><WalletCards size={14} />{selected.environment !== currentEnvironment ? `顶部账户当前为${environmentLabel(currentEnvironment)}，切换到${environmentLabel(selected.environment)}后可关联持仓` : account?.marketType !== selected.marketType ? `顶部市场当前为${marketLabel(account?.marketType || 'spot')}，切换到${marketLabel(selected.marketType)}后可关联持仓` : '该 Agent 当前没有匹配持仓'}</p>}
            </section>

            {(() => {
              const intelligence = intelligenceFor(selected)
              const skillNames = intelligence.skills.map((id) => builtInSkills.find((skill) => skill.id === id)?.name || id)
              return <section className="panel agent-intelligence-panel">
                <header className="panel-header"><div><h2>决策监督</h2><p>策略信号、模型判断与确定性风控分层执行</p></div><span className={`agent-intelligence-mode ${intelligence.mode === 'ai-supervised' ? 'is-ai' : ''}`}><BrainCircuit size={14} />{intelligenceModeLabel(intelligence.mode)}</span></header>
                <div className="agent-intelligence-grid">
                  <div><span>模型</span><strong>{intelligence.model || '--'}</strong></div>
                  <div><span>Skills</span><strong>{skillNames.length ? skillNames.join('、') : '未启用'}</strong></div>
                  <div><span>MCP 服务</span><strong>{intelligence.mcpServers.length ? intelligence.mcpServers.join('、') : '未连接'}</strong></div>
                  <div><span>MCP 工具白名单</span><strong>{intelligence.mcpTools?.length ? intelligence.mcpTools.join('、') : '未授权'}</strong></div>
                  <div><span>批准阈值</span><strong>{intelligence.mode === 'ai-supervised' ? `${formatNumber(intelligence.confidenceThreshold * 100)}%` : '--'}</strong></div>
                </div>
                <div className="agent-intelligence-boundary"><ShieldCheck size={15} /><span>{intelligence.mode === 'ai-supervised' ? intelligence.failClosed ? '模型、Skill 或 MCP 不可用时拒绝该次信号；AI 批准后仍需通过主进程风控' : '监督失败时回退到纯策略；订单仍需通过主进程风控' : '策略直接进入确定性风控，不调用模型、Skill 或 MCP'}</span></div>
              </section>
            })()}

            {!!selected.pendingIntents?.length && <div className="agent-intent-list">{selected.pendingIntents.map((intent) => <IntentPanel key={intent.id} intent={intent} busy={busyIntentIds.has(intent.id)} now={now} onConfirm={onConfirmIntent} />)}</div>}

            <section className="panel agent-log-panel">
              <header className="panel-header"><div><h2>执行时间线</h2><p>最新事件在前，保留主进程原始步骤</p></div><span className="runtime-count">{selectedLogs.length}</span></header>
              {selectedLogs.length ? <div className="agent-log-list">{selectedLogs.map((event) => (
                <div className={`agent-log-row level-${event.level} ${event.type.startsWith('AI_') ? 'agent-log-ai' : ''}`} key={event.id}>
                  <span className="agent-log-time">{formatTime(event.timestamp)}</span>
                  <span className="agent-log-mark" />
                  <div><header><strong>{eventLabels[event.type] || event.type}</strong><span>{event.type}</span></header><p>{event.message}</p></div>
                </div>
              ))}</div> : <div className="activity-empty"><Activity size={18} />该 Agent 还没有运行日志</div>}
            </section>
          </div>}
        </section>
      )}
    </main>
  )
}

interface AgentCreateModalProps {
  agent?: AgentDefinition | null
  initialEnvironment: Environment
  initialMarketType: MarketType
  initialSymbol: string
  enabledSkills: string[]
  mcpConnection: McpConnection | null
  modelConfigured: boolean
  modelName?: string
  onClose: () => void
  onSubmit: (definition: AgentCreateInput) => Promise<void>
}

export function AgentCreateModal({ agent, initialEnvironment, initialMarketType, initialSymbol, enabledSkills, mcpConnection, modelConfigured, modelName, onClose, onSubmit }: AgentCreateModalProps) {
  const editing = Boolean(agent)
  const savedIntelligence = agent ? intelligenceFor(agent) : null
  const [name, setName] = useState(agent?.name || `${initialSymbol.replace(/USDT$/, '')} 策略 Agent`)
  const [environment, setEnvironment] = useState<Environment>(agent?.environment || initialEnvironment)
  const [marketType, setMarketType] = useState<MarketType>(agent?.marketType || initialMarketType)
  const [positionMode, setPositionMode] = useState<AgentPositionMode>(agent?.positionMode || ((agent?.marketType || initialMarketType) === 'spot' ? 'long-only' : 'auto'))
  const [symbol, setSymbol] = useState(agent?.symbol || initialSymbol)
  const [interval, setInterval] = useState<MarketInterval>(agent?.interval || '15m')
  const [strategy, setStrategy] = useState<AgentStrategy>(agent?.strategy || 'ma-crossover')
  const [strategyParams, setStrategyParams] = useState<AgentParameterDraft>(() => createAgentParameterDraft(agent?.strategy || 'ma-crossover', agent?.params))
  const [riskPercent, setRiskPercent] = useState(String((agent?.risk.riskFraction ?? 0.005) * 100))
  const [maxNotional, setMaxNotional] = useState(String(agent?.risk.maxNotional ?? 100))
  const [maxQuantity, setMaxQuantity] = useState(agent?.risk.maxQuantity ? String(agent.risk.maxQuantity) : '')
  const [intelligenceMode, setIntelligenceMode] = useState<AgentIntelligenceMode>(savedIntelligence?.mode || 'strategy')
  const [model, setModel] = useState(savedIntelligence?.model || modelName || '')
  const [selectedSkills, setSelectedSkills] = useState(() => new Set(savedIntelligence?.skills || enabledSkills))
  const [selectedMcpTools, setSelectedMcpTools] = useState(() => new Set(savedIntelligence?.mcpTools || []))
  const [confidencePercent, setConfidencePercent] = useState(String((savedIntelligence?.confidenceThreshold ?? 0.7) * 100))
  const [failClosed, setFailClosed] = useState(savedIntelligence?.failClosed ?? true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const visibleSkills = builtInSkills.filter((skill) => enabledSkills.includes(skill.id) || selectedSkills.has(skill.id))
  const unknownSkills = [...selectedSkills].filter((id) => !builtInSkills.some((skill) => skill.id === id))
  const connectedMcpToolNames = new Set(mcpConnection?.tools.map((tool) => tool.name) || [])
  const unavailableMcpTools = [...selectedMcpTools].filter((name) => !connectedMcpToolNames.has(name))

  const changeStrategy = (nextStrategy: AgentStrategy) => {
    setStrategy(nextStrategy)
    setStrategyParams(createAgentParameterDraft(nextStrategy))
    setError(null)
  }

  const changeStrategyParam = (key: string, value: string) => {
    setStrategyParams((current) => ({ ...current, [key]: value }))
  }

  const submit = async () => {
    const riskFraction = Number(riskPercent) / 100
    const notional = Number(maxNotional)
    const quantity = maxQuantity.trim() ? Number(maxQuantity) : undefined
    const confidenceThreshold = Number(confidencePercent) / 100
    if (!name.trim()) return setError('请输入 Agent 名称')
    if (!symbol.trim()) return setError('请选择交易对')
    const parameterValidation = validateAgentParameterDraft(strategy, strategyParams)
    if (!parameterValidation.ok) return setError(parameterValidation.error)
    if (!(riskFraction >= 0.0001 && riskFraction <= 0.01)) return setError('单笔风险必须在净值的 0.01% 到 1% 之间')
    if (!(notional >= 1)) return setError('名义价值上限必须至少为 1 USDT')
    if (quantity !== undefined && !(quantity > 0)) return setError('数量上限必须大于 0，或留空使用名义价值上限')
    if (intelligenceMode === 'ai-supervised' && !model.trim()) return setError('AI 监督需要指定模型')
    if (intelligenceMode === 'ai-supervised' && !modelConfigured && !editing) return setError('AI 监督需要先配置并验证模型连接')
    if (intelligenceMode === 'ai-supervised' && !(confidenceThreshold >= 0.5 && confidenceThreshold <= 1)) return setError('AI 批准阈值必须在 50% 到 100% 之间')
    setSubmitting(true)
    setError(null)
    try {
      const mcpServers = new Set(savedIntelligence?.mcpServers || [])
      if (selectedMcpTools.size && mcpConnection) mcpServers.add(mcpConnection.url)
      await onSubmit({
        name: name.trim(),
        environment,
        marketType,
        positionMode: marketType === 'spot' ? 'long-only' : positionMode,
        symbol,
        interval,
        strategy,
        params: mergeAgentParameters(strategy, agent?.strategy, agent?.params, parameterValidation.params),
        risk: { riskFraction, maxNotional: notional, ...(quantity !== undefined ? { maxQuantity: quantity } : {}) },
        intelligence: intelligenceMode === 'ai-supervised' ? {
          mode: intelligenceMode,
          model: model.trim() || undefined,
          skills: [...selectedSkills],
          mcpServers: [...mcpServers],
          mcpTools: [...selectedMcpTools],
          confidenceThreshold,
          failClosed: true,
        } : {
          mode: 'strategy',
          skills: [],
          mcpServers: [],
          mcpTools: [],
          confidenceThreshold: 0.7,
          failClosed: true,
        },
      })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `Agent ${editing ? '保存' : '创建'}失败`)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal title={editing ? '编辑交易 Agent' : '创建交易 Agent'} subtitle={editing ? '保存会停止当前运行并清除旧待确认意图' : '定义真实市场订阅、策略和不可绕过的风险边界'} onClose={onClose} wide>
      <div className="agent-create-grid">
        <div className="form-stack">
          {editing && <div className="production-warning"><AlertOctagon size={16} /><span>保存后 Agent 会保持暂停，确认配置后需要手动重新启动</span></div>}
          <label className="field-label" htmlFor="agent-name">名称</label>
          <div className="input-shell"><Bot size={16} /><input id="agent-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} /></div>

          <label className="field-label">账户环境</label>
          <div className="segmented">{(['paper', 'testnet', 'live'] as Environment[]).map((value) => <button key={value} className={environment === value ? 'active' : ''} onClick={() => setEnvironment(value)}>{environmentLabel(value)}</button>)}</div>
          {environment === 'live' && <div className="production-warning"><AlertOctagon size={16} /><span>生产 Agent 生成订单后不会自动提交，必须在 30 秒内逐单确认</span></div>}

          <label className="field-label">决策模式</label>
          <div className="agent-mode-options">
            <button className={intelligenceMode === 'strategy' ? 'selected' : ''} onClick={() => setIntelligenceMode('strategy')}><Activity size={16} /><span><strong>纯策略</strong><small>信号直接进入确定性风控</small></span></button>
            <button className={intelligenceMode === 'ai-supervised' ? 'selected' : ''} onClick={() => setIntelligenceMode('ai-supervised')}><BrainCircuit size={16} /><span><strong>AI 监督</strong><small>模型可批准或拒绝策略信号</small></span></button>
          </div>

          <div className="agent-create-fields">
            <div><label className="field-label">市场</label><div className="segmented"><button className={marketType === 'spot' ? 'active' : ''} onClick={() => { setMarketType('spot'); setPositionMode('long-only'); setSymbol('BTCUSDT') }}>现货</button><button className={marketType === 'futures' ? 'active' : ''} onClick={() => { setMarketType('futures'); setSymbol('BTCUSDT') }}>永续</button></div></div>
            <div><label className="field-label" htmlFor="agent-position-mode">持仓方向</label><select id="agent-position-mode" className="select-field" value={positionMode} onChange={(event) => setPositionMode(event.target.value as AgentPositionMode)} disabled={marketType === 'spot'}><option value="long-only">仅做多</option><option value="short-only">仅做空</option><option value="auto">自动多空</option></select></div>
            <div><label className="field-label">交易对</label><div className="agent-market-picker"><MarketSelector environment={environment} marketType={marketType} value={symbol} onChange={setSymbol} /></div></div>
            <div><label className="field-label" htmlFor="agent-interval">K 线周期</label><select id="agent-interval" className="select-field" value={interval} onChange={(event) => setInterval(event.target.value as MarketInterval)}>{(['1m', '5m', '15m', '1h', '4h', '1d'] as MarketInterval[]).map((value) => <option value={value} key={value}>{value}</option>)}</select></div>
            <div><label className="field-label" htmlFor="agent-strategy">策略</label><select id="agent-strategy" className="select-field" value={strategy} onChange={(event) => changeStrategy(event.target.value as AgentStrategy)}>{Object.entries(strategyLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></div>
            <div><label className="field-label" htmlFor="agent-risk">单笔风险</label><div className="input-shell"><input id="agent-risk" value={riskPercent} onChange={(event) => setRiskPercent(event.target.value)} inputMode="decimal" /><span>% 净值</span></div></div>
            <div><label className="field-label" htmlFor="agent-notional">名义价值上限</label><div className="input-shell"><input id="agent-notional" value={maxNotional} onChange={(event) => setMaxNotional(event.target.value)} inputMode="decimal" /><span>USDT</span></div></div>
            <div><label className="field-label" htmlFor="agent-quantity">数量上限（可选）</label><div className="input-shell"><input id="agent-quantity" value={maxQuantity} onChange={(event) => setMaxQuantity(event.target.value)} inputMode="decimal" placeholder="按名义价值限制" /></div></div>
          </div>

          <section className="agent-strategy-config">
            <header><strong>{strategyLabels[strategy]}参数</strong><span>参数将在下次启动时生效</span></header>
            <div className="agent-strategy-fields"><AgentStrategyParameterFields strategy={strategy} draft={strategyParams} onChange={changeStrategyParam} /></div>
          </section>

          {intelligenceMode === 'ai-supervised' && <section className="agent-ai-config">
            <header><div><BrainCircuit size={16} /><span><strong>监督能力</strong><small>{modelConfigured ? '模型路由已验证' : editing ? '保存后需验证当前模型路由' : '模型尚未配置或验证'}</small></span></div><span className={modelConfigured ? 'healthy-label' : 'warning-label'}><StatusDot live={modelConfigured} />{modelConfigured ? '可用' : '需验证'}</span></header>
            <div><label className="field-label" htmlFor="agent-model">模型</label><div className="input-shell"><BrainCircuit size={16} /><input id="agent-model" value={model} onChange={(event) => setModel(event.target.value)} placeholder="例如 gpt-5.1 或路由模型名" /></div></div>
            <div className="agent-capability-list">
              {visibleSkills.map((skill) => <label key={skill.id}><input type="checkbox" checked={selectedSkills.has(skill.id)} onChange={(event) => setSelectedSkills((current) => { const next = new Set(current); if (event.target.checked) next.add(skill.id); else next.delete(skill.id); return next })} /><span><strong>{skill.name}</strong><small>{enabledSkills.includes(skill.id) ? skill.description : `${skill.description} · 当前全局未启用`}</small></span></label>)}
              {unknownSkills.map((id) => <label key={id}><input type="checkbox" checked onChange={(event) => { if (!event.target.checked) setSelectedSkills((current) => { const next = new Set(current); next.delete(id); return next }) }} /><span><strong>{id}</strong><small>已保存 Skill · 当前工作台未注册</small></span></label>)}
              {!visibleSkills.length && !unknownSkills.length && <p>当前没有已启用 Skill，可在 Skill / MCP 页面开启</p>}
              {mcpConnection?.tools.map((tool) => <label key={`mcp:${tool.name}`}><input type="checkbox" checked={selectedMcpTools.has(tool.name)} onChange={(event) => setSelectedMcpTools((current) => { const next = new Set(current); if (event.target.checked) next.add(tool.name); else next.delete(tool.name); return next })} /><Wrench size={15} /><span><strong>{tool.name}</strong><small>{tool.description || `MCP 工具 · ${mcpConnection.url}`}</small></span></label>)}
              {unavailableMcpTools.map((tool) => <label key={`saved-mcp:${tool}`}><input type="checkbox" checked onChange={(event) => { if (!event.target.checked) setSelectedMcpTools((current) => { const next = new Set(current); next.delete(tool); return next }) }} /><Wrench size={15} /><span><strong>{tool}</strong><small>已保存 MCP 工具 · 当前连接未提供</small></span></label>)}
              {!mcpConnection && !unavailableMcpTools.length && <label className="is-disabled"><input type="checkbox" disabled /><Wrench size={15} /><span><strong>MCP 工具</strong><small>当前没有可用 MCP 连接</small></span></label>}
            </div>
            <div className="agent-ai-controls">
              <div><label className="field-label" htmlFor="agent-confidence">批准阈值</label><div className="input-shell"><input id="agent-confidence" value={confidencePercent} onChange={(event) => setConfidencePercent(event.target.value)} inputMode="decimal" /><span>%</span></div></div>
              <label className="agent-fail-closed"><span><strong>失败关闭</strong><small>监督不可用时强制拒绝信号</small></span><span className="switch"><input type="checkbox" checked={failClosed} onChange={() => setFailClosed(true)} disabled /><span /></span></label>
            </div>
            <div className="agent-ai-boundary"><ShieldCheck size={15} /><span>AI 只能监督策略信号，不能修改风控规则、绕过生产确认或直接提交订单</span></div>
          </section>}
        </div>

        <aside className="agent-create-aside">
          <h3>执行边界</h3>
          <div><ShieldCheck size={16} /><p><strong>{editing ? '保存后保持暂停' : '创建后默认暂停'}</strong><span>{editing ? '旧待确认意图失效，需重新启动' : '只有明确启动后才订阅闭合 K 线'}</span></p></div>
          <div><Activity size={16} /><p><strong>{intelligenceMode === 'ai-supervised' ? '分层监督' : '确定性策略'}</strong><span>{intelligenceMode === 'ai-supervised' ? '策略先生成信号，AI 只能批准或拒绝' : '信号计算和仓位限制在主进程执行'}</span></p></div>
          <div><Clock3 size={16} /><p><strong>完整审计</strong><span>快照、信号、风控和订单结果写入本机日志</span></p></div>
          <dl><div><dt>当前交易对</dt><dd>{symbol}</dd></div><div><dt>运行环境</dt><dd>{environmentLabel(environment)}</dd></div><div><dt>执行策略</dt><dd>{strategyLabels[strategy]}</dd></div><div><dt>持仓方向</dt><dd>{positionModeLabel(positionMode)}</dd></div><div><dt>决策模式</dt><dd>{intelligenceModeLabel(intelligenceMode)}</dd></div></dl>
        </aside>
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="modal-actions"><button className="secondary-button" onClick={onClose} disabled={submitting}>取消</button><button className="primary-button" onClick={() => void submit()} disabled={submitting}>{submitting ? <RefreshCw className="spin" size={16} /> : editing ? <Settings2 size={16} /> : <Plus size={16} />}{submitting ? '保存中' : editing ? '保存并暂停' : '创建 Agent'}</button></div>
    </Modal>
  )
}
