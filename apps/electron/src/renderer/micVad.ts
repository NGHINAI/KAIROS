// micVad.ts — renderer-owned microphone with TWO independent jobs on one stream:
//
//   1. PUSH-TO-TALK CAPTURE (key-based, deterministic): we tap the mic stream and
//      buffer raw 16kHz mono Float32. startCapture() begins buffering on Option-down;
//      stopCapture() returns exactly the audio recorded until Option-up. The Option
//      key — NOT the VAD — defines the utterance boundaries. This fixes the bugs
//      where short clips got dropped (VAD's redemption-silence timer racing the key)
//      and where speech sent with no key press (a stale VAD-driven send latch).
//
//   2. BARGE-IN (VAD-based): Silero VAD runs continuously and fires onSpeechStart
//      so we can interrupt KAIROS's playback when the user talks over it. VAD is
//      used ONLY for this now, not for deciding what to send.
//
// (E.4 "continuous call" mode will reintroduce VAD/turn-detector segmentation —
//  that's the mode where there's no key to mark boundaries.)
//
// Assets (worklet + onnx + wasm) are bundled under /vad/ (see public/vad), so it
// works fully offline and inside the packaged .dmg — no CDN fetch.

import { MicVAD } from "@ricky0123/vad-web"
// Import the SAME subpath vad-web imports ("onnxruntime-web/wasm"), so this is the
// exact module instance vad uses — otherwise ort.env config would apply to a
// different copy and have no effect. Single onnxruntime-web@1.17.3 is enforced via
// package.json overrides (no nested 1.26 copy that would dynamic-import a .mjs).
import * as ort from "onnxruntime-web/wasm"

ort.env.wasm.wasmPaths = "/vad/"
ort.env.wasm.numThreads = 1

export interface MicVadCallbacks {
  /** User started speaking (VAD) — used for barge-in only. */
  onSpeechStart: () => void
  /** Per-frame speech probability (0..1) — for a live UI meter / diagnostics. */
  onFrame?: (pSpeech: number) => void
}

const VAD_ASSET_BASE = "/vad/"
const CAPTURE_RATE = 16_000

export class MicVad {
  private vad: MicVAD | null = null
  private started = false

  // Raw-capture graph (separate from vad-web's internal worklet).
  private audioCtx: AudioContext | null = null
  private sourceNode: MediaStreamAudioSourceNode | null = null
  private processor: ScriptProcessorNode | null = null
  private stream: MediaStream | null = null
  private capturing = false
  private captureChunks: Float32Array[] = []
  private captureSrcRate = 48_000

  constructor(private cb: MicVadCallbacks) {}

  /** Load the model + open the mic + build the raw-capture graph. Idempotent. */
  async start(): Promise<void> {
    if (this.started) return

    let stream: MediaStream
    try {
      // Explicit constraints enable Chromium's DSP. echoCancellation is critical:
      // while KAIROS speaks, the mic hears its own TTS — AEC subtracts that so
      // barge-in and capture hear (mostly) just the user.
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        video: false,
      })
    } catch (e) {
      throw new Error(`microphone access failed: ${(e as Error).name}: ${(e as Error).message}`)
    }
    this.stream = stream
    const tracks = stream.getAudioTracks()
    if (tracks.length === 0) throw new Error("microphone returned no audio tracks")
    const settings = (tracks[0].getSettings?.() ?? {}) as MediaTrackSettings & { echoCancellation?: boolean }
    console.log(`[vad] getUserMedia ok — device="${tracks[0].label}" echoCancellation=${settings.echoCancellation}`)

    // ── Raw PTT capture graph: source → ScriptProcessor (buffers frames) ──
    this.audioCtx = new AudioContext()
    this.captureSrcRate = this.audioCtx.sampleRate // typically 48000 on macOS
    this.sourceNode = this.audioCtx.createMediaStreamSource(stream)
    // ScriptProcessor is deprecated but universally available and dead-simple for
    // pulling raw frames; 4096-sample buffer ≈ 85ms at 48kHz.
    this.processor = this.audioCtx.createScriptProcessor(4096, 1, 1)
    this.processor.onaudioprocess = (ev) => {
      if (!this.capturing) return
      // Copy — the event buffer is reused by the engine after this callback.
      this.captureChunks.push(new Float32Array(ev.inputBuffer.getChannelData(0)))
    }
    this.sourceNode.connect(this.processor)
    // ScriptProcessor only runs if connected to a destination; route to a muted
    // gain so it ticks without making sound.
    const sink = this.audioCtx.createGain()
    sink.gain.value = 0
    this.processor.connect(sink)
    sink.connect(this.audioCtx.destination)

    // ── VAD (barge-in only): give it the SAME stream so it doesn't open a 2nd mic ──
    let frameCount = 0
    this.vad = await MicVAD.new({
      model: "v5",
      getStream: async () => stream,
      baseAssetPath: VAD_ASSET_BASE,
      onnxWASMBasePath: VAD_ASSET_BASE,
      positiveSpeechThreshold: 0.5,
      negativeSpeechThreshold: 0.35,
      redemptionFrames: 8,
      minSpeechFrames: 4,
      onFrameProcessed: (probs: { isSpeech: number }) => {
        const p = typeof probs?.isSpeech === "number" ? probs.isSpeech : 0
        this.cb.onFrame?.(p)
        if (frameCount++ % 30 === 0) console.log(`[vad] frame ${frameCount} p(speech)=${p.toFixed(2)}`)
      },
      onSpeechStart: () => this.cb.onSpeechStart(),
      // onSpeechEnd intentionally unused for sending — capture is key-driven now.
      onSpeechEnd: () => {},
    } as any)
    await this.vad.start()
    this.started = true
    console.log("[vad] MicVAD started (barge-in) + raw capture ready")
  }

  /** Begin buffering raw mic audio (Option-down). */
  startCapture(): void {
    this.captureChunks = []
    this.capturing = true
  }

  /** Stop buffering (Option-up) and return the captured audio as 16kHz mono
   *  Float32, ready for float32ToWavBase64(). Empty array if nothing/too short. */
  stopCapture(): Float32Array {
    this.capturing = false
    const chunks = this.captureChunks
    this.captureChunks = []
    if (chunks.length === 0) return new Float32Array(0)
    // Concatenate, then downsample srcRate → 16kHz by naive decimation (matches
    // what the daemon/Whisper expect; speech is robust to it).
    let total = 0
    for (const c of chunks) total += c.length
    const merged = new Float32Array(total)
    let off = 0
    for (const c of chunks) { merged.set(c, off); off += c.length }
    return downsample(merged, this.captureSrcRate, CAPTURE_RATE)
  }

  get isCapturing(): boolean { return this.capturing }

  async destroy(): Promise<void> {
    this.capturing = false
    try { await this.vad?.destroy() } catch { /* noop */ }
    try { this.processor?.disconnect() } catch { /* noop */ }
    try { this.sourceNode?.disconnect() } catch { /* noop */ }
    try { await this.audioCtx?.close() } catch { /* noop */ }
    try { this.stream?.getTracks().forEach(t => t.stop()) } catch { /* noop */ }
    this.vad = null; this.processor = null; this.sourceNode = null; this.audioCtx = null; this.stream = null
    this.started = false
  }

  get isRunning(): boolean { return this.started }
}

/** Naive decimation downsample. Good enough for speech STT. */
function downsample(input: Float32Array, srcRate: number, dstRate: number): Float32Array {
  if (srcRate === dstRate) return input
  const ratio = srcRate / dstRate
  const outLen = Math.floor(input.length / ratio)
  const out = new Float32Array(outLen)
  let pos = 0
  for (let i = 0; i < outLen; i++) {
    out[i] = input[Math.floor(pos)]
    pos += ratio
  }
  return out
}
