// swift-tools-version:5.9
// Package.swift — KairosVoiceHelper
//
// Standalone Swift binary that hosts the audio pipeline for KAIROS voice.
// Communicates with the Bun daemon over a Unix domain socket using line-delimited JSON.
//
// Build (development):
//   cd apps/macos/KairosVoiceHelper && swift build -c release
//   .build/release/KairosVoiceHelper
//
// Build (signed .app for distribution):
//   see BUILD.md

import PackageDescription

let package = Package(
    name: "KairosVoiceHelper",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "KairosVoiceHelper", targets: ["KairosVoiceHelper"]),
    ],
    dependencies: [],
    targets: [
        .executableTarget(
            name: "KairosVoiceHelper",
            path: "Sources/KairosVoiceHelper",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("AVFoundation"),
                .linkedFramework("Speech"),
                .linkedFramework("CoreGraphics"),
                .linkedFramework("Carbon"),
            ]
        )
    ]
)
