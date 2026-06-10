// swift-tools-version:6.2
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
// Targets macOS 26 (Tahoe) so we use NATIVE Liquid Glass (.glassEffect / GlassEffectContainer /
// glassEffectID) unconditionally — verified available on the active SDK 26.2 toolchain.

import PackageDescription

let package = Package(
    name: "KairosHUD",
    platforms: [.macOS(.v26)],
    products: [
        .executable(name: "KairosHUD", targets: ["KairosHUD"]),
    ],
    dependencies: [],
    targets: [
        .executableTarget(
            name: "KairosHUD",
            path: "Sources/KairosHUD",
            // tools 6.2 is required only for the macOS-26 platform (Liquid Glass). Keep the Swift 5
            // language mode so the single-threaded UI client isn't forced through Swift 6 strict
            // actor-isolation refactors (URLSession callbacks hopping to @MainActor are fine here).
            swiftSettings: [
                .swiftLanguageMode(.v5),
            ],
            linkerSettings: [
                .linkedFramework("AppKit"),
            ]
        )
    ]
)
