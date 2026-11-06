import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatSessionStore } from '../electron/services/chat-sessions.mjs'

const directory = await mkdtemp(join(tmpdir(), 'atlas-chat-sessions-'))

try {
  const store = new ChatSessionStore({ dataDirectory: directory })
  const initial = await store.bootstrap()
  assert.equal(initial.sessions.length, 1)
  const firstId = initial.activeSession.id

  const withUserMessage = await store.appendMessage(firstId, { role: 'user', content: 'BTC trend plan' })
  assert.equal(withUserMessage.activeSession.title, 'BTC trend plan')
  assert.equal(withUserMessage.activeSession.messages.at(-1).content, 'BTC trend plan')

  const withSecondSession = await store.create()
  const secondId = withSecondSession.activeSession.id
  assert.notEqual(secondId, firstId)

  const switched = await store.open(firstId)
  assert.equal(switched.activeSession.id, firstId)

  const renamed = await store.renameSession(firstId, 'BTC review')
  assert.equal(renamed.activeSession.title, 'BTC review')

  const withoutSecond = await store.deleteSession(secondId)
  assert.equal(withoutSecond.sessions.length, 1)
  assert.equal(withoutSecond.activeSession.id, firstId)

  const replacement = await store.deleteSession(firstId)
  assert.equal(replacement.sessions.length, 1)
  assert.notEqual(replacement.activeSession.id, firstId)
  await store.appendMessage(replacement.activeSession.id, { role: 'user', content: 'persist after restart' })

  const restored = await new ChatSessionStore({ dataDirectory: directory }).bootstrap()
  assert.equal(restored.activeSession.id, replacement.activeSession.id)
  assert.equal(restored.activeSession.messages.at(-1).content, 'persist after restart')

  const file = await stat(join(directory, 'sessions.json'))
  assert.equal(file.mode & 0o777, 0o600)

  console.log('chat session verification: ok')
} finally {
  await rm(directory, { recursive: true, force: true })
}
