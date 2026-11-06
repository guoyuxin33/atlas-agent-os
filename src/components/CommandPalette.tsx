import { Bot, BrainCircuit, Cable, ChartCandlestick, Search, ShieldCheck, Wrench, X } from 'lucide-react'
import { useMemo, useState } from 'react'

interface CommandPaletteProps {
  onClose: () => void
  onNavigate: (id: string) => void
}

const commands = [
  { id: 'overview', label: '打开交易工作台', hint: '行情与快速下单', icon: ChartCandlestick },
  { id: 'assistant', label: '打开 Atlas Assistant', hint: 'AI 对话与分析', icon: Bot },
  { id: 'agents', label: '管理 Agent', hint: '策略与运行状态', icon: BrainCircuit },
  { id: 'skills', label: '管理 Skill / MCP', hint: '工具与服务器', icon: Wrench },
  { id: 'connections', label: '检查连接', hint: '交易所与模型', icon: Cable },
  { id: 'risk', label: '查看风险控制', hint: '规则与紧急停止', icon: ShieldCheck },
]

export function CommandPalette({ onClose, onNavigate }: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const filtered = useMemo(() => commands.filter((command) => `${command.label}${command.hint}`.toLowerCase().includes(query.toLowerCase())), [query])
  return <div className="command-backdrop" onMouseDown={onClose}><section className="command-palette" onMouseDown={(event) => event.stopPropagation()}><header><Search size={17} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索页面或操作" /><button onClick={onClose}><X size={16} /></button></header><div>{filtered.map((command) => <button key={command.id} onClick={() => { onNavigate(command.id); onClose() }}><span><command.icon size={17} /></span><div><strong>{command.label}</strong><small>{command.hint}</small></div><kbd>↵</kbd></button>)}</div></section></div>
}
