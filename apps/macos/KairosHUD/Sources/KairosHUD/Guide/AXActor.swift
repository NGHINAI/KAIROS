// AXActor.swift — the ACTUATION half of computer use (the half Cua/HeyClicky made
// famous; AXFinder is the perception half we already had). Contract, in order of
// preference:
//
//   1. AXUIElementPerformAction(kAXPressAction) — the Accessibility API *presses*
//      the element directly. No synthetic events, no cursor movement, no focus
//      steal, works on buttons/rows/checkboxes/menu items. This is better than
//      HeyClicky's event path for the common case.
//   2. CGEvent.postToPid mouse click at the element's center — the fallback for
//      nodes that don't honor AXPress. Per-PID posting means the event goes to the
//      target app only: the user's cursor never moves, their frontmost app never
//      changes (the no-foreground contract from the Clicky teardown).
//
// Typing mirrors it: kAXValueAttribute set (instant, exact) → focused per-PID
// keyboard events as fallback. Raw coordinate clicks from the model are BLOCKED by
// construction — the daemon only ever addresses elements by index/label, never x,y.

import AppKit
import ApplicationServices

enum AXActor {
    /// Press (click) a resolved element. Returns (failure-reason-or-nil, mode):
    /// mode "select" = row navigation (the screen MUST change for success);
    /// mode "press"/"event" = button-style activation (toggles legitimately leave
    /// the element inventory identical — pressing IS the success signal).
    static func press(_ match: AXMatch) -> (String?, String) {
        if let node = match.node {
            // The MATCHED node is usually the LABEL (AXStaticText inside a cell
            // inside a row) — climb to the actionable ancestor first. Then:
            // rows/cells are SELECTED (kAXPress on them returns .success WITHOUT
            // navigating — live 2026-06-11, the blind click-loop); buttons are
            // pressed; everything else gets press-then-event.
            let (target, role) = actionableAncestor(of: node) ?? (node, match.role ?? "")
            if role == "AXRow" || role == "AXCell" || role == "AXOutlineRow" {
                if selectRow(target) { return (nil, "select") }
            }
            if AXUIElementPerformAction(target, kAXPressAction as CFString) == .success { return (nil, "press") }
            if target !== node, AXUIElementPerformAction(node, kAXPressAction as CFString) == .success { return (nil, "press") }
            // Some containers expose the press on a child button; try one level down.
            var childrenRef: CFTypeRef?
            if AXUIElementCopyAttributeValue(target, kAXChildrenAttribute as CFString, &childrenRef) == .success,
               let children = childrenRef as? [AXUIElement] {
                for child in children.prefix(6)
                where AXUIElementPerformAction(child, kAXPressAction as CFString) == .success {
                    return (nil, "press")
                }
            }
        }
        return (clickByEvent(match), "event")
    }

    /// Nearest ancestor (≤5 levels, self included) that is genuinely actionable.
    private static func actionableAncestor(of node: AXUIElement) -> (AXUIElement, String)? {
        let actionable: Set<String> = ["AXRow", "AXCell", "AXOutlineRow", "AXButton",
                                       "AXCheckBox", "AXRadioButton", "AXPopUpButton",
                                       "AXMenuItem", "AXMenuBarItem", "AXLink", "AXTab"]
        var cur: AXUIElement? = node
        for _ in 0..<6 {
            guard let c = cur else { break }
            if let r = roleOf(c), actionable.contains(r) { return (c, r) }
            cur = parentOf(c)
        }
        return nil
    }

    /// Select a row (or the row containing a matched cell) — the AX-native way
    /// sidebars navigate. Tries the row's own kAXSelected, then the owning
    /// outline/table's kAXSelectedRows (some apps only honor the container).
    private static func selectRow(_ node: AXUIElement) -> Bool {
        var row = node
        if roleOf(row) == "AXCell" {
            var cur: AXUIElement? = row
            for _ in 0..<3 {
                guard let c = cur, let parent = parentOf(c) else { break }
                if roleOf(parent) == "AXRow" || roleOf(parent) == "AXOutlineRow" { row = parent; break }
                cur = parent
            }
        }
        if AXUIElementSetAttributeValue(row, kAXSelectedAttribute as CFString, kCFBooleanTrue) == .success {
            return true
        }
        // Container-level selection: find the owning outline/table and set its
        // selected rows to exactly this row.
        var cur: AXUIElement? = row
        for _ in 0..<5 {
            guard let c = cur, let parent = parentOf(c) else { break }
            if let r = roleOf(parent), r == "AXOutline" || r == "AXTable" || r == "AXList" {
                let rows = [row] as CFArray
                if AXUIElementSetAttributeValue(parent, "AXSelectedRows" as CFString, rows) == .success {
                    return true
                }
                break
            }
            cur = parent
        }
        return false
    }

    private static func roleOf(_ el: AXUIElement) -> String? {
        var ref: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, kAXRoleAttribute as CFString, &ref) == .success else { return nil }
        return ref as? String
    }

    private static func parentOf(_ el: AXUIElement) -> AXUIElement? {
        var ref: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, kAXParentAttribute as CFString, &ref) == .success, let ref else { return nil }
        return (ref as! AXUIElement)
    }

    /// Put text into a field: AX value set first, focused keystrokes as fallback.
    /// `submit` presses Return afterwards (search fields, message boxes).
    static func setValue(_ text: String, on match: AXMatch, submit: Bool) -> String? {
        guard let node = match.node, let pid = match.pid else {
            return "the element reference is stale — read the screen again and retry"
        }
        var wrote = AXUIElementSetAttributeValue(node, kAXValueAttribute as CFString, text as CFString) == .success
        if !wrote {
            // Fallback: focus the field, then type the whole string as ONE per-PID
            // keyboard event (CGEventKeyboardSetUnicodeString carries arbitrary text —
            // no per-character keycode mapping, no layout assumptions).
            _ = AXUIElementSetAttributeValue(node, kAXFocusedAttribute as CFString, kCFBooleanTrue)
            usleep(60_000)
            guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
                  let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else {
                return "couldn't synthesize keyboard events"
            }
            let chars = Array(text.utf16)
            down.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: chars)
            up.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: chars)
            down.postToPid(pid)
            usleep(20_000)
            up.postToPid(pid)
            wrote = true
        }
        if submit {
            usleep(80_000)
            pressReturn(pid: pid)
        }
        return wrote ? nil : "the field rejected the text"
    }

    // ── internals ──

    private static func clickByEvent(_ match: AXMatch) -> String? {
        guard let pid = match.pid else {
            return "this element can't be pressed (no live reference) — read the screen again"
        }
        // AXMatch.frame is AppKit (bottom-left origin); CGEvent wants Quartz
        // (top-left of the primary display).
        let primaryHeight = NSScreen.screens.first?.frame.maxY ?? 1080
        let pt = CGPoint(x: match.frame.midX, y: primaryHeight - match.frame.midY)
        guard let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown,
                                 mouseCursorPosition: pt, mouseButton: .left),
              let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp,
                               mouseCursorPosition: pt, mouseButton: .left) else {
            return "couldn't synthesize the click"
        }
        down.setIntegerValueField(.mouseEventClickState, value: 1)
        up.setIntegerValueField(.mouseEventClickState, value: 1)
        down.postToPid(pid)      // per-PID: no cursor warp, no focus steal
        usleep(40_000)
        up.postToPid(pid)
        return nil
    }

    private static func pressReturn(pid: pid_t) {
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 36, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: 36, keyDown: false) else { return }
        down.postToPid(pid)
        usleep(20_000)
        up.postToPid(pid)
    }
}
