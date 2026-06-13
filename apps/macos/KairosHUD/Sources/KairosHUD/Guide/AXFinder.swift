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
    /// The LIVE AX node (act mode presses this directly — kAXPressAction beats
    /// synthetic clicks: no cursor, no focus steal, works on sidebar rows).
    /// nil for cached-frame fallbacks and dev/fake matches — those can point, not act.
    let node: AXUIElement?
    /// Owning app's pid — CGEvent.postToPid fallback target. nil when node is nil.
    let pid: pid_t?
    /// AX role — actuation strategy depends on it (rows/cells SELECT, buttons PRESS).
    let role: String?

    init(title: String, frame: CGRect, node: AXUIElement? = nil, pid: pid_t? = nil, role: String? = nil) {
        self.title = title
        self.frame = frame
        self.node = node
        self.pid = pid
        self.role = role
    }
}

enum AXFindResult {
    case found(AXMatch)
    case notFound(reason: String)
}

/// One numbered entry of a screen snapshot — what guide-by-element points at.
struct AXInventoryEntry {
    let label: String
    let role: String
    let frame: CGRect   // AppKit coords, resolved at snapshot time
}

enum AXInventoryResult {
    case ok(summary: String, entries: [AXInventoryEntry])
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
    private static let deadlineSeconds = 2.5
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
        AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 0.3)
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
        // The system-wide messaging timeout doesn't reliably propagate to app elements
        // (a freshly-launched System Settings hung a walk >8s past it) — set it on the
        // app element too; children created from it inherit this connection's timeout.
        AXUIElementSetMessagingTimeout(axApp, 0.3)
        var best: (score: Int, match: AXMatch)? = nil
        var visited = 0
        let deadline = Date().addingTimeInterval(deadlineSeconds)
        let needle = normalize(query)

        func walk(_ element: AXUIElement, depth: Int) {
            if depth > maxDepth || visited > maxNodes || Date() > deadline { return }
            visited += 1

            if let label = labelOf(element), !label.isEmpty {
                let score = matchScore(needle: needle, label: normalize(label), role: roleOf(element))
                if debug {
                    let f = frameOf(element)
                    seenLabels.append("\(roleOf(element) ?? "?"): \(label) [score=\(score) frame=\(f.map { "\(Int($0.width))x\(Int($0.height))" } ?? "nil")] norm=\"\(normalize(label))\"")
                }
                if score > 0, let frame = resolvedFrame(of: element) {
                    if best == nil || score > best!.score {
                        best = (score, AXMatch(title: label, frame: frame, node: element,
                                               pid: app.processIdentifier, role: roleOf(element)))
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

        // Windows first — what the user can SEE beats menu items with the same name.
        // The full app tree (menus included) is the fallback if the budget allows.
        var windowsRef: CFTypeRef?
        var windowCount = 0
        if AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &windowsRef) == .success,
           let windows = windowsRef as? [AXUIElement] {
            windowCount = windows.count
            for w in windows {
                walk(w, depth: 1)
                if let b = best, b.score >= 100 { break }
            }
        }
        if best == nil { walk(axApp, depth: 0) }

        if let b = best { return .found(b.match) }
        let where_ = appName ?? (app.localizedName ?? "the frontmost app")
        if windowCount == 0 {
            return .notFound(reason: "\(where_) is running but its window is closed — call open_app to bring it forward, then point again")
        }
        return .notFound(reason: "no element matching \"\(query)\" is visible in \(where_) right now")
    }

    /// READ_SCREEN: the visible element inventory of an app, rendered as compact
    /// grouped text for the agent to plan guidance steps from. This is what makes
    /// guidance DYNAMIC (HeyClicky's get_window_state, pointing-only): the agent sees
    /// what is ACTUALLY there instead of guessing from training memory. Read-only.
    static func inventory(appName: String?) -> AXInventoryResult {
        guard AXIsProcessTrusted() else {
            if !promptedForPermission {
                promptedForPermission = true
                let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
                _ = AXIsProcessTrustedWithOptions(opts)
            }
            return .failed(reason: "the Accessibility permission isn't granted yet")
        }
        guard let app = resolveApp(named: appName) else {
            return .failed(reason: appName != nil ? "no running app called \"\(appName!)\"" : "no frontmost app")
        }
        ensureMessagingTimeout()
        let axApp = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(axApp, 0.3)

        var buckets: [String: [String]] = [:]   // human bucket → "N label" (ordered)
        var entries: [AXInventoryEntry] = []     // numbered snapshot (1-based for the model)
        var seen = Set<String>()
        var visited = 0
        var total = 0
        let deadline = Date().addingTimeInterval(deadlineSeconds)

        func bucketName(for role: String) -> String {
            switch role {
            case kAXButtonRole, kAXPopUpButtonRole: return "Buttons"
            case kAXTextFieldRole, kAXTextAreaRole: return "Fields"
            case kAXCheckBoxRole, kAXRadioButtonRole: return "Toggles"
            case "AXRow", "AXCell", kAXMenuItemRole, "AXTab", "AXLink": return "Items"
            case kAXStaticTextRole: return "Labels"
            default: return "Other"
            }
        }

        func walk(_ element: AXUIElement, depth: Int) {
            if depth > maxDepth || visited > maxNodes || total >= 90 || Date() > deadline { return }
            visited += 1
            if let label = labelOf(element), !label.isEmpty, label.count <= 60,
               let role = roleOf(element) {
                let key = "\(role)|\(label)"
                if !seen.contains(key), let frame = resolvedFrame(of: element) {
                    seen.insert(key)
                    let bucket = bucketName(for: role)
                    if bucket != "Other" {
                        entries.append(AXInventoryEntry(label: label, role: role, frame: frame))
                        buckets[bucket, default: []].append("\(entries.count) \(label)")
                        total += 1
                    }
                }
            }
            var childrenRef: CFTypeRef?
            guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenRef) == .success,
                  let children = childrenRef as? [AXUIElement] else { return }
            for child in children { walk(child, depth: depth + 1) }
        }

        var windowsRef: CFTypeRef?
        var windowCount = 0
        if AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &windowsRef) == .success,
           let windows = windowsRef as? [AXUIElement] {
            windowCount = windows.count
            for w in windows { walk(w, depth: 1) }
        }

        // kAXWindowsAttribute is FLAKY on some apps (System Settings on macOS 26
        // returns empty while the window is plainly open — find() always survived
        // this via its app-root fallback; inventory() declared "window is closed"
        // and blinded the whole walkthrough). Fall back to walking the app element
        // directly, skipping the menu bar so the inventory stays what's VISIBLE.
        if total == 0 {
            var childrenRef: CFTypeRef?
            if AXUIElementCopyAttributeValue(axApp, kAXChildrenAttribute as CFString, &childrenRef) == .success,
               let children = childrenRef as? [AXUIElement] {
                for child in children where roleOf(child) != "AXMenuBar" {
                    windowCount += 1
                    walk(child, depth: 1)
                }
            }
        }

        if windowCount == 0 {
            return .failed(reason: "\(app.localizedName ?? "the app") is running but its window is closed — call open_app to bring it forward, then look again")
        }
        if total == 0 {
            return .failed(reason: "\(app.localizedName ?? "the app") exposes no readable elements (window may be empty or the app has poor accessibility support)")
        }

        var lines = ["App: \(app.localizedName ?? appName ?? "frontmost")"]
        for bucket in ["Items", "Buttons", "Toggles", "Fields", "Labels"] {
            guard let labels = buckets[bucket], !labels.isEmpty else { continue }
            lines.append("\(bucket): " + labels.prefix(28).joined(separator: " · "))
        }
        return .ok(summary: String(lines.joined(separator: "\n").prefix(2400)), entries: entries)
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
