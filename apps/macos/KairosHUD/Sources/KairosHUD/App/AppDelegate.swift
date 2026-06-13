// AppDelegate.swift — boots the HUD surfaces.
//
// Wave 1, step 1: stand up the OrbPanelManager (the one persistent surface) and, until the
// WebSocket Transport lands (next step), drive the orb with the MockDriver so `swift run`
// shows a living orb immediately. Pass no flag and it still mocks for now; once Transport is
// wired, `--mock` will be what forces daemon-free mode.

import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    let model = OrbModel()
    let activity = ActivityModel()          // Lane A — the live foreground turn
    let background = BackgroundModel()      // Lane B — background sub-agents
    let approval = ApprovalModel()          // pending approvals (Approve/Deny; voice also works)
    let hud = HUDState()                    // console open / which agent is expanded
    let guide = GuideModel()                // Guide Mode — the orb morphs into the on-screen guide
    private var orbManager: OrbPanelManager?
    private var mock: MockDriver?
    private var daemon: DaemonClient?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // A new to-do (approval) briefly flashes the To-dos list open, then it tucks away.
        approval.onNewItem = { [weak hud] in hud?.peekTodos() }

        let manager = OrbPanelManager(model: model, activity: activity, background: background,
                                      approval: approval, hud: hud, guide: guide)
        manager.show()
        orbManager = manager

        if CommandLine.arguments.contains("--mock") {
            // Daemon-free dev: scripted state/level + Lane A turn + Lane B agents + a mock approval.
            let driver = MockDriver(model: model, activity: activity, background: background, approval: approval)
            driver.start()
            mock = driver
        } else {
            // Live: react to the real daemon's voice + activity events (auto-reconnects if it's down).
            let client = DaemonClient(model: model, activity: activity, background: background,
                                      approval: approval, guide: guide, port: kairosDaemonPort())
            approval.resolveHandler = { [weak client] id, ok in client?.resolve(id, approve: ok) }
            guide.resultHandler = { [weak client] id, found, label, reason in
                client?.sendGuideResult(id: id, found: found, label: label, reason: reason)
            }
            guide.screenResultHandler = { [weak client] id, ok, summary, reason in
                client?.sendScreenResult(id: id, ok: ok, summary: summary, reason: reason)
            }
            client.connect()
            daemon = client
        }

        // --guidetest: rehearse the full Guide Mode choreography with FAKE targets
        // (no daemon, no AX permission needed) — the orb dissolves, the comet flies to
        // two "elements", highlights + captions them, then flies home and the orb
        // re-forms. Use this to eyeball the animation before recording a demo.
        if CommandLine.arguments.contains("--guidetest") {
            let g = guide
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
                g.pointFake(rect: CGRect(x: 560, y: 210, width: 170, height: 36), label: "Export…")
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 5.2) {
                g.pointFake(rect: CGRect(x: 940, y: 430, width: 230, height: 44), label: "Privacy & Security")
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 8.6) { g.end() }
        }
    }
}
