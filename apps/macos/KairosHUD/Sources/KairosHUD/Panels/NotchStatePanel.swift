// NotchStatePanel.swift — the word-bearing status pill that lives just under the menu
// bar, top-center, in the spirit of HeyClicky's notch chip.
//
// A second never-steal-focus surface (same NonActivatingHUDPanel chassis as the orb /
// console / guide overlay): a small glass capsule that names what KAIROS is doing —
// "Listening" / "Thinking" (or "Thinking deeper" on a deep turn) / "Speaking" — with a
// tiny gold→cyan equalizer that breathes with the live speech level. It fades fully out
// when the orb returns to idle. Pure projection of the SAME OrbModel the orb reads; no
// state of its own.

import AppKit
import SwiftUI

final class NotchStatePanel {
    private let panel: NonActivatingHUDPanel
    private let model: OrbModel
    private let size = NSSize(width: 170, height: 30)

    init(model: OrbModel) {
        self.model = model
        // Mirror the other HUD panels exactly: never-activating, click-through, joins all
        // Spaces, floats above the menu bar, and sits one level above the status bar.
        panel = NonActivatingHUDPanel(contentRect: NSRect(origin: .zero, size: size))
        panel.isMovableByWindowBackground = false
        panel.ignoresMouseEvents = true
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
        panel.level = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 1)
        let host = NSHostingView(rootView: NotchStateView(model: model))
        host.frame = NSRect(origin: .zero, size: size)
        host.autoresizingMask = [.width, .height]
        host.wantsLayer = true; host.layer?.backgroundColor = .clear
        panel.contentView = host
    }

    func show() {
        position()
        panel.orderFrontRegardless()
        NotificationCenter.default.addObserver(self, selector: #selector(reposition),
                                               name: NSApplication.didChangeScreenParametersNotification, object: nil)
    }

    @objc private func reposition() { position() }

    /// Top-center, just below the menu bar (mirrors OrbPanelManager.positionConsole's
    /// top-of-screen math, centered instead of left-inset). visibleFrame.maxY already
    /// sits under the menu bar; drop a small inset below that.
    private func position() {
        guard let screen = NSScreen.main else { return }
        let vf = screen.visibleFrame
        let topInset: CGFloat = 6
        let x = screen.frame.midX - size.width / 2
        let y = vf.maxY - topInset - size.height
        panel.setFrameOrigin(NSPoint(x: x, y: y))
    }
}

// ── The pill: a word + a live equalizer on glass ───────────────────────────────

struct NotchStateView: View {
    @ObservedObject var model: OrbModel

    private static let gradient = LinearGradient(
        colors: [Color(red: 1.0, green: 0.82, blue: 0.45),
                 Color(red: 0.35, green: 0.85, blue: 0.95)],
        startPoint: .leading, endPoint: .trailing)

    /// The word for the current state. Idle/error read empty — the whole pill fades out.
    private var word: String {
        switch model.state {
        case .listening: return "Listening"
        case .thinking:  return model.effortDeep ? "Thinking deeper" : "Thinking"
        case .speaking:  return "Speaking"
        case .idle, .error: return ""
        }
    }

    private var visible: Bool { !word.isEmpty }

    var body: some View {
        HStack(spacing: 8) {
            Text(word)
                .font(.system(size: 12.5, weight: .semibold, design: .rounded))
                .foregroundStyle(.white.opacity(0.95))
                .lineLimit(1)
            Equalizer(model: model)
                .frame(width: 18, height: 14)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 5)
        .background(.ultraThinMaterial, in: Capsule())
        .overlay(Capsule().strokeBorder(Color.white.opacity(0.22), lineWidth: 0.8))
        .shadow(color: .black.opacity(0.35), radius: 8, y: 2)
        .fixedSize()
        .frame(maxWidth: .infinity, maxHeight: .infinity)   // center in the panel
        .opacity(visible ? 1 : 0)
        .scaleEffect(visible ? 1 : 0.9)
        .animation(.easeInOut(duration: 0.32), value: visible)
        .animation(.easeInOut(duration: 0.22), value: word)
    }
}

/// A tiny 3-bar equalizer stroked in the gold→cyan gradient. Samples the orb's live,
/// eased voice level (model.display, 0…1) via a TimelineView so it breathes with speech
/// without needing model.display to be @Published (the renderer mutates it per-frame).
/// While thinking/listening it gives a gentle idle shimmer instead of a flat line.
private struct Equalizer: View {
    @ObservedObject var model: OrbModel

    var body: some View {
        TimelineView(.animation) { timeline in
            let t = timeline.date.timeIntervalSinceReferenceDate
            let level = model.display                 // 0…1 eased speech level
            // A small per-bar phase keeps the three bars out of lockstep; the idle floor
            // keeps a faint life when there's no audio (thinking/listening).
            Canvas { ctx, size in
                let bars = 3
                let gap: CGFloat = 3
                let barW = (size.width - gap * CGFloat(bars - 1)) / CGFloat(bars)
                let gradient = GraphicsContext.Shading.linearGradient(
                    Gradient(colors: [Color(red: 1.0, green: 0.82, blue: 0.45),
                                      Color(red: 0.35, green: 0.85, blue: 0.95)]),
                    startPoint: .zero, endPoint: CGPoint(x: size.width, y: 0))
                for i in 0..<bars {
                    let phase = t * 6 + Double(i) * 1.3
                    let wobble = (sin(phase) + 1) / 2                 // 0…1
                    let floor = 0.22 + 0.10 * wobble                 // idle shimmer
                    let amt = max(floor, min(1, level * (0.6 + 0.8 * wobble)))
                    let h = max(2, size.height * CGFloat(amt))
                    let x = CGFloat(i) * (barW + gap)
                    let rect = CGRect(x: x, y: size.height - h, width: barW, height: h)
                    ctx.fill(Path(roundedRect: rect, cornerRadius: barW / 2), with: gradient)
                }
            }
        }
    }
}
