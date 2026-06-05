// swift-tools-version:5.9
// Package.swift — KairosHUD
//
// The native macOS "Living Oval" HUD sidecar (amends Architecture A; Electron retired for the HUD).
// A thin renderer: it PROJECTS the daemon's WebSocket event stream into a notch-docked,
// never-steal-focus NSPanel with an audio-reactive orb. No agent logic lives here.
//
// Build / run (Command Line Tools, no Xcode needed):
//   cd apps/macos/KairosHUD && swift build
//   swift run KairosHUD            # live (connects ws://127.0.0.1:9876 — wired in a later step)
//   swift run KairosHUD --mock     # daemon-free: scripted state/level cycling
//
// NOTE: true Liquid Glass (.glassEffect) needs the macOS 26 SDK (Xcode 26 / 26.x Command Line Tools).
// On the current SDK we use NSVisualEffectView / .ultraThinMaterial via the GlassEffect shim.

import PackageDescription

let package = Package(
    name: "KairosHUD",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "KairosHUD", targets: ["KairosHUD"]),
    ],
    dependencies: [],
    targets: [
        .executableTarget(
            name: "KairosHUD",
            path: "Sources/KairosHUD",
            linkerSettings: [
                .linkedFramework("AppKit"),
            ]
        )
    ]
)
