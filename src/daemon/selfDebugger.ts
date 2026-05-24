// Self-debugger: monitors the daemon log for recurring errors and
// autonomously proposes source patches via L5 SourceEvolution.
//
// Pattern: scan log → fingerprint errors → threshold (3+ occurrences) →
// invoke L5 proposePatch → if validated, surface to user via Discord/inbox.

import { existsSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import type { Database } from 'bun:sqlite'
import { log, logError } from './logger'
import type { Config } from './types'
import type { SourceEvolution } from './sourceEvolution'

const ERROR_PATTERNS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS error_patterns (
    fingerprint           TEXT PRIMARY KEY,
    file_path             TEXT,                -- e.g. "src/daemon/scheduler.ts"
    line_number           INTEGER,
    error_message         TEXT NOT NULL,
    occurrences           INTEGER NOT NULL DEFAULT 1,
    first_seen            INTEGER NOT NULL,
    last_seen             INTEGER NOT NULL,
    last_log_excerpt      TEXT,                -- last 500 chars of context
    patch_proposed_id     TEXT,                -- patch_id if L5 was triggered
    patch_proposed_at     INTEGER,
    silenced_until        INTEGER              -- back off after a proposal
  );
  CREATE INDEX IF NOT EXISTS idx_error_patterns_active
    ON error_patterns(silenced_until, occurrences)
    WHERE patch_proposed_id IS NULL;
`

export type ErrorPattern = {
  fingerprint: string
  file_path: string | null
  line_number: number | null
  error_message: string
  occurrences: number
  first_seen: number
  last_seen: number
  last_log_excerpt: string | null
  patch_proposed_id: string | null
  patch_proposed_at: number | null
  silenced_until: number | null
}

export class SelfDebugger {
  private logPath: string
  private lastReadOffset = 0
  private scanning = false
  private readonly THRESHOLD = 3        // need this many occurrences to act
  private readonly WINDOW_MS = 3600_000 // within last hour
  private readonly SILENCE_AFTER_PROPOSE_MS = 24 * 3600_000  // 24h cooldown

  constructor(
    private db: Database,
    private config: Config,
    private sourceEvolution: SourceEvolution,
    private notifyFn?: (msg: string) => void,  // optional: Discord/inbox push
  ) {
    this.db.exec(ERROR_PATTERNS_SCHEMA)
    this.logPath = join(config.sandboxDir, 'state', 'logs', 'daemon.log')
    // Start at end of file — we only care about NEW errors going forward
    if (existsSync(this.logPath)) {
      try {
        this.lastReadOffset = statSync(this.logPath).size
      } catch { /* ignore */ }
    }
  }

  /**
   * Scan recent log entries for new errors. Called periodically (every 2-5 min).
   * Returns count of new error patterns found.
   */
  async scan(): Promise<number> {
    if (this.scanning) return 0
    if (!existsSync(this.logPath)) return 0

    this.scanning = true
    try {
      // Read only new content since last scan
      const stats = statSync(this.logPath)
      if (stats.size < this.lastReadOffset) {
        // Log was truncated/rotated — reset to start
        this.lastReadOffset = 0
      }
      if (stats.size === this.lastReadOffset) {
        return 0  // nothing new
      }

      const fd = await Bun.file(this.logPath).slice(this.lastReadOffset).text()
      this.lastReadOffset = stats.size

      const errors = this.extractErrors(fd)
      let newCount = 0

      for (const err of errors) {
        if (this.recordError(err)) newCount++
      }

      // Always check for proposal candidates if we processed ANY errors,
      // not just new fingerprints. A recurring error crossing threshold
      // via repeats also needs to fire — that's the whole point.
      if (errors.length > 0) {
        await this.maybeProposeFixes()
      }

      return newCount
    } catch (err) {
      logError('Self-debugger scan failed', err)
      return 0
    } finally {
      this.scanning = false
    }
  }

  /**
   * Parse log content for error patterns.
   * Looks for [error] level lines, exception traces, or "failed" patterns.
   */
  private extractErrors(logContent: string): Array<{
    file_path: string | null
    line_number: number | null
    error_message: string
    excerpt: string
  }> {
    const errors: Array<{
      file_path: string | null
      line_number: number | null
      error_message: string
      excerpt: string
    }> = []

    const lines = logContent.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!

      // Match [error] level log lines
      const levelMatch = line.match(/\[error\]\s+(.+)/i)
      if (!levelMatch) continue

      const errorMsg = levelMatch[1]!

      // Try to extract file:line from error message or surrounding lines
      // Patterns: "src/daemon/file.ts:127", "at src/daemon/file.ts (line 127)"
      let filePath: string | null = null
      let lineNum: number | null = null

      const fileLineMatch = (errorMsg + '\n' + (lines[i + 1] ?? '') + '\n' + (lines[i + 2] ?? ''))
        .match(/(src\/(?:daemon|shim)\/[a-zA-Z_-]+\.ts):(\d+)/)
      if (fileLineMatch) {
        filePath = fileLineMatch[1]!
        lineNum = parseInt(fileLineMatch[2]!)
      }

      // Excerpt: the error line plus 2 surrounding for context
      const excerpt = lines.slice(Math.max(0, i - 1), Math.min(lines.length, i + 3)).join('\n').slice(0, 500)

      errors.push({
        file_path: filePath,
        line_number: lineNum,
        error_message: errorMsg.slice(0, 300),
        excerpt,
      })
    }

    return errors
  }

  /**
   * Record an error occurrence. Returns true if this is a new fingerprint.
   */
  private recordError(err: {
    file_path: string | null
    line_number: number | null
    error_message: string
    excerpt: string
  }): boolean {
    const fingerprint = this.fingerprint(err.file_path, err.line_number, err.error_message)
    const existing = this.db.query(
      'SELECT occurrences FROM error_patterns WHERE fingerprint = ?',
    ).get(fingerprint) as { occurrences: number } | null

    if (existing) {
      this.db.run(
        'UPDATE error_patterns SET occurrences = occurrences + 1, last_seen = ?, last_log_excerpt = ? WHERE fingerprint = ?',
        [Date.now(), err.excerpt, fingerprint],
      )
      return false
    }

    this.db.run(
      `INSERT INTO error_patterns (fingerprint, file_path, line_number, error_message, occurrences, first_seen, last_seen, last_log_excerpt)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
      [fingerprint, err.file_path, err.line_number, err.error_message, Date.now(), Date.now(), err.excerpt],
    )
    return true
  }

  /**
   * Check for any error patterns that crossed threshold and haven't been
   * proposed yet. For each, invoke L5 to generate a patch.
   */
  private async maybeProposeFixes(): Promise<void> {
    const now = Date.now()
    const windowStart = now - this.WINDOW_MS

    const candidates = this.db.query(
      `SELECT * FROM error_patterns
       WHERE patch_proposed_id IS NULL
         AND (silenced_until IS NULL OR silenced_until < ?)
         AND last_seen > ?
         AND occurrences >= ?
         AND file_path IS NOT NULL
       ORDER BY occurrences DESC LIMIT 3`,
    ).all(now, windowStart, this.THRESHOLD) as ErrorPattern[]

    for (const pattern of candidates) {
      try {
        log(`Self-debugger: proposing fix for ${pattern.file_path}:${pattern.line_number} (${pattern.occurrences}x)`)

        const reason = `Recurring error detected ${pattern.occurrences}x in last hour:
File: ${pattern.file_path}:${pattern.line_number}
Error: ${pattern.error_message}
Context excerpt:
${pattern.last_log_excerpt}

Diagnose the likely root cause and propose a minimal, defensive fix.`

        const result = await this.sourceEvolution.proposePatch({
          targetFile: pattern.file_path!,
          reason,
        })

        // Update the pattern record
        this.db.run(
          'UPDATE error_patterns SET patch_proposed_id = ?, patch_proposed_at = ?, silenced_until = ? WHERE fingerprint = ?',
          [result.patch_id ?? 'failed', Date.now(), now + this.SILENCE_AFTER_PROPOSE_MS, pattern.fingerprint],
        )

        // Notify user (Discord/inbox)
        const msg = result.ok
          ? `🛠️ I detected a recurring error and proposed a fix.\n` +
            `**Pattern**: \`${pattern.file_path}:${pattern.line_number}\` (${pattern.occurrences}x)\n` +
            `**Patch**: \`${result.patch_id}\` — validated, ready to apply.\n` +
            `Reply \`approve patch ${result.patch_id}\` to apply, or \`reject patch ${result.patch_id}\`.`
          : `⚠️ Recurring error detected at \`${pattern.file_path}:${pattern.line_number}\` (${pattern.occurrences}x), ` +
            `but my patch attempt failed validation: ${result.error?.slice(0, 200)}`

        if (this.notifyFn) {
          try { this.notifyFn(msg) } catch (err) { logError('selfDebugger notify failed', err) }
        }
      } catch (err) {
        logError(`Self-debugger proposePatch failed for ${pattern.fingerprint}`, err)
      }
    }
  }

  /**
   * Stable fingerprint for grouping recurrences of the same error.
   * Hashes file:line + first 100 chars of error message.
   */
  private fingerprint(file: string | null, line: number | null, msg: string): string {
    const hasher = new Bun.CryptoHasher('sha256')
    hasher.update(`${file ?? '?'}:${line ?? 0}:${msg.slice(0, 100)}`)
    return hasher.digest('hex').slice(0, 16)
  }

  /**
   * List recent error patterns for inspection.
   */
  listPatterns(includeSilenced: boolean = false): ErrorPattern[] {
    const now = Date.now()
    if (includeSilenced) {
      return this.db.query(
        'SELECT * FROM error_patterns ORDER BY last_seen DESC LIMIT 20',
      ).all() as ErrorPattern[]
    }
    return this.db.query(
      `SELECT * FROM error_patterns
       WHERE silenced_until IS NULL OR silenced_until < ?
       ORDER BY last_seen DESC LIMIT 20`,
    ).all(now) as ErrorPattern[]
  }

  /**
   * Manually clear silence on a pattern (so it can be re-proposed).
   */
  unsilence(fingerprint: string): void {
    this.db.run('UPDATE error_patterns SET silenced_until = NULL, patch_proposed_id = NULL WHERE fingerprint = ?', [fingerprint])
  }
}
