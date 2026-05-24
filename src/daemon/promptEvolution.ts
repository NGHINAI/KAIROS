// Self-evolving prompts: KAIROS tracks effectiveness per prompt version,
// runs A/B tests, and promotes winners. The current prompt is always preserved
// at the original path; experiments live in prompts/experiments/<name>/v2/.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, copyFileSync } from 'fs'
import { join } from 'path'
import type { Database } from 'bun:sqlite'
import { log, logError } from './logger'
import type { Config } from './types'

export type PromptUsage = {
  prompt_name: string         // 'tick-decision', 'work-prompt', etc.
  version: string             // 'v1', 'v2-experimental', etc.
  used_in_tick_id?: number
  used_in_task_id?: string
  ts: number
}

export type PromptVersionMetrics = {
  prompt_name: string
  version: string
  total_uses: number
  positive_signals: number
  negative_signals: number
  avg_signal: number
  effectiveness_pct: number  // 0-100, higher is better
}

const PROMPT_USAGE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS prompt_usage (
    usage_id          INTEGER PRIMARY KEY AUTOINCREMENT,
    prompt_name       TEXT NOT NULL,
    version           TEXT NOT NULL,
    used_in_tick_id   INTEGER,
    used_in_task_id   TEXT,
    ts                INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_prompt_usage_lookup
    ON prompt_usage(prompt_name, version, ts DESC);
  CREATE INDEX IF NOT EXISTS idx_prompt_usage_tick
    ON prompt_usage(used_in_tick_id) WHERE used_in_tick_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_prompt_usage_task
    ON prompt_usage(used_in_task_id) WHERE used_in_task_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS prompt_versions (
    prompt_name       TEXT NOT NULL,
    version           TEXT NOT NULL,
    file_path         TEXT NOT NULL,
    created_at        INTEGER NOT NULL,
    is_active         INTEGER NOT NULL DEFAULT 0,
    is_experiment     INTEGER NOT NULL DEFAULT 0,
    promoted_at       INTEGER,
    archived_at       INTEGER,
    notes             TEXT,
    PRIMARY KEY (prompt_name, version)
  );
`

export class PromptEvolution {
  private experimentsDir: string
  private promptsDir: string
  private archiveDir: string

  constructor(
    private db: Database,
    private config: Config,
  ) {
    this.promptsDir = join(config.sandboxDir, 'src', 'prompts')
    this.experimentsDir = join(config.sandboxDir, 'src', 'prompts', 'experiments')
    this.archiveDir = join(config.sandboxDir, 'src', 'prompts', 'archive')
    this.db.exec(PROMPT_USAGE_SCHEMA)
    mkdirSync(this.experimentsDir, { recursive: true })
    mkdirSync(this.archiveDir, { recursive: true })
    this.registerExistingPrompts()
  }

  /**
   * On startup, register the current production prompts as v1 if not already.
   */
  private registerExistingPrompts(): void {
    if (!existsSync(this.promptsDir)) return
    const files = readdirSync(this.promptsDir)
      .filter(f => f.endsWith('.md') || f.endsWith('.json'))
    for (const file of files) {
      const promptName = file.replace(/\.(md|json)$/, '')
      const existing = this.db.query(
        'SELECT version FROM prompt_versions WHERE prompt_name = ? AND is_active = 1',
      ).get(promptName) as { version: string } | null
      if (existing) continue

      this.db.run(
        `INSERT INTO prompt_versions (prompt_name, version, file_path, created_at, is_active)
         VALUES (?, 'v1', ?, ?, 1)`,
        [promptName, join(this.promptsDir, file), Date.now()],
      )
    }
  }

  /**
   * Get the active version of a prompt. Falls back to v1.
   */
  getActiveVersion(promptName: string): string {
    const row = this.db.query(
      'SELECT version FROM prompt_versions WHERE prompt_name = ? AND is_active = 1 LIMIT 1',
    ).get(promptName) as { version: string } | null
    return row?.version ?? 'v1'
  }

  /**
   * Read a prompt by name and version. Returns the active version's content if
   * version is unspecified.
   */
  readPrompt(promptName: string, version?: string): string | null {
    const v = version ?? this.getActiveVersion(promptName)
    const row = this.db.query(
      'SELECT file_path FROM prompt_versions WHERE prompt_name = ? AND version = ?',
    ).get(promptName, v) as { file_path: string } | null
    if (!row || !existsSync(row.file_path)) return null
    return readFileSync(row.file_path, 'utf8')
  }

  /**
   * Decide which version to use for this invocation. Implements simple
   * A/B testing: if an experiment exists, route 25% of traffic to it.
   */
  pickVersionForUse(promptName: string): string {
    const experiment = this.db.query(
      `SELECT version FROM prompt_versions
       WHERE prompt_name = ? AND is_experiment = 1 AND archived_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
    ).get(promptName) as { version: string } | null

    if (!experiment) return this.getActiveVersion(promptName)

    // 25% to experimental, 75% to active
    return Math.random() < 0.25 ? experiment.version : this.getActiveVersion(promptName)
  }

  /**
   * Record that a specific prompt version was used. Called by the decision
   * engine after each tick subprocess.
   */
  recordUsage(params: {
    promptName: string
    version: string
    tickId?: number
    taskId?: string
  }): void {
    this.db.run(
      `INSERT INTO prompt_usage (prompt_name, version, used_in_tick_id, used_in_task_id, ts)
       VALUES (?, ?, ?, ?, ?)`,
      [params.promptName, params.version, params.tickId ?? null, params.taskId ?? null, Date.now()],
    )
  }

  /**
   * Compute effectiveness metrics per version of a prompt.
   * Joins usage records with feedback signals.
   */
  computeMetrics(promptName: string, lookbackMs: number = 7 * 24 * 3600_000): PromptVersionMetrics[] {
    const since = Date.now() - lookbackMs

    const rows = this.db.query(`
      SELECT
        pu.version,
        COUNT(DISTINCT pu.usage_id) AS total_uses,
        COUNT(DISTINCT CASE WHEN f.signal_strength > 0 THEN f.feedback_id END) AS positive,
        COUNT(DISTINCT CASE WHEN f.signal_strength < 0 THEN f.feedback_id END) AS negative,
        COALESCE(AVG(f.signal_strength), 0) AS avg_signal
      FROM prompt_usage pu
      LEFT JOIN messages m ON m.task_id = pu.used_in_task_id
      LEFT JOIN feedback f ON (f.message_id = m.message_id OR f.task_id = pu.used_in_task_id)
      WHERE pu.prompt_name = ? AND pu.ts > ?
      GROUP BY pu.version
    `).all(promptName, since) as Array<{
      version: string
      total_uses: number
      positive: number
      negative: number
      avg_signal: number
    }>

    return rows.map(r => ({
      prompt_name: promptName,
      version: r.version,
      total_uses: r.total_uses,
      positive_signals: r.positive,
      negative_signals: r.negative,
      avg_signal: r.avg_signal,
      effectiveness_pct: r.total_uses === 0
        ? 0
        : Math.round((r.positive / Math.max(1, r.positive + r.negative)) * 100),
    }))
  }

  /**
   * Create a new experimental version of a prompt. The user (or KAIROS itself
   * via L5) provides the new content. The experiment runs alongside production.
   */
  createExperiment(promptName: string, newContent: string, notes?: string): string {
    // Find next version number
    const existingVersions = this.db.query(
      'SELECT version FROM prompt_versions WHERE prompt_name = ?',
    ).all(promptName) as { version: string }[]
    const versionNumbers = existingVersions
      .map(r => parseInt(r.version.replace(/[^0-9]/g, '')))
      .filter(n => !isNaN(n))
    const nextVersion = `v${Math.max(0, ...versionNumbers) + 1}-experiment`

    // Determine file extension from active version
    const active = this.db.query(
      'SELECT file_path FROM prompt_versions WHERE prompt_name = ? AND is_active = 1',
    ).get(promptName) as { file_path: string } | null
    const ext = active?.file_path.endsWith('.json') ? '.json' : '.md'

    // Save experiment
    const expDir = join(this.experimentsDir, promptName)
    mkdirSync(expDir, { recursive: true })
    const expPath = join(expDir, `${nextVersion}${ext}`)
    writeFileSync(expPath, newContent)

    this.db.run(
      `INSERT INTO prompt_versions (prompt_name, version, file_path, created_at, is_experiment, notes)
       VALUES (?, ?, ?, ?, 1, ?)`,
      [promptName, nextVersion, expPath, Date.now(), notes ?? null],
    )

    log(`Created experimental prompt: ${promptName}/${nextVersion}`)
    return nextVersion
  }

  /**
   * Auto-promote an experimental version if it's significantly more effective
   * than the active version. Returns true if promotion happened.
   */
  autoPromote(promptName: string, opts?: {
    minSamples?: number
    minImprovement?: number  // 0.15 = 15% better
  }): boolean {
    const minSamples = opts?.minSamples ?? 50
    const minImprovement = opts?.minImprovement ?? 0.15

    const metrics = this.computeMetrics(promptName)
    if (metrics.length < 2) return false

    const active = metrics.find(m => m.version === this.getActiveVersion(promptName))
    const experiments = metrics.filter(m => m.version !== active?.version)

    for (const exp of experiments) {
      if (exp.total_uses < minSamples) continue
      if (!active || active.total_uses < minSamples) continue

      const lift = (exp.effectiveness_pct - active.effectiveness_pct) / 100
      if (lift >= minImprovement) {
        log(`Auto-promoting ${promptName}/${exp.version} (lift: +${(lift * 100).toFixed(1)}% over ${active.version})`)
        this.promote(promptName, exp.version)
        return true
      }
    }

    return false
  }

  /**
   * Manually promote a specific version to active. Archives the previous active.
   */
  promote(promptName: string, version: string): void {
    const target = this.db.query(
      'SELECT file_path FROM prompt_versions WHERE prompt_name = ? AND version = ?',
    ).get(promptName, version) as { file_path: string } | null
    if (!target) {
      throw new Error(`Version not found: ${promptName}/${version}`)
    }

    // Archive current active
    const currentActive = this.db.query(
      'SELECT version, file_path FROM prompt_versions WHERE prompt_name = ? AND is_active = 1',
    ).get(promptName) as { version: string; file_path: string } | null

    if (currentActive) {
      const archiveDir = join(this.archiveDir, promptName)
      mkdirSync(archiveDir, { recursive: true })
      const archivePath = join(archiveDir, `${currentActive.version}-${Date.now()}.archived`)
      copyFileSync(currentActive.file_path, archivePath)
      this.db.run(
        'UPDATE prompt_versions SET is_active = 0, archived_at = ? WHERE prompt_name = ? AND version = ?',
        [Date.now(), promptName, currentActive.version],
      )
    }

    // Copy experiment file over the production prompt path
    const productionPath = currentActive?.file_path ??
      this.db.query("SELECT file_path FROM prompt_versions WHERE prompt_name = ? ORDER BY created_at LIMIT 1").get(promptName) as { file_path: string }
    const prodPath = typeof productionPath === 'string' ? productionPath : productionPath.file_path
    copyFileSync(target.file_path, prodPath)

    this.db.run(
      'UPDATE prompt_versions SET is_active = 1, is_experiment = 0, promoted_at = ?, file_path = ? WHERE prompt_name = ? AND version = ?',
      [Date.now(), prodPath, promptName, version],
    )

    log(`Promoted ${promptName}/${version} to active`)
  }

  /**
   * Discard an experiment without promoting.
   */
  discardExperiment(promptName: string, version: string): void {
    this.db.run(
      'UPDATE prompt_versions SET archived_at = ? WHERE prompt_name = ? AND version = ?',
      [Date.now(), promptName, version],
    )
  }

  /**
   * List all versions for inspection.
   */
  listVersions(promptName?: string): Array<{
    prompt_name: string
    version: string
    is_active: number
    is_experiment: number
    metrics?: PromptVersionMetrics
  }> {
    const rows = promptName
      ? this.db.query('SELECT * FROM prompt_versions WHERE prompt_name = ? ORDER BY created_at DESC').all(promptName)
      : this.db.query('SELECT * FROM prompt_versions ORDER BY prompt_name, created_at DESC').all()

    return (rows as Array<{ prompt_name: string; version: string; is_active: number; is_experiment: number }>).map(r => {
      const allMetrics = this.computeMetrics(r.prompt_name)
      const m = allMetrics.find(x => x.version === r.version)
      return { ...r, metrics: m }
    })
  }
}
