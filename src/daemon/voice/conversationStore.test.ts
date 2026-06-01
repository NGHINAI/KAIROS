// src/daemon/voice/conversationStore.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { ConversationStore } from './conversationStore'

describe('ConversationStore', () => {
  let db: Database
  let store: ConversationStore

  beforeEach(() => {
    db = new Database(':memory:')
    store = new ConversationStore(db)
  })

  it('appendTurn + recentTurns round trip', async () => {
    await store.appendTurn('c1', { role: 'user', text: 'hi', at: 1000 })
    await store.appendTurn('c1', { role: 'agent', text: 'hello', at: 1100 })
    const turns = await store.recentTurns('c1', 10)
    expect(turns.length).toBe(2)
    expect(turns[0]!.text).toBe('hi')
    expect(turns[1]!.text).toBe('hello')
  })

  it('recentTurns returns chronological order (oldest first)', async () => {
    await store.appendTurn('c1', { role: 'user', text: 'first', at: 1000 })
    await store.appendTurn('c1', { role: 'agent', text: 'second', at: 2000 })
    await store.appendTurn('c1', { role: 'user', text: 'third', at: 3000 })
    const turns = await store.recentTurns('c1', 10)
    expect(turns.map(t => t.text)).toEqual(['first', 'second', 'third'])
  })

  it('recentTurns honors limit (keeps most recent)', async () => {
    for (let i = 0; i < 10; i++) {
      await store.appendTurn('c1', { role: 'user', text: 't' + i, at: 1000 + i })
    }
    const turns = await store.recentTurns('c1', 3)
    expect(turns.length).toBe(3)
    expect(turns[0]!.text).toBe('t7')
    expect(turns[2]!.text).toBe('t9')
  })

  it('different conversations isolated', async () => {
    await store.appendTurn('c1', { role: 'user', text: 'in c1', at: 1000 })
    await store.appendTurn('c2', { role: 'user', text: 'in c2', at: 1000 })
    expect((await store.recentTurns('c1', 10)).length).toBe(1)
    expect((await store.recentTurns('c2', 10)).length).toBe(1)
  })

  it('empty conversation returns empty array', async () => {
    expect(await store.recentTurns('never-existed', 10)).toEqual([])
  })
})
