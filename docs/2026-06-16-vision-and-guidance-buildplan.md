# KAIROS guidance + vision build plan (2026-06-16)

Source: planning workflow `wq8s2ow03` (last-session debug + Tier-2 architecture + phased plan). Memories: [[kairos-guidance-smartness]], [[kairos-brain-router]], [[kairos-clicky-research]], [[kairos-codex-brain-migration]].

## Last-session defects (verified vs state/logs/turns.jsonl, conv_default 06-16)
- **D1 — opencode tool-name namespace mismatch (highest sev).** Brain registers tools as MCP `kairos_<tool>`; prompt teaches bare names (`read_screen`). gemini emits bare → "unavailable tool 'read_screen'", sometimes dead air (turn 571). Re-bite of the codex-migration MCP-namespace blocker.
- **D2/D5 — guidance misrouting + lesson never established.** `isGuidance` (conductor.ts:687) is a pure regex on the current utterance; "Continue", "show me THE sound settings", "what's next?" miss → lane=general → opencode-first → D1. `lessonContext` empty all session (the Active-walkthrough skip at conductor.ts:220 never fired live) → continuations start COLD.
- **D3 — AX-blind System Settings sidebar (known).** `guide_user(find:"Sound")` → "no element matching" → brute-force (turn 569 = 12 tool calls). cua_click wired (gpt-4o-mini) but called 0× (wrong tool for locate; not named as the AX-blind escape).
- **D4 — dead air** (19/26 smart turns no tools; trivial acks → opencode → no speakable text; D1 worsens).
- **D6 — speech leak** (tool-result coaching echoed into TTS; sanitizer misses it; logged leaked:false).
- **D7 — end_lesson refusal loop** strands user.
- **D8/D9 — scroll busy-loop; click/type no-op misreport on System Settings.**

## Tier-2 decision: HYBRID (AX → vision, gated, AX-snap)
- Tier 1 = AXFinder.find (fast/free). Tier 2 fires ONLY on AX `no element matching`, behind an INTERNAL `locate()` fallback inside guide_user/click_element (NOT a model-visible tool — avoids speculative use).
- Tier-2 model: **NO Claude** (user decision 2026-06-16 — "we don't want Claude computer-use; CUA like HeyClicky with a cheap non-Claude vision model"). DEFAULT **`qwen/qwen3-vl-8b-instruct`** (OpenRouter, $0.08/$0.50, ScreenSpot-v2 ~92%, native coords + tools — the cheapest hosted model that actually grounds GUIs). gemma/mistral have NO published GUI-grounding numbers (regression risk) so they're not the default, but the model is env-swappable: `KAIROS_TIER2_MODEL` + `KAIROS_TIER2_GROUNDER=qwen|off`. Escalation tier `qwen/qwen3-vl-32b-instruct` for hard frames. (qwen3-vl-2b/4b would be cheaper but aren't on OpenRouter yet.) "CUA" here = the unified AX+vision grounder (HeyClicky-style), not a Claude product.
- **AX-SNAP keystone:** Tier-2 returns a screenshot-px coordinate → HUD converts (window-local → global → AX top-left) → `AXUIElementCopyElementAtPosition` hit-tests the live AX node → press via `kAXPressAction` (real element, no cursor warp — keeps the no-foreground contract). Produces an `AXMatch` like Tier-1 so the comet/verifier/state-tag pipeline is untouched. Pixel CGEvent press only if NO AX node at the point (true canvas/Electron).
- Capture: new `ScreenGrounder.swift` (ScreenCaptureKit, target window only, downscale to model budget). New Screen-Recording TCC grant; gate the tier on it; degrade to Tier-1 + spoken note when denied.

## Build phases (ordered; each independently shippable + verifiable)
1. **[medium] Tier-1 AX sidebar fix** — `AXFinder.labelOf`: try `kAXTitleUIElementAttribute` first; `derivedLabel` for empty-label clickables (AXRow/AXCell/AXButton/AXOutlineRow) = single descendant AXStaticText's text. Closes System Settings WITHOUT vision. Verify: Swift unit test (synthetic AXRow + empty title + one StaticText child → find('Sound') returns the ROW).
2. **[medium] Guidance lane stickiness + lesson establishment** — conductor.ts:687: `isGuidance=true` when a screen-guide tool ran recently OR front app is System Settings OR Active-walkthrough lessonContext exists (not only GUIDE_RE). Broaden GUIDE_RE/TEACHING_RE. Fix the lessonContext-empty bug. Verify: conductor.fastfront test w/ the literal 569/563/571/572/573 utterances → lane='guidance'.
3. **[medium] D1 namespace + empty-reply guarantee** — openCodeBrain: accept both bare and `kairos_`-prefixed tool names (inbound normalizer mirroring stripMcpPrefix) AND/OR teach prefixed names; guarantee no turn ends silently (conductor.ts:710 fallback reaches TTS). Verify: openCodeBrain test (bare `read_screen` → executes); no-dead-air test.
4. **[large] Tier-2 daemon-side** — `cuaTool.ts`: `makeClaudeComputerUseLocate` (direct Anthropic Messages, computer_20251124, parse tool_use.coordinate) + keep `makeVisionLocate` (qwen); rework cua_click → internal locate() fallback on AX miss; env selection at index.ts. Verify: cuaTool.test parses both response shapes.
5. **[large] Tier-2 HUD** — `ScreenGrounder.swift` (SCScreenshotManager window capture) + `AXActor.pressAtPoint` (3-space coord convert + hit-test) + WS `ground_request`/`ground_result`. Replaces the doctrine-violating screencapture+cliclick. Verify: Swift coord-conversion test; live.
6. **[medium] opencode speed** — warm serve + session reuse across turns; kairos-low alias for short turns; anti-dead-air speakInterim fires for opencode. Verify: latency harness before/after.
7. **[medium] Advanced guidance robustness** — D6 (scrubInternal strips tool-instruction phrasing + logs leaked:true), D7 (end_lesson refusal yields a next-step, no loop), D8 (scroll line forces turn end), D9 (click/type reliability). Verify: spokenSanitizer + guideLesson tests.

## Status
- Done earlier: verifier voice-paced; AX state/side tags; scroll-arrow side (require element); state-awareness ruleset; stuck-overlay outcome-based retract. (commits 8edd1c3, 5df8658, fa3a242, f803ac3)
- Next: Phases 1–3 (headless-verifiable, fix basic-tasks + sidebar + dead air), then 4–5 (vision, need live screen), then 6–7.
