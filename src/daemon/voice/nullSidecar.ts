// src/daemon/voice/nullSidecar.ts
// A no-op sidecar for KAIROS_MIC=renderer mode. When the Electron renderer owns
// mic capture + VAD, the Swift sidecar must NOT be spawned — otherwise two
// processes fight for the microphone and macOS Accessibility/TCC prompts appear.
//
// This satisfies the SidecarLike contract (onEvent/start) plus the optional
// send()/stop() the VoiceConductor probes for, but does nothing. Utterance audio
// and barge-in arrive over the WS instead (see index.ts onCommand handlers).

import type { SidecarEvent } from "./types"

export class NullSidecar {
  private handlers: Array<(e: SidecarEvent) => void> = []

  onEvent(h: (e: SidecarEvent) => void): void {
    this.handlers.push(h)
  }

  async start(): Promise<void> {
    // Emit a synthetic ready so any readiness waiters resolve immediately.
    this.emit({ event: "sidecar_ready", version: "renderer-mic" })
  }

  async stop(): Promise<void> {
    /* nothing to tear down */
  }

  /** VoiceConductor calls send() for start/stop_listening; renderer owns that. */
  async send(_cmd: unknown): Promise<void> {
    /* no-op: the renderer drives listening directly */
  }

  /** Inject an event into the conductor (used by index.ts to forward WS audio). */
  emit(e: SidecarEvent): void {
    for (const h of this.handlers) {
      try { h(e) } catch { /* swallow */ }
    }
  }
}
