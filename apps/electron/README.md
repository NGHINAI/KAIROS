# KAIROS Electron shell (alpha)

Alternative shell for KAIROS that replaces the pure-Swift `KairosVoiceHelper`
with an Electron + React frontend. The minimal Swift helper at
`apps/macos/KairosSpeechHelper/` is spawned as a child process and handles
only STT (SFSpeechRecognizer) + TTS (AVSpeechSynthesizer).

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Electron main (TypeScript)                              │
│   - globalShortcut('Alt+Space')                          │
│   - Spawns KairosSpeechHelper                            │
│   - IPC bridge to renderer                               │
│         │                                                │
│  Renderer (React)                                        │
│   - getUserMedia → MediaRecorder → WAV → base64          │
│   - send to helper via IPC                               │
│   - receive transcript → call LLM → call helper.speak    │
│         │                                                │
│  Swift helper (KairosSpeechHelper, ~150 LOC)             │
│   - SFSpeechURLRecognitionRequest (file-based)           │
│   - AVSpeechSynthesizer ("Zoe (Premium)")                │
└──────────────────────────────────────────────────────────┘
```

## Status

- ✅ Project scaffolded (package.json, vite, tsconfig)
- ✅ Main process: globalShortcut + helper spawn + IPC
- ✅ Preload: safe bridge
- ✅ Renderer: React UI + getUserMedia + MediaRecorder
- ✅ KairosSpeechHelper builds (`swift build -c release`)
- ⏳ Need to install electron + run `bun install`
- ⏳ Need to wire LLM call to Bun daemon wrap-API
- ⏳ Need to test end-to-end

## Run (when ready)

```bash
cd apps/electron
bun install
bun run build:main
bun run dev   # vite + electron in parallel
```

In another terminal, the Bun daemon runs as before:
```bash
cd ../..
bun src/daemon/index.ts
```

## Comparison to Swift-only version

| | Swift-only (v0.6.0-voice-swift-working tag) | Electron + Swift helper |
|---|---|---|
| Hotkey | CGEventTap (Accessibility TCC) | globalShortcut (no extra perm) |
| Mic | AVAudioEngine + manual TCC | getUserMedia (clean prompt) |
| STT | SFSpeechRecognizer (streaming) | SFSpeechURLRecognitionRequest (file) |
| TTS | AVSpeechSynthesizer (Zoe Premium) | AVSpeechSynthesizer (Zoe Premium) |
| App size | 10 MB | ~150 MB |
| Cross-platform | macOS only | Easy Windows/Linux later |

## Fallback

If Electron path stalls, revert to Swift-only:
```bash
git checkout v0.6.0-voice-swift-working
```
That tag is the validated working state.
