// GlassTest.swift — DEV ONLY. Renders the console with REAL macOS-26 Liquid Glass over a colorful
// faux-desktop backdrop in a normal (capturable) full-screen window, screenshots it, and exits.
// This is the only way to actually SEE .glassEffect: ImageRenderer renders it empty, and the live
// HUD panel sets sharingType=.none (excluded from screencapture). The opaque fullscreen backdrop
// also guarantees the screenshot contains only our content, never the user's other windows.

import AppKit
import SwiftUI

enum GlassTest {
    @MainActor static func run(out: String) {
        guard let screen = NSScreen.main else { exit(1) }
        let win = NSWindow(contentRect: screen.frame, styleMask: [.borderless],
                           backing: .buffered, defer: false)
        win.level = .floating
        win.isOpaque = true
        win.setFrame(screen.frame, display: true)
        win.contentView = NSHostingView(rootView: GlassTestRoot())
        win.makeKeyAndOrderFront(nil)
        win.orderFrontRegardless()
        // Give the GPU a beat to composite the glass, then capture the whole screen and quit.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.8) {
            let p = Process()
            p.launchPath = "/usr/sbin/screencapture"
            p.arguments = ["-x", out]
            try? p.run(); p.waitUntilExit()
            FileHandle.standardError.write("glasstest: wrote \(out)\n".data(using: .utf8)!)
            exit(0)
        }
    }
}

private struct GlassTestRoot: View {
    @StateObject private var activity = ActivityModel()
    @StateObject private var bg = BackgroundModel()
    @StateObject private var approval = ApprovalModel()
    @StateObject private var hud = HUDState()

    var body: some View {
        ZStack {
            // Faux colorful desktop so the glass has rich content/edges to refract & tint.
            LinearGradient(colors: [Color(red: 0.10, green: 0.35, blue: 0.95),
                                    Color(red: 0.55, green: 0.20, blue: 0.85),
                                    Color(red: 0.95, green: 0.35, blue: 0.55),
                                    Color(red: 0.98, green: 0.62, blue: 0.25)],
                           startPoint: .topLeading, endPoint: .bottomTrailing)
            Circle().fill(.white.opacity(0.55)).frame(width: 360).blur(radius: 50).offset(x: -260, y: -180)
            Circle().fill(.cyan.opacity(0.7)).frame(width: 300).blur(radius: 50).offset(x: 300, y: 240)
            // App icon grid feel — a few sharp tiles so refraction/edges are obvious through the glass.
            HStack(spacing: 26) {
                ForEach(0..<5) { i in
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .fill(.white.opacity(0.18)).frame(width: 80, height: 80)
                        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(.white.opacity(0.3)))
                        .offset(y: CGFloat(i % 2 == 0 ? -10 : 10))
                }
            }

            // LEFT: isolated glass-style swatches to see what .glassEffect actually renders.
            // RIGHT: the console (real glass).
            HStack(alignment: .top, spacing: 40) {
                swatches
                ConsoleView(activity: activity, bg: bg, hud: hud, approval: approval)
                    .environment(\.glassEnabled, true)
                Spacer()
            }
            .padding(48)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .ignoresSafeArea()
        .onAppear { seed() }
    }

    private var swatches: some View {
        GlassEffectContainer(spacing: 14) {
            VStack(alignment: .leading, spacing: 14) {
                label(".regular") { Capsule().glassEffect(.regular, in: Capsule()) }
                label("frost .white 0.25") { Capsule().glassEffect(.regular.tint(.white.opacity(0.25)), in: Capsule()) }
                label("frost .white 0.35") { Capsule().glassEffect(.regular.tint(.white.opacity(0.35)), in: Capsule()) }
                label("frost .white 0.5") { Capsule().glassEffect(.regular.tint(.white.opacity(0.5)), in: Capsule()) }
                label("frost + interactive") { Capsule().glassEffect(.regular.tint(.white.opacity(0.35)).interactive(), in: Capsule()) }
                Button("Glass Button") {}.buttonStyle(.glass).controlSize(.large)
            }
            .frame(width: 230)
        }
    }

    @ViewBuilder private func label<V: View>(_ t: String, _ swatch: () -> V) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(t).font(.system(size: 11, weight: .semibold)).foregroundStyle(.white)
            swatch().frame(height: 46)
        }
    }

    private func seed() {
        activity.intent(tier: "smart"); activity.setStatus("Working on your calendar")
        activity.toolCall(id: "1", name: DaemonClient.humanizeTool("GMAIL_FETCH_EMAILS"))
        activity.toolDone(id: "1", summary: DaemonClient.humanizeSummary("{\"successful\":true,\"data\":{\"messages\":[{},{},{}]}}"))
        activity.toolCall(id: "2", name: DaemonClient.humanizeTool("GOOGLECALENDAR_CREATE_EVENT"))
        bg.spawned(id: "bg-inbox", goal: "Organize my inbox")
        bg.tool(id: "bg-inbox", name: DaemonClient.humanizeTool("GMAIL_FETCH_EMAILS"))
        bg.tool(id: "bg-inbox", name: DaemonClient.humanizeTool("GMAIL_MODIFY_LABELS"))
        bg.progress(id: "bg-inbox", note: DaemonClient.humanizeNote("using GMAIL_MODIFY_LABELS"))
        bg.spawned(id: "bg-flights", goal: "Research SF→Tokyo flights")
        bg.progress(id: "bg-flights", note: "comparing 6 itineraries…")
        approval.request(id: "ap-1", summary: "Send the weekly report email to the team",
                         toolName: DaemonClient.humanizeTool("GMAIL_SEND_EMAIL"))
        hud.consoleOpen = true
        hud.todosExpanded = true
        hud.expandedAgentID = "bg-inbox"
    }
}
