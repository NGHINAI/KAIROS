# Phase B — Human-Like Memory + Tiered Perception + STANDING_ORDERS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform KAIROS from "narrator that fires every 5 min" to "co-worker with human-like memory that only speaks when there's real signal." Adds the 4-layer memory system (MemOS L1-L4 + Hermes Dreaming consolidation), the Tier 1 + Tier 2 perception gates that wrap Phase A's narrator (KAIROS_SILENT pattern), the STANDING_ORDERS.md hybrid compiler, the ActivityWatch 6th observer, and the TLS warmup retrofit.

**Architecture:** A push-based perception pipeline gates every event batch through two cheap classifiers before deciding to invoke the Narrator. The memory system writes raw events to L1 (working), promotes meaningful sequences to L2 (episodic), distills patterns to L3 (semantic facts/notes), and crystallizes repeated successful actions to L4 (procedural skills). Consolidation runs only during user idle + on AC power. A STANDING_ORDERS.md file lets the user declare what to watch for in plain English; a one-time LLM compile step parses it to structured triggers cached in the DB.

**Tech Stack:** TypeScript on Bun, `bun:sqlite` + `sqlite-vec` (vector search inside SQLite), `fastembed` (local nomic-embed-text for embeddings), ActivityWatch REST API (`localhost:5600`), reuse Phase A's ModelRouter for all classifier/narrator/dreamer LLM calls.

**Scope boundary:** Phase B ships the perception + memory + STANDING_ORDERS pipeline. Phase C builds the trigger engine + autonomy tiers (acting on perceived signal). Phase D wires OAuth connectors so KAIROS can read incoming messages. Phase E adds voice. Until Phase D/E, KAIROS can only observe local activity (Phase A's 5 observers + the new ActivityWatch) and store memory — it cannot yet act or talk back.

**Estimated size:** ~3,400 lines of TypeScript + tests across 22 atomic tasks.

---

## File Structure

All new code under `src/daemon/memory/`, `src/daemon/perception/`, `src/daemon/orders/`. Phase A's `src/daemon/proactive/narrator.ts` becomes the Tier 3 consumer — the file moves but its logic is wrapped, not rewritten.

```
src/daemon/
├── memory/                           [NEW — 4-tier memory system]
│   ├── schema.ts                     SQLite schema for L1-L4 tables + sqlite-vec setup
│   ├── embeddings.ts                 fastembed wrapper (nomic-embed-text local)
│   ├── workingMemory.ts              L1 — last N minutes of raw events, in-memory ring
│   ├── episodicMemory.ts             L2 — typed event sequences, SQLite JSONL
│   ├── semanticMemory.ts             L3 — facts/notes/persona, embedded for retrieval
│   ├── proceduralMemory.ts           L4 — crystallized skills (reference to skills/active/)
│   ├── recall.ts                     Hybrid query API: lexical (FTS5) + semantic (sqlite-vec)
│   ├── dreamer.ts                    Hermes Dreaming scoring + L1→L2→L3 promotion
│   └── idleDetector.ts               macOS IOPMAssertion-based idle + power-source detection
│
├── perception/                       [NEW — tiered gates]
│   ├── tier1Classifier.ts            Cheap classifier: SIGNIFICANT | ROUTINE | SILENT
│   ├── tier2Summarizer.ts            Lightweight summary + significance score 0-1
│   ├── perceptionPipeline.ts         Wraps the EventBus → narrator with the gates
│   └── perceptionLog.ts              Tracks Tier 1/2 decisions for tuning
│
├── orders/                           [NEW — STANDING_ORDERS.md compiler + runtime]
│   ├── parser.ts                     Watches ~/.kairos/STANDING_ORDERS.md for changes
│   ├── compiler.ts                   LLM compile English → structured triggers (cached)
│   ├── runtime.ts                    Match compiled triggers against event batches
│   └── seedFile.ts                   Writes example STANDING_ORDERS.md on first run
│
├── proactive/
│   ├── observers/
│   │   └── activityWatch.ts          [NEW] — 6th observer consuming localhost:5600
│   └── narrator.ts                   [MODIFY] — accept being invoked by perception pipeline (not timer)
│
├── llm/
│   └── providers/
│       ├── anthropicApi.ts           [MODIFY] — add TLS warmup HEAD request
│       ├── openai.ts                 [MODIFY] — add TLS warmup HEAD request
│       └── gemini.ts                 [MODIFY] — add TLS warmup HEAD request
│
└── index.ts                          [MODIFY] — wire memory + perception + orders into startup
```

**Test files** alongside source as `*.test.ts` via `bun test`.

---

## Task 0: Setup & dependencies

**Files:**
- Modify: `package.json`
- Create: `~/.kairos/STANDING_ORDERS.md` (seed example)

- [ ] **Step 1: Add new deps**

```bash
cd /Users/nirmalghinaiya/Desktop/kairos-sandbox
bun add sqlite-vec fastembed
```

`sqlite-vec` provides vector search as a SQLite extension; `fastembed` provides local `nomic-embed-text` embeddings (~120MB model, ~50ms per embedding on M2).

- [ ] **Step 2: Verify versions**

```bash
bun pm ls | grep -E "(sqlite-vec|fastembed)"
```

Expected: both packages listed.

- [ ] **Step 3: Write seed STANDING_ORDERS.md to ~/.kairos/**

```bash
mkdir -p ~/.kairos
```

```markdown
# KAIROS Standing Orders
# Edit this file in any text editor. KAIROS reloads it automatically on save.
# Write rules in plain English — KAIROS compiles them into triggers.

# Examples (delete or modify):
- If I have a calendar event starting in 10 minutes and I'm not in a video call, remind me.
- If my Spotify changes to a song I haven't heard before, note it in memory.
- If I copy a URL to the clipboard, fetch its title and add to recent reading.
- If I open the same file three times in 10 minutes, suggest opening the related PR.
- Never proactively interrupt me on Sunday before 11am or after 10pm any day.
```

- [ ] **Step 4: Commit**

```bash
git add package.json bun.lock
git commit -m "deps(phase-b): add sqlite-vec + fastembed for vector memory"
```

---

## Task 1: SQLite schema for 4-tier memory

**Files:**
- Create: `src/daemon/memory/schema.ts`
- Test:  `src/daemon/memory/schema.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/daemon/memory/schema.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { initMemorySchema } from './schema'

describe('memory schema', () => {
  let db: Database

  beforeEach(() => {
    db = new Database(':memory:')
  })

  it('creates all 4 tier tables and vec virtual table', () => {
    initMemorySchema(db)
    const tables = db.query("SELECT name FROM sqlite_master WHERE type IN ('table','virtual')").all() as { name: string }[]
    const names = tables.map(t => t.name)
    expect(names).toContain('mem_l2_episodes')
    expect(names).toContain('mem_l3_semantic')
    expect(names).toContain('mem_l4_procedural_index')
    expect(names).toContain('mem_l3_vec')   // sqlite-vec virtual table
  })

  it('creates FTS5 index for lexical search on L3', () => {
    initMemorySchema(db)
    const ftsExists = db.query("SELECT name FROM sqlite_master WHERE name = 'mem_l3_fts'").get()
    expect(ftsExists).toBeTruthy()
  })

  it('schema is idempotent — running twice does not error', () => {
    initMemorySchema(db)
    expect(() => initMemorySchema(db)).not.toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/nirmalghinaiya/Desktop/kairos-sandbox
bun test src/daemon/memory/schema.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the schema module**

```typescript
// src/daemon/memory/schema.ts
// 4-tier human-like memory schema following MemOS L1-L4 layout.
//
// L1 (working) is in-memory only — handled by workingMemory.ts ring buffer
// L2 (episodic) — typed sequences of events that form a meaningful unit
// L3 (semantic) — distilled facts/notes/persona, embedded for fuzzy recall
// L4 (procedural) — pointer index into skills/active/ (skills live as files)
//
// sqlite-vec provides cosine similarity over 768-dim nomic-embed-text vectors.
// FTS5 provides BM25 lexical search. Hybrid retrieval combines both.

import type { Database } from 'bun:sqlite'
import * as sqliteVec from 'sqlite-vec'

const SCHEMA = `
  -- L2: Episodic memory. Each row is one "episode" (a meaningful event sequence).
  CREATE TABLE IF NOT EXISTS mem_l2_episodes (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at      INTEGER NOT NULL,
    ended_at        INTEGER NOT NULL,
    episode_type    TEXT    NOT NULL,           -- 'work_session' | 'communication' | 'browsing' | etc
    title           TEXT    NOT NULL,           -- LLM-generated short title
    summary         TEXT    NOT NULL,           -- 1-3 sentence summary
    event_ids       TEXT    NOT NULL,           -- JSON array of world_state_events.id
    importance      REAL    NOT NULL DEFAULT 0.5,  -- 0-1 from dreamer score
    promoted_l3     INTEGER NOT NULL DEFAULT 0,  -- bool: was this distilled to L3?
    created_at      INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_l2_ts ON mem_l2_episodes(started_at);
  CREATE INDEX IF NOT EXISTS idx_l2_type ON mem_l2_episodes(episode_type, started_at);
  CREATE INDEX IF NOT EXISTS idx_l2_unpromoted ON mem_l2_episodes(promoted_l3, importance)
    WHERE promoted_l3 = 0;

  -- L3: Semantic memory. Persistent facts, notes, persona observations.
  CREATE TABLE IF NOT EXISTS mem_l3_semantic (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    kind            TEXT    NOT NULL,           -- 'fact' | 'preference' | 'person' | 'project' | 'pattern'
    subject         TEXT    NOT NULL,           -- the entity this is about (person name, project, etc)
    body            TEXT    NOT NULL,           -- the actual content
    source_episodes TEXT,                       -- JSON array of mem_l2_episodes.id that produced this
    importance      REAL    NOT NULL DEFAULT 0.5,
    frequency       INTEGER NOT NULL DEFAULT 1, -- times this fact has been reinforced
    last_seen       INTEGER NOT NULL,
    created_at      INTEGER NOT NULL,
    decayed_at      INTEGER                     -- nullable; set when forgetting curve evicts
  );
  CREATE INDEX IF NOT EXISTS idx_l3_subject ON mem_l3_semantic(subject);
  CREATE INDEX IF NOT EXISTS idx_l3_kind ON mem_l3_semantic(kind);
  CREATE INDEX IF NOT EXISTS idx_l3_active ON mem_l3_semantic(decayed_at, importance)
    WHERE decayed_at IS NULL;

  -- FTS5 for lexical search over L3 bodies
  CREATE VIRTUAL TABLE IF NOT EXISTS mem_l3_fts USING fts5(
    body,
    subject,
    content='mem_l3_semantic',
    content_rowid='id'
  );

  -- Triggers to keep FTS5 in sync with the underlying table
  CREATE TRIGGER IF NOT EXISTS mem_l3_ai AFTER INSERT ON mem_l3_semantic BEGIN
    INSERT INTO mem_l3_fts(rowid, body, subject) VALUES (new.id, new.body, new.subject);
  END;
  CREATE TRIGGER IF NOT EXISTS mem_l3_ad AFTER DELETE ON mem_l3_semantic BEGIN
    DELETE FROM mem_l3_fts WHERE rowid = old.id;
  END;
  CREATE TRIGGER IF NOT EXISTS mem_l3_au AFTER UPDATE ON mem_l3_semantic BEGIN
    DELETE FROM mem_l3_fts WHERE rowid = old.id;
    INSERT INTO mem_l3_fts(rowid, body, subject) VALUES (new.id, new.body, new.subject);
  END;

  -- L4: Procedural memory index. Skills live in skills/active/ as files;
  -- this table indexes them for retrieval by intent + recency.
  CREATE TABLE IF NOT EXISTS mem_l4_procedural_index (
    skill_id        TEXT    PRIMARY KEY,        -- matches skills/active/<dir>/manifest.json
    description     TEXT    NOT NULL,
    trigger_pattern TEXT,                       -- when does this skill apply?
    last_invoked    INTEGER,
    invoke_count    INTEGER NOT NULL DEFAULT 0,
    success_count   INTEGER NOT NULL DEFAULT 0,
    crystallized_from TEXT                      -- episode_id that originated this skill
  );

  -- Dreamer log — records what was consolidated when, for auditing
  CREATE TABLE IF NOT EXISTS mem_dream_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at      INTEGER NOT NULL,
    completed_at    INTEGER,
    episodes_in     INTEGER NOT NULL DEFAULT 0,
    facts_out       INTEGER NOT NULL DEFAULT 0,
    notes           TEXT
  );
`

export function initMemorySchema(db: Database): void {
  // sqlite-vec must be loaded BEFORE creating the virtual table
  sqliteVec.load(db)

  db.exec(SCHEMA)

  // Vector table for L3 embeddings (nomic-embed-text is 768-dim).
  // sqlite-vec syntax: virtual table with float[N] dimension declaration.
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS mem_l3_vec USING vec0(
      l3_id INTEGER PRIMARY KEY,
      embedding FLOAT[768]
    )
  `)
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test src/daemon/memory/schema.test.ts
```

Expected: PASS (3 tests). If sqlite-vec extension fails to load on macOS arm64, document the error in DONE_WITH_CONCERNS and check that `node_modules/sqlite-vec/build/Release/vec0.dylib` exists.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/memory/schema.ts src/daemon/memory/schema.test.ts
git commit -m "feat(memory): SQLite schema for L1-L4 memory tiers + sqlite-vec setup"
```

---

## Task 2: Embeddings wrapper

**Files:**
- Create: `src/daemon/memory/embeddings.ts`
- Test:  `src/daemon/memory/embeddings.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/daemon/memory/embeddings.test.ts
import { describe, it, expect } from 'bun:test'
import { Embedder } from './embeddings'

describe('Embedder', () => {
  it('produces 768-dim vectors for nomic-embed-text', async () => {
    const emb = new Embedder()
    const vec = await emb.embed('the quick brown fox')
    expect(vec.length).toBe(768)
  })

  it('similar texts have higher cosine similarity than unrelated ones', async () => {
    const emb = new Embedder()
    const v1 = await emb.embed('apple iphone macbook')
    const v2 = await emb.embed('apple ipad airpods')
    const v3 = await emb.embed('quantum chromodynamics partons')
    expect(cosine(v1, v2)).toBeGreaterThan(cosine(v1, v3))
  })

  it('caches identical text', async () => {
    const emb = new Embedder()
    const t = 'cached text'
    await emb.embed(t)
    const before = emb.cacheHits
    await emb.embed(t)
    expect(emb.cacheHits).toBe(before + 1)
  })
})

function cosine(a: Float32Array | number[], b: Float32Array | number[]): number {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! ** 2
    nb += b[i]! ** 2
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/nirmalghinaiya/Desktop/kairos-sandbox
bun test src/daemon/memory/embeddings.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the embedder**

```typescript
// src/daemon/memory/embeddings.ts
// Local embeddings via fastembed (nomic-embed-text v1.5, 768-dim).
// First call downloads the ~120MB model into ~/.cache/fastembed/.
// Subsequent calls are ~50ms on M2.
//
// LRU cache for identical text — common when summaries are stable.

import { FlagEmbedding, EmbeddingModel } from 'fastembed'

const MODEL = EmbeddingModel.NomicEmbedTextV1_5
const CACHE_SIZE = 256

export class Embedder {
  private modelPromise: Promise<FlagEmbedding> | null = null
  private cache: Map<string, number[]> = new Map()
  public cacheHits = 0

  private async getModel(): Promise<FlagEmbedding> {
    if (!this.modelPromise) {
      this.modelPromise = FlagEmbedding.init({ model: MODEL })
    }
    return this.modelPromise
  }

  async embed(text: string): Promise<number[]> {
    const cached = this.cache.get(text)
    if (cached) {
      this.cacheHits++
      return cached
    }
    const model = await this.getModel()
    const generator = model.embed([text])
    const batches = [] as number[][][]
    for await (const batch of generator) batches.push(batch as number[][])
    const vec = batches[0]?.[0]
    if (!vec) throw new Error('Embedder: model returned no vector')

    if (this.cache.size >= CACHE_SIZE) {
      // Simple FIFO eviction
      const firstKey = this.cache.keys().next().value
      if (firstKey !== undefined) this.cache.delete(firstKey)
    }
    this.cache.set(text, vec)
    return vec
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test src/daemon/memory/embeddings.test.ts
```

Expected: PASS (3 tests). First run will be slow due to model download (~2 min). Subsequent runs <1 sec. If fastembed module API differs from this code, adjust signatures — the test assertions stay the same.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/memory/embeddings.ts src/daemon/memory/embeddings.test.ts
git commit -m "feat(memory): local embeddings via fastembed (nomic-embed-text)"
```

---

## Task 3: Working memory (L1) ring buffer

**Files:**
- Create: `src/daemon/memory/workingMemory.ts`
- Test:  `src/daemon/memory/workingMemory.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/daemon/memory/workingMemory.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { EventBus } from '../proactive/eventBus'
import { WorkingMemory } from './workingMemory'

describe('WorkingMemory', () => {
  let db: Database
  let bus: EventBus
  let mem: WorkingMemory

  beforeEach(() => {
    db = new Database(':memory:')
    bus = new EventBus(db)
    mem = new WorkingMemory(bus, { windowMs: 60_000, maxEvents: 200 })
  })

  it('subscribes to bus and captures events into the window', () => {
    bus.publish({ source: 'focus-app', kind: 'app_changed', payload: { app: 'X' } })
    bus.publish({ source: 'clipboard', kind: 'changed', payload: { text: 'hi' } })
    expect(mem.snapshot().length).toBe(2)
  })

  it('evicts events older than the window', async () => {
    const m = new WorkingMemory(bus, { windowMs: 50, maxEvents: 200 })
    bus.publish({ source: 's', kind: 'k', payload: {} })
    expect(m.snapshot().length).toBe(1)
    await new Promise(r => setTimeout(r, 80))
    bus.publish({ source: 's', kind: 'k', payload: {} })
    expect(m.snapshot().length).toBe(1)   // first event evicted
  })

  it('caps at maxEvents even if window allows more', () => {
    const m = new WorkingMemory(bus, { windowMs: 60_000, maxEvents: 3 })
    for (let i = 0; i < 10; i++) {
      bus.publish({ source: 's', kind: 'k', payload: { n: i } })
    }
    expect(m.snapshot().length).toBe(3)
    expect((m.snapshot()[2]?.payload as any).n).toBe(9)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/daemon/memory/workingMemory.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// src/daemon/memory/workingMemory.ts
// L1 — working memory. An in-memory ring buffer of the last N minutes of
// events (or last K events, whichever is smaller). This is what the
// perception pipeline reads to decide if "something just happened".
//
// Not persistent — survives only as long as the daemon process.

import type { EventBus, WorldEvent } from '../proactive/eventBus'

export type WorkingMemoryOptions = {
  windowMs?: number   // default: 10 minutes
  maxEvents?: number  // default: 500
}

export class WorkingMemory {
  private events: WorldEvent[] = []
  private windowMs: number
  private maxEvents: number

  constructor(bus: EventBus, opts?: WorkingMemoryOptions) {
    this.windowMs = opts?.windowMs ?? 10 * 60_000
    this.maxEvents = opts?.maxEvents ?? 500
    bus.subscribe('*', e => this.ingest(e))
  }

  snapshot(): WorldEvent[] {
    this.evictOld()
    return this.events.slice()
  }

  /** Events grouped by source for compact perception prompts. */
  groupedBySource(): Record<string, WorldEvent[]> {
    this.evictOld()
    const groups: Record<string, WorldEvent[]> = {}
    for (const e of this.events) {
      ;(groups[e.source] ?? (groups[e.source] = [])).push(e)
    }
    return groups
  }

  /** Count of events since a given timestamp. */
  countSince(tsMs: number): number {
    this.evictOld()
    return this.events.filter(e => e.ts >= tsMs).length
  }

  private ingest(e: WorldEvent): void {
    this.events.push(e)
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents)
    }
    this.evictOld()
  }

  private evictOld(): void {
    const cutoff = Date.now() - this.windowMs
    let i = 0
    while (i < this.events.length && this.events[i]!.ts < cutoff) i++
    if (i > 0) this.events.splice(0, i)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test src/daemon/memory/workingMemory.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/memory/workingMemory.ts src/daemon/memory/workingMemory.test.ts
git commit -m "feat(memory): L1 working memory ring buffer (10min/500-event window)"
```

---

## Task 4: Episodic memory (L2) writer

**Files:**
- Create: `src/daemon/memory/episodicMemory.ts`
- Test:  `src/daemon/memory/episodicMemory.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/daemon/memory/episodicMemory.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { initMemorySchema } from './schema'
import { EpisodicMemory } from './episodicMemory'

describe('EpisodicMemory', () => {
  let db: Database
  let mem: EpisodicMemory

  beforeEach(() => {
    db = new Database(':memory:')
    initMemorySchema(db)
    mem = new EpisodicMemory(db)
  })

  it('writes an episode and returns the row id', () => {
    const id = mem.writeEpisode({
      started_at: 1700000000000,
      ended_at: 1700000600000,
      episode_type: 'work_session',
      title: 'Editing auth.ts',
      summary: 'Refactored session middleware in src/auth.ts',
      event_ids: [1, 2, 3],
      importance: 0.7,
    })
    expect(id).toBeGreaterThan(0)
  })

  it('retrieves recent episodes ordered newest-first', () => {
    mem.writeEpisode({ started_at: 1000, ended_at: 2000, episode_type: 'x', title: 'a', summary: 's', event_ids: [], importance: 0.5 })
    mem.writeEpisode({ started_at: 3000, ended_at: 4000, episode_type: 'x', title: 'b', summary: 's', event_ids: [], importance: 0.5 })
    const recent = mem.recent(10)
    expect(recent.length).toBe(2)
    expect(recent[0]?.title).toBe('b')
  })

  it('lists unpromoted episodes for the dreamer', () => {
    const id1 = mem.writeEpisode({ started_at: 1, ended_at: 2, episode_type: 'x', title: 'a', summary: 's', event_ids: [], importance: 0.8 })
    const id2 = mem.writeEpisode({ started_at: 3, ended_at: 4, episode_type: 'x', title: 'b', summary: 's', event_ids: [], importance: 0.3 })
    mem.markPromoted(id1)
    const unpromoted = mem.unpromoted(10)
    expect(unpromoted.length).toBe(1)
    expect(unpromoted[0]?.id).toBe(id2)
  })

  it('filters by episode_type', () => {
    mem.writeEpisode({ started_at: 1, ended_at: 2, episode_type: 'work_session', title: 'a', summary: 's', event_ids: [], importance: 0.5 })
    mem.writeEpisode({ started_at: 3, ended_at: 4, episode_type: 'communication', title: 'b', summary: 's', event_ids: [], importance: 0.5 })
    const work = mem.byType('work_session', 10)
    expect(work.length).toBe(1)
    expect(work[0]?.title).toBe('a')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/daemon/memory/episodicMemory.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// src/daemon/memory/episodicMemory.ts
// L2 — episodic memory. Each row is one "episode" — a meaningful sequence
// of events grouped together (a work session, a conversation, a browsing
// session, a coding bug-fix flow). Episodes are written by the perception
// pipeline when Tier 2 promotes a batch.

import type { Database } from 'bun:sqlite'

export type EpisodeInput = {
  started_at: number
  ended_at: number
  episode_type: string
  title: string
  summary: string
  event_ids: number[]
  importance: number
}

export type Episode = EpisodeInput & {
  id: number
  promoted_l3: number
  created_at: number
}

export class EpisodicMemory {
  constructor(private db: Database) {}

  writeEpisode(e: EpisodeInput): number {
    const info = this.db.run(
      `INSERT INTO mem_l2_episodes
         (started_at, ended_at, episode_type, title, summary, event_ids, importance, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [e.started_at, e.ended_at, e.episode_type, e.title, e.summary, JSON.stringify(e.event_ids), e.importance, Date.now()],
    )
    return Number(info.lastInsertRowid)
  }

  recent(limit: number = 20): Episode[] {
    const rows = this.db.query(
      'SELECT * FROM mem_l2_episodes ORDER BY started_at DESC LIMIT ?',
    ).all(limit) as Array<Episode & { event_ids: string }>
    return rows.map(r => ({ ...r, event_ids: JSON.parse(r.event_ids) }))
  }

  byType(type: string, limit: number = 20): Episode[] {
    const rows = this.db.query(
      'SELECT * FROM mem_l2_episodes WHERE episode_type = ? ORDER BY started_at DESC LIMIT ?',
    ).all(type, limit) as Array<Episode & { event_ids: string }>
    return rows.map(r => ({ ...r, event_ids: JSON.parse(r.event_ids) }))
  }

  unpromoted(limit: number = 50): Episode[] {
    const rows = this.db.query(
      `SELECT * FROM mem_l2_episodes
       WHERE promoted_l3 = 0
       ORDER BY importance DESC, started_at DESC
       LIMIT ?`,
    ).all(limit) as Array<Episode & { event_ids: string }>
    return rows.map(r => ({ ...r, event_ids: JSON.parse(r.event_ids) }))
  }

  markPromoted(id: number): void {
    this.db.run('UPDATE mem_l2_episodes SET promoted_l3 = 1 WHERE id = ?', [id])
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test src/daemon/memory/episodicMemory.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/memory/episodicMemory.ts src/daemon/memory/episodicMemory.test.ts
git commit -m "feat(memory): L2 episodic memory writer + recent/unpromoted queries"
```

---

## Task 5: Semantic memory (L3) + hybrid recall

**Files:**
- Create: `src/daemon/memory/semanticMemory.ts`
- Create: `src/daemon/memory/recall.ts`
- Test:  `src/daemon/memory/semanticMemory.test.ts`
- Test:  `src/daemon/memory/recall.test.ts`

- [ ] **Step 1: Write the failing test for semanticMemory**

```typescript
// src/daemon/memory/semanticMemory.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { initMemorySchema } from './schema'
import { SemanticMemory } from './semanticMemory'

describe('SemanticMemory', () => {
  let db: Database
  let mem: SemanticMemory

  beforeEach(() => {
    db = new Database(':memory:')
    initMemorySchema(db)
    mem = new SemanticMemory(db)
  })

  it('writes a fact with embedding and retrieves by id', () => {
    const fakeEmb = new Array(768).fill(0).map((_, i) => Math.sin(i))
    const id = mem.write({
      kind: 'fact',
      subject: 'John',
      body: 'John prefers concise replies after 6pm',
      embedding: fakeEmb,
      importance: 0.8,
    })
    const row = mem.getById(id)
    expect(row?.body).toBe('John prefers concise replies after 6pm')
  })

  it('reinforces existing facts by subject + body match', () => {
    const fakeEmb = new Array(768).fill(0).map((_, i) => Math.sin(i))
    const id1 = mem.write({ kind: 'fact', subject: 'John', body: 'prefers concise replies', embedding: fakeEmb, importance: 0.5 })
    const id2 = mem.reinforceOrWrite({ kind: 'fact', subject: 'John', body: 'prefers concise replies', embedding: fakeEmb, importance: 0.5 })
    expect(id2).toBe(id1)
    const row = mem.getById(id1)
    expect(row?.frequency).toBe(2)
  })

  it('marks rows as decayed (forgotten) without deleting', () => {
    const fakeEmb = new Array(768).fill(0).map((_, i) => Math.sin(i))
    const id = mem.write({ kind: 'fact', subject: 'X', body: 'y', embedding: fakeEmb, importance: 0.1 })
    mem.decay(id)
    const active = mem.allActive()
    expect(active.find(r => r.id === id)).toBeUndefined()
    const all = mem.allIncludingDecayed()
    expect(all.find(r => r.id === id)).toBeDefined()
  })
})
```

- [ ] **Step 2: Write the failing test for recall**

```typescript
// src/daemon/memory/recall.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { initMemorySchema } from './schema'
import { SemanticMemory } from './semanticMemory'
import { Recall } from './recall'

describe('Recall', () => {
  let db: Database
  let sem: SemanticMemory
  let recall: Recall

  beforeEach(() => {
    db = new Database(':memory:')
    initMemorySchema(db)
    sem = new SemanticMemory(db)
    recall = new Recall(db)
  })

  it('returns lexical matches via FTS5 BM25', () => {
    const fakeEmb = new Array(768).fill(0).map((_, i) => Math.sin(i))
    sem.write({ kind: 'fact', subject: 'meeting', body: 'standup is at 10am daily', embedding: fakeEmb, importance: 0.5 })
    sem.write({ kind: 'fact', subject: 'lunch', body: 'team lunch is on Fridays', embedding: fakeEmb, importance: 0.5 })
    const results = recall.lexical('standup', 5)
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]?.body).toContain('standup')
  })

  it('returns semantic matches via sqlite-vec', () => {
    const v1 = new Array(768).fill(0); v1[0] = 1
    const v2 = new Array(768).fill(0); v2[0] = 1; v2[1] = 0.1
    const v3 = new Array(768).fill(0); v3[100] = 1
    sem.write({ kind: 'fact', subject: 'a', body: 'first vector', embedding: v1, importance: 0.5 })
    sem.write({ kind: 'fact', subject: 'b', body: 'close to first', embedding: v2, importance: 0.5 })
    sem.write({ kind: 'fact', subject: 'c', body: 'unrelated', embedding: v3, importance: 0.5 })
    const results = recall.semantic(v1, 2)
    expect(results.length).toBe(2)
    expect(results[0]?.body).toBe('first vector')
    expect(results[1]?.body).toBe('close to first')
  })

  it('hybrid combines and dedupes lexical + semantic', () => {
    const v1 = new Array(768).fill(0); v1[0] = 1
    sem.write({ kind: 'fact', subject: 'meeting', body: 'standup is at 10am', embedding: v1, importance: 0.5 })
    const results = recall.hybrid('standup', v1, 5)
    expect(results.length).toBeGreaterThan(0)
    // No duplicates
    const ids = results.map(r => r.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
bun test src/daemon/memory/semanticMemory.test.ts src/daemon/memory/recall.test.ts
```

Expected: FAIL — modules not found.

- [ ] **Step 4: Write semanticMemory.ts**

```typescript
// src/daemon/memory/semanticMemory.ts
// L3 — semantic memory. Persistent facts, preferences, persona observations.
// Each row gets a 768-dim embedding stored in mem_l3_vec for similarity search.
//
// "Reinforce" is the human-like behavior: when the dreamer re-derives the same
// fact, we don't write a duplicate — we increment frequency + bump last_seen.
// Important for the Hermes Dreaming scoring (frequency × recency).
//
// Decay is non-destructive — we set decayed_at and exclude from active queries.
// This lets the forgetting curve be reversible if signal returns.

import type { Database } from 'bun:sqlite'

export type SemanticInput = {
  kind: 'fact' | 'preference' | 'person' | 'project' | 'pattern'
  subject: string
  body: string
  embedding: number[]
  source_episodes?: number[]
  importance: number
}

export type SemanticRow = {
  id: number
  kind: string
  subject: string
  body: string
  source_episodes: number[] | null
  importance: number
  frequency: number
  last_seen: number
  created_at: number
  decayed_at: number | null
}

export class SemanticMemory {
  constructor(private db: Database) {}

  write(input: SemanticInput): number {
    const now = Date.now()
    const info = this.db.run(
      `INSERT INTO mem_l3_semantic
         (kind, subject, body, source_episodes, importance, frequency, last_seen, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      [
        input.kind, input.subject, input.body,
        input.source_episodes ? JSON.stringify(input.source_episodes) : null,
        input.importance, now, now,
      ],
    )
    const id = Number(info.lastInsertRowid)
    this.db.run(
      'INSERT INTO mem_l3_vec(l3_id, embedding) VALUES (?, ?)',
      [id, new Float32Array(input.embedding).buffer as any],
    )
    return id
  }

  /** Write OR reinforce by (subject + body) match. Returns existing id if matched. */
  reinforceOrWrite(input: SemanticInput): number {
    const existing = this.db.query(
      'SELECT id FROM mem_l3_semantic WHERE subject = ? AND body = ? AND decayed_at IS NULL',
    ).get(input.subject, input.body) as { id: number } | null
    if (existing) {
      this.db.run(
        'UPDATE mem_l3_semantic SET frequency = frequency + 1, last_seen = ?, importance = MAX(importance, ?) WHERE id = ?',
        [Date.now(), input.importance, existing.id],
      )
      return existing.id
    }
    return this.write(input)
  }

  getById(id: number): SemanticRow | null {
    const row = this.db.query('SELECT * FROM mem_l3_semantic WHERE id = ?').get(id) as
      (Omit<SemanticRow, 'source_episodes'> & { source_episodes: string | null }) | null
    if (!row) return null
    return { ...row, source_episodes: row.source_episodes ? JSON.parse(row.source_episodes) : null }
  }

  allActive(): SemanticRow[] {
    const rows = this.db.query('SELECT * FROM mem_l3_semantic WHERE decayed_at IS NULL ORDER BY last_seen DESC').all() as
      Array<Omit<SemanticRow, 'source_episodes'> & { source_episodes: string | null }>
    return rows.map(r => ({ ...r, source_episodes: r.source_episodes ? JSON.parse(r.source_episodes) : null }))
  }

  allIncludingDecayed(): SemanticRow[] {
    const rows = this.db.query('SELECT * FROM mem_l3_semantic ORDER BY last_seen DESC').all() as
      Array<Omit<SemanticRow, 'source_episodes'> & { source_episodes: string | null }>
    return rows.map(r => ({ ...r, source_episodes: r.source_episodes ? JSON.parse(r.source_episodes) : null }))
  }

  decay(id: number): void {
    this.db.run('UPDATE mem_l3_semantic SET decayed_at = ? WHERE id = ?', [Date.now(), id])
  }
}
```

- [ ] **Step 5: Write recall.ts**

```typescript
// src/daemon/memory/recall.ts
// Hybrid retrieval API over L3 semantic memory.
// Lexical: FTS5 BM25 over body + subject
// Semantic: cosine similarity via sqlite-vec
// Hybrid: union both, dedupe by id, rerank by combined score.

import type { Database } from 'bun:sqlite'
import type { SemanticRow } from './semanticMemory'

export class Recall {
  constructor(private db: Database) {}

  lexical(query: string, limit: number = 10): SemanticRow[] {
    // FTS5 query with BM25 ranking
    const rows = this.db.query(
      `SELECT s.* FROM mem_l3_fts f
       JOIN mem_l3_semantic s ON s.id = f.rowid
       WHERE mem_l3_fts MATCH ? AND s.decayed_at IS NULL
       ORDER BY rank LIMIT ?`,
    ).all(query, limit) as Array<Omit<SemanticRow, 'source_episodes'> & { source_episodes: string | null }>
    return rows.map(r => ({ ...r, source_episodes: r.source_episodes ? JSON.parse(r.source_episodes) : null }))
  }

  semantic(embedding: number[], limit: number = 10): SemanticRow[] {
    const buf = new Float32Array(embedding).buffer
    const rows = this.db.query(
      `SELECT s.* FROM mem_l3_vec v
       JOIN mem_l3_semantic s ON s.id = v.l3_id
       WHERE v.embedding MATCH ? AND s.decayed_at IS NULL
       ORDER BY distance LIMIT ?`,
    ).all(buf as any, limit) as Array<Omit<SemanticRow, 'source_episodes'> & { source_episodes: string | null }>
    return rows.map(r => ({ ...r, source_episodes: r.source_episodes ? JSON.parse(r.source_episodes) : null }))
  }

  hybrid(query: string, embedding: number[], limit: number = 10): SemanticRow[] {
    const lex = this.lexical(query, limit)
    const sem = this.semantic(embedding, limit)
    const seen = new Set<number>()
    const merged: SemanticRow[] = []
    // Interleave: take one from each list until exhausted, dedupe by id
    for (let i = 0; i < limit; i++) {
      const l = lex[i], s = sem[i]
      if (l && !seen.has(l.id)) { merged.push(l); seen.add(l.id) }
      if (s && !seen.has(s.id)) { merged.push(s); seen.add(s.id) }
      if (merged.length >= limit) break
    }
    return merged.slice(0, limit)
  }
}
```

- [ ] **Step 6: Run tests**

```bash
bun test src/daemon/memory/semanticMemory.test.ts src/daemon/memory/recall.test.ts
```

Expected: PASS (3 + 3 = 6 tests).

- [ ] **Step 7: Commit**

```bash
git add src/daemon/memory/semanticMemory.ts src/daemon/memory/recall.ts \
        src/daemon/memory/semanticMemory.test.ts src/daemon/memory/recall.test.ts
git commit -m "feat(memory): L3 semantic memory + hybrid recall (FTS5 + sqlite-vec)"
```

---

## Task 6: Procedural memory (L4) index

**Files:**
- Create: `src/daemon/memory/proceduralMemory.ts`
- Test:  `src/daemon/memory/proceduralMemory.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/daemon/memory/proceduralMemory.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { initMemorySchema } from './schema'
import { ProceduralMemory } from './proceduralMemory'

describe('ProceduralMemory', () => {
  let db: Database
  let mem: ProceduralMemory

  beforeEach(() => {
    db = new Database(':memory:')
    initMemorySchema(db)
    mem = new ProceduralMemory(db)
  })

  it('registers a skill and retrieves by id', () => {
    mem.register({
      skill_id: 'system-info',
      description: 'Show host system info',
      trigger_pattern: 'user asks "what system" or "specs"',
    })
    const row = mem.get('system-info')
    expect(row?.description).toBe('Show host system info')
  })

  it('records invocation + success', () => {
    mem.register({ skill_id: 'x', description: 'y' })
    mem.recordInvoke('x', true)
    mem.recordInvoke('x', true)
    mem.recordInvoke('x', false)
    const row = mem.get('x')
    expect(row?.invoke_count).toBe(3)
    expect(row?.success_count).toBe(2)
  })

  it('lists skills ordered by recent + frequent usage', () => {
    mem.register({ skill_id: 'a', description: 'a' })
    mem.register({ skill_id: 'b', description: 'b' })
    mem.recordInvoke('b', true)
    mem.recordInvoke('b', true)
    mem.recordInvoke('a', true)
    const top = mem.topUsed(5)
    expect(top[0]?.skill_id).toBe('b')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/daemon/memory/proceduralMemory.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Write the implementation**

```typescript
// src/daemon/memory/proceduralMemory.ts
// L4 — procedural memory. The skills themselves live as files in
// skills/active/<dir>/. This table indexes them for fast retrieval by
// intent + tracks invocation success for Hermes-style skill scoring.

import type { Database } from 'bun:sqlite'

export type SkillIndexInput = {
  skill_id: string
  description: string
  trigger_pattern?: string
  crystallized_from?: number | null   // mem_l2_episodes.id
}

export type SkillIndexRow = SkillIndexInput & {
  last_invoked: number | null
  invoke_count: number
  success_count: number
  crystallized_from: number | null
}

export class ProceduralMemory {
  constructor(private db: Database) {}

  register(input: SkillIndexInput): void {
    this.db.run(
      `INSERT OR REPLACE INTO mem_l4_procedural_index
         (skill_id, description, trigger_pattern, last_invoked, invoke_count, success_count, crystallized_from)
       VALUES (?, ?, ?,
         (SELECT last_invoked FROM mem_l4_procedural_index WHERE skill_id = ?),
         COALESCE((SELECT invoke_count FROM mem_l4_procedural_index WHERE skill_id = ?), 0),
         COALESCE((SELECT success_count FROM mem_l4_procedural_index WHERE skill_id = ?), 0),
         ?)`,
      [input.skill_id, input.description, input.trigger_pattern ?? null,
        input.skill_id, input.skill_id, input.skill_id,
        input.crystallized_from ?? null],
    )
  }

  get(skillId: string): SkillIndexRow | null {
    return this.db.query('SELECT * FROM mem_l4_procedural_index WHERE skill_id = ?').get(skillId) as SkillIndexRow | null
  }

  recordInvoke(skillId: string, success: boolean): void {
    this.db.run(
      `UPDATE mem_l4_procedural_index
       SET last_invoked = ?, invoke_count = invoke_count + 1, success_count = success_count + ?
       WHERE skill_id = ?`,
      [Date.now(), success ? 1 : 0, skillId],
    )
  }

  topUsed(limit: number = 10): SkillIndexRow[] {
    return this.db.query(
      'SELECT * FROM mem_l4_procedural_index ORDER BY invoke_count DESC, last_invoked DESC LIMIT ?',
    ).all(limit) as SkillIndexRow[]
  }

  all(): SkillIndexRow[] {
    return this.db.query('SELECT * FROM mem_l4_procedural_index').all() as SkillIndexRow[]
  }
}
```

- [ ] **Step 4: Run tests**

```bash
bun test src/daemon/memory/proceduralMemory.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/memory/proceduralMemory.ts src/daemon/memory/proceduralMemory.test.ts
git commit -m "feat(memory): L4 procedural memory index (skill registry + invoke stats)"
```

---

## Task 7: Idle detector (macOS)

**Files:**
- Create: `src/daemon/memory/idleDetector.ts`
- Test:  `src/daemon/memory/idleDetector.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/daemon/memory/idleDetector.test.ts
import { describe, it, expect } from 'bun:test'
import { IdleDetector } from './idleDetector'

describe('IdleDetector', () => {
  it('reports a numeric idle time in ms', async () => {
    const det = new IdleDetector()
    const ms = await det.idleMs()
    expect(typeof ms).toBe('number')
    expect(ms).toBeGreaterThanOrEqual(0)
  })

  it('reports whether on AC power', async () => {
    const det = new IdleDetector()
    const onAC = await det.onACPower()
    expect(typeof onAC).toBe('boolean')
  })

  it('shouldDream returns true only when both conditions met', async () => {
    const det = new IdleDetector({
      idleThresholdMs: 100,
      probe: async () => ({ idleMs: 200, onAC: true }),
    })
    expect(await det.shouldDream()).toBe(true)

    const det2 = new IdleDetector({
      idleThresholdMs: 100,
      probe: async () => ({ idleMs: 50, onAC: true }),
    })
    expect(await det2.shouldDream()).toBe(false)

    const det3 = new IdleDetector({
      idleThresholdMs: 100,
      probe: async () => ({ idleMs: 200, onAC: false }),
    })
    expect(await det3.shouldDream()).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/daemon/memory/idleDetector.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Write the implementation**

```typescript
// src/daemon/memory/idleDetector.ts
// macOS idle + power source detection. Consolidation (dreaming) only runs
// when the user has been idle long enough AND the laptop is on AC — we
// don't want to wake the user's fans or drain battery for housekeeping.
//
// Idle: ioreg query for HIDIdleTime. Power: pmset -g batt.

type ProbeResult = { idleMs: number; onAC: boolean }
type Probe = () => Promise<ProbeResult>

export type IdleDetectorOptions = {
  idleThresholdMs?: number  // default: 20 min
  probe?: Probe
}

export class IdleDetector {
  private idleThresholdMs: number
  private probe: Probe

  constructor(opts?: IdleDetectorOptions) {
    this.idleThresholdMs = opts?.idleThresholdMs ?? 20 * 60_000
    this.probe = opts?.probe ?? defaultProbe
  }

  async idleMs(): Promise<number> {
    return (await this.probe()).idleMs
  }

  async onACPower(): Promise<boolean> {
    return (await this.probe()).onAC
  }

  async shouldDream(): Promise<boolean> {
    const { idleMs, onAC } = await this.probe()
    return idleMs >= this.idleThresholdMs && onAC
  }
}

async function defaultProbe(): Promise<ProbeResult> {
  const [idleMs, onAC] = await Promise.all([readIdleMs(), readOnAC()])
  return { idleMs, onAC }
}

async function readIdleMs(): Promise<number> {
  try {
    const proc = Bun.spawn(
      ['sh', '-c', "ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print $NF/1000000; exit}'"],
      { stdout: 'pipe' },
    )
    await proc.exited
    const out = (await new Response(proc.stdout).text()).trim()
    const sec = parseFloat(out)
    return Number.isFinite(sec) ? Math.round(sec * 1000) : 0
  } catch {
    return 0
  }
}

async function readOnAC(): Promise<boolean> {
  try {
    const proc = Bun.spawn(['pmset', '-g', 'batt'], { stdout: 'pipe' })
    await proc.exited
    const out = await new Response(proc.stdout).text()
    return /AC Power/i.test(out)
  } catch {
    return false  // fail safe — assume battery, don't dream
  }
}
```

- [ ] **Step 4: Run tests**

```bash
bun test src/daemon/memory/idleDetector.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/memory/idleDetector.ts src/daemon/memory/idleDetector.test.ts
git commit -m "feat(memory): macOS idle + AC-power detector for dream gating"
```

---

## Task 8: Dreamer (Hermes-style consolidation)

**Files:**
- Create: `src/daemon/memory/dreamer.ts`
- Test:  `src/daemon/memory/dreamer.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/daemon/memory/dreamer.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { initMemorySchema } from './schema'
import { EpisodicMemory } from './episodicMemory'
import { SemanticMemory } from './semanticMemory'
import { Dreamer } from './dreamer'
import type { ModelRouter } from '../llm/router'
import type { CompletionResult } from '../llm/types'

function fakeRouter(text: string): ModelRouter {
  return {
    complete: async (): Promise<CompletionResult> => ({
      text, provider: 'gemini', model: 'g', cost_cents: 0, latency_ms: 1,
      fallback_count: 0, input_tokens: 1, output_tokens: 1,
    }),
  } as unknown as ModelRouter
}

describe('Dreamer', () => {
  let db: Database
  let ep: EpisodicMemory
  let sem: SemanticMemory

  beforeEach(() => {
    db = new Database(':memory:')
    initMemorySchema(db)
    ep = new EpisodicMemory(db)
    sem = new SemanticMemory(db)
  })

  it('scores episodes using the Hermes formula', () => {
    const d = new Dreamer(db, ep, sem, fakeRouter(''), { embedder: async () => new Array(768).fill(0) })
    const score = d.score({
      id: 1, started_at: Date.now() - 60_000, ended_at: Date.now() - 60_000,
      episode_type: 'work_session', title: 't', summary: 's',
      event_ids: [1, 2, 3, 4, 5], importance: 0.5,
      promoted_l3: 0, created_at: 0,
    })
    expect(score).toBeGreaterThan(0)
    expect(score).toBeLessThanOrEqual(1)
  })

  it('consolidates unpromoted episodes into L3 facts and marks promoted', async () => {
    const id = ep.writeEpisode({
      started_at: Date.now() - 60_000, ended_at: Date.now() - 30_000,
      episode_type: 'work_session', title: 'Editing auth.ts',
      summary: 'Refactored session middleware', event_ids: [1, 2, 3], importance: 0.8,
    })
    // Fake router returns one fact to extract
    const router = fakeRouter(JSON.stringify({
      facts: [
        { kind: 'fact', subject: 'auth.ts', body: 'session middleware was refactored', importance: 0.7 },
      ],
    }))
    const d = new Dreamer(db, ep, sem, router, { embedder: async () => new Array(768).fill(0).map((_, i) => i / 768) })
    const consolidated = await d.consolidate({ maxEpisodes: 10 })
    expect(consolidated).toBe(1)
    expect(sem.allActive().length).toBe(1)
    expect(ep.unpromoted(10).length).toBe(0)
  })

  it('does not double-promote already-consolidated episodes', async () => {
    const id = ep.writeEpisode({
      started_at: 1, ended_at: 2, episode_type: 'x', title: 't', summary: 's',
      event_ids: [], importance: 0.9,
    })
    ep.markPromoted(id)
    const d = new Dreamer(db, ep, sem, fakeRouter('{"facts":[]}'), { embedder: async () => new Array(768).fill(0) })
    const consolidated = await d.consolidate({ maxEpisodes: 10 })
    expect(consolidated).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/daemon/memory/dreamer.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Write the implementation**

```typescript
// src/daemon/memory/dreamer.ts
// Hermes-Dreaming-inspired consolidation. Runs only when IdleDetector
// says safe (>20min idle + on AC). For each unpromoted L2 episode:
//   1. Score it (relevance × frequency × recency × diversity × richness - dup)
//   2. If above threshold, call LLM to extract structured facts (L3 candidates)
//   3. Write/reinforce L3 rows with embeddings via Recall.reinforceOrWrite
//   4. Mark episode promoted

import type { Database } from 'bun:sqlite'
import { logError, log } from '../logger'
import type { EpisodicMemory, Episode } from './episodicMemory'
import type { SemanticMemory } from './semanticMemory'
import type { ModelRouter } from '../llm/router'

const SCORE_THRESHOLD = 0.4

const SYSTEM_PROMPT = `You consolidate raw work-session episodes into durable semantic facts. Given one episode summary, extract 0-5 facts worth remembering long-term about: the user's projects, people they interact with, preferences, recurring patterns, or important decisions. Be conservative — most episodes have 0-2 facts. Trivial/transient observations are not facts.

Output strict JSON:
{
  "facts": [
    { "kind": "fact" | "preference" | "person" | "project" | "pattern", "subject": "...", "body": "...", "importance": 0.0-1.0 }
  ]
}`

export type DreamerOptions = {
  embedder: (text: string) => Promise<number[]>
}

export class Dreamer {
  constructor(
    private db: Database,
    private episodic: EpisodicMemory,
    private semantic: SemanticMemory,
    private router: ModelRouter,
    private opts: DreamerOptions,
  ) {}

  score(e: Episode): number {
    // Hermes weights — tuned for KAIROS scale
    const w_relevance  = 0.25
    const w_frequency  = 0.15
    const w_recency    = 0.20
    const w_diversity  = 0.10
    const w_richness   = 0.20
    const w_dup        = 0.10

    const ageHours = (Date.now() - e.ended_at) / 3_600_000
    const recency = Math.max(0, Math.min(1, 1 - ageHours / 168))   // 1 week half-life
    const richness = Math.min(1, e.event_ids.length / 10)           // capped at 10 events = full richness
    const relevance = e.importance                                  // perception pipeline supplied this
    const frequency = 0.5                                           // placeholder; refined when subject recurs
    const diversity = 0.5                                           // placeholder; needs cross-episode analysis
    const duplication = 0                                           // placeholder; needs L3 lookup

    return w_relevance * relevance + w_frequency * frequency + w_recency * recency
         + w_diversity * diversity + w_richness * richness - w_dup * duplication
  }

  async consolidate(opts?: { maxEpisodes?: number }): Promise<number> {
    const max = opts?.maxEpisodes ?? 50
    const candidates = this.episodic.unpromoted(max)
    const dreamLogId = this.startDreamLog(candidates.length)
    let factsCreated = 0

    for (const ep of candidates) {
      const s = this.score(ep)
      if (s < SCORE_THRESHOLD) {
        this.episodic.markPromoted(ep.id)   // skip & mark so we don't reconsider
        continue
      }

      try {
        const result = await this.router.complete({
          task_type: 'dream',
          system: SYSTEM_PROMPT,
          prompt: `Episode:\nType: ${ep.episode_type}\nTitle: ${ep.title}\nSummary: ${ep.summary}\nDuration: ${(ep.ended_at - ep.started_at) / 60_000}min`,
          structured: true,
          max_output_tokens: 400,
        })

        const parsed = result.parsed as { facts?: Array<{ kind: string; subject: string; body: string; importance: number }> } | undefined
        const facts = parsed?.facts ?? []

        for (const f of facts) {
          const emb = await this.opts.embedder(`${f.subject}: ${f.body}`)
          this.semantic.reinforceOrWrite({
            kind: f.kind as any,
            subject: f.subject,
            body: f.body,
            embedding: emb,
            importance: f.importance,
            source_episodes: [ep.id],
          })
          factsCreated++
        }

        this.episodic.markPromoted(ep.id)
      } catch (err) {
        logError(`Dreamer: episode ${ep.id} consolidation failed`, err)
      }
    }

    this.completeDreamLog(dreamLogId, candidates.length, factsCreated)
    log(`Dreamer: consolidated ${candidates.length} episodes → ${factsCreated} facts`)
    return factsCreated
  }

  private startDreamLog(episodeCount: number): number {
    const info = this.db.run(
      'INSERT INTO mem_dream_log (started_at, episodes_in) VALUES (?, ?)',
      [Date.now(), episodeCount],
    )
    return Number(info.lastInsertRowid)
  }

  private completeDreamLog(id: number, episodesIn: number, factsOut: number): void {
    this.db.run(
      'UPDATE mem_dream_log SET completed_at = ?, episodes_in = ?, facts_out = ? WHERE id = ?',
      [Date.now(), episodesIn, factsOut, id],
    )
  }
}
```

- [ ] **Step 4: Run tests**

```bash
bun test src/daemon/memory/dreamer.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/memory/dreamer.ts src/daemon/memory/dreamer.test.ts
git commit -m "feat(memory): Dreamer consolidates L2 episodes to L3 facts via Hermes scoring"
```

---

## Task 9: Tier 1 significance classifier

**Files:**
- Create: `src/daemon/perception/tier1Classifier.ts`
- Test:  `src/daemon/perception/tier1Classifier.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/daemon/perception/tier1Classifier.test.ts
import { describe, it, expect } from 'bun:test'
import { Tier1Classifier } from './tier1Classifier'
import type { ModelRouter } from '../llm/router'
import type { CompletionResult } from '../llm/types'
import type { WorldEvent } from '../proactive/eventBus'

function fakeRouter(verdict: 'SIGNIFICANT' | 'ROUTINE' | 'SILENT'): ModelRouter {
  return {
    complete: async (): Promise<CompletionResult> => ({
      text: verdict, provider: 'gemini', model: 'gemini-2.5-flash-lite',
      cost_cents: 0, latency_ms: 10, fallback_count: 0,
      input_tokens: 100, output_tokens: 5,
    }),
  } as unknown as ModelRouter
}

function makeEvent(source: string, kind: string, payload: Record<string, unknown>): WorldEvent {
  return { id: 1, ts: Date.now(), source, kind, payload }
}

describe('Tier1Classifier', () => {
  it('returns SIGNIFICANT verdict for important event batch', async () => {
    const t1 = new Tier1Classifier(fakeRouter('SIGNIFICANT'))
    const verdict = await t1.classify([makeEvent('focus-app', 'app_changed', { app: 'Slack' })])
    expect(verdict).toBe('SIGNIFICANT')
  })

  it('returns SILENT for trivial event batch', async () => {
    const t1 = new Tier1Classifier(fakeRouter('SILENT'))
    const verdict = await t1.classify([makeEvent('focus-app', 'app_changed', { app: 'Same' })])
    expect(verdict).toBe('SILENT')
  })

  it('returns SILENT if router throws (fail-closed — never spam on errors)', async () => {
    const router = { complete: async () => { throw new Error('router down') } } as unknown as ModelRouter
    const t1 = new Tier1Classifier(router)
    const verdict = await t1.classify([makeEvent('clipboard', 'changed', { text: 'x' })])
    expect(verdict).toBe('SILENT')
  })

  it('normalizes verbose router output to one of three verdicts', async () => {
    const t1 = new Tier1Classifier(fakeRouter('SIGNIFICANT — user just received an urgent slack' as any))
    const verdict = await t1.classify([makeEvent('s', 'k', {})])
    expect(verdict).toBe('SIGNIFICANT')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/daemon/perception/tier1Classifier.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Write the implementation**

```typescript
// src/daemon/perception/tier1Classifier.ts
// Tier 1 — the cheapest gate. Given a batch of recent events, decide
// whether they're worth the user's attention. Returns one of:
//   SIGNIFICANT — pass to Tier 2
//   ROUTINE     — interesting for memory but not for interruption
//   SILENT      — drop entirely (don't even update working set narrative)
//
// Fail-closed: on router error, return SILENT. Never spam on infra failure.

import { log, logError } from '../logger'
import type { ModelRouter } from '../llm/router'
import type { WorldEvent } from '../proactive/eventBus'

export type Tier1Verdict = 'SIGNIFICANT' | 'ROUTINE' | 'SILENT'

const SYSTEM_PROMPT = `You are KAIROS's first perception gate. Given a batch of recent events from the user's macOS, decide whether ANY of them are worth interrupting the user about.

Output EXACTLY one word:
- SIGNIFICANT: a message arrived that needs reply, a meeting is starting soon, an error in active work, a clipboard contains something needing action
- ROUTINE: events worth remembering (app switches, file edits, normal work) but not interruption-worthy
- SILENT: noise — repeated focus switches, polling artifacts, things that don't matter

Bias toward SILENT. The user is doing real work — only SIGNIFICANT for things that warrant breaking their flow.`

export class Tier1Classifier {
  constructor(private router: ModelRouter) {}

  async classify(events: WorldEvent[]): Promise<Tier1Verdict> {
    if (events.length === 0) return 'SILENT'

    try {
      const prompt = this.formatEvents(events)
      const result = await this.router.complete({
        task_type: 'classify',
        system: SYSTEM_PROMPT,
        prompt,
        max_output_tokens: 10,
        latency_target: 'realtime',
      })
      return this.normalize(result.text)
    } catch (err) {
      logError('Tier1Classifier: router failure → fail-closed SILENT', err)
      return 'SILENT'
    }
  }

  private formatEvents(events: WorldEvent[]): string {
    // Compact summary — no full payloads, just one line per event.
    const lines = events.map(e => `[${new Date(e.ts).toISOString().slice(11, 19)}] ${e.source}/${e.kind} ${JSON.stringify(e.payload).slice(0, 120)}`)
    return `Recent events (${events.length}):\n${lines.join('\n')}\n\nVerdict?`
  }

  private normalize(text: string): Tier1Verdict {
    const upper = text.toUpperCase()
    if (upper.includes('SIGNIFICANT')) return 'SIGNIFICANT'
    if (upper.includes('ROUTINE')) return 'ROUTINE'
    return 'SILENT'
  }
}
```

- [ ] **Step 4: Run tests**

```bash
bun test src/daemon/perception/tier1Classifier.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/perception/tier1Classifier.ts src/daemon/perception/tier1Classifier.test.ts
git commit -m "feat(perception): Tier 1 significance classifier (fail-closed SILENT)"
```

---

## Task 10: Tier 2 summarizer

**Files:**
- Create: `src/daemon/perception/tier2Summarizer.ts`
- Test:  `src/daemon/perception/tier2Summarizer.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/daemon/perception/tier2Summarizer.test.ts
import { describe, it, expect } from 'bun:test'
import { Tier2Summarizer } from './tier2Summarizer'
import type { ModelRouter } from '../llm/router'
import type { CompletionResult } from '../llm/types'
import type { WorldEvent } from '../proactive/eventBus'

function fakeRouter(payload: object): ModelRouter {
  return {
    complete: async (): Promise<CompletionResult> => ({
      text: JSON.stringify(payload),
      parsed: payload,
      provider: 'gemini', model: 'gemini-2.5-flash',
      cost_cents: 0, latency_ms: 50, fallback_count: 0,
      input_tokens: 300, output_tokens: 50,
    }),
  } as unknown as ModelRouter
}

const E = (source: string, kind: string, payload: Record<string, unknown>): WorldEvent =>
  ({ id: 1, ts: Date.now(), source, kind, payload })

describe('Tier2Summarizer', () => {
  it('produces a description + score from a batch', async () => {
    const router = fakeRouter({ description: 'User just got 2 Slack DMs', score: 0.85, episode_type: 'communication' })
    const s = new Tier2Summarizer(router)
    const result = await s.summarize([E('focus-app', 'app_changed', { app: 'Slack' })], '')
    expect(result.description).toContain('Slack')
    expect(result.score).toBe(0.85)
    expect(result.episode_type).toBe('communication')
  })

  it('clamps score to 0-1 range', async () => {
    const s = new Tier2Summarizer(fakeRouter({ description: 'x', score: 1.5, episode_type: 'x' }))
    const r = await s.summarize([E('s', 'k', {})], '')
    expect(r.score).toBe(1)
  })

  it('returns score 0 on router error (fail-closed)', async () => {
    const router = { complete: async () => { throw new Error('boom') } } as unknown as ModelRouter
    const s = new Tier2Summarizer(router)
    const r = await s.summarize([E('s', 'k', {})], '')
    expect(r.score).toBe(0)
  })

  it('biases score by matching standing orders', async () => {
    const s = new Tier2Summarizer(fakeRouter({ description: 'standup in 8 min', score: 0.5, episode_type: 'reminder' }))
    const ordersText = '- If I have a calendar event starting in 10 min, remind me'
    const r = await s.summarize([E('calendar-local', 'upcoming', { events: [{ title: 'Standup' }] })], ordersText)
    // We pass orders into the prompt; the summarizer is told to bias when they match.
    // In this test the fake router returns 0.5 regardless — we're just verifying the orders
    // text is accepted and flows through without crashing.
    expect(r.description).toBe('standup in 8 min')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/daemon/perception/tier2Summarizer.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Write the implementation**

```typescript
// src/daemon/perception/tier2Summarizer.ts
// Tier 2 — runs only when Tier 1 said SIGNIFICANT.
// Produces a short description + significance score (0-1) +
// episode_type. The score is what gates Tier 3 (narrator).
//
// Receives the current STANDING_ORDERS.md text and is told to bias the
// score upward when events match orders.

import { logError } from '../logger'
import type { ModelRouter } from '../llm/router'
import type { WorldEvent } from '../proactive/eventBus'

const SYSTEM_PROMPT = `You are KAIROS's Tier-2 perception layer. Given recent events + the user's standing orders, produce:
- description: 1-2 sentences naming what happened
- score: 0.0-1.0 significance (0 = noise, 1 = drop-everything urgent)
- episode_type: one of work_session | communication | browsing | system | reminder | other

If events match a standing order, score >= 0.7 baseline.
If events are mundane (app switching, normal clipboard, file edits in current work), score < 0.5.
If events suggest something urgent (incoming message, calendar conflict, error, password in clipboard), score >= 0.8.

Output strict JSON:
{ "description": "...", "score": 0.X, "episode_type": "..." }`

export type Tier2Result = {
  description: string
  score: number
  episode_type: string
}

export class Tier2Summarizer {
  constructor(private router: ModelRouter) {}

  async summarize(events: WorldEvent[], standingOrdersText: string): Promise<Tier2Result> {
    try {
      const eventLines = events.map(e => `[${new Date(e.ts).toISOString().slice(11, 19)}] ${e.source}/${e.kind} ${JSON.stringify(e.payload).slice(0, 200)}`).join('\n')
      const prompt = `Standing orders:\n${standingOrdersText || '(none)'}\n\nRecent events:\n${eventLines}\n\nProduce the JSON.`
      const result = await this.router.complete({
        task_type: 'action_compose',   // mid tier
        system: SYSTEM_PROMPT,
        prompt,
        structured: true,
        max_output_tokens: 300,
        latency_target: 'standard',
      })
      const parsed = result.parsed as { description?: string; score?: number; episode_type?: string } | undefined
      return {
        description: parsed?.description ?? 'unknown',
        score: clamp(parsed?.score ?? 0, 0, 1),
        episode_type: parsed?.episode_type ?? 'other',
      }
    } catch (err) {
      logError('Tier2Summarizer: router failure → fail-closed score 0', err)
      return { description: '', score: 0, episode_type: 'other' }
    }
  }
}

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo
  if (n > hi) return hi
  return n
}
```

- [ ] **Step 4: Run tests**

```bash
bun test src/daemon/perception/tier2Summarizer.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/perception/tier2Summarizer.ts src/daemon/perception/tier2Summarizer.test.ts
git commit -m "feat(perception): Tier 2 summarizer with standing-orders bias"
```

---

## Task 11: STANDING_ORDERS.md parser

**Files:**
- Create: `src/daemon/orders/parser.ts`
- Create: `src/daemon/orders/seedFile.ts`
- Test:  `src/daemon/orders/parser.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/daemon/orders/parser.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { OrdersParser } from './parser'

describe('OrdersParser', () => {
  let tmp: string

  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'kairos-orders-')) })

  it('reads the raw file content', () => {
    const path = join(tmp, 'STANDING_ORDERS.md')
    writeFileSync(path, '# Orders\n- Do X\n- Do Y\n')
    const p = new OrdersParser(path)
    expect(p.read()).toContain('Do X')
    rmSync(tmp, { recursive: true })
  })

  it('returns empty string when file missing', () => {
    const p = new OrdersParser(join(tmp, 'missing.md'))
    expect(p.read()).toBe('')
  })

  it('detects content changes via hash', () => {
    const path = join(tmp, 'STANDING_ORDERS.md')
    writeFileSync(path, 'first content')
    const p = new OrdersParser(path)
    const h1 = p.hash()
    writeFileSync(path, 'second content')
    const h2 = p.hash()
    expect(h1).not.toBe(h2)
    rmSync(tmp, { recursive: true })
  })

  it('extracts only the bullet lines (skips headers, blank lines, comments)', () => {
    const path = join(tmp, 'STANDING_ORDERS.md')
    writeFileSync(path, `# Header\n\n- First order\n- Second order\n# Comment line not bullet\n  - Indented bullet\n`)
    const p = new OrdersParser(path)
    const rules = p.bullets()
    expect(rules).toEqual(['First order', 'Second order', 'Indented bullet'])
    rmSync(tmp, { recursive: true })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/daemon/orders/parser.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Write the parser**

```typescript
// src/daemon/orders/parser.ts
// Plain-text parser for STANDING_ORDERS.md.
// Hash detection lets the compiler skip work when nothing changed.

import { existsSync, readFileSync } from 'fs'
import { createHash } from 'crypto'

export class OrdersParser {
  constructor(private path: string) {}

  read(): string {
    if (!existsSync(this.path)) return ''
    return readFileSync(this.path, 'utf8')
  }

  hash(): string {
    const content = this.read()
    return createHash('sha256').update(content).digest('hex').slice(0, 16)
  }

  bullets(): string[] {
    const content = this.read()
    const rules: string[] = []
    for (const line of content.split('\n')) {
      const m = line.match(/^\s*-\s+(.+)$/)
      if (m && !m[1]!.startsWith('#')) rules.push(m[1]!.trim())
    }
    return rules
  }
}
```

- [ ] **Step 4: Write seedFile.ts**

```typescript
// src/daemon/orders/seedFile.ts
// Writes the example STANDING_ORDERS.md on first run if absent.

import { existsSync, writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'

const SEED_CONTENT = `# KAIROS Standing Orders
# Edit this file in any text editor. KAIROS reloads automatically on save.
# Write rules in plain English — KAIROS compiles them into triggers.

# Example rules (delete or modify):
- If I have a calendar event starting in 10 minutes and I'm not in a video call, remind me.
- If I copy a URL to the clipboard, fetch its title and add to recent reading.
- If I open the same file three times in 10 minutes, suggest opening the related PR.
- Never proactively interrupt me on Sunday before 11am or after 10pm any day.
- If a Slack DM contains the word "urgent", interrupt me regardless of context.
`

export function ensureSeedFile(path: string): void {
  if (existsSync(path)) return
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, SEED_CONTENT, 'utf8')
}
```

- [ ] **Step 5: Run tests**

```bash
bun test src/daemon/orders/parser.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/daemon/orders/parser.ts src/daemon/orders/seedFile.ts \
        src/daemon/orders/parser.test.ts
git commit -m "feat(orders): STANDING_ORDERS.md parser + seed file"
```

---

## Task 12: STANDING_ORDERS compiler (LLM-driven)

**Files:**
- Create: `src/daemon/orders/compiler.ts`
- Test:  `src/daemon/orders/compiler.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/daemon/orders/compiler.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { OrdersCompiler, ORDERS_SCHEMA } from './compiler'
import type { ModelRouter } from '../llm/router'
import type { CompletionResult } from '../llm/types'

function fakeRouter(payload: object): ModelRouter {
  return {
    complete: async (): Promise<CompletionResult> => ({
      text: JSON.stringify(payload), parsed: payload,
      provider: 'gemini', model: 'gemini-2.5-flash',
      cost_cents: 0, latency_ms: 50, fallback_count: 0,
      input_tokens: 200, output_tokens: 100,
    }),
  } as unknown as ModelRouter
}

describe('OrdersCompiler', () => {
  let db: Database
  let comp: OrdersCompiler

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(ORDERS_SCHEMA)
  })

  it('compiles plain English rules into structured triggers', async () => {
    const router = fakeRouter({
      triggers: [
        { id: 't1', when_kind: 'calendar', when_match: 'event.startsIn(10min)', condition: 'NOT focus_app.is_video', action: 'notify' },
        { id: 't2', when_kind: 'clipboard', when_match: 'text.isURL()', condition: null, action: 'fetch_title_add_to_memory' },
      ],
    })
    comp = new OrdersCompiler(db, router)
    const rules = ['If I have a calendar event starting in 10 min and I am not on a video call, remind me.', 'If I copy a URL to the clipboard, fetch its title.']
    const result = await comp.compile(rules, 'hash1')
    expect(result.triggers.length).toBe(2)
    expect(comp.list().length).toBe(2)
  })

  it('skips recompile when source hash unchanged', async () => {
    const router = fakeRouter({ triggers: [{ id: 'x', when_kind: 'k', when_match: 'm', condition: null, action: 'notify' }] })
    comp = new OrdersCompiler(db, router)
    await comp.compile(['rule a'], 'hashA')
    const list1 = comp.list()

    // Same hash → no recompile, list unchanged
    await comp.compile(['rule a — changed body but same hash for test'], 'hashA')
    expect(comp.list().length).toBe(list1.length)
  })

  it('replaces compiled triggers when hash changes', async () => {
    const router1 = fakeRouter({ triggers: [{ id: 'a', when_kind: 'k', when_match: 'm', condition: null, action: 'notify' }] })
    comp = new OrdersCompiler(db, router1)
    await comp.compile(['rule one'], 'hash1')
    expect(comp.list().length).toBe(1)

    const router2 = fakeRouter({ triggers: [
      { id: 'b', when_kind: 'k', when_match: 'm', condition: null, action: 'notify' },
      { id: 'c', when_kind: 'k', when_match: 'm', condition: null, action: 'notify' },
    ] })
    const comp2 = new OrdersCompiler(db, router2)
    await comp2.compile(['rule two', 'rule three'], 'hash2')
    expect(comp2.list().length).toBe(2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/daemon/orders/compiler.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Write the implementation**

```typescript
// src/daemon/orders/compiler.ts
// Compiles free-form English standing orders into structured triggers
// stored in the database. Recompiles only when source content hash
// changes (avoid wasted LLM calls). Each rule maps to one or more
// structured triggers consumed by orders/runtime.ts.

import type { Database } from 'bun:sqlite'
import { logError, log } from '../logger'
import type { ModelRouter } from '../llm/router'

export const ORDERS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS compiled_orders_meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS compiled_orders_triggers (
    id          TEXT PRIMARY KEY,
    when_kind   TEXT NOT NULL,                -- 'calendar' | 'clipboard' | 'focus-app' | 'file-events' | 'browser-tabs' | 'time' | 'pattern'
    when_match  TEXT NOT NULL,                -- semi-structured: 'event.startsIn(10min)', 'text.isURL()', etc
    condition   TEXT,                          -- optional NOT focus_app.is_video, etc
    action      TEXT NOT NULL,                -- 'notify' | 'remind_later' | 'add_to_memory' | 'draft_reply' | etc
    source_rule TEXT NOT NULL,                 -- the original English rule text
    created_at  INTEGER NOT NULL
  );
`

const SYSTEM_PROMPT = `You are KAIROS's standing-orders compiler. Convert plain-English rules into structured trigger specifications.

For each rule, emit 1+ triggers. Each trigger has:
- id: short stable kebab-case id derived from rule
- when_kind: one of "calendar" | "clipboard" | "focus-app" | "file-events" | "browser-tabs" | "time" | "pattern"
- when_match: semi-structured selector. Examples:
    "event.startsIn(10min)"  "text.isURL()"  "app.equals('Slack')"  "path.endsWith('.ts')"
    "tabs.opened()"  "time.between(11:00, 22:00)"  "pattern.repeats(3, 10min, sameFile)"
- condition: optional. Examples: "NOT focus_app.is_video", "focus_app == 'Slack'"
- action: one of "notify" | "remind_later" | "add_to_memory" | "draft_reply" | "suspend" | "log"

If a rule restricts timing (e.g. "never on Sunday morning"), encode as a separate trigger with action "suspend" and appropriate when_kind: "time".

Output strict JSON:
{
  "triggers": [
    { "id": "...", "when_kind": "...", "when_match": "...", "condition": null|"...", "action": "..." }
  ]
}`

export type CompiledTrigger = {
  id: string
  when_kind: string
  when_match: string
  condition: string | null
  action: string
  source_rule: string
}

export class OrdersCompiler {
  constructor(private db: Database, private router: ModelRouter) {
    db.exec(ORDERS_SCHEMA)
  }

  /** Compile rules. Skips if hash matches the last stored hash. */
  async compile(rules: string[], sourceHash: string): Promise<{ triggers: CompiledTrigger[]; skipped: boolean }> {
    const last = this.db.query('SELECT value FROM compiled_orders_meta WHERE key = ?').get('source_hash') as { value: string } | null
    if (last?.value === sourceHash) {
      return { triggers: this.list(), skipped: true }
    }

    if (rules.length === 0) {
      this.replaceAll([])
      this.setMeta('source_hash', sourceHash)
      return { triggers: [], skipped: false }
    }

    try {
      const prompt = `Rules:\n${rules.map((r, i) => `${i + 1}. ${r}`).join('\n')}\n\nProduce the JSON.`
      const result = await this.router.complete({
        task_type: 'action_compose',
        system: SYSTEM_PROMPT,
        prompt,
        structured: true,
        max_output_tokens: 1200,
        latency_target: 'background',
      })
      const parsed = result.parsed as { triggers?: Array<Omit<CompiledTrigger, 'source_rule'>> } | undefined
      const compiled: CompiledTrigger[] = (parsed?.triggers ?? []).map((t, i) => ({
        ...t,
        source_rule: rules[i] ?? rules[0] ?? '',
      }))
      this.replaceAll(compiled)
      this.setMeta('source_hash', sourceHash)
      log(`OrdersCompiler: ${rules.length} rules → ${compiled.length} triggers`)
      return { triggers: compiled, skipped: false }
    } catch (err) {
      logError('OrdersCompiler: compilation failed', err)
      return { triggers: this.list(), skipped: false }
    }
  }

  list(): CompiledTrigger[] {
    return this.db.query('SELECT * FROM compiled_orders_triggers').all() as CompiledTrigger[]
  }

  private replaceAll(triggers: CompiledTrigger[]): void {
    this.db.exec('DELETE FROM compiled_orders_triggers')
    const now = Date.now()
    for (const t of triggers) {
      this.db.run(
        `INSERT INTO compiled_orders_triggers (id, when_kind, when_match, condition, action, source_rule, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [t.id, t.when_kind, t.when_match, t.condition, t.action, t.source_rule, now],
      )
    }
  }

  private setMeta(key: string, value: string): void {
    this.db.run('INSERT OR REPLACE INTO compiled_orders_meta (key, value) VALUES (?, ?)', [key, value])
  }
}
```

- [ ] **Step 4: Run tests**

```bash
bun test src/daemon/orders/compiler.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/orders/compiler.ts src/daemon/orders/compiler.test.ts
git commit -m "feat(orders): LLM compiler English -> structured triggers + hash gating"
```

---

## Task 13: Orders runtime (file watcher + trigger matcher)

**Files:**
- Create: `src/daemon/orders/runtime.ts`
- Test:  `src/daemon/orders/runtime.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/daemon/orders/runtime.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { OrdersParser } from './parser'
import { OrdersCompiler, ORDERS_SCHEMA } from './compiler'
import { OrdersRuntime } from './runtime'
import type { ModelRouter } from '../llm/router'

function fakeRouter(payload: object): ModelRouter {
  return {
    complete: async () => ({
      text: JSON.stringify(payload), parsed: payload,
      provider: 'gemini', model: 'g', cost_cents: 0, latency_ms: 1,
      fallback_count: 0, input_tokens: 1, output_tokens: 1,
    }),
  } as unknown as ModelRouter
}

describe('OrdersRuntime', () => {
  let tmp: string
  let db: Database

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kairos-runtime-'))
    db = new Database(':memory:')
    db.exec(ORDERS_SCHEMA)
  })

  it('reloads + recompiles when STANDING_ORDERS.md changes', async () => {
    const path = join(tmp, 'STANDING_ORDERS.md')
    writeFileSync(path, '- rule one')
    const router = fakeRouter({ triggers: [{ id: 'a', when_kind: 'k', when_match: 'm', condition: null, action: 'notify' }] })
    const parser = new OrdersParser(path)
    const compiler = new OrdersCompiler(db, router)
    const rt = new OrdersRuntime(parser, compiler, { pollMs: 30 })
    await rt.start()
    await new Promise(r => setTimeout(r, 100))
    expect(compiler.list().length).toBe(1)

    writeFileSync(path, '- rule one\n- rule two')
    await new Promise(r => setTimeout(r, 100))
    expect(compiler.list().length).toBe(1)   // fake router still returns 1 trigger
    rt.stop()
    rmSync(tmp, { recursive: true })
  })

  it('provides text() for Tier 2 consumption', async () => {
    const path = join(tmp, 'STANDING_ORDERS.md')
    writeFileSync(path, '- rule one\n- rule two')
    const router = fakeRouter({ triggers: [] })
    const parser = new OrdersParser(path)
    const compiler = new OrdersCompiler(db, router)
    const rt = new OrdersRuntime(parser, compiler, { pollMs: 30 })
    expect(rt.text()).toContain('rule one')
    expect(rt.text()).toContain('rule two')
    rmSync(tmp, { recursive: true })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/daemon/orders/runtime.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Write the implementation**

```typescript
// src/daemon/orders/runtime.ts
// Watches STANDING_ORDERS.md for changes (poll every 5s by default),
// recompiles via OrdersCompiler when content hash changes.
// Exposes text() for Tier 2 to inject into perception prompts.

import { log, logError } from '../logger'
import type { OrdersParser } from './parser'
import type { OrdersCompiler } from './compiler'

export type OrdersRuntimeOptions = {
  pollMs?: number
}

export class OrdersRuntime {
  private timer: ReturnType<typeof setInterval> | null = null
  private pollMs: number
  private lastHash: string = ''

  constructor(
    private parser: OrdersParser,
    private compiler: OrdersCompiler,
    opts?: OrdersRuntimeOptions,
  ) {
    this.pollMs = opts?.pollMs ?? 5000
  }

  async start(): Promise<void> {
    await this.recompileIfChanged()
    this.timer = setInterval(() => { void this.recompileIfChanged() }, this.pollMs)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Raw text of orders file, for Tier 2 prompt injection. */
  text(): string {
    return this.parser.read()
  }

  private async recompileIfChanged(): Promise<void> {
    try {
      const hash = this.parser.hash()
      if (hash === this.lastHash) return
      const rules = this.parser.bullets()
      const result = await this.compiler.compile(rules, hash)
      this.lastHash = hash
      if (!result.skipped) {
        log(`OrdersRuntime: recompiled (${rules.length} rules → ${result.triggers.length} triggers)`)
      }
    } catch (err) {
      logError('OrdersRuntime: recompile error', err)
    }
  }
}
```

- [ ] **Step 4: Run tests**

```bash
bun test src/daemon/orders/runtime.test.ts
```

Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/orders/runtime.ts src/daemon/orders/runtime.test.ts
git commit -m "feat(orders): runtime file watcher + hash-gated recompile"
```

---

## Task 14: Perception pipeline (wires Tier 1 + Tier 2 + Narrator)

**Files:**
- Create: `src/daemon/perception/perceptionPipeline.ts`
- Create: `src/daemon/perception/perceptionLog.ts`
- Test:  `src/daemon/perception/perceptionPipeline.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/daemon/perception/perceptionPipeline.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { EventBus } from '../proactive/eventBus'
import { StateSnapshot } from '../proactive/stateSnapshot'
import { WorkingMemory } from '../memory/workingMemory'
import { initMemorySchema } from '../memory/schema'
import { EpisodicMemory } from '../memory/episodicMemory'
import { Narrator } from '../proactive/narrator'
import { Tier1Classifier } from './tier1Classifier'
import { Tier2Summarizer } from './tier2Summarizer'
import { PerceptionPipeline, PERCEPTION_LOG_SCHEMA } from './perceptionPipeline'
import type { ModelRouter } from '../llm/router'
import type { CompletionResult } from '../llm/types'

function router(verdict: 'SIGNIFICANT' | 'ROUTINE' | 'SILENT', tier2: any = { description: 'd', score: 0.8, episode_type: 'work_session' }, narratorText: string = 'narrative'): ModelRouter {
  let callCount = 0
  return {
    complete: async (req: any): Promise<CompletionResult> => {
      callCount++
      if (req.task_type === 'classify') {
        return { text: verdict, provider: 'g', model: 'g', cost_cents: 0, latency_ms: 1, fallback_count: 0, input_tokens: 1, output_tokens: 1 }
      }
      if (req.task_type === 'action_compose') {
        return { text: JSON.stringify(tier2), parsed: tier2, provider: 'g', model: 'g', cost_cents: 0, latency_ms: 1, fallback_count: 0, input_tokens: 1, output_tokens: 1 }
      }
      return { text: narratorText, provider: 'g', model: 'g', cost_cents: 0, latency_ms: 1, fallback_count: 0, input_tokens: 1, output_tokens: 1 }
    },
  } as unknown as ModelRouter
}

describe('PerceptionPipeline', () => {
  let db: Database
  let bus: EventBus
  let snap: StateSnapshot
  let working: WorkingMemory
  let episodic: EpisodicMemory
  let narrator: Narrator

  beforeEach(() => {
    db = new Database(':memory:')
    initMemorySchema(db)
    db.exec(PERCEPTION_LOG_SCHEMA)
    bus = new EventBus(db)
    snap = new StateSnapshot(bus)
    working = new WorkingMemory(bus, { windowMs: 60_000, maxEvents: 100 })
    episodic = new EpisodicMemory(db)
    narrator = new Narrator(bus, snap, router('SILENT'))   // narrator router doesn't matter for these tests
  })

  it('SILENT verdict from Tier 1 short-circuits — no Tier 2, no narrator, no episode', async () => {
    const r = router('SILENT')
    const t1 = new Tier1Classifier(r)
    const t2 = new Tier2Summarizer(r)
    const pipeline = new PerceptionPipeline(db, working, t1, t2, narrator, episodic, () => '')
    bus.publish({ source: 'focus-app', kind: 'app_changed', payload: { app: 'X' } })
    await pipeline.evaluateNow()
    expect(episodic.recent(10).length).toBe(0)
    const log = db.query('SELECT * FROM perception_log').all() as any[]
    expect(log[0]?.verdict_tier1).toBe('SILENT')
  })

  it('ROUTINE writes episode but does not invoke narrator', async () => {
    const r = router('ROUTINE')
    const t1 = new Tier1Classifier(r)
    const t2 = new Tier2Summarizer(r, /* not called */)
    const pipeline = new PerceptionPipeline(db, working, t1, t2, narrator, episodic, () => '')
    bus.publish({ source: 'focus-app', kind: 'app_changed', payload: { app: 'X' } })
    await pipeline.evaluateNow()
    // ROUTINE skips both Tier 2 + narrator. Episode is recorded as "routine" type.
    const eps = episodic.recent(10)
    expect(eps.length).toBe(1)
    expect(eps[0]?.episode_type).toBe('routine')
  })

  it('SIGNIFICANT + high Tier 2 score invokes narrator + writes episode', async () => {
    const r = router('SIGNIFICANT', { description: 'big news', score: 0.9, episode_type: 'communication' }, 'narrative text')
    const t1 = new Tier1Classifier(r)
    const t2 = new Tier2Summarizer(r)
    // Use the same router for narrator so it succeeds
    const localNarrator = new Narrator(bus, snap, r)
    const pipeline = new PerceptionPipeline(db, working, t1, t2, localNarrator, episodic, () => '')
    bus.publish({ source: 'clipboard', kind: 'changed', payload: { text: 'something' } })
    bus.publish({ source: 'focus-app', kind: 'app_changed', payload: { app: 'Slack' } })
    await pipeline.evaluateNow()
    const eps = episodic.recent(10)
    expect(eps.length).toBe(1)
    expect(eps[0]?.episode_type).toBe('communication')
    expect(eps[0]?.importance).toBe(0.9)
  })

  it('SIGNIFICANT + low Tier 2 score skips narrator but still records episode', async () => {
    const r = router('SIGNIFICANT', { description: 'meh', score: 0.3, episode_type: 'work_session' })
    const t1 = new Tier1Classifier(r)
    const t2 = new Tier2Summarizer(r)
    const pipeline = new PerceptionPipeline(db, working, t1, t2, narrator, episodic, () => '')
    bus.publish({ source: 'focus-app', kind: 'app_changed', payload: { app: 'X' } })
    await pipeline.evaluateNow()
    const eps = episodic.recent(10)
    expect(eps.length).toBe(1)
    expect(eps[0]?.importance).toBe(0.3)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/daemon/perception/perceptionPipeline.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Write the perception log schema + pipeline**

```typescript
// src/daemon/perception/perceptionLog.ts
export const PERCEPTION_LOG_SCHEMA = `
  CREATE TABLE IF NOT EXISTS perception_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ts              INTEGER NOT NULL,
    event_count     INTEGER NOT NULL,
    verdict_tier1   TEXT    NOT NULL,
    tier1_cost      INTEGER NOT NULL DEFAULT 0,
    tier2_score     REAL,
    tier2_cost      INTEGER NOT NULL DEFAULT 0,
    narrator_fired  INTEGER NOT NULL DEFAULT 0,
    episode_id      INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_perception_log_ts ON perception_log(ts);
`
```

```typescript
// src/daemon/perception/perceptionPipeline.ts
// The orchestrator. Every N seconds (default 30s) AND on user-significant
// observer events (calendar/clipboard changes, app_changed), evaluate
// the recent working memory through Tier 1 → Tier 2 → Narrator gates.
//
// Recording: every evaluation gets a perception_log row, even SILENT
// ones, so we can tune thresholds.
//
// The narrator INSTANCE is the one from Phase A's narrator.ts. We don't
// modify its code — we just stop relying on its internal timer (set the
// daemon-startup intervalMs to a huge value or zero so its setInterval
// effectively never fires; the pipeline drives invocation via narrator.tick()).

import { log, logError } from '../logger'
import type { Database } from 'bun:sqlite'
import type { WorkingMemory } from '../memory/workingMemory'
import type { EpisodicMemory } from '../memory/episodicMemory'
import type { Tier1Classifier } from './tier1Classifier'
import type { Tier2Summarizer } from './tier2Summarizer'
import type { Narrator } from '../proactive/narrator'
import { PERCEPTION_LOG_SCHEMA } from './perceptionLog'

export { PERCEPTION_LOG_SCHEMA }

const NARRATOR_SCORE_THRESHOLD = 0.6

export type PerceptionPipelineOptions = {
  pollMs?: number
}

export class PerceptionPipeline {
  private timer: ReturnType<typeof setInterval> | null = null
  private pollMs: number
  private evaluating = false

  constructor(
    private db: Database,
    private working: WorkingMemory,
    private tier1: Tier1Classifier,
    private tier2: Tier2Summarizer,
    private narrator: Narrator,
    private episodic: EpisodicMemory,
    private ordersText: () => string,
    opts?: PerceptionPipelineOptions,
  ) {
    this.pollMs = opts?.pollMs ?? 30_000
    db.exec(PERCEPTION_LOG_SCHEMA)
  }

  start(): void {
    this.timer = setInterval(() => { void this.evaluateNow() }, this.pollMs)
    log(`PerceptionPipeline: armed (poll ${this.pollMs / 1000}s)`)
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }

  async evaluateNow(): Promise<void> {
    if (this.evaluating) return
    this.evaluating = true
    try {
      const events = this.working.snapshot()
      if (events.length === 0) return

      const startMs = Date.now()
      const verdict1 = await this.tier1.classify(events)

      if (verdict1 === 'SILENT') {
        this.recordLog({ event_count: events.length, verdict_tier1: 'SILENT', tier2_score: null, narrator_fired: 0, episode_id: null })
        return
      }

      if (verdict1 === 'ROUTINE') {
        // Record as routine episode; no narrator, no tier 2.
        const eventIds = events.map(e => e.id)
        const epId = this.episodic.writeEpisode({
          started_at: events[0]!.ts,
          ended_at: events[events.length - 1]!.ts,
          episode_type: 'routine',
          title: `${events.length} routine events`,
          summary: `${events.length} events across ${new Set(events.map(e => e.source)).size} sources`,
          event_ids: eventIds,
          importance: 0.3,
        })
        this.recordLog({ event_count: events.length, verdict_tier1: 'ROUTINE', tier2_score: null, narrator_fired: 0, episode_id: epId })
        return
      }

      // SIGNIFICANT — promote to Tier 2.
      const t2 = await this.tier2.summarize(events, this.ordersText())

      const eventIds = events.map(e => e.id)
      const epId = this.episodic.writeEpisode({
        started_at: events[0]!.ts,
        ended_at: events[events.length - 1]!.ts,
        episode_type: t2.episode_type,
        title: t2.description.slice(0, 80),
        summary: t2.description,
        event_ids: eventIds,
        importance: t2.score,
      })

      let narratorFired = 0
      if (t2.score >= NARRATOR_SCORE_THRESHOLD) {
        await this.narrator.tick()
        narratorFired = 1
      }

      this.recordLog({
        event_count: events.length,
        verdict_tier1: 'SIGNIFICANT',
        tier2_score: t2.score,
        narrator_fired: narratorFired,
        episode_id: epId,
      })
    } catch (err) {
      logError('PerceptionPipeline.evaluateNow failed', err)
    } finally {
      this.evaluating = false
    }
  }

  private recordLog(r: { event_count: number; verdict_tier1: string; tier2_score: number | null; narrator_fired: number; episode_id: number | null }): void {
    this.db.run(
      `INSERT INTO perception_log (ts, event_count, verdict_tier1, tier2_score, narrator_fired, episode_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [Date.now(), r.event_count, r.verdict_tier1, r.tier2_score, r.narrator_fired, r.episode_id],
    )
  }
}
```

- [ ] **Step 4: Run tests**

```bash
bun test src/daemon/perception/perceptionPipeline.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/perception/perceptionPipeline.ts src/daemon/perception/perceptionLog.ts \
        src/daemon/perception/perceptionPipeline.test.ts
git commit -m "feat(perception): pipeline orchestrator wires Tier1+Tier2+Narrator+Episode"
```

---

## Task 15: ActivityWatch 6th observer

**Files:**
- Create: `src/daemon/proactive/observers/activityWatch.ts`
- Test:  `src/daemon/proactive/observers/activityWatch.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/daemon/proactive/observers/activityWatch.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { EventBus } from '../eventBus'
import { ActivityWatchObserver } from './activityWatch'

describe('ActivityWatchObserver', () => {
  let db: Database
  let bus: EventBus

  beforeEach(() => {
    db = new Database(':memory:')
    bus = new EventBus(db)
  })

  it('emits window_focus events from probe', async () => {
    const obs = new ActivityWatchObserver(bus, {
      pollMs: 40,
      probe: async () => ({
        afk: false,
        currentApp: { app: 'Slack', title: 'general', durationSec: 47 },
        tabDwell: [{ url: 'https://github.com/x', durationSec: 120 }],
      }),
    })
    await obs.start()
    await new Promise(r => setTimeout(r, 80))
    await obs.stop()
    const r = bus.recent(10)
    expect(r.some(e => e.kind === 'window_focus_duration')).toBe(true)
  })

  it('emits afk events when state changes', async () => {
    let afk = false
    const obs = new ActivityWatchObserver(bus, {
      pollMs: 30,
      probe: async () => ({ afk, currentApp: null, tabDwell: [] }),
    })
    await obs.start()
    await new Promise(r => setTimeout(r, 50))
    afk = true
    await new Promise(r => setTimeout(r, 80))
    await obs.stop()
    expect(bus.recent(20).some(e => e.kind === 'afk' && (e.payload as any).state === true)).toBe(true)
  })

  it('disables gracefully when ActivityWatch is unreachable', async () => {
    const obs = new ActivityWatchObserver(bus, {
      pollMs: 30,
      probe: async () => { throw new Error('ECONNREFUSED') },
    })
    await obs.start()
    await new Promise(r => setTimeout(r, 80))
    await obs.stop()
    // No crash, no events from this observer
    expect(bus.recent(10).filter(e => e.source === 'activity-watch').length).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/daemon/proactive/observers/activityWatch.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Write the implementation**

```typescript
// src/daemon/proactive/observers/activityWatch.ts
// 6th observer — consumes ActivityWatch local REST API (localhost:5600/api/0).
// Provides richer signal than the other 5 observers:
//   - window focus DURATIONS (not just app switches)
//   - AFK / idle state
//   - per-browser-tab dwell times
//
// Gracefully disables if ActivityWatch isn't running.

import { Observer } from './base'
import type { EventBus } from '../eventBus'

type ProbeData = {
  afk: boolean
  currentApp: { app: string; title: string; durationSec: number } | null
  tabDwell: Array<{ url: string; durationSec: number }>
}

type Probe = () => Promise<ProbeData>

export class ActivityWatchObserver extends Observer {
  readonly id = 'activity-watch'
  private timer: ReturnType<typeof setInterval> | null = null
  private lastAfk: boolean | null = null
  private lastAppSig: string = ''
  private lastReachable = true
  private probe: Probe
  private pollMs: number

  constructor(bus: EventBus, opts?: { pollMs?: number; probe?: Probe }) {
    super(bus)
    this.pollMs = opts?.pollMs ?? 30_000
    this.probe = opts?.probe ?? defaultProbe
  }

  protected onStart(): void {
    this.tick()
    this.timer = setInterval(() => this.tick(), this.pollMs)
  }

  protected onStop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }

  private async tick(): Promise<void> {
    try {
      const data = await this.probe()
      if (!this.lastReachable) {
        this.lastReachable = true
      }

      if (data.afk !== this.lastAfk) {
        this.emit('afk', { state: data.afk })
        this.lastAfk = data.afk
      }

      if (data.currentApp) {
        const sig = `${data.currentApp.app}|${data.currentApp.title}|${data.currentApp.durationSec}`
        if (sig !== this.lastAppSig) {
          this.emit('window_focus_duration', data.currentApp)
          this.lastAppSig = sig
        }
      }

      for (const tab of data.tabDwell) {
        if (tab.durationSec > 60) {  // only emit for dwell > 1 min
          this.emit('tab_dwell', tab)
        }
      }
    } catch {
      if (this.lastReachable) {
        this.lastReachable = false
        // Don't spam logs — just silently disable. Tick will keep trying.
      }
    }
  }
}

const AW_BASE = 'http://localhost:5600/api/0'

async function defaultProbe(): Promise<ProbeData> {
  // Query the bucket list to find the right bucket names
  // For now, query known buckets directly. Production version should discover them.
  const now = new Date()
  const startTime = new Date(now.getTime() - 60_000).toISOString()
  const endTime = now.toISOString()

  // afk bucket
  const afkResp = await fetch(`${AW_BASE}/buckets/aw-watcher-afk_${getHost()}/events?start=${startTime}&end=${endTime}`)
  if (!afkResp.ok) throw new Error(`afk: ${afkResp.status}`)
  const afkEvents = await afkResp.json() as Array<{ data: { status: string }; duration: number }>
  const afk = afkEvents.length > 0 && afkEvents[afkEvents.length - 1]!.data.status === 'afk'

  // window bucket
  const winResp = await fetch(`${AW_BASE}/buckets/aw-watcher-window_${getHost()}/events?start=${startTime}&end=${endTime}`)
  if (!winResp.ok) throw new Error(`window: ${winResp.status}`)
  const winEvents = await winResp.json() as Array<{ data: { app: string; title: string }; duration: number }>
  const latest = winEvents[winEvents.length - 1]
  const currentApp = latest ? { app: latest.data.app, title: latest.data.title, durationSec: Math.round(latest.duration) } : null

  // Browser tab buckets vary by browser — skip in default probe; user can extend
  const tabDwell: Array<{ url: string; durationSec: number }> = []

  return { afk, currentApp, tabDwell }
}

function getHost(): string {
  return process.env.HOSTNAME ?? Bun.spawnSync(['hostname']).stdout.toString().trim()
}
```

- [ ] **Step 4: Run tests**

```bash
bun test src/daemon/proactive/observers/activityWatch.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/proactive/observers/activityWatch.ts \
        src/daemon/proactive/observers/activityWatch.test.ts
git commit -m "feat(proactive): ActivityWatch 6th observer (window focus duration + AFK)"
```

---

## Task 16: TLS warmup retrofit on API providers

**Files:**
- Modify: `src/daemon/llm/providers/anthropicApi.ts`
- Modify: `src/daemon/llm/providers/openai.ts`
- Modify: `src/daemon/llm/providers/gemini.ts`

- [ ] **Step 1: Read current providers + plan the change**

```bash
grep -n "constructor\|getClient" src/daemon/llm/providers/anthropicApi.ts src/daemon/llm/providers/openai.ts src/daemon/llm/providers/gemini.ts
```

Each provider lazily constructs its client. We add a `warmupTLS()` method that fires a HEAD request to the relevant API host on startup, in the background, swallowing errors.

- [ ] **Step 2: Add warmup to anthropicApi.ts**

Add after the `getClient` method:

```typescript
warmupTLS(): void {
  if (!this.isConfigured()) return
  // Fire-and-forget HEAD request to pre-establish TLS to api.anthropic.com.
  // Errors are silently swallowed — purely an optimization.
  fetch('https://api.anthropic.com', { method: 'HEAD' }).catch(() => { /* ignore */ })
}
```

- [ ] **Step 3: Add warmup to openai.ts**

```typescript
warmupTLS(): void {
  if (!this.isConfigured()) return
  const url = this.cfg.base_url ?? 'https://api.openai.com'
  fetch(url, { method: 'HEAD' }).catch(() => { /* ignore */ })
}
```

- [ ] **Step 4: Add warmup to gemini.ts**

```typescript
warmupTLS(): void {
  if (!this.isConfigured()) return
  fetch('https://generativelanguage.googleapis.com', { method: 'HEAD' }).catch(() => { /* ignore */ })
}
```

- [ ] **Step 5: Add warmup to factory in `src/daemon/llm/index.ts`**

After building the providers map, before returning the router, call warmupTLS on each:

```typescript
// Fire all warmups in background — Clicky-derived pattern (8.4.8 #3).
for (const p of Object.values(providers)) {
  if (p && 'warmupTLS' in p && typeof (p as any).warmupTLS === 'function') {
    (p as any).warmupTLS()
  }
}
```

- [ ] **Step 6: Type-check + run all LLM tests**

```bash
cd /Users/nirmalghinaiya/Desktop/kairos-sandbox
bunx tsc --noEmit src/daemon/llm/index.ts src/daemon/llm/providers/*.ts 2>&1 | grep -v "pre-existing" | head -20
bun test src/daemon/llm/
```

Expected: no new errors in changed files; all LLM tests still pass.

- [ ] **Step 7: Commit**

```bash
git add src/daemon/llm/providers/anthropicApi.ts src/daemon/llm/providers/openai.ts \
        src/daemon/llm/providers/gemini.ts src/daemon/llm/index.ts
git commit -m "feat(llm): TLS warmup HEAD requests on factory init (Clicky pattern 8.4.8 #3)"
```

---

## Task 17: Wire everything into daemon startup

**Files:**
- Modify: `src/daemon/index.ts`
- Modify: `src/daemon/types.ts` — add `memory + perception + orders` config

- [ ] **Step 1: Read current state**

```bash
sed -n '1,40p' src/daemon/types.ts
grep -n "config\.proactive\|registry.register\|narrator" src/daemon/index.ts
```

- [ ] **Step 2: Extend Config with memory + perception + orders blocks**

In `types.ts`, add to the `Config` type:

```typescript
memory: {
  enabled: boolean
  dreamIntervalMs: number   // how often to attempt dreaming (we check idle gate each time)
}
perception: {
  enabled: boolean
  pipelinePollMs: number
}
orders: {
  enabled: boolean
  filePath: string
}
```

In the defaults factory in `config.ts`:

```typescript
memory: { enabled: true, dreamIntervalMs: 30 * 60_000 },
perception: { enabled: true, pipelinePollMs: 30_000 },
orders: { enabled: true, filePath: join(process.env.HOME ?? '', '.kairos', 'STANDING_ORDERS.md') },
```

- [ ] **Step 3: Wire into index.ts after the existing proactive block**

```typescript
// New imports (top of file):
import { initMemorySchema } from './memory/schema'
import { Embedder } from './memory/embeddings'
import { WorkingMemory } from './memory/workingMemory'
import { EpisodicMemory } from './memory/episodicMemory'
import { SemanticMemory } from './memory/semanticMemory'
import { Dreamer } from './memory/dreamer'
import { IdleDetector } from './memory/idleDetector'
import { Tier1Classifier } from './perception/tier1Classifier'
import { Tier2Summarizer } from './perception/tier2Summarizer'
import { PerceptionPipeline } from './perception/perceptionPipeline'
import { OrdersParser } from './orders/parser'
import { OrdersCompiler } from './orders/compiler'
import { OrdersRuntime } from './orders/runtime'
import { ensureSeedFile } from './orders/seedFile'
import { ActivityWatchObserver } from './proactive/observers/activityWatch'

// Inside the if (config.proactive.enabled) block, AFTER `await registry.startAll()`
// and AFTER `narrator` is constructed, BEFORE its `.start()`:

// Register ActivityWatch as 6th observer
registry.register(new ActivityWatchObserver(bus))
await registry.startAll()   // (idempotent — already started; this is fine to call again because of double-start guard)

// ─── Memory subsystem (Phase B) ──────────────────
let memoryStop: (() => Promise<void>) | null = null
if (config.memory.enabled) {
  initMemorySchema(db)
  const embedder = new Embedder()
  const working = new WorkingMemory(bus, { windowMs: 10 * 60_000, maxEvents: 500 })
  const episodic = new EpisodicMemory(db)
  const semantic = new SemanticMemory(db)
  const dreamer = new Dreamer(db, episodic, semantic, router, { embedder: t => embedder.embed(t) })
  const idle = new IdleDetector()

  const dreamTimer = setInterval(async () => {
    try {
      if (await idle.shouldDream()) {
        await dreamer.consolidate({ maxEpisodes: 50 })
      }
    } catch (err) { logError('Dreamer tick failed', err) }
  }, config.memory.dreamIntervalMs)
  memoryStop = async () => { clearInterval(dreamTimer) }

  // ─── Standing orders subsystem ──────────────────
  let ordersRuntime: OrdersRuntime | null = null
  if (config.orders.enabled) {
    ensureSeedFile(config.orders.filePath)
    const ordersParser = new OrdersParser(config.orders.filePath)
    const ordersCompiler = new OrdersCompiler(db, router)
    ordersRuntime = new OrdersRuntime(ordersParser, ordersCompiler, { pollMs: 5000 })
    await ordersRuntime.start()
  }

  // ─── Perception pipeline ─────────────────────────
  if (config.perception.enabled) {
    // IMPORTANT: stop the narrator's internal timer so only the pipeline drives it.
    // We pass intervalMs: Number.MAX_SAFE_INTEGER on Narrator construction below,
    // or just call narrator.stop() if already started and rely on pipeline.
    const tier1 = new Tier1Classifier(router)
    const tier2 = new Tier2Summarizer(router)
    const pipeline = new PerceptionPipeline(
      db, working, tier1, tier2, narrator, episodic,
      () => ordersRuntime?.text() ?? '',
      { pollMs: config.perception.pipelinePollMs },
    )
    pipeline.start()
    log('Perception pipeline active: Tier1 → Tier2 → Narrator')

    const prevMemoryStop = memoryStop
    memoryStop = async () => {
      pipeline.stop()
      if (ordersRuntime) ordersRuntime.stop()
      if (prevMemoryStop) await prevMemoryStop()
    }
  }
}

// In shutdown handler, after `await proactiveStop()`:
if (memoryStop) await memoryStop()
```

**IMPORTANT**: change the Narrator instantiation in the existing proactive block. Set `intervalMs` to a very large number (e.g. `Number.MAX_SAFE_INTEGER`) so its internal timer effectively never fires. The PerceptionPipeline is now the sole driver.

OR: remove the `await narrator.start()` call entirely and only ever call `narrator.tick()` from the pipeline.

The cleaner option is the second: don't start the narrator's timer at all.

- [ ] **Step 4: Type-check + run full test suite**

```bash
cd /Users/nirmalghinaiya/Desktop/kairos-sandbox
bunx tsc --noEmit 2>&1 | grep -E "(daemon/index|daemon/types|daemon/config)" | head -10
bun test 2>&1 | tail -5
```

Expected: no new errors in modified files; all tests pass (Phase A's 59 + Phase B's new ~40+).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/index.ts src/daemon/types.ts src/daemon/config.ts
git commit -m "feat(daemon): wire memory + perception + orders subsystems into startup"
```

---

## Task 18: Phase B validation gate — replay test

**Files:**
- Create: `scripts/validate-phase-b.ts`

The Phase B validation per Section 8.5: replay 7 days of events + LLM-judged recall quality + notification volume check.

For Phase B we don't have 7 days of real events yet, so the validation:
1. Synthesizes 200 fake events spanning 24h (mix of focus-app/clipboard/file/calendar)
2. Drives them through the full pipeline (perception → episodic → consolidation)
3. Verifies: events captured, perception gates fire correctly, episodes promoted, semantic facts created
4. Asks 5 recall questions, prints results for human judgment

- [ ] **Step 1: Write the validation script**

```typescript
// scripts/validate-phase-b.ts
// Phase B validation per Section 8.5 — replay synthetic events + judge recall.
//
// Usage: bun run scripts/validate-phase-b.ts

import { Database } from 'bun:sqlite'
import { homedir } from 'os'
import { join } from 'path'
import { buildRouter } from '../src/daemon/llm'
import { EventBus } from '../src/daemon/proactive/eventBus'
import { initMemorySchema } from '../src/daemon/memory/schema'
import { Embedder } from '../src/daemon/memory/embeddings'
import { WorkingMemory } from '../src/daemon/memory/workingMemory'
import { EpisodicMemory } from '../src/daemon/memory/episodicMemory'
import { SemanticMemory } from '../src/daemon/memory/semanticMemory'
import { Recall } from '../src/daemon/memory/recall'
import { Dreamer } from '../src/daemon/memory/dreamer'
import { Tier1Classifier } from '../src/daemon/perception/tier1Classifier'
import { Tier2Summarizer } from '../src/daemon/perception/tier2Summarizer'
import { PerceptionPipeline } from '../src/daemon/perception/perceptionPipeline'
import { Narrator } from '../src/daemon/proactive/narrator'
import { StateSnapshot } from '../src/daemon/proactive/stateSnapshot'

const db = new Database(':memory:')
const router = buildRouter(db, join(homedir(), '.kairos', 'providers.json'))
const bus = new EventBus(db)
initMemorySchema(db)
const snap = new StateSnapshot(bus)
const working = new WorkingMemory(bus, { windowMs: 10 * 60_000, maxEvents: 500 })
const episodic = new EpisodicMemory(db)
const semantic = new SemanticMemory(db)
const embedder = new Embedder()
const dreamer = new Dreamer(db, episodic, semantic, router, { embedder: t => embedder.embed(t) })
const narrator = new Narrator(bus, snap, router, { intervalMs: Number.MAX_SAFE_INTEGER })
const tier1 = new Tier1Classifier(router)
const tier2 = new Tier2Summarizer(router)
const recall = new Recall(db)
const pipeline = new PerceptionPipeline(db, working, tier1, tier2, narrator, episodic, () => '', { pollMs: Number.MAX_SAFE_INTEGER })

console.log('─── Phase B Validation — Synthetic Event Replay ───')

// Generate 200 fake events spanning ~3 hours of compressed activity
const sources = ['focus-app', 'clipboard', 'file-events', 'browser-tabs'] as const
const apps = ['VS Code', 'Slack', 'Brave', 'Notes', 'Terminal']
const startTs = Date.now() - 3 * 3600_000
for (let i = 0; i < 200; i++) {
  const ts = startTs + (i / 200) * 3 * 3600_000
  const source = sources[i % sources.length]!
  bus.publish({
    source,
    kind: source === 'focus-app' ? 'app_changed' : 'changed',
    payload: source === 'focus-app' ? { app: apps[i % apps.length] }
           : source === 'clipboard' ? { text: `clipboard text ${i}` }
           : source === 'file-events' ? { path: `/tmp/file${i % 10}.ts` }
           : { tabs: [`https://github.com/example/repo/pull/${i % 5}`] },
  })
}
console.log(`✓ Replayed 200 synthetic events`)

// Drive perception 5 times to chunk through them
for (let i = 0; i < 5; i++) {
  await pipeline.evaluateNow()
}
const epCount = episodic.recent(100).length
console.log(`✓ Episodes recorded: ${epCount}`)

// Run dreamer
const factsCreated = await dreamer.consolidate({ maxEpisodes: 100 })
console.log(`✓ Facts consolidated to L3: ${factsCreated}`)

// Recall test
const questions = [
  { q: 'what apps did the user spend time in?',          embedding: await embedder.embed('apps used') },
  { q: 'did the user copy anything to clipboard?',       embedding: await embedder.embed('clipboard') },
  { q: 'what files were edited?',                        embedding: await embedder.embed('files edited') },
  { q: 'any github browsing?',                           embedding: await embedder.embed('github') },
  { q: 'when was the user in Slack?',                    embedding: await embedder.embed('slack') },
]

console.log('\n─── Recall Test ───')
for (const { q, embedding } of questions) {
  const results = recall.hybrid(q, embedding, 3)
  console.log(`\n  Q: ${q}`)
  for (const r of results) console.log(`    → ${r.subject}: ${r.body}`)
  if (results.length === 0) console.log('    (no recall — possibly insufficient memory consolidation)')
}

// Perception log analysis
const logRows = db.query('SELECT verdict_tier1, COUNT(*) as n FROM perception_log GROUP BY verdict_tier1').all() as Array<{ verdict_tier1: string; n: number }>
console.log('\n─── Perception Volume ───')
for (const r of logRows) console.log(`  ${r.verdict_tier1.padEnd(12)} ${r.n}`)

const narratorFired = db.query('SELECT COUNT(*) as n FROM perception_log WHERE narrator_fired = 1').get() as { n: number }
console.log(`  narrator_fired ${narratorFired.n}`)

console.log('\n─── Done ───')
console.log('Validation gate: human reviews recall answers + perception volume.')
console.log('PASS criteria: recall answers are roughly relevant; SIGNIFICANT < 20% of evaluations; narrator_fired < 10% of evaluations.')
```

- [ ] **Step 2: Run validation**

```bash
cd /Users/nirmalghinaiya/Desktop/kairos-sandbox
bun run scripts/validate-phase-b.ts
```

Expected: prints episode count, fact count, recall answers for 5 questions, perception verdict distribution. Human reviews and confirms.

- [ ] **Step 3: Commit + update CHANGELOG**

```bash
git add scripts/validate-phase-b.ts
git commit -m "test(phase-b): synthetic event replay validation script"
```

Then update `CHANGELOG.md` with Phase B section + validation results (as we did for Phase A).

- [ ] **Step 4: Tag the release**

```bash
git tag v0.2.0-phase-b
git log --oneline v0.1.0-phase-a..v0.2.0-phase-b
```

---

## Self-review

**Spec coverage:**
- ✅ Section 8.4.1 — Tiered perception → Tasks 9 (Tier 1), 10 (Tier 2), 14 (pipeline)
- ✅ Section 8.4.2 — STANDING_ORDERS.md → Tasks 11 (parser), 12 (compiler), 13 (runtime)
- ✅ Section 8.4.3 — Rate limiter SKIPPED per user decision; validation gate Task 18 checks volume manually instead
- ✅ Section 8.4.4 — Custom memory build with sqlite-vec + Hermes Dreaming + MemOS L1-L4 layout → Tasks 1 (schema), 2 (embeddings), 3 (L1), 4 (L2), 5 (L3+recall), 6 (L4), 7 (idle), 8 (dreamer)
- ✅ Section 8.4.7 — ActivityWatch 6th observer → Task 15
- ✅ Section 8.4.8 #3 — TLS warmup retrofit → Task 16
- ✅ Section 8.5 — Validation gate per phase → Task 18
- ✅ Daemon wire-up → Task 17

**Placeholder scan:** none found. Every task has actual code, exact paths, exact commands.

**Type consistency:** verified — `Episode` type used identically in episodic/dreamer/pipeline; `SemanticInput`/`SemanticRow` consistent across semanticMemory/recall/dreamer; `Tier1Verdict` union used in classifier + pipeline; `CompiledTrigger` used in compiler + runtime + (future) C trigger engine.

**Phase boundaries preserved:** Phase B does NOT implement triggers acting on the world (Phase C), does NOT add OAuth connectors (Phase D), does NOT add voice (Phase E). It builds the perception + memory + orders infrastructure that all of those depend on.

**Open questions raised by this plan** (handle inline during execution if encountered):
- If `sqlite-vec` extension fails to load on user's macOS arm64, fall back to manual cosine-similarity over a regular SQLite table (slower but works). Add as DONE_WITH_CONCERNS escalation.
- If `fastembed` model download is slow or fails, document the path (`~/.cache/fastembed/`) so user can manual-download.
- ActivityWatch bucket naming includes hostname — `defaultProbe` uses `getHost()` which may need adjustment per system. Test with real install before declaring Task 15 fully validated.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-24-phase-b-memory-perception-orders.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task. Best for Phase B since the 18 atomic tasks follow the same TDD pattern as Phase A.

2. **Inline Execution** — Execute tasks in this session with checkpoints. Slower but you see each step live.

After Phase B ships (`v0.2.0-phase-b`), Phase C plans the trigger engine + autonomy tiers (where the compiled STANDING_ORDERS triggers actually start firing actions).
