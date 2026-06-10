// AXFinder.swift — locate a UI element on screen by its VISIBLE label, via the
// Accessibility tree. This is the perception layer of Guide Mode, and the reason it
// has no screenshot/vision-model latency: an AX tree walk over the target app takes
// milliseconds and returns the element's exact screen rect. (Screenshots → vision
// models are 1–4s per look and give pixel guesses; the AX tree gives ground truth.
// Vision becomes necessary only for apps with no AX exposure — not handled in v1.)
//
// Requires the Accessibility permission (System Settings → Privacy & Security →
// Accessibility). Without it, find() fails fast with a reason the agent can speak.

import AppKit
import ApplicationServices

struct AXMatch {
    let title: String
    /// Screen rect in AppKit coordinates (bottom-left origin), ready for overlay use.
    let frame: CGRect
    /// The live element handle — kept so we can ACT on it (kAXPressAction), not just
    /// point. nil only for synthetic/dev matches.
    let element: AXUIElement?
}

enum AXFindResult {
    case found(AXMatch)
    case notFound(reason: String)
}

enum AXActResult {
    case ok(label: String)
    case failed(reason: String)
}

enum AXFinder {
    /// Roles a user can be guided to (clickable/selectable things first-class).
    private static let preferredRoles: Set<String> = [
        kAXButtonRole, kAXMenuItemRole, kAXMenuBarItemRole, kAXCheckBoxRole,
        kAXRadioButtonRole, kAXTextFieldRole, kAXTextAreaRole, kAXPopUpButtonRole,
        kAXTabGroupRole, "AXLink", "AXTab", "AXCell", "AXRow",
    ]

    private static let maxNodes = 12000
    private static let maxDepth = 14
    private static let perWindowSeconds = 1.6   // each window gets its OWN budget (a heavy window can't starve later ones)
    private static let totalSeconds = 5.0       // absolute wall-clock cap across all windows (< the 8s bridge timeout)
    private static var promptedForPermission = false

    /// Dev probe (--axprobe): collect every labeled node seen during the walk.
    static var debug = false
    static var seenLabels: [String] = []
    private static var messagingTimeoutSet = false

    /// A SINGLE AX call can block for many seconds when the target app is busy
    /// (System Settings right after launch hung a whole walk past the bridge's 8s
    /// timeout). Setting the messaging timeout on the system-wide element caps every
    /// AX call this process makes — the walk's own deadline then actually works.
    private static func ensureMessagingTimeout() {
        guard !messagingTimeoutSet else { return }
        messagingTimeoutSet = true
        // 1.0s, not 0.3s: a single fetch of a heavy web area's children (Safari) can
        // exceed 0.3s and time out, returning EMPTY children — the walk then silently
        // misses everything on the page. 1.0s still bounds a truly hung app; the walk's
        // own 2.5s overall deadline is the backstop.
        AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 1.0)
    }

    /// ACTUATE: find the element, then perform a semantic AX action on it — a real
    /// click with NO cursor move and NO focus theft (kAXPressAction → the element's
    /// own press handler). Falls back across press → confirm → pick → showMenu so
    /// buttons, links, menu items, checkboxes, and rows all work. This is the fast
    /// path Cua/HeyClicky use; the slow part of "computer use" is screenshots, which
    /// we never take.
    static func act(query: String, appName: String?) -> AXActResult {
        let found = find(query: query, appName: appName)
        guard case .found(let match) = found else {
            if case .notFound(let reason) = found { return .failed(reason: reason) }
            return .failed(reason: "not found")
        }
        return press(match)
    }

    /// Press an ALREADY-FOUND element — no second tree walk (the click path finds once,
    /// points, then presses this). kAXPressAction → confirm → pick → open → showMenu.
    static func press(_ match: AXMatch) -> AXActResult {
        guard let el = match.element else { return .failed(reason: "no actionable handle for \"\(match.title)\"") }

        // Only perform an action the element actually advertises (avoids -25205 noise).
        var namesRef: CFArray?
        let available: Set<String> = AXUIElementCopyActionNames(el, &namesRef) == .success
            ? Set((namesRef as? [String]) ?? []) : []
        let order = [kAXPressAction, kAXConfirmAction as String, kAXPickAction, "AXOpen", kAXShowMenuAction]
        for action in order where available.isEmpty || available.contains(action) {
            if AXUIElementPerformAction(el, action as CFString) == .success {
                return .ok(label: match.title)
            }
            if !available.isEmpty { continue }   // unknown action set → try the next blindly
        }
        return .failed(reason: "couldn't activate \"\(match.title)\" (the app didn't accept a press)")
    }

    /// Find the best on-screen element matching `query` in `appName` (nil = frontmost app).
    /// Synchronous and potentially blocking — call from a background queue.
    static func find(query: String, appName: String?) -> AXFindResult {
        guard AXIsProcessTrusted() else {
            // AXIsProcessTrusted() NEVER prompts on its own — users were silently
            // unpermissioned. Fire the system grant dialog once per process.
            if !promptedForPermission {
                promptedForPermission = true
                let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
                _ = AXIsProcessTrustedWithOptions(opts)
            }
            return .notFound(reason: "the Accessibility permission isn't granted yet — macOS just showed the grant dialog; once the user approves it (and relaunches the HUD), pointing will work")
        }
        guard let app = resolveApp(named: appName) else {
            return .notFound(reason: appName != nil ? "no running app called \"\(appName!)\"" : "no frontmost app")
        }

        ensureMessagingTimeout()
        if debug { seenLabels = [] }
        let axApp = AXUIElementCreateApplication(app.processIdentifier)
        var best: (score: Int, match: AXMatch)? = nil
        var visited = 0
        var deadline = Date().addingTimeInterval(perWindowSeconds)   // reset per window
        let hardDeadline = Date().addingTimeInterval(totalSeconds)   // absolute cap across all windows
        let needle = normalize(query)

        func walk(_ element: AXUIElement, depth: Int) {
            if depth > maxDepth || visited > maxNodes || Date() > deadline || Date() > hardDeadline { return }
            visited += 1

            if let label = labelOf(element), !label.isEmpty {
                let score = matchScore(needle: needle, label: normalize(label), role: roleOf(element))
                if debug {
                    let f = frameOf(element)
                    seenLabels.append("\(roleOf(element) ?? "?"): \(label) [score=\(score) frame=\(f.map { "\(Int($0.width))x\(Int($0.height))" } ?? "nil")] norm=\"\(normalize(label))\"")
                }
                if score > 0, let frame = resolvedFrame(of: element) {
                    if best == nil || score > best!.score {
                        best = (score, AXMatch(title: label, frame: frame, element: element))
                    }
                }
            }
            // Exact matches can stop early — nothing will beat them.
            if let b = best, b.score >= 100 { return }

            var childrenRef: CFTypeRef?
            guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenRef) == .success,
                  let children = childrenRef as? [AXUIElement] else { return }
            for child in children {
                walk(child, depth: depth + 1)
                if let b = best, b.score >= 100 { return }
            }
        }

        // FOCUSED window first — what the user is actually looking at. On a big app
        // (Safari with heavy tabs has a huge AX tree), walking windows in array order
        // can blow the node/time budget on a background window before reaching the one
        // on screen — so the same query resolved nondeterministically. Main/focused
        // window → other windows → whole app (menus) as the budget allows.
        var ordered: [AXUIElement] = []
        var seenWin = Set<AXUIElement>()
        for attr in [kAXFocusedWindowAttribute, kAXMainWindowAttribute] {
            var ref: CFTypeRef?
            if AXUIElementCopyAttributeValue(axApp, attr as CFString, &ref) == .success,
               CFGetTypeID(ref) == AXUIElementGetTypeID() {
                let w = ref as! AXUIElement
                if seenWin.insert(w).inserted { ordered.append(w) }
            }
        }
        var windowsRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &windowsRef) == .success,
           let windows = windowsRef as? [AXUIElement] {
            for w in windows where seenWin.insert(w).inserted { ordered.append(w) }
        }
        for w in ordered {
            if Date() > hardDeadline { break }
            visited = 0                                          // fresh node budget per window
            deadline = Date().addingTimeInterval(perWindowSeconds)  // fresh time budget per window
            walk(w, depth: 1)
            if let b = best, b.score >= 100 { break }
        }
        if best == nil, Date() < hardDeadline { visited = 0; deadline = Date().addingTimeInterval(perWindowSeconds); walk(axApp, depth: 0) }

        if let b = best { return .found(b.match) }
        let where_ = appName ?? (app.localizedName ?? "the frontmost app")
        if ProcessInfo.processInfo.environment["KAIROS_AX_DEBUG"] != nil {
            let hitDeadline = Date() > deadline
            FileHandle.standardError.write("AXFinder miss: query=\"\(query)\" app=\(where_) visited=\(visited) deadlineHit=\(hitDeadline)\n".data(using: .utf8)!)
        }
        return .notFound(reason: "no element matching \"\(query)\" is visible in \(where_) right now")
    }

    // ── matching ──

    private static func normalize(_ s: String) -> String {
        s.lowercased()
            .replacingOccurrences(of: "…", with: "")
            .replacingOccurrences(of: "&", with: " and ")   // STT says "and"; macOS labels use "&"
            .replacingOccurrences(of: "\u{2019}", with: "'")
            .replacingOccurrences(of: "   ", with: " ")
            .replacingOccurrences(of: "  ", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Score a label against the query. 100=exact · 80=prefix · 60=contains ·
    /// 50+=ALL meaningful words present. PARTIAL word overlap does NOT match —
    /// pointing at the wrong element is far worse than finding nothing (live bug:
    /// "Privacy & Security" matched "AppleCare & Warranty" on the shared "&").
    /// Preferred (clickable) roles get +10 so "Export" the button beats prose.
    private static func matchScore(needle: String, label: String, role: String?) -> Int {
        guard !needle.isEmpty, !label.isEmpty else { return 0 }
        var score = 0
        if label == needle { score = 100 }
        else if label.hasPrefix(needle) || needle.hasPrefix(label) { score = 80 }
        else if label.contains(needle) || needle.contains(label) { score = 60 }
        else {
            let stop: Set<String> = ["the", "a", "an", "and", "button", "icon", "tab", "menu", "section", "row", "field", "in", "on", "of", "for"]
            let nTokens = Set(needle.split(separator: " ").map(String.init))
                .subtracting(stop)
                .filter { $0.count >= 2 }
            let lTokens = Set(label.split(separator: " ").map(String.init))
            if !nTokens.isEmpty && nTokens.isSubset(of: lTokens) {
                score = 50 + nTokens.count * 5            // every meaningful word present
            }
        }
        if score > 0, let r = role, preferredRoles.contains(r) { score += 10 }
        return score
    }

    // ── AX attribute helpers ──

    private static func labelOf(_ element: AXUIElement) -> String? {
        for attr in [kAXTitleAttribute, kAXDescriptionAttribute, "AXLabel", kAXValueAttribute] {
            var ref: CFTypeRef?
            if AXUIElementCopyAttributeValue(element, attr as CFString, &ref) == .success,
               let s = ref as? String, !s.isEmpty, s.count <= 120 {
                return s
            }
        }
        return nil
    }

    private static func roleOf(_ element: AXUIElement) -> String? {
        var ref: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &ref) == .success else { return nil }
        return ref as? String
    }

    /// The element's frame, or the nearest ANCESTOR's when the element reports a
    /// zero/degenerate one — SwiftUI apps (System Settings!) expose 0×0 frames on the
    /// static text inside virtualized sidebar rows; the row/cell above has the truth.
    private static func resolvedFrame(of element: AXUIElement) -> CGRect? {
        var current: AXUIElement? = element
        for _ in 0..<4 {
            guard let el = current else { return nil }
            if let f = frameOf(el), f.width > 1, f.height > 1 { return f }
            var parentRef: CFTypeRef?
            guard AXUIElementCopyAttributeValue(el, kAXParentAttribute as CFString, &parentRef) == .success,
                  CFGetTypeID(parentRef) == AXUIElementGetTypeID() else { return nil }
            current = (parentRef as! AXUIElement)
        }
        return nil
    }

    /// Element frame → AppKit screen coordinates (bottom-left origin). AX reports
    /// top-left-origin global coordinates, so flip against the primary display.
    private static func frameOf(_ element: AXUIElement) -> CGRect? {
        var posRef: CFTypeRef?
        var sizeRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &posRef) == .success,
              AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeRef) == .success else { return nil }
        var pos = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(posRef as! AXValue, .cgPoint, &pos),
              AXValueGetValue(sizeRef as! AXValue, .cgSize, &size) else { return nil }
        guard let primary = NSScreen.screens.first else { return nil }
        let flippedY = primary.frame.maxY - pos.y - size.height
        return CGRect(x: pos.x, y: flippedY, width: size.width, height: size.height)
    }

    private static func resolveApp(named name: String?) -> NSRunningApplication? {
        let apps = NSWorkspace.shared.runningApplications
        if let name, !name.isEmpty {
            let n = name.lowercased()
            return apps.first { ($0.localizedName ?? "").lowercased() == n }
                ?? apps.first { ($0.localizedName ?? "").lowercased().contains(n) }
        }
        return NSWorkspace.shared.frontmostApplication
    }
}
