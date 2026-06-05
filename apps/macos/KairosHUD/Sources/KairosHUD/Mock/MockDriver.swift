// MockDriver.swift — daemon-free dev driver.
//
// Cycles the orb through its states + a synthetic level, AND simulates a Lane-A turn (tool calls)
// so the activity view can be exercised without the daemon. Drives the SAME models the real
// DaemonClient drives, so the UI code never changes between mock and live.

import Foundation

final class MockDriver {
    private let model: OrbModel
    private let activity: ActivityModel?
    private var frameTimer: Timer?
    private var stateTimer: Timer?
    private var t: Double = 0
    private var phase = 0
    private let states: [OrbState] = [.idle, .listening, .thinking, .speaking, .error]
    private let mockTools = ["search_gmail", "create_event", "send_reply", "query_linear"]

    init(model: OrbModel, activity: ActivityModel? = nil) {
        self.model = model
        self.activity = activity
    }

    func start() {
        model.transition(to: .idle)
        frameTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in self?.feed() }
        stateTimer = Timer.scheduledTimer(withTimeInterval: 3.5, repeats: true) { [weak self] _ in self?.cycle() }
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
        // simulate a turn's activity
        switch s {
        case .thinking:
            activity?.intent(tier: "smart")
            activity?.setStatus("working on your request")
            activity?.toolCall(id: "m0", name: mockTools[0])
        case .speaking:
            activity?.toolDone(id: "m0", summary: "3 results")
            activity?.toolCall(id: "m1", name: mockTools[1])
            activity?.setStatus("creating the event")
        case .error:
            activity?.toolFailed(id: "m1", error: "permission denied")
        case .idle:
            activity?.finish()
        default:
            break
        }
    }
}
