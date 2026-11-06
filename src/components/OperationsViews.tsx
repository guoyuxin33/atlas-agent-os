import { useEffect, useMemo, useState } from 'react'
import { ArrowDownRight, ArrowUpRight, BarChart3, CheckCircle2, Clock3, Filter, History, Play, Plus, RefreshCw, Search, SlidersHorizontal } from 'lucide-react'
import type { AccountSnapshot, Environment, MarketType, TradingOrder } from '../types'

export function StrategiesView({ onToast }: { onToast: (message: string) => void }) {
  const [running, setRunning] = useState<string | null>(null)
  const strategies = [
    { id: 'trend', name: '多周期趋势跟随', market: 'BTC/USDT', timeframe: '4h / 15m', returnValue: '+18.4%', drawdown: '-6.2%', state: '已验证' },
    { id: 'mean', name: '波动率均值回归', market: 'ETH/USDT', timeframe: '1h / 5m', returnValue: '+11.7%', drawdown: '-4.8%', state: '观察中' },
    { id: 'breakout', name: '永续突破保护', market: 'BTCUSDT 永续', timeframe: '1h / 5m', returnValue: '+23.1%', drawdown: '-9.4%', state: '高风险' },
  ]
  const backtest = (id: string, name: string) => {
    setRunning(id)
    window.setTimeout(() => { setRunning(null); onToast(`${name} 回测完成 · 2,000 根 K 线 · 夏普 1.42`) }, 1200)
  }
  return <main className="page"><section className="page-heading"><div><span className="section-kicker">可验证交易逻辑</span><h1>策略库</h1><p>版本化信号、仓位和退出规则，并在部署前完成回测</p></div><button className="primary-button" onClick={() => onToast('已创建空白策略草稿')}><Plus size={16} />新建策略</button></section><div className="strategy-grid">{strategies.map((strategy) => <article className="strategy-card panel" key={strategy.id}><header><span className="strategy-state">{strategy.state}</span><button className="icon-button" onClick={() => onToast(`${strategy.name} 参数面板已打开`)}><SlidersHorizontal size={16} /></button></header><h2>{strategy.name}</h2><p>{strategy.market} · {strategy.timeframe}</p><div className="strategy-metrics"><div><span>回测收益</span><strong className="text-positive">{strategy.returnValue}</strong></div><div><span>最大回撤</span><strong className="text-negative">{strategy.drawdown}</strong></div><div><span>样本</span><strong>2,000</strong></div></div><button className="secondary-button full-button" onClick={() => backtest(strategy.id, strategy.name)} disabled={running === strategy.id}>{running === strategy.id ? <RefreshCw size={15} /> : <Play size={15} />}{running === strategy.id ? '回测运行中' : '运行回测'}</button></article>)}</div></main>
}

interface OrdersViewProps { environment: Environment; marketType: MarketType; symbol: string; account: AccountSnapshot | null; onToast: (message: string) => void }

export function OrdersView({ environment, marketType, symbol, account, onToast }: OrdersViewProps) {
  const [orders, setOrders] = useState<TradingOrder[]>([])
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('ALL')

  const refresh = async () => {
    setLoading(true)
    try {
      const data = await window.atlas?.binance.orders({ environment, marketType, symbol }) ?? []
      setOrders(data)
      onToast(`订单已同步 · ${data.length} 条`)
    } catch (caught) {
      onToast(caught instanceof Error ? caught.message : '订单同步失败')
    } finally { setLoading(false) }
  }
  useEffect(() => {
    let cancelled = false
    window.atlas?.binance.orders({ environment, marketType, symbol })
      .then((data) => { if (!cancelled) setOrders(data) })
      .catch((caught) => { if (!cancelled) onToast(caught instanceof Error ? caught.message : '订单同步失败') })
    return () => { cancelled = true }
  }, [environment, marketType, onToast, symbol])
  const visible = useMemo(() => orders.filter((order) => (status === 'ALL' || order.status === status) && order.symbol.toLowerCase().includes(query.toLowerCase())), [orders, query, status])

  const holdings = marketType === 'futures' ? account?.positions ?? [] : account?.balances ?? []
  return <main className="page"><section className="page-heading"><div><span className="section-kicker">统一执行记录</span><h1>订单与持仓</h1><p>{environment === 'paper' ? '模拟盘' : environment === 'testnet' ? '测试网' : '生产'} · {marketType === 'spot' ? '现货' : 'USDT 永续'} · {symbol}</p></div><button className="secondary-button" onClick={refresh} disabled={loading}><RefreshCw size={16} />{loading ? '同步中' : '刷新订单'}</button></section><section className="portfolio-strip"><div><span>账户权益</span><strong>${Number(account?.totalWalletBalance || account?.availableBalance || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}</strong></div><div><span>可用余额</span><strong>${Number(account?.availableBalance || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}</strong></div><div><span>未实现盈亏</span><strong className={Number(account?.unrealizedPnl || 0) >= 0 ? 'text-positive' : 'text-negative'}>{Number(account?.unrealizedPnl || 0) >= 0 ? '+' : ''}${Number(account?.unrealizedPnl || 0).toFixed(2)}</strong></div><div><span>{marketType === 'spot' ? '非零资产' : '持仓'}</span><strong>{holdings.length}</strong></div></section><section className="panel orders-panel"><header className="orders-toolbar"><div className="table-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="筛选交易对" /></div><div className="segmented compact"><button className={status === 'ALL' ? 'active' : ''} onClick={() => setStatus('ALL')}>全部</button><button className={status === 'NEW' ? 'active' : ''} onClick={() => setStatus('NEW')}>挂单</button><button className={status === 'FILLED' ? 'active' : ''} onClick={() => setStatus('FILLED')}>已成交</button></div><button className="icon-button" onClick={() => onToast('已按最近时间排序')} aria-label="排序订单"><Filter size={16} /></button></header><div className="data-table"><div className="table-row order-table-row table-head"><span>时间</span><span>市场</span><span>方向</span><span>类型</span><span>数量</span><span>价格</span><span>状态</span></div>{visible.length ? visible.map((order) => <div className="table-row order-table-row" key={String(order.orderId || order.id)}><span>{order.transactTime ? new Date(order.transactTime).toLocaleTimeString('zh-CN', { hour12: false }) : '--'}</span><strong>{order.symbol}</strong><span className={order.side === 'BUY' ? 'text-positive' : 'text-negative'}>{order.side === 'BUY' ? '买入' : '卖出'}</span><span>{order.type === 'MARKET' ? '市价' : '限价'}</span><span>{order.quantity}</span><span>{order.price || '市价'}</span><span>{order.status || 'UNKNOWN'}</span></div>) : <div className="table-empty"><History size={22} /><strong>当前筛选下没有订单</strong><p>从工作台提交模拟或测试网订单后会出现在这里</p></div>}</div></section></main>
}

export function ReviewView({ onToast }: { onToast: (message: string) => void }) {
  const reviews = [
    { time: '今天 14:32', agent: '趋势侦察员', market: 'BTC/USDT', result: '+0.84%', verdict: '按计划执行', good: true },
    { time: '今天 13:51', agent: '事件雷达', market: 'SOL/USDT', result: '-0.42%', verdict: '风控提前退出', good: false },
    { time: '昨天 21:06', agent: '均值回归', market: 'ETH/USDT', result: '+1.16%', verdict: '信号质量良好', good: true },
  ]
  return <main className="page"><section className="page-heading"><div><span className="section-kicker">决策与结果对照</span><h1>复盘</h1><p>把市场快照、模型推理、风控判断和成交表现放在同一条时间线</p></div><button className="secondary-button" onClick={() => onToast('本周复盘报告已生成')}><BarChart3 size={16} />生成周报</button></section><section className="review-summary"><div><span>本周交易</span><strong>34</strong><small>胜率 61.8%</small></div><div><span>净收益</span><strong className="text-positive">+$842.70</strong><small>手续费后</small></div><div><span>风控拦截</span><strong>12</strong><small>避免风险 $2,104</small></div><div><span>计划一致性</span><strong>88%</strong><small>+6% vs 上周</small></div></section><section className="panel review-list"><header className="panel-header"><div><h2>最近交易</h2><p>逐笔检查策略是否按计划执行</p></div><button className="icon-button" onClick={() => onToast('复盘筛选器已切换为全部记录')} aria-label="筛选复盘"><Filter size={16} /></button></header>{reviews.map((review) => <article className="review-row" key={`${review.time}-${review.market}`}><span className={`review-direction ${review.good ? 'review-good' : 'review-bad'}`}>{review.good ? <ArrowUpRight size={16} /> : <ArrowDownRight size={16} />}</span><div><strong>{review.market}</strong><span>{review.time} · {review.agent}</span></div><p>{review.verdict}</p><strong className={review.good ? 'text-positive' : 'text-negative'}>{review.result}</strong><button className="secondary-button" onClick={() => onToast(`${review.market} 决策详情已展开`)}><Clock3 size={14} />查看详情</button></article>)}</section><div className="review-principle"><CheckCircle2 size={18} /><p>复盘只评价过程是否遵守策略和风险边界，不用单笔盈亏倒推决策质量。</p></div></main>
}
