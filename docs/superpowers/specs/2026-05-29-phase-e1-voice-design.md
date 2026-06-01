# Phase E.1 — Voice (Apple-Native + Swift Sidecar + Wrap-API)

**Status:** Design APPROVED. Ready for implementation planning.
**Owner:** Nirmal Ghinaiya
**Builds on:** Phase D (Composio triggers ✅), C.3.1 (soul.md + persona), C.4.1 (standing orders), perception bus.
**Blocks:** Phase F (HUD — wants voice state to animate), Phase E.2 (Self-healing Composio — wants voice pickers).
**Ships as:** `v0.6.0`. Estimated effort: ~3-4 weeks of focused work.

---

## 1. The Vision

KAIROS becomes **a voice you talk to**, not an app you launch. Push-to-talk via global hotkey, ambient speech the moment something matters. Like calling a Bland/Vapi voice agent — but it's *yours*, runs on your Mac, hears you when you say so, talks when you need to know.

**It is not a chat window with audio.** It is a real-time conversational interface where the daemon is a *presence*. No keyboard input. No clicking. No screen-reading. Voice is the primary surface; the Phase F HUD (Living Oval) is the visual companion.

---

## 2. Non-Goals (explicit)

- ❌ Wake-word ("Hey KAIROS") in v1 — push-to-talk only (v2 candidate)
- ❌ Personal Voice cloning (skip entirely)
- ❌ Multi-language v1 — English only
- ❌ Streaming TTS chunk-by-punctuation — batch responses in v1, optimize in v1.5
- ❌ Cloud TTS day-1 — Apple voices first, pluggable for Cartesia/ElevenLabs v1.5
- ❌ BYOK / user-supplied API keys — KAIROS provides all
- ❌ Web dashboard / settings UI — voice-only configuration
- ❌ KAIROS Cloud infrastructure — defer until public launch (wrap-API now, swap later)

---

## 3. Core User Experience

### 3.1 The voice loop the user actually feels

```
USER: [holds Option key]
        ↓
KAIROS: [listening — Living Oval pulses cyan]
        ↓
USER: "what's on my calendar this afternoon"
        ↓
USER: [releases Option key]
        ↓
[~300ms]  Apple STT finishes transcript
[~80ms]   Bun daemon receives → calls /v1/llm/complete (local wrap)
[~400ms]  Claude Haiku 4.5 first token
[~150ms]  Apple TTS speaks first phrase
        ↓
KAIROS: "You've got a 1:30 with Sarah, then nothing until 4."
        ↓
USER: [starts to speak over KAIROS]
        ↓
[~150ms]  Silero VAD detects user voice while KAIROS is speaking
        ↓
KAIROS: [stops mid-sentence, ducks volume to 0]
        ↓
USER: "what's that 4 o'clock"
        ↓
KAIROS: "Engineering review with the team. Quarterly thing."
```

**Latency budget for round-trip: ~700–1000ms voice-to-voice on M2+.**

### 3.2 Proactive speech (always-on output)

When a Composio trigger fires, the LLM decides if the user should be interrupted. If yes:

```
[Linear issue created → reactive evaluator → action: notify(voice)]
        ↓
KAIROS: [voice cuts in, gentle but not soft]
        "Hey, AJG-23 just got opened by Sarah. It's the auth bug
         you flagged yesterday. Want details?"
```

This works regardless of what the user is doing — KAIROS speaks through the system audio output the same way Spotify does. The Living Oval (Phase F) glows on the same beat.

### 3.3 Barge-in (interruption) — the most critical UX property

This is what separates "voice agent" from "speech notification."

**The rule: anytime KAIROS is speaking AND Silero VAD detects user voice with confidence >0.7, KAIROS stops within 150–170ms.**

Mechanism:
1. Silero VAD runs continuously, including during TTS playback
2. Apple's `VoiceProcessingIO` audio unit subtracts KAIROS's own TTS from the mic input (echo cancellation) — so VAD only triggers on the user's real voice, not KAIROS hearing itself
3. On user-voice detect:
   - `AVSpeechSynthesizer.stopSpeaking(at: .immediate)`
   - Ramp `playerNode.volume` to 0 over ~80ms (avoid pop)
   - Abort the LLM stream (HTTP cancel signal)
   - Write `voice.agent.utterance.interrupted` event to perception bus
   - Switch to listening mode

**Without barge-in, KAIROS feels robotic.** With it, conversations actually flow.

---

## 4. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                       USER'S MAC                                         │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  Existing KAIROS Bun daemon                                       │  │
│  │  (src/daemon/index.ts — Phase A–D already shipped)                │  │
│  │                                                                   │  │
│  │  Voice integration:                                               │  │
│  │   • src/daemon/voice/voiceConductor.ts                            │  │
│  │     - Subscribes to perception bus                                │  │
│  │     - Decides when to speak (proactive)                           │  │
│  │     - Decides what to do with user voice input (reactive)         │  │
│  │   • Talks to:                                                     │  │
│  │     ├─ Localhost wrap-API server (in-process)                     │  │
│  │     │   127.0.0.1:9876 — /v1/llm/complete, /v1/voice/tts, etc.   │  │
│  │     │   (For migration: just flip base URL to api.kairos.ai)     │  │
│  │     └─ Swift sidecar via Unix domain socket                      │  │
│  │         ~/Library/Application Support/KAIROS/voiced.sock         │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                  ↑              ↑                                       │
│                  │              │                                       │
│   ┌──────────────┴───┐    ┌────┴──────────────────────────────────┐   │
│   │ Wrap-API server   │   │  KairosVoiceHelper.app                  │   │
│   │ (in Bun daemon)   │   │  (Swift, LaunchAgent, ~5MB)            │   │
│   │                   │   │                                          │   │
│   │ /v1/llm/*         │   │  AVAudioEngine graph:                   │   │
│   │ /v1/voice/*       │   │   inputNode (VoiceProcessingIO on)      │   │
│   │ /v1/memory/*      │   │     → ring buffer                       │   │
│   │ /v1/orders/*      │   │     → Apple SFSpeechRecognizer (STT)    │   │
│   │ /v1/composio/*    │   │     → Silero VAD (CoreML, ANE)          │   │
│   │ /v1/settings/*    │   │   playerNode                            │   │
│   │ /v1/personal/*    │   │     ← AVSpeechSynthesizer (TTS)         │   │
│   │                   │   │   mainMixer → outputNode                │   │
│   │ Today:            │   │                                          │   │
│   │  → Anthropic SDK  │   │  Global hotkey:                         │   │
│   │  → embedded key   │   │   CGEventTap on flagsChanged            │   │
│   │                   │   │   (double-tap Control / hold Option)    │   │
│   │ Tomorrow (Cloud): │   │                                          │   │
│   │  → fetch          │   │  Stdio JSON-line protocol over UDS:     │   │
│   │     api.kairos.ai │   │   { "event": "stt_partial", ... }      │   │
│   │                   │   │   { "cmd": "speak", "text": "..." }    │   │
│   └───────────────────┘   └──────────────────────────────────────────┘   │
│                                            ↑                            │
│                                            │ AVAudioSession.voiceChat    │
│                                            ↓                            │
│                                ┌───────────────────────┐                │
│                                │  Mic + Speakers       │                │
│                                └───────────────────────┘                │
└─────────────────────────────────────────────────────────────────────────┘
                                            ↓ (HTTPS, only LLM calls)
┌─────────────────────────────────────────────────────────────────────────┐
│  PROVIDERS (Anthropic, Composio — for now)                              │
│  api.anthropic.com  ← all model calls                                   │
│  Composio API       ← triggers + actions (Phase D, unchanged)           │
│                                                                          │
│  Audio NEVER leaves the Mac. STT + TTS are 100% local.                  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Component Breakdown

### 5.1 KairosVoiceHelper.app (Swift sidecar)

**Why a Swift sidecar:** Audio APIs (AVAudioEngine, AVSpeechSynthesizer, SFSpeechRecognizer, CGEventTap) are Apple-native and don't have stable Bun/TS bindings. A small Swift binary handles all audio; the Bun daemon controls it via a clean JSON protocol. Audio buffers never cross the language boundary — only transcripts and commands.

**Bundle as:** Proper `.app` with `Info.plist` usage strings, signed, installed as a LaunchAgent. **Not** a LaunchDaemon (LaunchDaemons run as root and can't trigger TCC permission prompts).

**Starting point:** Fork [`farzaa/clicky`](https://github.com/farzaa/clicky) (MIT, Swift 95%, ~85% the shape we want). Strip out:
- AssemblyAI cloud STT calls → replace with `SFSpeechRecognizer`
- ElevenLabs cloud TTS calls → replace with `AVSpeechSynthesizer`
- Direct OpenAI calls → remove (Bun daemon handles LLM)

Keep:
- `HotKeyManager.swift` (CGEventTap pattern)
- `AudioEngine.swift` structure (AVAudioEngine setup)
- App bundle config / Info.plist usage strings

**Approximate size:** ~5 MB.

#### 5.1.1 Audio pipeline graph

```
AVAudioEngine
├── inputNode (mic, VoiceProcessingIO=true → FaceTime-grade echo cancellation)
│    │
│    └─ installTap(onBus: 0, bufferSize: 1024, format: 16kHz mono Float32)
│         │
│         ├─→ RingBuffer<Float32> (last 30s for context, ~1.8 MB)
│         │     └─→ SFSpeechRecognizer (or SpeechAnalyzer on Tahoe)
│         │           → onPartialResult: emit { event: "stt_partial", text }
│         │           → onFinalResult: emit { event: "stt_final", text }
│         │
│         └─→ SileroVAD (CoreML model, ~5MB, ANE-accelerated)
│               → on speech start (confidence > 0.7):
│                   - If KAIROS is currently speaking: emit { event: "barge_in_detected" }
│                   - If hotkey is NOT pressed: ignore (we only listen on push-to-talk)
│
├── playerNode (AVAudioPlayerNode)
│    └─ Receives PCM from AVSpeechSynthesizer.write() (in-process synth) OR
│       streams audio bytes from cloud TTS WebSocket (v1.5)
│
└── mainMixerNode → outputNode
```

**Key implementation details:**
- Use `AVAudioSession.Mode.voiceChat` to enable VoiceProcessingIO and bypass other audio session interference
- Mic sample rate: 16 kHz mono Float32 (what Silero VAD and Apple STT both expect)
- Output sample rate: matches AVSpeechSynthesizer's preferred format (usually 22050Hz)
- Audio ring buffer: 30 seconds, lock-free, single producer / multiple consumers

#### 5.1.2 Hotkey UX

**Pattern:** CGEventTap monitoring `flagsChanged` events for Option (or Control) key state.

**Two modes user can configure (via voice):**
- **Hold-to-talk:** press and hold Option → listen, release → stop. Most common.
- **Double-tap-to-toggle:** double-tap Control → start listening, double-tap again → stop. Hands-free for longer thoughts.

**Why CGEventTap not NSEvent.addGlobalMonitor:** CGEventTap can consume events (prevent propagation), works on flagsChanged, and is what every macOS voice assistant uses (Cleanshot, Raycast, OkClaw, VocaMac).

**Permission:** Input Monitoring TCC (`NSAppleScriptUsageDescription`-adjacent). Lighter than Accessibility. User grants once.

**Known issue:** Code-signed event taps can be silently disabled by macOS if the binary is unsigned or mis-signed. We sign properly + monitor `kCGEventTapDisabledByTimeout` / `kCGEventTapDisabledByUserInput` and re-enable.

#### 5.1.3 Sidecar protocol (stdio JSON lines over UDS)

Bidirectional, line-delimited JSON. Each line is a discrete message.

**Daemon → Sidecar (commands):**
```jsonl
{"cmd":"speak","text":"You've got a 1:30 with Sarah.","voice":"com.apple.voice.enhanced.en-US.Ava","rate":0.5,"interruptible":true}
{"cmd":"stop_speaking"}
{"cmd":"start_listening","mode":"push_to_talk"}
{"cmd":"set_hotkey","modifier":"option","action":"hold"}
{"cmd":"set_voice","voice":"com.apple.voice.enhanced.en-US.Ava"}
{"cmd":"get_voices"}
{"cmd":"health_check"}
{"cmd":"shutdown"}
```

**Sidecar → Daemon (events):**
```jsonl
{"event":"sidecar_ready","version":"0.6.0"}
{"event":"hotkey","state":"down","modifier":"option"}
{"event":"hotkey","state":"up","modifier":"option"}
{"event":"stt_partial","text":"what's on my","confidence":0.8}
{"event":"stt_final","text":"what's on my calendar this afternoon","confidence":0.95}
{"event":"user_speaking_started","amplitude":0.4}
{"event":"barge_in_detected","during_speak_id":"spk_abc"}
{"event":"speak_started","speak_id":"spk_abc"}
{"event":"speak_finished","speak_id":"spk_abc","interrupted":false}
{"event":"speak_interrupted","speak_id":"spk_abc"}
{"event":"voices_available","voices":[{"id":"com.apple.voice.enhanced.en-US.Ava","name":"Ava (Enhanced)","quality":"enhanced","language":"en-US"}]}
{"event":"error","code":"mic_permission_denied"}
```

**Transport: Unix domain socket** at `~/Library/Application Support/KAIROS/voiced.sock`. Higher throughput than stdio, simpler than gRPC, allows the daemon to reconnect if the sidecar restarts.

### 5.2 Bun daemon — voice conductor

**New file: `src/daemon/voice/voiceConductor.ts`**

Responsibilities:
1. Spawn/monitor the `KairosVoiceHelper.app` sidecar (relaunch if dead)
2. Subscribe to UDS for sidecar events
3. Subscribe to perception bus for trigger-driven events (Phase D incoming_event etc.)
4. Decide *when* to speak proactively (consults persona awareness — same RestraintPipeline as Phase D)
5. Drive listen mode based on hotkey
6. Route STT transcripts → /v1/voice/chat (the wrap endpoint) → speak the response
7. Persist conversation turns to perception bus → trajectory log → memory

**Pseudocode:**
```typescript
class VoiceConductor {
  async start() {
    await this.spawnSidecar()
    this.connectUDS()
    this.bus.subscribe('voice.event', this.handlePerceptionEvent.bind(this))
  }

  async onSidecarEvent(event: SidecarEvent) {
    switch (event.event) {
      case 'hotkey':
        if (event.state === 'down') await this.startListening()
        else await this.stopListening()
        break
      case 'stt_final':
        await this.handleUserSpeech(event.text)
        break
      case 'barge_in_detected':
        await this.handleBargeIn()
        break
      case 'speak_finished':
        this.markConversationTurnComplete(event.speak_id, !event.interrupted)
        break
    }
  }

  async handleUserSpeech(transcript: string) {
    this.bus.publish('voice.user.utterance', { text: transcript, ts: Date.now() })
    const response = await fetch('http://127.0.0.1:9876/v1/voice/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        transcript,
        conversationId: this.currentConversationId,
        userPersona: await this.persona.snapshot(),
      }),
    })
    const { text, speak_id } = await response.json()
    this.sidecar.send({ cmd: 'speak', text, voice: this.config.voice, interruptible: true })
    this.bus.publish('voice.agent.utterance', { text, speak_id, ts: Date.now() })
  }

  async handleBargeIn() {
    this.sidecar.send({ cmd: 'stop_speaking' })
    // wrap-server cancels in-flight LLM request via AbortController
    await fetch('http://127.0.0.1:9876/v1/voice/cancel', { method: 'POST' })
    this.bus.publish('voice.agent.utterance.interrupted', { ts: Date.now() })
  }

  async proactiveSpeak(text: string, urgency: 'ambient' | 'attention') {
    // Consult RestraintPipeline (Phase C.1.5) — is now a good time?
    const persona = await this.persona.snapshot()
    if (!this.restraint.allow(text, persona, { kind: 'voice', urgency })) return
    this.sidecar.send({ cmd: 'speak', text, voice: this.config.voice, interruptible: true })
  }
}
```

### 5.3 In-process wrap-API server

**New module: `src/daemon/wrapApi/server.ts`** — uses Bun's built-in HTTP server.

```typescript
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 9876,
  routes: {
    '/v1/llm/complete': async (req) => llmComplete(req),
    '/v1/voice/chat': async (req) => voiceChat(req),
    '/v1/voice/cancel': async (req) => voiceCancel(req),
    '/v1/memory/get': async (req) => memoryGet(req),
    '/v1/memory/append': async (req) => memoryAppend(req),
    '/v1/orders/add': async (req) => ordersAdd(req),
    '/v1/orders/list': async (req) => ordersList(req),
    '/v1/orders/disable': async (req) => ordersDisable(req),
    '/v1/composio/list_connections': async (req) => composioListConnections(req),
    '/v1/composio/connect': async (req) => composioConnect(req),
    '/v1/composio/disconnect': async (req) => composioDisconnect(req),
    '/v1/settings/get': async (req) => settingsGet(req),
    '/v1/settings/update': async (req) => settingsUpdate(req),
    '/v1/personal/persona': async (req) => personaCrud(req),
    '/v1/health': async () => new Response('ok'),
  },
})
```

**Why in-process:**
- Lowest latency (~10ms vs ~50ms separate process)
- Single binary to manage
- Cloud migration is **one config flip** — daemon's HTTP client switches base URL from `http://127.0.0.1:9876` to `https://api.kairos.ai`. Zero code refactor outside that line.
- Production-grade: Bun.serve is the same server you'd use behind a load balancer at scale

**Endpoint contracts (selected):**

`POST /v1/llm/complete`
```json
{
  "messages": [{"role": "user", "content": "..."}],
  "model": "claude-haiku-4-5",
  "stream": true,
  "max_tokens": 1024,
  "system": "..."
}
→ SSE stream of token deltas
```

`POST /v1/voice/chat` (the conversational endpoint)
```json
{
  "transcript": "what's on my calendar this afternoon",
  "conversationId": "conv_abc",
  "userPersona": { /* snapshot */ }
}
→ { "text": "You've got a 1:30 with Sarah, then nothing until 4.", "speak_id": "spk_xyz" }
```

`POST /v1/orders/add`
```json
{
  "rule": { /* STANDING_ORDERS.md rule */ },
  "via": "voice"
}
→ { "slug": "linear-issue-watcher" }
```

`PATCH /v1/settings/update`
```json
{
  "voice.rate": 0.45,
  "voice.preferred_voice": "com.apple.voice.enhanced.en-US.Daniel",
  "notification.frequency": "low"
}
→ { "updated": ["voice.rate", "voice.preferred_voice", "notification.frequency"] }
```

`POST /v1/composio/disconnect`
```json
{ "toolkit": "slack" }
→ { "disconnected": true, "rules_affected": ["slack-dm-monitor"] }
```

### 5.4 Embedded API key strategy (pre-Cloud)

**Goal:** KAIROS works out-of-the-box. User downloads .app → opens → talks. No API key entry.

**Strategy for the dev/private/early-access phase:**

1. **Build-time injection:** `ANTHROPIC_API_KEY` is read from a gitignored `.env.build` at Bun bundle time. The key gets baked into the `LLMAdapter` module as a runtime constant.

2. **Obfuscation:** XOR the key bytes with a deterministic seed derived from the binary's checksum at startup. Casual `strings` won't find `sk-ant-`. Determined reverse-engineer with disassembler can. **Accept this for early-access** — the audience is small and trusted.

3. **Rotation playbook:** If a key leaks, rotate the Anthropic key + ship a new build. The wrap-API's `/v1/llm/complete` calls the latest provider key without any user-visible change.

4. **No string says "Anthropic" in the code** outside the LLMAdapter. Voice conductor, wrap-server, daemon — all call `/v1/llm/complete`. They don't know what model they hit.

**Migration to Cloud (v1.x):**
- LLMAdapter swaps from in-process Anthropic client to `fetch('https://api.kairos.ai/v1/llm/complete')`
- Same internal contract, different base URL
- API key now lives on KAIROS Cloud, never embedded
- Daemon authenticates via signed-in user token

---

## 6. Voice Interaction Patterns

### 6.1 Onboarding (first-launch)

**Goal:** Get user through TCC permissions + persona build + first OAuth, all by voice, in under 5 min, feeling like a chat.

```
[User double-clicks KAIROS.app for the first time]

1. App launches → checks for TCC permissions
   → Missing: mic, accessibility, speech recognition
   → Show system TCC prompts in sequence (Apple's UI, not KAIROS's)

2. Once permissions granted, sidecar starts. Speaks via Apple Ava:

   KAIROS: "Hey! I'm KAIROS. Before we start I want to get to know you
            so I can be actually useful. Sound good?"

3. User: [holds Option] "sure" [releases]

4. KAIROS: "Cool. What should I call you?"

5. User: "Nirmal."

6. KAIROS: "Hi Nirmal. What do you spend most of your day on?"

   [...4-6 more questions, conversational pacing, ~3 min total...]
   - "What tools do you live in?"
   - "Are you the heads-down-don't-bother-me type, or do you want me
      pinging you about things as they happen?"
   - "When I tell you stuff, should I be direct and brief, or more
      conversational?"

7. KAIROS reads back the persona:

   KAIROS: "Okay so I've got — you're Nirmal, building a voice AI product,
            you live in Linear and Gmail, you want brief direct responses,
            and you want me to ping you on things that matter but not
            interrupt deep work. Right?"

8. User: "yeah."

9. KAIROS: "Want me to set up Gmail and Linear so I can actually do stuff?"

10. User: "yes."

11. KAIROS: "Opening Gmail now."
    [Browser opens to Composio OAuth → user authorizes]
    KAIROS: "Got Gmail. Linear next."
    [Browser opens to Linear OAuth → user authorizes]
    KAIROS: "Got Linear too."

12. KAIROS: "All set. I'm watching. I'll talk to you when something matters."
    [15-minute timer starts → first proactive check-in]
```

**Implementation:**
- Onboarding flow stored as a state machine in `src/daemon/onboarding/voiceOnboarding.ts`
- Each KAIROS line is LLM-generated using the soul-wizard prompt + current state
- User answers parsed by LLM (`/v1/llm/complete`) and stored into soul.md incrementally
- Existing `SoulWizard` (C.3.1) provides the underlying persona structure

### 6.2 The 15-minute check-in (first proactive moment)

Scheduled by onboarding completion. Fires once, then never again.

```
[15 minutes after onboarding completes]

KAIROS: "Hey Nirmal, just checking in. How's your morning going?"

[Branches based on response:]

User (terse): "fine."
  KAIROS: "Cool. I'll stay out of your way then. Holler if you need me."

User (chatty): "actually been productive. Closed a bug, in flow."
  KAIROS: "Nice. I'll let you cook. Pinging if Linear or Gmail spikes."

User (frustrated): "ugh, stuck on something."
  KAIROS: "What's the stuck thing? Maybe I can dig something up."
  [→ continues conversation, possibly invokes skills]
```

**Why 15 min:** Long enough that user has settled into work. Short enough to reinforce KAIROS is alive. The first check-in establishes the relationship — its tone signals how all future proactive moments will feel.

**Trade-off acknowledged:** Could feel needy. **Mitigated by:**
- Single occurrence (not recurring)
- LLM tone matches user's earlier voice (terse-in → terse-out)
- User can say "don't do that again" → KAIROS suppresses for the rest of v1's session and asks at v1.5 review

### 6.3 Conversational configuration (no dashboard)

Anything a dashboard would expose, KAIROS exposes by voice:

| User says | KAIROS does |
|---|---|
| "speak slower" | `PATCH /v1/settings/update {voice.rate: 0.4}` → "Okay, slowing down. Better?" |
| "be quieter today" | suppress non-urgent voice for 24h |
| "add a rule for new Linear issues" | invoke OrdersAuthor (existing) via `/v1/orders/add` → "Done. I'll ping you on Linear issues from now on." |
| "stop watching Slack" | `/v1/composio/disconnect {toolkit: 'slack'}` → "Slack disconnected. Anything else?" |
| "what can you change about yourself" | KAIROS speaks the capability menu in natural language |
| "what are you doing right now" | KAIROS reports active rules + recent triggers |
| "forget what I said earlier" | `/v1/memory/redact` with last N turns |
| "remember that I prefer Vim over VS Code" | `/v1/memory/append` to persona facts |

**Discovery for new users** ("what can I do?"):
KAIROS describes capabilities in plain English, not menu lists. "I can change how I sound, how often I interrupt you, which apps I'm watching, and what kind of stuff I should ping you about. Try saying 'speak slower' or 'add a reminder for daily standups at 9.'"

### 6.4 Memory integration

Voice transcripts are first-class observations on the perception bus, same as `clipboard`, `focus_app`, `file_events`, `incoming_event` (Phase D).

```
[user speaks]                   [agent speaks]
      ↓                                ↓
voice.user.utterance        voice.agent.utterance
      ↓                                ↓
perception bus  ────────────────────►  perception bus
      ↓                                ↓
[TrajWriter — C.3.1 Task 4]   [TrajWriter]
      ↓                                ↓
trajectory log (daily .md file)
      ↓
[Hermes Dreaming — C.3.1 Task 6, nightly]
      ↓
[persona deltas, semantic memory promotion]
      ↓
soul.md, DREAMS.md updated
```

**This means:**
- "What did I tell you about my deadlines last week?" → KAIROS searches trajectory + episodic memory
- KAIROS learns vocabulary (your project names, teammate names, jargon) over time
- Patterns ("you always say 'whatever' when you actually mean 'do it'") get promoted to persona
- The longer you use KAIROS by voice, the more it sounds like *you* speaking to it

**Privacy: voice transcripts NEVER leave the Mac.** Audio is processed locally by Apple STT. Transcripts go into local files. The wrap-API hits Anthropic with just the transcript + persona context — not the audio. (When Cloud ships, this becomes a tunable: cloud sync of memory is opt-in.)

---

## 7. Failure Modes

| Failure | Detection | Recovery |
|---|---|---|
| Sidecar crashes | UDS connection drops | Daemon respawns sidecar; if 3 crashes in 60s, surface error via system notification |
| Mic permission revoked | SFSpeechRecognizer throws | Voice goes mute; daemon falls back to system notifications until re-granted |
| Accessibility permission revoked | CGEventTap silently disabled | Detect via `kCGEventTapDisabledBy*`, re-enable; if denied, fall back to menu-bar click |
| Apple voice not downloaded | AVSpeechSynthesizer falls back to default voice | Onboarding flow detects + prompts user to download Ava Enhanced from System Settings |
| LLM API call fails | Wrap server returns 5xx | Voice conductor speaks an apology: "Sorry, my brain's offline for a sec." + retries with backoff |
| Apple STT loses partial transcript | Confidence drops | Wait for final transcript; if empty after 3s, ask user "Sorry, what was that?" |
| Echo cancellation breaks (VoiceProcessingIO bug) | Silero VAD fires repeatedly during TTS | Detect feedback loop, switch to half-duplex mode (no barge-in for current session), log for follow-up |
| User talks for >60s straight | SFSpeechRecognizer hits 1-min cap | Auto-restart recognizer, append continuation; barely noticeable to user |
| Hotkey conflict with another app | Hotkey fires for wrong action | Detect via diagnostics; offer alternative modifier ("Try Option instead of Control?") |

---

## 8. Component Files (new)

```
src/daemon/voice/
├── voiceConductor.ts          # Main orchestrator
├── sidecarClient.ts           # UDS connection + protocol
├── sidecarLifecycle.ts        # Spawn/respawn the .app
├── conversationStore.ts       # SQLite: conversations, turns, speak_ids
├── voiceConfig.ts             # Voice settings, hotkey, voice selection
├── proactiveScheduler.ts      # Decides when KAIROS speaks unsolicited
└── voiceConductor.test.ts

src/daemon/wrapApi/
├── server.ts                  # Bun.serve config + routes
├── adapters/
│   ├── llmAdapter.ts          # Calls Anthropic (today) / Cloud (tomorrow)
│   ├── memoryAdapter.ts       # Wraps existing soul/persona/trajectory APIs
│   ├── ordersAdapter.ts       # Wraps existing OrdersAuthor / OrdersStore
│   ├── composioAdapter.ts     # Wraps existing Composio integration
│   └── settingsAdapter.ts     # Reads/writes ~/.kairos/config.json
├── auth.ts                    # No-op now; Bearer token check later
└── server.test.ts

src/daemon/onboarding/
├── voiceOnboarding.ts         # First-launch state machine
├── personaBuilder.ts          # Builds soul.md from voice answers
└── voiceOnboarding.test.ts

apps/macos/
├── KairosVoiceHelper/         # Swift project
│   ├── KairosVoiceHelper.xcodeproj
│   ├── KairosVoiceHelper/
│   │   ├── App.swift          # NSApplicationDelegate
│   │   ├── HotKeyManager.swift     # CGEventTap (fork from clicky)
│   │   ├── AudioEngine.swift       # AVAudioEngine setup (fork from clicky)
│   │   ├── SpeechRecognizer.swift  # SFSpeechRecognizer / SpeechAnalyzer abstraction
│   │   ├── SpeechSynthesizer.swift # AVSpeechSynthesizer
│   │   ├── SileroVAD.swift         # CoreML VAD wrapper
│   │   ├── BargeInDetector.swift   # VAD-during-TTS logic
│   │   ├── SidecarProtocol.swift   # JSON-line over UDS
│   │   ├── Info.plist             # Usage strings (mic, accessibility, etc.)
│   │   └── KairosVoiceHelper.entitlements
│   └── Resources/
│       └── silero_vad.mlmodelc     # bundled
└── installer/
    └── postinstall.sh         # Installs LaunchAgent plist
```

**~3000 LOC Swift + ~2000 LOC TS new. ~5000 lines total new code.**

---

## 9. Implementation Phases

### E.1.1 — Swift sidecar foundation (week 1-1.5)
- Fork clicky, strip cloud bits, prove `SFSpeechRecognizer` + `AVSpeechSynthesizer` + `CGEventTap` work end-to-end
- Build sidecar protocol (UDS + JSON lines)
- Standalone test app: hotkey → STT → echo back via TTS
- **Gate:** voice round-trip with no LLM, <500ms latency

### E.1.2 — Bun ↔ sidecar bridge (week 1.5-2)
- `voiceConductor.ts` skeleton
- Spawn/monitor the sidecar
- Wire perception bus events through to sidecar
- Tests for protocol parsing
- **Gate:** Bun daemon receives `stt_final` events and sends `speak` commands

### E.1.3 — Wrap-API server + LLM adapter (week 2)
- `Bun.serve` with `/v1/llm/complete` and `/v1/voice/chat`
- Anthropic adapter with embedded key
- Voice chat endpoint: transcript → LLM → response
- **Gate:** real conversation possible: hotkey → speak → KAIROS responds with LLM-generated answer

### E.1.4 — Barge-in (week 2-2.5)
- Bundle Silero VAD CoreML
- VAD-during-TTS logic in sidecar
- Wire stop_speaking flow from sidecar → daemon → wrap-server LLM cancel
- **Gate:** user can interrupt KAIROS mid-sentence, stops in <200ms

### E.1.5 — Onboarding (week 2.5-3)
- TCC permission flow
- Voice-driven persona builder
- soul.md write integration
- Composio OAuth trigger via voice
- **Gate:** clean install → 5 min onboarding → KAIROS knows user + has Gmail/Linear connected

### E.1.6 — Memory + conversational config (week 3)
- Voice utterances → perception bus → trajectory log
- "Settings change via voice" endpoints (`/v1/settings/*`)
- Conversational config UX
- **Gate:** "speak slower" works end-to-end + persists

### E.1.7 — Proactive 15-min check-in (week 3)
- Post-onboarding scheduler
- Persona-conditioned proactive speech
- RestraintPipeline integration
- **Gate:** 15 min after onboarding, KAIROS speaks check-in

### E.1.8 — Polish + validation gate (week 3.5-4)
- Edge cases (permission revoke, mic plug/unplug, sleep/wake)
- Bun ↔ Swift signed build pipeline
- LaunchAgent installer
- 25-assertion validation gate (similar to Phase D)
- **Gate:** Phase E.1 ships as v0.6.0

---

## 10. Success Criteria (Phase E.1 ships)

1. **Voice-to-voice latency:** 95th percentile < 1000ms on M2 Air
2. **Barge-in stop:** 95th percentile < 200ms
3. **Onboarding completion rate:** users complete TCC + persona + OAuth in single session
4. **Voice transcripts in memory:** `git log` of trajectory log shows voice utterances post-onboarding
5. **Self-modification via voice:** "speak slower" / "add a rule" / "disconnect Slack" all work end-to-end without dashboard
6. **No "Anthropic" or "Claude" strings in binary's user-visible code paths** (only inside LLMAdapter)
7. **App size impact:** KAIROS .app + KairosVoiceHelper.app < 15 MB additional
8. **Cost:** < $0.005/min of actual conversation (verified via Anthropic usage dashboard)
9. **15-min check-in fires reliably** post-onboarding
10. **Phase D triggers can call proactive voice** — Linear issue arrives, KAIROS speaks within 500ms of perception bus event

---

## 11. Cloud Migration Plan (when ready, post-v1)

When KAIROS Cloud ships:

```diff
- # config.json (today)
- llm_endpoint: "http://127.0.0.1:9876/v1/llm/complete"
- voice_endpoint: "http://127.0.0.1:9876/v1/voice"
+ # config.json (Cloud)
+ llm_endpoint: "https://api.kairos.ai/v1/llm/complete"
+ voice_endpoint: "https://api.kairos.ai/v1/voice"
+ auth_token: "<user-cloud-token>"
```

**That's it.** Same endpoints, same contracts. The wrap-API server stays in-process as a "local fallback" if Cloud is unreachable (graceful degradation: voice still works for STT/TTS even without internet, LLM falls back to a local lite model).

**Cloud surfaces add:**
- Multi-device sync of soul.md / standing orders (opt-in)
- Per-user telemetry dashboard for the team
- Subscription billing
- A/B testing of LLM model choices server-side
- New endpoints like `/v1/users/upgrade-tier`

**Daemon code:** zero changes outside the LLMAdapter file. Same `voiceConductor.ts`. Same wrap server (now optional, acts as a local fallback layer).

---

## 12. Open Questions to Revisit at Implementation Time

1. **Apple voice download UX.** "Ava (Enhanced)" requires a 100MB+ download from System Settings → Accessibility → Spoken Content. Onboarding needs to detect "user has only basic voice installed" and guide them to upgrade. Subprocess to `say -v "?"` lists installed voices.

2. **Concurrency: multiple Macs running KAIROS for the same user.** Pre-Cloud: not a concern. Post-Cloud: which Mac owns "active speaker"? Probably whichever was most-recently-focused, but needs design.

3. **Phone call detection.** If user is on a Zoom/Phone call, KAIROS should NOT speak. Detect via `NSWorkspace.shared.runningApplications` for Zoom/Teams/FaceTime in active state.

4. **Diarization: distinguishing user voice from other voices on the mic.** v1: assume single speaker (user). v1.5: speaker embeddings to filter out "person walking past my desk talking on phone" false triggers.

5. **Long-form transcription accuracy.** SFSpeechRecognizer has a 1-min limit. For longer thoughts ("let me explain what I'm working on"), need stitching across recognizer instances. Same approach as Whisper would use.

6. **Voice "personality" expression.** Once we add Cartesia/ElevenLabs in v1.5, do we let users pick from a small set (Calm, Energetic, Direct, Warm) or expose the full provider catalog? Probably curated for the first release.

7. **Cancellation of in-flight TTS audio buffers.** When barge-in fires, audio may already be queued in the playerNode. `stopSpeaking(at: .immediate)` + setting `playerNode.volume = 0` + scheduling silence chunks covers most cases. Verify edge case: TTS just finished synthesizing 30s of audio that's now in the buffer.

8. **Resilience to upstream network blips.** Anthropic 500s during a voice turn — what does KAIROS say? Probably: "Hold on, I lost my train of thought. What were we just talking about?" — uses memory to recover.

---

## 13. Appendix A — Why these specific picks

| Decision | Why this, not that |
|---|---|
| Swift sidecar (not pure Bun) | Apple audio APIs require Swift/ObjC. Bun FFI for these is fragile. Audio thread can't be JS. |
| Unix domain socket (not stdio) | Bidirectional, higher throughput, allows sidecar to outlive a Bun restart. Stdio works but is more fragile under load. |
| SFSpeechRecognizer (not WhisperKit) | Same Apple Neural Engine target. Apple's model is co-evolved with system. Zero MB. WhisperKit is excellent but adds 75-150MB for marginal quality gain. |
| AVSpeechSynthesizer (not Cartesia day-1) | Zero MB, zero $, sub-100ms TTFA, "Ava Enhanced" is genuinely good for short utterances. Cartesia/ElevenLabs comes when budget permits. |
| Silero VAD via CoreML (not WebRTC VAD) | Better accuracy in noisy environments. Already ANE-accelerated via existing CoreML port. Same VAD that Pipecat / OpenAI Realtime use server-side. |
| VoiceProcessingIO (not custom AEC) | Apple's DSP is FaceTime-grade. Building our own is months of work for worse results. |
| CGEventTap (not NSEvent.addGlobalMonitor) | NSEvent doesn't capture key-down for modifier keys reliably. CGEventTap is the standard. |
| Input Monitoring TCC (not Accessibility) | Lighter permission, sufficient for hotkey capture. Accessibility opens too much. |
| In-process Bun wrap server (not separate proxy) | Lower latency, simpler ops, same migration story to Cloud. |
| Fork clicky (not vocamac / pluely) | clicky is MIT. vocamac/pluely are (A)GPL — viral license incompatible with proprietary KAIROS. |
| Apple voices for v1 (not premium TTS) | Free + on-device + acceptable quality + reduces v1 complexity. Premium TTS is opt-in v1.5. |
| Embedded key (not BYOK) | UX: download → talk. No "go get an Anthropic key first" friction. Accepts the leak risk during early access. |
| Voice-only configuration (no dashboard) | Product thesis: "KAIROS is its own UI." Dashboard breaks that. HUD (Phase F) is the only visual surface. |
| English-only v1 | Apple English STT/TTS are mature. Multi-language adds 4-6 weeks of QA + UX work. Defer to v1.5. |

---

## 14. Appendix B — Sources & references

**OSS repos studied:**
- [farzaa/clicky](https://github.com/farzaa/clicky) — MIT, Swift, will fork
- [jatinkrmalik/vocamac](https://github.com/jatinkrmalik/vocamac) — AGPL, pattern only
- [kwindla/macos-local-voice-agents](https://github.com/kwindla/macos-local-voice-agents) — Python, reference for <800ms target
- [moonshine-ai/moonshine](https://github.com/moonshine-ai/moonshine) — MIT, alternative if Apple STT has issues
- [argmaxinc/WhisperKit](https://github.com/argmaxinc/WhisperKit) — MIT, fallback path if needed
- [livekit/agents-js](https://github.com/livekit/agents-js) — Apache 2.0, ruled out (requires media server sidecar)
- [pipecat-ai/pipecat](https://github.com/pipecat-ai/pipecat) — has known interruption bugs in 2026, ruled out
- [openclaw/openclaw](https://github.com/openclaw/openclaw) — agent allowlist pattern referenced in Phase E.2

**Apple docs:**
- [SFSpeechRecognizer](https://developer.apple.com/documentation/speech/sfspeechrecognizer)
- [SpeechAnalyzer (Tahoe+)](https://developer.apple.com/documentation/speech/speechanalyzer)
- [WWDC25: SpeechAnalyzer](https://developer.apple.com/videos/play/wwdc2025/277/)
- [AVSpeechSynthesizer](https://developer.apple.com/documentation/avfaudio/avspeechsynthesizer)
- [AVAudioEngine VoiceProcessingIO](https://developer.apple.com/forums/thread/66953)
- [Bun FFI](https://bun.com/docs/runtime/ffi)

**Provider research:**
- [Anthropic Haiku 4.5 pricing](https://www.anthropic.com/pricing)
- [Apple's SpeechAnalyzer vs SFSpeechRecognizer](https://blakecrosley.com/blog/speech-framework-vs-sfspeechrecognizer)
- [CGEventTap silent-disable race](https://danielraffel.me/til/2026/02/19/cgevent-taps-and-code-signing-the-silent-disable-race/)

**Research artifacts (gitignored, in `/tmp`):**
- `/tmp/voice-providers-research.md` — full provider comparison + cost tables
- `/tmp/voice-oss-research.md` — full OSS landscape audit
- `/tmp/voice-stack-research.md` — comprehensive architecture recommendation
- `/tmp/apple-native-voice-research.md` — Apple native API deep-dive
