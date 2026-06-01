// src/daemon/voice/conversationStore.ts
// SQLite-backed conversation turn history. Used by VoiceAdapter to give the LLM
// per-conversation memory of the last N turns when answering each new utterance.

import type { Database } from 'bun:sqlite'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS voice_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user','agent')),
  text TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_voice_turns_conv ON voice_turns(conversation_id, at);
`

export type Turn = { role: 'user' | 'agent'; text: string; at: number }

export class ConversationStore {
  constructor(private db: Database) {
    db.exec(SCHEMA)
  }

  async appendTurn(conversationId: string, turn: Turn): Promise<void> {
    this.db.run(
      `INSERT INTO voice_turns (conversation_id, role, text, at) VALUES (?, ?, ?, ?)`,
      [conversationId, turn.role, turn.text, turn.at],
    )
  }

  async recentTurns(conversationId: string, limit = 10): Promise<Turn[]> {
    const rows = this.db
      .query(
        `SELECT role, text, at FROM voice_turns WHERE conversation_id = ? ORDER BY at DESC LIMIT ?`,
      )
      .all(conversationId, limit) as any[]
    return rows.reverse().map(r => ({ role: r.role, text: r.text, at: r.at }))
  }
}
