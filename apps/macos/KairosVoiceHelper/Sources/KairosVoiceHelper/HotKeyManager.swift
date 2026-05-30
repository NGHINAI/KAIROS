// HotKeyManager.swift — global hotkey via CGEventTap on flagsChanged events.
//
// Default: hold Option key → push-to-talk. Releases → stop listening.
// User can switch to double-tap Control via the set_hotkey command.

import Foundation
import AppKit
import CoreGraphics

final class HotKeyManager {
    private let bus: ProtocolBus
    private var eventTap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?
    private var modifier: CGEventFlags = .maskAlternate    // Option
    private var action: String = "hold"
    private var lastFlags: CGEventFlags = []
    private var doubleTapWindow: TimeInterval = 0.4
    private var lastTapAt: TimeInterval = 0

    init(bus: ProtocolBus) {
        self.bus = bus
    }

    func start() {
        let mask: UInt64 = 1 << CGEventType.flagsChanged.rawValue
        let opaqueSelf = Unmanaged.passUnretained(self).toOpaque()
        let callback: CGEventTapCallBack = { _, type, event, refcon in
            guard let refcon = refcon else { return Unmanaged.passUnretained(event) }
            let mgr = Unmanaged<HotKeyManager>.fromOpaque(refcon).takeUnretainedValue()
            mgr.handle(type: type, event: event)
            return Unmanaged.passUnretained(event)
        }
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .listenOnly,
            eventsOfInterest: CGEventMask(mask),
            callback: callback,
            userInfo: opaqueSelf
        ) else {
            bus.emit(["event": "error", "code": "hotkey_tap_failed"])
            return
        }
        eventTap = tap
        runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetCurrent(), runLoopSource, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
    }

    func setHotkey(modifier: String, action: String) {
        self.action = action
        switch modifier {
        case "option":  self.modifier = .maskAlternate
        case "control": self.modifier = .maskControl
        case "command": self.modifier = .maskCommand
        default:        self.modifier = .maskAlternate
        }
    }

    private func handle(type: CGEventType, event: CGEvent) {
        guard type == .flagsChanged else { return }
        let flags = event.flags
        let modActive = flags.contains(modifier)
        let prevModActive = lastFlags.contains(modifier)
        if modActive && !prevModActive {
            if action == "hold" {
                bus.emit(["event": "hotkey", "state": "down", "modifier": modName()])
            } else {
                let now = Date().timeIntervalSince1970
                if (now - lastTapAt) <= doubleTapWindow {
                    bus.emit(["event": "hotkey", "state": "down", "modifier": modName()])
                }
                lastTapAt = now
            }
        } else if !modActive && prevModActive {
            if action == "hold" {
                bus.emit(["event": "hotkey", "state": "up", "modifier": modName()])
            }
        }
        lastFlags = flags
    }

    private func modName() -> String {
        if modifier == .maskAlternate { return "option" }
        if modifier == .maskControl   { return "control" }
        if modifier == .maskCommand   { return "command" }
        return "unknown"
    }
}
