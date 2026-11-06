import { Activity, Braces, ChartCandlestick, Newspaper, ShieldCheck } from 'lucide-react'

export interface SkillDefinition {
  id: string
  name: string
  description: string
  icon: typeof Activity
  tools: number
}

export const builtInSkills: SkillDefinition[] = [
  { id: 'market-analysis', name: '市场结构分析', description: '趋势、支撑阻力、成交量与波动率', icon: ChartCandlestick, tools: 6 },
  { id: 'risk-review', name: '交易风险审查', description: '仓位、回撤、滑点和止损完整性', icon: ShieldCheck, tools: 8 },
  { id: 'news-research', name: '事件与新闻研究', description: '事件聚合、来源对照和情绪归因', icon: Newspaper, tools: 4 },
  { id: 'strategy-builder', name: '策略结构化', description: '把自然语言转成可验证的策略规则', icon: Braces, tools: 5 },
]
