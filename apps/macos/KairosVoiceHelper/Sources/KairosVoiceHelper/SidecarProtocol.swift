// SidecarProtocol.swift — Unix domain socket + line-delimited JSON.
//
// Listens on the well-known UDS path. Accepts ONE Bun daemon connection at a
// time. Reads JSON commands line-by-line; writes JSON events line-by-line.
// Hot-pluggable: if Bun disconnects, sidecar waits for a new connection.

import Foundation

final class ProtocolBus {
    private let socketPath: String
    private var listenSocket: Int32 = -1
    private var clientSocket: Int32 = -1
    private let queue = DispatchQueue(label: "kairos.voice.protocol")
    private let writeQueue = DispatchQueue(label: "kairos.voice.protocol.write")
    private var onCommandHandler: ((SidecarCmd) -> Void)?

    init(socketPath: String) {
        self.socketPath = socketPath
    }

    func onCommand(_ handler: @escaping (SidecarCmd) -> Void) {
        onCommandHandler = handler
    }

    func start() {
        queue.async { self.runListener() }
    }

    func emit(_ payload: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let line = String(data: data, encoding: .utf8) else { return }
        let withNewline = line + "\n"
        writeQueue.async {
            guard self.clientSocket >= 0 else { return }
            _ = withNewline.withCString { ptr in
                write(self.clientSocket, ptr, strlen(ptr))
            }
        }
    }

    private func runListener() {
        unlink(socketPath)
        listenSocket = socket(AF_UNIX, SOCK_STREAM, 0)
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        socketPath.withCString { sp in
            withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
                ptr.withMemoryRebound(to: CChar.self, capacity: Int(getMaxPathLen())) { dst in
                    _ = strncpy(dst, sp, Int(getMaxPathLen()) - 1)
                }
            }
        }
        let bound = withUnsafePointer(to: &addr) { ap -> Int32 in
            ap.withMemoryRebound(to: sockaddr.self, capacity: 1) { sp in
                bind(listenSocket, sp, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bound >= 0 else { NSLog("KAIROS sidecar: bind failed: \(errno)"); return }
        listen(listenSocket, 1)

        while true {
            clientSocket = accept(listenSocket, nil, nil)
            guard clientSocket >= 0 else { sleep(1); continue }
            handleClient()
            close(clientSocket)
            clientSocket = -1
        }
    }

    private func handleClient() {
        var buf = [UInt8](repeating: 0, count: 8192)
        var pending = Data()
        while true {
            let n = read(clientSocket, &buf, buf.count)
            if n <= 0 { return }
            pending.append(buf, count: n)
            while let nl = pending.firstIndex(of: 0x0a) {
                let lineData = pending.subdata(in: 0..<nl)
                pending.removeSubrange(0...nl)
                guard !lineData.isEmpty,
                      let json = try? JSONSerialization.jsonObject(with: lineData) as? [String: Any] else { continue }
                if let cmd = SidecarCmd(json: json) {
                    onCommandHandler?(cmd)
                }
            }
        }
    }

    private func getMaxPathLen() -> Int32 {
        // sun_path is fixed at 104 on macOS
        return 104
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
