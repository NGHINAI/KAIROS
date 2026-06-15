// GuideOverlayView.swift — the full-screen, click-through stage of Guide Mode.
//
// Visual language: the comet is the orb's child — the same warm-gold-to-cyan light,
// condensed to a small glowing body with two soft eyes (the Clicky nod), riding a
// spring. The target gets a breathing highlight ring and a glass caption pill with
// the element's real name. Everything is light on glass — no chrome, no windows.

import SwiftUI

struct GuideOverlayView: View {
    @ObservedObject var model: GuideModel

    var body: some View {
        ZStack(alignment: .topLeading) {
            if let t = model.target {
                TargetHighlight(rect: t.rect)
                CaptionPill(text: t.label)
                    .position(x: t.rect.midX, y: captionY(for: t.rect))
                    .transition(.opacity.combined(with: .scale(scale: 0.92)))
            }
            if let dir = model.scrollDirection {
                ScrollGuideArrow(direction: dir, anchorRect: model.scrollAnchorRect)
            }
            if model.phase != .hidden {
                GuideComet(eyesOpen: model.eyesOpen)
                    .position(model.cometPos)
                    .animation(.spring(response: 0.55, dampingFraction: 0.78), value: model.cometPos)
                    .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .animation(.spring(response: 0.42, dampingFraction: 0.8), value: model.target)
        .allowsHitTesting(false)
    }

    private func captionY(for rect: CGRect) -> CGFloat {
        // Below the element; above it when the element hugs the screen bottom.
        let below = rect.maxY + 26
        return below < (NSScreen.main?.frame.height ?? 1080) - 40 ? below : rect.minY - 26
    }
}

// ── The guide comet: a condensed orb with eyes ─────────────────────────────────

struct GuideComet: View {
    var eyesOpen: Bool
    @State private var breathe = false

    var body: some View {
        ZStack {
            // Outer glow — the orb's warm-gold signature.
            Circle()
                .fill(RadialGradient(
                    colors: [Color(red: 1.0, green: 0.82, blue: 0.45).opacity(0.55),
                             Color(red: 0.35, green: 0.85, blue: 0.95).opacity(0.18),
                             .clear],
                    center: .center, startRadius: 2, endRadius: 34))
                .frame(width: 68, height: 68)
                .scaleEffect(breathe ? 1.08 : 0.95)
            // Body — liquid glass bead.
            Circle()
                .fill(LinearGradient(
                    colors: [Color.white.opacity(0.95), Color(red: 1.0, green: 0.86, blue: 0.55).opacity(0.85)],
                    startPoint: .topLeading, endPoint: .bottomTrailing))
                .frame(width: 26, height: 26)
                .overlay(Circle().strokeBorder(Color.white.opacity(0.7), lineWidth: 0.8))
                .shadow(color: Color(red: 1.0, green: 0.8, blue: 0.4).opacity(0.8), radius: 10)
            // Eyes — two soft dark capsules that blink (the Clicky nod).
            HStack(spacing: 5.5) {
                Capsule().frame(width: 4.4, height: 9)
                Capsule().frame(width: 4.4, height: 9)
            }
            .foregroundStyle(Color(red: 0.12, green: 0.13, blue: 0.18).opacity(0.92))
            .scaleEffect(y: eyesOpen ? 1 : 0.12, anchor: .center)
            .animation(.easeInOut(duration: 0.1), value: eyesOpen)
            .offset(y: -0.5)
        }
        .onAppear {
            withAnimation(.easeInOut(duration: 1.6).repeatForever(autoreverses: true)) { breathe = true }
        }
    }
}

// ── Target highlight: a breathing ring around the element ─────────────────────

struct TargetHighlight: View {
    let rect: CGRect
    @State private var pulse = false

    var body: some View {
        RoundedRectangle(cornerRadius: 9, style: .continuous)
            .strokeBorder(
                LinearGradient(colors: [Color(red: 1.0, green: 0.82, blue: 0.45),
                                        Color(red: 0.35, green: 0.85, blue: 0.95)],
                               startPoint: .topLeading, endPoint: .bottomTrailing),
                lineWidth: 2.4)
            .frame(width: max(rect.width + 14, 30), height: max(rect.height + 14, 24))
            .shadow(color: Color(red: 1.0, green: 0.82, blue: 0.45).opacity(pulse ? 0.65 : 0.25), radius: pulse ? 14 : 7)
            .scaleEffect(pulse ? 1.03 : 1.0)
            .position(x: rect.midX, y: rect.midY)
            .onAppear {
                withAnimation(.easeInOut(duration: 1.1).repeatForever(autoreverses: true)) { pulse = true }
            }
    }
}

// ── Scroll guide arrow: a glowing directional cue at the scroll viewport's edge ──
//
// Arrow-ONLY: KAIROS never auto-scrolls. When a read_screen target sits off the
// visible viewport, the brain calls guide_scroll and this arrow appears at the scroll
// area's near edge (bottom for "down", top for "up") with a "scroll down/up" pill —
// the user does the scrolling. Same warm-gold→cyan light language as TargetHighlight.

struct ScrollGuideArrow: View {
    let direction: String          // "down" | "up"
    let anchorRect: CGRect?
    @State private var pulse = false
    @State private var appeared = false

    private var isDown: Bool { direction != "up" }   // default to "down" for any unknown value

    private static let gradient = LinearGradient(
        colors: [Color(red: 1.0, green: 0.82, blue: 0.45),
                 Color(red: 0.35, green: 0.85, blue: 0.95)],
        startPoint: .topLeading, endPoint: .bottomTrailing)

    var body: some View {
        let pos = anchorPosition()
        VStack(spacing: 8) {
            if !isDown { caption }        // pointing up: pill above the arrowhead
            Chevron(down: isDown)
                .fill(Self.gradient)
                .frame(width: 38, height: 46)
                .shadow(color: Color(red: 1.0, green: 0.82, blue: 0.45).opacity(pulse ? 0.7 : 0.3),
                        radius: pulse ? 16 : 8)
            if isDown { caption }         // pointing down: pill below the arrowhead
        }
        .scaleEffect(appeared ? (pulse ? 1.04 : 1.0) : 0.6)
        .opacity(appeared ? 1 : 0)
        .position(x: pos.x, y: pos.y)
        .onAppear {
            withAnimation(.spring(response: 0.45, dampingFraction: 0.7)) { appeared = true }
            withAnimation(.easeInOut(duration: 1.1).repeatForever(autoreverses: true)) { pulse = true }
        }
    }

    private var caption: some View {
        Text(isDown ? "scroll down" : "scroll up")
            .font(.system(size: 12.5, weight: .semibold, design: .rounded))
            .foregroundStyle(.white.opacity(0.95))
            .lineLimit(1)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(.ultraThinMaterial, in: Capsule())
            .overlay(Capsule().strokeBorder(Color.white.opacity(0.22), lineWidth: 0.8))
            .shadow(color: .black.opacity(0.35), radius: 8, y: 2)
            .fixedSize()
    }

    /// Overlay-coordinate center for the arrow stack. Anchor to the viewport edge when we
    /// have one; otherwise default to screen-bottom-center (down) / top-center (up).
    private func anchorPosition() -> CGPoint {
        let inset: CGFloat = 56   // keep the whole stack clear of the very edge
        if let r = anchorRect {
            return CGPoint(x: r.midX, y: isDown ? r.maxY - inset : r.minY + inset)
        }
        let screen = NSScreen.main?.frame ?? CGRect(x: 0, y: 0, width: 1920, height: 1080)
        return CGPoint(x: screen.width / 2, y: isDown ? screen.height - inset : inset)
    }
}

/// A simple downward/upward chevron + short stem, drawn as a single fillable path.
private struct Chevron: Shape {
    let down: Bool

    func path(in rect: CGRect) -> Path {
        var p = Path()
        let w = rect.width, h = rect.height
        let thick = w * 0.30                 // arm/stem thickness
        if down {
            // Stem (top) then a downward arrowhead (bottom).
            p.addRect(CGRect(x: rect.midX - thick / 2, y: 0, width: thick, height: h * 0.42))
            p.move(to: CGPoint(x: 0, y: h * 0.40))
            p.addLine(to: CGPoint(x: rect.midX, y: h))
            p.addLine(to: CGPoint(x: w, y: h * 0.40))
            p.addLine(to: CGPoint(x: w - thick, y: h * 0.40))
            p.addLine(to: CGPoint(x: rect.midX, y: h - thick * 1.3))
            p.addLine(to: CGPoint(x: thick, y: h * 0.40))
            p.closeSubpath()
        } else {
            // Upward arrowhead (top) then a stem (bottom).
            p.addRect(CGRect(x: rect.midX - thick / 2, y: h * 0.58, width: thick, height: h * 0.42))
            p.move(to: CGPoint(x: 0, y: h * 0.60))
            p.addLine(to: CGPoint(x: rect.midX, y: 0))
            p.addLine(to: CGPoint(x: w, y: h * 0.60))
            p.addLine(to: CGPoint(x: w - thick, y: h * 0.60))
            p.addLine(to: CGPoint(x: rect.midX, y: thick * 1.3))
            p.addLine(to: CGPoint(x: thick, y: h * 0.60))
            p.closeSubpath()
        }
        return p
    }
}

// ── Caption pill: the element's real name on glass ─────────────────────────────

struct CaptionPill: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.system(size: 12.5, weight: .semibold, design: .rounded))
            .foregroundStyle(.white.opacity(0.95))
            .lineLimit(1)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(.ultraThinMaterial, in: Capsule())
            .overlay(Capsule().strokeBorder(Color.white.opacity(0.22), lineWidth: 0.8))
            .shadow(color: .black.opacity(0.35), radius: 8, y: 2)
            .fixedSize()
    }
}
