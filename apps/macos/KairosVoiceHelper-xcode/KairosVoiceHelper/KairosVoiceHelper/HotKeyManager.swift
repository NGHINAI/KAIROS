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
        // Must run on main runloop — CGEventTap delivers callbacks via CFRunLoop,
        // and only the main thread's runloop runs automatically via app.run().
        let work: () -> Void = { [weak self] in
            guard let self = self else { return }
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
                NSLog("KAIROS hotkey: tapCreate returned nil — Accessibility permission likely denied")
                self.bus.emit(["event": "error", "code": "hotkey_tap_failed",
                               "message": "CGEventTap could not be created. Grant Accessibility permission in System Settings."])
                return
            }
            NSLog("KAIROS hotkey: tap created, adding to MAIN runloop")
            self.eventTap = tap
            self.runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
            CFRunLoopAddSource(CFRunLoopGetMain(), self.runLoopSource, .commonModes)
            CGEvent.tapEnable(tap: tap, enable: true)
            NSLog("KAIROS hotkey: ready, watching for Option modifier")
        }
        if Thread.isMainThread { work() }
        else { DispatchQueue.main.async(execute: work) }
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
        // Re-enable if macOS disabled the tap (signing race / system event)
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap = eventTap { CGEvent.tapEnable(tap: tap, enable: true) }
            return
        }
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
