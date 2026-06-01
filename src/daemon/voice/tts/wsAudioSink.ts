// src/daemon/voice/tts/wsAudioSink.ts
// AudioSink that streams canonical PCM to WS clients (the Electron renderer)
// as base64-tagged JSON frames over the existing broadcast() path:
//   { event: "tts_begin", speakId, sampleRate }
//   { event: "tts_chunk", speakId, pcm: "<base64 s16le>" }
//   { event: "tts_end",   speakId }
//   { event: "tts_abort", speakId }
// The renderer decodes base64 → Int16 → Float32 and plays via Web Audio.
//
// Base64-over-JSON (vs raw binary WS frames) keeps the daemon's single
// broadcast() channel intact — no second binary socket, no framing protocol.
// At 24kHz mono s16le a phrase is a few KB/chunk; base64's 33% overhead is
// negligible next to the LLM/STT round-trips.

import type { AudioSink } from "./types"

export interface WsAudioSinkDeps {
  /** The wrapApi.broadcast(event) function. */
  broadcast: (event: Record<string, unknown>) => void
}

export class WsAudioSink implements AudioSink {
  constructor(private deps: WsAudioSinkDeps) {}

  begin(speakId: string, sampleRate: number): void {
    this.deps.broadcast({ event: "tts_begin", speakId, sampleRate })
  }

  push(speakId: string, chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return
    this.deps.broadcast({ event: "tts_chunk", speakId, pcm: toBase64(chunk) })
  }

  end(speakId: string): void {
    this.deps.broadcast({ event: "tts_end", speakId })
  }

  abort(speakId: string): void {
    this.deps.broadcast({ event: "tts_abort", speakId })
  }
}

/** Uint8Array → base64. Chunked to avoid call-stack limits on large buffers. */
function toBase64(bytes: Uint8Array): string {
  let binary = ""
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}
