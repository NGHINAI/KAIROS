// SpeechSynthesizer.swift — AVSpeechSynthesizer wrapper.
//
// Uses AVSpeechSynthesizer with downloaded premium voices ("Ava Enhanced", etc.).
// `playerNode` feeds the AudioEngine's main mixer for output.

import Foundation
import AVFoundation

final class SpeechSynthesizer: NSObject, AVSpeechSynthesizerDelegate {
    private let bus: ProtocolBus
    private let synthesizer = AVSpeechSynthesizer()
    let playerNode = AVAudioPlayerNode()
    private var currentSpeakId: String?
    private var lastFinishedNotInterrupted = false

    init(bus: ProtocolBus) {
        self.bus = bus
        super.init()
        synthesizer.delegate = self
    }

    func speak(text: String, voice: String?, rate: Double?, speakId: String) {
        let utterance = AVSpeechUtterance(string: text)
        if let voiceName = voice {
            // Match by identifier or display name
            if let v = AVSpeechSynthesisVoice.speechVoices().first(where: {
                $0.identifier == voiceName || $0.name == voiceName
            }) {
                utterance.voice = v
            }
        }
        if utterance.voice == nil {
            utterance.voice = AVSpeechSynthesisVoice(language: "en-US")
        }
        if let r = rate {
            // AVSpeechUtterance.rate is 0.0...1.0 (0.5 = default)
            utterance.rate = Float(max(0.0, min(1.0, r)))
        }
        currentSpeakId = speakId
        bus.emit(["event": "speak_started", "speak_id": speakId])
        synthesizer.speak(utterance)
    }

    func stop() {
        synthesizer.stopSpeaking(at: .immediate)
    }

    func listVoices() {
        let voices = AVSpeechSynthesisVoice.speechVoices().map { v -> [String: Any] in
            return [
                "id": v.identifier,
                "name": v.name,
                "quality": qualityString(v.quality),
                "language": v.language,
            ]
        }
        bus.emit(["event": "voices_available", "voices": voices])
    }

    private func qualityString(_ q: AVSpeechSynthesisVoiceQuality) -> String {
        switch q {
        case .enhanced: return "enhanced"
        case .premium:  return "premium"
        case .default:  return "default"
        @unknown default: return "unknown"
        }
    }

    // MARK: AVSpeechSynthesizerDelegate

    func speechSynthesizer(_ synth: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        if let id = currentSpeakId {
            bus.emit(["event": "speak_finished", "speak_id": id, "interrupted": false])
        }
        currentSpeakId = nil
    }

    func speechSynthesizer(_ synth: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        if let id = currentSpeakId {
            bus.emit(["event": "speak_interrupted", "speak_id": id])
        }
        currentSpeakId = nil
    }
}
