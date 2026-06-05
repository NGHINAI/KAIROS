// OrbModel.swift — the orb's state + level, with the smoothing that makes it feel alive.
//
// (state, level) is the whole contract: `state` sets the palette/base-motion; `level` (0..1, an RMS
// derived from streamed audio) drives core scale, ring wobble, glow, and chromatic separation.
// Smoothing is asymmetric — fast attack so it feels responsive, slow release so it never strobes.

import SwiftUI
import Combine

enum OrbState {
    case idle, listening, thinking, speaking, error

    /// Drives the shader's shape-deformation (breathing / pulse / traveling / liquid / jitter).
    var mode: Float {
        switch self {
        case .idle: return 0
        case .listening: return 1
        case .thinking: return 2
        case .speaking: return 3
        case .error: return 4
        }
    }

    /// Gentle per-state rotation of the warm→cool sweep (orange stays roughly at the top, as in the reference).
    var sweepRotation: Float {
        switch self {
        case .idle: return 0.0
        case .listening: return 0.4
        case .thinking: return 0.8
        case .speaking: return -0.3
        case .error: return -0.6
        }
    }
}

final class OrbModel: ObservableObject {
    /// Published so a state change re-evaluates the view tree (and animates the palette target).
    @Published private(set) var state: OrbState = .idle

    // These are mutated every frame inside the Canvas draw and don't need to publish.
    private(set) var smoothed: Double = 0   // EMA of incoming level
    var display: Double = 0                  // per-frame eased value the Canvas reads
    var paletteDisplay: Palette = .idle      // current (lerped) palette
    var paletteTarget: Palette = .idle       // target palette for the active state

    /// Feed a raw 0..1 level (e.g. RMS of a tts_chunk). Curved + asymmetric-EMA smoothed.
    func ingest(level raw: Double) {
        let target = min(1, max(0, pow(max(0, raw), 0.6))) // RMS is small; curve into usable range
        let k = target > smoothed ? 0.35 : 0.08            // attack fast, release slow
        smoothed += (target - smoothed) * k
    }

    /// Advance per-frame easing. Called once at the top of each Canvas draw.
    func tick() {
        display += (smoothed - display) * 0.2
        paletteDisplay = paletteDisplay.lerp(paletteTarget, 0.08)
    }

    func transition(to s: OrbState) {
        state = s
        paletteTarget = Palette.of(s)
    }
}
