// KairosSpeechHelper — tiny Swift CLI for STT + TTS only.
//
// Protocol: read JSON lines from stdin, write JSON line events to stdout.
//
// Commands:
//   {"cmd":"transcribe","wavBase64":"..."}
//   {"cmd":"speak","text":"...","voice":"Zoe (Premium)","rate":0.5}
//   {"cmd":"stop_speaking"}
//
// Events:
//   {"event":"helper_ready"}
//   {"event":"stt_final","text":"..."}
//   {"event":"speak_started","speak_id":"..."}
//   {"event":"speak_finished","speak_id":"..."}
//   {"event":"error","code":"...","message":"..."}
//
// No audio engine, no hotkey, no mic capture — Electron's renderer does that.

import Foundation
import AVFoundation
import Speech

setbuf(stdout, nil)

let synth = AVSpeechSynthesizer()
let synthDelegate = SynthDelegate()
synth.delegate = synthDelegate

// Request Speech permission early
SFSpeechRecognizer.requestAuthorization { status in
    NSLog("KAIROS speech: auth status=\(status.rawValue)")
}

emit(["event": "helper_ready", "version": "0.6.0-electron"])

readLoop()
RunLoop.main.run()

// MARK: - I/O

func emit(_ payload: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: payload),
          let line = String(data: data, encoding: .utf8) else { return }
    print(line)
}

func readLoop() {
    DispatchQueue.global().async {
        let stdin = FileHandle.standardInput
        var buffer = Data()
        while true {
            let chunk = stdin.availableData
            if chunk.isEmpty { exit(0) }
            buffer.append(chunk)
            while let nl = buffer.firstIndex(of: 0x0a) {
                let line = buffer.subdata(in: 0..<nl)
                buffer.removeSubrange(0...nl)
                if line.isEmpty { continue }
                guard let json = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
                handleCommand(json)
            }
        }
    }
}

func handleCommand(_ cmd: [String: Any]) {
    guard let kind = cmd["cmd"] as? String else { return }
    switch kind {
    case "transcribe":
        if let b64 = cmd["wavBase64"] as? String { transcribe(b64) }
    case "speak":
        if let text = cmd["text"] as? String {
            speak(text: text, voice: cmd["voice"] as? String, rate: cmd["rate"] as? Double, speakId: (cmd["speakId"] as? String) ?? UUID().uuidString)
        }
    case "stop_speaking":
        synth.stopSpeaking(at: .immediate)
    default:
        break
    }
}

// MARK: - STT (file-based via Whisper-like API)

func transcribe(_ wavBase64: String) {
    guard let data = Data(base64Encoded: wavBase64) else {
        emit(["event": "error", "code": "decode_failed"])
        return
    }
    let tmp = FileManager.default.temporaryDirectory
        .appendingPathComponent("kairos-\(UUID().uuidString).webm")
    do {
        try data.write(to: tmp)
    } catch {
        emit(["event": "error", "code": "write_failed", "message": "\(error)"])
        return
    }
    let req = SFSpeechURLRecognitionRequest(url: tmp)
    req.shouldReportPartialResults = false
    req.requiresOnDeviceRecognition = false
    guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US")), recognizer.isAvailable else {
        emit(["event": "error", "code": "stt_unavailable"])
        return
    }
    recognizer.recognitionTask(with: req) { result, error in
        if let r = result, r.isFinal {
            emit(["event": "stt_final", "text": r.bestTranscription.formattedString])
            try? FileManager.default.removeItem(at: tmp)
        }
        if let e = error {
            emit(["event": "error", "code": "stt_failed", "message": e.localizedDescription])
            try? FileManager.default.removeItem(at: tmp)
        }
    }
}

// MARK: - TTS

var currentSpeakId: String?

func speak(text: String, voice: String?, rate: Double?, speakId: String) {
    let utterance = AVSpeechUtterance(string: text)
    if let v = voice, let match = AVSpeechSynthesisVoice.speechVoices().first(where: { $0.name == v || $0.identifier == v }) {
        utterance.voice = match
    }
    if utterance.voice == nil { utterance.voice = AVSpeechSynthesisVoice(language: "en-US") }
    if let r = rate { utterance.rate = Float(max(0.0, min(1.0, r))) }
    currentSpeakId = speakId
    emit(["event": "speak_started", "speak_id": speakId])
    synth.speak(utterance)
}

class SynthDelegate: NSObject, AVSpeechSynthesizerDelegate {
    func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) {
        if let id = currentSpeakId { emit(["event": "speak_finished", "speak_id": id]) }
        currentSpeakId = nil
    }
    func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel u: AVSpeechUtterance) {
        if let id = currentSpeakId { emit(["event": "speak_interrupted", "speak_id": id]) }
        currentSpeakId = nil
    }
}
