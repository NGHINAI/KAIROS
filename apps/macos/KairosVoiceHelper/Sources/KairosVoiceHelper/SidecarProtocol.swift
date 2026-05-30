// SidecarProtocol.swift — stdin/stdout JSON-line protocol.
//
// Bun spawns the sidecar; commands flow in via stdin, events out via stdout.
// No socket dance. Matches Claude Code's tool architecture. Simple and reliable.

import Foundation

final class ProtocolBus {
    private var onCommandHandler: ((SidecarCmd) -> Void)?
    private var readerQueue = DispatchQueue(label: "kairos.voice.protocol.read")
    private let writeQueue = DispatchQueue(label: "kairos.voice.protocol.write")

    init(socketPath: String) {
        // socketPath is unused in stdio mode but kept for API compatibility.
    }

    func onCommand(_ handler: @escaping (SidecarCmd) -> Void) {
        onCommandHandler = handler
    }

    func start() {
        readerQueue.async { self.runReader() }
    }

    func emit(_ payload: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let line = String(data: data, encoding: .utf8) else { return }
        writeQueue.async {
            FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
        }
    }

    private func runReader() {
        let stdin = FileHandle.standardInput
        var buffer = Data()
        while true {
            let chunk = stdin.availableData
            if chunk.isEmpty {
                // stdin closed → daemon disconnected; exit cleanly
                exit(0)
            }
            buffer.append(chunk)
            while let nl = buffer.firstIndex(of: 0x0a) {
                let line = buffer.subdata(in: 0..<nl)
                buffer.removeSubrange(0...nl)
                guard !line.isEmpty,
                      let json = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
                      let cmd = SidecarCmd(json: json) else { continue }
                onCommandHandler?(cmd)
            }
        }
    }
}

enum SidecarCmd {
    case speak(text: String, voice: String?, rate: Double?, speakId: String?, interruptible: Bool)
    case stopSpeaking
    case startListening(mode: String)
    case stopListening
    case setHotkey(modifier: String, action: String)
    case setVoice(voice: String)
    case getVoices
    case healthCheck
    case shutdown

    init?(json: [String: Any]) {
        guard let cmd = json["cmd"] as? String else { return nil }
        switch cmd {
        case "speak":
            guard let text = json["text"] as? String else { return nil }
            self = .speak(
                text: text,
                voice: json["voice"] as? String,
                rate: json["rate"] as? Double,
                speakId: json["speakId"] as? String,
                interruptible: (json["interruptible"] as? Bool) ?? true
            )
        case "stop_speaking":   self = .stopSpeaking
        case "start_listening": self = .startListening(mode: (json["mode"] as? String) ?? "push_to_talk")
        case "stop_listening":  self = .stopListening
        case "set_hotkey":
            self = .setHotkey(
                modifier: (json["modifier"] as? String) ?? "option",
                action: (json["action"] as? String) ?? "hold"
            )
        case "set_voice":
            guard let v = json["voice"] as? String else { return nil }
            self = .setVoice(voice: v)
        case "get_voices":   self = .getVoices
        case "health_check": self = .healthCheck
        case "shutdown":     self = .shutdown
        default: return nil
        }
    }
}
