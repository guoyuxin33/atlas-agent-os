import { useState } from 'react'
import { Blocks, Bot, Cable, CircleCheck, CircleX, Plus, Wrench } from 'lucide-react'
import { builtInSkills } from '../skills'
import type { McpConnection } from '../types'

interface SkillsViewProps {
  enabled: Set<string>
  onToggle: (id: string) => void
  onToast: (message: string) => void
  mcpConnection: McpConnection | null
  onMcpConnection: (connection: McpConnection | null) => void
}

export function SkillsView({ enabled, onToggle, onToast, mcpConnection, onMcpConnection }: SkillsViewProps) {
  const [showMcpForm, setShowMcpForm] = useState(false)
  const [mcpUrl, setMcpUrl] = useState(mcpConnection?.url || 'http://127.0.0.1:3001/mcp')
  const [connecting, setConnecting] = useState(false)
  const [mcpError, setMcpError] = useState<string | null>(null)
  const mcpTools = mcpConnection?.tools || []

  const connectMcp = async () => {
    setConnecting(true)
    setMcpError(null)
    try {
      if (!window.atlas) throw new Error('MCP 连接需要桌面应用主进程')
      const result = await window.atlas.mcp.connect({ url: mcpUrl })
      onMcpConnection({ url: mcpUrl, tools: result.tools })
      setShowMcpForm(false)
      onToast(`MCP 已连接，发现 ${result.tools.length} 个工具`)
    } catch (caught) {
      setMcpError(caught instanceof Error ? caught.message : 'MCP 连接失败')
    } finally {
      setConnecting(false)
    }
  }

  return (
    <main className="page">
      <section className="page-heading"><div><span className="section-kicker">Agent 能力层</span><h1>Skill / MCP</h1><p>控制模型可使用的领域能力和外部工具服务器</p></div><button className="primary-button" onClick={() => setShowMcpForm(true)}><Plus size={16} />连接 MCP</button></section>
      <section className="skill-section">
        <header className="section-header"><div><h2>内置 Skill</h2><p>Skill 只提供分析能力，执行仍受权限和风控限制</p></div><span className="quiet-chip">{enabled.size} / {builtInSkills.length} 已启用</span></header>
        <div className="skill-grid">{builtInSkills.map((skill) => {
          const Icon = skill.icon
          const active = enabled.has(skill.id)
          return <article className={`skill-card ${active ? 'skill-active' : ''}`} key={skill.id}><header><span className="skill-icon"><Icon size={18} /></span><label className="switch"><input type="checkbox" checked={active} onChange={() => onToggle(skill.id)} /><span /></label></header><h3>{skill.name}</h3><p>{skill.description}</p><footer><span><Wrench size={13} />{skill.tools} 个工具</span><strong>{active ? '已启用' : '未启用'}</strong></footer></article>
        })}</div>
      </section>
      <section className="skill-section mcp-section">
        <header className="section-header"><div><h2>MCP 服务器</h2><p>支持 Streamable HTTP，连接时执行 initialize 与 tools/list</p></div></header>
        {showMcpForm && <div className="mcp-connect-panel panel"><div><label className="field-label" htmlFor="mcp-url">Streamable HTTP URL</label><div className="input-shell"><Cable size={16} /><input id="mcp-url" value={mcpUrl} onChange={(event) => setMcpUrl(event.target.value)} /></div>{mcpError && <p className="form-error">{mcpError}</p>}</div><button className="secondary-button" onClick={() => setShowMcpForm(false)}>取消</button><button className="primary-button" onClick={connectMcp} disabled={connecting}><Cable size={16} />{connecting ? '握手中' : '连接并发现工具'}</button></div>}
        <div className="connection-list">
          <article className="connection-row mcp-row"><span className="model-logo large"><Blocks size={19} /></span><div className="connection-main"><div><h3>Atlas 内置工具服务</h3><span className="healthy-label"><CircleCheck size={12} />可用</span></div><p>market.get_ticker · market.get_klines · risk.check_order · portfolio.snapshot</p></div><div className="connection-meta"><span>工具</span><strong>4</strong></div><div className="connection-meta"><span>传输</span><strong>Local IPC</strong></div><button className="icon-button" onClick={() => onToast('内置工具由主进程管理，无需单独配置')}><Bot size={17} /></button></article>
          {mcpTools.length > 0 && <article className="connection-row mcp-row"><span className="model-logo large"><Cable size={19} /></span><div className="connection-main"><div><h3>{new URL(mcpConnection?.url || mcpUrl).host}</h3><span className="healthy-label"><CircleCheck size={12} />已连接</span></div><p>{mcpTools.slice(0, 4).map((tool) => tool.name).join(' · ')}</p></div><div className="connection-meta"><span>工具</span><strong>{mcpTools.length}</strong></div><div className="connection-meta"><span>协议</span><strong>MCP</strong></div><button className="icon-button" onClick={() => { onMcpConnection(null); onToast('MCP 会话已从工作台移除') }} title="断开"><CircleX size={17} /></button></article>}
        </div>
      </section>
    </main>
  )
}
