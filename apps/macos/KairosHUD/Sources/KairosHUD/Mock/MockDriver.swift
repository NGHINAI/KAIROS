// MockDriver.swift — daemon-free dev driver.
//
// Cycles the orb through its states and feeds a synthetic level so the HUD is alive without the
// Bun daemon running. Once the WebSocket Transport lands, this is what `--mock` selects instead of
// a live connection. Drives the SAME OrbModel the real Transport will, so the orb code never changes.

import Foundation

final class MockDriver {
    private let model: OrbModel
    private var frameTimer: Timer?
    private var stateTimer: Timer?
    private var t: Double = 0
    private var phase = 0
    private let states: [OrbState] = [.idle, .listening, .thinking, .speaking, .error]

    init(model: OrbModel) { self.model = model }

    func start() {
        model.transition(to: .idle)
        // ~30 Hz level feed
        frameTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in
            self?.feed()
        }
        // walk through states so you can see all five
        stateTimer = Timer.scheduledTimer(withTimeInterval: 3.5, repeats: true) { [weak self] _ in
            self?.cycle()
        }
    }

    private func feed() {
        t += 1.0 / 30.0
        switch model.state {
        case .speaking:
            // a voice-like envelope: two beating sines + a little noise
            let env = 0.5 + 0.42 * sin(t * 6.0) + 0.18 * sin(t * 13.0)
            model.ingest(level: min(1, max(0, env)) * (0.6 + 0.4 * Double.random(in: 0...1)))
        case .listening:
            model.ingest(level: max(0, 0.30 + 0.30 * sin(t * 4.0)))
        default:
            model.ingest(level: 0)
        }
    }

    private func cycle() {
        phase = (phase + 1) % states.count
        model.transition(to: states[phase])
    }
}
