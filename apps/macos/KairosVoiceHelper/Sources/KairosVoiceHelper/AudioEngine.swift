// AudioEngine.swift — minimal AVAudioEngine for mic capture only.
//
// Feeds mic buffers to:
//   - SpeechRecognizer (Apple STT)  — default
//   - BufferRecorder   (cloud STT)  — when KAIROS_STT_MODE=cloud
// Plus VAD in either case.

import AVFoundation

final class AudioEngine {
    private let engine = AVAudioEngine()
    private let bus: ProtocolBus
    private let recognizer: SpeechRecognizer?
    private let recorder: BufferRecorder?
    private let vad: SileroVAD
    private let synth: SpeechSynthesizer

    init(bus: ProtocolBus,
         recognizer: SpeechRecognizer?,
         recorder: BufferRecorder?,
         vad: SileroVAD,
         synth: SpeechSynthesizer) {
        self.bus = bus
        self.recognizer = recognizer
        self.recorder = recorder
        self.vad = vad
        self.synth = synth
    }

    func start() {
        let input = engine.inputNode
        let nativeFormat = input.outputFormat(forBus: 0)
        NSLog("KAIROS audio: input native format = \(nativeFormat)")

        var tapBufferCount = 0
        var maxAmpInWindow: Float = 0

        input.installTap(onBus: 0, bufferSize: 1024, format: nativeFormat) { [weak self] buffer, time in
            if let ch = buffer.floatChannelData?[0] {
                let n = Int(buffer.frameLength)
                var peak: Float = 0
                for i in 0..<n {
                    let v = abs(ch[i])
                    if v > peak { peak = v }
                }
                if peak > maxAmpInWindow { maxAmpInWindow = peak }
                tapBufferCount += 1
                if tapBufferCount % 30 == 0 {
                    NSLog("KAIROS audio: mic peak amplitude over last ~700ms = \(maxAmpInWindow)")
                    maxAmpInWindow = 0
                }
            }
            self?.recognizer?.feed(buffer: buffer, time: time)
            self?.recorder?.feed(buffer: buffer, time: time)
            self?.vad.feed(buffer: buffer)
        }

        do {
            engine.prepare()
            try engine.start()
        } catch {
            bus.emit([
                "event": "error",
                "code": "audio_engine_start_failed",
                "message": "\(error)"
            ])
        }
    }

    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
    }
}
