// 4-tier human-like memory schema following MemOS L1-L4 layout.
//
// L1 (working) is in-memory only — handled by workingMemory.ts ring buffer
// L2 (episodic) — typed sequences of events that form a meaningful unit
// L3 (semantic) — distilled facts/notes/persona, embedded for fuzzy recall
// L4 (procedural) — pointer index into skills/active/ (skills live as files)
//
// Vector search: embeddings stored as BLOB in mem_l3_embeddings (one-to-one
// with mem_l3_semantic.id). Cosine similarity is done in pure TypeScript over
// an in-memory Float32Array matrix loaded at recall time. See recall.ts.
// Reason: bun:sqlite cannot load dynamic extensions like sqlite-vec.
// At KAIROS scale (~10k facts max), pure-TS cosine is sub-10ms — fine.
//
// FTS5 provides BM25 lexical search (built into SQLite, no extension needed).

import type { Database } from 'bun:sqlite'

const SCHEMA = `
  -- L2: Episodic memory. Each row is one "episode" (a meaningful event sequence).
  CREATE TABLE IF NOT EXISTS mem_l2_episodes (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at      INTEGER NOT NULL,
    ended_at        INTEGER NOT NULL,
    episode_type    TEXT    NOT NULL,
    title           TEXT    NOT NULL,
    summary         TEXT    NOT NULL,
    event_ids       TEXT    NOT NULL,
    importance      REAL    NOT NULL DEFAULT 0.5,
    promoted_l3     INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_l2_ts ON mem_l2_episodes(started_at);
  CREATE INDEX IF NOT EXISTS idx_l2_type ON mem_l2_episodes(episode_type, started_at);
  CREATE INDEX IF NOT EXISTS idx_l2_unpromoted ON mem_l2_episodes(promoted_l3, importance)
    WHERE promoted_l3 = 0;

  -- L3: Semantic memory.
  CREATE TABLE IF NOT EXISTS mem_l3_semantic (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    kind            TEXT    NOT NULL,
    subject         TEXT    NOT NULL,
    body            TEXT    NOT NULL,
    source_episodes TEXT,
    importance      REAL    NOT NULL DEFAULT 0.5,
    frequency       INTEGER NOT NULL DEFAULT 1,
    last_seen       INTEGER NOT NULL,
    created_at      INTEGER NOT NULL,
    decayed_at      INTEGER
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

  -- L4: Procedural memory index.
  CREATE TABLE IF NOT EXISTS mem_l4_procedural_index (
    skill_id        TEXT    PRIMARY KEY,
    description     TEXT    NOT NULL,
    trigger_pattern TEXT,
    last_invoked    INTEGER,
    invoke_count    INTEGER NOT NULL DEFAULT 0,
    success_count   INTEGER NOT NULL DEFAULT 0,
    crystallized_from TEXT
  );

  -- Dreamer log
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
  db.exec(SCHEMA)

  // Embeddings stored as BLOB (Float32Array bytes). Loaded into memory at
  // recall time for cosine similarity. One row per mem_l3_semantic row.
  db.exec(`
    CREATE TABLE IF NOT EXISTS mem_l3_embeddings (
      l3_id     INTEGER PRIMARY KEY REFERENCES mem_l3_semantic(id) ON DELETE CASCADE,
      embedding BLOB NOT NULL
    );
  `)
}
