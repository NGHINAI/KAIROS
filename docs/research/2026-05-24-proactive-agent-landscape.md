# Proactive Agent Landscape — Research for KAIROS
Date: 2026-05-24

---

## Executive Summary

**State of the art:** Genuine proactivity in AI agents is rare. The overwhelming majority of projects that claim to be "proactive" are either cron-loop pollers dressed up with LLM calls, or reactive chat systems with an event listener bolted on. Only a handful of projects have solved the two hard sub-problems simultaneously: (1) a credible signal model for *when* to fire, and (2) a suppression mechanism to avoid notification spam. The clearest architecture breakthrough of 2025–2026 is the `HEARTBEAT_OK` suppression pattern pioneered by OpenClaw and extended by Hermes Agent: the model runs on a heartbeat, but the *output is dropped unless there's something worth surfacing*. This inverts the polling anti-pattern — the agent evaluates continuously but the user experiences only signal, not noise. On the memory side, the field has converged on three-tier episodic/semantic/procedural stacks, with the best systems (MemOS, CraniMem, Engram) adding scheduled consolidation loops that compact raw episodes into a knowledge graph — the "dream" consolidation analogue.

**Biggest gaps:** No open-source project combines all four pillars KAIROS needs: (1) rich OS-level event stream from multiple live sensors, (2) a credible proactivity trigger engine (not cron), (3) hold-to-speak voice I/O with barge-in, and (4) a Liquid Glass floating HUD. Every project reviewed has one or two of these. Screenpipe has the best sensor pipeline but no voice-out or trigger intelligence. OpenClaw/Hermes have the best trigger discipline but run headless over messaging channels. Pipecat/LiveKit have the best voice pipeline but are server-side and call-scoped, not daemon-style. KAIROS is in a unique position to unify all four.

**Specific recommendations for KAIROS:** Adopt the HEARTBEAT_OK suppression pattern immediately for the Narrator; replace the cron-style narrator loop with a priority-scored event bus consumer that gates on a significance threshold before calling the LLM at all; borrow Pipecat's VAD + barge-in pipeline for voice I/O rather than building from scratch; use MemOS or Engram's consolidation scheduler for the memory system rather than raw SQLite appending; and target macOS's NSPanel + `.nonactivatingPanel` + `CGEventTap` combo (not Electron, not Tauri) for the HUD since SwiftUI gives native Liquid Glass access starting macOS 26 Tahoe.

---

## Architectural Inspiration (ranked by usefulness to KAIROS)

### 1. OpenClaw + Hermes Agent (successor)
**URLs:** https://github.com/openclaw/openclaw (374k stars) / https://github.com/NousResearch/hermes-agent (166k stars)
**One-line:** OpenClaw is a local-first AI agent gateway; Hermes Agent is its Nous Research successor with a self-improving skill loop.
**Is it actually proactive?** Partial — yes, but through scheduled heartbeats, not reactive event streams. Heartbeat fires every 30 minutes by default; the model reads `HEARTBEAT.md`, evaluates a checklist, and replies with either substantive output or `HEARTBEAT_OK`. If the reply starts/ends with `HEARTBEAT_OK` and the remaining text is under 300 characters, the gateway *drops the message entirely* — the user sees nothing. Outside active hours, ticks are skipped. The agent can also set `skipWhenBusy` to defer when another job is running.

**What to steal:**
- The `HEARTBEAT_OK` suppression pattern is the single best anti-spam primitive in the open-source landscape. KAIROS should adopt it verbatim: let the Narrator run on every significant event batch, but return `KAIROS_SILENT` when nothing merits interruption. Only promote to notification when the score exceeds threshold.
- The `HEARTBEAT.md` task checklist pattern: a plain markdown file that the agent consults on each tick, with per-task interval declarations (`name`, `interval`, `prompt`). KAIROS can use an analog for persistent "standing orders" the daemon checks against new world-state snapshots.
- Hermes's "Dreaming" system: a 3-phase background consolidation loop that scores memories (relevance, frequency, recency, diversity, richness, dedup) and promotes high-scoring entries to persistent long-term memory. Runs during quiet hours via cron — a good model for KAIROS's nightly consolidation pass.
- Skill learning: Hermes auto-distills reusable skills after complex tasks. KAIROS Phase G (Hermes-style self-evolution) should study this closely.

**What to avoid:**
- The 30-minute heartbeat cadence is far too coarse for KAIROS's live event stream. This works for a messaging channel bot because messages arrive infrequently; KAIROS has continuous sensor data. Don't port the cadence, port the suppression logic.
- OpenClaw's "heartbeat as the main proactivity primitive" means it's fundamentally still polling, not event-driven. It cannot react to a calendar event appearing or a browser tab change in real time. KAIROS needs a proper event bus consumer as the trigger layer, with the heartbeat only as a fallback sweep.

---

### 2. Screenpipe
**URL:** https://github.com/screenpipe/screenpipe (18.9k stars)
**One-line:** 24/7 local screen + mic capture daemon with a pipe-based AI agent plugin system, built in Rust + Tauri.
**Is it actually proactive?** Partial — the pipe system runs AI agents on *schedules*, making it periodic rather than truly event-driven. However, the capture layer itself is event-driven: it listens for OS events (app switch, click, typing pause, scroll, clipboard change), and when activity occurs, captures a screenshot paired with the accessibility tree. This is the right sensor architecture.

**What to steal:**
- The **event-driven capture model**: fire on OS events rather than on a fixed timer. Capture = (screenshot + accessibility tree + timestamp) on each meaningful event transition. This is exactly the right primitive for KAIROS's world-state snapshot.
- **SQLite + FTS5 for local storage**: screenpipe's ~300 MB / 8hr budget for screenshots is a useful benchmark. KAIROS's SQLite event bus is already aligned here.
- **Pipe architecture as plugin model**: each pipe is a markdown file with a prompt, a schedule, and data permissions. KAIROS's skill/tool system should be similarly declarative — a `TRIGGER.md` file next to each skill declaring what events activate it.
- **Tauri (Rust + WebKit)** for the UI layer if not going pure SwiftUI: 28 MB RAM vs Electron's 250 MB is decisive for a daemon that runs 24/7.
- The screenpipe REST API on `localhost:3030` is a clean model for KAIROS's local IPC between the daemon and the HUD overlay.

**What to avoid:**
- Pipes still run on schedules (cron-style), not on event triggers. The system doesn't say "a new Slack message appeared — run the summarizer now." KAIROS must not replicate this gap.
- Screen recording as primary sensor has privacy and performance costs. KAIROS's accessibility-tree-first approach (with screenshot as fallback) is the right call per Fazm's production experience.

---

### 3. thunlp/ProactiveAgent (ICLR 2025 paper + code)
**URL:** https://github.com/thunlp/ProactiveAgent (604 stars)
**One-line:** Research system that monitors user activity via VS Code/Chrome extensions and uses a fine-tuned reward model to decide when to propose tasks.
**Is it actually proactive?** Yes — this is one of the few systems with a principled decision model for *when* to fire. The core loop: Activity Watcher collects raw signals → reward model (0.918 F1 on binary "should I interrupt?" classification) gates LLM task proposals → proposals appear as toast notifications → user accept/reject/ignore feeds back into the reward model.

**What to steal:**
- The **two-stage gate**: raw sensors → interrupt classifier → (if yes) task proposer → user. KAIROS needs exactly this: a cheap "should I fire?" classifier that runs on every event batch, and only calls the expensive LLM narrator when the classifier says yes. The thunlp paper's 66% F1 on the full prediction task is weak, but the *architecture* of the gate is correct.
- Human feedback loop: ignore signals reduce future suggestions. KAIROS should track user dismissals and down-weight similar event patterns.
- **Activity Watcher as a sensor bus**: the project reuses ActivityWatch (https://github.com/ActivityWatch/activitywatch) for system-level event collection. ActivityWatch produces window focus, AFK state, and browser tab events via a REST API. KAIROS can consume this directly rather than re-implementing those watchers.
- Toast notification as the non-intrusive surfacing primitive: appears, can be ignored, doesn't steal focus.

**What to avoid:**
- Fine-tuning LLaMA-3.1-8B for the reward model is overkill for KAIROS v1. Start with a prompt-based classifier using a fast/cheap model (Haiku, Gemini Flash Lite). Fine-tune only if false-positive rate is unacceptable in production.
- The VS Code + Chrome extension approach is brittle — extensions break on updates. KAIROS's OS-level accessibility API approach is more durable.

---

### 4. ContextAgent / ProAgent (NeurIPS 2025 / arXiv Dec 2025)
**URLs:** https://github.com/openaiotlab/ContextAgent (42 stars) / https://arxiv.org/abs/2512.06721
**One-line:** Academic systems that fuse wearable sensor streams (camera, mic, location, accelerometer) with an LLM to trigger proactive assistance in 9 daily-life scenarios.
**Is it actually proactive?** Yes — these are the most architecturally rigorous proactive systems in the literature. ContextAgent (NeurIPS 2025) achieves 8.5% higher accuracy on proactive prediction vs baselines. ProAgent adds "on-demand tiered perception": it doesn't process all sensors at full resolution all the time; it uses a coarse classifier to decide which sensor modalities to activate for deeper analysis, then decides whether to act.

**What to steal:**
- **Tiered perception**: KAIROS should not run full LLM narration on every event. Tier 1 = cheap classifier on raw event metadata (app name, event type, time of day). Tier 2 = lightweight summarizer on the event payload. Tier 3 = full Narrator LLM call only when tiers 1 and 2 both flag significance. This drastically reduces cost and latency.
- **Persona context**: ContextAgent conditions proactive decisions on historical persona data (user habits, preferences). KAIROS's memory system should feed a persona summary into the trigger classifier, not just the narrator.
- **ContextAgentBench**: 1,000 samples across 9 daily scenarios and 20 tools. Useful as a benchmark template for evaluating KAIROS's trigger accuracy.

**What to avoid:**
- Both projects are wearable/mobile focused. The sensor APIs don't map directly to a macOS desktop daemon. Extract the architectural pattern (tiered perception + persona conditioning), ignore the implementation.
- 42 stars / no production use — treat as concept-only, validate independently before depending on their code.

---

### 5. Pipecat + LiveKit Agents (voice pipeline)
**URLs:** https://github.com/pipecat-ai/pipecat (12.5k stars) / https://github.com/livekit/agents (10.7k stars)
**One-line:** Pipecat is a composable Python pipeline for real-time voice AI (VAD → STT → LLM → TTS); LiveKit Agents is a WebRTC-first framework with semantic turn detection and outbound call dispatch.
**Is it actually proactive?** No — both are call-scoped, session-based frameworks. They don't observe the world continuously or initiate without user action. But they are the best-of-breed for the voice I/O layer KAIROS needs.

**What to steal:**
- **Pipecat's pipeline model**: `AudioIn → VAD → STT → LLM → TTS → AudioOut`, where each stage is a swappable component. KAIROS's Phase E voice module should adopt this pipeline verbatim. Silero VAD for silence detection, WhisperKit (local, Apple Silicon) for STT, Kokoro or ElevenLabs for TTS.
- **Barge-in / interruption handling**: Pipecat stops TTS playback and cancels LLM generation immediately when VAD detects user speech mid-response. This is the correct UX for a hold-to-speak hotkey: release = finalize; re-press = barge-in and redirect. LiveKit's semantic turn detection (transformer model) reduces spurious interruptions from background noise.
- **WebRTC over WebSockets**: for sub-800ms voice-to-voice latency on Apple Silicon, use WebRTC (UDP). WebSocket adds jitter buffer overhead. LiveKit's local WHIP server can run on-device.
- **kwindla/macos-local-voice-agents** (https://github.com/kwindla/macos-local-voice-agents): a working example of Pipecat running fully local on macOS M-series with <800ms voice-to-voice. Clone this as the Phase E starting point.

**What to avoid:**
- Don't build a custom VAD from scratch. Silero VAD (https://github.com/snakers4/silero-vad) processes audio in <1ms per chunk, has MIT license, no telemetry. Use it.
- RealtimeVoiceChat (3.7k stars) is no longer maintained — interesting architecture but dead project.
- Don't use WebSockets for voice if targeting <1 second latency. The jitter budget on macOS loopback is too tight.

---

## Voice + UI Inspiration

### Hold-to-Speak Hotkey + Floating HUD

**VocaMac** (https://github.com/jatinkrmalik/vocamac, 48 stars): SwiftUI + `MenuBarExtra` + `CGEventTap` for global hotkey. Exactly the pattern KAIROS needs. Uses `Right Option` hold = push-to-talk, release = transcribe. Floating mic indicator near cursor during recording. 48 stars but the implementation is clean and minimal — good to fork.

**OkClaw** (https://okclaw.app): companion to OpenClaw, push-to-talk overlay with Right Option hold. Floating transcription overlay appears on hold, disappears on release. KAIROS's Phase E hotkey UX should match this exactly.

**VoxClaw** (https://github.com/malpern/VoxClaw, 200 stars): gives AI agents a voice via Apple TTS / OpenAI TTS / ElevenLabs. Floating teleprompter overlay with word-by-word highlight synced to speech. The word-highlight timing approach is worth studying for KAIROS's voice-out display — shows the user what word is being spoken.

### SwiftUI Floating Panel Pattern (for the HUD)

The canonical macOS floating panel recipe: subclass `NSPanel` with `.nonactivatingPanel` style, set `becomesKeyOnlyIfNeeded = true` and `level = .floating`, host SwiftUI via `NSHostingView`, set `collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]`. This is how Spotlight-style overlays work. Reference: https://cindori.com/developer/floating-panel.

**Liquid Glass / macOS 26 Tahoe**: Apple's `liquidGlass` material is available in SwiftUI as of macOS 26. Use `.glassEffect(.regular)` modifier on the panel's background. `SwiftGlass` (https://github.com/1998code/SwiftGlass) provides a compatibility shim for pre-26 targets. KAIROS should target macOS 26+ natively and use `.glassEffect` directly.

**Tauri vs SwiftUI for the HUD**: For KAIROS specifically, SwiftUI is the correct choice. The HUD is macOS-only, needs Liquid Glass, needs `CGEventTap` for global hotkey, and needs NSPanel-level control. Tauri's WebKit renderer has no access to `liquidGlass` material and requires a Rust cursor-polling workaround for per-region hit testing. Electron is flatly excluded — 250 MB RAM baseline for a daemon that runs 24/7 is unacceptable.

### Voice-Out Patterns

- Announce-style: short spoken summaries, ≤ 2 sentences, never full paragraphs. Research on proactive speech agents (arXiv 2106.02077) shows users interrupt sooner when they perceive urgency and expect brevity. KAIROS should modulate TTS speed (1.1–1.3x) based on interruption signal from VAD.
- Never speak without a visual cue. VoxClaw's word-highlight overlay is the right model: user knows what the agent is about to say before audio starts, can barge-in early.

---

## Memory Architecture for Always-On Agents

### Best Systems (ranked for KAIROS relevance)

**Engram** (https://github.com/tstockham96/engram, 39 stars): SQLite + Gemini embeddings + typed knowledge graph + LLM consolidation. Achieves 80% on LOCOMO benchmark vs Mem0's 66.9%, using fewer tokens. The MCP server interface makes it drop-in for KAIROS. Strong candidate for KAIROS's memory backend. MIT licensed.

**MemOS** (https://github.com/MemTensor/MemOS, 9.4k stars): Four-layer architecture (L1 traces → L2 policy → L3 world model → crystallized skills) with async MemScheduler, FTS5 + vector hybrid retrieval. 43.7% improvement over OpenAI Memory on standard benchmarks. Best for multi-agent scenarios; may be over-engineered for KAIROS v1.

**CraniMem** (arxiv 2603.15642, code on GitHub): Neurobiologically inspired — goal-conditioned gating, bounded episodic buffer, structured knowledge graph, scheduled consolidation loop. More robust than Mem0 under noisy input. Directly applicable to KAIROS's "dream consolidation" Phase requirement. No production deployment yet.

**Hermes Local Memory** (https://github.com/smarzola/hermes-local-memory): SQLite-backed, profiles + aliases + raw history + facts + search + context injection + migration. Simpler than MemOS/Engram but battle-tested against the Hermes Agent ecosystem.

**Recommended approach for KAIROS:** Use Engram's SQLite + knowledge graph + consolidation as the base. Layer Hermes's "Dreaming" 3-phase scoring (relevance × frequency × recency × diversity × richness × dedup) on top. Run consolidation during system idle periods, not on a fixed cron. Don't build a custom vector store — use Qdrant (embedded mode) for semantic search.

---

## Anti-Patterns to Avoid

### 1. Cron-as-proactivity (the most common failure)
Many projects — including OpenClaw, screenpipe pipes, and most "ambient agent" enterprise tools — use cron/heartbeat as their proactivity primitive and call it event-driven. It isn't. A 30-minute heartbeat misses fast-moving context (browser tab change, urgent calendar alert, copy-paste of a URL). KAIROS's trigger engine must consume the event bus in near-real-time and score events on arrival. Cron is acceptable only as a fallback sweep for events the bus might have missed.

### 2. Screen-recording-first pipelines (privacy, performance, brittleness)
Wispr Flow captures screenshots every few seconds and sends them to cloud servers. OpenAI Chronicle does the same locally. Screenpipe's continuous JPEG capture at ~300 MB/8hr is manageable but the *accessibility tree* is cheaper, richer, and more durable than pixel buffers. Fazm (macOS AI agent, Swift) learned this in production: screenshot + OCR methods fail at different screen resolutions and when UI is redesigned; accessibility APIs give stable, structured, hierarchical data that survives visual redesigns. KAIROS is right to lead with the AX tree and use screenshots only when AX data is absent.

### 3. Always-speaking agents (notification fatigue)
Friend/friend.com (the AI necklace) and early Omi builds emit proactive messages constantly. OpenClaw's own documentation warns: "3–5 proactive messages per day is comfortable for most people. More than that and the value dilutes into noise." Omi (12.6k stars) transcribes everything but leaves the spam problem unsolved in its default configuration. KAIROS must bake rate limiting and significance gating into the trigger engine architecture from day one — it cannot be bolted on later.

### 4. Chat-wrapped polling (looks proactive, isn't)
leomariga/ProactiveAgent (35 stars): uses a `SleepCalculator` that determines "optimal wait intervals before the next decision cycle." This is polling with variable cadence — the model wakes up, checks if it should speak, usually says no, goes back to sleep. The decision is still pull-based (agent checks) rather than push-based (event arrives, agent evaluates). The `multi-factor decision engine` is interesting but the fundamental architecture is reactive to a timer, not to the world.

### 5. WebSocket voice pipelines for low-latency speech
RealtimeVoiceChat (3.7k stars, abandoned) and several JARVIS-style projects use WebSocket streaming for audio. WebSocket adds jitter overhead that pushes voice-to-voice latency above 1 second on typical hardware. Pipecat's experience confirms: WebRTC (UDP) is required for interruption handling to feel natural. KAIROS Phase E must use WebRTC locally.

### 6. Electron for always-on HUD overlays
Multiple "AI desktop assistant" projects use Electron because it's cross-platform and familiar to web developers. For a daemon running 24/7, 250 MB idle RAM baseline is prohibitive. Tauri is 30–50 MB. Pure SwiftUI (native macOS) is ~10 MB for a menubar + panel app. The 2026 Manasight overlay project documented this explicitly in choosing Tauri over Electron for a gaming HUD; KAIROS should choose SwiftUI over both.

---

## Concepts (Papers Without Shipping Code)

**"Eliciting Spoken Interruptions to Inform Proactive Speech Agent Design"** (arXiv 2106.02077): Study of when/how humans interrupt each other. Key finding: people interrupt sooner for urgent information, use "access rituals" (mm-hmm, ah-) to pre-signal interruption, and balance speed vs accuracy based on task cues. KAIROS should model urgency in spoken announcements to let users know whether to barge-in immediately or wait.

**"Ambient Agents: When Events, Not Prompts, Are the Trigger"** (LangChain blog): Clearest conceptual framing of the reactive → ambient shift. Three human-in-loop patterns: Notify / Question / Review. KAIROS Phase C trigger engine should offer all three.

**"Comparing Perceptions of Static and Adaptive Proactive Speech Agents"** (arXiv 2405.07528): Adaptive agents (those that learn your preferences from dismissals) are perceived as significantly less annoying over time. Statically proactive agents create habituation — users stop listening. KAIROS must adapt proactivity thresholds per user over time.

---

## Recommended Changes to KAIROS Architecture

### Add immediately (Phase B / C)

1. **Significance scorer before every Narrator call.** Before invoking the Narrator LLM, run a cheap classifier (prompt + Haiku/Flash Lite) that returns `SIGNIFICANT | ROUTINE | SILENT`. Only call the full Narrator on `SIGNIFICANT`. Return `KAIROS_SILENT` internally on `ROUTINE`/`SILENT` — log but don't notify. Target: <5% of event batches reach the full Narrator.

2. **Rate limiter with daily budget.** Hard cap: max 8 proactive notifications per day, max 2 per hour. Excess signals are queued and bundled into a digest. Urgent signals (calendar conflict in <15 min, clipboard contains password-like string) bypass the cap.

3. **HEARTBEAT.md equivalent: `STANDING_ORDERS.md`.** A markdown file the user edits declaring what the daemon should watch for. Example: "If my Spotify changes to a song I haven't heard before, note it in memory." "If my calendar has a meeting starting in 10 minutes and I'm not on a video call, remind me." The Narrator checks standing orders on each significant event batch.

### Phase E (Voice)

4. **Adopt Pipecat's pipeline**: Silero VAD → WhisperKit (local, offline) → Narrator LLM (Claude Haiku 3.5) → Kokoro TTS (local) → AudioOut. Use WebRTC locally (LiveKit WHIP or Daily). Total pipeline target: <600ms on M2+.

5. **Hold-to-speak via CGEventTap on Right Option key.** Follow VocaMac's implementation exactly. Show a 24px floating oval indicator (Liquid Glass material) near the cursor on hold; animate to "processing" on release; dismiss after TTS completes or user dismisses.

6. **Barge-in**: VAD mid-TTS → stop TTS + cancel LLM generation → re-enter listening state. Pipecat handles this natively — use it.

### Phase F (HUD)

7. **SwiftUI NSPanel + Liquid Glass**. Target macOS 26+ only. Use `.glassEffect(.regular)` on a `NSPanel` with `.nonactivatingPanel`. Panel should be `level = .floating`, `collectionBehavior = [.canJoinAllSpaces]`. Panel should never steal focus. Animate in from bottom-center, animate out after 4 seconds or user dismiss.

8. **Don't use Tauri.** KAIROS is macOS-only, and the HUD needs native `liquidGlass` material, NSPanel-level control, and deep accessibility API integration. Tauri cannot provide these without Objective-C bridging that negates its cross-platform advantage.

### Phase G (Memory)

9. **Use Engram as the memory backend.** Drop in `engram-sdk` (npm / PyPI). SQLite + semantic vector search + knowledge graph + LLM consolidation. Run the consolidation loop during system idle (use `IOPMAssertionCreateWithName` to detect idle, or watch for `kIOPMAssertPreventUserIdleSystemSleep`).

10. **Adopt the Hermes Dreaming scoring formula**: score = `w1*(relevance) + w2*(frequency) + w3*(recency) + w4*(diversity) + w5*(richness) - w6*(duplication)`. Promote scores above threshold to the knowledge graph; prune below threshold. Run nightly, not on a cron — trigger on "user has been idle >20 min and on AC power."

### Drop / Reconsider

11. **Drop the fixed-interval Narrator loop** (if KAIROS currently has one). The Narrator should be triggered by the event bus consumer's significance score, not by a timer. Timer-based narration will produce routine summaries that train the user to ignore notifications — the exact failure mode of every "ambient AI" product that has shipped and been disabled within a week.

12. **Reconsider screenpipe as a sensor bus.** KAIROS could run as a screenpipe pipe (scheduled AI agent consuming the screenpipe API) rather than building its own capture layer. This would give KAIROS a battle-tested sensor layer immediately. The tradeoff: screenpipe's schedule-based pipe system would need to be replaced with a real event trigger. Feasible but non-trivial.

---

*Research conducted 2026-05-24. Sources span GitHub repos, arXiv papers (NeurIPS 2025, ICLR 2025), and project documentation.*
