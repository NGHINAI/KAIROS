// main.swift — KairosVoiceHelper sidecar entry point.
//
// Binds a Unix domain socket, accepts a single Bun daemon connection,
// processes JSON-line commands, emits JSON-line events. All audio runs in
// a single AVAudioEngine graph in the same process — no IPC for audio.

import Foundation
import AppKit

let socketPath: String = {
    let appSupport = NSSearchPathForDirectoriesInDomains(.applicationSupportDirectory, .userDomainMask, true).first ?? "/tmp"
    let dir = (appSupport as NSString).appendingPathComponent("KAIROS")
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    return (dir as NSString).appendingPathComponent("voiced.sock")
}()

// Configure as a background helper (no Dock icon, no menu bar by default).
let app = NSApplication.shared
app.setActivationPolicy(.accessory)

// Boot order: audio engine → speech recognizer → speech synthesizer → VAD → hotkey → socket
let bus  = ProtocolBus(socketPath: socketPath)
let synth = SpeechSynthesizer(bus: bus)
let recognizer = SpeechRecognizer(bus: bus)
let vad = SileroVAD(bus: bus)
let audio = AudioEngine(bus: bus, recognizer: recognizer, vad: vad, synth: synth)
let bargeIn = BargeInDetector(bus: bus, vad: vad, synth: synth)
let hotkey = HotKeyManager(bus: bus)

audio.start()
bargeIn.start()
hotkey.start()
bus.start()
bus.emit(["event": "sidecar_ready", "version": "0.6.0"])

app.run()
