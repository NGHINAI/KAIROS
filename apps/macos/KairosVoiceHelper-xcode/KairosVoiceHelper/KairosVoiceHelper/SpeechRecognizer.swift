// SpeechRecognizer.swift — Apple Speech.framework wrapper.

import Foundation
import Speech
import AVFoundation

final class SpeechRecognizer {
    private let bus: ProtocolBus
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var isListening = false
    private var authStatus: SFSpeechRecognizerAuthorizationStatus = .notDetermined

    init(bus: ProtocolBus) {
        self.bus = bus
        recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
        NSLog("KAIROS stt: recognizer init — available=\(recognizer?.isAvailable ?? false) supportsOnDevice=\(recognizer?.supportsOnDeviceRecognition ?? false)")
        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            self?.authStatus = status
            switch status {
            case .authorized:    NSLog("KAIROS stt: AUTHORIZED")
            case .denied:        NSLog("KAIROS stt: DENIED by user")
            case .restricted:    NSLog("KAIROS stt: RESTRICTED by policy")
            case .notDetermined: NSLog("KAIROS stt: not determined yet")
            @unknown default:    NSLog("KAIROS stt: unknown auth status")
            }
        }
    }

    func startListening() {
        NSLog("KAIROS stt: startListening called, isListening=\(isListening) authStatus=\(authStatus.rawValue)")
        guard !isListening else { return }
        guard let recognizer = recognizer else {
            NSLog("KAIROS stt: no recognizer object")
            bus.emit(["event": "error", "code": "stt_no_recognizer"])
            return
        }
        guard recognizer.isAvailable else {
            NSLog("KAIROS stt: recognizer not available")
            bus.emit(["event": "error", "code": "stt_unavailable", "message": "SFSpeechRecognizer not available"])
            return
        }
        guard authStatus == .authorized else {
            NSLog("KAIROS stt: not authorized (status=\(authStatus.rawValue))")
            bus.emit(["event": "error", "code": "stt_not_authorized",
                      "message": "Grant Speech Recognition permission in System Settings → Privacy & Security."])
            return
        }

        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        // Try on-device first if supported, else fall back to cloud. We just don't REQUIRE it.
        req.requiresOnDeviceRecognition = false
        NSLog("KAIROS stt: created request, onDevice=false (cloud fallback ok)")

        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            if let r = result {
                let text = r.bestTranscription.formattedString
                let confidence = Double(r.bestTranscription.segments.last?.confidence ?? 0.5)
                NSLog("KAIROS stt: \(r.isFinal ? "FINAL" : "partial") text=\"\(text)\" conf=\(confidence)")
                if r.isFinal {
                    self?.bus.emit(["event": "stt_final", "text": text, "confidence": confidence])
                } else {
                    self?.bus.emit(["event": "stt_partial", "text": text, "confidence": confidence])
                }
            }
            if let error = error {
                NSLog("KAIROS stt: error \(error.localizedDescription)")
                self?.bus.emit(["event": "error", "code": "stt_failed", "message": "\(error.localizedDescription)"])
            }
        }
        request = req
        isListening = true
        NSLog("KAIROS stt: listening now")
    }

    func stopListening() {
        NSLog("KAIROS stt: stopListening called, isListening=\(isListening)")
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
