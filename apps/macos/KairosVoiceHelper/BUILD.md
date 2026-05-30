# KairosVoiceHelper — build instructions

This is the Swift sidecar for KAIROS Phase E.1 voice. It handles all audio APIs
(SFSpeechRecognizer, AVSpeechSynthesizer, AVAudioEngine, CGEventTap) on macOS,
and communicates with the Bun daemon over a Unix domain socket using JSON lines.

## Prerequisites

- macOS 15 (Sequoia) or later
- Xcode 16+ with command-line tools
- Apple Developer ID certificate for code signing (free Apple ID works for local dev)
- Silero VAD CoreML model — download `silero_vad.mlmodelc` and place at
  `Sources/KairosVoiceHelper/Resources/silero_vad.mlmodelc`
  (source: <https://github.com/FluidInference/FluidAudio> — convert the ONNX
  model to Core ML, or use any prebuilt `.mlmodelc`)

## Build & run (development)

```bash
cd apps/macos/KairosVoiceHelper
swift build -c release
.build/release/KairosVoiceHelper
```

The binary listens at `~/Library/Application Support/KAIROS/voiced.sock`.
The Bun daemon (`bun src/daemon/index.ts`) auto-discovers it.

## Build a signed .app for distribution

1. Open this directory in Xcode (`File → Open`)
2. Create a new macOS App target named `KairosVoiceHelper` that wraps the Package
3. In `Info.plist`, set usage descriptions:
   - `NSMicrophoneUsageDescription` — "KAIROS needs your mic to hear you when you press the hotkey."
   - `NSSpeechRecognitionUsageDescription` — "KAIROS uses on-device speech recognition to transcribe what you say."
   - `NSAppleEventsUsageDescription` — "KAIROS uses keyboard events for the global push-to-talk hotkey."
4. Add entitlements (`KairosVoiceHelper.entitlements`):
   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0"><dict>
     <key>com.apple.security.app-sandbox</key><false/>
     <key>com.apple.security.device.audio-input</key><true/>
   </dict></plist>
   ```
5. Build & sign:
   ```bash
   xcodebuild -scheme KairosVoiceHelper -configuration Release \
       CODE_SIGN_IDENTITY="Developer ID Application: Nirmal Ghinaiya (XXXXXX)" \
       DEVELOPMENT_TEAM="XXXXXX"
   ```

## Install as a LaunchAgent (auto-start)

After building the signed `.app`:

```bash
# Copy to /Applications
sudo cp -R build/Release/KairosVoiceHelper.app /Applications/

# Install LaunchAgent plist
cp installer/com.kairos.voicehelper.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.kairos.voicehelper.plist
```

The first launch triggers macOS TCC prompts for mic + accessibility + speech.

## Why LaunchAgent and not LaunchDaemon

LaunchDaemons run as root, but TCC permission prompts only trigger for user-domain
processes. LaunchAgents run in the user session — the only path that gets us
microphone + accessibility access without manual System Settings clicks.

## Testing without TCC permissions (CI / pre-release)

The Bun daemon side has a `SidecarSimulator` (src/daemon/voice/sidecarSimulator.ts)
that mocks this entire process in-memory. All unit tests use it. You only need
the real sidecar for end-user / acceptance testing.
