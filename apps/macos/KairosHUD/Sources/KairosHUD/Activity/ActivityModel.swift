// ActivityModel.swift — the "watch it work" state for Lane A (the live foreground turn).
//
// Fed by DaemonClient from agent_intent / agent_tool_call / agent_tool_done / agent_tool_failed /
// agent_status, cleared shortly after agent_done. The orbiting nodes + timeline card are a pure
// projection of this. (Lane B / background sub-agents come next, in the same model family.)

import SwiftUI
import Combine

enum StepStatus { case running, done, failed }

struct ActivityStep: Identifiable {
    let id: String
    var name: String
    var status: StepStatus
    var summary: String
}

final class ActivityModel: ObservableObject {
    @Published private(set) var steps: [ActivityStep] = []
    @Published private(set) var status: String = ""      // agent_status line
    @Published private(set) var tier: String = ""        // fast / smart / deep / vision
    @Published private(set) var active: Bool = false      // a turn is in progress (drives card show/hide)

    private var clearWork: DispatchWorkItem?

    func intent(tier: String) { self.tier = tier; begin() }
    func setStatus(_ s: String) { status = s; begin() }

    func toolCall(id: String, name: String) {
        begin()
        if let i = steps.firstIndex(where: { $0.id == id }) { steps[i].status = .running }
        else { steps.append(ActivityStep(id: id, name: name, status: .running, summary: "")) }
    }
    func toolDone(id: String, summary: String) {
        if let i = steps.firstIndex(where: { $0.id == id }) { steps[i].status = .done; steps[i].summary = summary }
    }
    func toolFailed(id: String, error: String) {
        if let i = steps.firstIndex(where: { $0.id == id }) { steps[i].status = .failed; steps[i].summary = error }
    }

    /// Turn ended — fade the activity out after a beat so the last state is readable.
    func finish() {
        clearWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            self?.steps = []; self?.status = ""; self?.tier = ""; self?.active = false
        }
        clearWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5, execute: work)
    }

    private func begin() { clearWork?.cancel(); clearWork = nil; active = true }

    // Dev helpers for the mock driver / snapshots.
    func mockReset() { clearWork?.cancel(); steps = []; status = ""; tier = ""; active = false }
}
