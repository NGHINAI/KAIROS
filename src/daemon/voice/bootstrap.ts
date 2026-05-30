// src/daemon/voice/bootstrap.ts
// Reusable voice subsystem bootstrap. Pulled out of scripts/voice-live.ts so
// the main daemon (src/daemon/index.ts) can wire voice in the same way.

import { Database } from "bun:sqlite"
import { ConversationStore } from "./conversationStore"
import { VoiceConductor } from "./voiceConductor"
import { SidecarClient } from "./sidecarClient"
import { SayBackend } from "./sayBackend"

export interface BootstrapVoiceOpts {
  db: Database
  helperBinary: string
  dryRun?: boolean             // skip actual sidecar spawn (for tests)
  llm: { complete: (body: any) => Promise<any> }
  defaultVoice?: string
  defaultRate?: number
}

export interface VoiceBundle {
  conductor: VoiceConductor
  sidecar: SidecarClient
  sayBackend: SayBackend
  conversationStore: ConversationStore
}

export async function bootstrapVoice(opts: BootstrapVoiceOpts): Promise<VoiceBundle> {
  const conversationStore = new ConversationStore(opts.db)
  const sayBackend = new SayBackend({
    defaultVoice: opts.defaultVoice ?? "Zoe (Premium)",
    defaultRate: opts.defaultRate ?? 180,
  })

  const sidecar = new SidecarClient({
    helperBinary: opts.helperBinary,
    env: process.env.KAIROS_STT === "groq" || process.env.KAIROS_STT === "openrouter"
      ? { KAIROS_STT_MODE: "cloud" }
      : undefined,
  })

  // Conductor needs an event bus; we accept a stub here. The full wiring
  // happens in index.ts (broadcast to /v1/voice/events WS).
  const conductor = new VoiceConductor({
    sidecar: sidecar as any,
    store: conversationStore,
    bus: { publish: () => {} },          // overridden by caller
    wrapApiBaseUrl: "http://127.0.0.1:0", // overridden by caller
    speakBackend: sayBackend,
    externalLLMHandling: true,           // we want full agentic handling
  })

  // Only actually start the sidecar process if not dry-run
  if (!opts.dryRun) {
    await conductor.start()
  }

  return { conductor, sidecar, sayBackend, conversationStore }
}
