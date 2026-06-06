// DaemonClient.swift — the live WebSocket client. Connects to the Bun daemon's voice-events socket
// and drives the orb's (state, level) from real events. This is the seam from §17 of the UI spec:
// the HUD is a pure projection of the WS event stream.
//
//   ws://127.0.0.1:<port>/v1/voice/events   (same socket the Electron app used)
//
// State mapping:
//   listening_started → listening · agent_intent/planning → thinking · tts_begin → speaking
//   tts_end/abort/agent_interrupted/agent_done → idle · *error → error (auto-clears)
// Level: while speaking, RMS of each tts_chunk's PCM (s16le 24kHz mono) drives the liquid pulse.
// Auto-reconnects with backoff; if the daemon is down the orb just sits idle and keeps retrying.

import Foundation

final class DaemonClient {
    private let model: OrbModel
    private let activity: ActivityModel?
    private let url: URL
    private let session = URLSession(configuration: .default)
    private var task: URLSessionWebSocketTask?
    private var reconnectScheduled = false
    private var speaking = false
    private let verbose: Bool

    init(model: OrbModel, activity: ActivityModel? = nil, port: Int = 9876, verbose: Bool = false) {
        self.model = model
        self.activity = activity
        self.url = URL(string: "ws://127.0.0.1:\(port)/v1/voice/events")!
        self.verbose = verbose
    }

    func connect() {
        let t = session.webSocketTask(with: url)
        task = t
        t.resume()
        receive()
    }

    private func receive() {
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure:
                self.scheduleReconnect()
            case .success(let message):
                switch message {
                case .string(let s): self.handle(s)
                case .data(let d): if let s = String(data: d, encoding: .utf8) { self.handle(s) }
                @unknown default: break
                }
                self.receive()
            }
        }
    }

    private func scheduleReconnect() {
        task = nil
        if reconnectScheduled { return }
        reconnectScheduled = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            self?.reconnectScheduled = false
            self?.connect()
        }
    }

    private func handle(_ text: String) {
        guard let data = text.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let event = obj["event"] as? String else { return }
        if verbose { FileHandle.standardError.write("event: \(event)\n".data(using: .utf8)!) }
        DispatchQueue.main.async { [weak self] in self?.apply(event: event, payload: obj) }
    }

    private func apply(event: String, payload: [String: Any]) {
        switch event {
        case "listening_started":
            model.transition(to: .listening)
        case "listening_stopped":
            if !speaking { model.transition(to: .idle) }
        case "agent_intent":
            if !speaking { model.transition(to: .thinking) }
            activity?.intent(tier: payload["tier"] as? String ?? "")
        case "agent_planning":
            if !speaking { model.transition(to: .thinking) }
        case "agent_status":
            activity?.setStatus(payload["text"] as? String ?? "")
        case "agent_tool_call":
            activity?.toolCall(id: payload["id"] as? String ?? UUID().uuidString,
                               name: payload["name"] as? String ?? "tool")
        case "agent_tool_done":
            activity?.toolDone(id: payload["id"] as? String ?? "",
                               summary: payload["result_summary"] as? String ?? "")
        case "agent_tool_failed":
            activity?.toolFailed(id: payload["id"] as? String ?? "",
                                 error: payload["error"] as? String ?? "failed")
        case "tts_begin":
            speaking = true
            model.transition(to: .speaking)
        case "tts_chunk":
            if let pcm = payload["pcm"] as? String { model.ingest(level: Self.rms(base64Pcm: pcm)) }
        case "tts_end", "tts_abort", "agent_interrupted":
            speaking = false
            model.ingest(level: 0)
            model.transition(to: .idle)
            if event == "agent_interrupted" { activity?.finish() }
        case "agent_done":
            if !speaking { model.transition(to: .idle) }
            activity?.finish()
        case "agent_error", "error", "sidecar_error":
            model.transition(to: .error)
            activity?.finish()
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) { [weak self] in
                if self?.model.state == .error { self?.model.transition(to: .idle) }
            }
        default:
            break
        }
    }

    /// RMS amplitude (0…1) of a base64 PCM chunk (signed 16-bit little-endian). Scaled up because
    /// speech RMS is small; OrbModel.ingest does the final curve + smoothing.
    static func rms(base64Pcm: String) -> Double {
        guard let data = Data(base64Encoded: base64Pcm), data.count >= 2 else { return 0 }
        let count = data.count / 2
        var sum = 0.0
        data.withUnsafeBytes { raw in
            let p = raw.bindMemory(to: Int16.self)
            for i in 0..<count {
                let v = Double(Int16(littleEndian: p[i])) / 32768.0
                sum += v * v
            }
        }
        return min(1.0, sqrt(sum / Double(count)) * 2.5)
    }
}
