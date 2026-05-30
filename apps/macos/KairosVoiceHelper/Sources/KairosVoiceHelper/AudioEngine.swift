// AudioEngine.swift — AVAudioEngine graph for KAIROS voice.
//
// Pipeline:
//   inputNode (VoiceProcessingIO ON → FaceTime-grade echo cancellation)
//     │
//     ├─→ Tap (16kHz mono Float32 buffers) → SpeechRecognizer (Apple STT)
//     │                                    → SileroVAD (CoreML, ANE)
//     │
//   playerNode ← receives PCM from SpeechSynthesizer / cloud TTS
//     │
//   mainMixerNode → outputNode

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

        // Enable VoiceProcessingIO — Apple's built-in echo cancellation + noise
        // suppression (same DSP that drives FaceTime). Critical for barge-in:
        // STT and VAD will see only the user's voice, not KAIROS's own TTS.
        do {
            try input.setVoiceProcessingEnabled(true)
        } catch {
            NSLog("VoiceProcessingIO not available: \(error)")
        }

        // Install tap for STT + VAD (16kHz mono Float32, ~64ms buffer at 1024 samples)
        let format = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: 16000,
            channels: 1,
            interleaved: false
        )

        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, time in
            self?.recognizer.feed(buffer: buffer, time: time)
            self?.vad.feed(buffer: buffer)
        }

        // Wire up the player node for TTS playback
        engine.attach(synth.playerNode)
        engine.connect(synth.playerNode, to: engine.mainMixerNode, format: nil)

        // Start the engine
        do {
            engine.prepare()
            try engine.start()
        } catch {
            bus.emit(["event": "error", "code": "audio_engine_start_failed", "message": "\(error)"])
        }
    }

    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
    }
}
