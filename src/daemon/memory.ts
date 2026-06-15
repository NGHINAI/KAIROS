// Memory management: MEMORY.md read/write, dream consolidation.
// MEMORY.md is the Tier 3 distilled memory — human-readable, ~200 lines max.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { Database } from 'bun:sqlite'
import { log, logError } from './logger'
import type { Config } from './types'

export class MemoryStore {
  private memoryPath: string
  private dreamPrompt: string

  constructor(
    private db: Database,
    private config: Config,
    // The consolidation brain. Injected OpenRouter completer (memory/fast model)
    // — replaces the old `claude -p` Sonnet subprocess. No claude at runtime.
    private llm?: { complete: (body: any) => Promise<{ text: string }> },
  ) {
    this.memoryPath = join(config.sandboxDir, 'state', 'MEMORY.md')

    const dreamPromptPath = join(config.sandboxDir, 'src', 'prompts', 'dream-prompt.md')
    this.dreamPrompt = existsSync(dreamPromptPath)
      ? readFileSync(dreamPromptPath, 'utf8')
      : 'Consolidate the following observations into a structured MEMORY.md file.'
  }

  read(): string {
    if (!existsSync(this.memoryPath)) {
      return '(No memory yet — this is a fresh start.)'
    }
    return readFileSync(this.memoryPath, 'utf8')
  }

  /**
   * Run a dream consolidation pass. Gathers unconsolidated candidates,
   * recent task summaries, and the current MEMORY.md, then spawns a
   * Sonnet subprocess to produce a new MEMORY.md.
   */
  async runDream(feedbackMetrics?: string): Promise<void> {
    // Check gates
    const candidates = this.db.query(
      'SELECT * FROM memory_candidates WHERE promoted_to_memory = 0 ORDER BY created_at ASC',
    ).all() as Array<{ candidate_id: number; category: string; content: string; confidence: number }>

    if (candidates.length < this.config.dream.minCandidates) {
      log(`Dream skipped: only ${candidates.length} candidates (need ${this.config.dream.minCandidates})`)
      return
    }

    const lastDream = this.db.query(
      'SELECT completed_at FROM dreams WHERE status = ? ORDER BY completed_at DESC LIMIT 1',
    ).get('success') as { completed_at: number } | null

    if (lastDream) {
      const minutesSince = (Date.now() - lastDream.completed_at) / 60_000
      if (minutesSince < this.config.dream.minIntervalMinutes) {
        log(`Dream skipped: only ${Math.floor(minutesSince)}m since last dream (need ${this.config.dream.minIntervalMinutes}m)`)
        return
      }
    }

    // Start dream
    const dreamId = this.db.query(
      "INSERT INTO dreams (started_at, status) VALUES (?, 'running') RETURNING dream_id",
    ).get(Date.now()) as { dream_id: number }

    log(`Dream #${dreamId.dream_id} starting with ${candidates.length} candidates`)

    // Gather context
    const currentMemory = this.read()
    const recentTasks = this.db.query(
      "SELECT task_id, description, result_summary FROM tasks WHERE status = 'done' ORDER BY completed_at DESC LIMIT 10",
    ).all() as Array<{ task_id: string; description: string; result_summary: string | null }>

    const candidateText = candidates.map(c =>
      `- [${c.category}] (confidence ${c.confidence}): ${c.content}`,
    ).join('\n')

    const taskText = recentTasks.map(t =>
      `- ${t.description}: ${t.result_summary?.slice(0, 200) ?? '(no summary)'}`,
    ).join('\n')

    const prompt = this.dreamPrompt
      .replace('{{CURRENT_MEMORY}}', currentMemory)
      .replace('{{NEW_CANDIDATES}}', candidateText)
      .replace('{{RECENT_TASKS}}', taskText)
      .replace('{{CANDIDATE_COUNT}}', candidates.length.toString())
      .replace('{{FEEDBACK_METRICS}}', feedbackMetrics ?? '(No feedback data yet — too early for learning.)')

    try {
      if (!this.llm) throw new Error('No consolidation LLM configured')
      const resp = await this.llm.complete({ messages: [{ role: 'user', content: prompt }] })
      let newMemory: string = resp.text ?? ''
      const costCents = 0  // spend metered in the LLM ledger via the completer's adapter

      // Validate: must have some structure, not be empty, under 200 lines
      const lines = newMemory.trim().split('\n')
      if (lines.length < 5) {
        throw new Error(`Dream output too short: ${lines.length} lines`)
      }
      if (lines.length > 250) {
        // Trim to 200 lines
        newMemory = lines.slice(0, 200).join('\n')
        log(`Dream output trimmed from ${lines.length} to 200 lines`, 'warn')
      }

      // Atomic write: write to .tmp, then rename
      const tmpPath = this.memoryPath + '.tmp'
      writeFileSync(tmpPath, newMemory)
      renameSync(tmpPath, this.memoryPath)

      // Mark candidates as promoted
      const ids = candidates.map(c => c.candidate_id)
      const placeholders = ids.map(() => '?').join(',')
      this.db.run(
        `UPDATE memory_candidates SET promoted_to_memory = 1, promoted_at = ? WHERE candidate_id IN (${placeholders})`,
        [Date.now(), ...ids],
      )

      // Update dream record
      this.db.run(
        `UPDATE dreams SET completed_at = ?, status = 'success', candidates_read = ?,
         entries_added = ?, cost_cents = ?, model = ? WHERE dream_id = ?`,
        [Date.now(), candidates.length, lines.length, costCents, this.config.models.dream, dreamId.dream_id],
      )

      log(`Dream #${dreamId.dream_id} complete. ${candidates.length} candidates → ${lines.length} lines. Cost: $${(costCents / 100).toFixed(4)}`)
    } catch (err) {
      logError(`Dream #${dreamId.dream_id} failed`, err)
      this.db.run(
        "UPDATE dreams SET completed_at = ?, status = 'error', notes = ? WHERE dream_id = ?",
        [Date.now(), err instanceof Error ? err.message : String(err), dreamId.dream_id],
      )
    }
  }
}
