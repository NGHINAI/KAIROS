# Phase C.3.3 — AWM Workflow Crystallization (Self-Improving Skills) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the self-improving loop. KAIROS detects repeating successful patterns in `~/.kairos/traj/YYYY-MM-DD.md`, crystallizes them into reusable SKILL.md files (agentskills.io open standard), executes them via dual sandboxes (Bun Worker for TS, Composio Workbench for Python), tracks per-skill telemetry, and runs a Hermes-style Curator that archives stale skills. After C.3.3 ships, the agent gets measurably better at recurring tasks the longer it runs.

**Architecture:** AWM worker watches `~/.kairos/traj/` (written by TrajWriter, C.3.1). When trajectory clusters meet the induction trigger (Hermes pattern: ≥5 tool calls + success + ≥3 occurrences), the SkillCrystallizer LLM-composes a candidate SKILL.md. Persona Gate runs cosine dedup against existing skills + auto-assigns autonomy tier. Low-tier skills auto-promote; ORANGE/RED queue for human review. Promoted skills land in `~/.kairos/skills/<slug>/SKILL.md` (+ optional `scripts/`, `references/`). Skill Registry hot-reloads — agent discovers skills via progressive disclosure (name+description at boot, body on activation). Executors run skills in sandboxes (Bun Worker for TS, Composio Workbench-enabled session for Python). UsageTracker persists per-skill `.usage.json` (Hermes schema). Curator runs weekly (7d idle-gated): Phase 1 deterministic state transitions (active→stale@30d→archived@90d), Phase 2 LLM consolidation/patching of flagged skills.

**Architecture inspiration (verified May 28, 2026 — research at `docs/research/2026-05-28-phase-c3-3-awm-details.md`):**

| Pattern | Source | Adopted by KAIROS |
|---|---|---|
| `SKILL.md` frontmatter format (name, description, license, compatibility, metadata, allowed-tools) | **agentskills.io** Dec 2025 open standard | Yes — full canonical spec |
| Progressive disclosure (metadata @ boot, body @ activation, scripts on-demand) | **agentskills.io** + **OpenClaw** | Yes — ~100 tokens/skill at boot |
| Skills auto-created after complex tasks (5+ tool calls + success) | **Hermes** | Yes — induction trigger |
| Per-skill `.usage.json` (10 fields: use_count, view_count, last_used_at, etc.) | **Hermes** | Yes — exact port |
| Curator 7d idle-gated cycle | **Hermes** | Yes |
| Curator state machine: active → stale@30d unused → archived@90d unused (file move) | **Hermes** | Yes |
| Curator 2-phase: Phase 1 deterministic + Phase 2 LLM pass | **Hermes** | Yes |
| 6-factor scoring formula | **Hermes** | NO — that's for Dreaming/observations, NOT skills |
| In-flight patching during execution | **Hermes** | NO — does not exist; post-execution flag → next Curator |
| Cosine dedup of candidate skills against existing | **Hermes** (via embeddings) | Yes — reuses Phase C.2.6 LocalEmbedder |
| `output` variable capture (not stdout) | **Composio Workbench** | Yes — mandatory |
| Bun Worker for in-process TS execution | **Bun** | Yes — NOT a security sandbox, relies on human-approval gate |

**User-confirmed scope decisions (2026-05-28):**

| Decision | Choice |
|---|---|
| Induction trigger | "do as Hermes does": ≥5 tool calls + success + ≥3 occurrences |
| Skill execution model | Executable + declarative (both Bun Worker TS + Composio Workbench Python + LLM-interpreted markdown) |
| Skill lifecycle | Hermes Curator: active → stale → archived |
| Validation scope | Every feature tested + comprehensive end-to-end demo |
| `manageConnections` on workbench session | Keep `true` (consistent with main session) |
| Composio CustomTool promotion (stretch) | Out of scope for v1; revisit if MCP support lands |

**Estimated size:** ~3,500 LOC of TypeScript + tests across 14 atomic tasks. Comparable to C.2.5 + C.2.6.

---

## File Structure

```
src/daemon/skills/                            [NEW — entire skill subsystem]
├── types.ts                                  SkillFile, SkillUsage, SkillCandidate, SkillState, AutonomyTier
├── skillMd.ts                                Parse/serialize SKILL.md (agentskills.io spec)
├── skillWriter.ts                            Write SKILL.md + scripts to ~/.kairos/skills/<slug>/
├── skillStore.ts                             SQLite index of skills (slug → metadata for fast boot-time read)
├── usageTracker.ts                           Per-skill .usage.json (Hermes 10-field schema) read/update
├── skillRegistry.ts                          Hot-reloaded list of active skills, progressive disclosure
├── crystallizer.ts                           LLM-composes candidate SKILL.md from trajectory cluster
├── personaGate.ts                            Cosine dedup + autonomy tier + human-review queueing
├── tsRunner.ts                               Bun Worker executor for TS skills (30s timeout)
├── pythonRunner.ts                           Composio Workbench session manager + Python executor
├── skillDispatcher.ts                        Given a skill, picks ts/python/declarative path + executes
├── awmWorker.ts                              Watches ~/.kairos/traj/ → finds clusters → crystallizes → gates
├── curator.ts                                Phase 1 (deterministic state transitions) + Phase 2 (LLM consolidation)
└── reviewQueue.ts                            For ORANGE/RED skills awaiting human approval

src/daemon/                                   [MODIFY]
├── types.ts                                  Add `skills?` config block
├── config.ts                                  Defaults
├── index.ts                                   Wire SkillRegistry → agency layer; start AwmWorker + Curator
└── agency/                                    [MODIFY — agency layer discovers + invokes skills]
    └── intentRegistry.ts                      Skill-invocation intent added
```

**Test files** alongside source as `*.test.ts`.

**Disk layout:**
```
~/.kairos/skills/
├── kairos-skill-index.sqlite           SkillStore: fast metadata lookup
├── kairos-review-queue.sqlite          ReviewQueue: pending human approval
├── <skill-slug>/
│   ├── SKILL.md                        agentskills.io frontmatter + body
│   ├── .usage.json                     Hermes 10-field schema
│   ├── scripts/                        Optional: execute-time scripts
│   ├── references/                     Optional: load-on-demand context
│   └── assets/                         Optional: assets the skill needs
└── .archive/
    └── <skill-slug>/                   Same shape, moved here after 90d unused
```

---

## Task 0: Types + agentskills.io SKILL.md schema

**Files:**
- Create: `src/daemon/skills/types.ts`

```typescript
// src/daemon/skills/types.ts
// Types for the AWM (Agent Workflow Memory) subsystem.
// Follows agentskills.io open standard (Dec 2025) with KAIROS-specific metadata extensions.

import type { AutonomyTier } from '../agency/types'

/** State machine per Hermes Curator: active → stale → archived. */
export type SkillState = 'active' | 'stale' | 'archived' | 'pending_review'

/** Parsed SKILL.md content (agentskills.io spec + KAIROS extensions in metadata). */
export type SkillFile = {
  // ── agentskills.io REQUIRED fields ─────────────────────────
  name: string                            // 1-64 chars, lowercase alphanumeric + hyphens; matches directory name
  description: string                     // 1-1024 chars; explicitly states WHAT and WHEN

  // ── agentskills.io OPTIONAL fields ─────────────────────────
  license?: string                        // SPDX license identifier
  compatibility?: string                  // max 500 chars; environment requirements
  allowed_tools?: string[]                // experimental; space-separated tool IDs
  metadata?: Record<string, string>       // free-form. KAIROS uses this for extensions.

  // ── Loaded from filesystem ──────────────────────────────────
  slug: string                            // = name; also the directory name
  body: string                            // markdown body after frontmatter (full skill instructions)
  dir_path: string                        // absolute path to skill directory
  has_scripts: boolean                    // true if scripts/ dir exists with files
  has_references: boolean                 // true if references/ dir exists
}

/** Hermes `.usage.json` schema — 10 fields exactly. Stored alongside SKILL.md. */
export type SkillUsage = {
  use_count: number                       // invocation count (incremented on each execution)
  view_count: number                      // metadata-only access count (loaded but not invoked)
  last_used_at: number                    // ms epoch, 0 if never
  last_viewed_at: number                  // ms epoch, 0 if never
  patch_count: number                     // times the skill has been patched by Curator
  last_patched_at: number                 // ms epoch, 0 if never
  created_at: number                      // ms epoch when skill first crystallized
  state: SkillState
  pinned: boolean                         // user explicitly pinned — never stale/archive
  archived_at: number                     // ms epoch, 0 if never archived
  // Plus an unofficial flag for Curator scheduling
  curator_review_flag?: boolean           // set true when skill execution fails
  failure_history?: Array<{ ts: number; error: string }>   // bounded to last 5
}

/** A candidate from trajectory analysis, before persona gate / crystallization. */
export type SkillCandidate = {
  cluster_id: string                      // hash of trajectory signature
  trajectories: any[]                     // TrajEntry[] — from C.3.1 TrajWriter
  representative_signature: {
    intent_id: string
    common_args: Record<string, unknown>
    avg_tool_calls: number
    success_rate: number
  }
  occurrences: number                     // how many times this pattern appeared
  first_seen_at: number
  last_seen_at: number
}

/** Result of skill execution. */
export type SkillExecutionResult = {
  ok: boolean
  output?: string                         // for Python: the `output` variable. For TS: return value serialized
  error?: string
  duration_ms: number
  sandbox: 'ts_worker' | 'composio_workbench' | 'declarative'
  // For declarative skills, output is what the LLM-driven action produced
}

/** Persona-gate verdict for a candidate skill. */
export type PersonaGateVerdict = {
  approved: boolean
  tier: AutonomyTier
  is_duplicate: boolean
  similar_existing?: string               // slug of similar skill if dedup found one
  needs_human_review: boolean
  reason: string
}

export type SkillsConfig = {
  enabled?: boolean
  dir?: string                            // ~/.kairos/skills/
  archive_dir?: string                    // ~/.kairos/skills/.archive/
  curator?: {
    cycle_interval_days?: number          // default 7
    idle_gate_minutes?: number            // default 120 (2h)
    stale_threshold_days?: number         // default 30
    archive_threshold_days?: number       // default 90
  }
  induction?: {
    min_tool_calls?: number               // default 5 (Hermes)
    min_occurrences?: number              // default 3
  }
  execution?: {
    ts_timeout_ms?: number                // default 30000
    python_timeout_ms?: number            // default 60000
  }
}
```

- [ ] **Write types.ts exactly as above.**
- [ ] **Commit:** `feat(skills): C.3.3 type surface — SkillFile, SkillUsage, SkillCandidate, SkillExecutionResult`

---

## Task 1: SKILL.md parser/serializer (agentskills.io spec)

**Files:**
- Create: `src/daemon/skills/skillMd.ts`
- Create: `src/daemon/skills/skillMd.test.ts`

Reuses C.3.1's MdLoader for the YAML+body parsing primitives. Adds:
- Validation per agentskills.io spec (name regex, description length, etc.)
- Serialization with field ordering preserved
- Helper: `extractMetadata(skill: SkillFile): Record<string, string>` and inverse

- [ ] **Tests (8):** parse valid SKILL.md; reject too-long descriptions; reject invalid name characters; round-trip preserves frontmatter; metadata extension fields preserved; KAIROS extension keys recognized (`kairos:autonomy_tier`, `kairos:state`, etc.); slug derived from directory; scripts/references presence detected.
- [ ] **Commit:** `feat(skills): SKILL.md parser — agentskills.io spec + KAIROS metadata extensions`

---

## Task 2: SkillWriter — persist SKILL.md + scripts to disk

**Files:**
- Create: `src/daemon/skills/skillWriter.ts`
- Create: `src/daemon/skills/skillWriter.test.ts`

Atomic writes to `~/.kairos/skills/<slug>/` (frontmatter + body + optional scripts/). Handles directory creation, file collision (slug already exists → version suffix or reject).

- [ ] **Tests (6):** writes SKILL.md with valid frontmatter; creates scripts/ when scripts provided; rejects on slug collision unless force=true; atomic rename pattern (write to `.tmp` then rename); preserves file mode; round-trip via parser.
- [ ] **Commit:** `feat(skills): SkillWriter — atomic SKILL.md + scripts/ persistence`

---

## Task 3: UsageTracker — per-skill .usage.json (Hermes schema)

**Files:**
- Create: `src/daemon/skills/usageTracker.ts`
- Create: `src/daemon/skills/usageTracker.test.ts`

Per-skill `.usage.json` file alongside SKILL.md. Hermes 10-field schema exactly. Methods:
- `read(slug): SkillUsage | null`
- `recordUse(slug, durationMs, success: boolean)` — increments use_count, updates last_used_at, optionally appends to failure_history (bounded to 5)
- `recordView(slug)` — increments view_count + last_viewed_at
- `recordPatch(slug)` — increments patch_count + last_patched_at
- `markState(slug, state)` — updates state, sets archived_at if state=archived
- `markCuratorFlag(slug)` — sets curator_review_flag=true after a failure

- [ ] **Tests (8):** read returns null for missing skill; recordUse increments and persists; failure_history bounded to 5; recordView vs recordUse distinction; markState=archived sets archived_at; pinned skills never receive archived state; concurrent writes safe (read-modify-write with atomic file replace).
- [ ] **Commit:** `feat(skills): UsageTracker — Hermes 10-field .usage.json + failure history`

---

## Task 4: SkillStore (SQLite metadata index)

**Files:**
- Create: `src/daemon/skills/skillStore.ts`
- Create: `src/daemon/skills/skillStore.test.ts`

SQLite-backed index for fast boot-time discovery. Stores: `slug, name, description, state, pinned, tier, last_used_at, created_at, dir_path`. Avoids scanning hundreds of SKILL.md files at boot.

- [ ] **Tests (5):** insert/update/delete; listActive returns only state=active; markStale by age threshold; pinned skills exempt from staleness; rebuild from disk if index is missing or corrupted.
- [ ] **Commit:** `feat(skills): SkillStore — SQLite metadata index for fast boot-time skill listing`

---

## Task 5: SkillRegistry — hot-reloaded discovery surface

**Files:**
- Create: `src/daemon/skills/skillRegistry.ts`
- Create: `src/daemon/skills/skillRegistry.test.ts`

Loads active skills at boot via SkillStore. Watches `~/.kairos/skills/` for new files (hot-reload — picks up newly-promoted skills without daemon restart). Exposes progressive disclosure surface:
- `listActiveMetadata(): Array<{slug, name, description, tier}>` — ~100 tokens/skill, for agency layer system prompt at boot
- `loadFullSkill(slug): SkillFile` — loads body + scripts only when agent activates the skill
- Records view via UsageTracker on `loadFullSkill`

- [ ] **Tests (6):** lists active skills only; hot-reload picks up new skill; loadFullSkill returns full body; loadFullSkill records view; ignores `.archive/` directory; refuses to load stale or archived skills via the primary path.
- [ ] **Commit:** `feat(skills): SkillRegistry — hot-reload + progressive disclosure (metadata at boot, body on activation)`

---

## Task 6: Bun Worker TS executor

**Files:**
- Create: `src/daemon/skills/tsRunner.ts`
- Create: `src/daemon/skills/tsRunner.test.ts`

Execute TS skills in a Bun Worker with 30-second hard timeout. **Not a security sandbox** — process isolation only. Acceptable because crystallized skills go through Persona Gate first.

Pattern:
```typescript
async function executeSkillInWorker(
  scriptPath: string,
  args: Record<string, unknown>,
  timeoutMs: number = 30000,
): Promise<SkillExecutionResult>
```

Uses `new Worker(new URL(scriptPath, import.meta.url))`, postMessage for args, awaits message reply or timeout, terminates worker on timeout.

- [ ] **Tests (6):** executes a trivial TS skill and returns result; times out after 30s; captures errors from worker; returns ok=false on syntax errors; passes args via postMessage; terminates worker cleanly on timeout.
- [ ] **Commit:** `feat(skills): TsRunner — Bun Worker executor for TS skills with 30s timeout`

---

## Task 7: Composio Workbench Python executor

**Files:**
- Create: `src/daemon/skills/pythonRunner.ts`
- Create: `src/daemon/skills/pythonRunner.test.ts`

**Critical gotcha (from research):** Python code MUST assign to a variable named `output` at the end. `print()` doesn't surface in the result. The sandbox captures the `output` variable.

Lifecycle:
- One persistent Composio session `kairos-{userId}-skills` with `workbench: { enable: true }`
- Session ID persisted to config (resume on daemon restart)
- Per-skill execution: load Python file, append `output = main(args)`-style invocation, send to workbench
- Capture `data` field from result (NOT stdout)

```typescript
async function executePythonSkill(
  scriptPath: string,
  args: Record<string, unknown>,
  timeoutMs: number = 60000,
): Promise<SkillExecutionResult>
```

- [ ] **Tests (5):** session created with workbench enabled; reuses same session across calls; Python script with `output = ...` returns expected data; missing `output` variable returns empty result (warning logged); session survives daemon restart via cached sessionId.
- [ ] **Commit:** `feat(skills): PythonRunner — Composio Workbench-enabled session for Python skill execution`

---

## Task 8: SkillDispatcher — routes by skill type

**Files:**
- Create: `src/daemon/skills/skillDispatcher.ts`
- Create: `src/daemon/skills/skillDispatcher.test.ts`

Given a SkillFile, decides:
- If `scripts/main.ts` exists → TsRunner
- If `scripts/main.py` exists → PythonRunner
- Else → declarative (return SkillFile.body for LLM-driven execution in agency layer)

Records use via UsageTracker on each call. On failure, calls `usageTracker.markCuratorFlag(slug)`.

- [ ] **Tests (5):** dispatches .ts to TsRunner; dispatches .py to PythonRunner; falls through to declarative when no scripts; usage tracked on every call; curator flag set on failure.
- [ ] **Commit:** `feat(skills): SkillDispatcher — routes TS/Python/declarative + usage tracking`

---

## Task 9: SkillCrystallizer — LLM composes candidate SKILL.md from cluster

**Files:**
- Create: `src/daemon/skills/crystallizer.ts`
- Create: `src/daemon/skills/crystallizer.test.ts`

Takes a `SkillCandidate` (cluster of similar trajectories), calls LLM (medium tier, new task_type `skill_crystallize`) with a strict system prompt: "Given these N successful trajectories of the same pattern, produce a SKILL.md that captures the reusable workflow." Returns a candidate SkillFile.

System prompt enforces:
- agentskills.io frontmatter (name kebab-case ≤64ch, description ≤1024ch stating WHAT + WHEN)
- Body is step-by-step instructions, parameterized over arguments
- KAIROS metadata extensions: `kairos:autonomy_tier` (auto-classify based on trajectory tools used), `kairos:auto_crystallized: 'true'`, `kairos:source_trajectories: <count>`
- If trajectories show data-processing pattern → suggest Python; if mostly tool-calls → declarative; if mixed → TS

- [ ] **Tests (5):** crystallizes basic cluster into valid SKILL.md (with mock LLM); rejects empty cluster; uses task_type='skill_crystallize'; sets `kairos:auto_crystallized: 'true'` in metadata; respects min_tool_calls threshold.
- [ ] **Add `skill_crystallize` task_type** to ModelRouter mapping (medium tier).
- [ ] **Commit:** `feat(skills): SkillCrystallizer — LLM-composes candidate SKILL.md from trajectory clusters`

---

## Task 10: PersonaGate — cosine dedup + autonomy tier + review queue

**Files:**
- Create: `src/daemon/skills/personaGate.ts`
- Create: `src/daemon/skills/reviewQueue.ts`
- Tests for both

PersonaGate decides what to do with a candidate skill:
1. **Cosine dedup**: embed candidate's `description + body` via C.2.6 LocalEmbedder. Compare against embeddings of existing active skills. If similarity > 0.85 → mark as duplicate, do NOT promote.
2. **Autonomy tier assignment**: parse candidate body for risky tool patterns (delete/send/payment/etc.) → GREEN/YELLOW/ORANGE/RED.
3. **Decision**:
   - GREEN → auto-promote (write to disk + register)
   - YELLOW → auto-promote with `kairos:auto_crystallized: 'true'` flag (user can review on demand)
   - ORANGE/RED → queue in ReviewQueue (SQLite) for human approval

ReviewQueue exposes:
- `enqueue(candidate, verdict)`
- `listPending()`
- `approve(id)` → promotes to disk
- `reject(id, reason)` → discards

- [ ] **Tests (10):** dedup identifies similar skill via cosine; non-duplicate candidates pass through; GREEN auto-promotes; ORANGE goes to review queue; review queue persists across restarts; approve flow promotes from queue; reject flow discards.
- [ ] **Commit:** `feat(skills): PersonaGate + ReviewQueue — cosine dedup, tier classification, human review pipeline`

---

## Task 11: AwmWorker — traj.md watcher → cluster detection → crystallization

**Files:**
- Create: `src/daemon/skills/awmWorker.ts`
- Create: `src/daemon/skills/awmWorker.test.ts`

The orchestrator. Runs on a timer (default every 4h, configurable). On each tick:
1. Read recent `~/.kairos/traj/*.md` entries (last 30 days)
2. Filter to outcome=success AND >5 tool calls AND duration >30s (Hermes thresholds)
3. Cluster by intent_id + common_args (cluster signature)
4. For clusters with ≥3 occurrences:
   - Build SkillCandidate
   - Call SkillCrystallizer to get candidate SKILL.md
   - Pass through PersonaGate → ReviewQueue or auto-promote

```typescript
class AwmWorker {
  constructor(deps: { trajWriter, crystallizer, personaGate, skillWriter, skillStore, embedder })
  async runOnce(): Promise<{ candidates_found: number; promoted: number; queued: number; deduplicated: number }>
  start(intervalMs: number): void
  stop(): void
}
```

- [ ] **Tests (6):** finds clusters meeting threshold; ignores below-threshold patterns; passes through deduplicator; auto-promotes GREEN; queues ORANGE; respects min_tool_calls config; runOnce returns metrics summary.
- [ ] **Commit:** `feat(skills): AwmWorker — trajectory watcher with cluster detection + crystallization pipeline`

---

## Task 12: Curator — Hermes 2-phase lifecycle

**Files:**
- Create: `src/daemon/skills/curator.ts`
- Create: `src/daemon/skills/curator.test.ts`

Two phases:

**Phase 1 (deterministic, no LLM):**
- For each active skill: if `last_used_at` is >30 days ago → mark stale
- For each stale skill: if >90 days unused → archive (move directory to `.archive/<slug>/`)
- Pinned skills are exempt
- min_skill_age_days=7 guard (no skill archived in its first 7 days)

**Phase 2 (LLM-driven, only flagged skills):**
- For each skill with `curator_review_flag === true`:
  - Read skill via `skill_view` (records view via UsageTracker)
  - Call LLM (cheap tier, task_type `skill_curate`) with skill content + failure history
  - LLM decides: `keep | patch | consolidate | archive`
  - On `patch`: LLM produces a revised SKILL.md → SkillWriter writes it (preserve slug), increments patch_count
  - On `consolidate`: identifies a duplicate skill to merge with → SkillWriter merges, archives the loser
  - On `archive`: move to .archive/
  - Max 8 skills processed per Phase 2 run (cost ceiling)

**Trigger**: ≥7d since last Curator run AND daemon idle ≥2h. Idle is conservatively defined as: no agency intent firings in the last 2h.

Writes a CURATOR-REPORT.md to `~/.kairos/skills/` after each run summarizing actions.

- [ ] **Tests (12):** Phase 1 marks stale at 30d; Phase 1 archives at 90d; pinned skills never archived; 7d guard prevents young-skill archival; Phase 2 only runs when flagged skills exist; Phase 2 patches a flagged skill via LLM; Phase 2 respects 8-skill ceiling; Phase 2 consolidate path identifies duplicate via similarity; Phase 2 archive path; CURATOR-REPORT.md written.
- [ ] **Add `skill_curate` task_type** to ModelRouter mapping (cheap tier).
- [ ] **Commit:** `feat(skills): Curator — Hermes 2-phase lifecycle (deterministic + LLM consolidation)`

---

## Task 13: Daemon wire-up + agency layer skill discovery

**Files:**
- Modify: `src/daemon/types.ts` (add `skills?: SkillsConfig`)
- Modify: `src/daemon/config.ts` (defaults)
- Modify: `src/daemon/index.ts` (instantiate full subsystem)
- Modify: `src/daemon/agency/intentRegistry.ts` (skill invocation intent)

In daemon boot:
1. Instantiate SkillStore (SQLite) + load metadata
2. Instantiate SkillRegistry → expose `listActiveMetadata()` to agency layer's system prompt builder
3. Instantiate UsageTracker, SkillDispatcher (with TsRunner + PythonRunner)
4. Instantiate AwmWorker, start on 4h interval
5. Instantiate Curator, schedule weekly idle-gated cycle
6. Wire SkillRegistry into agency system_blocks: add a short context block listing available skills with their names + descriptions (~100 tokens/skill)
7. Add `invoke_skill` agency intent (GREEN tier — autonomy already gated by per-skill tier) — args: `{ slug: string, args: Record<string, unknown> }` → dispatches via SkillDispatcher

When agent decides to use a skill: the system prompt includes the skill list. Agent calls `invoke_skill` intent with the chosen slug. SkillDispatcher loads full body (records view), executes, returns result. UsageTracker records use.

- [ ] **Tests:** existing tests pass; agency layer system_blocks now include skill list; invoke_skill intent works end-to-end with a fixture skill.
- [ ] **Commit:** `feat(skills): wire C.3.3 — SkillRegistry → agency system prompt, AwmWorker + Curator schedules`

---

## Task 14: Comprehensive validation gate + tag v0.3.7-phase-c3-3

**Files:**
- Create: `scripts/validate-phase-c3-3.ts`

Per user's directive ("every feature added in this, should be tested, and if it works, means its good"), this validation script tests every major subsystem end-to-end. Mirror pattern from `scripts/validate-phase-c3-1.ts`.

**14 assertions:**

1. SKILL.md parser accepts valid spec + rejects invalid (name regex, description length)
2. SkillWriter writes + reads round-trip
3. UsageTracker — recordUse increments + persists + failure_history bounded to 5
4. SkillStore — listActive returns only active + rebuild from disk works
5. SkillRegistry — progressive disclosure (metadata at boot, body on activation) + records view
6. TsRunner — executes trivial TS skill + 30s timeout
7. PythonRunner — Workbench session + `output` variable capture
8. SkillDispatcher — routes correctly TS/Python/declarative + tracks usage
9. SkillCrystallizer — composes valid SKILL.md from cluster (with fake router)
10. PersonaGate — cosine dedup with mock embedder + tier assignment
11. ReviewQueue — enqueue + approve + reject flows
12. AwmWorker — full pipeline: 3 fake traj entries → cluster detected → candidate crystallized → promoted
13. Curator Phase 1 — 30d unused → stale; 90d unused → archived; pinned skips
14. End-to-end: register a skill → agent's available skill list updates → invoke via intent → execution → usage recorded

All assertions must PASS. Tag `v0.3.7-phase-c3-3`.

- [ ] **Append CHANGELOG entry.**
- [ ] **Commit:** `test(c3.3): validation gate — 14 assertions across AWM subsystem`
- [ ] **Tag:** `v0.3.7-phase-c3-3`

---

## Self-review checklist

- [ ] **No regressions** in C.1.5 / C.2.5 / C.2.6 / C.2.7 / C.3.1 tests
- [ ] **agentskills.io spec compliance** — name format, description length, valid YAML
- [ ] **Cost guardrails** — Curator Phase 2 capped at 8 skills/run; AwmWorker only runs every 4h; both use cheap LLM tier
- [ ] **Sandbox boundary clarity** — Bun Worker explicitly documented as "trust-on-promotion, not security"; Python sandbox via Composio Workbench (proper isolation)
- [ ] **Hermes schema fidelity** — `.usage.json` is 10 fields exactly, not 9, not 11
- [ ] **`output` variable** — Python skills always documented with `output = ...` requirement
- [ ] **Curator idle gate** — uses agency intent firings as proxy for "user active"
- [ ] **Review queue persistence** — SQLite survives daemon restart

---

## Risks flagged

1. **agentskills.io spec drift** — if the standard evolves between now and v0.3.7 shipping, the parser may need updating. Mitigate: pin the spec version in metadata and tag adoption date.
2. **Composio Workbench session may expire** — sessions persist "indefinitely" but observed behavior could differ. PythonRunner must handle re-creation on first failure with session-not-found error.
3. **Bun Worker is not a real sandbox** — documented explicitly. If a skill goes rogue, it can do anything the daemon can. Persona Gate's tier assignment is the safety mechanism.
4. **AwmWorker may over-crystallize** — 4h cycle might find too many candidates early on. Default `min_occurrences: 3` should prevent this; can raise to 5 if it's still noisy.
5. **Curator Phase 2 LLM cost** — even at cheap tier, 8 skills × ~$0.001/skill = ~$0.008/week. Negligible. But if a daemon runs continuously for 10 years, that's still <$5 cumulative. Fine.
6. **Cosine dedup false positives** — 0.85 similarity threshold may merge skills that are conceptually distinct but share vocabulary. Mitigate: log every dedup decision so we can tune the threshold based on real data.

---

## Execution Handoff

Plan saved to `docs/superpowers/plans/2026-05-28-phase-c3-3-awm-skills.md`.

**Recommended execution:** Subagent-driven development. ~3-4 sessions of 60-90 min at the C.2.5/6/7 + C.3.1 cadence.

After C.3.3 ships (`v0.3.7-phase-c3-3`):
- The self-improving skills loop is live
- KAIROS learns from every successful pattern
- Skills auto-expire when unused
- Phase C.3.2 (OpenAI Agents SDK orchestrator) optionally next, OR jump to Phase D/E/F

When ready to execute: invoke `superpowers:subagent-driven-development` pointing at this plan.
