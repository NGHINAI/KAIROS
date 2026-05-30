// scripts/voice-live.ts
//
// LIVE voice loop. Spawns the real Swift KairosVoiceHelper sidecar, boots
// the wrap-API server + voice conductor, and lets you actually talk to
// KAIROS by pressing the Option key (hold to talk).
//
// First run: macOS will prompt for microphone + accessibility permissions.
// Grant them. After that the loop is push-to-talk.
//
// Run:
//   KAIROS_ANTHROPIC_KEY=sk-... bun scripts/voice-live.ts
//
// Stop: Ctrl-C

import { Database } from 'bun:sqlite'
import { join } from 'path'
import { existsSync } from 'fs'
import { startWrapApi } from '../src/daemon/wrapApi/server'
import { LLMAdapter } from '../src/daemon/wrapApi/adapters/llmAdapter'
import { VoiceAdapter } from '../src/daemon/wrapApi/adapters/voiceAdapter'
import { ConversationStore } from '../src/daemon/voice/conversationStore'
import { VoiceConductor } from '../src/daemon/voice/voiceConductor'
import { SidecarClient } from '../src/daemon/voice/sidecarClient'
import { SayBackend } from '../src/daemon/voice/sayBackend'

const apiKey = process.env.KAIROS_ANTHROPIC_KEY ?? process.env.ANTHROPIC_API_KEY
if (!apiKey) { console.error('✗ ANTHROPIC_API_KEY not set'); process.exit(1) }

const helperBinary = process.env.KAIROS_VOICE_HELPER ??
  join(import.meta.dir, '..', 'apps', 'macos', 'KairosVoiceHelper', '.build', 'release', 'KairosVoiceHelper')

if (!existsSync(helperBinary)) {
  console.error(`✗ helper not found at ${helperBinary}`)
  console.error(`  Build it first:`)
  console.error(`    cd apps/macos/KairosVoiceHelper && swift build -c release`)
  process.exit(1)
}

console.log('═════════════════════════════════════════════════════════════')
console.log('  KAIROS Phase E.1 — LIVE voice (real mic + hotkey + Apple STT/TTS)')
console.log('═════════════════════════════════════════════════════════════')
console.log()
console.log('  Hold OPTION key to talk. Release to stop.')
console.log('  KAIROS responds via Apple voice through your speakers.')
console.log('  Ctrl-C to stop.')
console.log()

console.log('[1/4] Starting Bun wrap-API server...')
const db = new Database(':memory:')
const conversationStore = new ConversationStore(db)
const llm = new LLMAdapter({ apiKey, defaultModel: 'claude-haiku-4-5' })
const voice = new VoiceAdapter({ llm, store: conversationStore })

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
console.log(`       ✓ wrap-API at ${api.baseUrl}`)

console.log('[2/4] Spawning Swift KairosVoiceHelper sidecar...')
console.log(`       binary: ${helperBinary}`)
const sidecar = new SidecarClient({ helperBinary })

console.log('[3/4] Connecting to UDS + booting voice conductor...')
const sayBackend = new SayBackend({
  defaultVoice: process.env.KAIROS_VOICE_NAME ?? 'Ava',
  defaultRate: Number(process.env.KAIROS_VOICE_RATE ?? 180),
})

let lastAgentText = ''
const conductor = new VoiceConductor({
  sidecar: sidecar as any,
  store: conversationStore,
  bus: {
    publish: (kind, payload) => {
      if (kind === 'voice.user.utterance') {
        console.log(`\n  🎙  YOU: "${payload.text}"`)
      } else if (kind === 'voice.agent.utterance') {
        lastAgentText = payload.text
        console.log(`  🔊 KAIROS: "${payload.text}"`)
      } else if (kind === 'voice.hotkey.down') {
        process.stdout.write('  ● listening...')
      } else if (kind === 'voice.hotkey.up') {
        process.stdout.write(' ✓\n')
      } else if (kind === 'voice.agent.utterance.interrupted') {
        console.log(`  ⏸  (interrupted)`)
      } else if (kind === 'voice.error') {
        console.log(`  ✗ error: ${payload.error}`)
      }
    },
  },
  wrapApiBaseUrl: api.baseUrl,
  speakBackend: sayBackend,
})

try {
  await sidecar.start()
  await conductor.start()
  console.log('       ✓ sidecar connected, conductor running')
} catch (err) {
  console.error('✗ failed to start sidecar:', err)
  console.error()
  console.error('  Common causes:')
  console.error('  - macOS TCC permissions not granted (mic, accessibility, speech recognition)')
  console.error('  - Sidecar binary not signed (run with `codesign --force --sign - <binary>`)')
  console.error('  - Another KAIROS sidecar already running (kill old process)')
  process.exit(1)
}

console.log()
console.log('[4/4] READY. Hold Option and talk. KAIROS is listening.')
console.log('       (If you hear nothing on first try, macOS may have shown a TCC prompt — grant it and re-run.)')
console.log()

// Stay alive. Ctrl-C handler does cleanup.
process.on('SIGINT', async () => {
  console.log('\n\nShutting down...')
  await conductor.stop()
  await sidecar.stop()
  await api.stop()
  process.exit(0)
})

await new Promise(() => {})   // run forever
