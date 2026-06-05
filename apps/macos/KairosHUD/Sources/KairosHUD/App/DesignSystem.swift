// DesignSystem.swift — per-state palettes for the energy ring.
//
// Each state has a 3-color gradient that sweeps around the ring (max 3 colors, per the brief).
// State changes BOTH the colors (here) and the ring's shape/motion (the shader `mode`). Colors are
// plain RGB doubles so they cross-fade by lerping between states.

import SwiftUI

struct RGB {
    var r: Double, g: Double, b: Double
    func lerp(_ o: RGB, _ k: Double) -> RGB {
        RGB(r: r + (o.r - r) * k, g: g + (o.g - g) * k, b: b + (o.b - b) * k)
    }
    var simd: SIMD4<Float> { SIMD4(Float(r), Float(g), Float(b), 1) }
}

/// Exactly 3 gradient colors per state.
struct Palette {
    var g0: RGB, g1: RGB, g2: RGB
    func lerp(_ o: Palette, _ k: Double) -> Palette {
        Palette(g0: g0.lerp(o.g0, k), g1: g1.lerp(o.g1, k), g2: g2.lerp(o.g2, k))
    }
}

extension Palette {
    // idle — calm cool
    static let idle = Palette(
        g0: RGB(r: 0.30, g: 0.45, b: 1.00), g1: RGB(r: 0.20, g: 0.80, b: 1.00), g2: RGB(r: 0.28, g: 1.00, b: 0.86))
    // listening — bright attentive cyan/aqua
    static let listening = Palette(
        g0: RGB(r: 0.15, g: 0.85, b: 1.00), g1: RGB(r: 0.32, g: 1.00, b: 0.90), g2: RGB(r: 0.30, g: 0.55, b: 1.00))
    // thinking — violet/magenta
    static let thinking = Palette(
        g0: RGB(r: 0.62, g: 0.40, b: 1.00), g1: RGB(r: 1.00, g: 0.42, b: 0.92), g2: RGB(r: 0.45, g: 0.48, b: 1.00))
    // speaking — warm + cool energetic (the #1/#2 reference look)
    static let speaking = Palette(
        g0: RGB(r: 1.00, g: 0.45, b: 0.10), g1: RGB(r: 1.00, g: 0.78, b: 0.34), g2: RGB(r: 0.16, g: 0.86, b: 1.00))
    // error — red/orange
    static let error = Palette(
        g0: RGB(r: 1.00, g: 0.26, b: 0.20), g1: RGB(r: 1.00, g: 0.52, b: 0.20), g2: RGB(r: 1.00, g: 0.22, b: 0.36))

    static func of(_ s: OrbState) -> Palette {
        switch s {
        case .idle: return .idle
        case .listening: return .listening
        case .thinking: return .thinking
        case .speaking: return .speaking
        case .error: return .error
        }
    }
}
