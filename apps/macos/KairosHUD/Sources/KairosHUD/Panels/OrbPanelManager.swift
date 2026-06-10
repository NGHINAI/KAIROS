// OrbPanelManager.swift — owns the orb panel (Metal orb + rim count badge) and a separate Liquid
// Glass console panel below it.
//
// At rest the orb is the entire footprint. A single gesture drives everything: a CLICK on the orb
// toggles the console; a DRAG moves the orb (position persisted). The console panel stays ordered-in
// once first shown and animates its content in/out (no instant orderOut), so every reveal is fluid.

import AppKit
import SwiftUI
import Combine

/// The orb's interactive backing view. Distinguishes a tap (→ toggle console) from a drag (→ move the
/// window), and is only hit-testable within the orb's circle so the panel's transparent corners stay
/// click-through. All clicks route here (hitTest returns self), so the Metal layer + badge never eat them.
final class OrbHostView: NSView {
    var onTap: (() -> Void)?
    var hitRadius: CGFloat = 72
    private var downAt: NSPoint = .zero
    private var dragging = false

    override func hitTest(_ point: NSPoint) -> NSView? {
        let p = convert(point, from: superview)
        let c = NSPoint(x: bounds.midX, y: bounds.midY)
        return hypot(p.x - c.x, p.y - c.y) <= hitRadius ? self : nil
    }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with e: NSEvent) { downAt = e.locationInWindow; dragging = false }
    override func mouseDragged(with e: NSEvent) {
        if hypot(e.locationInWindow.x - downAt.x, e.locationInWindow.y - downAt.y) > 4 {
            dragging = true
            window?.performDrag(with: e)
        }
    }
    override func mouseUp(with e: NSEvent) { if !dragging { onTap?() } }
}

/// Top-aligned host for the console so it grows downward from just under the orb.
private struct ConsoleHostView: View {
    @ObservedObject var activity: ActivityModel
    @ObservedObject var bg: BackgroundModel
    @ObservedObject var approval: ApprovalModel
    @ObservedObject var hud: HUDState
    var body: some View {
        VStack(spacing: 0) {
            if hud.consoleOpen {
                ConsoleView(activity: activity, bg: bg, hud: hud, approval: approval)
                    .transition(.scale(scale: 0.94, anchor: .top).combined(with: .opacity))
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .padding(.top, 4)
    }
}

final class OrbPanelManager {
    private let panel: NonActivatingHUDPanel
    private let consolePanel: NonActivatingHUDPanel
    private let guidePanel: NonActivatingHUDPanel
    private let model: OrbModel
    private let activity: ActivityModel
    private let bg: BackgroundModel
    private let approval: ApprovalModel
    private let hud: HUDState
    private let guide: GuideModel
    private let orb: MetalOrb?
    private let size = NSSize(width: 200, height: 200)
    private let consoleSize = NSSize(width: 380, height: 600)
    private let posKey = "KairosHUD.orbOrigin.v2"   // bumped: ignore the old top-center saved origin
    private var cancellables = Set<AnyCancellable>()
    private var outsideMonitor: Any?

    init(model: OrbModel, activity: ActivityModel, background: BackgroundModel, approval: ApprovalModel,
         hud: HUDState, guide: GuideModel) {
        self.model = model
        self.activity = activity
        self.bg = background
        self.approval = approval
        self.hud = hud
        self.guide = guide
        self.orb = MetalOrb()

        // Orb panel: Metal orb + rim count badge. The host view owns clicks (tap vs drag).
        panel = NonActivatingHUDPanel(contentRect: NSRect(origin: .zero, size: size))
        panel.isMovableByWindowBackground = false               // the host drives drag via performDrag
        let host = OrbHostView(frame: NSRect(origin: .zero, size: size))
        host.onTap = { [weak hud] in hud?.toggleConsole() }
        let orbView = MetalOrbView(model: model, orb: orb)
        orbView.frame = host.bounds; orbView.autoresizingMask = [.width, .height]
        host.addSubview(orbView)
        let badge = NSHostingView(rootView: OrbBadgeOverlay(bg: background, approval: approval))
        badge.frame = host.bounds; badge.autoresizingMask = [.width, .height]
        badge.wantsLayer = true; badge.layer?.backgroundColor = .clear
        host.addSubview(badge)
        panel.contentView = host

        // Console panel: Liquid Glass, click-through until opened.
        consolePanel = NonActivatingHUDPanel(contentRect: NSRect(origin: .zero, size: consoleSize))
        consolePanel.isMovableByWindowBackground = false
        consolePanel.ignoresMouseEvents = true
        let console = NSHostingView(rootView: ConsoleHostView(activity: activity, bg: background, approval: approval, hud: hud))
        console.frame = NSRect(origin: .zero, size: consoleSize); console.autoresizingMask = [.width, .height]
        console.wantsLayer = true; console.layer?.backgroundColor = .clear
        consolePanel.contentView = console

        // Guide panel: full-screen, ALWAYS click-through — the stage the guide comet
        // flies on. Hidden until a guide begins; while active the orb panel fades out
        // (the morph illusion: orb dissolves, comet rises at its position).
        let screenFrame = NSScreen.main?.frame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        guidePanel = NonActivatingHUDPanel(contentRect: screenFrame)
        guidePanel.isMovableByWindowBackground = false
        guidePanel.ignoresMouseEvents = true
        guidePanel.level = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 2)
        let guideHost = NSHostingView(rootView: GuideOverlayView(model: guide))
        guideHost.frame = NSRect(origin: .zero, size: screenFrame.size)
        guideHost.autoresizingMask = [.width, .height]
        guideHost.wantsLayer = true; guideHost.layer?.backgroundColor = .clear
        guidePanel.contentView = guideHost
    }

    func show() {
        restorePosition()
        panel.orderFrontRegardless()
        positionConsole()   // pre-place the (still-hidden) console so its first open is instant
        NotificationCenter.default.addObserver(self, selector: #selector(didMove),
                                               name: NSWindow.didMoveNotification, object: panel)
        hud.$consoleOpen.receive(on: DispatchQueue.main).sink { [weak self] open in
            self?.consoleVisibility(open)
        }.store(in: &cancellables)

        // Guide Mode wiring: the comet launches from (and returns to) wherever the orb
        // currently sits, and the orb dissolves while the guide owns the screen.
        guide.orbCenterProvider = { [weak self] in self?.orbCenterInOverlayCoords() ?? CGPoint(x: 90, y: 90) }
        guide.onActiveChange = { [weak self] active in self?.guideVisibility(active) }
    }

    /// The orb's center expressed in the guide overlay's SwiftUI coordinates
    /// (top-left origin on the main screen) — the comet's launch/return point.
    private func orbCenterInOverlayCoords() -> CGPoint {
        guard let screen = NSScreen.main else { return CGPoint(x: 90, y: 90) }
        let f = panel.frame
        let center = CGPoint(x: f.midX, y: f.midY)
        return CGPoint(x: center.x - screen.frame.minX, y: screen.frame.maxY - center.y)
    }

    /// Orb ⇄ guide morph: fade the orb out as the overlay comes up, back in when done.
    private func guideVisibility(_ active: Bool) {
        if active {
            if let screen = NSScreen.main { guidePanel.setFrame(screen.frame, display: true) }
            guidePanel.orderFrontRegardless()
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.28
                panel.animator().alphaValue = 0
            }
        } else {
            NSAnimationContext.runAnimationGroup({ ctx in
                ctx.duration = 0.30
                panel.animator().alphaValue = 1
            }, completionHandler: { [weak self] in
                self?.guidePanel.orderOut(nil)
            })
        }
    }

    private func consoleVisibility(_ open: Bool) {
        if open {
            positionConsole()
            consolePanel.ignoresMouseEvents = false
            consolePanel.orderFrontRegardless()
            addOutsideMonitor()
        } else {
            consolePanel.ignoresMouseEvents = true       // click-through; content animates out on its own
            removeOutsideMonitor()
        }
    }

    // Close the console when the user clicks anywhere outside our windows.
    private func addOutsideMonitor() {
        guard outsideMonitor == nil else { return }
        outsideMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            self?.hud.closeConsole()
        }
    }
    private func removeOutsideMonitor() {
        if let m = outsideMonitor { NSEvent.removeMonitor(m); outsideMonitor = nil }
    }

    @objc private func didMove() {
        // Persist the orb's position. The console is intentionally NOT repositioned here — it stays
        // anchored at the screen's top-left, so dragging the orb moves ONLY the orb (no console jank).
        UserDefaults.standard.set(NSStringFromPoint(panel.frame.origin), forKey: posKey)
    }

    /// The console is fixed at the TOP-LEFT of the orb's screen (below the menu bar / Apple icon,
    /// inset from the left), growing downward as more agent boxes appear. It does not track the orb.
    private func positionConsole() {
        let f = panel.frame
        let screen = NSScreen.screens.first(where: { $0.frame.intersects(f) }) ?? NSScreen.main
        guard let vf = screen?.visibleFrame else { return }
        let topInset: CGFloat = 10      // space below the menu bar / Apple icon
        let leftInset: CGFloat = 16     // space from the left edge
        let x = vf.minX + leftInset
        let y = vf.maxY - topInset - consoleSize.height   // panel top sits just under the menu bar
        consolePanel.setFrameOrigin(NSPoint(x: x, y: y))
    }

    private func restorePosition() {
        if let s = UserDefaults.standard.string(forKey: posKey) {
            let origin = NSPointFromString(s)
            let center = NSPoint(x: origin.x + size.width / 2, y: origin.y + size.height / 2)
            if NSScreen.screens.contains(where: { $0.frame.contains(center) }) {
                panel.setFrameOrigin(origin); return
            }
        }
        positionDefault()
    }

    /// Default = BOTTOM-LEFT, just above the dock, with a little breathing room from the left edge.
    /// `visibleFrame` already excludes the dock + menu bar, so its min corner is the usable bottom-left;
    /// the margins below are measured to the ORB'S CENTER (the 200pt panel is mostly transparent padding).
    private func positionDefault() {
        guard let screen = NSScreen.main else { return }
        let vf = screen.visibleFrame
        let centerFromLeft: CGFloat = 76     // orb center inset from the left edge
        let centerFromBottom: CGFloat = 72   // orb center above the dock
        let x = vf.minX + centerFromLeft - size.width / 2
        let y = vf.minY + centerFromBottom - size.height / 2
        panel.setFrameOrigin(NSPoint(x: x, y: y))
    }
}
