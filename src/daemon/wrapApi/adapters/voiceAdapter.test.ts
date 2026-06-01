// src/daemon/wrapApi/adapters/voiceAdapter.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { VoiceAdapter } from './voiceAdapter'
import { ConversationStore } from '../../voice/conversationStore'

describe('VoiceAdapter', () => {
  let store: ConversationStore
  beforeEach(() => { store = new ConversationStore(new Database(':memory:')) })

  it('chat() builds prompt from transcript + persona + recent turns', async () => {
    let receivedReq: any
    const fakeLLM = { complete: async (req: any) => { receivedReq = req; return { text: 'response' } } }
    await store.appendTurn('conv_1', { role: 'user', text: 'hey', at: 1000 })
    await store.appendTurn('conv_1', { role: 'agent', text: 'hi nirmal', at: 1100 })
    const adapter = new VoiceAdapter({ llm: fakeLLM, store })

    const r = await adapter.chat({
      transcript: 'what time is it',
      conversationId: 'conv_1',
      userPersona: { name: 'Nirmal', tone: 'terse-direct' },
    })

    expect(r.text).toBe('response')
    expect(r.speakId).toMatch(/^spk_/)
    expect(receivedReq.messages[0].content).toBe('hey')
    expect(receivedReq.messages[1].content).toBe('hi nirmal')
    expect(receivedReq.messages[2].content).toBe('what time is it')
    expect(receivedReq.system).toContain('Nirmal')
    expect(receivedReq.system).toContain('terse-direct')
  })

  it('chat() persists both user and agent turn to store', async () => {
    const fakeLLM = { complete: async () => ({ text: 'r' }) }
    const adapter = new VoiceAdapter({ llm: fakeLLM, store })
    await adapter.chat({ transcript: 'hi', conversationId: 'c1', userPersona: {} })
    const turns = await store.recentTurns('c1', 10)
    expect(turns.length).toBe(2)
    expect(turns[0]!.role).toBe('user')
    expect(turns[0]!.text).toBe('hi')
    expect(turns[1]!.role).toBe('agent')
    expect(turns[1]!.text).toBe('r')
  })

  it('chat() handles empty LLM response gracefully', async () => {
    const fakeLLM = { complete: async () => ({ text: '' }) }
    const adapter = new VoiceAdapter({ llm: fakeLLM, store })
    const r = await adapter.chat({ transcript: 'hi', conversationId: 'c1', userPersona: {} })
    expect(r.text).toBe('(no response)')
  })

  it('chat() role conversion: agent → assistant', async () => {
    let receivedReq: any
    const fakeLLM = { complete: async (req: any) => { receivedReq = req; return { text: 'r' } } }
    await store.appendTurn('c1', { role: 'agent', text: 'prev agent turn', at: 100 })
    const adapter = new VoiceAdapter({ llm: fakeLLM, store })
    await adapter.chat({ transcript: 'now user turn', conversationId: 'c1', userPersona: {} })
    expect(receivedReq.messages[0].role).toBe('assistant')
    expect(receivedReq.messages[1].role).toBe('user')
  })

  it('cancel() aborts the in-flight chat request', async () => {
    let aborted = false
    const fakeLLM = {
      complete: (req: any) => new Promise<any>(resolve => {
        req.signal?.addEventListener?.('abort', () => { aborted = true; resolve({ text: '(aborted)' }) })
      }),
    }
    const adapter = new VoiceAdapter({ llm: fakeLLM, store })
    const chatPromise = adapter.chat({ transcript: 'long', conversationId: 'c1', userPersona: {} })
    setTimeout(() => adapter.cancel(), 5)
    await chatPromise
    expect(aborted).toBe(true)
  })

  it('subsequent chat() cancels the previous in-flight chat', async () => {
    let firstAborted = false
    const fakeLLM = {
      complete: (req: any) => new Promise<any>(resolve => {
        req.signal?.addEventListener?.('abort', () => { firstAborted = true })
        setTimeout(() => resolve({ text: 'done' }), 50)
      }),
    }
    const adapter = new VoiceAdapter({ llm: fakeLLM, store })
    void adapter.chat({ transcript: 'first', conversationId: 'c1', userPersona: {} })
    await new Promise(r => setTimeout(r, 5))
    await adapter.chat({ transcript: 'second', conversationId: 'c1', userPersona: {} })
    expect(firstAborted).toBe(true)
  })
})
