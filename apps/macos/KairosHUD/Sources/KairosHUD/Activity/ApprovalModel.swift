// ApprovalModel.swift — pending approvals a background sub-agent is parked on.
//
// When a sub-agent wants to do something destructive (send/delete/pay/connect), the daemon emits
// `approval_request` (asking aloud now) and, if unanswered in ~20s, `approval_inboxed` (parked in the
// user's inbox). Either way the sub-agent is paused at ZERO token cost until resolved. Resolution can
// come three ways, all equivalent: voice ("yes"/"no", now or later), or this HUD's Approve/Deny, or
// the CLI/inbox. This model is the HUD's persistent view of what's waiting — it stays until the daemon
// confirms `approval_resolved`, so the user can act on it ANY time, not just in the moment.

import SwiftUI

struct PendingApproval: Identifiable, Equatable {
    let id: String          // = approval_request.id (also the item_id we send back)
    var summary: String     // human: "send an email to Sam"
    var toolName: String    // humanized tool label, for a small hint
    var parked: Bool        // false = being asked right now; true = parked in the inbox, waiting
}

final class ApprovalModel: ObservableObject {
    @Published private(set) var pending: [PendingApproval] = []

    /// Set by AppDelegate to actually send the decision to the daemon over the WS.
    var resolveHandler: ((_ id: String, _ approve: Bool) -> Void)?
    /// Fired when a genuinely new to-do arrives (AppDelegate wires it to HUDState.peekTodos()).
    var onNewItem: (() -> Void)?

    var count: Int { pending.count }

    private func upsert(_ a: PendingApproval) {
        if let i = pending.firstIndex(where: { $0.id == a.id }) {
            pending[i].summary = a.summary
            if !a.toolName.isEmpty { pending[i].toolName = a.toolName }
            pending[i].parked = a.parked || pending[i].parked
        } else {
            withAnimation(HUDState.glassSpring) { pending.insert(a, at: 0) }
            onNewItem?()
        }
    }

    /// `approval_request` — surfaced/asked now.
    func request(id: String, summary: String, toolName: String) {
        upsert(PendingApproval(id: id, summary: summary, toolName: toolName, parked: false))
    }
    /// `approval_inboxed` — parked (still waiting; user can resolve anytime).
    func inboxed(id: String, summary: String) {
        if pending.contains(where: { $0.id == id }) {
            if let i = pending.firstIndex(where: { $0.id == id }) { pending[i].parked = true }
        } else {
            upsert(PendingApproval(id: id, summary: summary, toolName: "", parked: true))
        }
    }
    /// `approval_resolved` — daemon confirmed; drop it.
    func resolved(id: String) {
        withAnimation(HUDState.glassSpring) { pending.removeAll { $0.id == id } }
    }

    /// User tapped Approve/Deny — tell the daemon and optimistically remove for snappy feedback.
    func act(_ id: String, approve: Bool) {
        resolveHandler?(id, approve)
        withAnimation(HUDState.glassSpring) { pending.removeAll { $0.id == id } }
    }

    func reset() { pending = [] }
}
