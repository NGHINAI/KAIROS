// AppDelegate.swift — boots the HUD surfaces.
//
// Wave 1, step 1: stand up the OrbPanelManager (the one persistent surface) and, until the
// WebSocket Transport lands (next step), drive the orb with the MockDriver so `swift run`
// shows a living orb immediately. Pass no flag and it still mocks for now; once Transport is
// wired, `--mock` will be what forces daemon-free mode.

import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    let model = OrbModel()
    private var orbManager: OrbPanelManager?
    private var mock: MockDriver?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let manager = OrbPanelManager(model: model)
        manager.show()
        orbManager = manager

        // First cut: always mock (Transport wired in the next build step).
        let driver = MockDriver(model: model)
        driver.start()
        mock = driver
    }
}
