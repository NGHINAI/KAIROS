// NonActivatingHUDPanel.swift — the shared floating-panel chassis.
//
// The never-steal-focus recipe (mirrors HeyClicky's NotchPanel): a borderless, non-activating,
// transparent panel that floats above the menu bar, joins all Spaces, shows over fullscreen apps,
// and never deactivates the user's frontmost app. `sharingType = .none` is set from day one so the
// HUD never leaks into the screenshots the agent will capture in Phase H.

import AppKit

final class NonActivatingHUDPanel: NSPanel {
    /// RECORDABLE BY DEFAULT (`.readOnly`) so demo recordings capture the orb/console/
    /// guide. `--capture-invisible` flips back to `.none` — Phase-H hygiene for when
    /// the agent takes its own screenshots and must not see itself. Set in main.swift
    /// before any panel is constructed.
    static var recordable = true

    init(contentRect: NSRect) {
        super.init(
            contentRect: contentRect,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        isFloatingPanel = true
        // Above the menu bar / status items, below the screen-saver level.
        level = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 1)
        collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
        hidesOnDeactivate = false
        // Draggable anywhere on screen by clicking the orb; never steals focus (.nonactivatingPanel).
        isMovableByWindowBackground = true
        // Never appear in screen captures (Phase H: the agent must not "see itself").
        sharingType = Self.recordable ? .readOnly : .none
        ignoresMouseEvents = false
    }

    // Allow text fields inside summoned cards to become first responder, but never own the menu bar.
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}
