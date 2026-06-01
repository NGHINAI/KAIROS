// src/daemon/voice/bootstrap.ts
// Reusable voice subsystem bootstrap. Pulled out of scripts/voice-live.ts so
// the main daemon (src/daemon/index.ts) can wire voice in the same way.

import { Database } from "bun:sqlite"
import { ConversationStore } from "./conversationStore"
import { VoiceConductor } from "./voiceConductor"
import { SidecarClient } from "./sidecarClient"
import { NullSidecar } from "./nullSidecar"
import { SayBackend, type SpeakOptions } from "./sayBackend"
import { sttFromEnv } from "./stt"
import { ttsFromEnv, StreamingTtsBackend } from "./tts"
import { WsAudioSink } from "./tts/wsAudioSink"

/** Minimal speak/stop contract shared by SayBackend and StreamingTtsBackend. */
export interface SpeakBackend {
  speak(text: string, opts?: SpeakOptions): Promise<void>
  stop(): void
}

export interface BootstrapVoiceOpts {
  db: Database
  helperBinary: string
  dryRun?: boolean             // skip actual sidecar spawn (for tests)
  llm: { complete: (body: any) => Promise<any> }
  defaultVoice?: string
  defaultRate?: number
  /**
   * Broadcast fn for canonical-PCM streaming to WS clients. When provided AND
   * KAIROS_TTS selects a streaming provider (deepgram/openai), TTS audio is
   * streamed to the renderer (Web Audio) instead of played via macOS `say`.
   * index.ts passes wrapApi.broadcast here.
   */
  broadcast?: (event: Record<string, unknown>) => void
  /** Override env (tests). */
  env?: Record<string, string | undefined>
}

export interface VoiceBundle {
  conductor: VoiceConductor
  /** SidecarClient (Swift) or NullSidecar (renderer-mic mode). */
  sidecar: SidecarClient | NullSidecar
  /** The active speak backend — StreamingTtsBackend (canonical) or SayBackend (Apple). */
  sayBackend: SpeakBackend
  /** True when a cloud streaming TTS provider is active (vs. Apple `say`). */
  streamingTts: boolean
  /** True when the Electron renderer owns mic+VAD (Swift sidecar not spawned). */
  rendererMic: boolean
  /** Cloud Whisper transcriber, when KAIROS_STT is groq/openrouter. Used by
   *  index.ts to transcribe utterance audio arriving over the WS. */
  whisper?: { transcribe: (b: Uint8Array) => Promise<{ text: string }> }
  conversationStore: ConversationStore
}

export async function bootstrapVoice(opts: BootstrapVoiceOpts): Promise<VoiceBundle> {
  const env = opts.env ?? process.env
  const conversationStore = new ConversationStore(opts.db)

  // TTS selection (canonical, provider-agnostic): KAIROS_TTS picks the provider;
  // a streaming provider needs a broadcast sink to reach the renderer. If either
  // is missing we fall back to macOS `say` so voice always works.
  const appleBackend = new SayBackend({
    defaultVoice: opts.defaultVoice ?? "Zoe (Premium)",
    defaultRate: opts.defaultRate ?? 180,
  })

  let sayBackend: SpeakBackend = appleBackend
  let streamingTts = false
  try {
    const provider = ttsFromEnv(env)
    if (provider && opts.broadcast) {
      const sink = new WsAudioSink({ broadcast: opts.broadcast })
      sayBackend = new StreamingTtsBackend(provider, sink, {
        voice: env.KAIROS_TTS_VOICE,
        instructions: env.KAIROS_TTS_INSTRUCTIONS,
      })
      streamingTts = true
      console.log(`[voice] TTS: ${provider.name} (canonical PCM → renderer Web Audio)`)
    } else if (provider && !opts.broadcast) {
      console.warn(`[voice] KAIROS_TTS=${provider.name} set but no broadcast sink — falling back to Apple \`say\``)
    } else {
      console.log(`[voice] TTS: apple (\`say\`) — set KAIROS_TTS=deepgram|openai for cloud voice`)
    }
  } catch (e) {
    console.error(`[voice] TTS init failed (${(e as Error).message}) — falling back to Apple \`say\``)
  }

  const sttProvider = (env.KAIROS_STT ?? "").toLowerCase()

  // Canonical STT: sttFromEnv() returns a SttBackend for any cloud provider
  // (groq/openrouter/openai/deepgram), or null for apple/on-device. Swapping
  // provider is one env var, no code change — the input-side mirror of ttsFromEnv.
  const sttBackend = sttFromEnv(env)
  const cloudStt = sttBackend != null

  // Mic ownership: KAIROS_MIC=renderer → Electron owns mic+VAD (NullSidecar, no
  // Swift spawn). Default "sidecar" keeps the Swift helper. Renderer mode REQUIRES
  // a cloud STT backend (the renderer ships WAV over the WS; no Apple SFSpeech path).
  const rendererMic = (env.KAIROS_MIC ?? "sidecar").toLowerCase() === "renderer"
  if (rendererMic && !cloudStt) {
    throw new Error(`[voice] KAIROS_MIC=renderer requires a cloud KAIROS_STT (groq|openrouter|openai|deepgram), got "${sttProvider || "unset"}"`)
  }

  const sidecar: SidecarClient | NullSidecar = rendererMic
    ? new NullSidecar()
    : new SidecarClient({
        helperBinary: opts.helperBinary,
        env: cloudStt ? { KAIROS_STT_MODE: "cloud" } : undefined,
      })

  // Back-compat bridge: VoiceConductor + index.ts call `whisper.transcribe(bytes)`
  // and expect `{ text }`. Wrap the canonical SttBackend (which takes SttAudio +
  // returns SttResult) so existing call sites don't change. The renderer/sidecar
  // both produce a self-describing 16kHz mono WAV, so we tag format:'wav'.
  let whisper: { transcribe: (b: Uint8Array) => Promise<{ text: string }> } | undefined
  if (sttBackend) {
    whisper = {
      transcribe: async (b: Uint8Array) => {
        const r = await sttBackend.transcribe({ data: b, format: "wav" })
        return { text: r.text }
      },
    }
    console.log(`[voice] cloud STT: ${sttBackend.name} (canonical SttBackend)`)
  } else {
    console.log(`[voice] on-device STT: apple (sidecar SFSpeechRecognizer)`)
  }
  console.log(`[voice] mic owner: ${rendererMic ? "electron renderer (Swift sidecar NOT spawned)" : "swift sidecar"}`)

  // Conductor needs an event bus; we accept a stub here. The full wiring
  // happens in index.ts (broadcast to /v1/voice/events WS).
  const conductor = new VoiceConductor({
    sidecar: sidecar as any,
    store: conversationStore,
    bus: { publish: () => {} },          // overridden by caller
    wrapApiBaseUrl: "http://127.0.0.1:0", // overridden by caller
    speakBackend: sayBackend,
    externalLLMHandling: true,           // we want full agentic handling
    whisper,
  })

  // Only actually start the sidecar process if not dry-run
  if (!opts.dryRun) {
    await conductor.start()
  }

  return { conductor, sidecar, sayBackend, streamingTts, rendererMic, whisper, conversationStore }
}
