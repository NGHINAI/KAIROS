// OrbModel.swift — the orb's state + the smoothed quantities that make each state read as a DISTINCT,
// smooth motion.
//
// Each state is a blend of motion ARCHETYPES (breathe / pulse / travel-wave / voice-lobes / jitter),
// not just "more or less wobble." On a state change the per-archetype weights (and amp/speed/hue) EASE
// toward the new state's targets, so the motion cross-fades — e.g. a slow breathing ring smoothly grows
// a traveling wave when it starts thinking, then morphs into voice-driven lobes when it speaks.
// `level` (RMS from streamed TTS audio) rides on top and drives the speaking lobes live.

import Foundation

/// The orb's motion at an instant. `amp`/`speed` scale the whole deformation; the five weights select
/// WHICH motion archetype(s) are active (each 0…1). All of these ease frame-to-frame.
struct OrbMotion {
    var amp: Double      // overall radial-deformation amplitude
    var speed: Double    // overall motion-speed multiplier
    var breathe: Double  // idle  — slow, uniform radius swell (calm, alive at rest)
    var pulse: Double    // listening — faster uniform pulse (attentive/expectant)
    var travel: Double   // thinking — a wave that travels AROUND the ring (processing/churn)
    var lobe: Double     // speaking — asymmetric lobes driven by the voice (level)
    var jitter: Double   // error — high-frequency agitated shake

    static let zero = OrbMotion(amp: 0, speed: 0.6, breathe: 0, pulse: 0, travel: 0, lobe: 0, jitter: 0)

    /// Ease every component toward `target` by factor k (call once per frame).
    mutating func ease(toward t: OrbMotion, _ k: Double) {
        amp     += (t.amp - amp) * k
        speed   += (t.speed - speed) * k
        breathe += (t.breathe - breathe) * k
        pulse   += (t.pulse - pulse) * k
        travel  += (t.travel - travel) * k
        lobe    += (t.lobe - lobe) * k
        jitter  += (t.jitter - jitter) * k
    }
}

enum OrbState {
    case idle, listening, thinking, speaking, error

    /// Per-state rotation of the warm→cool hue sweep (a different hue leads in each state).
    var sweepRotation: Double {
        switch self {
        case .idle: return 0.0; case .listening: return 0.4; case .thinking: return 0.8
        case .speaking: return -0.3; case .error: return -0.6
        }
    }

    /// The motion this state eases toward. Distinct archetype mix per state.
    var motion: OrbMotion {
        switch self {
        //                       amp    speed  breathe pulse travel lobe  jitter
        case .idle:      return OrbMotion(amp: 0.020, speed: 0.6, breathe: 1.0, pulse: 0.0, travel: 0.0,  lobe: 0.0, jitter: 0.0)
        case .listening: return OrbMotion(amp: 0.030, speed: 1.0, breathe: 0.30, pulse: 1.0, travel: 0.12, lobe: 0.0, jitter: 0.0)
        case .thinking:  return OrbMotion(amp: 0.050, speed: 1.5, breathe: 0.15, pulse: 0.0, travel: 1.0,  lobe: 0.0, jitter: 0.0)
        case .speaking:  return OrbMotion(amp: 0.060, speed: 1.2, breathe: 0.15, pulse: 0.0, travel: 0.20, lobe: 1.0, jitter: 0.0)
        case .error:     return OrbMotion(amp: 0.055, speed: 2.6, breathe: 0.0,  pulse: 0.0, travel: 0.0,  lobe: 0.0, jitter: 1.0)
        }
    }
}

final class OrbModel: ObservableObject {
    @Published private(set) var state: OrbState = .idle

    // Mutated every frame (read by the renderer); no need to publish.
    private(set) var smoothed: Double = 0
    var display: Double = 0                                   // eased voice level
    private(set) var motion: OrbMotion = OrbState.idle.motion // eased motion (live)
    var rotDisplay: Double = OrbState.idle.sweepRotation

    private var motionTarget: OrbMotion = OrbState.idle.motion
    private var rotTarget = OrbState.idle.sweepRotation

    /// Feed a raw 0..1 level (RMS of a tts_chunk). Curved + asymmetric-EMA smoothed.
    func ingest(level raw: Double) {
        let target = min(1, max(0, pow(max(0, raw), 0.6)))
        let k = target > smoothed ? 0.35 : 0.08    // fast attack, slow release
        smoothed += (target - smoothed) * k
    }

    /// Advance per-frame easing. Called once per rendered frame.
    func tick() {
        display += (smoothed - display) * 0.2
        motion.ease(toward: motionTarget, 0.06)      // ~0.3s ease → fluid character morph
        rotDisplay += (rotTarget - rotDisplay) * 0.08
    }

    func transition(to s: OrbState) {
        state = s
        motionTarget = s.motion
        rotTarget = s.sweepRotation
    }
}
