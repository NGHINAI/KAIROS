// GuideModel.swift — the state machine of Guide Mode.
//
// The choreography (the Clicky moment): when the agent calls guide_user, the ORB
// dissolves and a small guide comet — same liquid-light language, plus eyes — spawns
// at the orb's position, flies to the resolved element, and hovers there while a
// pulse ring highlights the target and a glass caption names it. Each further step
// glides the comet to the next element. When the turn ends (guide_end), the comet
// flies home and the orb re-forms. The element itself is resolved via AXFinder
// (Accessibility tree, ~50ms) — no screenshots, no vision-model latency.

import AppKit
import Combine

struct GuideTarget: Equatable {
    /// Element rect in OVERLAY coordinates (SwiftUI top-left origin, main screen).
    let rect: CGRect
    let label: String
}

enum GuidePhase: Equatable {
    case hidden       // orb is in charge
    case active       // comet on screen, pointing
    case returning    // comet flying home, orb about to re-form
}

final class GuideModel: ObservableObject {
    @Published var phase: GuidePhase = .hidden
    @Published var target: GuideTarget? = nil
    @Published var cometPos: CGPoint = .zero
    @Published var eyesOpen = true

    /// Answers a guide_request back to the daemon: (id, found, label, reason).
    var resultHandler: ((String, Bool, String?, String?) -> Void)? = nil
    /// Answers a control_request (click) back to the daemon: (id, ok, label, reason).
    var controlResultHandler: ((String, Bool, String?, String?) -> Void)? = nil
    /// The orb's current center in OVERLAY coordinates — comet launch + return point.
    var orbCenterProvider: (() -> CGPoint)? = nil
    /// Overlay/orb visibility hook for the panel manager (true = guide owns the screen).
    var onActiveChange: ((Bool) -> Void)? = nil

    private let axQueue = DispatchQueue(label: "kairos.guide.ax", qos: .userInitiated)
    private var blinkTimer: Timer? = nil
    private var endWorkItem: DispatchWorkItem? = nil

    // ── daemon entry points (called from DaemonClient on the main queue) ──

    func handle(id: String, find: String, app: String?) {
        axQueue.async { [weak self] in
            let result = AXFinder.find(query: find, appName: app)
            DispatchQueue.main.async {
                guard let self else { return }
                switch result {
                case .found(let match):
                    self.point(at: match)
                    self.resultHandler?(id, true, match.title, nil)
                case .notFound(let reason):
                    self.resultHandler?(id, false, nil, reason)
                }
            }
        }
    }

    /// CLICK: point at the element AND press it (a real AX action, no cursor move).
    /// The comet flies there and the highlight flashes, then the element activates —
    /// the "Ghost Hands" beat. Answers control_result back to the daemon.
    func handleClick(id: String, find: String, app: String?) {
        axQueue.async { [weak self] in
            // ONE tree walk: find the element, point at it (visual), then press THAT
            // handle — no second walk (two walks of a heavy tree blew the bridge timeout).
            let found = AXFinder.find(query: find, appName: app)
            guard case .found(let match) = found else {
                let reason: String = { if case .notFound(let r) = found { return r }; return "not found" }()
                DispatchQueue.main.async { self?.controlResultHandler?(id, false, nil, reason) }
                return
            }
            DispatchQueue.main.async { self?.point(at: match) }
            // A short beat so the comet visibly LANDS before the element activates.
            let act = AXFinder.press(match)
            DispatchQueue.main.async {
                guard let self else { return }
                switch act {
                case .ok(let label): self.controlResultHandler?(id, true, label, nil)
                case .failed(let reason): self.controlResultHandler?(id, false, nil, reason)
                }
            }
        }
    }

    func end() {
        guard phase == .active else { return }
        phase = .returning
        target = nil
        if let home = orbCenterProvider?() { cometPos = home }
        stopBlinking()
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.phase == .returning else { return }
            self.phase = .hidden
            self.onActiveChange?(false)   // orb re-forms
        }
        endWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.55, execute: work)  // after the homeward spring
    }

    // ── dev hook (--guidetest): drive the full choreography with a fake target ──

    func pointFake(rect: CGRect, label: String) {
        point(at: AXMatch(title: label, frame: appKitRect(fromOverlay: rect), element: nil))
    }

    // ── internals ──

    private func point(at match: AXMatch) {
        endWorkItem?.cancel(); endWorkItem = nil
        let rect = overlayRect(fromAppKit: match.frame)
        let wasHidden = (phase != .active)
        if wasHidden {
            cometPos = orbCenterProvider?() ?? CGPoint(x: 90, y: overlayHeight() - 90)
            phase = .active
            onActiveChange?(true)         // orb dissolves, overlay appears
            startBlinking()
        }
        // Let the launch frame render first so the flight ANIMATES from the orb's
        // position instead of popping in at the destination.
        DispatchQueue.main.asyncAfter(deadline: .now() + (wasHidden ? 0.06 : 0)) { [weak self] in
            guard let self, self.phase == .active else { return }
            self.target = GuideTarget(rect: rect, label: match.title)
            // Hover just above the element (below if it's at the very top of the screen),
            // CLAMPED on-screen — Dock icons and edge elements report frames at (or past)
            // the screen boundary, which would park the comet/caption off-screen.
            let h = self.overlayHeight()
            let w = NSScreen.main?.frame.width ?? 1920
            let hoverY = rect.minY > 64 ? rect.minY - 34 : rect.maxY + 34
            self.cometPos = CGPoint(x: min(max(rect.midX, 28), w - 28),
                                    y: min(max(hoverY, 28), h - 28))
        }
    }

    private func startBlinking() {
        stopBlinking()
        blinkTimer = Timer.scheduledTimer(withTimeInterval: 3.2, repeats: true) { [weak self] _ in
            guard let self else { return }
            self.eyesOpen = false
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.14) { self.eyesOpen = true }
        }
    }
    private func stopBlinking() { blinkTimer?.invalidate(); blinkTimer = nil }

    // AppKit screen coords (bottom-left origin) ⇄ overlay coords (top-left origin, main screen).
    private func overlayHeight() -> CGFloat { NSScreen.main?.frame.height ?? 1080 }
    private func overlayRect(fromAppKit r: CGRect) -> CGRect {
        guard let screen = NSScreen.main else { return r }
        return CGRect(x: r.minX - screen.frame.minX,
                      y: screen.frame.maxY - r.maxY,
                      width: r.width, height: r.height)
    }
    private func appKitRect(fromOverlay r: CGRect) -> CGRect {
        guard let screen = NSScreen.main else { return r }
        return CGRect(x: r.minX + screen.frame.minX,
                      y: screen.frame.maxY - r.maxY,
                      width: r.width, height: r.height)
    }
}
