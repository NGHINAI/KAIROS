# Phase C.4.2 — Persona-Routing + Composio Wiring + Phase C Validation Gate

**Status:** design approved 2026-05-28
**Author:** Nirmal Ghinaiya
**Scope:** finish what C.4.1 deferred. Wire real Composio tool execution, make RestraintPipeline persona-aware (threshold-shifting only), add a pending-edits queue for offline LLM, and prove Phase C works end-to-end via a simulated 4-hour user-session gate. Tag `v0.4.0` after PASS.

---

## 1. Goals

| Gap from C.4.1 | C.4.2 fix |
|---|---|
| `ActionDispatcher` stubs the `composio_tool` action — returns "wired in C.4.2" | Real `composioClient.executeTool()` call via a new `ComposioToolResolver` that maps friendly names to exact Composio toolNames |
| `RestraintPipeline` accepts `PersonaAwareness` but never reads it when scoring | Persona hints shift the interrupt / surface / digest thresholds at score time. Rules in `if`/`unless` already could read persona — now the *pipeline itself* does too |
| `OrdersAuthor.handleSpeech()` returns an error when the LLM is unreachable | Pending-edits queue persists failed edits; daemon retries every 5 minutes; user sees "lost rule" inbox alert after max retries |
| No proof that C.1 + C.2 + C.3 + C.4 work together as one product | New `scripts/validate-phase-c.ts` runs a simulated 4-hour user session with 30 cross-subsystem assertions |
| Phase C never tagged as a milestone | `v0.4.0` annotated tag created after the gate PASSes |

## 2. Non-goals

- C.3.2 — OpenAI Agents SDK multi-agent orchestrator (separate phase)
- Phase D / E / F (voice, speech, HUD)
- LLM fuzzy fallback when the resolver misses — if `{toolkit, tool}` doesn't resolve, return an error; don't guess
- Migration script for v1 standing-orders (still deferred — both v1 and v2 keep running side-by-side)
- Offline LLM-free *English* parsing (replaced by pending-edits queue at user request — much simpler design)

## 3. Architecture

```
                              ┌──────────────────────────────┐
   user speech ────────────►  │ OrdersAuthor (MODIFIED)       │
                              │  on LLM error → enqueue       │
                              └──────────────┬───────────────┘
                                             │
                          LLM ok             │       LLM unreachable
                          ┌──────────────────┴──────────┐
                          ▼                             ▼
                  STANDING_ORDERS.md          ┌─────────────────────────┐
                  (existing path)             │ PendingEditsQueue (NEW) │
                                              │  SQLite-backed          │
                                              │  retry every 5 min      │
                                              │  surfaces on max retries│
                                              └─────────┬───────────────┘
                                                        │
                                                  on retry success
                                                        │
                                                        ▼
                                            (re-enters OrdersAuthor path)

                          ↓ rule fires (Reactive or ScheduleAdapter) ↓

                  ┌────────────────────────────────────┐
                  │ ActionDispatcher (MODIFIED)        │
                  │  composio_tool path:               │
                  │   1. ComposioToolResolver (NEW)    │
                  │       {toolkit, tool} → toolName   │
                  │   2. composio.executeTool()        │
                  │   3. capture output for chaining   │
                  └──────────────┬─────────────────────┘
                                 │ outcome → routes via notify
                                 ▼
                  ┌──────────────────────────────────────┐
                  │ RestraintPipeline (MODIFIED)         │
                  │  - reads PersonaAwareness.getHints() │
                  │  - personaThresholdShift() applied   │
                  │    before mode comparison:           │
                  │      aggressiveness=low   → +0.10    │
                  │      aggressiveness=high  → −0.05    │
                  │      in_focus_now         → +0.05    │
                  │     !active_hours_now     → +0.10    │
                  │    clamp shift to ±0.20              │
                  │  - persona snapshot logged to traj   │
                  └──────────────────────────────────────┘
```

**Unit boundaries:**

- **ComposioToolResolver** — input: `(toolkit, friendly_name)`. Output: exact Composio `toolName` string or null. Owns its cache + daily refresh. Depends on `ComposioClient`.
- **ActionDispatcher composio path** — orchestrates resolver + executeTool. Single responsibility: take a `composio_tool` Action, dispatch it, return ActionResult.
- **RestraintPipeline persona shift** — pure function: `(hints, baseThreshold) → effectiveThreshold`. Tested in isolation. Wired into existing scoring step.
- **PendingEditsQueue** — input: failed-speech rows. Output: retried-and-materialized rules. SQLite table. Time-driven processor.
- **Phase C gate** — independent script. No new daemon-side code.

Each unit fits one file <300 LOC. No new circular dependencies.

## 4. Sub-systems

### 4a. ComposioToolResolver (NEW)

**File:** `src/daemon/orders/v2/composioToolResolver.ts`

Resolves friendly `{toolkit, friendly_name}` to Composio's exact `toolName` (e.g. `SLACK_SEND_MESSAGE`).

**Boot behavior:**
1. Calls `composio.tools.list({ toolkits: <connectedToolkitSlugs> })` once at construction
2. For each tool result, indexes under multiple friendly aliases:
   - `SLACK_SEND_MESSAGE` indexed as `slack:send_message` AND `slack:send`
   - `GITHUB_CREATE_ISSUE` indexed as `github:create_issue` AND `github:create`
   - Generic rule: strip the toolkit prefix from the toolName, lowercase, split into words. The last word + each suffix-truncation becomes an alias.
3. Stores the map in-memory; persists a JSON cache at `~/.kairos/composio-tools-cache.json` for warm-boot

**Refresh behavior:**
- Daily timer (`setInterval` 24h) re-runs `tools.list()` and replaces the map
- On any resolve-miss, schedules an immediate refresh (rate-limited to once per hour) — surfaces Composio catalog additions quickly

**API:**
```typescript
class ComposioToolResolver {
  constructor(deps: { composio: ComposioClient; userId: string; cachePath?: string })
  async initialize(): Promise<void>                     // boot — populate map
  resolve(toolkit: string, friendlyName: string): string | null
  async refresh(): Promise<void>
  stop(): void                                          // clear timer
}
```

**Action dispatch integration:**
ActionDispatcher's `composio_tool` branch (replacing the C.4.1 stub):
```typescript
const toolName = resolver.resolve(args.toolkit, args.tool)
if (!toolName) throw new Error(`could not resolve composio tool '${args.toolkit}:${args.tool}'`)
const result = await composio.executeTool({ toolName, userId: 'local', arguments: args.args })
skill_output_raw = result   // available for chaining
```

### 4b. Persona-conditioned routing (MODIFY RestraintPipeline)

**File:** `src/daemon/restraint/restraintPipeline.ts`

Add a pure helper next to the scoring step:

```typescript
/** Returns a delta to apply to interrupt/surface/digest thresholds.
 *  Positive = harder to interrupt the user. Clamped to ±0.20. */
export function personaThresholdShift(hints: PersonaHints | null): number {
  if (!hints) return 0
  let shift = 0
  if (hints.interrupt_aggressiveness === 'low')  shift += 0.10
  if (hints.interrupt_aggressiveness === 'high') shift -= 0.05
  if (hints.in_focus_now)                        shift += 0.05
  if (!hints.active_hours_now)                   shift += 0.10
  return Math.max(-0.20, Math.min(0.20, shift))
}
```

Wired in at the existing `evaluate()` step that compares the action's score against thresholds:

```typescript
const hints = this.deps.personaAwareness?.getHints() ?? null
const shift = personaThresholdShift(hints)
const interruptT = this.deps.config.interrupt_threshold + shift
const surfaceT   = this.deps.config.surface_threshold   + (shift * 0.5)
const digestT    = this.deps.config.digest_threshold    + (shift * 0.25)
```

(Smaller proportional shifts on surface/digest so the entire distribution moves up under persona pressure without collapsing modes.)

Each routing decision records the persona snapshot used → `DeliveryDecision.persona_snapshot` → TrajWriter captures it → makes the persona-influence auditable on review.

### 4c. PendingEditsQueue (NEW)

**File:** `src/daemon/orders/v2/pendingEdits.ts`

SQLite table:
```sql
CREATE TABLE IF NOT EXISTS orders_pending_edits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  speech TEXT NOT NULL,
  enqueued_at INTEGER NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER NOT NULL,
  last_error TEXT,
  status TEXT NOT NULL DEFAULT 'pending'  -- pending | failed | done
);
CREATE INDEX IF NOT EXISTS idx_pending_status ON orders_pending_edits(status, next_retry_at);
```

**OrdersAuthor changes:**
- Wraps the LLM call in try/catch
- On catch (or if `parsed?.proposed_rule` is missing): enqueue with `retry_count=0`, `next_retry_at = now + 5min`
- Returns `{ created_slug: null, queued_for_retry: true }`

**PendingEditsProcessor (new):**
- Timer every 5 minutes
- Selects rows where `status='pending' AND next_retry_at <= now`
- For each: calls `OrdersAuthor.handleSpeechDirect(speech)` (a new internal method that bypasses the queue-on-fail path)
- Success → row deleted (or `status='done'`)
- Fail → `retry_count++`, `last_error` updated, `next_retry_at = now + (5min × 2^retry_count)` (exponential backoff capped at 1h)
- After `retry_count >= 10` → `status='failed'`, surfaces an inbox alert: "I tried to create a rule from your speech 10 times but the LLM kept failing. Here's what you said: ..."

**Cap:** if `count(pending) > 50`, drop the oldest pending and add a one-time inbox alert.

### 4d. Phase C overall validation gate

**File:** `scripts/validate-phase-c.ts`

Simulated 4-hour user-session script. Wall clock runs in <60 seconds via injected clock + immediate timer fires. ~30 assertions span every Phase C subsystem and prove the cross-subsystem flows actually work.

**Scenario script:**

```
T+00:00  Boot daemon with fresh ephemeral home dir, in-memory DB, fake router,
         fake composio client. All C subsystems initialize.
         Assertions (3):
         - all subsystems start without error
         - SoulLoader has BASELINE_BOUNDARIES loaded
         - OrdersStore exists with empty rules table

T+00:05  User speaks "remind me at 3pm to send the standup"
         Assertions (4):
         - OrdersAuthor compiles via fake router
         - rule block appended to STANDING_ORDERS.md
         - OrdersStore has rule slug 'standup-reminder'
         - ScheduleAdapter armed with cron/at for 3pm

T+00:10  Clipboard event "urgent: please review PR #42"
         Assertions (1):
         - no rule matches yet, no fire

T+00:15  User speaks "if clipboard has 'urgent', ping me"
         Assertions (1):
         - rule created in dry-run window (state='dry_run')

T+00:20  Re-fire clipboard event "urgent: another PR"
         Assertions (2):
         - rule matched
         - fire routed to dry_run_log (NOT to actual notify intent)

T+01:00  Persona Dreaming light cycle runs
         Assertions (2):
         - DreamingExtension processed trajectories
         - persona.md updated (token cap respected)

T+02:00  PersonaAwareness reports in_focus_now=true.
         Inject an ActionRequest with score 0.82, base interrupt_threshold=0.80.
         Without persona shift this would route 'interrupt' (0.82 >= 0.80).
         Assertions (2):
         - personaThresholdShift returns +0.05 for in_focus_now
         - effective threshold becomes 0.85; action 0.82 < 0.85 routes to 'surface'

T+02:30  Rule fires composio_tool { toolkit: 'slack', tool: 'send_message' }
         Assertions (2):
         - resolver finds SLACK_SEND_MESSAGE
         - fake composio.executeTool called with correct toolName

T+02:35  Simulate LLM down. User speaks "remind me every Friday to summarize"
         Assertions (2):
         - OrdersAuthor returns { queued_for_retry: true }
         - PendingEditsQueue has 1 row, retry_count=0

T+02:40  Simulate LLM back. PendingEditsProcessor runs.
         Assertions (2):
         - row processed: status='done' or row deleted
         - rule materialized in OrdersStore

T+03:00  AwmWorker discovers traj pattern (≥3 successful trajectories with same intent)
         Crystallizer composes a skill (fake router returns valid SkillFile)
         PersonaGate auto-promotes (GREEN tier)
         Assertions (3):
         - candidate found
         - skill written to ~/.kairos/skills/<slug>/SKILL.md
         - SkillRegistry has new skill, listed in active metadata

T+03:30  STANDING_ORDERS rule invokes the newly-crystallized skill via invoke_skill action
         Assertions (2):
         - SkillDispatcher routes to the right runner
         - action recorded in TrajWriter

T+04:00  Daemon shutdown
         Assertions (4):
         - AwmWorker stopped
         - Curator timer cleared
         - file watcher closed
         - ScheduleAdapter timers cleared (no leaks)

TOTAL: 30 assertions
```

Each assertion: `try { ... record(true, label) } catch (e) { record(false, label + ': ' + e.message) }`. Verdict = all 30 PASS.

## 5. Storage / Config changes

- New SQLite table: `orders_pending_edits` (defined above)
- New optional config field `orders.pending_retry_interval_ms` (default 5min) and `orders.pending_max_retries` (default 10)
- New optional config field `composio.tool_resolver_cache_path` (default `~/.kairos/composio-tools-cache.json`)
- `RestraintConfig` unchanged — persona shifts live in-code, not in config

## 5b. Regression strategy

Every C.4.2 task that touches existing code follows this discipline:

1. **Pre-task baseline:** run `bun test` and ALL existing `scripts/validate-phase-*.ts` gates. Record pass counts.
2. **Post-task verification:** rerun the same suites; confirm no regression. The commit message includes `regression: X gates pass, Y unit tests green`.
3. **Files most at risk for regression:**
   - `src/daemon/restraint/restraintPipeline.ts` — persona shift mod must not change scoring behavior in existing tests
   - `src/daemon/orders/v2/actionDispatcher.ts` — composio_tool path replaces the C.4.1 stub; all 8 existing tests must still pass
   - `src/daemon/orders/v2/author.ts` — pending-queue integration must not break the 6 happy-path tests
   - `src/daemon/orders/v2/store.ts` — new table addition; existing CRUD tests must still pass

**Pre-merge sweep (before tagging v0.4.0):** all 10 gates run consecutively + full `bun test` suite. Any FAIL blocks tag. Specifically:
- `validate-phase-b.ts`, `validate-phase-c1.ts`, `validate-phase-c1-5.ts`, `validate-phase-c2.ts`, `validate-phase-c2-5.ts`, `validate-phase-c2-6.ts`, `validate-phase-c2-7.ts`, `validate-phase-c3-1.ts`, `validate-phase-c3-3.ts`, `validate-phase-c4-1.ts`
- Plus the new `validate-phase-c.ts`

If any FAIL, the failure is fixed before tagging. No "tag now, fix later."

## 6. Test strategy

| Component | Tests |
|---|---|
| ComposioToolResolver | 8 (boot mapping, friendly-name variations, resolve hit/miss, daily refresh fires, on-miss refresh rate-limited, persists cache, warm-boot from cache) |
| ActionDispatcher composio_tool path | 4 new (resolver hit → executeTool, resolver miss → error, executeTool failure → error result, output chained to next action) |
| personaThresholdShift | 6 (low/high aggressiveness, in_focus, !active_hours, no-hints fallback, combined shift clamps at ±0.20) |
| RestraintPipeline integration | 4 new (score-just-below-base-threshold, score-above-base, persona-flips-interrupt-to-surface, persona-snapshot-in-decision) |
| PendingEditsQueue | 8 (enqueue, list pending, process success → done, process retry → backoff, max retries → failed + inbox surfaced, persists across restart, cap 50 drops oldest, exponential backoff) |
| OrdersAuthor pending-queue integration | 4 new (LLM ok → file path; LLM fails → queue path; missing proposed_rule → queue path; handleSpeechDirect bypasses queue) |
| Phase C gate | 30 assertions (end-to-end simulated session) |

**Total: ~40 new unit tests + 30 gate assertions + full regression on all existing gates.**

## 7. Risks and mitigations

1. **Composio `tools.list()` rate-limit** — Mitigation: persist resolver cache to disk; refresh only every 24h; on-miss refresh rate-limited to once per hour.
2. **Persona shift accidentally suppresses urgent items** — Mitigation: urgency-floor path in RestraintPipeline already bypasses scoring; persona shift only affects the score-comparison step.
3. **Pending queue grows unbounded if LLM down for days** — Mitigation: max 50 entries; oldest dropped + surfaced to user.
4. **Phase C gate flakes on real-time delays** — Mitigation: inject clock + use immediate timer fires; wall-clock target <60s for the whole simulation.
5. **Regression in RestraintPipeline tests due to threshold shift defaults** — Mitigation: `personaAwareness` is optional; when null, `shift=0`, existing tests get identical behavior.
6. **Daemon boot time grows due to resolver initialization** — Mitigation: resolver `initialize()` runs in background after daemon ready; first composio_tool dispatch awaits the init promise if needed.

## 8. Tagging plan

After Phase C gate verdicts PASS + all regression suites green:

1. Append `CHANGELOG.md` with the `v0.4.0` entry — summarizes the entire Phase C arc: C.1 (agency + restraint) + C.2 (memory + Composio) + C.3 (persona + AWM skills) + C.4 (standing-orders v2 + persona routing)
2. Commit: `release: Phase C complete — orchestration, persona, skills, standing orders`
3. Tag: `v0.4.0` (no `-phase-c4-2` suffix — this is the first cohesive Phase C release tag)

---

End of design.
