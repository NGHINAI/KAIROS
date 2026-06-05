// OrbPanelManager.swift — owns the one persistent surface: the floating orb panel.
//
// Mirrors HeyClicky's per-surface *WindowManager pattern: owns the NSPanel lifecycle and hosts the
// Metal orb view. The panel is draggable anywhere (never steals focus) and remembers its position.

import AppKit

final class OrbPanelManager {
    private let panel: NonActivatingHUDPanel
    private let model: OrbModel
    private let orb: MetalOrb?
    private let size = NSSize(width: 200, height: 200)   // smaller
    private let posKey = "KairosHUD.orbOrigin"

    init(model: OrbModel) {
        self.model = model
        self.orb = MetalOrb()
        panel = NonActivatingHUDPanel(contentRect: NSRect(origin: .zero, size: size))

        let view = MetalOrbView(model: model, orb: orb)
        view.frame = NSRect(origin: .zero, size: size)
        view.autoresizingMask = [.width, .height]
        panel.contentView = view
    }

    func show() {
        restorePosition()
        panel.orderFrontRegardless()
        // Remember wherever the user drags it.
        NotificationCenter.default.addObserver(
            self, selector: #selector(didMove), name: NSWindow.didMoveNotification, object: panel)
    }

    @objc private func didMove() {
        UserDefaults.standard.set(NSStringFromPoint(panel.frame.origin), forKey: posKey)
    }

    private func restorePosition() {
        if let s = UserDefaults.standard.string(forKey: posKey) {
            let origin = NSPointFromString(s)
            // only restore if it lands on a visible screen, else fall back to the default spot
            if NSScreen.screens.contains(where: { $0.frame.contains(NSPoint(x: origin.x + size.width / 2, y: origin.y + size.height / 2)) }) {
                panel.setFrameOrigin(origin)
                return
            }
        }
        positionTopCenter()
    }

    /// Default spot: centered at the top of the main screen, tucked under the notch when present.
    private func positionTopCenter() {
        guard let screen = NSScreen.main else { return }
        let f = screen.frame
        let topInset = screen.safeAreaInsets.top
        panel.setFrameOrigin(NSPoint(x: f.midX - size.width / 2, y: f.maxY - size.height - max(topInset, 8) + 6))
    }
}
