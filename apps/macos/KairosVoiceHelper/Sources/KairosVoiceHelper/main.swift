// main.swift — KairosVoiceHelper sidecar entry point.
//
// Binds a Unix domain socket, accepts a single Bun daemon connection,
// processes JSON-line commands, emits JSON-line events. All audio runs in
// a single AVAudioEngine graph in the same process — no IPC for audio.

import Foundation
import AppKit
import AVFoundation

let socketPath: String = {
    // Use /tmp by default — no spaces, no entitlement issues, simpler for dev.
    // Override via KAIROS_SIDECAR_SOCKET env var.
    if let custom = ProcessInfo.processInfo.environment["KAIROS_SIDECAR_SOCKET"], !custom.isEmpty {
        return custom
    }
    return "/tmp/kairos-voiced.sock"
}()

// Configure as a background helper (no Dock icon, no menu bar by default).
let app = NSApplication.shared
app.setActivationPolicy(.accessory)

// Make stdout unbuffered so events reach Bun immediately
setbuf(stdout, nil)

// Explicitly request microphone permission. AVAudioEngine.inputNode access
// doesn't reliably trigger the TCC prompt — this call does. Once user grants,
// the app appears in System Settings → Privacy & Security → Microphone.
AVCaptureDevice.requestAccess(for: .audio) { granted in
    NSLog("KAIROS mic permission requested → granted=\(granted)")
}

// STT mode is selected by the Bun daemon via KAIROS_STT_MODE env var.
//   "apple" (default) — uses on-device SFSpeechRecognizer with live partials.
//   "cloud"           — buffers PCM and emits {"event":"audio_blob",...} on stop;
//                        Bun POSTs that to Groq/OpenRouter Whisper.
let sttMode = (ProcessInfo.processInfo.environment["KAIROS_STT_MODE"] ?? "apple").lowercased()
let cloudSTT = (sttMode == "cloud")
NSLog("KAIROS helper: STT mode = \(sttMode)")

let bus = ProtocolBus(socketPath: socketPath)
let synth = SpeechSynthesizer(bus: bus)
let recognizer: SpeechRecognizer? = cloudSTT ? nil : SpeechRecognizer(bus: bus)
let recorder: BufferRecorder? = cloudSTT ? BufferRecorder(bus: bus) : nil
let vad = SileroVAD(bus: bus)
let audio = AudioEngine(bus: bus, recognizer: recognizer, recorder: recorder, vad: vad, synth: synth)
let bargeIn = BargeInDetector(bus: bus, vad: vad, synth: synth)
let hotkey = HotKeyManager(bus: bus)

// Wire incoming commands → component dispatchers
bus.onCommand { cmd in
    switch cmd {
    case .speak(let text, let voice, let rate, let speakId, _):
        synth.speak(text: text, voice: voice, rate: rate, speakId: speakId ?? "spk_default")
    case .stopSpeaking:
        synth.stop()
    case .startListening:
        recognizer?.startListening()
        recorder?.startListening()
    case .stopListening:
        recognizer?.stopListening()
        recorder?.stopListening()
    case .setHotkey(let modifier, let action):
        hotkey.setHotkey(modifier: modifier, action: action)
    case .setVoice:
        break   // applied per-call via speak's `voice` arg
    case .getVoices:
        synth.listVoices()
    case .healthCheck:
        bus.emit(["event": "sidecar_ready", "version": "0.6.0"])
    case .shutdown:
        exit(0)
    }
}

// Bus first — emit `sidecar_ready` so daemon knows we're alive even if audio init blocks
bus.start()
bus.emit(["event": "sidecar_ready", "version": "0.6.0"])
NSLog("KAIROS sidecar: ready emitted")

// Audio init on a background queue so it doesn't block speech command processing.
// On unsigned CLI binaries, mic TCC isn't granted; setVoiceProcessingEnabled / engine.start
// may block. TTS does not need the audio engine; STT + barge-in + hotkey do.
DispatchQueue.global(qos: .userInitiated).async {
    NSLog("KAIROS sidecar: starting audio engine on background queue")
    audio.start()
    NSLog("KAIROS sidecar: audio.start returned")
    bargeIn.start()
    hotkey.start()
}

app.run()
