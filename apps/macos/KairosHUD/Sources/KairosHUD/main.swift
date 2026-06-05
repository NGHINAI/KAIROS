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

// Daemon port: --port N, else $KAIROS_DAEMON_PORT, else 9876.
func kairosDaemonPort() -> Int {
    let a = CommandLine.arguments
    if let i = a.firstIndex(of: "--port"), i + 1 < a.count, let p = Int(a[i + 1]) { return p }
    if let e = ProcessInfo.processInfo.environment["KAIROS_DAEMON_PORT"], let p = Int(e) { return p }
    return 9876
}

// Probe: connect, log events for ~6s, exit — verifies the live wire without launching the GUI.
if arguments.contains("--probe") {
    let probeModel = OrbModel()
    let client = DaemonClient(model: probeModel, port: kairosDaemonPort(), verbose: true)
    client.connect()
    FileHandle.standardError.write("probing ws://127.0.0.1:\(kairosDaemonPort())/v1/voice/events for 6s…\n".data(using: .utf8)!)
    RunLoop.main.run(until: Date().addingTimeInterval(6))
    exit(0)
}

let delegate = AppDelegate()
app.delegate = delegate
app.run()
