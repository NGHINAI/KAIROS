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
    /// "down"/"up" when the element lives in a scroll area but is scrolled OUT of view
    /// (must scroll that way to reveal it); nil when on-screen or not in a scroll area.
    let scrollDirection: String?
    /// The enclosing scroll area's frame (AppKit coords) — the dynamic-scroll arrow
    /// anchors to its bottom/top edge. nil when there's no resolvable scroll ancestor.
    let scrollViewport: CGRect?

    init(title: String, frame: CGRect, node: AXUIElement? = nil, pid: pid_t? = nil, role: String? = nil,
         scrollDirection: String? = nil, scrollViewport: CGRect? = nil) {
        self.title = title
        self.frame = frame
        self.node = node
        self.pid = pid
        self.role = role
        self.scrollDirection = scrollDirection
        self.scrollViewport = scrollViewport
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
    /// "down"/"up" when this entry is in a scroll area but scrolled OUT of view; nil otherwise.
    let scrollDirection: String?
    /// The enclosing scroll area's frame (AppKit coords) — the scroll-arrow anchor; nil if none.
    let scrollViewport: CGRect?

    init(label: String, role: String, frame: CGRect,
         scrollDirection: String? = nil, scrollViewport: CGRect? = nil) {
        self.label = label
        self.role = role
        self.frame = frame
        self.scrollDirection = scrollDirection
        self.scrollViewport = scrollViewport
    }
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

            let role = roleOf(element)
            // Menu-bar constructs (a window's View-menu items etc.) sit in the AX tree
            // even when the menu is CLOSED, with phantom frames — they hijacked sidebar
            // locates (find "Sound" → the View menu's "Sound" item, comet flew to nowhere,
            // live 2026-06-15). Guidance points at VISIBLE content; a genuine menu target
            // is reached via read_screen instead. Skip menu-bar roles in the find path.
            let isMenuConstruct = role == "AXMenuItem" || role == "AXMenuBarItem" || role == "AXMenu"
            if let label = labelOf(element), !label.isEmpty, !isMenuConstruct {
                let score = matchScore(needle: needle, label: normalize(label), role: role)
                if debug {
                    let f = frameOf(element)
                    seenLabels.append("\(role ?? "?"): \(label) [score=\(score) frame=\(f.map { "\(Int($0.width))x\(Int($0.height))" } ?? "nil")] norm=\"\(normalize(label))\"")
                }
                if score > 0, let frame = resolvedFrame(of: element) {
                    if best == nil || score > best!.score {
                        // Best-effort scroll context (nil is fine): lets the comet/arrow
                        // know if a matched element is parked off the visible viewport.
                        let off = offscreenDirection(of: element, frame: frame)
                        best = (score, AXMatch(title: label, frame: frame, node: element,
                                               pid: app.processIdentifier, role: roleOf(element),
                                               scrollDirection: off?.dir, scrollViewport: off?.viewport))
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
        // Window AX flaky/empty (System Settings on macOS 26 returns no kAXWindows) →
        // fall back to the app's children, but walk VISIBLE CONTENT first and the menu
        // bar only as a LAST resort. Walking the whole app root (incl. the menu bar)
        // let the View-menu's "Sound" item (role AXMenuItem, garbage closed-menu frame)
        // win over the sidebar row — the comet then flew to nowhere (live 2026-06-15).
        if best == nil {
            var childrenRef: CFTypeRef?
            if AXUIElementCopyAttributeValue(axApp, kAXChildrenAttribute as CFString, &childrenRef) == .success,
               let children = childrenRef as? [AXUIElement] {
                for child in children where roleOf(child) != "AXMenuBar" {
                    walk(child, depth: 1)
                    if let b = best, b.score >= 100 { break }
                }
                if best == nil {
                    for child in children where roleOf(child) == "AXMenuBar" { walk(child, depth: 1) }
                }
            }
        }

        // Diagnostic (KAIROS_AX_DEBUG=1): log the app actually searched + the matched
        // element's label/role/frame, so a "pointed at the wrong thing" report is
        // traceable from logs instead of guessed at.
        if debug || ProcessInfo.processInfo.environment["KAIROS_AX_DEBUG"] == "1" {
            let m = best?.match
            let fr = m?.frame
            FileHandle.standardError.write(("[ax-find] query=\"\(query)\" app=\"\(app.localizedName ?? "?")\" pid=\(app.processIdentifier) → " +
                (m != nil ? "MATCH \"\(m!.title)\" role=\(m!.role ?? "?") score=\(best!.score) frame=\(fr.map { "(\(Int($0.minX)),\(Int($0.minY)) \(Int($0.width))x\(Int($0.height)))" } ?? "nil")" : "NO MATCH") + "\n").data(using: .utf8)!)
        }

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

        func walk(_ element: AXUIElement, depth: Int, windowFrame: CGRect?) {
            if depth > maxDepth || visited > maxNodes || total >= 90 || Date() > deadline { return }
            visited += 1
            if let label = labelOf(element), !label.isEmpty, label.count <= 60,
               let role = roleOf(element) {
                let key = "\(role)|\(label)"
                if !seen.contains(key), let frame = resolvedFrame(of: element) {
                    seen.insert(key)
                    let bucket = bucketName(for: role)
                    if bucket != "Other" {
                        // Off-screen marker: if this element lives in a scroll area but is
                        // scrolled out of view, the brain reads the " [off-screen ↓/↑]" cue
                        // in the summary text and calls guide_scroll to reveal it.
                        let off = offscreenDirection(of: element, frame: frame)
                        entries.append(AXInventoryEntry(label: label, role: role, frame: frame,
                                                        scrollDirection: off?.dir, scrollViewport: off?.viewport))
                        let offTag = off?.dir == "down" ? " [off-screen ↓]" : off?.dir == "up" ? " [off-screen ↑]" : ""
                        // STATE tag (on/off/selected/disabled) — so the brain can SEE whether
                        // a setting is already set instead of guessing "already enabled".
                        let stateTag = Self.stateTag(of: element, role: role)
                        // SIDE tag (left/right within the window) — grounds spoken direction
                        // ("the switch on the right") instead of a coin-flip.
                        let sideTag = Self.sideTag(frame: frame, windowFrame: windowFrame)
                        buckets[bucket, default: []].append("\(entries.count) \(label)\(stateTag)\(sideTag)\(offTag)")
                        total += 1
                    }
                }
            }
            var childrenRef: CFTypeRef?
            guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenRef) == .success,
                  let children = childrenRef as? [AXUIElement] else { return }
            for child in children { walk(child, depth: depth + 1, windowFrame: windowFrame) }
        }

        var windowsRef: CFTypeRef?
        var windowCount = 0
        if AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &windowsRef) == .success,
           let windows = windowsRef as? [AXUIElement] {
            windowCount = windows.count
            for w in windows { walk(w, depth: 1, windowFrame: resolvedFrame(of: w)) }
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
                    walk(child, depth: 1, windowFrame: resolvedFrame(of: child))
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

    // ── inventory enrichment (state + side) ──
    // These tags are the data the model was previously BLIND to — the cause of
    // "you already enabled dark mode" (no state) and "wrong arrow side" (no geometry).
    // The values are read straight from AX; AXActor already reads the same attrs to
    // actuate, we just surface them to the planner in the summary string.

    /// A compact state tag for a stateful control: " [on]" / " [off]" / " [✓ selected]" /
    /// " [disabled]" — or "" when the element carries no meaningful state. Toggles and
    /// radios expose kAXValue (1/0); rows/tabs/radios expose kAXSelected.
    private static func stateTag(of element: AXUIElement, role: String) -> String {
        var parts: [String] = []
        if let enabled = boolAttr(element, kAXEnabledAttribute), enabled == false { parts.append("disabled") }
        switch role {
        case kAXCheckBoxRole, kAXRadioButtonRole:
            if let v = intAttr(element, kAXValueAttribute) { parts.append(v != 0 ? "on" : "off") }
            else if let sel = boolAttr(element, kAXSelectedAttribute) { parts.append(sel ? "✓ selected" : "off") }
        default:
            if let sel = boolAttr(element, kAXSelectedAttribute), sel { parts.append("✓ selected") }
        }
        return parts.isEmpty ? "" : " [" + parts.joined(separator: ", ") + "]"
    }

    /// Coarse left/right position WITHIN the window — grounds the model's spoken
    /// direction. Center elements get no tag (no useful side cue). NOTE: this informs
    /// the model's SPEECH, not the rendered arrow x (that's a separate HUD geometry path).
    private static func sideTag(frame: CGRect, windowFrame: CGRect?) -> String {
        guard let w = windowFrame, w.width > 1 else { return "" }
        let rel = (frame.midX - w.minX) / w.width
        if rel < 0.38 { return " [left]" }
        if rel > 0.62 { return " [right]" }
        return ""
    }

    private static func boolAttr(_ element: AXUIElement, _ attr: String) -> Bool? {
        var ref: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attr as CFString, &ref) == .success else { return nil }
        if let n = ref as? NSNumber { return n.boolValue }
        return nil
    }

    private static func intAttr(_ element: AXUIElement, _ attr: String) -> Int? {
        var ref: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attr as CFString, &ref) == .success else { return nil }
        if let n = ref as? NSNumber { return n.intValue }
        return nil
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
        // (1) Linked title element: many SwiftUI controls expose their visible text via
        // kAXTitleUIElement rather than an own title. Cheap (no walk).
        var tref: CFTypeRef?
        if AXUIElementCopyAttributeValue(element, kAXTitleUIElementAttribute as CFString, &tref) == .success,
           let raw = tref, CFGetTypeID(raw) == AXUIElementGetTypeID() {
            if let s = ownLabel(of: raw as! AXUIElement) { return s }
        }
        // (2) Derived label: a CLICKABLE container (a System Settings sidebar row) whose
        // OWN label is empty but which holds a text descendant — attribute that text to
        // the container so find("Sound") matches the ROW, not the (now-excluded) menu
        // item. This is the deterministic, vision-free fix for the AX-blind sidebar.
        if let role = roleOf(element), derivableRoles.contains(role),
           let s = childTextLabel(of: element, depth: 0) {
            return s
        }
        return nil
    }

    /// Roles that legitimately stand in for their text child (clickable containers).
    private static let derivableRoles: Set<String> =
        ["AXRow", "AXCell", "AXOutlineRow", "AXButton", "AXLink", "AXTab"]

    /// An element's OWN title/value/description (no walk) — used for the linked-title path.
    private static func ownLabel(of element: AXUIElement) -> String? {
        for attr in [kAXValueAttribute, kAXTitleAttribute, kAXDescriptionAttribute, "AXLabel"] {
            var r: CFTypeRef?
            if AXUIElementCopyAttributeValue(element, attr as CFString, &r) == .success,
               let s = r as? String, !s.isEmpty, s.count <= 120 { return s }
        }
        return nil
    }

    /// First non-empty text label within a SHALLOW subtree (depth ≤ 3) — gives a
    /// clickable container the visible text it lacks an own-title for. Bounded so it
    /// can't blow the find() walk budget (sidebar rows are shallow).
    private static func childTextLabel(of element: AXUIElement, depth: Int) -> String? {
        if depth > 3 { return nil }
        var ref: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &ref) == .success,
              let children = ref as? [AXUIElement] else { return nil }
        for child in children {
            if let s = ownLabel(of: child) { return s }
            if let nested = childTextLabel(of: child, depth: depth + 1) { return nested }
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

    /// Climb up to 8 parents looking for the enclosing scroll area — the viewport an
    /// off-screen element lives in. nil when the element isn't inside any scroll area.
    private static func scrollableAncestor(of element: AXUIElement) -> AXUIElement? {
        var current: AXUIElement = element
        for _ in 0..<8 {
            var parentRef: CFTypeRef?
            guard AXUIElementCopyAttributeValue(current, kAXParentAttribute as CFString, &parentRef) == .success,
                  CFGetTypeID(parentRef) == AXUIElementGetTypeID() else { return nil }
            let parent = parentRef as! AXUIElement
            if roleOf(parent) == kAXScrollAreaRole { return parent }
            current = parent
        }
        return nil
    }

    /// Is `element` (at `frame`, AppKit bottom-left origin) scrolled OUT of its scroll
    /// area's viewport? Returns the direction the user must scroll to reveal it plus the
    /// viewport rect. AppKit y grows UPWARD: an element BELOW the viewport (off the
    /// bottom) needs a scroll DOWN; one ABOVE it (off the top) needs a scroll UP.
    /// Defensive: nil whenever the ancestor frame can't be read, or the element overlaps
    /// the viewport (visible). kAXVisibleChildrenAttribute is unreliable and unused.
    private static func offscreenDirection(of element: AXUIElement, frame: CGRect) -> (dir: String, viewport: CGRect)? {
        guard let ancestor = scrollableAncestor(of: element),
              let viewport = resolvedFrame(of: ancestor) else { return nil }
        if frame.maxY < viewport.minY - 4 { return ("down", viewport) }   // below the viewport
        if frame.minY > viewport.maxY + 4 { return ("up", viewport) }     // above the viewport
        return nil                                                        // visible / overlapping
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

    // Transient system overlays that float ABOVE the real app — they must never be the
    // search target. Live bug 2026-06-15: a macOS screenshot thumbnail (screencaptureui)
    // hijacked a "find Sound" locate because the call fell through to frontmost and the
    // thumbnail was topmost, so the comet flew to a "Screenshot….png" element.
    private static let overlayApps: Set<String> = [
        "screencaptureui", "kairoshud", "notification center", "controlcenter",
        "control center", "spotlight", "window server", "windowserver", "loginwindow",
        "screenshot", "siri", "coreautha.daemon",
    ]
    private static func isOverlay(_ app: NSRunningApplication?) -> Bool {
        let nm = (app?.localizedName ?? "").lowercased()
        let bid = (app?.bundleIdentifier ?? "").lowercased()
        return overlayApps.contains(nm) || bid.contains("screencaptureui") || bid.contains("controlcenter") || bid.contains("notificationcenter")
    }

    private static func resolveApp(named name: String?) -> NSRunningApplication? {
        let apps = NSWorkspace.shared.runningApplications
        if let name, !name.isEmpty {
            let n = name.lowercased()
            return apps.first { ($0.localizedName ?? "").lowercased() == n }
                ?? apps.first { ($0.localizedName ?? "").lowercased().contains(n) }
        }
        // Frontmost — but NEVER a transient overlay (screenshot thumbnail, our own orb,
        // Notification/Control Center, Spotlight). If the topmost thing is an overlay,
        // fall back to the most-recently-active REAL (.regular) app underneath it.
        let front = NSWorkspace.shared.frontmostApplication
        if let f = front, !isOverlay(f) { return f }
        return apps.first { $0.activationPolicy == .regular && !isOverlay($0) && $0.isActive }
            ?? apps.first { $0.activationPolicy == .regular && !isOverlay($0) }
            ?? front
    }
}
