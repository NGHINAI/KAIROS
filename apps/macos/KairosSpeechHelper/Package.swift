// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "KairosSpeechHelper",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "KairosSpeechHelper", targets: ["KairosSpeechHelper"]),
    ],
    targets: [
        .executableTarget(
            name: "KairosSpeechHelper",
            path: "Sources/KairosSpeechHelper",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("AVFoundation"),
                .linkedFramework("Speech"),
            ]
        )
    ]
)
