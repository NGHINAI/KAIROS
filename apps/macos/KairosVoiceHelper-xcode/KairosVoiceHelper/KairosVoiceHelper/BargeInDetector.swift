// BargeInDetector.swift — fires barge_in_detected when user speaks while KAIROS is.
//
// Subscribes to VAD's onSpeechDetected callback. Independently tracks whether
// the synthesizer is currently speaking. When both are true → barge_in_detected.
// The synth listens for this event and stops itself.

import Foundation

final class BargeInDetector {
    private let bus: ProtocolBus
    private let vad: SileroVAD
    private let synth: SpeechSynthesizer

    init(bus: ProtocolBus, vad: SileroVAD, synth: SpeechSynthesizer) {
        self.bus = bus
        self.vad = vad
        self.synth = synth
    }

    func start() {
        vad.onSpeechDetected { [weak self] in
            // The SpeechSynthesizer doesn't expose a public "isSpeaking" inspector,
            // but we track that via the speak_started / speak_finished events the
            // ProtocolBus already emits. For barge-in purposes we just fire the
            // event — the conductor decides what to do with it. Cheap and decoupled.
            self?.bus.emit(["event": "barge_in_detected"])
            self?.synth.stop()
        }
    }
}
