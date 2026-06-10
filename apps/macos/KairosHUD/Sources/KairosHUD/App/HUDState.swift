// HUDState.swift — the tiny shared UI state the orb panel and the console panel both observe.
//
// The whole interaction model funnels through one gesture: clicking the orb toggles `consoleOpen`.
// At rest the orb is alone on screen (plus a count badge when background agents run); the full
// "what's it doing" detail lives behind that single click. `expandedAgentID` tracks which one
// background agent (if any) the user has opened to its full step list inside the console.

import SwiftUI

final class HUDState: ObservableObject {
    @Published var consoleOpen = false
    @Published var expandedAgentID: String? = nil
    @Published var todosExpanded = false            // the "To-dos" list (parked approvals etc.)

    private var todosCollapseWork: DispatchWorkItem?

    /// Liquid-Glass spring used for every reveal/morph in the HUD, in one place so motion is uniform.
    static let glassSpring: Animation = .spring(response: 0.42, dampingFraction: 0.78)

    /// A new to-do arrived: flash the list open for a few seconds, then tuck it away again. The user
    /// can re-open it anytime (toggleTodos). Manual control cancels the auto-collapse.
    func peekTodos() {
        todosCollapseWork?.cancel()
        withAnimation(Self.glassSpring) { todosExpanded = true }
        let w = DispatchWorkItem { [weak self] in withAnimation(Self.glassSpring) { self?.todosExpanded = false } }
        todosCollapseWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 5, execute: w)
    }

    func toggleTodos() {
        todosCollapseWork?.cancel()                 // user is driving now — stop the auto-collapse
        withAnimation(Self.glassSpring) { todosExpanded.toggle() }
    }

    func toggleConsole() {
        withAnimation(Self.glassSpring) {
            consoleOpen.toggle()
            if !consoleOpen { expandedAgentID = nil }   // collapse detail when the console closes
        }
    }

    func closeConsole() {
        guard consoleOpen else { return }
        withAnimation(Self.glassSpring) { consoleOpen = false; expandedAgentID = nil }
    }

    func toggleAgent(_ id: String) {
        withAnimation(Self.glassSpring) {
            expandedAgentID = (expandedAgentID == id) ? nil : id
        }
    }
}
