// main.swift — KairosHUD entry point.
//
// A GUI AppKit app launched from the command line. We set the activation policy to
// `.accessory` so there's no Dock icon and the app is invisible to Cmd-Tab (the LSUIElement
// equivalent at runtime) — exactly what an always-on HUD wants.

import AppKit
import Metal

let arguments = CommandLine.arguments
let app = NSApplication.shared
app.setActivationPolicy(.accessory)

// Dev tool: render the Metal orb states to PNGs over a purple desktop and exit (no window).
if let i = arguments.firstIndex(of: "--snapshot"), i + 1 < arguments.count {
    let dir = arguments[i + 1]
    guard let orb = MetalOrb() else {
        FileHandle.standardError.write("MetalOrb init failed\n".data(using: .utf8)!)
        exit(1)
    }
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    let cases: [(String, OrbState, Float)] = [
        ("idle", .idle, 0.10), ("listening", .listening, 0.55),
        ("thinking", .thinking, 0.40), ("speaking", .speaking, 0.90), ("error", .error, 0.60),
    ]
    let clear = MTLClearColor(red: 0.02, green: 0.02, blue: 0.03, alpha: 1.0)  // near-black (matches the references)
    for (name, state, level) in cases {
        // render at t=0.6 so the speaking/listening shape deformation is visible in the still
        if let png = orb.snapshotPNG(width: 360, height: 360, time: 0.6, level: level, palette: .of(state), clear: clear, mode: state.mode, baseAngle: state.sweepRotation) {
            try? png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("orb-\(name).png"))
            FileHandle.standardError.write("metal snapshot: orb-\(name).png\n".data(using: .utf8)!)
        }
    }
    exit(0)
}

let delegate = AppDelegate()
app.delegate = delegate
app.run()
