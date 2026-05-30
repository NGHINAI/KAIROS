// scripts/voice-demo.ts
//
// Phase E.1 end-to-end demo. Boots: wrap-API server + voice conductor +
// SidecarSimulator + SayBackend. Simulates a user utterance and KAIROS
// actually speaks the response through your Mac speakers.
//
// Run: KAIROS_ANTHROPIC_KEY=sk-... bun scripts/voice-demo.ts

import { Database } from 'bun:sqlite'
import { startWrapApi } from '../src/daemon/wrapApi/server'
import { LLMAdapter } from '../src/daemon/wrapApi/adapters/llmAdapter'
import { VoiceAdapter } from '../src/daemon/wrapApi/adapters/voiceAdapter'
import { ConversationStore } from '../src/daemon/voice/conversationStore'
import { VoiceConductor } from '../src/daemon/voice/voiceConductor'
import { SidecarSimulator } from '../src/daemon/voice/sidecarSimulator'
import { SayBackend } from '../src/daemon/voice/sayBackend'

const apiKey = process.env.KAIROS_ANTHROPIC_KEY ?? process.env.ANTHROPIC_API_KEY
if (!apiKey) {
  console.error('✗ neither KAIROS_ANTHROPIC_KEY nor ANTHROPIC_API_KEY set')
  process.exit(1)
}

console.log('═════════════════════════════════════════════════════════════')
console.log('  KAIROS Phase E.1 — Voice end-to-end demo')
console.log('  (stage-0: SidecarSimulator + SayBackend on top of real wrap-API)')
console.log('═════════════════════════════════════════════════════════════')
console.log()

const db = new Database(':memory:')
const conversationStore = new ConversationStore(db)
const llm = new LLMAdapter({ apiKey, defaultModel: 'claude-haiku-4-5' })
const voice = new VoiceAdapter({ llm, store: conversationStore })

console.log('[1/4] Starting wrap-API server on 127.0.0.1...')
const api = await startWrapApi({
  port: 0,
  hostname: '127.0.0.1',
  adapters: {
    llm:      { complete: (b) => llm.complete(b) },
    voice:    { chat: (b) => voice.chat(b), cancel: async () => voice.cancel() },
    memory:   { append: async () => ({}), get: async () => ({}) },
    orders:   { add: async () => ({ slug: 'stub' }), list: async () => [] },
    composio: { listConnections: async () => [], connect: async () => ({}), disconnect: async () => ({}) },
    settings: { get: async () => ({}), update: async () => ({ updated: [] }) },
  },
})
console.log(`       ✓ wrap-API ready at ${api.baseUrl}`)

console.log('[2/4] Initializing SidecarSimulator + SayBackend...')
const sim = new SidecarSimulator()
const sayBackend = new SayBackend({
  defaultVoice: process.env.KAIROS_VOICE_NAME ?? 'Ava',
  defaultRate: Number(process.env.KAIROS_VOICE_RATE ?? 180),
})

const log = (kind: string, payload: any) =>
  console.log(`       [bus] ${kind}: ${JSON.stringify(payload).slice(0, 200)}`)

const conductor = new VoiceConductor({
  sidecar: sim,
  store: conversationStore,
  bus: { publish: log },
  wrapApiBaseUrl: api.baseUrl,
  speakBackend: sayBackend,
})

console.log('[3/4] Starting conductor...')
await conductor.start()
console.log('       ✓ conductor ready')

console.log()
console.log('[4/4] Simulating user utterance and listening for KAIROS response...')
console.log('       🎙  simulated user: "Say hello to me and tell me what you are in one sentence."')
console.log()

sim.simulateHotkey('down')
sim.simulateUtterance('Say hello to me and tell me what you are in one sentence.')
sim.simulateHotkey('up')

// Wait for: fetch + LLM response + TTS playback
await new Promise(r => setTimeout(r, 20000))

console.log()
console.log('─── done ──────────────────────────────────────────────────────')
console.log('  If you heard KAIROS speak, the end-to-end voice loop works ✓')
console.log()

await conductor.stop()
await api.stop()
process.exit(0)
