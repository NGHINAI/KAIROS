// MockDriver.swift — daemon-free dev driver.
//
// Cycles the orb through its states + a synthetic level, simulates a Lane-A foreground turn (tool
// calls), AND spawns Lane-B background sub-agents (so the rim count badge + console roster can be
// exercised without the daemon). Drives the SAME models the real DaemonClient drives, so the UI
// code never changes between mock and live.

import Foundation

final class MockDriver {
    private let model: OrbModel
    private let activity: ActivityModel?
    private let bg: BackgroundModel?
    private let approval: ApprovalModel?
    private var frameTimer: Timer?
    private var stateTimer: Timer?
    private var bgTimer: Timer?
    private var t: Double = 0
    private var phase = 0
    private var bgStep = 0
    private let states: [OrbState] = [.idle, .listening, .thinking, .speaking, .error]
    // Realistic daemon slugs so the mock exercises the humanizers (→ "Gmail · fetch emails", "done").
    private let mockTools = ["GMAIL_FETCH_EMAILS", "GOOGLECALENDAR_CREATE_EVENT", "GMAIL_SEND_EMAIL", "LINEAR_LIST_ISSUES"]
    private let okJSON = "{\"successful\":true,\"data\":{\"messages\":[{\"id\":\"1\"},{\"id\":\"2\"},{\"id\":\"3\"}]}}"

    init(model: OrbModel, activity: ActivityModel? = nil, background: BackgroundModel? = nil, approval: ApprovalModel? = nil) {
        self.model = model
        self.activity = activity
        self.bg = background
        self.approval = approval
    }

    func start() {
        model.transition(to: .idle)
        frameTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in self?.feed() }
        stateTimer = Timer.scheduledTimer(withTimeInterval: 3.5, repeats: true) { [weak self] _ in self?.cycle() }
        bgTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in self?.bgCycle() }
    }

    private func feed() {
        t += 1.0 / 30.0
        switch model.state {
        case .speaking:
            let env = 0.5 + 0.42 * sin(t * 6.0) + 0.18 * sin(t * 13.0)
            model.ingest(level: min(1, max(0, env)) * (0.6 + 0.4 * Double.random(in: 0...1)))
        case .listening:
            model.ingest(level: max(0, 0.30 + 0.30 * sin(t * 4.0)))
        default:
            model.ingest(level: 0)
        }
    }

    private func cycle() {
        phase = (phase + 1) % states.count
        let s = states[phase]
        model.transition(to: s)
        switch s {
        case .thinking:
            activity?.intent(tier: "smart")
            activity?.setStatus("Working on your Gmail")
            activity?.toolCall(id: "m0", name: DaemonClient.humanizeTool(mockTools[0]))
        case .speaking:
            activity?.toolDone(id: "m0", summary: DaemonClient.humanizeSummary(okJSON))     // → "3 results"
            activity?.toolCall(id: "m1", name: DaemonClient.humanizeTool(mockTools[1]))
            activity?.setStatus("Working on your calendar")
        case .error:
            activity?.toolFailed(id: "m1", error: "permission denied")
        case .idle:
            activity?.finish()
        default:
            break
        }
    }

    // A scripted background-agent lifecycle so the count badge + roster animate on their own.
    private func bgCycle() {
        guard let bg else { return }
        switch bgStep {
        case 0:
            bg.spawned(id: "bg-inbox", goal: "Organize my inbox")
            bg.progress(id: "bg-inbox", note: "scanning 142 unread…")
        case 1:
            bg.tool(id: "bg-inbox", name: DaemonClient.humanizeTool("GMAIL_FETCH_EMAILS"))
            bg.spawned(id: "bg-flights", goal: "Research SF→Tokyo flights")
        case 2:
            bg.tool(id: "bg-inbox", name: DaemonClient.humanizeTool("GMAIL_MODIFY_LABELS"))
            bg.progress(id: "bg-inbox", note: DaemonClient.humanizeNote("using GMAIL_MODIFY_LABELS"))
            bg.tool(id: "bg-flights", name: DaemonClient.humanizeTool("COMPOSIO_SEARCH_SEARCH"))
            bg.progress(id: "bg-flights", note: "comparing 6 itineraries…")
        case 3:
            bg.tool(id: "bg-inbox", name: DaemonClient.humanizeTool("GMAIL_MOVE_TO_TRASH"))
            bg.spawned(id: "bg-report", goal: "Draft the weekly report")
            bg.progress(id: "bg-report", note: "pulling Linear issues…")
            // a sub-agent parks on a destructive action → persistent Approve/Deny (or say "yes")
            approval?.request(id: "ap-1", summary: "Send the weekly report email to the team",
                              toolName: DaemonClient.humanizeTool("GMAIL_SEND_EMAIL"))
        case 4:
            bg.done(id: "bg-inbox", summary: "Archived 88, labeled 41 into 6 projects, flagged 5 to reply.")
            bg.tool(id: "bg-flights", name: "summarize")
        case 5:
            bg.done(id: "bg-flights", summary: "Cheapest: ANA $812 nonstop, May 14. 3 alternates in the report.")
            bg.tool(id: "bg-report", name: "query_linear")
        case 6:
            bg.failed(id: "bg-report", error: "Notion auth expired — needs reconnect")
        default:
            bg.reset()
            approval?.reset()
            bgStep = -1     // loop the demo
        }
        bgStep += 1
    }
}
