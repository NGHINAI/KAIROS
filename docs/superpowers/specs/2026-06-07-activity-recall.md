# KAIROS — Activity Recall ("what did you do yesterday?") — production spec

**Status:** shipped (voice-only) · **Date:** 2026-06-07 · **Branch:** `phase-e2-core`

> **REVISED 2026-06-07 (user direction):** the HUD timeline panel + the WS `recall_query`/`recall_result`
> feed (Phases 5–6 below) were REMOVED. KAIROS just SPEAKS its recall — via the `kairos_activity`
> voice tool, when asked or when the conversation relates to a past action. No visual surface.
> The durable activity log + tool (Phases 1–4) remain. The next direction is PROACTIVE
> self-reflection (use the same activity log to surface relevant follow-ups), restraint-gated.

## Goal
KAIROS can answer, by voice **and** in the HUD: *"what did you do yesterday / today / this week?"* — enumerating the actions it took (emails sent, issues created, inboxes summarized), the background tasks it ran and what they found, and the proactive things it did (reminders fired, observations surfaced) — for any time range.

## Why it doesn't work today (from the audit)
KAIROS is a meticulous record-keeper with **amnesia about its own records**: it writes everything durably but the voice planner has no tool that reads it back time-filtered.
- `kairos_traj_recent` is **mislabeled** — it reads `mem_l2_episodes` (perception rollups → "167 routine events"), not the action log.
- `kairos_daily_log` is the right idea but its writer only runs on a 7-day dream timer → `~/.kairos/daily/` is **empty**.
- The real action logs (`turns.jsonl`, `TrajWriter` day-files, `subagents.jsonl`, SQLite `tasks`/`ticks`) have **no model-callable tool**, and **nothing accepts a date filter**.
- Background sub-agent runs are **in-memory, evicted at 24, lost on restart**.

## Architecture — one normalized activity log + read-time union

**Decision:** a single durable `activity_events` table (the first-class "what KAIROS did" record), written by a small `ActivityRecorder` hooked into the producers we control (foreground action-turns + background sub-agent completions). At **query time**, `ActivityStore.query()` also **unions the existing autonomous SQLite tables** (`ticks` with real decisions, delivered `messages`, completed `tasks`, fired `schedules`) — these are already durable + timestamped, so we read them rather than double-writing into them. One unified, time-indexed shape feeds both the voice tool and the HUD.

Why not pure aggregate-on-read over the markdown/YAML/JSONL? Fragile (YAML parse, lazy tables, eviction) and slow per query. Why not hook every proactive writer? Unnecessary surface — those tables are already clean. The hybrid is the production sweet spot.

### `activity_events` (new SQLite table, shared `state.db`)
```
id INTEGER PK AUTOINCREMENT
at INTEGER NOT NULL              -- ms epoch
day TEXT NOT NULL               -- 'YYYY-MM-DD' in the USER's tz (KAIROS_TZ) — the bucket key
kind TEXT NOT NULL              -- 'action' | 'subagent' | 'read' | 'tick' | 'task' | 'message' | 'schedule_fired'
lane TEXT NOT NULL              -- 'foreground' | 'background' | 'proactive'
conversation_id TEXT
run_id TEXT
title TEXT NOT NULL             -- short, secret-sanitized ("Sent an email to pateln062@gmail.com")
detail TEXT                     -- optional longer summary / the user's request
tool TEXT                       -- primary tool/intent name
status TEXT                     -- 'done' | 'failed' | 'cancelled' | 'info'
ref_json TEXT                   -- ids/metadata for linking (threadId, taskId) — NEVER bodies
importance REAL                 -- 0..1; chitchat/reads low, writes high (for digest filtering)
CREATE INDEX idx_activity_day ON activity_events(day, at);
CREATE INDEX idx_activity_at  ON activity_events(at);
```

### Time util — `dayKey` / `resolveWhen` (new, shared)
The single fix for the UTC-vs-KAIROS_TZ gotcha (today the `toISOString().slice(0,10)` idiom is copy-pasted in 4 places, all UTC).
- `dayKey(ts, tz=KAIROS_TZ): 'YYYY-MM-DD'` — the user's local day for a timestamp.
- `resolveWhen(phrase, tz, now): { from, to, label }` — "yesterday" / "today" / "this week" / "last 7 days" / a date → an ms range + a human label. Default = today.

### `ActivityStore` (new)
- `record(ev)` — INSERT one normalized event (computes `day` via `dayKey`, sanitizes `title` with the existing `SECRET_PATTERNS`).
- `query({ from, to, kinds?, lanes?, minImportance?, limit? })` → unified `ActivityItem[]` sorted by `at`: reads `activity_events` in range **+** best-effort (try/catch per table) unions autonomous rows mapped to `ActivityItem` (ticks where `decision NOT IN ('sleep','noop')`, delivered `messages`, `tasks` completed in range, `schedules` fired in range).
- `digest(items)` → a compact rollup string ("12 things — 3 emails sent, inbox summarized, 2 background tasks, 1 reminder fired") for the spoken lead-in + the HUD header.
- `prune(olderThanMs)` — retention (default keep 90 days; `KAIROS_ACTIVITY_RETENTION_DAYS`).

### `ActivityRecorder` wiring
- **Foreground** (conductor `handleSmart`): after a turn, if it used ≥1 tool → record `kind:'action'` (write-nature, importance 0.8) or `kind:'read'` (read-only, importance 0.4); pure chitchat → skip. `title` derived from the primary tool + sanitized arg (reuse `describeAction`), `detail` = the user's request, `ref_json` = ids from results (threadId etc.). Off the hot path (after speaking).
- **Background** (index.ts `appendTraj` hook @2205 — the durable sub-agent completion sink): record `kind:'subagent'`, `title` = goal, `detail` = final report, `status` from outcome, `run_id`.
- **Proactive**: read-time union (no new write path).

### Voice tool — `kairos_activity({ when })`
Added to `buildIntrospectionTools` (same pattern as `kairos_daily_log`). `when` defaults "today". Resolves the range, queries `ActivityStore`, returns `{ label, digest, items }` (compact, id-free for speech). The model speaks a natural summary. Also **broadcasts `recall_result`** so the HUD shows the timeline alongside the spoken answer.
- **Fix the broken tools:** repoint/relabel `kairos_traj_recent` to filter out routine perception rollups (importance/episode_type), and correct `kairos_daily_log`'s description (it summarizes conversation, not actions).

### HUD feed — WS request/response
- Inbound command (`index.ts:2538` `onCommand`): `cmd:'recall_query' { when|date }` → `ActivityStore.query` → `broadcast({ event:'recall_result', label, digest, items:[...] })`. Mirrors `approve`→`approval_resolved`.
- The `kairos_activity` voice tool also emits `recall_result` so asking by voice populates the panel.

### HUD UI — the Recall panel (new Swift surface)
A new glass panel (sibling to the live `ConsoleView`), **scrollable + date-grouped** — the HUD's first history surface.

```
┌──────────────────────────────────────────────┐
│  ◀  Yesterday · Fri Jun 6            ▶   ✕     │   ← day nav (prev/next), close
│  12 things · 3 emails · inbox summarized ·      │   ← digest line
│  2 background tasks · 1 reminder                │
├──────────────────────────────────────────────┤
│  9:14a  💬  Sent an email to pateln062…   ✓     │   ← foreground action (tap → detail)
│  9:30a  💬  Summarized your inbox          ✓     │
│ 10:02a  ⚙️  Background: researched flights ✓     │   ← background sub-agent (tap → report)
│  1:00p  🔔  Reminder fired: "standup"      ✓     │   ← proactive
│  3:20p  💬  Tried to reply to that email   ✗     │   ← failed = amber
│           └ couldn't find the thread            │
└──────────────────────────────────────────────┘
```
- **Triggers:** (a) voice "what did you do yesterday" → tool runs → `recall_result` → panel opens; (b) manual: a small "history" affordance on the console / a hotkey → sends `recall_query`.
- **Models:** `RecallModel(@Published day, label, digest, items:[RecallItem])`; `RecallItem{at, lane, title, detail, status, tool}`. `HUDState.recallOpen/recallDay`.
- **Decode:** `DaemonClient.apply` gains a `recall_result` case → populates `RecallModel`. (Unknown-event default-drop means this is additive + safe.)
- Lane icon/color: foreground (blue 💬), background (violet ⚙️), proactive (amber 🔔); failed rows amber with the error as a sub-line. Reuses the glass-pill styling + spring from `HUDState`.

## Phases (each shippable, TDD, `KAIROS_ACTIVITY` flag default on)
| # | Deliverable | Files |
|---|---|---|
| 1 | `dayKey` / `resolveWhen` time util | new `daemon/util/timeRange.ts` |
| 2 | `ActivityStore` (+ table, record, query+union, digest, prune) | new `daemon/activity/activityStore.ts` |
| 3 | `ActivityRecorder` wiring (conductor + appendTraj hook) | `agents/conductor.ts`, `index.ts` |
| 4 | `kairos_activity` tool + relabel/repoint the broken tools + **regression test** | `agents/introspectionTools.ts`, `index.ts` |
| 5 | WS `recall_query`→`recall_result` feed | `index.ts`, `wrapApi/server.ts` |
| 6 | HUD Recall panel (Swift) | `apps/macos/KairosHUD/...` |
| 7 *(opt)* | Backfill from `turns.jsonl` + `subagents.jsonl` | one-shot importer |

## Acceptance regression test (the gate)
Seed `activity_events` with: an action (sent email, yesterday), a subagent run (yesterday), a chitchat-only turn (yesterday), and an action from 3 days ago. `kairos_activity({when:'yesterday'})` must return the email + the subagent run (with the real titles), **exclude** the chitchat and the 3-days-ago item, and the digest must count them — i.e. real actions, **not** "167 routine events". Plus unit tests: `resolveWhen('yesterday')` boundaries in tz; `ActivityStore` round-trip + autonomous union (try/catch on missing tables); recorder skips chitchat / records writes.

## Production-readiness
- Recording = one INSERT, **off the hot path** (after TTS).
- **Privacy:** titles/refs only, **never bodies**; secret-sanitized; retention prune (90d default); respects `KAIROS_TZ`.
- **Resilience:** per-table try/catch in the union (lazy/missing tables never break recall).
- Feature-flagged (`KAIROS_ACTIVITY`); additive migration; unknown WS events safely ignored by the HUD.
