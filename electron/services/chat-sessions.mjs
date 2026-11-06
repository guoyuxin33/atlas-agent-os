import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

const STORE_VERSION = 1
const DEFAULT_TITLE = '新会话'
const MAX_TITLE_LENGTH = 80
const MAX_MESSAGE_LENGTH = 100_000
const MAX_MESSAGES_PER_SESSION = 2_000
const MAX_SESSION_CHARACTERS = 2_000_000
const MAX_SESSIONS = 500

const WELCOME_MESSAGE = '我可以结合当前行情、账户环境和已启用的 Skill 做分析。任何生产订单都只会生成交易意图，不会在对话中直接执行。'

function clone(value) {
  return structuredClone(value)
}

function cleanTitle(value, fallback = DEFAULT_TITLE) {
  const title = String(value || '').trim().replace(/\s+/g, ' ')
  return (title || fallback).slice(0, MAX_TITLE_LENGTH)
}

function cleanMessage(candidate) {
  const role = candidate?.role === 'assistant' ? 'assistant' : candidate?.role === 'user' ? 'user' : null
  const content = typeof candidate?.content === 'string' ? candidate.content.trim() : ''
  if (!role) throw new Error('不支持的消息角色')
  if (!content) throw new Error('消息内容不能为空')
  if (content.length > MAX_MESSAGE_LENGTH) throw new Error('消息过长，请缩短后重试')
  return {
    id: randomUUID(),
    role,
    content,
    createdAt: Date.now(),
    ...(role === 'assistant' && candidate.model ? { model: String(candidate.model).slice(0, 160) } : {}),
  }
}

function safeMessage(candidate) {
  if (!candidate || !['user', 'assistant'].includes(candidate.role) || typeof candidate.content !== 'string') return null
  const content = candidate.content.trim().slice(0, MAX_MESSAGE_LENGTH)
  if (!content) return null
  return {
    id: typeof candidate.id === 'string' && candidate.id ? candidate.id : randomUUID(),
    role: candidate.role,
    content,
    createdAt: Number.isFinite(candidate.createdAt) ? candidate.createdAt : Date.now(),
    ...(candidate.role === 'assistant' && candidate.model ? { model: String(candidate.model).slice(0, 160) } : {}),
  }
}

function safeSession(candidate) {
  if (!candidate || typeof candidate.id !== 'string' || !candidate.id) return null
  const createdAt = Number.isFinite(candidate.createdAt) ? candidate.createdAt : Date.now()
  const messages = Array.isArray(candidate.messages) ? candidate.messages.map(safeMessage).filter(Boolean) : []
  return {
    id: candidate.id,
    title: cleanTitle(candidate.title),
    messages,
    createdAt,
    updatedAt: Number.isFinite(candidate.updatedAt) ? candidate.updatedAt : createdAt,
  }
}

function newSession(title = DEFAULT_TITLE) {
  const now = Date.now()
  return {
    id: randomUUID(),
    title: cleanTitle(title),
    messages: [{ id: randomUUID(), role: 'assistant', content: WELCOME_MESSAGE, createdAt: now }],
    createdAt: now,
    updatedAt: now,
  }
}

function summarize(session) {
  const lastMessage = session.messages.at(-1)
  return {
    id: session.id,
    title: session.title,
    preview: lastMessage?.content || '暂无消息',
    messageCount: session.messages.length,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  }
}

export class ChatSessionStore {
  constructor({ dataDirectory }) {
    if (!dataDirectory) throw new Error('Chat session data directory is required')
    this.dataDirectory = dataDirectory
    this.storePath = join(dataDirectory, 'sessions.json')
    this.sessions = new Map()
    this.activeSessionId = null
    this.initialization = null
    this.writeQueue = Promise.resolve()
  }

  initialize() {
    if (this.initialization) return this.initialization
    this.initialization = this.#initialize()
    return this.initialization
  }

  async #initialize() {
    await mkdir(this.dataDirectory, { recursive: true })
    try {
      const stored = JSON.parse(await readFile(this.storePath, 'utf8'))
      for (const candidate of Array.isArray(stored?.sessions) ? stored.sessions : []) {
        const session = safeSession(candidate)
        if (session) this.sessions.set(session.id, session)
      }
      if (typeof stored?.activeSessionId === 'string' && this.sessions.has(stored.activeSessionId)) {
        this.activeSessionId = stored.activeSessionId
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') console.error('[chat-sessions:load]', error)
    }

    if (!this.sessions.size) {
      const session = newSession()
      this.sessions.set(session.id, session)
      this.activeSessionId = session.id
      await this.#persist()
    } else if (!this.activeSessionId) {
      this.activeSessionId = this.#sortedSessions()[0].id
      await this.#persist()
    }
  }

  async bootstrap() {
    await this.initialize()
    return this.#state()
  }

  async create(input = {}) {
    await this.initialize()
    if (this.sessions.size >= MAX_SESSIONS) throw new Error(`会话数量已达 ${MAX_SESSIONS} 个，请删除旧会话后重试`)
    const session = newSession(input.title)
    this.sessions.set(session.id, session)
    this.activeSessionId = session.id
    await this.#persist()
    return this.#state()
  }

  async open(sessionId) {
    await this.initialize()
    const session = this.#requireSession(sessionId)
    this.activeSessionId = session.id
    await this.#persist()
    return this.#state()
  }

  async renameSession(sessionId, title) {
    await this.initialize()
    const session = this.#requireSession(sessionId)
    session.title = cleanTitle(title)
    session.updatedAt = Date.now()
    await this.#persist()
    return this.#state()
  }

  async deleteSession(sessionId) {
    await this.initialize()
    this.#requireSession(sessionId)
    this.sessions.delete(sessionId)
    if (!this.sessions.size) {
      const replacement = newSession()
      this.sessions.set(replacement.id, replacement)
      this.activeSessionId = replacement.id
    } else if (this.activeSessionId === sessionId) {
      this.activeSessionId = this.#sortedSessions()[0].id
    }
    await this.#persist()
    return this.#state()
  }

  async appendMessage(sessionId, input) {
    await this.initialize()
    const session = this.#requireSession(sessionId)
    const message = cleanMessage(input)
    if (session.messages.length >= MAX_MESSAGES_PER_SESSION) {
      throw new Error(`当前会话已达 ${MAX_MESSAGES_PER_SESSION} 条消息，请新建会话继续`)
    }
    const currentCharacters = session.messages.reduce((total, item) => total + item.content.length, 0)
    if (currentCharacters + message.content.length > MAX_SESSION_CHARACTERS) {
      throw new Error('当前会话已达到本地存储上限，请新建会话继续')
    }
    session.messages.push(message)
    if (message.role === 'user' && session.title === DEFAULT_TITLE) {
      session.title = cleanTitle(message.content.slice(0, 32))
    }
    session.updatedAt = Date.now()
    await this.#persist()
    return this.#state()
  }

  #requireSession(sessionId) {
    const session = this.sessions.get(String(sessionId || ''))
    if (!session) throw new Error('会话不存在或已被删除')
    return session
  }

  #sortedSessions() {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  #state() {
    const activeSession = this.#requireSession(this.activeSessionId)
    return clone({
      sessions: this.#sortedSessions().map(summarize),
      activeSession,
    })
  }

  #persist() {
    const payload = JSON.stringify({
      version: STORE_VERSION,
      activeSessionId: this.activeSessionId,
      sessions: [...this.sessions.values()],
    }, null, 2)
    const temporaryPath = `${this.storePath}.${process.pid}.${randomUUID()}.tmp`
    const operation = this.writeQueue.catch(() => {}).then(async () => {
      await writeFile(temporaryPath, payload, { encoding: 'utf8', mode: 0o600 })
      await rename(temporaryPath, this.storePath)
    })
    this.writeQueue = operation
    return operation
  }
}
