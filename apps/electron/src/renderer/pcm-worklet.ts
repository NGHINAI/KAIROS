// AudioWorklet processor that downsamples mic audio to 16kHz mono Int16 PCM.
//
// Browsers give us float32 audio at the device's native rate (48kHz on macOS).
// Apple's SFSpeechRecognizer is happy with 16kHz Int16, which is ~6x smaller —
// less data to base64 + send over IPC.
//
// Loaded as a separate worklet module file at runtime (see App.tsx).

const WORKLET_SOURCE = `
class PcmDownsampler extends AudioWorkletProcessor {
  constructor() {
    super()
    this.targetRate = 16000
    this.sourceRate = sampleRate  // global in worklet scope
    this.ratio = this.sourceRate / this.targetRate
    this.acc = 0
    this.outBuf = new Int16Array(2048) // ~128ms @ 16kHz
    this.outIdx = 0
  }
  process(inputs) {
    const input = inputs[0]
    if (!input || !input[0]) return true
    const ch = input[0]
    for (let i = 0; i < ch.length; i++) {
      // Naive decimation. Good enough for speech; SFSpeechRecognizer is robust.
      this.acc += 1
      if (this.acc >= this.ratio) {
        this.acc -= this.ratio
        // Float32 [-1,1] → Int16 [-32768, 32767]
        const v = Math.max(-1, Math.min(1, ch[i]))
        this.outBuf[this.outIdx++] = v < 0 ? v * 0x8000 : v * 0x7FFF
        if (this.outIdx >= this.outBuf.length) {
          this.port.postMessage(this.outBuf.buffer.slice(0), [])
          this.outIdx = 0
        }
      }
    }
    return true
  }
}
registerProcessor('pcm-downsampler', PcmDownsampler)
`

// Returns an object-URL the AudioContext.audioWorklet.addModule() can load.
export function pcmWorkletURL(): string {
  const blob = new Blob([WORKLET_SOURCE], { type: 'application/javascript' })
  return URL.createObjectURL(blob)
}
