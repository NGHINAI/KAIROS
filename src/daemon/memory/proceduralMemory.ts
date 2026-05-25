// src/daemon/memory/proceduralMemory.ts
// L4 — procedural memory. Skills themselves live as files in
// skills/active/<dir>/. This table indexes them + tracks invocation stats.

import type { Database } from 'bun:sqlite'

export type SkillIndexInput = {
  skill_id: string
  description: string
  trigger_pattern?: string
  crystallized_from?: number | null
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
