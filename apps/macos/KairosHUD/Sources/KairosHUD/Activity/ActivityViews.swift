// ActivityViews.swift — the Liquid Glass console + the orb's rim count badge.
//
// Interaction model (locked with the user): at rest the orb is alone; a small glass count badge
// appears on its rim when background agents run. Clicking the orb opens ONE Liquid Glass console
// holding (a) a "Now" section = what the foreground KAIROS is doing this turn, and (b) a roster of
// background sub-agents. The full tool/step list never shows until you click a single agent row.
//
// Everything is native macOS-26 Liquid Glass: a GlassEffectContainer lets the pills refract the
// desktop and fluidly merge/morph as rows expand (glassEffectID), and motion runs on one spring.

import SwiftUI

// MARK: - Liquid Glass plumbing
//
// Live we use native macOS-26 Liquid Glass. ImageRenderer (our offscreen snapshot path) can't draw
// `.glassEffect`, so a `glassEnabled` environment flag lets snapshots fall back to `.ultraThinMaterial`
// to verify layout. The same fallback is graceful degradation if glass is ever unavailable.

private struct GlassEnabledKey: EnvironmentKey { static let defaultValue = true }
extension EnvironmentValues {
    var glassEnabled: Bool {
        get { self[GlassEnabledKey.self] }
        set { self[GlassEnabledKey.self] = newValue }
    }
}

// MARK: - Shared status vocabulary

/// The Control-Center "active" blue — the accent + glass tint for live/running things.
let ccBlue = Color(.sRGB, red: 0.16, green: 0.56, blue: 1.00, opacity: 1)
/// Amber — "needs your attention" (pending approvals). Distinct from blue activity.
let ccAmber = Color(.sRGB, red: 1.00, green: 0.72, blue: 0.20, opacity: 1)

private func stepColor(_ s: StepStatus) -> Color {
    switch s {
    case .running: return ccBlue
    case .done:    return Color(.sRGB, red: 0.45, green: 1.00, blue: 0.60)   // green
    case .failed:  return Color(.sRGB, red: 1.00, green: 0.45, blue: 0.45)   // red
    }
}

private func bgColor(_ s: BgStatus) -> Color {
    switch s {
    case .running:   return ccBlue
    case .done:      return Color(.sRGB, red: 0.45, green: 1.00, blue: 0.60)   // green
    case .failed:    return Color(.sRGB, red: 1.00, green: 0.45, blue: 0.45)   // red
    case .cancelled: return Color(.sRGB, red: 0.70, green: 0.72, blue: 0.78)   // grey
    }
}

private func bgWord(_ s: BgStatus) -> String {
    switch s {
    case .running: return "working"; case .done: return "done"
    case .failed: return "failed"; case .cancelled: return "cancelled"
    }
}

// MARK: - The console (opens below the orb on click)

struct ConsoleView: View {
    @ObservedObject var activity: ActivityModel
    @ObservedObject var bg: BackgroundModel
    @ObservedObject var hud: HUDState
    @ObservedObject var approval: ApprovalModel
    @Environment(\.glassEnabled) private var glassEnabled

    /// A LIGHT white frosting — just enough to lift the glass over a dark wallpaper while staying
    /// transparent/glassy (not milky). Tunable: higher = brighter/milkier, lower = more see-through.
    static let frost = Color.white.opacity(0.14)

    // Show the "Now" pill only when the foreground turn has real content to show — NOT merely because
    // a turn is active. A turn that only hands off to a background agent (no status, no fg steps)
    // shows nothing here, so it doesn't read as a second box next to the Lane-B row.
    private var foregroundLive: Bool {
        !activity.status.isEmpty || !activity.steps.isEmpty
    }

    // No GlassEffectContainer: Control-Center modules are DISCRETE and must never fuse. The container
    // merges glass shapes that come within its spacing of each other — and when a row expanded, the
    // reflow pulled pills inside that distance, fusing them all into one milky blob until re-shown.
    // Independent .glassEffect per pill keeps them separate and fixes that.
    var body: some View {
        stack.padding(4)
    }

    private var stack: some View {
        VStack(alignment: .leading, spacing: 12) {
            header

            // To-dos (parked approvals) — one collapsible amber section. It flashes open when a new
            // one arrives, then tucks away; tap the header to revisit/act anytime. Voice also works.
            if approval.count > 0 {
                pill("todos", tint: ccAmber.opacity(0.42), interactive: true) {
                    TodosSection(approval: approval, expanded: hud.todosExpanded, onToggle: { hud.toggleTodos() })
                }
                .transition(.scale(scale: 0.92, anchor: .top).combined(with: .opacity))
            }

            if foregroundLive {
                // Control-Center module = bright milky-white frosted glass; blue stays in the accents.
                pill("fg", tint: Self.frost) { ForegroundSection(activity: activity) }
                    .transition(.scale(scale: 0.92, anchor: .top).combined(with: .opacity))
            }

            ForEach(bg.agents) { agent in
                pill(agent.id, tint: Self.frost, interactive: true) {
                    AgentRow(agent: agent,
                             expanded: hud.expandedAgentID == agent.id,
                             onTap: { hud.toggleAgent(agent.id) })
                }
                .transition(.scale(scale: 0.92, anchor: .top).combined(with: .opacity))
            }

            if !foregroundLive && bg.agents.isEmpty && approval.pending.isEmpty { pill("idle") { idleHint } }
        }
        .frame(width: 304, alignment: .leading)
    }

    /// One Control-Center-style glass pill. Native Liquid Glass live (optionally blue-tinted for
    /// "active" modules); `.ultraThinMaterial` + an approximate tint wash as the snapshot fallback.
    @ViewBuilder private func pill<V: View>(_ id: String, tint: Color? = nil, interactive: Bool = false,
                                            @ViewBuilder _ content: () -> V) -> some View {
        let shape = RoundedRectangle(cornerRadius: 28, style: .continuous)
        if glassEnabled {
            content().glassEffect(Self.glassStyle(tint: tint, interactive: interactive), in: shape)
        } else {
            content()
                .background(.ultraThinMaterial, in: shape)
                .overlay(shape.fill((tint ?? .clear).opacity(0.20)))
                .overlay(shape.strokeBorder((tint ?? .white).opacity(0.22), lineWidth: 1))
        }
    }

    /// Build the Liquid Glass style. A WHITE frosting tint gives the bright milky Control-Center look
    /// (so the module reads as bright glass over ANY wallpaper, not just light ones); the tint color
    /// is used as given (caller sets opacity).
    private static func glassStyle(tint: Color?, interactive: Bool) -> Glass {
        var style: Glass = .regular
        if let tint { style = style.tint(tint) }
        if interactive { style = style.interactive() }
        return style
    }

    private var header: some View {
        HStack(spacing: 7) {
            Circle().fill(.white.opacity(0.9)).frame(width: 5, height: 5)
            Text("KAIROS").font(.system(size: 10, weight: .bold, design: .rounded))
                .tracking(1.4).foregroundStyle(.white.opacity(0.55))
            Spacer(minLength: 0)
            if approval.count > 0 {
                Text("\(approval.count) needs you")
                    .font(.system(size: 10, weight: .bold, design: .rounded))
                    .foregroundStyle(ccAmber)
            } else if bg.runningCount > 0 {
                Text("\(bg.runningCount) working")
                    .font(.system(size: 10, weight: .semibold, design: .rounded))
                    .foregroundStyle(.white.opacity(0.5))
            }
        }
        .padding(.horizontal, 6)
    }

    private var idleHint: some View {
        Text("Nothing running right now.")
            .font(.system(size: 12)).foregroundStyle(.white.opacity(0.5))
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 16).padding(.horizontal, 16)
    }
}

// MARK: - Foreground "Now" section (Lane A — the live turn)

struct ForegroundSection: View {
    @ObservedObject var activity: ActivityModel

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 7) {
                PulsingDot(color: ccBlue, active: activity.active)
                if !activity.tier.isEmpty {
                    Text(activity.tier.uppercased())
                        .font(.system(size: 8, weight: .heavy)).tracking(0.6)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Capsule().fill(.white.opacity(0.14)))
                        .foregroundStyle(.white.opacity(0.85))
                }
                Text(activity.status.isEmpty ? "thinking…" : activity.status)
                    .font(.system(size: 12, weight: .medium)).foregroundStyle(.white.opacity(0.92))
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            ForEach(activity.steps) { step in StepRow(name: step.name, status: step.status, summary: step.summary) }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - A background sub-agent row (collapsed → click to expand its steps)

struct AgentRow: View {
    @ObservedObject var agent: BgAgent
    let expanded: Bool
    let onTap: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button(action: onTap) {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 9) {
                        PulsingDot(color: bgColor(agent.status), active: agent.status == .running)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(agent.goal)
                                .font(.system(size: 12.5, weight: .semibold)).foregroundStyle(.white.opacity(0.95))
                                .lineLimit(1)
                            Text(agent.status == .failed ? agent.note
                                 : (agent.note.isEmpty ? bgWord(agent.status) : agent.note))
                                .font(.system(size: 10.5)).foregroundStyle(.white.opacity(0.5))
                                .lineLimit(1)
                        }
                        Spacer(minLength: 6)
                        Image(systemName: "chevron.right")
                            .font(.system(size: 10, weight: .bold)).foregroundStyle(.white.opacity(0.5))
                            .rotationEffect(.degrees(expanded ? 90 : 0))
                    }
                    if agent.status == .running { LiquidProgressBar(tint: bgColor(.running)) }
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if expanded {
                VStack(alignment: .leading, spacing: 7) {
                    if agent.steps.isEmpty {
                        Text("no tool calls yet").font(.system(size: 10.5))
                            .foregroundStyle(.white.opacity(0.4))
                    } else {
                        ForEach(agent.steps) { s in StepRow(name: s.name, status: s.status, summary: s.summary) }
                    }
                    if let report = agent.report, !report.isEmpty {
                        Text(report).font(.system(size: 11)).italic()
                            .foregroundStyle(.white.opacity(0.62))
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.top, 2)
                    }
                }
                .padding(.horizontal, 16).padding(.bottom, 14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }
}

// MARK: - To-dos (collapsible list of parked approvals — flashes open, revisit anytime)

struct TodosSection: View {
    @ObservedObject var approval: ApprovalModel
    let expanded: Bool
    let onToggle: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button(action: onToggle) {
                HStack(spacing: 8) {
                    Image(systemName: "exclamationmark.shield.fill").font(.system(size: 12)).foregroundStyle(ccAmber)
                    Text("\(approval.count) to-do\(approval.count == 1 ? "" : "s")")
                        .font(.system(size: 12.5, weight: .semibold)).foregroundStyle(.white.opacity(0.96))
                    if !expanded, let first = approval.pending.first {
                        Text("· \(first.summary)").font(.system(size: 11)).foregroundStyle(.white.opacity(0.5)).lineLimit(1)
                    }
                    Spacer(minLength: 6)
                    Image(systemName: "chevron.right").font(.system(size: 10, weight: .bold))
                        .foregroundStyle(.white.opacity(0.5)).rotationEffect(.degrees(expanded ? 90 : 0))
                }
                .padding(14).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if expanded {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(approval.pending) { ap in
                        TodoRow(approval: ap,
                                onApprove: { approval.act(ap.id, approve: true) },
                                onDeny: { approval.act(ap.id, approve: false) })
                    }
                    Text("…or just say “yes” / “no” — now or later")
                        .font(.system(size: 9.5)).foregroundStyle(.white.opacity(0.4))
                }
                .padding(.horizontal, 14).padding(.bottom, 14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }
}

/// One parked approval inside the expanded To-dos list.
struct TodoRow: View {
    let approval: PendingApproval
    let onApprove: () -> Void
    let onDeny: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(approval.summary)
                .font(.system(size: 12.5, weight: .medium)).foregroundStyle(.white.opacity(0.95))
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                Button(action: onApprove) {
                    Text("Approve").font(.system(size: 12, weight: .semibold)).frame(maxWidth: .infinity)
                }
                .buttonStyle(.glass).tint(Color(.sRGB, red: 0.30, green: 0.85, blue: 0.45))
                Button(action: onDeny) {
                    Text("Deny").font(.system(size: 12, weight: .semibold)).frame(maxWidth: .infinity)
                }
                .buttonStyle(.glass).tint(.white.opacity(0.18))
            }
            .controlSize(.large)
        }
    }
}

// MARK: - Small reusable pieces

/// One tool/step row: glyph + monospaced name + right-aligned summary.
struct StepRow: View {
    let name: String
    let status: StepStatus
    let summary: String
    var body: some View {
        HStack(spacing: 8) {
            glyph
            Text(name).font(.system(size: 11, design: .monospaced)).foregroundStyle(.white.opacity(0.9))
            Spacer(minLength: 6)
            if !summary.isEmpty {
                Text(summary).font(.system(size: 10)).foregroundStyle(.white.opacity(0.45))
                    .lineLimit(1).truncationMode(.tail)
            }
        }
    }
    @ViewBuilder private var glyph: some View {
        switch status {
        case .running: Image(systemName: "circle.dotted").font(.system(size: 11))
                .foregroundStyle(stepColor(status)).symbolEffect(.pulse, options: .repeating)
        case .done:    Image(systemName: "checkmark.circle.fill").font(.system(size: 11)).foregroundStyle(stepColor(status))
        case .failed:  Image(systemName: "xmark.circle.fill").font(.system(size: 11)).foregroundStyle(stepColor(status))
        }
    }
}

/// A status dot that breathes while active.
struct PulsingDot: View {
    let color: Color
    let active: Bool
    var body: some View {
        TimelineView(.animation(paused: !active)) { tl in
            let t = tl.date.timeIntervalSinceReferenceDate
            let p = active ? 0.55 + 0.45 * (0.5 + 0.5 * sin(t * 3.2)) : 1.0
            Circle().fill(color).frame(width: 8, height: 8)
                .shadow(color: color.opacity(0.8 * p), radius: 5)
                .opacity(p)
        }
        .frame(width: 8, height: 8)
    }
}

/// A thin indeterminate "liquid" progress track — a bright segment slides along a glassy capsule.
struct LiquidProgressBar: View {
    let tint: Color
    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width
            TimelineView(.animation) { tl in
                let t = tl.date.timeIntervalSinceReferenceDate
                let seg = max(40, w * 0.34)
                let travel = w + seg
                let x = (t.truncatingRemainder(dividingBy: 1.6) / 1.6) * travel - seg
                Capsule().fill(.white.opacity(0.10))
                    .overlay(alignment: .leading) {
                        Capsule()
                            .fill(LinearGradient(colors: [tint.opacity(0), tint, tint.opacity(0)],
                                                 startPoint: .leading, endPoint: .trailing))
                            .frame(width: seg)
                            .offset(x: x)
                            .blur(radius: 0.5)
                    }
                    .clipShape(Capsule())
            }
        }
        .frame(height: 3)
    }
}

// MARK: - The orb's rim count badge

/// "③" — appears on the orb's rim while background agents run; tapping the orb opens the console.
struct OrbBadgeOverlay: View {
    @ObservedObject var bg: BackgroundModel
    @ObservedObject var approval: ApprovalModel
    var body: some View {
        GeometryReader { geo in
            ZStack {
                // Amber "needs you" wins — it's actionable; blue running-count is just status.
                if approval.count > 0 {
                    CountBadge(count: approval.count, tint: ccAmber, attention: true)
                        .position(x: geo.size.width / 2 + 34, y: geo.size.height / 2 - 34)
                        .transition(.scale.combined(with: .opacity))
                } else if bg.runningCount > 0 {
                    CountBadge(count: bg.runningCount, tint: ccBlue, attention: false)
                        .position(x: geo.size.width / 2 + 34, y: geo.size.height / 2 - 34)
                        .transition(.scale.combined(with: .opacity))
                }
            }
            .animation(HUDState.glassSpring, value: bg.runningCount)
            .animation(HUDState.glassSpring, value: approval.count)
        }
        .allowsHitTesting(false)   // the orb host view owns all clicks
    }
}

struct CountBadge: View {
    let count: Int
    var tint: Color = ccBlue
    var attention: Bool = false     // pulse when something needs the user
    var body: some View {
        TimelineView(.animation(paused: !attention)) { tl in
            let t = tl.date.timeIntervalSinceReferenceDate
            let p = attention ? 0.7 + 0.3 * (0.5 + 0.5 * sin(t * 3.0)) : 1.0
            Text("\(count)")
                .font(.system(size: 12, weight: .heavy, design: .rounded))
                .foregroundStyle(.white)
                .frame(minWidth: 16, minHeight: 16)
                .padding(5)
                .glassEffect(.regular.tint(tint.opacity(0.7)), in: Circle())
                .shadow(color: tint.opacity(attention ? 0.7 * p : 0), radius: 6)
                .opacity(p)
                .contentTransition(.numericText())
        }
    }
}
