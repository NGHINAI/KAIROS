# Live Voice Session — Bug Diagnosis & Backend Handoff
**Date:** 2026-06-07  · **Session:** `./scripts/voice-hud.sh`, daemon PID 24788, ~14:51–14:54 local (17:51–17:54 UTC)
**Audience:** backend/daemon session. **Author:** UI session (diagnosis only; no daemon code changed).

This documents five independent issues that surfaced in one voice session. They have **different root causes** that merely coincided — fixing one does not fix the others. Each entry: symptom → root cause → evidence (file:line + log/DB) → recommended fix.

Ground-truth sources used: `state/logs/{turns.jsonl,daemon.log,conversation.log}`, the SQLite ledger `state/state.db → llm_call_log`, and the source under `src/daemon/`.

---

## Summary

| # | Bug | Severity | One-line |
|---|-----|----------|----------|
| 1 | **LLM cost over-counted ~10×** (`Math.ceil` per-call cents) | **HIGH** | `$50.69` recorded vs ~`$5` real OpenRouter; false monthly-budget exhaustion |
| 1b | Perception `classify` prompt huge (~5.3k tok) + fires every 30s | MED | The volume driver behind #1 (4,522 calls/mo) |
| 2 | Read-only `kairos_*` introspection tools mis-gated as destructive writes | **HIGH** | Spurious background approvals; the trigger for #3 |
| 3 | Approval summary **speaks the raw tool id** ("do via kairos_composio_status") | **HIGH** | The "spoke internal/system messages" complaint |
| 4 | Foreground (fast) speech **truncated** by barge-in / supersede on a shared speaker | MED-HIGH | "Didn't speak whole replies"; partial/cut audio |
| 5 | Empty fast reply produced a **silent turn** (guard didn't fire) | MED | "Okay." → blank; nothing spoken |
| — | Port `8765` in boot banner | NOT A BUG | Daemon binds 8765 (legacy) **and** 9876 (`/v1/*`) by design |

**Key architectural fact:** the **voice conductor does NOT go through `ModelRouter`** (it builds raw `OpenRouterAdapter`s), so the monthly budget never gated voice. The budget only starved the **ambient/proactive** brain (perception `Tier1Classifier`, Dreamer). That's why every voice turn answered normally while the log spammed "monthly budget exceeded" every 30s.

---

## Bug 1 — LLM cost over-counted ~10× (false budget exhaustion) — HIGH

**Symptom.** `ModelRouter: monthly budget exceeded` everywhere; KAIROS's ledger says **$50.69 MTD** spent, but real OpenRouter spend is ~**$5**. The $50/month cap fired on inflated numbers.

**Root cause.** Per-call cost is quantized to whole cents with `Math.ceil`, so every sub-cent call is recorded as **≥ 1¢**:
```ts
// src/daemon/llm/providers/openrouter.ts:153-156
const costCents = Math.ceil((
  (inputTok  / 1_000_000) * pricing.input  +
  (outputTok / 1_000_000) * pricing.output
) * 100)
```
`cost_cents` is an **INTEGER** column (`costTracker.ts:20`), and `monthlyCostCents()` sums it (`costTracker.ts:88-94`); `isOverBudget()` compares to `monthly_budget_usd * 100` (`costTracker.ts:104-106`); the throw is `router.ts:127-129`. The **pricing table is correct** (gpt-4o-mini ≈ $0.15/1M in, $0.60/1M out) — the bug is solely the per-call ceil.

**Evidence (ledger, `state/state.db → llm_call_log`, MTD since 2026-06-01):**
| task_type | calls | avg in tok | avg out tok | avg ¢ | recorded $ | real $ (est) |
|---|---|---|---|---|---|---|
| classify | 4,522 | 5,304 | 4 | 0.98 | **$44.44** | ~$3.6 |
| dream | 401 | 180 | 120 | 1.0 | $4.01 | ~$0.3 |
| action_compose | 139 | 3,881 | 846 | 1.39 | $1.93 | ~$1 |
| (others) | ~28 | — | — | — | ~$0.3 | — |
| **TOTAL** | **5,090** | | | | **$50.69** | **~$5** |

Cost-cents distribution: **4,970 calls recorded as exactly `1`**, 79 as `0`, 30 as `2`. A classify call (5,304 in / 4 out on gpt-4o-mini) really costs `(5304/1e6)*0.15*100 ≈ 0.08¢` → `Math.ceil → 1¢` → **~12× over** per call.

**Recommended fix.** Preserve sub-cent precision — don't `Math.ceil` per call:
- Store cost in a finer integer unit (e.g. `cost_microcents` = cents×1000, or nano-dollars) and only round for display, **or** store a REAL dollar amount. Update `costTracker` schema + `monthlyCostCents()`/`isOverBudget()` accordingly (compare `monthly_budget_usd * 100_000` if micro-cents).
- Minimum change that stops the bleeding: compute the float cents and **round at aggregation time**, not per row (keep raw float in a new column). Avoid `Math.round` per call too (sub-0.5¢ → 0 loses cost across volume).
- Also applies to other providers that may ceil similarly — audit `anthropicApi.ts:82+` cost math.

**Operational (to unblock testing now — no code):**
```bash
# Raise the KAIROS-internal cap (it's NOT OpenRouter's bill):
#   ~/.kairos/providers.json  →  "monthly_budget_usd": 50  →  e.g. 200   (back up first)
# OR reset the recorded month (daemon must be stopped; back up state.db):
sqlite3 state/state.db "DELETE FROM llm_call_log WHERE ts >= strftime('%s','2026-06-01')*1000;"
```
Reminder: voice testing is unaffected by this cap regardless (see "Key architectural fact").

---

## Bug 1b — perception `classify` is the volume driver — MED

The 4,522 `classify` calls/mo come from the **perception pipeline polling every 30s, 24/7** (`perceptionPipeline.ts:38` default `pollMs ?? 30_000`, armed `:42-44`), each calling `Tier1Classifier.classify()` (`tier1Classifier.ts:28-33`) on the `ultra_cheap` tier → gpt-4o-mini (`policy.ts:11`, `router.ts:29`). The prompt averages **~5,304 input tokens** — very heavy for "the cheapest gate." Even after fixing #1, this is ~$3.6/mo of real spend doing nothing while idle.

**Recommended fix:** (a) add a `KAIROS_PERCEPTION_POLL_MS` env knob (currently hardcoded) and/or back off when the screen is idle; (b) trim the classify prompt (5.3k tokens for a SIGNIFICANT/ROUTINE/SILENT decision is excessive); (c) a way to disable proactivity for test sessions.

---

## Bug 2 — voice path is uncoupled from the budget (architectural note) — INFO/MED

Not a defect per se, but document the intent. Voice turns use **raw `OpenRouterAdapter`s built in the conductor** (`conductor.ts:501,517,523,528` for the smart planner; fast via `buildAgentLlmCompleter` `index.ts:188-222`, wired `:2301-2303`) — they **never call `ModelRouter`/`CostTracker.isOverBudget()`**. Meanwhile perception/Dreamer/narrator/skills/memory DO go through `ModelRouter` (two instances: `index.ts:522` main, `:1524` voiceRouter, both on the same `state.db` + same cap). Result: the cap can starve the background brain while voice keeps spending un-tracked. Decide if voice should be metered (even if not gated) so the ledger reflects total spend.

---

## Bug 3 — read-only `kairos_*` tools mis-gated as destructive writes — HIGH

**Symptom.** A background sub-agent (the "research flights" task) paused for a **human approval** to run `kairos_composio_status` — a **read-only** introspection tool ("list which Composio toolkits are connected", `introspectionTools.ts:185-189`). It should never gate.

**Root cause.** `approvalWrap.callNeedsApproval` (`approvalWrap.ts:43-49`) calls `isDestructiveCall(call, {unmappedDefault:"write"})`. In `verifier.ts:isDestructiveCall` (`:59-65`), the `LOCAL_TOOLS` allowlist (`verifier.ts:40-46`) only whitelists `search_tools` and `find_integration`; the other read-only `kairos_*` introspection tools (`kairos_composio_status`, `kairos_help`, `kairos_memory_overview`, `kairos_dreams_last`, …) are missing and have no `toolNature` entry, so line 65 returns `unmappedDefault === "write"` → **true** → approval required.

**Recommended fix.** Add all side-effect-free `kairos_*` introspection tools (defined in `introspectionTools.ts`) to `LOCAL_TOOLS` (`verifier.ts:40-46`), or give them an explicit `toolNature: "read"`. Sub-agents then run reads without gating.

---

## Bug 4 — approval summary speaks the RAW tool id ("spoke internal messages") — HIGH

**Symptom.** KAIROS **vocalized internal text**: *"Quick approval — I want to do via kairos_composio_status. Say yes to go ahead, or no to skip."* and, on the user's "Yes": *"Okay, going ahead with: do via kairos_composio_status."* (Proof: `daemon.log:66721` `[voice] background approval APPROVED "do via kairos_composio_status"`.)

**Root cause.** The approval summary builder has no friendly name for the tool and no verb match, so it falls back to `"do via " + <raw tool id>`:
```
approvalWrap.ts:60  → humanSummary(tool.name, effective, args)
approvalWrap.ts:74-86 → unmatched ⇒ "do via " + label   (label = raw snake_case id)
```
That raw string is spoken verbatim at **`backgroundSubsystem.ts:93`** (the ask) and **`index.ts:2418`** (the resolve). There is **no sanitizer on this path** — `sanitizeReply()` (`conductor.ts:480-485`, strips `<think>`/tool-markup) is only applied to *conductor replies*, not to approval summaries, which are spoken directly via `streamingSpeaker.begin/feed/end` (`index.ts:2399`).

**Recommended fix.** (a) Humanize `humanSummary` (`approvalWrap.ts:74-86`): never emit a raw `snake_case` id — map known tools to friendly verbs/nouns, else strip the `kairos_`/toolkit prefix and de-snake. (b) Run the approval ask/resolve text through a sanitizer before TTS. (c) Note that Bug 3 is the trigger — fixing #3 stops *this specific* tool from gating, but #4 must be fixed independently so no future mis-gated/odd tool name is ever spoken raw.

---

## Bug 5 — empty fast reply → silent turn — MED

**Symptom.** "Okay." produced no spoken reply. `turns.jsonl` line 122: `{"utterance":"Okay.","tier":"fast","reply":""}`; `conversation.log` shows a blank `KAIROS:` line.

**Root cause.** The fast model returned empty content. The guard `sanitizeReply(resp.text) || "Sorry, I didn't catch that…"` (`conductor.ts:207`) only fires on a falsy result; an empty-after-trim or whitespace value slipped through and recorded `""`. (The turn was also superseded ~751ms later — see Bug 4-truncation below.)

**Recommended fix.** Harden the guard at `conductor.ts:207` to treat whitespace-only / post-sanitize-empty as empty and emit the fallback (or stay deliberately silent without logging a "reply"). Consider a separate filler model fallback when fast returns blank.

---

## Bug 4-truncation — foreground replies cut off mid-audio — MED-HIGH

**Symptom.** Fast replies were **generated in full** (full text in `turns.jsonl` / `agent_done`) but **spoken only partially**.

**Root causes (audio layer, not generation):**
1. **Spurious barge-in.** `daemon.log:66694-66695`: "Hey, how's it going?" finished, then a `WS cmd: barge_in` fired **+89ms** later (no user utterance transcribed in that gap — the VAD self-triggered on KAIROS's own tail audio / room noise). Barge-in handlers (`index.ts:2648-2660` renderer VAD, `:2680-2690` sidecar VAD) call `streamingSpeaker.cancel()` + `sayBackend.stop()` → clips the tail. **No debounce against the agent's own audio.**
2. **Supersede-on-every-utterance.** `handleUtterance` top (`index.ts:2383-2384`) does `activeConductorController?.abort()` + `streamingSpeaker.cancel()` unconditionally. Rapid/double utterances ("Okay." → "Can you?" 751ms apart, `daemon.log:66704` vs `66707`) kill the prior reply mid-speak — this is the "aborted after classify" you saw (`conductor.ts:122`).
3. **Shared single speaker, no cross-utterance queue.** One `StreamingSpeaker`/`SayBackend` built at `index.ts:1996`, reused for fast/smart/background-report. `SayBackend.speak()` self-cancels (`sayBackend.ts:49`); `StreamingSpeaker.cancel()` wipes the queue + stops the backend (`streamingSpeaker.ts:50-55`). Any overlapping speak truncates the previous.

Fast tier speaks the whole string at once (`conductor.ts:197-218`: complete → `agent_done` → `speakBackend.speak(text)`), so truncation is **not** sentence-chunking/early-flush — it's external `cancel()`.

**Recommended fix.** (a) Debounce barge-in: ignore VAD for a short window after our own TTS ends, or gate on actual transcribed speech, not raw VAD. (b) Don't cancel a near-finished fast reply on supersede — let short replies drain, or queue. (c) Consider per-utterance speaker serialization instead of one shared, cancel-on-touch speaker. (d) Coalesce STT fragments of one breath (the "Okay." + "Can you?" 751ms split looks like one utterance fragmented).

---

## Not a bug — port 8765 vs 9876

The boot banner says `port: 8765`. The single daemon (PID 24788) binds **both**: 8765 (legacy HTTP/WS server, `daemon.log:66647`) and **9876** (the `/v1/*` wrap-API the HUD connects to, `index.ts:1546`, `daemon.log:66685`). Comment `index.ts:1536-1539` confirms 8765 was chosen "so it can coexist with the wrap-api on 9876." No rogue daemon, no misread.

---

## Approvals — UI now BUILT (2026-06-08); remaining daemon to-dos

The HUD now has a full approvals surface (UI session): a persistent amber **Approve/Deny** card at the top of the console + an amber "needs you" rim badge on the orb, and a `send()` channel. It consumes `approval_request{id,summary,toolName}` / `approval_inboxed{id,summary}` / `approval_resolved{item_id}` and sends `{cmd:"approve"|"deny",item_id:<id>}`. Voice ("yes"/"no", now or later via the inbox) is unchanged and works. The card defensively humanizes the summary so a raw slug never shows.

For this to be correct end-to-end, the **daemon** still needs (all daemon-side, backend session):
1. **Don't gate read-only tools** (Bug 3 above) — `kairos_composio_status` etc. must never trigger an approval. This is what produced the "do via kairos_composio_status" ask. Add the read-only `kairos_*` introspection tools to `LOCAL_TOOLS` (`verifier.ts:40-46`).
2. **Humanize approval summaries** (Bug 4 above) — `approvalWrap.ts:74-86` must emit prose ("send an email to Sam"), never `"do via <RAW_TOOL>"`.
3. **"Remind anytime" — raise/disable `maxParkMs`.** `approvalGate.ts:26,88` defaults to **10 min**, after which a parked approval AUTO-DENIES. The user wants to approve whenever (later that day, etc.), so a parked approval must persist much longer (or until the sub-agent is cancelled). Make `maxParkMs` large/configurable, and ensure the sub-agent stays parked at zero cost meanwhile (it already does). The inbox already persists the item and voice/UI both resolve it — only the 10-min auto-deny caps "anytime."

## 2026-06-09 UPDATE — speech/approval fixes APPLIED IN CODE (tested)

Done directly in the daemon (not just documented), all 259 agent-layer tests green:
- **Markdown no longer spoken** (`*`→"star" etc.): `spokenSanitizer.ts` now `stripSpeakableMarkdown` (fenced/inline code, links, headings, bullets, bold/italic, stray `* _ \` # > ~ |`) inside `sanitizeSpoken`, plus a stream-safe char strip in `SpokenStreamFilter.push/flush`. Newlines collapse so multi-line reports speak as prose.
- **Internal names/slugs no longer spoken**: `scrubInternal` maps `Composio`/`MCP`→"the integration" and humanizes raw `SCREAMING_SNAKE` tool slugs (`GMAIL_SEND_EMAIL`→"gmail send email").
- **Approval ask + background report routed through the guard**: `backgroundSubsystem.ts` wraps the "Quick approval — I want to …" line in `sanitizeSpoken`, and `reportLine` now sanitizes the **goal** too (not just the summary).
- **"Remind anytime"**: `approvalGate.ts maxParkMs` default 10 min → **24h** (a parked to-do survives the day instead of auto-denying).
- Tests added: `spokenSanitizer.test.ts` (markdown, internal terms, slugs, approval-line, stream).
- Read-only tool gating (Bug 3) was already fixed in code (`verifier.ts:65` `kairos_*`/local → never gate); the 06-08 session only showed it because it ran a **stale 06-07 daemon** — restart picks it up.

## 2026-06-08 FOLLOW-UP — what's fixed, what's still broken (from the 06-08 22:16 session)

**Status of earlier bugs:** `348524d` (read-tool mis-gate + raw-id-spoken) and `65e61ab` ("never speak internal text" guard at every TTS sink) FIXED Bugs 3 & 4 — `verifier.ts:65` now `return false` for any `call.name.startsWith("kairos_")`, and approvals/replies route through `sanitizeSpoken`. ⚠️ **Operational gotcha:** the 06-08 22:16 session still showed the OLD behavior (gated `kairos_skills_list` @22:17:04 and `kairos_memory_search` @22:17:32; spoke raw ids) because it ran the **stale 06-07T21:54 daemon** — the 06-08 restarts were refused ("another daemon already running"). **A single long-lived daemon silently serves stale code across days. Recommend: a build/commit stamp in the boot banner + the launcher killing any existing daemon before starting (or the "refusing to start" path should win and replace).** Restart on current HEAD clears Bugs 3/4.

**STILL BROKEN (NOT previously flagged — my miss): markdown/formatting spoken aloud → "star".**
`sanitizeSpoken` (`src/daemon/agents/spokenSanitizer.ts:30-35`) strips `<think>`/tool-markup but does **NOT** strip markdown. A background report / reply containing `*`, `**`, `#`, `` ` ``, `- ` bullets, or `[text](url)` is spoken with the punctuation verbalized ("star", "hash", "backtick"). The flights report's `*`/`**` is what spoke "star". This is the single guard on every TTS sink, so fix it once here:
```ts
// add to spokenSanitizer.ts and call inside sanitizeSpoken() AFTER the think/tool-markup handling:
function speakableProse(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, " ")            // fenced code → drop
    .replace(/`([^`]*)`/g, "$1")                 // inline code → text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")   // links/images → label
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")          // headings
    .replace(/^\s*[-*+]\s+/gm, "")               // bullet markers
    .replace(/(\*\*|__)(.*?)\1/g, "$2")          // bold
    .replace(/(\*|_)(.*?)\1/g, "$2")             // italic
    .replace(/[*_#`>~|]/g, " ")                  // any stray markdown char → space
    .replace(/\s{2,}/g, " ").trim()
}
```
Also: the approval ask at `backgroundSubsystem.ts:94` speaks `` `Quick approval — I want to ${req.summary}…` `` WITHOUT `sanitizeSpoken` — wrap `req.summary` (and the whole line) in it.

**STILL TODO: never voice internal infra terms in natural prose.** Beyond markup, the model can casually say "Composio" / a tool slug in a normal sentence (not markup, so the guard misses it). Two layers: (1) a **system-prompt rule** — "never mention internal infrastructure (Composio, MCP, tool slugs, runIds) by name; speak in user terms (Gmail, Calendar)"; (2) a small **denylist scrub** in `sanitizeSpoken` mapping known internal terms out (Composio→"", or →"the integration"). 

**STILL TODO (the "permission for any tool access" principle):** read-only tool ACCESS must never gate — only genuine outward/destructive actions (send/delete/pay/post/connect). `kairos_*` is handled; confirm the `toolNature` read/write classifier (commit `f4d09c4`) marks read-only Composio tools (search/fetch/list/get/read) as `read` so a background agent never gates on a *read*. Background `unmappedDefault:"write"` should only bite truly-unknown tools, and ideally even those default to read unless a destructive verb matches.

**STILL TODO: raise/disable `approvalGate.ts maxParkMs`** (10-min auto-deny) for "remind anytime" (carried from above).

## File:line index (for the backend)
- Cost ceil bug: `src/daemon/llm/providers/openrouter.ts:153-156`; integer schema `src/daemon/llm/costTracker.ts:20`; sum/cap `:88-94,104-106`; throw `src/daemon/llm/router.ts:127-129`; cap config `~/.kairos/providers.json` + default `src/daemon/llm/config.ts:20`.
- Perception volume: `src/daemon/perception/perceptionPipeline.ts:38,42-44`; classifier `src/daemon/perception/tier1Classifier.ts:28-44`; tier map `src/daemon/llm/policy.ts:11`, `router.ts:29`.
- Voice bypass: `src/daemon/agents/conductor.ts:501,517,523,528`; `src/daemon/index.ts:188-222,2301-2303`; dual routers `index.ts:522,1524`.
- Mis-gate: `src/daemon/agents/loop/verifier.ts:40-46,59-65`; `approvalWrap.ts:43-49`; tool def `src/daemon/agents/loop/introspectionTools.ts:185-189`.
- Spoken raw id: `src/daemon/agents/loop/approvalWrap.ts:60,74-86`; spoken at `src/daemon/agents/loop/backgroundSubsystem.ts:93` and `src/daemon/index.ts:2399,2418`; sanitizer only on conductor `conductor.ts:480-485`.
- Empty fast guard: `src/daemon/agents/conductor.ts:207`.
- Truncation: supersede `index.ts:2383-2384`; barge-in `index.ts:2648-2660,2680-2690`; shared speaker `index.ts:1996`; `streamingSpeaker.ts:50-55`; `sayBackend.ts:45-67`; fast speak `conductor.ts:197-218`.

## Evidence index (logs/DB)
- `state/state.db → llm_call_log` — MTD $50.69, classify 4,522 calls/$44.44, 4,970 rows at exactly 1¢.
- `state/logs/daemon.log` — Tier1 budget fail every 30s (66591,66701,66717,66722-66724); Dreamer bounces (66558-66588); barge-in (66694-66695); double-utterance (66704,66707); approval (66721); ports (66647,66685).
- `state/logs/turns.jsonl` — full per-turn replies; "Okay." reply `""`.
- `state/logs/conversation.log` — spoken lines incl. the blank "Okay." turn.
