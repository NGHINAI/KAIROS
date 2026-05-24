// Skill gap detector: analyzes task failures and user requests to identify
// capabilities KAIROS is missing. Surfaces gaps as suggestions during dream
// consolidation. The gap table records candidates for self-generation.

import type { Database } from 'bun:sqlite'
import { log } from './logger'
import type { SkillRegistry } from './skillRegistry'

export type SkillGap = {
  gap_id: string
  category: string         // domain hint: aws, docker, slack, postgres, etc.
  pattern: string          // what was being attempted (e.g., "aws s3 ls")
  description: string      // human-readable: "User wanted to list S3 buckets"
  occurrences: number
  first_seen: number
  last_seen: number
  proposed_skill_desc?: string  // suggested skill to fill this gap
  proposed_at?: number
  acted_on_at?: number     // user generated a skill for this
  dismissed_at?: number
}

const GAP_SCHEMA = `
  CREATE TABLE IF NOT EXISTS skill_gaps (
    gap_id              TEXT PRIMARY KEY,
    category            TEXT NOT NULL,
    pattern             TEXT NOT NULL,
    description         TEXT NOT NULL,
    occurrences         INTEGER NOT NULL DEFAULT 1,
    first_seen          INTEGER NOT NULL,
    last_seen           INTEGER NOT NULL,
    proposed_skill_desc TEXT,
    proposed_at         INTEGER,
    acted_on_at         INTEGER,
    dismissed_at        INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_skill_gaps_active
    ON skill_gaps(acted_on_at, dismissed_at)
    WHERE acted_on_at IS NULL AND dismissed_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_skill_gaps_pattern
    ON skill_gaps(pattern);
`

// Common domain keywords → category mapping. Extend this as we learn.
const DOMAIN_KEYWORDS: Record<string, string[]> = {
  aws: ['aws', 's3', 'ec2', 'lambda', 'iam', 'cloudformation', 'cloudwatch'],
  gcp: ['gcloud', 'gsutil', 'bigquery', 'firestore'],
  azure: ['az ', 'azurerm'],
  docker: ['docker', 'docker-compose', 'dockerfile'],
  kubernetes: ['kubectl', 'kubernetes', 'helm', 'k9s'],
  database: ['postgres', 'psql', 'mysql', 'sqlite', 'mongo', 'redis'],
  slack: ['slack', 'webhooks/T0'],
  github: ['gh ', 'github.com', 'github api'],
  npm: ['npm publish', 'npm view', 'npm registry'],
  python: ['pip', 'pyenv', 'pytest', 'poetry'],
  network: ['ping', 'traceroute', 'dig', 'curl', 'wget', 'http'],
  filesystem: ['find', 'tree', 'stat', 'ls -la'],
  monitoring: ['htop', 'iostat', 'vmstat', 'lsof'],
}

export class SkillGapDetector {
  constructor(
    private db: Database,
    private skillRegistry: SkillRegistry,
  ) {
    this.db.exec(GAP_SCHEMA)
  }

  /**
   * Record a gap candidate. Idempotent — if the same pattern was seen before,
   * just bump the occurrences counter.
   */
  recordGap(params: {
    category: string
    pattern: string
    description: string
  }): string {
    const existing = this.db.query(
      'SELECT gap_id, occurrences FROM skill_gaps WHERE pattern = ? AND dismissed_at IS NULL',
    ).get(params.pattern) as { gap_id: string; occurrences: number } | null

    if (existing) {
      this.db.run(
        'UPDATE skill_gaps SET occurrences = ?, last_seen = ? WHERE gap_id = ?',
        [existing.occurrences + 1, Date.now(), existing.gap_id],
      )
      return existing.gap_id
    }

    const gapId = 'gap_' + crypto.randomUUID().slice(0, 8)
    this.db.run(
      `INSERT INTO skill_gaps (gap_id, category, pattern, description, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [gapId, params.category, params.pattern, params.description, Date.now(), Date.now()],
    )
    return gapId
  }

  /**
   * Analyze recent failed tasks for skill gaps. Called periodically.
   */
  scanFailures(lookbackMs: number = 7 * 24 * 3600_000): number {
    const since = Date.now() - lookbackMs

    // Failed tasks: look at the result_summary for failure patterns
    const failures = this.db.query(`
      SELECT description, result_summary
      FROM tasks
      WHERE status IN ('failed', 'blocked')
        AND completed_at > ?
        AND result_summary IS NOT NULL
    `).all(since) as { description: string; result_summary: string }[]

    let recorded = 0
    const existingSkillNames = new Set(
      this.skillRegistry.listSkills().map(s => s.name.toLowerCase())
    )

    for (const failure of failures) {
      const fullText = `${failure.description} ${failure.result_summary}`.toLowerCase()

      // Look for "command not found" patterns — strong gap signal
      const cmdNotFound = fullText.match(/([a-z][a-z0-9_-]*): command not found/i)
      if (cmdNotFound) {
        const cmd = cmdNotFound[1]!
        // Skip if we already have a skill for it
        if (existingSkillNames.has(cmd)) continue

        const category = this.categorize(cmd)
        this.recordGap({
          category,
          pattern: `command_not_found:${cmd}`,
          description: `Tried to use "${cmd}" but it's not installed or not on PATH. May need a skill.`,
        })
        recorded++
      }

      // Look for domain keywords → categorize
      for (const [category, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
        for (const kw of keywords) {
          if (fullText.includes(kw.toLowerCase())) {
            // Only record if no existing skill covers this domain
            const hasSkill = this.skillRegistry.listSkills().some(s =>
              s.description.toLowerCase().includes(category) ||
              s.when_to_use.toLowerCase().includes(category)
            )
            if (hasSkill) continue

            this.recordGap({
              category,
              pattern: `domain:${category}:${kw}`,
              description: `Task involved ${category} (keyword: "${kw}") but no ${category} skill exists.`,
            })
            recorded++
            break // one record per category per failure
          }
        }
      }
    }

    if (recorded > 0) {
      log(`Skill gap scan: recorded ${recorded} gap signal(s) from ${failures.length} failures`)
    }
    return recorded
  }

  /**
   * Get gap candidates that should be proposed to the user.
   * Returns gaps with at least 2 occurrences that haven't been proposed/acted/dismissed.
   */
  getProposalCandidates(minOccurrences: number = 2): SkillGap[] {
    return this.db.query(`
      SELECT * FROM skill_gaps
      WHERE acted_on_at IS NULL
        AND dismissed_at IS NULL
        AND proposed_at IS NULL
        AND occurrences >= ?
      ORDER BY occurrences DESC, last_seen DESC
      LIMIT 5
    `).all(minOccurrences) as SkillGap[]
  }

  /**
   * Mark a gap as proposed (suggestion message sent to user).
   */
  markProposed(gapId: string, proposedDesc: string): void {
    this.db.run(
      'UPDATE skill_gaps SET proposed_at = ?, proposed_skill_desc = ? WHERE gap_id = ?',
      [Date.now(), proposedDesc, gapId],
    )
  }

  /**
   * Mark gap as acted on (user accepted, skill was generated).
   */
  markActed(gapId: string): void {
    this.db.run('UPDATE skill_gaps SET acted_on_at = ? WHERE gap_id = ?', [Date.now(), gapId])
  }

  /**
   * Mark gap as dismissed (user said no, don't suggest again).
   */
  dismiss(gapId: string): void {
    this.db.run('UPDATE skill_gaps SET dismissed_at = ? WHERE gap_id = ?', [Date.now(), gapId])
  }

  /**
   * List all gaps for inspection.
   */
  listAll(includeResolved: boolean = false): SkillGap[] {
    if (includeResolved) {
      return this.db.query('SELECT * FROM skill_gaps ORDER BY last_seen DESC').all() as SkillGap[]
    }
    return this.db.query(
      'SELECT * FROM skill_gaps WHERE acted_on_at IS NULL AND dismissed_at IS NULL ORDER BY occurrences DESC, last_seen DESC',
    ).all() as SkillGap[]
  }

  /**
   * Build a section for the dream prompt summarizing gaps.
   */
  formatForDream(): string {
    const candidates = this.getProposalCandidates(2)
    if (candidates.length === 0) return ''

    const lines = ['## Skill gaps detected', '']
    for (const gap of candidates) {
      lines.push(`- [${gap.category}] ${gap.description} (seen ${gap.occurrences}x)`)
    }
    lines.push('')
    lines.push('Consider proposing new skills for these gaps. The user can ignore or approve.')
    return lines.join('\n')
  }

  private categorize(commandOrKeyword: string): string {
    const lc = commandOrKeyword.toLowerCase()
    for (const [category, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
      if (keywords.some(kw => lc.includes(kw.toLowerCase()))) {
        return category
      }
    }
    return 'general'
  }
}
