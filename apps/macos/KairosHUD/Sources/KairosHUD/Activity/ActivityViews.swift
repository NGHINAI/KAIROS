// ActivityViews.swift — Lane A "watch it work" UI: small energy nodes orbiting the ring (collapsed
// glance) + a glass timeline card (the detail). Both are pure projections of ActivityModel.

import SwiftUI

private func stepColor(_ s: StepStatus) -> Color {
    switch s {
    case .running: return Color(.sRGB, red: 0.35, green: 0.9, blue: 1.0, opacity: 1)   // cyan
    case .done:    return Color(.sRGB, red: 0.45, green: 1.0, blue: 0.6, opacity: 1)    // green
    case .failed:  return Color(.sRGB, red: 1.0, green: 0.42, blue: 0.42, opacity: 1)   // red
    }
}

/// Small glowing nodes orbiting the orb — one per step of the current turn. Overlays the Metal orb.
struct ActivityNodesView: View {
    @ObservedObject var activity: ActivityModel
    var radius: CGFloat = 68

    var body: some View {
        TimelineView(.animation) { tl in
            let t = tl.date.timeIntervalSinceReferenceDate
            GeometryReader { geo in
                let c = CGPoint(x: geo.size.width / 2, y: geo.size.height / 2)
                ForEach(Array(activity.steps.enumerated()), id: \.element.id) { pair in
                    let i = pair.offset, step = pair.element
                    node(step, t: t)
                        .position(pos(i, total: activity.steps.count, center: c))
                }
            }
        }
        .allowsHitTesting(false)   // never block dragging the orb
    }

    private func pos(_ i: Int, total: Int, center c: CGPoint) -> CGPoint {
        let a = -Double.pi / 2 + Double(i) / Double(max(total, 1)) * 2 * Double.pi
        let r = Double(radius)
        return CGPoint(x: Double(c.x) + r * cos(a), y: Double(c.y) + r * sin(a))
    }

    @ViewBuilder private func node(_ step: ActivityStep, t: Double) -> some View {
        let col = stepColor(step.status)
        let pulse = step.status == .running ? 0.6 + 0.4 * sin(t * 4) : 1.0
        ZStack {
            Circle().fill(col).frame(width: 9, height: 9)
                .shadow(color: col.opacity(0.9), radius: 6)
                .opacity(pulse)
            if step.status == .done {
                Image(systemName: "checkmark").font(.system(size: 6, weight: .bold)).foregroundStyle(.black.opacity(0.7))
            } else if step.status == .failed {
                Image(systemName: "xmark").font(.system(size: 6, weight: .bold)).foregroundStyle(.black.opacity(0.7))
            }
        }
    }
}

/// The glass timeline card — appears below the orb during a turn.
struct ActivityCardView: View {
    @ObservedObject var activity: ActivityModel

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 6) {
                if !activity.tier.isEmpty {
                    Text(activity.tier.uppercased())
                        .font(.system(size: 8, weight: .heavy)).tracking(0.5)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Capsule().fill(.white.opacity(0.12)))
                        .foregroundStyle(.white.opacity(0.8))
                }
                Text(activity.status.isEmpty ? "working…" : activity.status)
                    .font(.system(size: 11, weight: .medium)).foregroundStyle(.white.opacity(0.85))
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            ForEach(activity.steps) { step in
                HStack(spacing: 8) {
                    glyph(step.status)
                    Text(step.name).font(.system(size: 11, design: .monospaced)).foregroundStyle(.white.opacity(0.9))
                    Spacer(minLength: 6)
                    if !step.summary.isEmpty {
                        Text(step.summary).font(.system(size: 10)).foregroundStyle(.white.opacity(0.45))
                            .lineLimit(1).truncationMode(.tail)
                    }
                }
            }
        }
        .padding(14)
        .frame(width: 250, alignment: .leading)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(.white.opacity(0.12), lineWidth: 1))
        .shadow(color: .black.opacity(0.4), radius: 16, y: 6)
    }

    @ViewBuilder private func glyph(_ s: StepStatus) -> some View {
        switch s {
        case .running: Image(systemName: "circle.dotted").font(.system(size: 11)).foregroundStyle(stepColor(s))
        case .done:    Image(systemName: "checkmark.circle.fill").font(.system(size: 11)).foregroundStyle(stepColor(s))
        case .failed:  Image(systemName: "xmark.circle.fill").font(.system(size: 11)).foregroundStyle(stepColor(s))
        }
    }
}

/// Hosts the card at the top of its (transparent) panel, just under the orb.
struct ActivityCardContainer: View {
    @ObservedObject var activity: ActivityModel
    var body: some View {
        VStack { ActivityCardView(activity: activity); Spacer(minLength: 0) }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .padding(.top, 2)
    }
}
