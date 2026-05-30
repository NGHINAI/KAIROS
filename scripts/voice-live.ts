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
import { spawn } from 'bun'
import { startWrapApi } from '../src/daemon/wrapApi/server'
import { LLMAdapter } from '../src/daemon/wrapApi/adapters/llmAdapter'
import { ClaudeCodeAdapter } from '../src/daemon/wrapApi/adapters/claudeCodeAdapter'
import { OpenRouterAdapter } from '../src/daemon/wrapApi/adapters/openRouterAdapter'
import { VoiceAdapter } from '../src/daemon/wrapApi/adapters/voiceAdapter'
import { ConversationStore } from '../src/daemon/voice/conversationStore'
import { VoiceConductor } from '../src/daemon/voice/voiceConductor'
import { SidecarClient } from '../src/daemon/voice/sidecarClient'
import { SayBackend } from '../src/daemon/voice/sayBackend'
import { StreamingSpeaker } from '../src/daemon/voice/streamingSpeaker'
import { whisperFromEnv, type WhisperAdapter } from '../src/daemon/voice/whisperAdapter'

// STT backend selection. Env: KAIROS_STT = apple | groq | openrouter (default: apple)
// All three feed the same downstream pipeline; only the transcription source differs.
type SttBackend = 'apple' | 'groq' | 'openrouter'
const sttBackend: SttBackend = ((process.env.KAIROS_STT ?? 'apple').toLowerCase() as SttBackend)
let whisperClient: WhisperAdapter | null = null
if (sttBackend === 'groq' || sttBackend === 'openrouter') {
  whisperClient = whisperFromEnv(sttBackend)
  if (!whisperClient) {
    const keyName = sttBackend === 'groq' ? 'GROQ_API_KEY' : 'OPENROUTER_API_KEY'
    console.error(`✗ KAIROS_STT=${sttBackend} but ${keyName} is not set. Aborting.`)
    process.exit(1)
  }
}
const cloudSttMode = sttBackend !== 'apple'

// LLM backend selection. Priority:
//   1. OpenRouter (streaming + cheapest fast model) if OPENROUTER_API_KEY set
//   2. Claude Code subscription (if installed)
//   3. Direct Anthropic SDK (if API key set)
type LLMBackend = {
  kind: 'openrouter' | 'claude-code' | 'api-key'
  model: string
  complete: (b: any) => Promise<any>
  stream?: (b: any) => AsyncGenerator<{ kind: 'delta'; text: string } | { kind: 'done'; text: string } | { kind: 'error'; message: string }, void, unknown>
}

async function selectLLMBackend(): Promise<LLMBackend> {
  // Tier 1: OpenRouter (preferred for speed)
  if (process.env.OPENROUTER_API_KEY && !process.env.KAIROS_FORCE_CLAUDE) {
    const model = process.env.KAIROS_MODEL ?? 'openai/gpt-4o-mini'
    console.log(`       ✓ model: ${model} (via OpenRouter)`)
    const adapter = new OpenRouterAdapter({ defaultModel: model })
    return {
      kind: 'openrouter', model,
      complete: (b) => adapter.complete(b),
      stream: (b) => adapter.stream(b),
    }
  }
  // Tier 2: Claude Code subscription
  const claudeAvailable = await (async () => {
    try {
      const proc = spawn({ cmd: ['claude', '--version'], stdout: 'pipe', stderr: 'pipe' })
      const code = await proc.exited
      return code === 0
    } catch { return false }
  })()
  if (claudeAvailable && !process.env.KAIROS_FORCE_API_KEY) {
    const model = (process.env.KAIROS_MODEL ?? 'haiku') as 'haiku' | 'sonnet' | 'opus'
    console.log(`       ✓ model: ${model} (via Claude Code)`)
    const adapter = new ClaudeCodeAdapter({ defaultModel: model })
    return { kind: 'claude-code', model, complete: (b) => adapter.complete(b) }
  }
  // Tier 3: direct Anthropic API
  const apiKey = process.env.KAIROS_ANTHROPIC_KEY ?? process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    console.error('✗ no LLM backend available. Set OPENROUTER_API_KEY (recommended) or install Claude Code.')
    process.exit(1)
  }
  const adapter = new LLMAdapter({ apiKey, defaultModel: 'claude-haiku-4-5' })
  return { kind: 'api-key', model: 'claude-haiku-4-5', complete: (b) => adapter.complete(b) }
}

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
const llmBackend = await selectLLMBackend()
console.log(`       ✓ LLM backend: ${llmBackend.kind}`)
const voice = new VoiceAdapter({ llm: { complete: llmBackend.complete }, store: conversationStore })
const supportsStreaming = !!llmBackend.stream

// Pinned port lets the Electron UI find us without an out-of-band port file.
// Override with KAIROS_DAEMON_PORT if 9876 is taken.
const daemonPort = Number(process.env.KAIROS_DAEMON_PORT ?? 9876)
const api = await startWrapApi({
  port: daemonPort, hostname: '127.0.0.1',
  adapters: {
    llm: { complete: llmBackend.complete },
    voice: { chat: (b) => voice.chat(b), cancel: async () => voice.cancel() },
    memory: { append: async () => ({}), get: async () => ({}) },
    orders: { add: async () => ({ slug: 'stub' }), list: async () => [] },
    composio: { listConnections: async () => [], connect: async () => ({}), disconnect: async () => ({}) },
    settings: { get: async () => ({}), update: async () => ({ updated: [] }) },
  },
})
console.log(`       ✓ wrap-API at ${api.baseUrl}`)
console.log(`       ✓ Voice events WebSocket: ws://127.0.0.1:${daemonPort}/v1/voice/events`)

console.log(`       ✓ STT backend: ${sttBackend}${whisperClient ? ` (cloud Whisper)` : ' (Apple on-device)'}`)

console.log('[2/4] Spawning Swift KairosVoiceHelper sidecar...')
console.log(`       binary: ${helperBinary}`)
const sidecar = new SidecarClient({
  helperBinary,
  // KAIROS_STT_MODE=cloud disables SFSpeechRecognizer in the helper and
  // enables BufferRecorder, which emits {"event":"audio_blob"} on stop.
  env: cloudSttMode ? { KAIROS_STT_MODE: 'cloud' } : undefined,
})

console.log('[3/4] Connecting to UDS + booting voice conductor...')
const sayBackend = new SayBackend({
  defaultVoice: process.env.KAIROS_VOICE_NAME ?? 'Ava',
  defaultRate: Number(process.env.KAIROS_VOICE_RATE ?? 180),
})

let lastAgentText = ''
let tUserEnd = 0
let tLlmStart = 0
let tLlmEnd = 0
let tSpeakStart = 0
// Streaming pipeline: hijack the wrap-API request and stream LLM → TTS directly.
// Bypasses the standard request-response flow when streaming is available.
const streamingSayBackend = new SayBackend({
  defaultVoice: process.env.KAIROS_VOICE_NAME ?? 'Zoe (Premium)',
  defaultRate: Number(process.env.KAIROS_VOICE_RATE ?? 180),
})
let activeStream: { speaker: StreamingSpeaker; abort: AbortController } | null = null

async function handleUserSpeechStreaming(transcript: string, conversationId: string): Promise<void> {
  if (!llmBackend.stream) return
  // Cancel any in-flight stream (barge-in)
  if (activeStream) {
    activeStream.speaker.cancel()
    activeStream.abort.abort()
  }
  const speaker = new StreamingSpeaker({
    backend: streamingSayBackend,
    voice: process.env.KAIROS_VOICE_NAME ?? 'Zoe (Premium)',
    rate: Number(process.env.KAIROS_VOICE_RATE ?? 180),
  })
  const abort = new AbortController()
  activeStream = { speaker, abort }

  const history = await conversationStore.recentTurns(conversationId, 10)
  const messages = [
    ...history.map(t => ({ role: t.role === 'agent' ? ('assistant' as const) : ('user' as const), content: t.text })),
    { role: 'user' as const, content: transcript },
  ]
  await conversationStore.appendTurn(conversationId, { role: 'user', text: transcript, at: Date.now() })

  const system = 'You are KAIROS, a proactive AI co-worker. Respond conversationally, as if speaking. Keep responses brief (1-2 sentences typical). Plain spoken English only — no markdown.'

  const tTurnStart = Date.now()
  let tFirstToken = 0
  let collected = ''
  console.log(`  🔊 KAIROS: `)
  for await (const ev of llmBackend.stream({ messages, system, signal: abort.signal })) {
    if (ev.kind === 'error') {
      console.error(`  ✗ LLM error: ${ev.message}`)
      api.broadcast({ event: 'agent_error', message: ev.message })
      activeStream = null
      return
    }
    if (ev.kind === 'delta') {
      if (!tFirstToken) tFirstToken = Date.now()
      collected += ev.text
      process.stdout.write(ev.text)
      speaker.feed(ev.text)
      api.broadcast({ event: 'agent_delta', text: ev.text })
    } else if (ev.kind === 'done') {
      if (ev.text) collected = ev.text
      break
    }
  }
  console.log()
  await speaker.end()
  api.broadcast({ event: 'agent_done', text: collected })
  await conversationStore.appendTurn(conversationId, { role: 'agent', text: collected, at: Date.now() })
  const tFinish = Date.now()
  console.log(`     [first token: ${tFirstToken - tTurnStart}ms · total to-speak-done: ${tFinish - tTurnStart}ms]`)
  if (activeStream?.abort === abort) activeStream = null
}

const conductor = new VoiceConductor({
  sidecar: sidecar as any,
  store: conversationStore,
  bus: {
    publish: (kind, payload) => {
      if (kind === 'voice.user.utterance') {
        tUserEnd = Date.now()
        tLlmStart = Date.now()
        console.log(`\n  🎙  YOU: "${payload.text}"`)
        api.broadcast({ event: 'stt_final', text: payload.text })
        if (supportsStreaming) {
          void handleUserSpeechStreaming(payload.text, payload.conversationId)
        }
      } else if (kind === 'voice.agent.utterance') {
        tLlmEnd = Date.now()
        tSpeakStart = Date.now()
        lastAgentText = payload.text
        const llmMs = tLlmEnd - tLlmStart
        console.log(`  🔊 KAIROS: "${payload.text}"  [LLM: ${llmMs}ms]`)
        if (!supportsStreaming) api.broadcast({ event: 'agent_done', text: payload.text })
      } else if (kind === 'voice.hotkey.down') {
        process.stdout.write('  ● listening...')
        api.broadcast({ event: 'listening_started' })
      } else if (kind === 'voice.hotkey.up') {
        process.stdout.write(' ✓\n')
        api.broadcast({ event: 'listening_stopped' })
      } else if (kind === 'voice.agent.utterance.interrupted') {
        console.log(`  ⏸  (interrupted)`)
        api.broadcast({ event: 'agent_interrupted' })
      } else if (kind === 'voice.error') {
        console.log(`  ✗ error: ${payload.error}`)
        api.broadcast({ event: 'error', message: payload.error })
      } else if (kind === 'voice.sidecar.error') {
        console.log(`  ⚠  sidecar: ${payload.code}${payload.message ? ' — ' + payload.message : ''}`)
        api.broadcast({ event: 'sidecar_error', code: payload.code, message: payload.message })
      } else if (kind === 'voice.stt.partial') {
        process.stdout.write(`\r  …${payload.text}                             `)
        api.broadcast({ event: 'stt_partial', text: payload.text })
      }
    },
  },
  wrapApiBaseUrl: api.baseUrl,
  speakBackend: sayBackend,
  externalLLMHandling: supportsStreaming,
})

try {
  // conductor.start() calls sidecar.start() internally — don't double-spawn
  await conductor.start()
  console.log('       ✓ sidecar connected, conductor running')

  // Cloud STT path: when helper is in KAIROS_STT_MODE=cloud, it emits
  // {"event":"audio_blob"} on stopListening with a base64 WAV. We POST that
  // to the configured Whisper API and pump the resulting transcript through
  // the same handleUserSpeechStreaming() that the Apple-STT path uses.
  const cloudConversationId = `voice-${Date.now().toString(36)}`
  if (cloudSttMode && whisperClient) {
    sidecar.onEvent(async (e: any) => {
      if (e.event !== 'audio_blob') return
      const wavBase64 = String(e.wavBase64 ?? '')
      if (!wavBase64) {
        api.broadcast({ event: 'error', message: 'empty audio blob' })
        return
      }
      api.broadcast({ event: 'transcribing' })
      const t0 = Date.now()
      try {
        const wavBytes = Uint8Array.from(atob(wavBase64), (c) => c.charCodeAt(0))
        const result = await whisperClient!.transcribe(wavBytes)
        const elapsed = Date.now() - t0
        const text = result.text.trim()
        if (!text) {
          api.broadcast({ event: 'stt_final', text: '' })
          return
        }
        console.log(`\n  🎙  YOU [${sttBackend} ${elapsed}ms]: "${text}"`)
        api.broadcast({ event: 'stt_final', text })
        if (supportsStreaming) {
          void handleUserSpeechStreaming(text, cloudConversationId)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`  ✗ STT error: ${msg}`)
        api.broadcast({ event: 'error', message: `STT: ${msg}` })
      }
    })
  }

  // WS command handler: lets the Electron UI drive listening + interruption.
  api.onCommand((cmd) => {
    if (!cmd || typeof cmd !== 'object') return
    switch (cmd.cmd) {
      case 'start_listening':
        void sidecar.send({ cmd: 'start_listening', mode: 'push_to_talk' } as any)
        break
      case 'stop_listening':
        void sidecar.send({ cmd: 'stop_listening' } as any)
        break
      case 'cancel_speak':
        void sidecar.send({ cmd: 'stop_speaking' } as any)
        if (activeStream) {
          activeStream.speaker.cancel()
          activeStream.abort.abort()
          activeStream = null
        }
        break
    }
  })
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
