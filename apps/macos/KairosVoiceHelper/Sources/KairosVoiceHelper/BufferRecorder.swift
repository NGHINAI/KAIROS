// BufferRecorder.swift — alternative to SpeechRecognizer for cloud STT.
//
// In Apple-STT mode, AudioEngine feeds the mic into SFSpeechAudioBufferRecognitionRequest.
// In cloud-STT mode (KAIROS_STT_MODE=cloud), we route the same mic frames into
// this recorder instead, which downsamples to 16kHz mono Int16, wraps the result
// in a RIFF/WAVE header on stop, and emits {"event":"audio_blob","wavBase64":"..."}.
// Bun then POSTs that blob to whichever Whisper-compatible API the daemon picks
// (Groq or OpenRouter).

import Foundation
import AVFoundation

final class BufferRecorder {
    private let bus: ProtocolBus
    private var samples: [Int16] = []
    private var isRecording = false
    private var phase: Double = 0  // decimation accumulator
    private let targetRate: Double = 16_000
    private let utteranceId = "rec_\(UUID().uuidString.prefix(8))"

    init(bus: ProtocolBus) {
        self.bus = bus
        NSLog("KAIROS recorder: init (cloud STT mode)")
    }

    func startListening() {
        guard !isRecording else { return }
        samples.removeAll(keepingCapacity: true)
        phase = 0
        isRecording = true
        NSLog("KAIROS recorder: recording started")
    }

    func stopListening() {
        guard isRecording else { return }
        isRecording = false
        NSLog("KAIROS recorder: recording stopped (samples=\(samples.count))")

        if samples.isEmpty {
            bus.emit(["event": "audio_blob", "wavBase64": "", "samples": 0])
            return
        }
        let wav = makeWavData(samples: samples, sampleRate: UInt32(targetRate))
        let b64 = wav.base64EncodedString()
        bus.emit([
            "event": "audio_blob",
            "wavBase64": b64,
            "samples": samples.count,
            "durationMs": Int(Double(samples.count) / targetRate * 1000),
        ])
        samples.removeAll(keepingCapacity: false)
    }

    func feed(buffer: AVAudioPCMBuffer, time: AVAudioTime) {
        guard isRecording, let ch = buffer.floatChannelData?[0] else { return }
        let n = Int(buffer.frameLength)
        let nativeRate = buffer.format.sampleRate
        let ratio = nativeRate / targetRate     // e.g. 48000 / 16000 = 3.0

        // Naive decimation — good enough for speech; Whisper is robust to it.
        // (Anti-aliasing would mean a proper low-pass filter; if accuracy
        // suffers we can swap this for AVAudioConverter later.)
        for i in 0..<n {
            phase += 1.0
            if phase >= ratio {
                phase -= ratio
                let v = max(-1.0, min(1.0, ch[i]))
                let s: Int16 = v < 0 ? Int16(Float(v) * 32768.0) : Int16(Float(v) * 32767.0)
                samples.append(s)
            }
        }
    }

    // ── WAV encoder ───────────────────────────────────────────────────────

    private func makeWavData(samples: [Int16], sampleRate: UInt32) -> Data {
        let bytesPerSample: UInt16 = 2
        let channels: UInt16 = 1
        let byteRate: UInt32 = sampleRate * UInt32(channels) * UInt32(bytesPerSample)
        let blockAlign: UInt16 = channels * bytesPerSample
        let dataSize: UInt32 = UInt32(samples.count * Int(bytesPerSample))
        let riffSize: UInt32 = 36 + dataSize

        var data = Data()
        data.append(contentsOf: Array("RIFF".utf8))
        data.appendLE(riffSize)
        data.append(contentsOf: Array("WAVE".utf8))

        data.append(contentsOf: Array("fmt ".utf8))
        data.appendLE(UInt32(16))            // PCM fmt chunk size
        data.appendLE(UInt16(1))             // PCM format
        data.appendLE(channels)
        data.appendLE(sampleRate)
        data.appendLE(byteRate)
        data.appendLE(blockAlign)
        data.appendLE(UInt16(16))            // bits per sample

        data.append(contentsOf: Array("data".utf8))
        data.appendLE(dataSize)
        samples.withUnsafeBufferPointer { ptr in
            data.append(Data(buffer: ptr))
        }
        return data
    }
}

private extension Data {
    mutating func appendLE(_ v: UInt16) {
        var le = v.littleEndian
        Swift.withUnsafeBytes(of: &le) { self.append(contentsOf: $0) }
    }
    mutating func appendLE(_ v: UInt32) {
        var le = v.littleEndian
        Swift.withUnsafeBytes(of: &le) { self.append(contentsOf: $0) }
    }
}
