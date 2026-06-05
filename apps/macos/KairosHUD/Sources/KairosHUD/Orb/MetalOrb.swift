// MetalOrb.swift — the Metal renderer for the orb.
//
// Compiles OrbShaders.source at runtime (MTLDevice.makeLibrary(source:)) — no offline Metal
// toolchain, no .metallib, works with plain `swift build` and on every user's Mac. Renders either
// into a CAMetalLayer drawable (live) or an offscreen texture read back to a PNG (headless snapshot,
// the verify loop). Uniforms layout matches the MSL `Uniforms` struct exactly.

import Metal
import CoreGraphics
import AppKit
import simd

struct OrbUniforms {
    var resolution: SIMD2<Float> = .zero
    var time: Float = 0
    var level: Float = 0
    var cWarm: SIMD4<Float> = .zero
    var cAccent: SIMD4<Float> = .zero
    var cCool: SIMD4<Float> = .zero
    var cRim: SIMD4<Float> = .zero
    var params: SIMD4<Float> = .zero   // x=glow y=radius z=coreBright w=lineOpacity
}

final class MetalOrb {
    let device: MTLDevice
    let queue: MTLCommandQueue
    let pipeline: MTLRenderPipelineState

    init?() {
        guard let dev = MTLCreateSystemDefaultDevice(), let q = dev.makeCommandQueue() else { return nil }
        device = dev
        queue = q
        do {
            let lib = try dev.makeLibrary(source: OrbShaders.source, options: nil)   // runtime compile
            guard let vfn = lib.makeFunction(name: "v_main"), let ffn = lib.makeFunction(name: "f_main") else { return nil }
            let desc = MTLRenderPipelineDescriptor()
            desc.vertexFunction = vfn
            desc.fragmentFunction = ffn
            let ca = desc.colorAttachments[0]!
            ca.pixelFormat = .bgra8Unorm
            ca.isBlendingEnabled = true
            ca.rgbBlendOperation = .add
            ca.alphaBlendOperation = .add
            ca.sourceRGBBlendFactor = .one                 // shader outputs premultiplied
            ca.sourceAlphaBlendFactor = .one
            ca.destinationRGBBlendFactor = .oneMinusSourceAlpha
            ca.destinationAlphaBlendFactor = .oneMinusSourceAlpha
            pipeline = try dev.makeRenderPipelineState(descriptor: desc)
        } catch {
            FileHandle.standardError.write("MetalOrb: shader compile failed: \(error)\n".data(using: .utf8)!)
            return nil
        }
    }

    func uniforms(palette p: Palette, time: Float, level: Float, size: SIMD2<Float>, mode: Float = 0, baseAngle: Float = 1.5708, flip: Float = 1) -> OrbUniforms {
        var u = OrbUniforms()
        u.resolution = size
        u.time = time
        u.level = level
        u.cWarm = p.g0.simd                        // 3 gradient colors (per state)
        u.cAccent = p.g1.simd
        u.cCool = p.g2.simd
        u.cRim = SIMD4(baseAngle, flip, mode, 0)   // sweepRotation, handedness, state mode
        u.params = SIMD4(1.1, 0.44, 0.006, 0.0)    // bloom/exposure, ringRadius(leave margin for glow), coreWidth(LASER-thin), rotSpeed
        return u
    }

    /// Render the orb into a render target. Shared by live (drawable) and snapshot (offscreen).
    func encode(into texture: MTLTexture, clear: MTLClearColor, uniforms: OrbUniforms, commandBuffer cmd: MTLCommandBuffer) {
        let rp = MTLRenderPassDescriptor()
        rp.colorAttachments[0].texture = texture
        rp.colorAttachments[0].loadAction = .clear
        rp.colorAttachments[0].clearColor = clear
        rp.colorAttachments[0].storeAction = .store
        guard let enc = cmd.makeRenderCommandEncoder(descriptor: rp) else { return }
        var u = uniforms
        enc.setRenderPipelineState(pipeline)
        enc.setFragmentBytes(&u, length: MemoryLayout<OrbUniforms>.stride, index: 0)
        enc.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        enc.endEncoding()
    }

    /// Headless: render to an offscreen texture and read back a PNG. No window/display needed.
    func snapshotPNG(width: Int, height: Int, time: Float, level: Float, palette: Palette, clear: MTLClearColor, mode: Float = 0, baseAngle: Float = 1.5708, flip: Float = 1) -> Data? {
        let td = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: width, height: height, mipmapped: false)
        td.usage = [.renderTarget, .shaderRead]
        td.storageMode = .shared
        guard let tex = device.makeTexture(descriptor: td), let cmd = queue.makeCommandBuffer() else { return nil }
        let u = uniforms(palette: palette, time: time, level: level, size: SIMD2(Float(width), Float(height)), mode: mode, baseAngle: baseAngle, flip: flip)
        encode(into: tex, clear: clear, uniforms: u, commandBuffer: cmd)
        cmd.commit()
        cmd.waitUntilCompleted()

        let rowBytes = width * 4
        var raw = [UInt8](repeating: 0, count: rowBytes * height)
        tex.getBytes(&raw, bytesPerRow: rowBytes, from: MTLRegionMake2D(0, 0, width, height), mipmapLevel: 0)
        guard let cs = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
        let info = CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
        guard let ctx = CGContext(data: &raw, width: width, height: height, bitsPerComponent: 8,
                                  bytesPerRow: rowBytes, space: cs, bitmapInfo: info),
              let cg = ctx.makeImage() else { return nil }
        return NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:])
    }
}
