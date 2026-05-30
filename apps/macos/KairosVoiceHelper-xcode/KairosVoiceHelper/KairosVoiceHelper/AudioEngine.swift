// AudioEngine.swift — minimal AVAudioEngine for mic capture only.
//
// v1: just feeds mic buffers to STT + VAD. No output routing — AVSpeechSynthesizer
// handles its own playback through Apple's internal audio session.

import AVFoundation

final class AudioEngine {
    private let engine = AVAudioEngine()
    private let bus: ProtocolBus
    private let recognizer: SpeechRecognizer
    private let vad: SileroVAD
    private let synth: SpeechSynthesizer

    init(bus: ProtocolBus, recognizer: SpeechRecognizer, vad: SileroVAD, synth: SpeechSynthesizer) {
        self.bus = bus
        self.recognizer = recognizer
        self.vad = vad
        self.synth = synth
    }

    func start() {
        let input = engine.inputNode
        let nativeFormat = input.outputFormat(forBus: 0)

        // Install tap at the mic's native format. Recognizer + VAD downsample internally.
        input.installTap(onBus: 0, bufferSize: 1024, format: nativeFormat) { [weak self] buffer, time in
            self?.recognizer.feed(buffer: buffer, time: time)
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
