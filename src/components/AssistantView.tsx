import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Bot, BrainCircuit, Check, CircleStop, Copy, History, MessageSquare, MessageSquarePlus, Pencil, ShieldCheck, Trash2, Wrench, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { builtInSkills } from '../skills'
import type { AccountSnapshot, ChatSessionState, Environment, McpConnection, MarketType, MarketTick } from '../types'

const EMPTY_MESSAGES: ChatSessionState['activeSession']['messages'] = []

interface AssistantViewProps {
  environment: Environment
  marketType: MarketType
  symbol: string
  tick: MarketTick
  account: AccountSnapshot | null
  halted: boolean
  enabledSkills: string[]
  mcpConnection: McpConnection | null
  onOpenConnections: () => void
}

function readableIpcError(error: unknown) {
  const message = error instanceof Error ? error.message : '模型请求失败'
  return message
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
}

function formatSessionTime(timestamp: number) {
  const date = new Date(timestamp)
  const today = new Date()
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  }
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

function AssistantMessage({ content }: { content: string }) {
  return (
    <div className="chat-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => href?.startsWith('https://')
            ? <a href={href} target="_blank" rel="noreferrer">{children}</a>
            : <span>{children}</span>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}

export function AssistantView({ environment, marketType, symbol, tick, account, halted, enabledSkills, mcpConnection, onOpenConnections }: AssistantViewProps) {
  const [sessionState, setSessionState] = useState<ChatSessionState | null>(null)
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [sessionBusy, setSessionBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameTitle, setRenameTitle] = useState('')
  const messageListRef = useRef<HTMLDivElement>(null)

  const activeSession = sessionState?.activeSession
  const messages = activeSession?.messages || EMPTY_MESSAGES

  useEffect(() => {
    let current = true
    const load = async () => {
      try {
        if (!window.atlas) throw new Error('AI 对话需要在 Atlas 桌面应用中运行')
        const state = await window.atlas.ai.sessions.bootstrap()
        if (current) setSessionState(state)
      } catch (caught) {
        if (current) setError(readableIpcError(caught))
      }
    }
    void load()
    return () => { current = false }
  }, [])

  useEffect(() => {
    const list = messageListRef.current
    if (list) list.scrollTop = list.scrollHeight
  }, [messages, loading])

  const runSessionAction = async (action: () => Promise<ChatSessionState>) => {
    if (loading || sessionBusy) return
    setSessionBusy(true)
    setError(null)
    try {
      setSessionState(await action())
    } catch (caught) {
      setError(readableIpcError(caught))
    } finally {
      setSessionBusy(false)
    }
  }

  const createSession = () => {
    if (!window.atlas) return
    setRenamingId(null)
    void runSessionAction(() => window.atlas!.ai.sessions.create())
  }

  const openSession = (sessionId: string) => {
    if (!window.atlas || sessionId === activeSession?.id) return
    setRenamingId(null)
    void runSessionAction(() => window.atlas!.ai.sessions.open(sessionId))
  }

  const beginRename = (sessionId: string, title: string) => {
    if (loading || sessionBusy) return
    setRenamingId(sessionId)
    setRenameTitle(title)
  }

  const renameSession = (sessionId: string) => {
    const title = renameTitle.trim()
    if (!window.atlas || !title) return
    void runSessionAction(async () => {
      const state = await window.atlas!.ai.sessions.rename(sessionId, title)
      setRenamingId(null)
      return state
    })
  }

  const deleteSession = (sessionId: string, title: string) => {
    if (!window.atlas || loading || sessionBusy) return
    if (!window.confirm(`删除会话“${title}”？历史消息将无法恢复。`)) return
    setRenamingId(null)
    void runSessionAction(() => window.atlas!.ai.sessions.delete(sessionId))
  }

  const send = async (content = input) => {
    const trimmed = content.trim()
    if (!trimmed || loading || sessionBusy || !activeSession) return
    const sessionId = activeSession.id
    setInput('')
    setLoading(true)
    setError(null)
    try {
      if (!window.atlas) throw new Error('AI 对话需要在 Atlas 桌面应用中运行')
      const withUserMessage = await window.atlas.ai.sessions.append(sessionId, { role: 'user', content: trimmed })
      setSessionState(withUserMessage)
      const response = await window.atlas.ai.chat({
        messages: withUserMessage.activeSession.messages.map(({ role, content: messageContent }) => ({ role, content: messageContent })),
        skills: enabledSkills,
        mcp: mcpConnection || undefined,
        context: {
          environment,
          marketType,
          symbol,
          price: tick.price,
          change24h: tick.change,
          high24h: tick.high,
          low24h: tick.low,
          executionHalted: halted,
          account: account ? {
            equity: account.totalWalletBalance,
            availableBalance: account.availableBalance,
            unrealizedPnl: account.unrealizedPnl,
            todayPnl: account.todayPnl,
            positions: account.portfolio.slice(0, 20),
          } : null,
        },
      })
      const withAssistantMessage = await window.atlas.ai.sessions.append(sessionId, {
        role: 'assistant',
        content: response.content,
        model: response.model,
      })
      setSessionState(withAssistantMessage)
    } catch (caught) {
      setError(readableIpcError(caught))
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="page assistant-page">
      <section className="page-heading assistant-heading">
        <div><span className="section-kicker">带上下文的交易分析</span><h1>Atlas Assistant</h1><p>模型可读取当前市场与 Skill，但生产执行始终经过独立确认</p></div>
        <button className="secondary-button" onClick={onOpenConnections}><BrainCircuit size={16} />模型连接</button>
      </section>
      <section className="assistant-layout">
        <aside className="assistant-sessions panel">
          <header className="assistant-session-header">
            <div><History size={15} /><h2>历史会话</h2></div>
            <button onClick={createSession} disabled={loading || sessionBusy} title="新建会话" aria-label="新建会话"><MessageSquarePlus size={16} /></button>
          </header>
          <div className="assistant-session-list">
            {!sessionState && !error && <p className="session-loading">正在加载会话…</p>}
            {sessionState?.sessions.map((session) => (
              <div className={`assistant-session-row ${session.id === activeSession?.id ? 'active' : ''}`} key={session.id}>
                {renamingId === session.id ? (
                  <form className="session-rename" onSubmit={(event) => { event.preventDefault(); renameSession(session.id) }}>
                    <input autoFocus value={renameTitle} maxLength={80} onChange={(event) => setRenameTitle(event.target.value)} aria-label="会话名称" />
                    <button type="submit" disabled={!renameTitle.trim() || sessionBusy} title="保存" aria-label="保存会话名称"><Check size={14} /></button>
                    <button type="button" onClick={() => setRenamingId(null)} title="取消" aria-label="取消重命名"><X size={14} /></button>
                  </form>
                ) : (
                  <>
                    <button className="session-open" onClick={() => openSession(session.id)} disabled={loading || sessionBusy}>
                      <MessageSquare size={14} />
                      <span><strong>{session.title}</strong><small>{session.preview}</small></span>
                      <time>{formatSessionTime(session.updatedAt)}</time>
                    </button>
                    <span className="session-row-actions">
                      <button onClick={() => beginRename(session.id, session.title)} disabled={loading || sessionBusy} title="重命名" aria-label={`重命名 ${session.title}`}><Pencil size={13} /></button>
                      <button onClick={() => deleteSession(session.id, session.title)} disabled={loading || sessionBusy} title="删除" aria-label={`删除 ${session.title}`}><Trash2 size={13} /></button>
                    </span>
                  </>
                )}
              </div>
            ))}
          </div>
        </aside>

        <div className="assistant-chat panel">
          <header className="assistant-context">
            <span><i className={tick.connected ? 'context-live' : ''} />{symbol}</span>
            <span>{marketType === 'spot' ? '现货' : 'USDT 永续'}</span>
            <span>{environment === 'paper' ? '模拟盘' : environment === 'testnet' ? '测试网' : '生产'}</span>
            <span className={tick.change >= 0 ? 'text-positive' : 'text-negative'}>{tick.price.toLocaleString('en-US', { maximumFractionDigits: 2 })} · {tick.change >= 0 ? '+' : ''}{tick.change.toFixed(2)}%</span>
          </header>
          <div className="message-list" ref={messageListRef}>
            {messages.map((message) => (
              <article className={`chat-message chat-${message.role}`} key={message.id}>
                <span className="chat-avatar">{message.role === 'assistant' ? <Bot size={16} /> : 'YX'}</span>
                <div><header><strong>{message.role === 'assistant' ? 'Atlas' : '你'}</strong><span>{message.model || formatSessionTime(message.createdAt)}</span></header>{message.role === 'assistant' ? <AssistantMessage content={message.content} /> : <p>{message.content}</p>}{message.role === 'assistant' && <button className="message-copy" onClick={() => navigator.clipboard.writeText(message.content)} title="复制回答"><Copy size={14} /></button>}</div>
              </article>
            ))}
            {loading && <article className="chat-message chat-assistant"><span className="chat-avatar"><Bot size={16} /></span><div><header><strong>Atlas</strong><span>正在分析</span></header><p className="thinking-line">读取市场上下文与 Skill...</p></div></article>}
          </div>
          {error && <div className="chat-error"><CircleStop size={16} /><span>{error}</span><button onClick={onOpenConnections}>检查模型连接</button></div>}
          <div className="quick-prompts">
            <button onClick={() => send(`结合当前 24 小时走势，给出 ${symbol} 的关键支撑阻力和失效条件`)} disabled={!activeSession || loading || sessionBusy}>关键价位</button>
            <button onClick={() => send('检查当前市场是否适合趋势策略，列出主要风险')} disabled={!activeSession || loading || sessionBusy}>策略检查</button>
            <button onClick={() => send('为当前环境生成一个只读观察计划，不执行订单')} disabled={!activeSession || loading || sessionBusy}>观察计划</button>
          </div>
          <form className="chat-composer" onSubmit={(event) => { event.preventDefault(); void send() }}>
            <textarea value={input} onChange={(event) => setInput(event.target.value)} placeholder="询问行情、策略或风险" disabled={!activeSession || sessionBusy} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send() } }} />
            <button type="submit" disabled={!activeSession || !input.trim() || loading || sessionBusy} aria-label="发送"><ArrowUp size={17} /></button>
          </form>
        </div>

        <aside className="assistant-tools panel">
          <header className="panel-header"><div><h2>本次会话能力</h2><p>由 Skill 和 MCP 提供</p></div><Wrench size={17} /></header>
          <div className="assistant-tool-list">
            {enabledSkills.map((skill) => { const definition = builtInSkills.find((item) => item.id === skill); return <div key={skill}><ShieldCheck size={15} /><span><strong>{definition?.name || skill}</strong><small>已注入系统上下文</small></span></div> })}
            {mcpConnection?.tools.map((tool) => <div key={`mcp:${tool.name}`}><Wrench size={15} /><span><strong>{tool.name}</strong><small>MCP 可调用工具</small></span></div>)}
            {!enabledSkills.length && !mcpConnection?.tools.length && <p className="empty-copy">请在 Skill / MCP 页面启用至少一个能力</p>}
          </div>
          <div className="assistant-boundary"><ShieldCheck size={18} /><div><strong>执行边界</strong><p>对话可以提出交易意图，但不能直接提交生产订单或修改风控规则。</p></div></div>
        </aside>
      </section>
    </main>
  )
}
