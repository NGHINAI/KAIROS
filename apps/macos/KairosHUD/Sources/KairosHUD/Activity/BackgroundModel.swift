// BackgroundModel.swift — Lane B: the persistent background sub-agents ("a background KAIROS
// running a task while the foreground keeps talking").
//
// Fed by DaemonClient from the flat task_* events (task_spawned / task_tool / task_progress /
// task_done / task_failed / task_cancelled / task_report), each keyed by the task `id`. The daemon
// runs these concurrently with the foreground turn (fire-and-forget, cap 3); this model is a pure
// projection of their event stream. The orb's rim count badge reads `runningCount`; the console
// roster reads `agents`; each row observes its own BgAgent so per-agent updates don't churn the list.

import SwiftUI

enum BgStatus { case running, done, failed, cancelled }

/// One background sub-agent. Observable so a console row re-renders on its own progress without
/// republishing the whole roster.
final class BgAgent: ObservableObject, Identifiable {
    let id: String
    @Published var goal: String
    @Published var status: BgStatus = .running
    @Published var note: String = ""              // latest "radio-dispatch" milestone (task_progress.note)
    @Published var steps: [ActivityStep] = []      // tool calls (task_tool), for the expanded detail
    @Published var report: String? = nil           // final summary (task_done / task_report)
    let startedAt = Date()

    init(id: String, goal: String) { self.id = id; self.goal = goal }
}

final class BackgroundModel: ObservableObject {
    @Published private(set) var agents: [BgAgent] = []     // newest first
    @Published private(set) var runningCount: Int = 0       // drives the rim count badge

    private var pruneWork: [String: DispatchWorkItem] = [:]

    private func find(_ id: String) -> BgAgent? { agents.first { $0.id == id } }
    private func recount() { runningCount = agents.filter { $0.status == .running }.count }

    func spawned(id: String, goal: String) {
        cancelPrune(id)
        if let a = find(id) { a.goal = goal; a.status = .running }
        else { withAnimation(HUDState.glassSpring) { agents.insert(BgAgent(id: id, goal: goal), at: 0) } }
        recount()
    }

    func tool(id: String, name: String) {
        guard let a = find(id) else { return }
        // Ignore a re-delivered duplicate (WS reconnect replay) of the tool that's already running.
        if let last = a.steps.last, last.name == name, last.status == .running { return }
        for i in a.steps.indices where a.steps[i].status == .running { a.steps[i].status = .done }
        withAnimation(HUDState.glassSpring) {
            a.steps.append(ActivityStep(id: "\(id)-\(a.steps.count)", name: name, status: .running, summary: ""))
        }
    }

    func progress(id: String, note: String) { find(id)?.note = note }

    func done(id: String, summary: String) {
        guard let a = find(id) else { return }
        for i in a.steps.indices where a.steps[i].status == .running { a.steps[i].status = .done }
        a.status = .done; a.report = summary.isEmpty ? a.report : summary
        recount(); schedulePrune(id)
    }

    func failed(id: String, error: String) {
        guard let a = find(id) else { return }
        if let i = a.steps.lastIndex(where: { $0.status == .running }) { a.steps[i].status = .failed }
        a.status = .failed; a.note = error
        recount(); schedulePrune(id)
    }

    func cancelled(id: String) {
        guard let a = find(id) else { return }
        a.status = .cancelled
        recount(); schedulePrune(id)
    }

    /// task_report carries the SAME id as task_spawned/task_done. It must only UPDATE an existing
    /// agent — never CREATE one. (Creating-on-miss caused a phantom duplicate box when the agent had
    /// already been pruned at 45s, or when a reconnect replayed the report.)
    func report(id: String, goal: String, summary: String) {
        guard let a = find(id) else { return }
        a.report = summary
        if a.status == .running { a.status = .done }
        recount(); schedulePrune(id)
    }

    // Finished agents linger ~45s so their report is readable, then tidy themselves away.
    private func schedulePrune(_ id: String) {
        cancelPrune(id)
        let w = DispatchWorkItem { [weak self] in
            guard let self else { return }
            withAnimation(HUDState.glassSpring) { self.agents.removeAll { $0.id == id } }
            self.recount(); self.pruneWork[id] = nil
        }
        pruneWork[id] = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 45, execute: w)
    }
    private func cancelPrune(_ id: String) { pruneWork[id]?.cancel(); pruneWork[id] = nil }

    // Dev/mock reset.
    func reset() { agents = []; runningCount = 0; pruneWork.values.forEach { $0.cancel() }; pruneWork = [:] }
}
