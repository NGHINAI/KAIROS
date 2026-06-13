// main.swift — KairosHUD entry point.
//
// A GUI AppKit app launched from the command line. We set the activation policy to
// `.accessory` so there's no Dock icon and the app is invisible to Cmd-Tab (the LSUIElement
// equivalent at runtime) — exactly what an always-on HUD wants.

import AppKit
import Metal
import SwiftUI

let arguments = CommandLine.arguments
let app = NSApplication.shared
app.setActivationPolicy(.accessory)

// RECORDABLE BY DEFAULT: HUD panels are visible to screen recordings/captures
// (sharingType .readOnly) so demos just work. `--capture-invisible` opts back into
// .none — needed later when the Phase-H agent takes its own screenshots and must
// not see itself. Must be set before any panel is constructed.
NonActivatingHUDPanel.recordable = !arguments.contains("--capture-invisible")

// Dev tool: render the Metal orb states to PNGs over a purple desktop and exit (no window).
if let i = arguments.firstIndex(of: "--snapshot"), i + 1 < arguments.count {
    let dir = arguments[i + 1]
    guard let orb = MetalOrb() else {
        FileHandle.standardError.write("MetalOrb init failed\n".data(using: .utf8)!)
        exit(1)
    }
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    let cases: [(String, OrbState, Float)] = [
        ("idle", .idle, 0.0), ("listening", .listening, 0.3),
        ("thinking", .thinking, 0.2), ("speaking", .speaking, 0.9), ("error", .error, 0.3),
    ]
    let clear = MTLClearColor(red: 0.02, green: 0.02, blue: 0.03, alpha: 1.0)  // near-black (matches the references)
    for (name, state, level) in cases {
        // render at t=0.6 so each state's deformation character is visible in the still.
        // (Motion/easing only show live; a still uses each state's resting archetype mix.)
        if let png = orb.snapshotPNG(width: 360, height: 360, time: 0.6, level: level,
                                     motion: state.motion,
                                     clear: clear, baseAngle: Float(state.sweepRotation)) {
            try? png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("orb-\(name).png"))
            FileHandle.standardError.write("metal snapshot: orb-\(name).png\n".data(using: .utf8)!)
        }
    }
    exit(0)
}

// Dev probe: resolve + CLICK an element via AXActor and report whether the screen
// changed — the whole act pipeline without the LLM loop. Exit 0 on changed.
// Usage: KairosHUD --axclick "Appearance" "System Settings"
if let i = arguments.firstIndex(of: "--axclick"), i + 2 < arguments.count {
    let app = arguments[i + 2] == "frontmost" ? nil : arguments[i + 2]
    func summary() -> String? {
        if case .ok(let s, _) = AXFinder.inventory(appName: app) { return s }
        return nil
    }
    switch AXFinder.find(query: arguments[i + 1], appName: app) {
    case .notFound(let reason):
        print("NOT FOUND: \(reason)"); exit(2)
    case .found(let match):
        print("resolved \"\(match.title)\" role=\(match.role ?? "?")")
        let pre = summary()
        let (failure, mode) = AXActor.press(match)
        if let failure { print("PRESS FAILED: \(failure)"); exit(3) }
        usleep(900_000)
        let post = summary()
        let changed = pre != nil && post != nil && pre != post
        print(changed ? "CLICKED (\(mode)) + SCREEN CHANGED" : "clicked (\(mode)) — screen inventory unchanged")
        exit(changed ? 0 : 4)
    }
}

// Dev probe: dump the read_screen inventory summary for an app, then exit.
// Usage: KairosHUD --axinv "System Settings"
if let i = arguments.firstIndex(of: "--axinv"), i + 1 < arguments.count {
    switch AXFinder.inventory(appName: arguments[i + 1] == "frontmost" ? nil : arguments[i + 1]) {
    case .ok(let summary, let entries): print("OK (\(entries.count) entries)\n\(summary)")
    case .failed(let reason): print("FAILED: \(reason)")
    }
    exit(0)
}

// Dev probe: resolve an element via the AX walker and dump what it saw, then exit.
// Usage: KairosHUD --axprobe "Privacy and Security" "System Settings"
if let i = arguments.firstIndex(of: "--axprobe"), i + 2 < arguments.count {
    AXFinder.debug = true
    let r = AXFinder.find(query: arguments[i + 1], appName: arguments[i + 2] == "frontmost" ? nil : arguments[i + 2])
    switch r {
    case .found(let m): print("FOUND \"\(m.title)\" at \(m.frame)")
    case .notFound(let reason): print("NOT FOUND: \(reason)")
    }
    print("--- labels seen during walk (\(AXFinder.seenLabels.count)):")
    for l in AXFinder.seenLabels.prefix(150) { print("  \(l)") }
    exit(0)
}

// Daemon port: --port N, else $KAIROS_DAEMON_PORT, else 9876.
func kairosDaemonPort() -> Int {
    let a = CommandLine.arguments
    if let i = a.firstIndex(of: "--port"), i + 1 < a.count, let p = Int(a[i + 1]) { return p }
    if let e = ProcessInfo.processInfo.environment["KAIROS_DAEMON_PORT"], let p = Int(e) { return p }
    return 9876
}

// Probe: connect, log full event JSON for N seconds (default 6), exit — verifies the live wire
// without launching the GUI. Usage: KairosHUD --probe [seconds]
if let i = arguments.firstIndex(of: "--probe") {
    let secs = (i + 1 < arguments.count ? Double(arguments[i + 1]) : nil) ?? 6
    let probeModel = OrbModel()
    let client = DaemonClient(model: probeModel, port: kairosDaemonPort(), verbose: true)
    client.connect()
    FileHandle.standardError.write("probing ws://127.0.0.1:\(kairosDaemonPort())/v1/voice/events for \(Int(secs))s…\n".data(using: .utf8)!)
    RunLoop.main.run(until: Date().addingTimeInterval(secs))
    exit(0)
}

// Render the Liquid Glass console to a PNG (mock Lane A + Lane B) for layout verification.
// NOTE: ImageRenderer composites over the backdrop we supply here, so the glass refraction looks
// only approximate — judge the TRUE Liquid Glass live (`swift run KairosHUD --mock`). This still
// verifies layout, spacing, the expanded-agent detail, and the count badge.
@MainActor func renderActivitySnaps(toDir dir: String) {
    let a = ActivityModel()
    a.intent(tier: "smart"); a.setStatus("Working on your calendar")
    a.toolCall(id: "1", name: DaemonClient.humanizeTool("GMAIL_FETCH_EMAILS"))
    a.toolDone(id: "1", summary: DaemonClient.humanizeSummary("{\"successful\":true,\"data\":{\"messages\":[{},{},{}]}}"))
    a.toolCall(id: "2", name: DaemonClient.humanizeTool("GOOGLECALENDAR_CREATE_EVENT"))

    let bg = BackgroundModel()
    bg.spawned(id: "bg-inbox", goal: "Organize my inbox")
    bg.tool(id: "bg-inbox", name: DaemonClient.humanizeTool("GMAIL_FETCH_EMAILS"))
    bg.tool(id: "bg-inbox", name: DaemonClient.humanizeTool("GMAIL_MODIFY_LABELS"))
    bg.progress(id: "bg-inbox", note: DaemonClient.humanizeNote("using GMAIL_MODIFY_LABELS"))
    bg.spawned(id: "bg-flights", goal: "Research SF→Tokyo flights")
    bg.progress(id: "bg-flights", note: "comparing 6 itineraries…")

    let approval = ApprovalModel()
    approval.request(id: "ap-1", summary: "Send the weekly report email to the team",
                     toolName: DaemonClient.humanizeTool("GMAIL_SEND_EMAIL"))

    let hud = HUDState()
    hud.consoleOpen = true
    hud.expandedAgentID = "bg-inbox"   // one agent opened to its full step list
    hud.todosExpanded = true           // show the to-dos list expanded for the snapshot

    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    func write(_ view: some View, _ name: String, _ w: CGFloat, _ h: CGFloat) {
        let r = ImageRenderer(content: view.frame(width: w, height: h)); r.scale = 2
        if let img = r.nsImage, let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
           let png = rep.representation(using: .png, properties: [:]) {
            try? png.write(to: URL(fileURLWithPath: dir).appendingPathComponent(name))
        }
    }
    // Faux desktop backdrop so the glass has something to (approximately) refract.
    let backdrop = LinearGradient(colors: [Color(.sRGB, red: 0.10, green: 0.08, blue: 0.18),
                                           Color(.sRGB, red: 0.04, green: 0.05, blue: 0.10)],
                                  startPoint: .topLeading, endPoint: .bottomTrailing)
    write(ZStack { backdrop; ConsoleView(activity: a, bg: bg, hud: hud, approval: approval).environment(\.glassEnabled, false) },
          "console.png", 420, 560)
    FileHandle.standardError.write("wrote console.png\n".data(using: .utf8)!)
}

if let i = arguments.firstIndex(of: "--activitysnap"), i + 1 < arguments.count {
    MainActor.assumeIsolated { renderActivitySnaps(toDir: arguments[i + 1]) }
    exit(0)
}

// Dev tool: render the console with REAL Liquid Glass over a colorful backdrop in a normal
// (capturable) full-screen window, screenshot it, and exit. This is the only way to SEE the true
// .glassEffect (ImageRenderer can't draw it and the HUD panel is sharingType=.none). The opaque
// fullscreen backdrop also means the screenshot shows only our content, not the user's screen.
// Usage: KairosHUD --glasstest /tmp/glass.png
if let i = arguments.firstIndex(of: "--glasstest"), i + 1 < arguments.count {
    let out = arguments[i + 1]
    MainActor.assumeIsolated { GlassTest.run(out: out) }
    app.run()
}

let delegate = AppDelegate()
app.delegate = delegate
app.run()
