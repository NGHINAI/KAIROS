# Clicky / HeyClicky / OpenClicky — Deep Teardown (2026-06-01)

Research for KAIROS Phase H (Clicky-style screen guidance / computer use). Three targets:
shipped binary `/Applications/HeyClicky.app`, `jasonkneen/openclicky` (OSS fork), `farzaa/clicky` (original OSS).

## TL;DR — the three are different generations
- **farzaa/clicky** (OSS, MIT, ~6.3k★): Clicky v1. Swift menubar app. Claude (Sonnet 4.6) via Cloudflare Worker, AssemblyAI STT, ElevenLabs TTS, push-to-talk (Ctrl+Opt), **pointing only** ([POINT:x,y] → animated triangle cursor), NO computer use, NO agents, NO MCP. Farza keeps new work private.
- **jasonkneen/openclicky** (OSS fork, ~93% Swift): the advanced OSS reference. Adds Codex app-server + Claude Agent SDK bridge (warm child processes over stdio JSON-RPC), real **computer use via Cua (AX-tree + CGEvent.postToPid, no-foreground)**, NSPanel notch HUD, pluggable STT, specialist sub-agents (6-file folders + HEARTBEAT.md), ~50 skills, control bridge on 127.0.0.1:32123.
- **HeyClicky.app** (shipped, com.humansongs.clicky v1.0.21): the commercial build. Bundles **OpenAI Codex CLI** (~180-200MB Mach-O in CodexRuntime/) as the agent brain via Cloudflare Worker proxy, **Cua computer-use** (ClickyComputerUseRuntime 22MB helper + cua-driver skill), Composio MCP (25 integrations), OpenAI Realtime voice (alloy/ash/cedar/marin…), AssemblyAI STT, Supabase+paywall, PostHog+Sentry, Sparkle auto-update. LSUIElement menubar/notch app.

## Architecture pattern (shared, gold-standard)
**Swift native shell owns ONLY I/O + OS control; the agent brain is shelled out to a CLI over local IPC, kept warm.**
- Shell: mic capture, screenshots (ScreenCaptureKit), NSPanel HUD, global hotkey (CGEvent tap), permissions (TCC), audio playback.
- Brain: Codex app-server (stdio JSON-RPC: thread/start, turn/start {effort:"low"} for voice) and/or Claude Agent SDK bridge (bridge.mjs, line-delimited JSON, claude-sonnet-4-6 default). Warm processes hide cold-start; no per-request timeout for agent work.

## Computer Use — the crown jewel (cua-driver / Cua, github.com/trycua/cua)
**The "no-foreground contract": the user's frontmost app MUST NOT change while the agent drives another app.** This is the entire differentiator.
- Events posted **per-pid via `CGEvent.postToPid`**, NOT global cghidEventTap → no cursor warp, no Space switch, no focus steal.
- **AX-tree-first, not pixel-first**: `get_window_state({pid,window_id})` returns AX tree (tree_markdown) + screenshot together. Act by `element_index` (AX node), never raw coords (coordinate clicks BLOCKED in HeyClicky runtime).
- Loop: `launch_app({bundle_id})` → `get_window_state` → decide element_index → `click/type_text/set_value/scroll/press_key/hotkey` → re-`get_window_state` to verify. Snapshot-act-verify, snapshot invariant not optional.
- `launch_app` has internal `FocusRestoreGuard` that clobbers foreground back after a target's NSApp.activate. `open`/osascript activate/cliclick all FORBIDDEN (they foreground).
- Browser: open each URL as a new **window** (own window_id+AX tree) not tab; tab-switching (⌘]) visibly flips UI even backgrounded; ⌘L omnibox = focus-steal. `page({action:"get_text"|"query_dom"|"execute_javascript"})` for DOM.
- capture_mode: "som" (AX+png default) / "ax" / "vision". Agent cursor overlay (triangle + ripple) toggleable for demo.
- Menu bar: only when target is frontmost (on-screen menu belongs to frontmost app).
- Safety: stop before purchases/sends/deletes/payments/form-submits unless explicitly approved.

## Routing doctrine (ClickyModelInstructions.md / SOUL.md)
Narrowest-capable route, in order: **structured/local tools → resume owning child thread → Composio MCP (connected external apps) → Cua/Computer-Use (last-mile native/browser UI)**.
- Screenshots are CONTEXT, not route selection — seeing Gmail on screen ≠ "use the GUI"; prefer Composio first unless user says "click/type this page".
- Two lanes: **voice companion** (fast, conversational, screen-aware, effort:low, must NOT spawn agents) vs **agent mode** (autonomous, tools, background); heavy work auto-promotes voice→agent.
- Draft-first email; approval before send/delete/irreversible.
- Don't hallucinate unavailable provider routes; name the blocker.

## Models (mixed-vendor by design)
- HeyClicky shipped: Codex CLI (agent) + OpenAI Realtime (voice) + AssemblyAI (STT) + Anthropic fallback.
- openclicky: speech gpt-realtime-2; delegation claude-sonnet-4-6; codex actions gpt-5.4; fast voice claude-haiku-4-5. STT pluggable (Apple/AssemblyAI/Deepgram/OpenAI). TTS ElevenLabs.
- farzaa: claude-sonnet-4-6/opus-4-6, AssemblyAI u3-rt-pro, ElevenLabs eleven_flash_v2_5.

## Voice
- openclicky: pluggable STT protocol (BuddyTranscriptionProvider). Wake word = Apple SFSpeechRecognizer always-on + **substring match** "hey clicky" (NO Porcupine, no real VAD). Push-to-talk global CGEvent tap.
- HeyClicky: OpenAI Realtime + AssemblyAI ws. Always-listening toggle (realtimeVoiceToggleRow).

## Notch / HUD UI
NSPanel subclass: `[.borderless, .nonactivatingPanel]`, `canBecomeKey:true`/`canBecomeMain:false`, `level` = statusBar+1, clear bg, `collectionBehavior=[.canJoinAllSpaces,.stationary,.fullScreenAuxiliary]`, hidesOnDeactivate:false. 28pt corner radius + "liquid glass" backdrop. `.nonactivatingPanel` + per-pid events = HUD never steals focus. DynamicNotchKit-style animations.

## Skills system
Folder-per-skill with SKILL.md (name/description frontmatter + instructions). ~14 bundled in HeyClicky, ~50 in openclicky. Workflow skills (research-report, repo-operator, email-assistant, google-workspace, build-preview, dev-setup-doctor, artifacts, creative-studio) + capability skills (pdf, doc, spreadsheet, frontend-design, obsidian, vercel-deploy, cua-driver). Specialist sub-agents = 6-file folders (agent.json, soul.md, instructions.md, memory.md, HEARTBEAT.md, skills.json allowlist); "specialist-builder" builds other agents.

## Control bridge (openclicky) — 127.0.0.1:32123 HTTP+SSE
Language-agnostic, non-invasive (doesn't mutate conversation): /cursor (animated triangle + secondary cursors), captions, /speak, screenshots. Model emits `[POINT:x,y:label]` / `[TYPE:x,y:label]` markers → bridge renders screen guidance.

## What KAIROS already has vs needs (for Phase H)
HAVE: Bun daemon Architecture A, canonical STT/TTS, Silero VAD, memory, env model swap, Composio MCP wiring, skills (AWM).
NEED for Clicky-parity: (1) Cua-style no-foreground computer use (the hard part — github.com/trycua/cua), (2) NSPanel notch/liquid-glass HUD (Phase G), (3) screen-guidance pointing-cursor bridge, (4) the narrowest-route doctrine in the conductor (structured→composio→cua), (5) screenshot context per turn.

## Key files to study in openclicky (most valuable)
- OpenClickyComputerUseRuntime.swift (CGEvent control)
- OpenClickyNotchCaptureWindowManager.swift (NSPanel HUD)
- CodexVoiceSession.swift (voice RPC + lane split)
- ClaudeAgentSDKBridge/bridge.mjs (warm Claude process)
- ClickyBundledSkills/cua-driver/SKILL.md (the no-foreground contract — full text in HeyClicky.app)
- skill-suggestion-rules.json (proactive frontmost-app-triggered suggestion chips)
