// AppDelegate.swift — boots the HUD surfaces.
//
// Wave 1, step 1: stand up the OrbPanelManager (the one persistent surface) and, until the
// WebSocket Transport lands (next step), drive the orb with the MockDriver so `swift run`
// shows a living orb immediately. Pass no flag and it still mocks for now; once Transport is
// wired, `--mock` will be what forces daemon-free mode.

import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    let model = OrbModel()
    let activity = ActivityModel()
    private var orbManager: OrbPanelManager?
    private var mock: MockDriver?
    private var daemon: DaemonClient?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let manager = OrbPanelManager(model: model, activity: activity)
        manager.show()
        orbManager = manager

        if CommandLine.arguments.contains("--mock") {
            // Daemon-free dev: scripted state/level + tool-call cycle.
            let driver = MockDriver(model: model, activity: activity)
            driver.start()
            mock = driver
        } else {
            // Live: react to the real daemon's voice + activity events (auto-reconnects if it's down).
            let client = DaemonClient(model: model, activity: activity, port: kairosDaemonPort())
            client.connect()
            daemon = client
        }
    }
}
