import { Activity, Braces, ChartCandlestick, Gauge, Landmark, Newspaper, ShieldCheck } from 'lucide-react'

export interface SkillDefinition {
  id: string
  name: string
  description: string
  icon: typeof Activity
  checks: number
}

export const builtInSkills: SkillDefinition[] = [
  { id: 'market-analysis', name: '市场状态与波动率', description: '用闭合 K 线识别趋势、震荡、突破与异常波动', icon: ChartCandlestick, checks: 5 },
  { id: 'risk-review', name: '仓位规模与风险预算', description: '核对名义价值、可用余额、持仓集中度与风险上限', icon: ShieldCheck, checks: 6 },
  { id: 'execution-quality', name: '执行质量与滑点', description: '审查价格新鲜度、成交额占比、限价偏离与冲击代理', icon: Gauge, checks: 5 },
  { id: 'futures-carry-risk', name: '资金费率与清算风险', description: '审查杠杆、保证金模式、清算缓冲与永续持仓成本', icon: Landmark, checks: 6 },
  { id: 'news-research', name: '事件与新闻研究', description: '仅使用带来源和时间戳的已授权外部信息', icon: Newspaper, checks: 4 },
  { id: 'strategy-builder', name: '策略一致性审查', description: '核对策略参数、信号理由与冻结候选订单的一致性', icon: Braces, checks: 4 },
]
