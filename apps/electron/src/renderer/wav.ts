// wav.ts — encode 16kHz mono Float32 PCM (as emitted by Silero VAD's onSpeechEnd)
// into a WAV blob the daemon's Whisper adapter accepts. Mirrors the byte layout
// of the Swift BufferRecorder.makeWavData so the daemon path is unchanged.

const SAMPLE_RATE = 16_000

/** Float32 [-1,1] @16kHz mono → base64 WAV (s16le). */
export function float32ToWavBase64(samples: Float32Array): string {
  const bytes = encodeWav(samples, SAMPLE_RATE)
  // Uint8Array → base64, chunked to avoid call-stack overflow on big buffers.
  let binary = ""
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const numSamples = samples.length
  const dataSize = numSamples * 2 // 16-bit
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
  }

  writeStr(0, "RIFF")
  view.setUint32(4, 36 + dataSize, true)
  writeStr(8, "WAVE")
  writeStr(12, "fmt ")
  view.setUint32(16, 16, true)        // PCM fmt chunk size
  view.setUint16(20, 1, true)         // audio format = PCM
  view.setUint16(22, 1, true)         // channels = mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true)         // block align
  view.setUint16(34, 16, true)        // bits per sample
  writeStr(36, "data")
  view.setUint32(40, dataSize, true)

  let offset = 44
  for (let i = 0; i < numSamples; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, v < 0 ? v * 0x8000 : v * 0x7fff, true)
    offset += 2
  }
  return new Uint8Array(buffer)
}
