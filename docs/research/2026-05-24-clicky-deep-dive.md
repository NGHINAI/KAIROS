# Clicky Deep Dive — Research for KAIROS
Date: 2026-05-24

## What Clicky Is

Clicky is a macOS menu-bar-only voice companion app where a small blue triangle cursor follows the mouse and can "fly" to UI elements on screen. The primary interaction model is push-to-talk: hold `Ctrl+Option`, speak, release — the app takes a screenshot of every connected monitor, sends the transcript and screenshots to Claude via vision API, gets a text response, and plays it back through ElevenLabs TTS. Claude can embed spatial `[POINT:x,y:label:screenN]` tags in its response, which cause the blue triangle to animate along a bezier arc to that pixel location on the correct display. The persona is a casually voiced, screen-aware teaching buddy: "you're clicky, a friendly always-on companion that lives in the user's menu bar."

The repo went viral (6000+ stars, 1100+ forks) after a tweet demo in April 2026. As of that date the author forked development private (`heyclicky.com`) and open-sourced the historical codebase under MIT — meaning what's publicly available is the v1 architecture, not whatever is now shipping commercially.

---

## Stack + Architecture

**Language / framework:** Swift + SwiftUI (macOS 14.2+). AppKit is used only where SwiftUI can't reach: `NSPanel` for the non-activating floating panel, `NSStatusItem` for the menu bar icon, `NSHostingView` to bridge SwiftUI into AppKit windows, and `CGEvent` tap for global hotkeys.

**AI layer:**
- LLM: Claude Sonnet 4.6 (Opus 4.6 selectable). SSE streaming, vision (base64 images), conversation history in the messages array.
- STT: AssemblyAI real-time streaming (`u3-rt-pro`) via websocket. OpenAI upload-based and Apple Speech as fallbacks — resolved at build time via `Info.plist` key, not runtime.
- TTS: ElevenLabs `eleven_flash_v2_5`, non-streaming (full audio then play).

**API proxy:** A Cloudflare Worker (`worker/src/index.ts`) acts as a key-hiding reverse proxy. Three routes: `/chat` → Anthropic, `/tts` → ElevenLabs, `/transcribe-token` → AssemblyAI temp token. The app binary has zero API keys. Total worker code: ~142 lines of TypeScript.

**Analytics:** PostHog (`ClickyAnalytics.swift`) for usage events. Identified by user-submitted email.

**Concurrency:** `@MainActor` isolation throughout; async/await for all I/O. No RxSwift/Combine for business logic, just Combine `PassthroughSubject` for the keyboard shortcut publisher.

**Pattern:** MVVM. `CompanionManager` (~1026 lines) is the single ObservableObject state machine that all views observe.

---

## Voice Layer

### STT — AssemblyAI WebSocket Streaming

`AssemblyAIStreamingTranscriptionProvider.swift` fetches a short-lived (480s) token from the Cloudflare Worker on each session start, then opens a `wss://streaming.assemblyai.com/v3/ws` connection. Audio is captured via `AVAudioEngine`, converted to PCM16 mono at 16kHz (`BuddyAudioConversionSupport.swift`), and streamed in real time. Turn-based transcript tracking: the provider waits for `end_of_turn` messages, with a 2.8-second fallback deadline if the explicit final never arrives.

**Critical engineering note documented in CLAUDE.md:** a single long-lived `URLSession` is shared across ALL AssemblyAI streaming sessions (owned by the provider, not the session). Creating and invalidating a `URLSession` per session "corrupts the OS connection pool and causes 'Socket is not connected' errors after a few rapid reconnections." File: `AssemblyAIStreamingTranscriptionProvider.swift`.

### TTS — ElevenLabs (non-streaming)

`ElevenLabsTTSClient.swift` (~81 lines). Full response downloaded to `Data` then played with `AVAudioPlayer`. Model: `eleven_flash_v2_5`, stability 0.5, similarity 0.75. No streaming playback — the cursor spins in "processing" state until the entire audio payload arrives. This is the biggest latency bottleneck in the pipeline.

### Hotkey — `Ctrl+Option` hold-to-speak

`GlobalPushToTalkShortcutMonitor.swift` uses a listen-only `CGEvent.tapCreate` (`.cgSessionEventTap`, `.listenOnly`) on `CFRunLoopGetMain()`. Modifier-only combos like `Ctrl+Option` are detected via `.flagsChanged` events. The event tap auto-re-enables itself on `.tapDisabledByTimeout`. The tap is kept alive as long as the app runs; the guard at `start()` prevents restart from resetting `isShortcutCurrentlyPressed` mid-press.

### Latency profile

End-to-end latency is: `AVAudioEngine capture → WebSocket PCM16 stream (real time) → key-up → AssemblyAI finalize (~1.4s grace period) → screenshot capture → Claude SSE (no partial display, waits for full response) → ElevenLabs TTS request → audio download → playback`. The non-streaming TTS is a design choice — the CLAUDE.md suggests the spinner state makes this acceptable. No VAD is implemented; it's purely edge-triggered on key press/release.

---

## UI / Overlay

### Full-screen transparent overlay

`OverlayWindow.swift` creates one `NSWindow` per connected display:
```swift
self.isOpaque = false
self.backgroundColor = .clear
self.level = .screenSaver          // above submenus and popups
self.ignoresMouseEvents = true     // click-through
self.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
self.hidesOnDeactivate = false
```

The SwiftUI `BlueCursorView` is embedded via `NSHostingView`. Each `BlueCursorView` polls cursor position via a `Timer` every ~16ms and updates its local `CGPoint`. The view checks `screenFrame.contains(mouseLocation)` to only render the triangle on the screen the cursor is actually on.

### Cursor visual design

A blue-glowing equilateral triangle (`DS.Colors.overlayCursorBlue = #3380FF`) with a shadow glow effect. Default rotation: -35° (cursor-like). During flight to a target, rotation is recalculated to face the direction of travel. The triangle scales to ~1.3x at the arc midpoint for a "swooping" feel, then snaps back to 1.0x on landing. Response text displays in a speech bubble positioned 10pt to the right and 18pt below the cursor tip.

### No glassmorphism

The overlay uses `.clear` background and a solid blue fill for speech bubbles. The menu bar panel (`CompanionPanelView.swift`) uses a custom dark design system (`DS.Colors.background = #101211`) with layered surface tokens (surface1–surface4) — effectively dark material but no blur/vibrancy. There is no `NSVisualEffectView` anywhere in the codebase. The "glass" aesthetic comes purely from the color palette and shadow layering.

### Menu bar panel

`MenuBarPanelManager.swift`: `NSStatusItem` with a custom-drawn triangle icon (same shape, hand-drawn with `NSBezierPath`). The dropdown uses a `KeyablePanel: NSPanel` (custom subclass that overrides `canBecomeKey: Bool { true }` so text fields work), `.nonactivatingPanel` style, `.borderless` style mask, dark background. Auto-dismissed by an `NSEvent.addLocalMonitor(for: .leftMouseDown)` outside-click monitor.

### Design system

`DesignSystem.swift` (~880 lines). Full Tailwind CSS v4 blue scale (blue50–blue950) plus semantic surface/border/text tokens. All UI references `DS.Colors.*`. Elevation is communicated through progressively lighter surface tokens (surface1=#171918 → surface4=#2E3130). No third-party UI frameworks.

---

## Conversation Structure + Memory

### In-session conversation history

`CompanionManager` keeps `private var conversationHistory: [(userTranscript: String, assistantResponse: String)]`. Each exchange is appended after response. Capped at 10 exchanges: `if conversationHistory.count > 10 { conversationHistory.removeFirst(conversationHistory.count - 10) }`. Point-coordinate tags are stripped from `assistantResponse` before storing so they don't confuse future turns.

When calling Claude, history is injected as alternating `user`/`assistant` message entries:
```swift
for (userPlaceholder, assistantResponse) in conversationHistory {
    messages.append(["role": "user", "content": userPlaceholder])
    messages.append(["role": "assistant", "content": assistantResponse])
}
```

The current turn then appends all screen images + the transcript as a new user message.

### System prompt structure

The voice system prompt (`companionVoiceResponseSystemPrompt`) is a dense 500-word instruction block, all lowercase, written for TTS output. Key rules: 1-2 sentences default but go long if asked; no markdown/lists/bullets; write for the ear not the eye; spell out numbers; reference specific screen elements; never say "simply" or "just"; end with a "seed" (hint at something bigger) rather than a yes/no question. The pointing instruction tells Claude to embed `[POINT:x,y:label:screenN]` or `[POINT:none]` at the very end of the response.

### No cross-session persistence

Zero. `conversationHistory` is in-memory, lost on app quit. No file-based memory, no CoreData, no SQLite, no embedding store. This is the #1 pain point in the GitHub Issues — multiple open issues requesting persistent memory.

### Multi-LLM support

**Limited.** `ClaudeAPI.swift` (Anthropic, primary) and `OpenAIAPI.swift` (OpenAI GPT vision, optional). A model picker in the panel switches between `claude-sonnet-4-6` and `claude-opus-4-6`. There is no routing logic, no provider abstraction, no Ollama/Gemini/local support. The open Issues have several proposals for multi-provider backends.

---

## Proactivity Assessment

**Clicky is entirely chat-driven. There is zero proactivity.**

The only triggers for AI invocation are:
1. User holds `Ctrl+Option` (push-to-talk)
2. An onboarding demo fires once on first launch — Claude is asked to identify something interesting on screen and point at it

There are no ambient observers, no file watches, no clipboard monitors, no calendar hooks, no focus-app detection, no periodic narration, no standing orders. The app is purely reactive: speak → respond → done. The overlay follows the cursor but never speaks without being explicitly invoked.

This is the foundational architectural difference between Clicky and what KAIROS is building. Clicky is a better Siri button with a cute triangle; KAIROS is an always-on observation daemon that decides when to intervene.

---

## macOS Integration Surfaces

| Surface | How Clicky Does It |
|---|---|
| Menu bar | `NSStatusItem` with custom `NSBezierPath` triangle icon |
| Global hotkey | Listen-only `CGEvent` tap on `CFRunLoopGetMain()`, `.flagsChanged` for modifier-only combos |
| Screen capture | `ScreenCaptureKit` (`SCScreenshotManager.captureImage`) per display, JPEG at 1280px max dimension |
| Multi-monitor | One `OverlayWindow` per `NSScreen`, cursor-screen detection via `NSEvent.mouseLocation` + AppKit frame |
| Microphone | `AVAudioEngine` with tap buffer callbacks |
| Accessibility permission | Required for CGEvent tap; polled every 1.5s via `Timer` |
| App visibility | `LSUIElement=true` in Info.plist — no dock icon, no main window, invisible to Cmd+Tab |
| No Spaces/Mission Control integration | `canJoinAllSpaces` on the overlay, but the menu bar panel is not space-aware |

---

## RECOMMENDATIONS FOR KAIROS

### 1. Adopt the `[POINT:x,y:label:screenN]` protocol verbatim (Phase E/F)

When KAIROS develops a voice layer or HUD, this is the best-documented approach for grounding LLM spatial references to actual pixel coordinates. The coordinate system design (screenshot pixels → display points → AppKit global coords, with per-display scaling), the `isCursorScreen` prioritization, and the multi-monitor `screenN` suffix are all production-tested patterns. File: `CompanionManager.swift` lines 640-690, `CompanionScreenCaptureUtility.swift`.

### 2. The Cloudflare Worker key-proxy pattern is worth copying for KAIROS voice (Phase E)

When adding STT/TTS to KAIROS, the pattern of a 142-line Cloudflare Worker that holds all API keys — returning short-lived tokens for websocket APIs and proxying streaming endpoints — is elegant and keeps the daemon binary clean. The `/transcribe-token` route (480-second AssemblyAI temp token) is particularly clever since it avoids shipping a permanent key while allowing real-time WebSocket connections. The Worker pattern also means the same proxy can serve future mobile/web surfaces.

### 3. The single shared `URLSession` for WebSocket pools (Phase E — STT)

Document this in KAIROS audio code before it becomes a bug: `URLSession` must be shared across AssemblyAI WebSocket sessions, not recreated per-session. Clicky discovered this the hard way ("Socket is not connected" after rapid reconnections). File: `AssemblyAIStreamingTranscriptionProvider.swift`, `sharedWebSocketURLSession`.

### 4. TLS warmup pre-connection for LLM calls (Phase B+)

`ClaudeAPI.init()` fires a background `HEAD /` request immediately at app launch to pre-warm the TLS session ticket. This eliminates the cold handshake latency on the first real API call (which carries a large image payload). Cost: ~10ms background task. Benefit: first-call latency drops significantly. Copy this pattern for any KAIROS component that makes periodic or burst LLM calls. File: `ClaudeAPI.swift`, `warmUpTLSConnectionIfNeeded()`.

### 5. The voice system prompt design (Phase E)

The `companionVoiceResponseSystemPrompt` is the best-designed TTS-aware LLM prompt I've seen in an open repo. Specific techniques to adopt:
- "Write for the ear, not the eye" — ban lists, bullets, markdown, symbols
- Spell-out rule: "write 'for example' not 'e.g.'"
- Default concise but explicit "go long if asked" escape hatch
- "Plant a seed" instead of dead-end yes/no follow-up questions
- "Never say 'simply' or 'just'" — specific banned words
- Coordinate tag appended AFTER spoken text so TTS strip is trivial

---

## ANTI-PATTERNS / Avoid

### 1. Non-streaming TTS

Clicky downloads the full ElevenLabs audio before playing. For a companion that's already finished generating the LLM response, this adds 1–3 seconds of silence. For KAIROS, always use streaming TTS (ElevenLabs `/v1/text-to-speech/{id}/stream`) and pipe bytes to an audio player as they arrive. The felt latency difference is dramatic.

### 2. No memory architecture

Clicky caps history at 10 turns, in-memory only. This is the most-requested feature in Issues. For KAIROS this is Phase B (custom memory layers) — do not skip it. The Issues thread on TINM/PCP is worth reading as prior art for the persistent memory protocol design.

### 3. Open public Cloudflare Worker with no auth

The Clicky Worker has no authentication — anyone who finds the Worker URL can burn your API credits. Multiple Issues call this out. If KAIROS uses a proxy pattern, add signed requests (HMAC-SHA256 with a client secret, or short-lived JWT from the local daemon) from day one.

### 4. Polling timer for cursor position

`BlueCursorView` fires a `Timer` every ~16ms to read `NSEvent.mouseLocation`. This works but is wasteful. KAIROS should use `NSEvent.addGlobalMonitorForEvents(matching: .mouseMoved)` for event-driven cursor tracking rather than polling.

### 5. Fixed shortcut with no configurability

`BuddyDictationManager.swift` has `static let currentShortcutOption: ShortcutOption = .controlOption` — hardcoded. The Issues section has a full thread on this being a UX problem. KAIROS should expose hotkey binding via `STANDING_ORDERS.md` or a settings file from day one to avoid the same complaints.

### 6. No cancellation mid-response

Clicky's `currentResponseTask?.cancel()` fires when the user speaks again, but there's no interrupt-speech-mid-TTS behavior. If Claude is speaking and the user holds the hotkey, TTS stops but there's an awkward gap. Design KAIROS voice with explicit cancellation + immediate microphone activation.

---

## Key Code References

| File | What Makes It Interesting |
|---|---|
| `leanring-buddy/CompanionManager.swift:544–577` | The full voice system prompt — best TTS-aware LLM prompt structure in the repo |
| `leanring-buddy/CompanionManager.swift:580–720` | Complete push-to-talk → screenshot → Claude SSE → TTS → pointing pipeline |
| `leanring-buddy/ClaudeAPI.swift:1–40` | TLS warmup pattern — copy this for any KAIROS LLM client |
| `leanring-buddy/ClaudeAPI.swift:100–175` | SSE streaming parser for Anthropic `content_block_delta` events |
| `leanring-buddy/GlobalPushToTalkShortcutMonitor.swift` | Listen-only `CGEvent` tap for modifier-only global hotkeys |
| `leanring-buddy/AssemblyAIStreamingTranscriptionProvider.swift:1–65` | Shared `URLSession` architecture for WebSocket pool safety |
| `leanring-buddy/CompanionScreenCaptureUtility.swift` | Multi-monitor ScreenCaptureKit with AppKit vs CG coordinate system handling — subtle and correct |
| `leanring-buddy/OverlayWindow.swift:1–60` | Full-screen transparent click-through `NSWindow` init pattern |
| `leanring-buddy/DesignSystem.swift:1–80` | Dark palette with Tailwind blue scale — usable directly for KAIROS HUD Phase F |
| `leanring-buddy/MenuBarPanelManager.swift:80–115` | Hand-drawn `NSBezierPath` triangle menu bar icon — no image assets needed |
| `worker/src/index.ts` | Complete 142-line Cloudflare Worker proxy — copy as KAIROS voice proxy template |
| `leanring-buddy/CompanionManager.swift:950–962` | Onboarding demo system prompt — example of spatial grounding prompt with coordinate constraints |
