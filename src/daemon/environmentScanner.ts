// Environment scanner: observes the user's workspace via bash commands (NOT LLM).
// Creates observations and suggestions. NEVER acts autonomously — only suggests.

import type { Database } from 'bun:sqlite'
import * as queries from './db'
import { log, logError } from './logger'
import { sendObservationNotification } from './notify'
import type { Config, ObservationCategory, ObservationSeverity } from './types'

type RawObservation = {
  category: ObservationCategory
  subject: string
  description: string
  confidence: number
  severity: ObservationSeverity
  suggestedAction: string
  stateHash: string
}

export class EnvironmentScanner {
  private scanning = false
  private tickCounter = 0
  private triggerTick?: (event: { source: string; reason: string }) => void

  constructor(
    private db: Database,
    private config: Config,
  ) {}

  setTriggerTick(fn: (event: { source: string; reason: string }) => void): void {
    this.triggerTick = fn
  }

  /**
   * Run a full environment scan. Called from the scheduler on every Nth tick.
   * Returns true if any new suggestions were created.
   */
  async scan(): Promise<boolean> {
    if (this.scanning) return false
    this.scanning = true

    this.tickCounter++
    if (this.tickCounter % this.config.observation.scanIntervalTicks !== 0) {
      this.scanning = false
      return false
    }

    // Determine which directory to scan
    const cwd = this.getScanDirectory()
    if (!cwd) {
      this.scanning = false
      return false
    }

    let suggestionsCreated = false

    try {
      const enabled = new Set(this.config.observation.enabledCategories)

      // Check suppressed categories from feedback
      const feedback = this.getEffectivenessSuppressions()
      for (const cat of feedback) enabled.delete(cat)

      // Run each scanner category
      const allObservations: RawObservation[] = []

      if (enabled.has('git_uncommitted')) {
        allObservations.push(...await this.scanGitStatus(cwd))
      }
      if (enabled.has('git_behind_remote')) {
        allObservations.push(...await this.scanGitRemote(cwd))
      }
      if (enabled.has('branch_stale')) {
        allObservations.push(...await this.scanBranchStaleness(cwd))
      }
      if (enabled.has('large_diff')) {
        allObservations.push(...await this.scanLargeDiff(cwd))
      }
      if (enabled.has('merge_conflicts')) {
        allObservations.push(...await this.scanMergeConflicts(cwd))
      }
      if (enabled.has('todo_items')) {
        allObservations.push(...await this.scanTodos(cwd))
      }
      // Test/lint/build scanners run less frequently (every 10th scan)
      if (this.tickCounter % 10 === 0) {
        if (enabled.has('test_failing')) {
          allObservations.push(...await this.scanTestResults(cwd))
        }
        if (enabled.has('build_broken')) {
          allObservations.push(...await this.scanBuildBroken(cwd))
        }
      }
      if (enabled.has('dependency_outdated') && this.tickCounter % 30 === 0) {
        allObservations.push(...await this.scanDependencies(cwd))
      }

      // Cap at 10 observations per scan, prioritize by severity
      const severityOrder: Record<string, number> = { critical: 0, warning: 1, info: 2 }
      const sorted = allObservations.sort((a, b) =>
        (severityOrder[a.severity] ?? 2) - (severityOrder[b.severity] ?? 2),
      ).slice(0, 10)

      // Process each observation: deduplicate via state_hash
      for (const obs of sorted) {
        const existing = queries.getObservationByHash(this.db, obs.stateHash)
        if (existing) {
          // Already known — just update last_observed_at
          queries.updateObservationSeen(this.db, existing.observation_id)
          continue
        }

        // Resolve any previous observation with same category+subject
        const prev = this.db.query(
          `SELECT observation_id FROM observations
           WHERE category = ? AND subject = ? AND resolved_at IS NULL AND dismissed_at IS NULL`,
        ).all(obs.category, obs.subject) as { observation_id: string }[]
        for (const p of prev) {
          queries.resolveObservation(this.db, p.observation_id)
        }

        // Create new observation
        const obsId = queries.createObservation(this.db, {
          category: obs.category,
          subject: obs.subject,
          description: obs.description,
          confidence: obs.confidence,
          source: 'environment_scanner',
          severity: obs.severity,
          suggestedAction: obs.suggestedAction,
          stateHash: obs.stateHash,
        })

        // Create suggestion message if within budget and severity >= warning
        if (obs.severity !== 'info') {
          const hourlyCount = queries.getSuggestionCountLastHour(this.db)
          if (hourlyCount < this.config.observation.maxSuggestionsPerHour) {
            queries.markObservationSuggested(this.db, obsId)
            const priority = obs.severity === 'critical' ? 'urgent' : 'proactive'
            queries.createMessage(this.db, {
              sessionId: null, // broadcast
              kind: 'notification',
              priority,
              body: `🔎 ${obs.description}\n   → ${obs.suggestedAction}\n   Want me to handle it? Use kairos_observe(action="act", observation_id="${obsId}"), or just ignore this.`,
            })
            suggestionsCreated = true

            // macOS notification — method depends on severity
            if (obs.severity !== 'info') {
              sendObservationNotification({
                severity: obs.severity,
                message: obs.description,
                observationId: obsId,
                category: obs.category,
                db: this.db,
                triggerTick: this.triggerTick,
              })
            }
          }
        }
      }
    } catch (err) {
      logError('Environment scan failed', err)
    } finally {
      this.scanning = false
    }

    return suggestionsCreated
  }

  // ─── Individual scanners ──────────────────────────────────────────

  private async scanGitStatus(cwd: string): Promise<RawObservation[]> {
    const output = await this.runCommand('git status --porcelain', cwd)
    if (!output) return []

    const lines = output.trim().split('\n').filter(l => l.length > 0)
    if (lines.length === 0) return []

    const modified = lines.filter(l => l.startsWith(' M') || l.startsWith('M ')).length
    const untracked = lines.filter(l => l.startsWith('??')).length
    const staged = lines.filter(l => l.startsWith('A ') || l.startsWith('D ')).length

    const parts: string[] = []
    if (modified > 0) parts.push(`${modified} modified`)
    if (untracked > 0) parts.push(`${untracked} new`)
    if (staged > 0) parts.push(`${staged} staged`)

    const desc = lines.length <= 5
      ? `You've got ${lines.length} uncommitted file${lines.length === 1 ? '' : 's'} (${parts.join(', ')}). Small enough to wrap up in one commit.`
      : `You've got ${lines.length} uncommitted changes piling up (${parts.join(', ')}). Might be worth committing before the diff gets unwieldy.`

    return [{
      category: 'git_uncommitted',
      subject: cwd,
      description: desc,
      confidence: 0.9,
      severity: lines.length > 20 ? 'warning' : 'info',
      suggestedAction: lines.length > 15 ? `I can help split these into logical commits.` : `Want me to stage and commit these?`,
      stateHash: this.hash(`git_uncommitted:${lines.length}:${modified}:${untracked}`),
    }]
  }

  private async scanGitRemote(cwd: string): Promise<RawObservation[]> {
    await this.runCommand('git fetch --quiet 2>/dev/null', cwd)
    const output = await this.runCommand('git log HEAD..origin/main --oneline 2>/dev/null', cwd)
    if (!output?.trim()) return []

    const commits = output.trim().split('\n').length
    return [{
      category: 'git_behind_remote',
      subject: 'origin/main',
      description: commits === 1
        ? `You're 1 commit behind main. Someone pushed while you were working.`
        : `You're ${commits} commits behind main. Might want to pull before you drift too far.`,
      confidence: 0.85,
      severity: commits > 10 ? 'warning' : 'info',
      suggestedAction: `I can pull the latest for you.`,
      stateHash: this.hash(`git_behind:${commits}`),
    }]
  }

  private async scanBranchStaleness(cwd: string): Promise<RawObservation[]> {
    const output = await this.runCommand('git log -1 --format=%ct 2>/dev/null', cwd)
    if (!output?.trim()) return []

    const lastCommitEpoch = parseInt(output.trim()) * 1000
    const daysSince = (Date.now() - lastCommitEpoch) / 86_400_000

    if (daysSince < 7) return []

    const branch = (await this.runCommand('git branch --show-current 2>/dev/null', cwd))?.trim() ?? 'current branch'
    const weeks = Math.floor(daysSince / 7)
    return [{
      category: 'branch_stale',
      subject: branch,
      description: weeks > 4
        ? `The "${branch}" branch hasn't seen a commit in over a month. Is it still alive, or can we clean it up?`
        : `The "${branch}" branch has been quiet for ${weeks} week${weeks === 1 ? '' : 's'}. Still working on this?`,
      confidence: 0.7,
      severity: daysSince > 30 ? 'warning' : 'info',
      suggestedAction: `I can rebase it on main or help you decide if it's still needed.`,
      stateHash: this.hash(`stale:${branch}:${Math.floor(daysSince / 7)}`),
    }]
  }

  private async scanLargeDiff(cwd: string): Promise<RawObservation[]> {
    const output = await this.runCommand('git diff --stat 2>/dev/null | tail -1', cwd)
    if (!output?.trim()) return []

    const match = output.match(/(\d+) files? changed/)
    const insertions = output.match(/(\d+) insertion/)
    const deletions = output.match(/(\d+) deletion/)
    const totalChanges = (parseInt(insertions?.[1] ?? '0') + parseInt(deletions?.[1] ?? '0'))

    if (totalChanges < 500) return []

    return [{
      category: 'large_diff',
      subject: cwd,
      description: totalChanges > 1000
        ? `Your uncommitted diff is getting big — ${totalChanges} lines across ${match?.[1] ?? '?'} files. That's going to be a painful code review if it grows more.`
        : `You've got a ${totalChanges}-line diff building up across ${match?.[1] ?? '?'} files. Might be a good time to checkpoint with a commit.`,
      confidence: 0.8,
      severity: totalChanges > 1000 ? 'warning' : 'info',
      suggestedAction: `I can help break this into smaller, logical commits.`,
      stateHash: this.hash(`large_diff:${Math.floor(totalChanges / 100)}`),
    }]
  }

  private async scanMergeConflicts(cwd: string): Promise<RawObservation[]> {
    const output = await this.runCommand('git diff --name-only --diff-filter=U 2>/dev/null', cwd)
    if (!output?.trim()) return []

    const files = output.trim().split('\n').filter(l => l.length > 0)
    if (files.length === 0) return []

    return [{
      category: 'merge_conflicts',
      subject: cwd,
      description: files.length === 1
        ? `You've got a merge conflict in ${files[0]}. Nothing else will work right until that's resolved.`
        : `There are merge conflicts in ${files.length} files. These need resolving before anything else — git won't let you move forward until they're sorted.`,
      confidence: 0.95,
      severity: 'critical',
      suggestedAction: `I can help resolve these conflicts.`,
      stateHash: this.hash(`conflicts:${files.sort().join(',')}`),
    }]
  }

  private async scanTodos(cwd: string): Promise<RawObservation[]> {
    const output = await this.runCommand(
      "grep -rn 'TODO\\|FIXME\\|HACK\\|XXX' --include='*.ts' --include='*.js' --include='*.tsx' -l 2>/dev/null | head -20",
      cwd,
    )
    if (!output?.trim()) return []

    const files = output.trim().split('\n').filter(l => l.length > 0)
    if (files.length < 5) return [] // Only flag if there are many

    return [{
      category: 'todo_items',
      subject: cwd,
      description: `There are TODO/FIXME markers scattered across ${files.length} files. Not urgent, but they're piling up.`,
      confidence: 0.5,
      severity: 'info',
      suggestedAction: `I can list them all and help you triage which ones matter.`,
      stateHash: this.hash(`todos:${files.length}`),
    }]
  }

  private async scanTestResults(cwd: string): Promise<RawObservation[]> {
    // Check for common test runners
    const hasPackageJson = await this.runCommand('test -f package.json && echo yes', cwd)
    if (!hasPackageJson?.trim()) return []

    // Try running tests with --dry-run or just check last test output
    // We use a lightweight check: does `npm test` exist in package.json?
    const testScript = await this.runCommand("node -e \"const p=require('./package.json'); console.log(p.scripts?.test ? 'yes' : 'no')\" 2>/dev/null", cwd)
    if (testScript?.trim() !== 'yes') return []

    // Run tests briefly (5s timeout will kill if too slow)
    const output = await this.runCommand('npm test 2>&1 | tail -20', cwd)
    if (!output) return []

    // Check for failure indicators
    const hasFailure = /fail|error|FAIL|ERROR/i.test(output) && !/0 fail/i.test(output)
    if (!hasFailure) return []

    return [{
      category: 'test_failing',
      subject: cwd,
      description: `Your tests are failing. Something broke — probably in the last few changes. Here's the tail end of the output:\n${output.slice(-150).trim()}`,
      confidence: 0.85,
      severity: 'warning',
      suggestedAction: `I can dig into the failures and try to fix them.`,
      stateHash: this.hash(`test_fail:${output.slice(-100)}`),
    }]
  }

  private async scanBuildBroken(cwd: string): Promise<RawObservation[]> {
    const hasTsConfig = await this.runCommand('test -f tsconfig.json && echo yes', cwd)
    if (hasTsConfig?.trim() !== 'yes') return []

    const output = await this.runCommand('npx tsc --noEmit 2>&1 | tail -10', cwd)
    if (!output?.trim()) return []

    const errorMatch = output.match(/Found (\d+) error/)
    if (!errorMatch) return []

    const errorCount = parseInt(errorMatch[1]!)
    if (errorCount === 0) return []

    return [{
      category: 'build_broken',
      subject: cwd,
      description: errorCount === 1
        ? `TypeScript found 1 error. Your build won't pass until it's fixed.`
        : errorCount > 10
          ? `TypeScript is unhappy — ${errorCount} errors. The build is broken. This needs attention.`
          : `TypeScript found ${errorCount} errors. Not a lot, but the build won't pass.`,
      confidence: 0.9,
      severity: errorCount > 10 ? 'critical' : 'warning',
      suggestedAction: `I can look at the errors and fix them.`,
      stateHash: this.hash(`tsc_errors:${errorCount}`),
    }]
  }

  private async scanDependencies(cwd: string): Promise<RawObservation[]> {
    const output = await this.runCommand('npm outdated --json 2>/dev/null', cwd)
    if (!output?.trim() || output.trim() === '{}') return []

    try {
      const outdated = JSON.parse(output) as Record<string, { current: string; latest: string }>
      const majorUpdates = Object.entries(outdated).filter(([, v]) => {
        const curr = v.current?.split('.')[0]
        const latest = v.latest?.split('.')[0]
        return curr !== latest
      })

      if (majorUpdates.length === 0) return []

      const names = majorUpdates.slice(0, 3).map(([k]) => k).join(', ')
      return [{
        category: 'dependency_outdated',
        subject: cwd,
        description: majorUpdates.length === 1
          ? `${names} has a major version update available. Worth checking the changelog for breaking changes.`
          : `${majorUpdates.length} packages have major updates waiting (${names}${majorUpdates.length > 3 ? ', ...' : ''}). Not urgent, but falling behind on major versions gets painful.`,
        confidence: 0.6,
        severity: 'info',
        suggestedAction: `I can check the changelogs and update them one by one.`,
        stateHash: this.hash(`deps:${majorUpdates.map(([k]) => k).sort().join(',')}`),
      }]
    } catch {
      return []
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  private async runCommand(cmd: string, cwd: string): Promise<string | null> {
    try {
      const proc = Bun.spawn(['sh', '-c', cmd], {
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
      })

      const timeout = setTimeout(() => proc.kill('SIGTERM'), this.config.observation.commandTimeoutMs)
      const stdout = await new Response(proc.stdout).text()
      clearTimeout(timeout)
      await proc.exited

      return stdout
    } catch {
      return null
    }
  }

  private hash(input: string): string {
    const hasher = new Bun.CryptoHasher('sha256')
    hasher.update(input)
    return hasher.digest('hex').slice(0, 16)
  }

  private getScanDirectory(): string | null {
    // Use the most recently active session's cwd
    const sessions = queries.getActiveSessions(this.db)
    if (sessions.length === 0) return this.config.sandboxDir

    // Sort by last_heartbeat descending, pick first
    const sorted = sessions.sort((a, b) => b.last_heartbeat - a.last_heartbeat)
    return sorted[0]?.cwd ?? this.config.sandboxDir
  }

  private getEffectivenessSuppressions(): string[] {
    // Check feedback for suppressed categories (effectiveness < 40%)
    const oneWeekAgo = Date.now() - 7 * 24 * 3_600_000
    const feedback = this.db.query(`
      SELECT o.category, AVG(f.signal_strength) as avg_signal, COUNT(*) as cnt
      FROM feedback f
      JOIN observations o ON f.observation_id = o.observation_id
      WHERE f.created_at > ? AND f.observation_id IS NOT NULL
      GROUP BY o.category
      HAVING cnt >= 3 AND avg_signal < -0.2
    `).all(oneWeekAgo) as { category: string; avg_signal: number }[]

    // Safety floor: never suppress test_failing or merge_conflicts
    const safeCategories = new Set(['test_failing', 'merge_conflicts'])
    return feedback
      .map(f => f.category)
      .filter(c => !safeCategories.has(c))
  }
}
