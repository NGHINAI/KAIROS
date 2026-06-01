// KairosSpeechHelper — Swift CLI: SFSpeechRecognizer (streaming STT) + AVSpeechSynthesizer (TTS).
// Mic is owned by Electron (Chromium getUserMedia); PCM samples stream in via stdin.
//
// Protocol (JSON lines over stdio):
//   in  → {"cmd":"audio_start"}
//         {"cmd":"audio_pcm","pcm":"<base64 16kHz int16 LE>"}
//         {"cmd":"audio_stop"}
//         {"cmd":"speak","text":"...","voice":"Zoe (Premium)","rate":0.5}
//         {"cmd":"stop_speaking"}
//
//   out → {"event":"helper_ready", "version":"..."}
//         {"event":"perm_speech","status":"authorized" | ...}
//         {"event":"listening_started"} / {"event":"listening_stopped"}
//         {"event":"stt_partial","text":"..."} / {"event":"stt_final","text":"..."}
//         {"event":"speak_started" / "speak_finished" / "speak_interrupted","speak_id":"..."}
//         {"event":"error","code":"...","message":"..."}

import Foundation
import AppKit
import AVFoundation
import Speech

setbuf(stdout, nil)

// SFSpeechRecognizer / AVSpeechSynthesizer need a fully-booted NSApplication
// event loop. Accessing them at module-load time crashes when this binary is
// spawned as a child process. So we hold globals as Optional and initialize
// them on the main queue after `app.run()` is pumping events.

var synth: AVSpeechSynthesizer?
var synthDelegate: SynthDelegate?
var recognizer: SFSpeechRecognizer?
var sttRequest: SFSpeechAudioBufferRecognitionRequest?
var sttTask: SFSpeechRecognitionTask?
var isListening = false
var speechStatus: SFSpeechRecognizerAuthorizationStatus = .notDetermined
var currentSpeakId: String?
var pendingCommands: [[String: Any]] = []
var initialized = false

let pcmFormat = AVAudioFormat(
    commonFormat: .pcmFormatInt16,
    sampleRate: 16_000,
    channels: 1,
    interleaved: true
)!

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

// Defer init until NSApp event loop is pumping. The DispatchQueue.main.async
// fires after the first runloop tick — by then all the AppKit setup is done.
DispatchQueue.main.async {
    initRecognizers()
}

// Start the stdin reader before app.run() — readLoop runs on a bg queue.
readLoop()
app.run()

// ── Init (runs after NSApplication is ready) ──────────────────────────────

func initRecognizers() {
    // Just check current auth status — don't request (the dialog needs a UI
    // responsible-process context which child-of-Electron lacks → SIGABRT).
    // The user grants Speech Recognition once via System Settings.
    speechStatus = SFSpeechRecognizer.authorizationStatus()
    NSLog("KAIROS helper: speech auth (current) = \(speechStatus.rawValue)")

    synth = AVSpeechSynthesizer()
    synthDelegate = SynthDelegate()
    synth?.delegate = synthDelegate
    recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))

    initialized = true
    emit(["event": "helper_ready", "version": "0.6.1-pcm-stream"])
    emit(["event": "perm_speech", "status": speechAuthStr(speechStatus)])

    // Drain any commands that arrived before init
    let queued = pendingCommands
    pendingCommands = []
    for cmd in queued { handleCommand(cmd) }
}

// ── stdio I/O ─────────────────────────────────────────────────────────────

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
                DispatchQueue.main.async {
                    if initialized { handleCommand(json) }
                    else { pendingCommands.append(json) }
                }
            }
        }
    }
}

func handleCommand(_ cmd: [String: Any]) {
    guard let kind = cmd["cmd"] as? String else { return }
    switch kind {
    case "request_speech_auth":
        // Opt-in. Only call when we know UI context is safe (e.g. user explicitly
        // ran the bootstrap script). Crashes when called as Electron child.
        SFSpeechRecognizer.requestAuthorization { status in
            speechStatus = status
            emit(["event": "perm_speech", "status": speechAuthStr(status)])
        }
    case "audio_start": audioStart()
    case "audio_stop":  audioStop()
    case "audio_pcm":
        if let b64 = cmd["pcm"] as? String { feedPCM(b64) }
    case "speak":
        if let text = cmd["text"] as? String {
            speak(text: text,
                  voice: cmd["voice"] as? String,
                  rate:  cmd["rate"] as? Double,
                  speakId: (cmd["speakId"] as? String) ?? UUID().uuidString)
        }
    case "stop_speaking":
        synth?.stopSpeaking(at: .immediate)
    default: break
    }
}

// ── PCM-driven streaming STT ──────────────────────────────────────────────

func audioStart() {
    guard !isListening else { return }
    guard let recognizer = recognizer, recognizer.isAvailable else {
        emit(["event": "error", "code": "stt_unavailable"])
        return
    }
    guard speechStatus == .authorized else {
        emit(["event": "error", "code": "stt_not_authorized",
              "message": "Grant Speech Recognition in System Settings → Privacy & Security."])
        return
    }

    let req = SFSpeechAudioBufferRecognitionRequest()
    req.shouldReportPartialResults = true
    req.requiresOnDeviceRecognition = false
    sttRequest = req

    sttTask = recognizer.recognitionTask(with: req) { result, error in
        if let r = result {
            let text = r.bestTranscription.formattedString
            if r.isFinal {
                emit(["event": "stt_final", "text": text])
            } else {
                emit(["event": "stt_partial", "text": text])
            }
        }
        if let err = error {
            let nsErr = err as NSError
            if nsErr.code != 203 && nsErr.code != 216 {
                emit(["event": "error", "code": "stt_failed", "message": err.localizedDescription])
            }
        }
    }
    isListening = true
    emit(["event": "listening_started"])
}

func feedPCM(_ b64: String) {
    guard isListening, let request = sttRequest else { return }
    guard let data = Data(base64Encoded: b64), !data.isEmpty else { return }
    let frameCount = AVAudioFrameCount(data.count / 2)
    guard frameCount > 0,
          let buffer = AVAudioPCMBuffer(pcmFormat: pcmFormat, frameCapacity: frameCount),
          let ch = buffer.int16ChannelData?[0] else { return }
    buffer.frameLength = frameCount
    data.withUnsafeBytes { raw in
        guard let src = raw.bindMemory(to: Int16.self).baseAddress else { return }
        ch.update(from: src, count: Int(frameCount))
    }
    request.append(buffer)
}

func audioStop() {
    guard isListening else { return }
    sttRequest?.endAudio()
    sttTask?.finish()
    sttRequest = nil
    sttTask = nil
    isListening = false
    emit(["event": "listening_stopped"])
}

// ── TTS ───────────────────────────────────────────────────────────────────

func speak(text: String, voice: String?, rate: Double?, speakId: String) {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, let synth = synth else { return }
    let utterance = AVSpeechUtterance(string: trimmed)
    if let v = voice,
       let match = AVSpeechSynthesisVoice.speechVoices().first(where: { $0.name == v || $0.identifier == v }) {
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

// ── Helpers ───────────────────────────────────────────────────────────────

func speechAuthStr(_ s: SFSpeechRecognizerAuthorizationStatus) -> String {
    switch s {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "not_determined"
    @unknown default: return "unknown"
    }
}
