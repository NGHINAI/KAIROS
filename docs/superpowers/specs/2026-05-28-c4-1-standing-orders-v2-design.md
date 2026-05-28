# Phase C.4.1 — STANDING_ORDERS v2 + Time-Triggered Rules

**Status:** design approved 2026-05-28
**Author:** Nirmal Ghinaiya
**Scope:** structural refactor of the standing-orders subsystem. Persona-conditioned routing, offline LLM-free English parsing, and the Phase C overall validation gate are deferred to C.4.2.

---

## 1. Why v2

v1 (Phases B and C.1) introduced `~/.kairos/STANDING_ORDERS.md` as plain English bullets that get LLM-compiled into opaque SQLite triggers. It works for the simple cases and we keep it running on every daemon today, but it has six concrete limits:

| v1 problem | What it means in practice | v2 fix |
|---|---|---|
| Non-deterministic LLM compilation | The same English rule may compile to slightly different triggers on different runs. Hash-gated recompile hides drift only until the source changes. | The structured DSL form is the canonical representation. Structured input passes through unchanged. English input is compiled once and the result is written back to the file. |
| No per-rule cooldowns | Global `default_trigger_cooldown_sec` only. You cannot say "this specific rule fires at most once per hour." | Each rule has its own `cooldown:` field (`"20h"`, `"5m"`, `"30s"`). |
| No chaining | Rule A cannot trigger rule B. Multi-step flows must be skills. | Rules emit named events; other rules listen via `when: event 'name'`. |
| No time-triggered rules | "Every Monday at 9am" cannot be expressed; only state-triggered rules exist. | `when: cron: "..."` or `when: at: "5pm"` registers with the existing `ScheduleManager`. |
| Rule edits require manual file edits | User has to open the file in a text editor to change anything. | KAIROS appends/updates the file when you speak the change. The file becomes an audit record, not a workflow. |
| LLM-down breaks rule editing | If the LLM API is unreachable, even a one-character edit cannot recompile. | Structured-form rules need no LLM. Only English-to-structured needs the LLM. (Offline English parsing comes in C.4.2.) |

A seventh, less-visible win: **the file IS the structured form**. What you see in `STANDING_ORDERS.md` after KAIROS writes it is exactly what runs. No hidden SQLite divergence.

## 2. Non-goals (explicitly out of scope for C.4.1)

- Persona-conditioned routing wired into `RestraintPipeline` — partial via `persona.X` conditions in `if`/`unless`; deeper integration is C.4.2
- Offline LLM-free **English** parsing — only structured-form parsing is offline in C.4.1
- Phase C overall validation gate and the `v0.4.0` tag — C.4.2 owns the gate

These are explicit non-goals so reviewers don't expect them in the C.4.1 PR.

## 3. Architecture

```
                           ┌─────────────────────────────────┐
   user speech ────────►   │ OrdersAuthor (NEW)              │
   (Discord / voice /      │  - LLM compiles English → rule  │
    kairos_tell)           │  - finds-or-creates by intent   │
                           │  - appends to STANDING_ORDERS.md │
                           └────────────────┬────────────────┘
                                            │
                                            ▼
                           ┌─────────────────────────────────┐
   STANDING_ORDERS.md ───►│ OrdersParser (NEW, replaces v1)  │
   (fs.watch, 200ms        │  - parses YAML frontmatter      │
    debounce, hot reload)  │  - validates schema             │
                           └────────────────┬────────────────┘
                                            │
                                            ▼
                           ┌─────────────────────────────────┐
                           │ OrdersStore (NEW SQLite tables)  │
                           │  rules, rule_state, rule_events  │
                           └───────┬────────────────┬────────┘
                                   │                │
              state-triggered      │                │  time-triggered
                                   ▼                ▼
           ┌───────────────────────────────┐  ┌──────────────────────┐
           │ ReactiveEvaluator (NEW)       │  │ ScheduleManager      │
           │  - subscribes to perception   │  │ (existing, reused)   │
           │  - matches when/if/unless     │  │  - registers cron/at │
           │  - emits a fire request       │  │  - setTimeout to ms  │
           └─────────────┬─────────────────┘  └──────────┬───────────┘
                         │                                │
                         └──────────────┬─────────────────┘
                                        ▼
                           ┌─────────────────────────────────┐
                           │ ActionDispatcher (NEW thin layer)│
                           │  routes to:                      │
                           │  - IntentRegistry  (built-ins)   │
                           │  - SkillDispatcher (C.3.3)       │
                           │  - ComposioClient  (C.2.7)       │
                           │  - EventBus        (emit_event)  │
                           └────────────────┬────────────────┘
                                            │
                                            ▼
                                  TrajWriter records
                                  (per existing C.3.1 pattern)
```

**Unit boundaries (what + how + dependencies):**

- **OrdersAuthor** — accepts speech, calls LLM with `task_type: 'orders_compose'`, dedups against existing rules by intent-similarity, writes to file. Depends on `ModelRouter`, `OrdersStore`, `OrdersParser`.
- **OrdersParser** — pure function: YAML frontmatter → typed rule objects. Depends on nothing but the `yaml` package already in the repo.
- **OrdersStore** — SQLite CRUD over three tables. Depends on `bun:sqlite`.
- **ReactiveEvaluator** — subscribes to the existing perception bus (`bus.subscribe('*')`); evaluates state-triggered rules. Depends on `OrdersStore`, perception `EventBus`.
- **ScheduleManager extension** — register/unregister rules by id; existing class gets two new methods. Depends on `cronParser.ts` (already in repo).
- **ActionDispatcher** — switch over `action.type`, routes to the right subsystem. Depends on `IntentRegistry`, `SkillDispatcher`, `ComposioClient`, `EventBus`.
- **EventBus** (rules-scoped, NOT the perception bus) — small typed pub/sub for rule chaining. Pure, in-process, with `${...}` variable interpolation.

Each unit fits in one file <300 LOC. Tests independently. No circular dependencies — the graph flows top-down except for the chaining loop (ActionDispatcher → EventBus → ReactiveEvaluator) which is the intended async event edge.

## 4. DSL — rule shape

Each rule is one YAML frontmatter block in `STANDING_ORDERS.md`, separated by `## <slug>` headers. The slug is the rule's stable identifier; it never changes once assigned. The English description below the frontmatter is the human-readable record of how the rule came to be.

```markdown
## morning-brief
---
schema_version: 1
when:
  cron: "0 8 * * 1-5"        # weekdays 8am
unless:
  - persona.is_in_meeting
do:
  - action: invoke_skill
    args:
      slug: morning-brief
      args:
        lookback_hours: 24
cooldown: 20h
dry_run_until: 2026-05-29T08:00:00Z   # auto-set by daemon; cleared after approval
state: dry_run                          # pending | active | suspended | dry_run | legacy
created_by: voice                       # voice | manual | crystallized | migrated_v1
created_at: 2026-05-28T14:30:00Z
---
You said: "every weekday at 8am draft a morning brief, skip if I'm in a meeting"
```

**Schema (TypeScript-style, normative):**

```typescript
type Rule = {
  schema_version: 1                   // bump on breaking DSL changes; parser refuses unknown versions
  slug: string                        // matches the `## <slug>` header; kebab-case, [a-z0-9-]+
  when: When                          // exactly one of cron, at, event, state
  if?: Condition[]                    // ALL must be true to fire
  unless?: Condition[]                // ANY true => skip
  do: Action[]                        // executed in order, sequentially
  cooldown?: Duration                 // e.g. "20h", "5m", "30s", "1d"
  dry_run_until?: ISOTimestamp        // rule fires silently to log until this time
  state: 'pending' | 'active' | 'suspended' | 'dry_run' | 'legacy'
  created_by: 'voice' | 'manual' | 'crystallized' | 'migrated_v1'
  created_at: ISOTimestamp
}

type When =
  | { cron: string }                  // standard 5-field
  | { at: string }                    // "5pm", "in 2 hours", absolute ISO
  | { event: string }                 // named event from another rule
  | { state: StateSelector }          // matches perception world state

type StateSelector =
  | { clipboard: { contains?: string; is_url?: boolean } }
  | { focus_app: { equals?: string; in?: string[] } }
  | { calendar: { event_starts_in?: Duration } }
  | { file_events: { path_matches?: string } }     // glob
  | { browser_tabs: { opened?: boolean } }
  | { pattern: { repeats: number; window: Duration; same?: 'file' | 'app' | 'url' } }

type Condition =
  | `persona.${string}`               // e.g. "persona.is_in_meeting"
  | `time.${string}`                  // e.g. "time.between('22:00','07:00')"
  | `payload.${string} == ${literal}` // for event-triggered rules
  | `${string} != ${literal}` | `${string} > ${number}` | ...   // simple comparisons

type Action =
  | { action: 'notify' | 'remind_later' | 'add_to_memory' | 'log' | 'suspend', args: object }
  | { action: 'invoke_skill', args: { slug: string, args?: object } }
  | { action: 'composio_tool', args: { toolkit: string, tool: string, args: object } }
  | { action: 'emit_event', args: { name: string, payload?: object } }
```

**Serialization note:** `dry_run_until` and `created_at` are ISO-8601 strings in the file (human-editable) and ms-epoch integers in SQLite (efficient comparison). `OrdersParser` converts file → in-memory `Rule`; `OrdersStore` converts in-memory → SQL. The in-memory `Rule` uses ms-epoch numbers, so all evaluator code sees integers.

**Condition evaluator:** `if` and `unless` strings are parsed by a small **safe expression evaluator** (no `eval()`, no arbitrary code). Supported forms:
- Bare identifier reference: `persona.is_in_meeting` → looks up boolean on the live persona state
- Comparison: `payload.importance == 'high'`, `persona.current_hour > 9`
- Function call from a fixed allowlist: `time.between('22:00','07:00')`, `payload.X.includes('urgent')`
- Logical ops: `&&`, `||`, `!`

Any token outside this grammar fails parsing and the rule is logged + skipped (not silently treated as true/false).

**Validation rules (enforced by OrdersParser):**

1. `slug` matches `^[a-z0-9][a-z0-9-]{0,63}$` and equals the `## <slug>` header value
2. `when` has exactly one of {cron, at, event, state}
3. `cron` is parseable by `cronParser.ts` (`isValidCronExpr` already exists)
4. `at` is parseable by `cronParser.ts` (`parseRelativeTime` or absolute ISO)
5. `cooldown` matches `^\d+(s|m|h|d)$`
6. `do` is non-empty
7. Action `args` is shape-checked per action type (no missing required fields)
8. `state` is one of the five listed values

Parse failures are non-fatal at the file level: bad rule is logged + skipped; other rules continue. This matches the v1 behavior of "one bad rule doesn't break the file."

## 5. Input pipeline — how rules get authored

```
user says: "remind me every Monday at 9 to send the standup"
       │
       ▼
   kairos_tell  (Discord, voice in Phase D, or direct MCP call)
       │
       ▼
   OrdersAuthor.handleSpeech(text)
       │
       ├─► LLM (task_type 'orders_compose', mid tier) returns:
       │     {
       │       proposed_rule: {
       │         when: { cron: "0 9 * * 1" },
       │         do: [{ action: "notify", args: { message: "send standup" }}]
       │       },
       │       slug_suggestion: "monday-standup-reminder",
       │       similar_existing: null,        // or slug if dedup found one
       │       confidence: 0.9
       │     }
       │
       ▼
   If `similar_existing` !== null → ask via existing inbox surface:
     "Update existing rule 'monday-standup-reminder', or create new?"
   Else: append rule block to STANDING_ORDERS.md with:
     state: 'dry_run', dry_run_until: now + 24h, created_by: 'voice'
       │
       ▼
   OrdersParser hot-reload (200ms debounce) → OrdersStore upsert
   → ScheduleManager.register (if when.cron|at) or ReactiveEvaluator picks up
       │
       ▼
   24h later → daemon adds inbox item:
     "Rule 'monday-standup-reminder' would have fired N times.
      Sample: [09:00 last Monday]. Approve to go live?"
```

**Dedup decision (OrdersAuthor):** the LLM is asked to compare the proposed rule against existing rule slugs + descriptions and either name a match or return null. We don't do embedding similarity at this layer — the LLM is already mid-tier and can read 10-20 rule names cheaply.

## 6. Evaluator — how rules fire

**State-triggered path (replaces v1's reactive path):**

- `ReactiveEvaluator` subscribes to the perception event bus (`src/daemon/perception/`)
- On each event, it queries `OrdersStore.listActiveByWhenKind('state')` and evaluates each rule's `when.state` selector against the event payload
- For matching rules: evaluate `if` and `unless` predicates against current `PersonaAwareness.getLiveState()` + the event payload
- Check `cooldown`: query `rule_state.last_fired_at`, skip if `now - last_fired_at < cooldown_ms`
- If all checks pass → call `ActionDispatcher.dispatch(rule, { trigger: eventPayload })`

**Time-triggered path (new):**

- On rule load: `ScheduleManager.registerRule(rule.id, rule.when)` — wraps the existing `parseSchedule` and `scheduleNext` helpers
- The scheduler computes the exact next-fire millisecond and arms a `setTimeout`
- At fire time: scheduler calls back into `OrdersStore.getRule(id)`, evaluates `if`/`unless` predicates (live persona check), checks cooldown
- If pass → `ActionDispatcher.dispatch(rule, { trigger: { fired_at: now } })`
- For cron rules: re-schedule next occurrence. For `at:` rules: mark `state='active' → 'suspended'` (one-shot)

**Both paths funnel into `ActionDispatcher.dispatch(rule, context)`** — one place where all firings happen.

## 7. Chaining via named events

Multi-step flows compose by emitting and listening for events:

```yaml
## classify-invite
when:
  state: { calendar: { event_starts_in: "1h" } }
do:
  - action: invoke_skill
    args:
      slug: classify-calendar-invite
  - action: emit_event
    args:
      name: invite_classified
      payload:
        importance: "${skill_output.importance}"
        invite_id: "${trigger.invite_id}"

## draft-important-invite-response
when:
  event: invite_classified
if:
  - "payload.importance == 'high'"
do:
  - action: invoke_skill
    args:
      slug: draft-invite-response
      args: { invite_id: "${payload.invite_id}" }
```

**Variable interpolation grammar (`OrdersInterp`):**
- `${trigger.X}` — the firing trigger's data (event payload, scheduled fire timestamp, perception event)
- `${payload.X}` — for `when: event` rules, the event payload
- `${skill_output.X}` — result of the previous action in the same `do:` chain
- `${persona.X}` — current PersonaAwareness state
- Interpolation is resolved at action-dispatch time; missing keys interpolate to empty string and log a warning

**EventBus shape:**
```typescript
class RulesEventBus {
  emit(name: string, payload: object): void   // O(listeners)
  on(name: string, handler: (payload) => void): void
  off(name: string, handler): void
}
```
In-process only. Not persisted. If the daemon restarts mid-chain, the chain is broken — by design, since events represent transient signals.

## 8. Dry-run integration

Reuses the existing `DryRunMode` infrastructure (already in `src/daemon/restraint/`). New wiring:

- A rule with `dry_run_until > now` causes `ActionDispatcher` to short-circuit: instead of routing to the real subsystem, it writes a row to `rule_state` with `mode='dry_run'`, the would-be action, and the inputs
- After 24h, a daemon timer aggregates dry-run fires per rule and surfaces an inbox prompt with stats:
  - "Rule X would have fired N times in 24h"
  - Sample fire times (up to 3)
  - "Approve to go live" / "Tune cooldown" / "Reject"
- On approve: `dry_run_until = null`, `state = 'active'`, file is updated in place
- On reject: `state = 'suspended'`, file is updated to record reason

**Manual opt-out:** user can say "fire 'morning-brief' immediately" and OrdersAuthor will set `dry_run_until: null` directly. This is the explicit-trust path.

## 9. Migration from v1

The v1 subsystem (`src/daemon/orders/`: parser, compiler, runtime) stays in place. C.4.1 adds the v2 subsystem alongside, in `src/daemon/orders/v2/`. Both are wired at boot, gated by `config.orders.v2_enabled` (default `true` for new installs, but flag-readable).

- v1 `compiled_orders_triggers` table is preserved. On first v2 boot, daemon marks every existing row as `state='legacy'` in a parallel v2 view.
- Legacy rules continue to fire through the v1 evaluator until the user runs `kairos migrate-orders-v1`.
- The migration command re-runs each v1 rule through the LLM (task_type `orders_compose`) to produce a v2 rule. Writes the result to `STANDING_ORDERS.md` with `state: 'dry_run'`, `created_by: 'migrated_v1'`, original v1 rule preserved in the description body. User reviews the file.
- Once user confirms migration is good, the v1 row is marked `state='retired'` and the v1 evaluator stops firing it. No silent data loss: the v1 row stays in the table for forensic inspection.

The migration command is a Bun script: `scripts/migrate-orders-v1.ts`. It is interactive and run-once per install. It is not part of C.4.1's mandatory daemon boot path.

## 10. Storage — new SQLite tables

```sql
CREATE TABLE IF NOT EXISTS orders_rules (
  slug          TEXT PRIMARY KEY,
  when_kind     TEXT NOT NULL,         -- 'cron' | 'at' | 'event' | 'state'
  rule_json     TEXT NOT NULL,         -- the full parsed Rule object, JSON
  state         TEXT NOT NULL,         -- pending | active | suspended | dry_run | legacy
  dry_run_until INTEGER,               -- ms epoch or NULL
  cooldown_ms   INTEGER,
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_when_kind ON orders_rules(when_kind);
CREATE INDEX IF NOT EXISTS idx_orders_state ON orders_rules(state);

CREATE TABLE IF NOT EXISTS orders_rule_state (
  slug            TEXT PRIMARY KEY,
  last_fired_at   INTEGER NOT NULL DEFAULT 0,
  fire_count      INTEGER NOT NULL DEFAULT 0,
  last_dry_run_at INTEGER NOT NULL DEFAULT 0,
  dry_run_count   INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  FOREIGN KEY (slug) REFERENCES orders_rules(slug) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS orders_dry_run_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT NOT NULL,
  fired_at    INTEGER NOT NULL,
  would_do    TEXT NOT NULL,           -- JSON: the Action array that would have run
  trigger_ctx TEXT,                    -- JSON: the trigger payload
  FOREIGN KEY (slug) REFERENCES orders_rules(slug) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_dry_run_slug_time ON orders_dry_run_log(slug, fired_at);
```

`OrdersStore` is the only writer of these tables. `OrdersParser` produces typed `Rule` objects; `OrdersStore.upsert(rule)` serializes to `rule_json` and updates the indexed columns.

## 11. Daemon wire-up

In `src/daemon/index.ts`, after the C.3.3 skills subsystem block, add a new block gated by `config.orders.v2_enabled !== false`:

```typescript
const ordersStore = new OrdersStore(db)
const ordersParser = new OrdersParser()
const ordersAuthor = new OrdersAuthor({ router, ordersStore, ordersParser, filePath })
const rulesBus = new RulesEventBus()
const actionDispatcher = new ActionDispatcher({
  intentRegistry, skillDispatcher, composioClient, rulesBus,
})
const reactiveEvaluator = new ReactiveEvaluator({
  perceptionBus: bus, ordersStore, actionDispatcher, personaAwareness,
})
const scheduleManagerExt = new ScheduleManagerOrdersAdapter(scheduleManager, ordersStore, actionDispatcher)

// Hot-reload from file
const fileWatcher = watchOrdersFile(filePath, debounce200ms(() => {
  const rules = ordersParser.parseFile(filePath)
  ordersStore.replaceAll(rules)
  scheduleManagerExt.refreshAll()
}))

// Initial load
ordersParser.parseFile(filePath).forEach(r => ordersStore.upsert(r))
scheduleManagerExt.refreshAll()
```

Shutdown: stop file watcher; unregister all schedule entries.

## 12. Test strategy

Per the user's directive ("every feature added in this should be tested, and if it works, means it's good"), ~80 unit tests + a 14-assertion validation gate.

**Unit tests (TDD per task):**

| Component | Tests | Coverage |
|---|---:|---|
| OrdersParser | 12 | YAML edge cases, validation errors, schema fields, bad-rule skip behavior, multi-rule files |
| OrdersStore | 8 | CRUD, dry_run state, lifecycle transitions, parallel reads |
| ReactiveEvaluator | 12 | state matching for all 6 selectors, cooldowns, if/unless precedence, persona condition evaluation |
| ScheduleManagerOrdersAdapter | 8 | cron registration, at: parsing, one-shot vs recurring, re-schedule on cron fire |
| ActionDispatcher | 10 | routing to all 4 action types, error handling, variable interpolation |
| OrdersAuthor | 10 | LLM compose, similar-existing dedup, file append, slug collision, English→DSL round-trip |
| RulesEventBus | 6 | emit/listen, payload propagation, ${interp}, missing-key warnings |
| DryRun integration | 8 | 24h gate, fire-to-log, approval flow, manual opt-out |
| Inbox prompt builder | 6 | aggregation, sample selection, edge cases (0 fires, >100 fires) |
| **Total** | **80** | |

**Validation gate (`scripts/validate-phase-c4-1.ts`) — 14 assertions:**

1. OrdersParser accepts a valid rule + rejects each invalid case (slug, when, action shape)
2. OrdersStore upsert + replaceAll round-trip via SQLite
3. ReactiveEvaluator fires a state-triggered rule end-to-end
4. ReactiveEvaluator skips a rule whose `unless` predicate is true
5. ScheduleManagerOrdersAdapter fires a `cron: "* * * * *"` rule within 60s
6. ScheduleManagerOrdersAdapter fires an `at: "in 2 seconds"` rule within 3s
7. ActionDispatcher routes `invoke_skill` to a fixture skill via SkillDispatcher
8. ActionDispatcher routes `emit_event` and a listening rule fires
9. RulesEventBus interpolates `${payload.X}` correctly
10. Dry-run rule fires to log instead of executing the action
11. After 24h dry-run window (faked via clock injection), inbox prompt is built
12. Cooldown enforcement: rule fires once, immediately re-evaluates, gets skipped
13. OrdersAuthor speech-to-rule round trip with fake router (produces valid DSL block)
14. End-to-end: speech → OrdersAuthor → file → OrdersParser → OrdersStore → ScheduleManager → ActionDispatcher → fixture skill → UsageTracker.use_count == 1

Validation gate must verdict PASS before tagging `v0.3.8-phase-c4-1`.

## 13. Risks and mitigations

1. **DSL drift over time** — as we add features (e.g., new state selectors), older rules might break. Mitigation: every rule carries an explicit `schema_version: 1` field added in C.4.1 from day one. Parser refuses unknown versions instead of silently misinterpreting.
2. **OrdersAuthor LLM cost** — every speech input costs an LLM call. Mitigation: mid-tier (gemini-2.5-flash) is ~$0.0001/call; cap is irrelevant in practice. Cache identical English → same rule.
3. **Chaining loops** — rule A emits event X, rule B listens to X and emits Y, rule A listens to Y. Mitigation: per-dispatch loop counter; ActionDispatcher refuses to recurse past N=10 hops in one trigger chain. Logged as `chain_loop_detected`.
4. **File-vs-DB drift** — user edits the file mid-flight, daemon reloads, but a fire was in progress. Mitigation: fires take a snapshot of the rule at dispatch time; file reloads don't affect in-flight fires.
5. **v1 ↔ v2 double-fire** — if a v1 rule and a v2 rule cover the same intent, both fire. Mitigation: migration command marks v1 row as `retired` once user approves the v2 form. Pre-migration, this is a known acceptable risk during the migration window.
6. **Cron clock skew** — `setTimeout` accuracy on macOS while suspended can drift. Mitigation: existing `ScheduleManager` already handles this with a recompute on resume; we inherit it for free.

## 14. Deferred to C.4.2

- Persona-conditioned routing wired into `RestraintPipeline` (deeper than just `persona.X` conditions in `if`/`unless`)
- Offline LLM-free English parsing (regex + keyword fallback)
- Phase C overall validation gate covering C.1 + C.2 + C.3 + C.4 end-to-end
- Tag `v0.4.0` (the Phase C completion tag)

---

End of design.
