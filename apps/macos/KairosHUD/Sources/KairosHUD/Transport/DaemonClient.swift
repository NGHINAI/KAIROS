// DaemonClient.swift — the live WebSocket client. Connects to the Bun daemon's voice-events socket
// and drives the orb's (state, level) from real events. This is the seam from §17 of the UI spec:
// the HUD is a pure projection of the WS event stream.
//
//   ws://127.0.0.1:<port>/v1/voice/events   (same socket the Electron app used)
//
// State mapping:
//   listening_started → listening · agent_intent/planning → thinking
//   agent_speaking {speaking:true|false} → speaking / (thinking|idle)   ← the ENVELOPE (preferred)
//   tts_begin/tts_end → speaking/idle only as LEGACY fallback (per-phrase events strobe)
//   agent_interrupted/agent_done → idle · *error → error (auto-clears)
// The envelope is the daemon's single speech-level signal (renderer playback truth
// overlaid on the synthesis envelope) — per-phrase tts_* made the orb flicker at every
// sentence boundary and stop seconds early (tts_end = chunks downloaded, not played).
// Level: while speaking, RMS of each tts_chunk's PCM (s16le 24kHz mono) drives the liquid pulse.
// Auto-reconnects with backoff; if the daemon is down the orb just sits idle and keeps retrying.

import Foundation

final class DaemonClient {
    private let model: OrbModel
    private let activity: ActivityModel?
    private let bg: BackgroundModel?
    private let approval: ApprovalModel?
    private let guide: GuideModel?
    private let url: URL
    private let session = URLSession(configuration: .default)
    private var task: URLSessionWebSocketTask?
    private var reconnectScheduled = false
    private var speaking = false
    /// True once an `agent_speaking` envelope event has been seen — from then on the
    /// per-phrase tts_begin/tts_end events no longer drive state (audio level only).
    private var usesEnvelope = false
    /// True once a live `tts_level` stream has been seen — chunk-RMS is then ignored.
    private var usesLevelStream = false
    /// A turn is in flight (intent/planning/tool seen, no done/interrupted yet) — when
    /// speech pauses mid-turn the orb returns to .thinking, not .idle.
    private var turnActive = false
    private let verbose: Bool

    init(model: OrbModel, activity: ActivityModel? = nil, background: BackgroundModel? = nil,
         approval: ApprovalModel? = nil, guide: GuideModel? = nil, port: Int = 9876, verbose: Bool = false) {
        self.model = model
        self.activity = activity
        self.bg = background
        self.approval = approval
        self.guide = guide
        self.url = URL(string: "ws://127.0.0.1:\(port)/v1/voice/events")!
        self.verbose = verbose
    }

    /// Send an approval decision back to the daemon (the one place the HUD talks back). The daemon
    /// resolves the parked sub-agent via its approval gate; voice "yes"/"no" does the same.
    func resolve(_ id: String, approve: Bool) {
        guard let data = try? JSONSerialization.data(withJSONObject: ["cmd": approve ? "approve" : "deny", "item_id": id]),
              let json = String(data: data, encoding: .utf8) else { return }
        task?.send(.string(json)) { _ in }
    }

    /// Answer a guide_request: found (and now pointing) or not found + why.
    func sendGuideResult(id: String, found: Bool, label: String?, reason: String?) {
        var obj: [String: Any] = ["cmd": "guide_result", "id": id, "found": found]
        if let label { obj["label"] = label }
        if let reason { obj["reason"] = reason }
        guard let data = try? JSONSerialization.data(withJSONObject: obj),
              let json = String(data: data, encoding: .utf8) else { return }
        task?.send(.string(json)) { _ in }
    }

    /// Answer a control_request (a click): ok (the element was pressed) or not + why.
    func sendControlResult(id: String, ok: Bool, label: String?, reason: String?) {
        var obj: [String: Any] = ["cmd": "control_result", "id": id, "ok": ok]
        if let label { obj["label"] = label }
        if let reason { obj["reason"] = reason }
        guard let data = try? JSONSerialization.data(withJSONObject: obj),
              let json = String(data: data, encoding: .utf8) else { return }
        task?.send(.string(json)) { _ in }
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
        if verbose {
            var p = obj
            if let pcm = obj["pcm"] as? String { p["pcm"] = "<\(pcm.count) b64>" }   // elide audio spam
            let dump = (try? JSONSerialization.data(withJSONObject: p, options: [.sortedKeys]))
                .flatMap { String(data: $0, encoding: .utf8) } ?? event
            FileHandle.standardError.write("EVT \(dump)\n".data(using: .utf8)!)
        }
        DispatchQueue.main.async { [weak self] in self?.apply(event: event, payload: obj) }
    }

    private func apply(event: String, payload: [String: Any]) {
        switch event {
        case "listening_started":
            model.transition(to: .listening)
        case "listening_stopped":
            if !speaking { model.transition(to: .idle) }
        case "agent_intent":
            turnActive = true
            if !speaking { model.transition(to: .thinking) }
            activity?.intent(tier: payload["tier"] as? String ?? "")
        case "agent_planning":
            turnActive = true
            if !speaking { model.transition(to: .thinking) }
        case "agent_status":
            activity?.setStatus(payload["text"] as? String ?? "")
        case "agent_tool_call":
            let name = payload["name"] as? String ?? "tool"
            // The bg-spawn tools are represented by their OWN Lane B row — don't ALSO show them as a
            // foreground step (that was the "two boxes for one task" duplication).
            if Self.isBackgroundTool(name) { break }
            activity?.toolCall(id: payload["id"] as? String ?? UUID().uuidString,
                               name: Self.humanizeTool(name, args: payload["args"] as? [String: Any]))
        case "agent_tool_done":
            // (no-op if the id was a filtered bg tool — it was never added as a step)
            activity?.toolDone(id: payload["id"] as? String ?? "",
                               summary: Self.humanizeSummary(payload["result_summary"] as? String ?? ""))
        case "agent_tool_failed":
            activity?.toolFailed(id: payload["id"] as? String ?? "",
                                 error: Self.humanizeSummary(payload["error"] as? String ?? "failed"))
        // THE speech-level signal: one true at first audible word, one false when the
        // whole reply has finished playing. Replaces per-phrase tts_* for orb state.
        case "agent_speaking":
            usesEnvelope = true
            let on = payload["speaking"] as? Bool ?? false
            speaking = on
            if on {
                model.transition(to: .speaking)
            } else {
                model.ingest(level: 0)
                model.transition(to: turnActive ? .thinking : .idle)
            }
        case "tts_begin":
            // Legacy fallback only (old daemons without the envelope): per-phrase.
            if !usesEnvelope {
                speaking = true
                model.transition(to: .speaking)
            }
        // LIVE playback level from the renderer's analyser (~15Hz) — drives the
        // speaking lobes in sync with what's actually audible. Once seen, chunk-RMS
        // is ignored (chunks arrive at download speed, seconds ahead of playback).
        case "tts_level":
            usesLevelStream = true
            if let l = payload["level"] as? Double { model.ingest(level: l) }
        case "tts_chunk":
            if !usesLevelStream, let pcm = payload["pcm"] as? String { model.ingest(level: Self.rms(base64Pcm: pcm)) }
        case "tts_end", "tts_abort":
            if !usesEnvelope {
                speaking = false
                model.ingest(level: 0)
                model.transition(to: .idle)
            }
        case "agent_interrupted":
            speaking = false
            turnActive = false
            model.ingest(level: 0)
            model.transition(to: .idle)
            activity?.finish()
        case "agent_done":
            turnActive = false
            if !speaking { model.transition(to: .idle) }
            activity?.finish()
        // Guide Mode: resolve the element via the AX tree, fly the comet there, answer back.
        case "guide_request":
            if ProcessInfo.processInfo.environment["KAIROS_AX_DEBUG"] != nil {
                FileHandle.standardError.write("DC guide_request guide=\(guide != nil) find=\(payload["find"] as? String ?? "?")\n".data(using: .utf8)!)
            }
            guide?.handle(id: payload["id"] as? String ?? "",
                          find: payload["find"] as? String ?? "",
                          app: payload["app"] as? String)
        case "control_request":
            if ProcessInfo.processInfo.environment["KAIROS_AX_DEBUG"] != nil {
                FileHandle.standardError.write("DC control_request guide=\(guide != nil) find=\(payload["find"] as? String ?? "?")\n".data(using: .utf8)!)
            }
            guide?.handleClick(id: payload["id"] as? String ?? "",
                               find: payload["find"] as? String ?? "",
                               app: payload["app"] as? String)
        case "guide_end":
            guide?.end()

        case "agent_error", "error", "sidecar_error":
            turnActive = false
            model.transition(to: .error)
            activity?.finish()
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) { [weak self] in
                if self?.model.state == .error { self?.model.transition(to: .idle) }
            }

        // Lane B — background sub-agents (run concurrently with the foreground; keyed by `id`).
        case "task_spawned":
            bg?.spawned(id: payload["id"] as? String ?? "", goal: payload["goal"] as? String ?? "task")
        case "task_tool":
            bg?.tool(id: payload["id"] as? String ?? "", name: Self.humanizeTool(payload["tool"] as? String ?? "tool"))
        case "task_progress":
            bg?.progress(id: payload["id"] as? String ?? "", note: Self.humanizeNote(payload["note"] as? String ?? ""))
        case "task_done":
            bg?.done(id: payload["id"] as? String ?? "", summary: payload["summary"] as? String ?? "")
        case "task_failed":
            bg?.failed(id: payload["id"] as? String ?? "", error: payload["error"] as? String ?? "failed")
        case "task_cancelled":
            bg?.cancelled(id: payload["id"] as? String ?? "")
        case "task_report":
            bg?.report(id: payload["id"] as? String ?? "",
                       goal: payload["goal"] as? String ?? "task",
                       summary: payload["summary"] as? String ?? "")

        // Approvals — a background sub-agent parked on a destructive action. Persistent until resolved
        // (here, by voice, or in the inbox). The daemon should never gate read-only tools; we still
        // humanize the summary defensively so a raw tool id never shows.
        case "approval_request":
            approval?.request(id: payload["id"] as? String ?? "",
                              summary: Self.humanizeApprovalSummary(payload["summary"] as? String ?? ""),
                              toolName: Self.humanizeTool(payload["toolName"] as? String ?? ""))
        case "approval_inboxed":
            approval?.inboxed(id: payload["id"] as? String ?? "",
                              summary: Self.humanizeApprovalSummary(payload["summary"] as? String ?? ""))
        case "approval_resolved":
            approval?.resolved(id: payload["item_id"] as? String ?? payload["id"] as? String ?? "")

        default:
            break
        }
    }

    // MARK: - Humanizers (make the daemon's technical strings "as human as possible" at the boundary)
    //
    // The daemon ships tool SLUGS (GMAIL_SEND_EMAIL) and, for tool results, a JSON.stringify blob
    // (summarize() truncates the raw Composio object to 200 chars). We never want either in front of
    // the user, so we translate here — the HUD's last line of defense regardless of the daemon.

    static func isBackgroundTool(_ name: String) -> Bool {
        name == "spawn_background_task" || name == "background_tasks"
    }

    /// "GMAIL_SEND_EMAIL" → "Gmail · send email". Unwraps Composio meta-tools to their real action.
    static func humanizeTool(_ rawName: String, args: [String: Any]? = nil) -> String {
        var slug = rawName
        if (rawName == "execute_tool" || rawName == "search_tools"), let a = args,
           let t = (a["tool_name"] ?? a["tool_slug"] ?? a["slug"] ?? a["tool"]) as? String, !t.isEmpty {
            slug = t
        }
        let parts = slug.split(separator: "_").map(String.init)
        guard parts.count > 1 else { return slug.replacingOccurrences(of: "_", with: " ").capitalized }
        let toolkit = prettyToolkit[parts[0].uppercased()] ?? parts[0].lowercased().capitalized   // GMAIL → Gmail
        let action = parts.dropFirst().map { $0.lowercased() }.joined(separator: " ")
        return "\(toolkit) · \(action)"
    }

    /// Multi-word / branded toolkits that `.capitalized` would mangle (GOOGLECALENDAR → "Googlecalendar").
    private static let prettyToolkit: [String: String] = [
        "GOOGLECALENDAR": "Google Calendar", "GOOGLEDRIVE": "Google Drive", "GOOGLEDOCS": "Google Docs",
        "GOOGLESHEETS": "Google Sheets", "GITHUB": "GitHub", "GMAIL": "Gmail", "LINEAR": "Linear",
        "SLACK": "Slack", "NOTION": "Notion", "WHATSAPP": "WhatsApp", "OUTLOOK": "Outlook",
        "COMPOSIO": "Web", "GOOGLEMAPS": "Google Maps", "YOUTUBE": "YouTube",
    ]

    /// A raw tool-result summary (usually truncated JSON) → a short human line. Never shows JSON.
    static func humanizeSummary(_ raw: String) -> String {
        let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return "" }
        guard s.hasPrefix("{") || s.hasPrefix("[") else { return String(s.prefix(80)) }  // already prose
        if let data = s.data(using: .utf8), let obj = try? JSONSerialization.jsonObject(with: data) {
            if let arr = obj as? [Any] { return count(arr.count) }
            if let d = obj as? [String: Any] {
                if let n = listCount(in: d) { return count(n) }
                if (d["successful"] as? Bool) == true || (d["success"] as? Bool) == true { return "done" }
                if let e = d["error"], !(e is NSNull) { return "failed" }
            }
            return "done"
        }
        return "done"   // truncated/invalid JSON → never surface the blob
    }

    /// Defensive: a daemon approval summary should be prose ("send an email to Sam"), but if it leaks
    /// the "do via <RAW_TOOL>" fallback, turn the slug human ("do via Gmail · send email").
    static func humanizeApprovalSummary(_ raw: String) -> String {
        let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.lowercased().hasPrefix("do via "), case let slug = String(s.dropFirst(7)), slug.contains("_") {
            return "do via \(humanizeTool(slug))"
        }
        return s.isEmpty ? "an action that needs your OK" : s
    }

    /// "using GMAIL_FETCH_EMAILS" → "using Gmail · fetch emails"; otherwise pass prose through.
    static func humanizeNote(_ raw: String) -> String {
        let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.lowercased().hasPrefix("using "), case let slug = String(s.dropFirst(6)), slug.contains("_") {
            return "using \(humanizeTool(slug))"
        }
        return s
    }

    private static func count(_ n: Int) -> String { "\(n) result\(n == 1 ? "" : "s")" }
    private static func listCount(in d: [String: Any]) -> Int? {
        let keys = ["messages", "items", "results", "issues", "threads", "events", "files", "records", "data"]
        for container in [d, d["data"] as? [String: Any] ?? [:]] {
            for k in keys { if let a = container[k] as? [Any] { return a.count } }
        }
        return nil
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
