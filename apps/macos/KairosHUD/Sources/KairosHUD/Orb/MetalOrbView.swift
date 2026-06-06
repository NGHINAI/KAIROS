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
        } else if window == nil {
            displayLink?.invalidate()
            displayLink = nil
        }
    }

    @objc private func tick() {
        guard let orb, let drawable = metalLayer.nextDrawable() else { return }
        model.tick()  // advance level smoothing + palette cross-fade
        let t = Float(CACurrentMediaTime() - start)
        let size = SIMD2(Float(drawable.texture.width), Float(drawable.texture.height))
        let u = orb.uniforms(palette: model.paletteDisplay, time: t, level: Float(model.display), size: size, mode: model.state.mode, baseAngle: model.state.sweepRotation)
        guard let cmd = orb.queue.makeCommandBuffer() else { return }
        orb.encode(into: drawable.texture, clear: MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0), uniforms: u, commandBuffer: cmd)
        cmd.present(drawable)
        cmd.commit()
    }
}
