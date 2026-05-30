// scripts/voice-repl.ts
//
// "Voice REPL" — closest thing to talking-to-KAIROS we can run today without
// Xcode + Apple Developer signing + TCC permission grants.
//
// You TYPE the user side (instead of mic). KAIROS responds via real Claude +
// real Apple voice through your Mac speakers. Same pipeline as the future
// hotkey-driven version — just stdin instead of mic.
//
// Once the Swift sidecar is built+signed+TCC-granted, replace stdin reading
// with hotkey-gated SFSpeechRecognizer — everything else stays.
//
// Run: bun scripts/voice-repl.ts

import { Database } from 'bun:sqlite'
import { startWrapApi } from '../src/daemon/wrapApi/server'
import { LLMAdapter } from '../src/daemon/wrapApi/adapters/llmAdapter'
import { VoiceAdapter } from '../src/daemon/wrapApi/adapters/voiceAdapter'
import { ConversationStore } from '../src/daemon/voice/conversationStore'
import { SayBackend } from '../src/daemon/voice/sayBackend'

const apiKey = process.env.KAIROS_ANTHROPIC_KEY ?? process.env.ANTHROPIC_API_KEY
if (!apiKey) { console.error('✗ ANTHROPIC_API_KEY not set'); process.exit(1) }

const db = new Database(':memory:')
const conversationStore = new ConversationStore(db)
const llm = new LLMAdapter({ apiKey, defaultModel: 'claude-haiku-4-5' })
const voice = new VoiceAdapter({ llm, store: conversationStore })
const sayBackend = new SayBackend({
  defaultVoice: process.env.KAIROS_VOICE_NAME ?? 'Ava',
  defaultRate: Number(process.env.KAIROS_VOICE_RATE ?? 180),
})

const api = await startWrapApi({
  port: 0, hostname: '127.0.0.1',
  adapters: {
    llm: { complete: (b) => llm.complete(b) },
    voice: { chat: (b) => voice.chat(b), cancel: async () => voice.cancel() },
    memory: { append: async () => ({}), get: async () => ({}) },
    orders: { add: async () => ({ slug: 'stub' }), list: async () => [] },
    composio: { listConnections: async () => [], connect: async () => ({}), disconnect: async () => ({}) },
    settings: { get: async () => ({}), update: async () => ({ updated: [] }) },
  },
})

console.log('═════════════════════════════════════════════════════════════')
console.log('  KAIROS Voice REPL')
console.log('═════════════════════════════════════════════════════════════')
console.log()
console.log('  Type your message and press Enter — KAIROS replies via voice.')
console.log('  Type   exit   to quit. Or press Ctrl-D.')
console.log()

// Initial greeting
const greeting = "Hey Nirmal. I'm KAIROS. Talk to me — type, hit enter, I'll respond."
console.log(`  KAIROS: "${greeting}"`)
console.log()
await sayBackend.speak(greeting)

const conversationId = 'repl-' + Date.now()

async function processLine(rawText: any): Promise<boolean> {
  const text = String(rawText ?? '').trim()
  if (!text) { process.stdout.write('  you > '); return false }
  if (text === 'exit' || text === 'quit') return true
  try {
    const resp = await fetch(`${api.baseUrl}/v1/voice/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ transcript: text, conversationId, userPersona: { name: 'Nirmal' } }),
    })
    const raw = await resp.text()
    let body: any
    try { body = JSON.parse(raw) } catch { body = { text: raw } }
    if (process.env.KAIROS_DEBUG) console.log('  [debug] raw:', raw.slice(0, 300))
    const answer = String(body?.text ?? '(no response)')
    console.log()
    console.log(`  KAIROS: "${answer}"`)
    console.log()
    await sayBackend.speak(answer)
  } catch (err) {
    console.error('  ✗ error:', err instanceof Error ? err.message : err)
  }
  process.stdout.write('  you > ')
  return false
}

process.stdout.write('  you > ')

const readline = await import('readline')
const rl = readline.createInterface({ input: process.stdin, output: undefined, terminal: false })

for await (const line of rl) {
  if (await processLine(line)) break
}

console.log('\nGoodbye.')
await api.stop()
process.exit(0)

console.log('\nGoodbye.')
await api.stop()
process.exit(0)
