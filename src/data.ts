export type AgentStatus = 'running' | 'observing' | 'paused'

export interface Agent {
  id: string
  name: string
  strategy: string
  market: string
  status: AgentStatus
  pnl: number
  allocation: number
  risk: '低' | '中' | '高'
  lastAction: string
}

export const agents: Agent[] = [
  {
    id: 'momentum',
    name: '趋势侦察员',
    strategy: '4h 趋势 + 15m 入场确认',
    market: 'BTC / USDT',
    status: 'running',
    pnl: 2.84,
    allocation: 34,
    risk: '中',
    lastAction: '14:32 加仓 0.008 BTC',
  },
  {
    id: 'mean-reversion',
    name: '均值回归',
    strategy: '布林带偏离 + 成交量过滤',
    market: 'ETH / USDT',
    status: 'observing',
    pnl: 1.16,
    allocation: 22,
    risk: '低',
    lastAction: '14:28 信号未通过过滤',
  },
  {
    id: 'sentiment',
    name: '事件雷达',
    strategy: '新闻情绪 + 波动率保护',
    market: 'SOL / USDT',
    status: 'paused',
    pnl: -0.42,
    allocation: 0,
    risk: '高',
    lastAction: '13:51 触发日内回撤限制',
  },
]

export const activity = [
  {
    time: '14:32:18',
    agent: '趋势侦察员',
    title: '限价买入已成交',
    detail: 'BTC/USDT · 0.008 BTC @ 68,214.40',
    status: 'executed',
  },
  {
    time: '14:31:52',
    agent: '风控闸门',
    title: '订单检查通过',
    detail: '仓位 2.1% · 预估滑点 0.04% · 止损已设置',
    status: 'passed',
  },
  {
    time: '14:28:06',
    agent: '均值回归',
    title: '放弃交易信号',
    detail: 'ETH 成交量低于 20 日中位数，置信度降至 58%',
    status: 'skipped',
  },
  {
    time: '13:51:40',
    agent: '风控闸门',
    title: '暂停事件雷达',
    detail: '策略日内回撤 -2.02%，达到自动暂停阈值',
    status: 'blocked',
  },
]

export const positions = [
  { market: 'BTC/USDT', side: '多', size: '0.034 BTC', entry: '67,840.20', mark: '68,412.60', pnl: '+19.46', percent: '+0.84%' },
  { market: 'ETH/USDT', side: '多', size: '0.42 ETH', entry: '3,846.18', mark: '3,872.42', pnl: '+11.02', percent: '+0.68%' },
  { market: 'SOL/USDT', side: '空', size: '3.8 SOL', entry: '176.82', mark: '177.56', pnl: '-2.81', percent: '-0.42%' },
]

export const riskRules = [
  { name: '单笔最大仓位', value: '3.0%', state: '正常', detail: '基于账户净值' },
  { name: '日内最大回撤', value: '2.0%', state: '已触发 1 次', detail: '触发后暂停对应 Agent' },
  { name: '组合总风险敞口', value: '18.0%', state: '当前 11.4%', detail: '跨交易所合并计算' },
  { name: '最小风险回报比', value: '1 : 1.8', state: '正常', detail: '不满足则拒绝订单' },
]
