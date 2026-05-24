// Self-modifying source code: KAIROS can propose patches to its own
// TypeScript source. Each patch goes through: generate → validate
// (compile check) → queue for approval → apply on user OK → archive original
// → trigger rebuild. The user remains in the loop for source changes.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { Database } from 'bun:sqlite'
import { log, logError } from './logger'
import type { Config } from './types'

export type PatchProposal = {
  patch_id: string
  target_file: string         // Relative to sandboxDir
  reason: string              // Why KAIROS proposed this
  diff_unified: string        // Unified diff text
  proposed_at: number
  approved_at: number | null
  rejected_at: number | null
  applied_at: number | null
  reverted_at: number | null
  validation_status: 'pending' | 'compiled' | 'compile_failed' | 'applied' | 'failed'
  validation_output: string | null
  build_log: string | null
  cost_cents: number
}

const PATCH_SCHEMA = `
  CREATE TABLE IF NOT EXISTS source_patches (
    patch_id            TEXT PRIMARY KEY,
    target_file         TEXT NOT NULL,
    reason              TEXT NOT NULL,
    diff_unified        TEXT NOT NULL,
    proposed_at         INTEGER NOT NULL,
    approved_at         INTEGER,
    rejected_at         INTEGER,
    applied_at          INTEGER,
    reverted_at         INTEGER,
    validation_status   TEXT NOT NULL DEFAULT 'pending',
    validation_output   TEXT,
    build_log           TEXT,
    cost_cents          INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_source_patches_pending
    ON source_patches(approved_at, rejected_at, applied_at)
    WHERE approved_at IS NULL AND rejected_at IS NULL;
`

const PATCH_GENERATION_PROMPT = `You are proposing a self-modification to KAIROS's TypeScript source code.

The target file is: {{TARGET_FILE}}
The reason for this change: {{REASON}}

Current file contents:
\`\`\`typescript
{{CURRENT_CONTENT}}
\`\`\`

Your job: produce a unified diff (patch format) that implements the change.
The diff must apply cleanly to the file shown above.
The diff must result in valid TypeScript that compiles cleanly.
The diff should be MINIMAL — only change what's necessary for the stated reason.

Output EXACTLY this format (no preamble, no markdown fences, no explanation):

===PATCH===
--- a/{{TARGET_FILE}}
+++ b/{{TARGET_FILE}}
@@ -lineNum,count +lineNum,count @@
 unchanged context
-removed line
+added line
 unchanged context
===END===

If the change is too large or risky to make safely, output instead:

===REJECT===
<one-line reason>
===END===

Constraints:
- Diff context must match the current file exactly (whitespace-sensitive)
- Don't introduce new dependencies (no new imports unless they exist elsewhere in the codebase)
- Preserve existing types and exports
- Don't remove error handling
- Don't change the public API of any function unless explicitly requested`

export class SourceEvolution {
  constructor(
    private db: Database,
    private config: Config,
  ) {
    this.db.exec(PATCH_SCHEMA)
  }

  /**
   * Propose a source code change. KAIROS uses claude -p (Sonnet) to generate
   * a patch, validates by attempting compilation, and queues for approval.
   */
  async proposePatch(params: {
    targetFile: string  // Relative to sandboxDir, e.g., "src/daemon/scheduler.ts"
    reason: string
  }): Promise<{ ok: boolean; patch_id?: string; error?: string; cost_cents?: number }> {
    const fullPath = join(this.config.sandboxDir, params.targetFile)
    if (!existsSync(fullPath)) {
      return { ok: false, error: `Target file not found: ${params.targetFile}` }
    }

    // Safety: only allow modifications under src/daemon/ and src/shim/
    if (!params.targetFile.startsWith('src/daemon/') && !params.targetFile.startsWith('src/shim/')) {
      return { ok: false, error: `Refusing to modify file outside src/daemon or src/shim: ${params.targetFile}` }
    }

    const currentContent = readFileSync(fullPath, 'utf8')

    log(`Generating patch for ${params.targetFile}: ${params.reason}`)

    const prompt = PATCH_GENERATION_PROMPT
      .replace(/\{\{TARGET_FILE\}\}/g, params.targetFile)
      .replace('{{REASON}}', params.reason)
      .replace('{{CURRENT_CONTENT}}', currentContent)

    let stdout: string
    let costCents = 0
    try {
      const proc = Bun.spawn([
        'claude', '-p',
        '--model', this.config.models.work,
        '--output-format', 'json',
        '--permission-mode', 'bypassPermissions',
      ], {
        stdin: new TextEncoder().encode(prompt),
        stdout: 'pipe',
        stderr: 'pipe',
      })
      stdout = await new Response(proc.stdout).text()
      const exitCode = await proc.exited
      if (exitCode !== 0) return { ok: false, error: `Generation subprocess exited ${exitCode}` }

      try {
        const parsed = JSON.parse(stdout)
        stdout = (parsed.result ?? '') as string
        costCents = Math.round(((parsed.cost_usd ?? 0) as number) * 100)
      } catch { /* raw text fallback */ }
    } catch (err) {
      return { ok: false, error: `Subprocess error: ${err instanceof Error ? err.message : String(err)}` }
    }

    // Check for rejection
    const rejectMatch = stdout.match(/===REJECT===([\s\S]*?)===END===/)
    if (rejectMatch) {
      return { ok: false, error: `KAIROS declined to generate patch: ${rejectMatch[1]!.trim()}`, cost_cents: costCents }
    }

    // Extract patch
    const patchMatch = stdout.match(/===PATCH===([\s\S]*?)===END===/)
    if (!patchMatch) {
      return { ok: false, error: `Could not parse patch output. Got: ${stdout.slice(0, 300)}`, cost_cents: costCents }
    }

    const diff = patchMatch[1]!.trim()

    // Record the patch
    const patchId = 'patch_' + crypto.randomUUID().slice(0, 8)
    this.db.run(
      `INSERT INTO source_patches (patch_id, target_file, reason, diff_unified, proposed_at, validation_status, cost_cents)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      [patchId, params.targetFile, params.reason, diff, Date.now(), costCents],
    )

    // Validate by trying to apply + compile in a sandbox copy
    const validation = await this.validatePatch(patchId)

    return { ok: validation.ok, patch_id: patchId, error: validation.error, cost_cents: costCents }
  }

  /**
   * Validate a patch by applying it to a temp copy and running bun build.
   * Updates the patch's validation_status and build_log.
   */
  async validatePatch(patchId: string): Promise<{ ok: boolean; error?: string }> {
    const patch = this.getPatch(patchId)
    if (!patch) return { ok: false, error: `Patch not found: ${patchId}` }

    const fullPath = join(this.config.sandboxDir, patch.target_file)
    if (!existsSync(fullPath)) return { ok: false, error: `Target file gone: ${patch.target_file}` }

    // Create a backup BEFORE testing (we'll restore if validation fails or if user rejects)
    const validationDir = join(this.config.sandboxDir, 'state', 'patches', patchId)
    mkdirSync(validationDir, { recursive: true })
    const backupPath = join(validationDir, 'original.txt')
    copyFileSync(fullPath, backupPath)

    // Apply patch using `patch` CLI tool
    const tmpDiffPath = join(validationDir, 'patch.diff')
    writeFileSync(tmpDiffPath, patch.diff_unified)

    try {
      // Apply using the system patch utility (dry-run first)
      const dryRunProc = Bun.spawn(
        ['patch', '--dry-run', '-p1', fullPath, tmpDiffPath],
        { cwd: this.config.sandboxDir, stdout: 'pipe', stderr: 'pipe' },
      )
      const dryRunOut = await new Response(dryRunProc.stdout).text()
      const dryRunErr = await new Response(dryRunProc.stderr).text()
      const dryRunCode = await dryRunProc.exited

      if (dryRunCode !== 0) {
        this.db.run(
          `UPDATE source_patches SET validation_status = 'compile_failed', validation_output = ? WHERE patch_id = ?`,
          [`Patch dry-run failed: ${dryRunErr || dryRunOut}`, patchId],
        )
        return { ok: false, error: `Patch doesn't apply cleanly: ${dryRunErr || dryRunOut}` }
      }

      // Apply for real (we'll undo via backup if compile fails)
      const applyProc = Bun.spawn(
        ['patch', '-p1', fullPath, tmpDiffPath],
        { cwd: this.config.sandboxDir, stdout: 'pipe', stderr: 'pipe' },
      )
      await applyProc.exited

      // Try to compile
      const buildProc = Bun.spawn(
        ['bun', 'build', 'src/daemon/index.ts', '--target=bun', '--outfile', '/dev/null'],
        { cwd: this.config.sandboxDir, stdout: 'pipe', stderr: 'pipe' },
      )
      const buildOut = await new Response(buildProc.stdout).text()
      const buildErr = await new Response(buildProc.stderr).text()
      const buildCode = await buildProc.exited

      // ALWAYS restore the original (we just wanted to test compilation)
      copyFileSync(backupPath, fullPath)

      if (buildCode !== 0) {
        this.db.run(
          `UPDATE source_patches SET validation_status = 'compile_failed', build_log = ? WHERE patch_id = ?`,
          [`Build failed: ${buildErr.slice(0, 2000)}`, patchId],
        )
        return { ok: false, error: `Patch applies but compilation fails: ${buildErr.slice(0, 200)}` }
      }

      this.db.run(
        `UPDATE source_patches SET validation_status = 'compiled', build_log = ? WHERE patch_id = ?`,
        [`Compiled cleanly: ${buildOut.slice(0, 500)}`, patchId],
      )
      log(`Patch ${patchId} validated — compiles cleanly. Awaiting approval.`)
      return { ok: true }
    } catch (err) {
      // Restore backup if it exists
      try { copyFileSync(backupPath, fullPath) } catch {}
      const errMsg = err instanceof Error ? err.message : String(err)
      this.db.run(
        `UPDATE source_patches SET validation_status = 'compile_failed', validation_output = ? WHERE patch_id = ?`,
        [errMsg, patchId],
      )
      return { ok: false, error: errMsg }
    }
  }

  /**
   * Approve and apply a validated patch. Triggers rebuild.
   */
  async approveAndApply(patchId: string): Promise<{ ok: boolean; error?: string; build_log?: string }> {
    const patch = this.getPatch(patchId)
    if (!patch) return { ok: false, error: `Patch not found: ${patchId}` }
    if (patch.applied_at) return { ok: false, error: 'Patch already applied' }
    if (patch.rejected_at) return { ok: false, error: 'Patch was rejected' }
    if (patch.validation_status !== 'compiled') {
      return { ok: false, error: `Patch validation is "${patch.validation_status}", not "compiled". Cannot apply.` }
    }

    const fullPath = join(this.config.sandboxDir, patch.target_file)
    const validationDir = join(this.config.sandboxDir, 'state', 'patches', patchId)
    const backupPath = join(validationDir, 'original.txt')

    if (!existsSync(backupPath)) {
      return { ok: false, error: 'Backup file missing — cannot guarantee rollback' }
    }

    // Apply for real
    const tmpDiffPath = join(validationDir, 'patch.diff')
    const applyProc = Bun.spawn(
      ['patch', '-p1', fullPath, tmpDiffPath],
      { cwd: this.config.sandboxDir, stdout: 'pipe', stderr: 'pipe' },
    )
    const applyErr = await new Response(applyProc.stderr).text()
    const applyCode = await applyProc.exited
    if (applyCode !== 0) {
      try { copyFileSync(backupPath, fullPath) } catch {}
      return { ok: false, error: `Apply failed: ${applyErr}` }
    }

    // Trigger rebuild
    const buildProc = Bun.spawn(
      ['bash', join(this.config.sandboxDir, 'scripts', 'build.sh')],
      { cwd: this.config.sandboxDir, stdout: 'pipe', stderr: 'pipe' },
    )
    const buildOut = await new Response(buildProc.stdout).text()
    const buildErr = await new Response(buildProc.stderr).text()
    const buildCode = await buildProc.exited

    if (buildCode !== 0) {
      // Rollback!
      try { copyFileSync(backupPath, fullPath) } catch {}
      this.db.run(
        `UPDATE source_patches SET validation_status = 'failed', build_log = ? WHERE patch_id = ?`,
        [`Build failed during apply, rolled back: ${buildErr.slice(0, 1000)}`, patchId],
      )
      return { ok: false, error: `Build failed, patch reverted: ${buildErr.slice(0, 200)}` }
    }

    this.db.run(
      `UPDATE source_patches SET approved_at = ?, applied_at = ?, validation_status = 'applied', build_log = ? WHERE patch_id = ?`,
      [Date.now(), Date.now(), buildOut.slice(0, 1000), patchId],
    )

    log(`Patch ${patchId} applied successfully. Restart daemon to pick up changes.`)
    return { ok: true, build_log: buildOut.slice(0, 500) }
  }

  /**
   * Reject a patch (don't apply, mark as rejected).
   */
  reject(patchId: string, reason?: string): boolean {
    const patch = this.getPatch(patchId)
    if (!patch || patch.applied_at) return false
    this.db.run(
      `UPDATE source_patches SET rejected_at = ?, validation_output = ? WHERE patch_id = ?`,
      [Date.now(), reason ?? null, patchId],
    )
    return true
  }

  /**
   * Revert an applied patch by restoring from backup.
   */
  async revert(patchId: string): Promise<{ ok: boolean; error?: string }> {
    const patch = this.getPatch(patchId)
    if (!patch) return { ok: false, error: 'Patch not found' }
    if (!patch.applied_at) return { ok: false, error: 'Patch was never applied' }
    if (patch.reverted_at) return { ok: false, error: 'Patch already reverted' }

    const fullPath = join(this.config.sandboxDir, patch.target_file)
    const backupPath = join(this.config.sandboxDir, 'state', 'patches', patchId, 'original.txt')
    if (!existsSync(backupPath)) return { ok: false, error: 'Backup missing' }

    copyFileSync(backupPath, fullPath)

    // Rebuild
    const buildProc = Bun.spawn(
      ['bash', join(this.config.sandboxDir, 'scripts', 'build.sh')],
      { cwd: this.config.sandboxDir, stdout: 'pipe', stderr: 'pipe' },
    )
    await buildProc.exited

    this.db.run(`UPDATE source_patches SET reverted_at = ? WHERE patch_id = ?`, [Date.now(), patchId])
    log(`Patch ${patchId} reverted. Restart daemon to pick up changes.`)
    return { ok: true }
  }

  getPatch(patchId: string): PatchProposal | null {
    return this.db.query('SELECT * FROM source_patches WHERE patch_id = ?').get(patchId) as PatchProposal | null
  }

  listPending(): PatchProposal[] {
    return this.db.query(
      `SELECT * FROM source_patches
       WHERE approved_at IS NULL AND rejected_at IS NULL
       ORDER BY proposed_at DESC`,
    ).all() as PatchProposal[]
  }

  listAll(limit: number = 20): PatchProposal[] {
    return this.db.query(
      'SELECT * FROM source_patches ORDER BY proposed_at DESC LIMIT ?',
    ).all(limit) as PatchProposal[]
  }
}
