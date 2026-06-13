// MetalOrbView.swift — the LIVE orb: a CAMetalLayer-backed NSView driven by a display link.
//
// Renders the same MetalOrb pipeline as the snapshot path, every frame, into the layer's drawable,
// with a transparent clear so it composites over the desktop (no box). Reads (state, level) from the
// shared OrbModel. The shader is runtime-compiled — no toolchain, runs on any Mac.

import AppKit
import Metal
import QuartzCore

final class MetalOrbView: NSView {
    private let model: OrbModel
    private let orb: MetalOrb?
    private let metalLayer = CAMetalLayer()
    private var displayLink: CADisplayLink?
    private let start = CACurrentMediaTime()

    init(model: OrbModel, orb: MetalOrb?) {
        self.model = model
        self.orb = orb
        super.init(frame: .zero)
        wantsLayer = true
        metalLayer.device = orb?.device ?? MTLCreateSystemDefaultDevice()
        metalLayer.pixelFormat = .bgra8Unorm
        metalLayer.framebufferOnly = true
        metalLayer.isOpaque = false                 // transparent → composites over the desktop
        metalLayer.backgroundColor = NSColor.clear.cgColor
        // NEVER let a starved drawable pool block: when the screen is locked/asleep
        // the compositor stops releasing drawables, and a blocking nextDrawable()
        // wedged the MAIN THREAD permanently (every display-link tick waited the
        // full internal timeout, back to back — keepalives, timers, and the whole
        // guide pipeline went dark while TCP stayed "connected"; live 2026-06-11).
        metalLayer.allowsNextDrawableTimeout = true
    }

    required init?(coder: NSCoder) { fatalError() }

    override func makeBackingLayer() -> CALayer { metalLayer }

    override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        updateDrawableSize()
    }

    override func layout() {
        super.layout()
        updateDrawableSize()
    }

    private func updateDrawableSize() {
        let scale = window?.backingScaleFactor ?? 2
        metalLayer.contentsScale = scale
        metalLayer.drawableSize = CGSize(width: bounds.width * scale, height: bounds.height * scale)
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window != nil, displayLink == nil {
            let link = displayLink(target: self, selector: #selector(tick))
            link.add(to: .main, forMode: .common)
            displayLink = link
            updateDrawableSize()
            observeScreenLock()
        } else if window == nil {
            displayLink?.invalidate()
            displayLink = nil
        }
    }

    // ── render-starvation defenses ────────────────────────────────────────────
    // A status-bar-level joins-all-spaces panel still reports occlusionState
    // .visible ON THE LOCK SCREEN, but the compositor stops releasing drawables —
    // every nextDrawable() then blocks ~1s, the display link refires immediately,
    // and the MAIN THREAD spends 100% of its time wedged (live 2026-06-11: the
    // whole guide pipeline + WS heartbeat went dark; `sample` showed 1518/1519
    // samples inside the drawable semaphore). Two layers of defense:
    //   1. explicit lock/sleep notifications pause the display link outright;
    //   2. a SELF-HEALING breaker: any slow/failed drawable acquisition pauses
    //      rendering for 2s — whatever the cause, main stays responsive and the
    //      orb resumes by itself.

    private func observeScreenLock() {
        let dnc = DistributedNotificationCenter.default()
        dnc.addObserver(forName: .init("com.apple.screenIsLocked"), object: nil, queue: .main) { [weak self] _ in
            self?.displayLink?.isPaused = true
        }
        dnc.addObserver(forName: .init("com.apple.screenIsUnlocked"), object: nil, queue: .main) { [weak self] _ in
            self?.displayLink?.isPaused = false
        }
        let wnc = NSWorkspace.shared.notificationCenter
        wnc.addObserver(forName: NSWorkspace.screensDidSleepNotification, object: nil, queue: .main) { [weak self] _ in
            self?.displayLink?.isPaused = true
        }
        wnc.addObserver(forName: NSWorkspace.screensDidWakeNotification, object: nil, queue: .main) { [weak self] _ in
            self?.displayLink?.isPaused = false
        }
    }

    private func backOff() {
        displayLink?.isPaused = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { [weak self] in
            self?.displayLink?.isPaused = false
        }
    }

    @objc private func tick() {
        guard window?.occlusionState.contains(.visible) == true else { return }
        guard let orb else { return }
        let t0 = CACurrentMediaTime()
        let drawable = metalLayer.nextDrawable()
        // Starvation breaker: a slow or failed acquisition means the compositor
        // isn't draining the pool — back off instead of blocking every frame.
        if drawable == nil || CACurrentMediaTime() - t0 > 0.25 {
            if drawable == nil { backOff(); return }
            backOff()
        }
        guard let drawable else { return }
        model.tick()  // advance eased level + motion archetype weights + hue rotation
        let t = Float(CACurrentMediaTime() - start)
        let size = SIMD2(Float(drawable.texture.width), Float(drawable.texture.height))
        let u = orb.uniforms(time: t, level: Float(model.display), size: size,
                             motion: model.motion, baseAngle: Float(model.rotDisplay))
        guard let cmd = orb.queue.makeCommandBuffer() else { return }
        orb.encode(into: drawable.texture, clear: MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0), uniforms: u, commandBuffer: cmd)
        cmd.present(drawable)
        cmd.commit()
    }
}
