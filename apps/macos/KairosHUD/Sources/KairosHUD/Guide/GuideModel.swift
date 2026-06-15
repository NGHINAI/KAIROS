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
    /// Dynamic scroll cue: "down"/"up" while a scroll arrow is shown, nil otherwise.
    /// The USER scrolls — KAIROS never actuates the scroll; this is a directional hint.
    @Published var scrollDirection: String? = nil
    /// The scroll area's rect in OVERLAY coords — the arrow anchors to its edge. nil ⇒
    /// the view falls back to a screen-edge default.
    @Published var scrollAnchorRect: CGRect? = nil

    /// Answers a guide_request back to the daemon: (id, found, label, reason).
    var resultHandler: ((String, Bool, String?, String?) -> Void)? = nil
    /// Answers a screen_request back to the daemon: (id, ok, summary, reason).
    var screenResultHandler: ((String, Bool, String?, String?) -> Void)? = nil
    /// Answers a scroll_request back to the daemon: (id, found, reason, newSummary).
    var scrollResultHandler: ((String, Bool, String?, String?) -> Void)? = nil
    /// The orb's current center in OVERLAY coordinates — comet launch + return point.
    var orbCenterProvider: (() -> CGPoint)? = nil
    /// Overlay/orb visibility hook for the panel manager (true = guide owns the screen).
    var onActiveChange: ((Bool) -> Void)? = nil

    private let axQueue = DispatchQueue(label: "kairos.guide.ax", qos: .userInitiated)
    private var blinkTimer: Timer? = nil
    private var endWorkItem: DispatchWorkItem? = nil

    // ── daemon entry points (called from DaemonClient on the main queue) ──

    func handle(id: String, find: String?, element: Int?, app: String?) {
        let t0 = Date()
        // ELEMENT mode (grounded): the number indexes the cached read_screen snapshot.
        // Re-resolve by the SEEN label for a fresh rect (the pane may have scrolled);
        // the snapshot's cached frame is the fallback when the live find misses.
        var query = find ?? ""
        var cachedFallback: AXMatch? = nil
        if let element, element >= 1, element <= snapshot.count {
            let entry = snapshot[element - 1]
            query = entry.label
            cachedFallback = AXMatch(title: entry.label, frame: entry.frame)
        } else if let element {
            resultHandler?(id, false, nil, "element #\(element) isn't in the last read_screen snapshot (\(snapshot.count) entries) — call read_screen again")
            return
        }
        guard !query.isEmpty else {
            resultHandler?(id, false, nil, "nothing to point at — give an element number from read_screen or a label")
            return
        }
        axQueue.async { [weak self] in
            let result = AXFinder.find(query: query, appName: app)
            DispatchQueue.main.async {
                guard let self else { return }
                let ms = Int(Date().timeIntervalSince(t0) * 1000)
                switch result {
                case .found(let match):
                    FileHandle.standardError.write("guide_result FOUND \"\(match.title)\" in \(ms)ms\n".data(using: .utf8)!)
                    self.point(at: match)
                    self.resultHandler?(id, true, match.title, nil)
                case .notFound(let reason):
                    if let cached = cachedFallback {
                        // Live find missed but the snapshot saw it — point at the cached rect.
                        FileHandle.standardError.write("guide_result cached-frame \"\(cached.title)\" in \(ms)ms\n".data(using: .utf8)!)
                        self.point(at: cached)
                        self.resultHandler?(id, true, cached.title, nil)
                    } else {
                        FileHandle.standardError.write("guide_result not-found (\(reason)) in \(ms)ms\n".data(using: .utf8)!)
                        self.resultHandler?(id, false, nil, reason)
                    }
                }
            }
        }
    }

    /// wait_for_screen: poll the AX tree until `find` exists (the user completed the
    /// step) or the deadline passes. The walkthrough heartbeat — auto-advance without
    /// the user announcing "done". A newer watch or guide end cancels a pending one.
    private var watchGeneration = 0
    func handleWatch(id: String, find: String, app: String?, timeoutMs: Double) {
        watchGeneration += 1
        let gen = watchGeneration
        let deadline = Date().addingTimeInterval(max(timeoutMs, 1000) / 1000)
        func poll() {
            axQueue.async { [weak self] in
                guard let self else { return }
                if gen != self.watchGeneration {
                    DispatchQueue.main.async { self.resultHandler?(id, false, nil, "watch superseded") }
                    return
                }
                let result = AXFinder.find(query: find, appName: app)
                DispatchQueue.main.async {
                    guard gen == self.watchGeneration else { self.resultHandler?(id, false, nil, "watch superseded"); return }
                    if case .found(let match) = result {
                        self.resultHandler?(id, true, match.title, nil)
                    } else if Date() > deadline {
                        self.resultHandler?(id, false, nil, "not seen within the wait window")
                    } else {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { poll() }
                    }
                }
            }
        }
        poll()
    }

    /// ACT MODE (computer use): resolve the element exactly like a guide point, fly
    /// the comet to it (the user SEES each step as it happens), then PRESS it (or
    /// set its value) via AXActor. Element-index/label addressing only — the model
    /// can never click raw coordinates, by construction.
    func handleAct(id: String, find: String?, element: Int?, app: String?, action: String, text: String?, submit: Bool, confirm: Bool, confirmGuard: String?) {
        let t0 = Date()
        var query = find ?? ""
        if let element, element >= 1, element <= snapshot.count {
            query = snapshot[element - 1].label
        } else if let element {
            resultHandler?(id, false, nil, "element #\(element) isn't in the last read_screen snapshot (\(snapshot.count) entries) — call read_screen again")
            return
        }
        guard !query.isEmpty else {
            resultHandler?(id, false, nil, "nothing to act on — give an element number from read_screen or a label")
            return
        }
        axQueue.async { [weak self] in
            let found = AXFinder.find(query: query, appName: app)
            guard case .found(let match) = found else {
                if case .notFound(let reason) = found {
                    DispatchQueue.main.async { self?.resultHandler?(id, false, nil, reason) }
                }
                return
            }
            // CONFIRM GATE — checked on the RESOLVED label, BEFORE anything happens.
            // The comet still flies to it (the user sees exactly what KAIROS wants to
            // press while it asks out loud), but the press itself is refused.
            if !confirm, action == "press", let pattern = confirmGuard,
               match.title.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil {
                DispatchQueue.main.async {
                    self?.point(at: match)
                    self?.resultHandler?(id, false, match.title, "needs_confirm")
                }
                return
            }
            // Show the step BEFORE doing it — the comet lands on the element, then
            // the press happens. This is the "watch it work" choreography.
            DispatchQueue.main.async { self?.point(at: match) }
            usleep(420_000)   // let the flight land so the user's eye arrives with the action
            // CHANGED-DETECTION: snapshot the inventory hash before and after the
            // act. An act that "succeeds" without changing the screen (AXPress on a
            // row that didn't navigate) must SAY SO — the model click-looped blind
            // for 30s when success claims weren't grounded (live 2026-06-11).
            func quickSummary() -> String? {
                if case .ok(let s, _) = AXFinder.inventory(appName: app) { return s }
                return nil
            }
            let pre = quickSummary()
            let failure: String?
            var mode = "press"
            switch action {
            case "set_value":
                failure = AXActor.setValue(text ?? "", on: match, submit: submit)
            default:
                let r = AXActor.press(match)
                failure = r.0
                mode = r.1
            }
            var verdict: String? = nil
            if failure == nil {
                usleep(700_000)   // let the UI settle before re-reading
                let post = quickSummary()
                if let pre, let post {
                    if pre != post {
                        verdict = "changed"
                    } else {
                        // Strategy-aware: row SELECTION must change the screen
                        // (navigation); a BUTTON press that leaves the inventory
                        // identical is normal for toggles — the press itself is
                        // the success signal (live: clicking "Light" flipped the
                        // OS appearance with zero inventory delta).
                        verdict = (mode == "select") ? "unchanged" : "pressed"
                    }
                }
            }
            let ms = Int(Date().timeIntervalSince(t0) * 1000)
            DispatchQueue.main.async {
                guard let self else { return }
                if let failure {
                    FileHandle.standardError.write("act_result FAILED \"\(match.title)\" (\(failure)) in \(ms)ms\n".data(using: .utf8)!)
                    self.resultHandler?(id, false, match.title, failure)
                } else {
                    FileHandle.standardError.write("act_result OK \(action) \"\(match.title)\" \(verdict ?? "unverified") in \(ms)ms\n".data(using: .utf8)!)
                    self.resultHandler?(id, true, match.title, verdict)
                }
            }
        }
    }

    /// Between-turns lesson heartbeat: poll the app's inventory until it DIFFERS from
    /// the first reading (the user clicked the highlighted step → a pane opened) or
    /// the deadline passes. Shares watchGeneration with handleWatch so the newest
    /// watch always wins. Does NOT touch `snapshot` — element addressing stays owned
    /// by read_screen.
    func handleWatchChange(id: String, app: String?, timeoutMs: Double) {
        watchGeneration += 1
        let gen = watchGeneration
        let deadline = Date().addingTimeInterval(max(timeoutMs, 1000) / 1000)
        var baseline: String? = nil
        func poll() {
            axQueue.async { [weak self] in
                guard let self else { return }
                if gen != self.watchGeneration {
                    DispatchQueue.main.async { self.resultHandler?(id, false, nil, "watch superseded") }
                    return
                }
                let result = AXFinder.inventory(appName: app)
                DispatchQueue.main.async {
                    guard gen == self.watchGeneration else { self.resultHandler?(id, false, nil, "watch superseded"); return }
                    if case .ok(let summary, _) = result {
                        if baseline == nil {
                            baseline = summary
                        } else if summary != baseline {
                            FileHandle.standardError.write("watch_change CHANGED app=\(app ?? "frontmost")\n".data(using: .utf8)!)
                            self.resultHandler?(id, true, "screen changed", nil)
                            return
                        }
                    }
                    // .failed = transient AX hiccup (app relaunching, tree settling) — keep polling.
                    if Date() > deadline {
                        self.resultHandler?(id, false, nil, "no change within the watch window")
                    } else {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { poll() }
                    }
                }
            }
        }
        poll()
    }

    /// read_screen: the element inventory of an app — READ-ONLY, no visual change.
    /// The numbered snapshot is CACHED: guide-by-element points into it (you can
    /// only point at what you've seen — Cua's element_index, adapted to pointing).
    private var snapshot: [AXInventoryEntry] = []
    func handleScreen(id: String, app: String?) {
        let t0 = Date()
        axQueue.async { [weak self] in
            let queuedMs = Int(Date().timeIntervalSince(t0) * 1000)
            let result = AXFinder.inventory(appName: app)
            let walkMs = Int(Date().timeIntervalSince(t0) * 1000) - queuedMs
            DispatchQueue.main.async {
                guard let self else { return }
                let totalMs = Int(Date().timeIntervalSince(t0) * 1000)
                FileHandle.standardError.write("screen_result queued=\(queuedMs)ms walk=\(walkMs)ms total=\(totalMs)ms\n".data(using: .utf8)!)
                switch result {
                case .ok(let summary, let entries):
                    self.snapshot = entries
                    self.screenResultHandler?(id, true, summary, nil)
                case .failed(let reason):
                    self.screenResultHandler?(id, false, nil, reason)
                }
            }
        }
    }

    /// guide_scroll: show a directional arrow + "scroll down/up" cue at the scroll area
    /// that holds the off-screen target. ARROW-ONLY — KAIROS never auto-scrolls; the user
    /// does. Resolves the target's scroll viewport from the cached read_screen snapshot
    /// for the anchor; falls back to the element frame, then a screen-edge default.
    /// Always replies found:true immediately — the cue is purely advisory, never blocks.
    func handleScroll(id: String, direction: String, targetElement: Int?, app: String?) {
        var anchor: CGRect? = nil
        if let element = targetElement, element >= 1, element <= snapshot.count {
            let entry = snapshot[element - 1]
            // Prefer the scroll area's rect (the arrow hugs the viewport edge); fall back
            // to the element's own frame when the viewport wasn't resolvable at snapshot.
            if let viewport = entry.scrollViewport {
                anchor = overlayRect(fromAppKit: viewport)
            } else {
                anchor = overlayRect(fromAppKit: entry.frame)
            }
        }
        FileHandle.standardError.write("scroll_request dir=\(direction) element=\(targetElement.map(String.init) ?? "-") anchor=\(anchor != nil ? "viewport" : "edge-default")\n".data(using: .utf8)!)

        scrollDirection = direction
        scrollAnchorRect = anchor
        // Reveal the overlay if it's hidden (mirrors point(at:)'s reveal) so the arrow is
        // visible even without an active comet. Keeps any in-flight comet logic intact.
        if phase != .active {
            endWorkItem?.cancel(); endWorkItem = nil
            cometPos = orbCenterProvider?() ?? CGPoint(x: 90, y: overlayHeight() - 90)
            phase = .active
            onActiveChange?(true)         // orb dissolves, overlay appears
            startBlinking()
        }
        scrollResultHandler?(id, true, nil, "arrow-shown")
    }

    func end() {
        watchGeneration += 1            // cancel any pending step-watch
        scrollDirection = nil; scrollAnchorRect = nil   // drop any scroll cue
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
        point(at: AXMatch(title: label, frame: appKitRect(fromOverlay: rect)))
    }

    // ── internals ──

    private func point(at match: AXMatch) {
        endWorkItem?.cancel(); endWorkItem = nil
        scrollDirection = nil; scrollAnchorRect = nil   // a real on-screen target supersedes the scroll cue
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
