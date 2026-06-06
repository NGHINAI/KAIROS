// OrbPanelManager.swift — owns the orb panel (Metal orb + Lane-A activity nodes overlay) and a
// transparent card panel below it that shows the live timeline during a turn.

import AppKit
import SwiftUI
import Combine

final class OrbPanelManager {
    private let panel: NonActivatingHUDPanel
    private let cardPanel: NonActivatingHUDPanel
    private let model: OrbModel
    private let activity: ActivityModel
    private let orb: MetalOrb?
    private let size = NSSize(width: 200, height: 200)
    private let cardSize = NSSize(width: 290, height: 260)
    private let posKey = "KairosHUD.orbOrigin"
    private var cancellables = Set<AnyCancellable>()

    init(model: OrbModel, activity: ActivityModel) {
        self.model = model
        self.activity = activity
        self.orb = MetalOrb()

        // Orb panel: Metal orb (background) + activity nodes overlay (transparent, non-interactive).
        panel = NonActivatingHUDPanel(contentRect: NSRect(origin: .zero, size: size))
        let container = NSView(frame: NSRect(origin: .zero, size: size))
        let orbView = MetalOrbView(model: model, orb: orb)
        orbView.frame = container.bounds; orbView.autoresizingMask = [.width, .height]
        container.addSubview(orbView)
        let nodes = NSHostingView(rootView: ActivityNodesView(activity: activity))
        nodes.frame = container.bounds; nodes.autoresizingMask = [.width, .height]
        nodes.wantsLayer = true; nodes.layer?.backgroundColor = .clear
        container.addSubview(nodes)
        panel.contentView = container

        // Card panel: read-only (click-through), transparent, hosts the timeline card.
        cardPanel = NonActivatingHUDPanel(contentRect: NSRect(origin: .zero, size: cardSize))
        cardPanel.ignoresMouseEvents = true
        cardPanel.isMovableByWindowBackground = false
        let card = NSHostingView(rootView: ActivityCardContainer(activity: activity))
        card.frame = NSRect(origin: .zero, size: cardSize); card.autoresizingMask = [.width, .height]
        card.wantsLayer = true; card.layer?.backgroundColor = .clear
        cardPanel.contentView = card
    }

    func show() {
        restorePosition()
        panel.orderFrontRegardless()
        NotificationCenter.default.addObserver(self, selector: #selector(didMove), name: NSWindow.didMoveNotification, object: panel)
        // Show the card while a turn is active; keep it tucked under the orb.
        activity.$active.receive(on: RunLoop.main).sink { [weak self] active in
            guard let self else { return }
            if active { self.positionCard(); self.cardPanel.orderFrontRegardless() }
            else { self.cardPanel.orderOut(nil) }
        }.store(in: &cancellables)
    }

    @objc private func didMove() {
        UserDefaults.standard.set(NSStringFromPoint(panel.frame.origin), forKey: posKey)
        if activity.active { positionCard() }
    }

    private func positionCard() {
        let f = panel.frame
        cardPanel.setFrameOrigin(NSPoint(x: f.midX - cardSize.width / 2, y: f.minY - cardSize.height - 2))
    }

    private func restorePosition() {
        if let s = UserDefaults.standard.string(forKey: posKey) {
            let origin = NSPointFromString(s)
            let center = NSPoint(x: origin.x + size.width / 2, y: origin.y + size.height / 2)
            if NSScreen.screens.contains(where: { $0.frame.contains(center) }) {
                panel.setFrameOrigin(origin); return
            }
        }
        positionTopCenter()
    }

    private func positionTopCenter() {
        guard let screen = NSScreen.main else { return }
        let f = screen.frame
        let topInset = screen.safeAreaInsets.top
        panel.setFrameOrigin(NSPoint(x: f.midX - size.width / 2, y: f.maxY - size.height - max(topInset, 8) + 6))
    }
}
