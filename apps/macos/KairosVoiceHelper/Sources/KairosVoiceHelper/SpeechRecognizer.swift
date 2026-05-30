// SpeechRecognizer.swift — Apple Speech.framework wrapper.
//
// On macOS 15 (Sequoia): SFSpeechRecognizer with on-device recognition.
// On macOS 26+ (Tahoe): swap to SpeechAnalyzer for 2.2x speed boost.
//
// Streams partial transcripts as they arrive, then emits a final on end-of-utterance.

import Foundation
import Speech
import AVFoundation

final class SpeechRecognizer {
    private let bus: ProtocolBus
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var isListening = false

    init(bus: ProtocolBus) {
        self.bus = bus
        recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
        recognizer?.supportsOnDeviceRecognition = true
        SFSpeechRecognizer.requestAuthorization { _ in /* result surfaces via system UI */ }
    }

    func startListening() {
        guard !isListening, let recognizer = recognizer, recognizer.isAvailable else {
            bus.emit(["event": "error", "code": "stt_unavailable"])
            return
        }
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        req.requiresOnDeviceRecognition = true
        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            if let r = result {
                let text = r.bestTranscription.formattedString
                let confidence = Double(r.bestTranscription.segments.last?.confidence ?? 0.5)
                if r.isFinal {
                    self?.bus.emit(["event": "stt_final", "text": text, "confidence": confidence])
                } else {
                    self?.bus.emit(["event": "stt_partial", "text": text, "confidence": confidence])
                }
            }
            if let error = error {
                self?.bus.emit(["event": "error", "code": "stt_failed", "message": "\(error.localizedDescription)"])
            }
        }
        request = req
        isListening = true
    }

    func stopListening() {
        guard isListening else { return }
        request?.endAudio()
        task?.finish()
        task = nil
        request = nil
        isListening = false
    }

    func feed(buffer: AVAudioPCMBuffer, time: AVAudioTime) {
        guard isListening, let request = request else { return }
        request.append(buffer)
    }
}
