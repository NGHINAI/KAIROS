// Self-generated skills: KAIROS writes new skills via claude -p when it
// recognizes a gap in its capabilities. New skills go through a staging
// pipeline: generate → stage → validate → promote → activate.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { chmodSync } from 'fs'
import { join } from 'path'
import { log, logError } from './logger'
import type { Config } from './types'
import type { SkillManifest, SkillRegistry } from './skillRegistry'

export type GenerationRequest = {
  description: string  // What the skill should do, in plain language
  example_use?: string  // Optional: how it would be invoked
  output_format?: 'json' | 'text'
  category?: string
}

export type GenerationResult = {
  ok: boolean
  skill_name?: string
  staged_path?: string
  active_path?: string
  test_output?: string
  error?: string
  cost_cents?: number
}

const SKILL_GENERATION_PROMPT = `You are writing a new skill for KAIROS, an autonomous AI assistant.

A skill is a single bash script that does one thing. It outputs JSON or text to stdout.
It runs in a subprocess with a 10-second timeout. It must be SAFE and READ-ONLY by default.

The user wants this skill:
{{DESCRIPTION}}

{{EXAMPLE_USE}}

Output EXACTLY this format (no preamble, no markdown fences, no explanation):

===MANIFEST===
{
  "name": "<kebab-case-name>",
  "description": "<one-line description>",
  "when_to_use": "<when KAIROS should consider this skill>",
  "command": "./run.sh",
  "timeout_ms": 10000,
  "output_format": "{{OUTPUT_FORMAT}}",
  "category": "{{CATEGORY}}",
  "generated": true
}
===SCRIPT===
#!/bin/bash
# <one-line description>
# (Your script here. MUST output to stdout. MUST exit 0 on success.
#  MUST be safe — read-only operations only unless explicitly requested.
#  Use $1, $2 etc for any args.)
===END===

Constraints:
- Name: lowercase-with-hyphens, max 30 chars, no special characters except hyphens
- Description: ONE sentence, no period at end
- Script: pure bash, no external tool installation
- If output_format is json: script MUST output valid JSON
- If reading files/dirs: handle "not found" gracefully (output JSON with error field, exit 0)
- NEVER do destructive things (rm, write, chmod, etc.) unless the description explicitly says so
- NEVER use sudo
- NEVER ask for user input (no read commands)
- If you need a tool that may not be installed (jq, curl, etc.), check first and fail gracefully`

export class SkillGenerator {
  constructor(
    private config: Config,
    private skillRegistry: SkillRegistry,
  ) {}

  /**
   * Generate a new skill from a natural-language description.
   * Returns generation result including paths and test output.
   */
  async generateSkill(request: GenerationRequest): Promise<GenerationResult> {
    log(`Generating new skill: "${request.description}"`)

    // Build prompt
    const prompt = SKILL_GENERATION_PROMPT
      .replace('{{DESCRIPTION}}', request.description)
      .replace('{{EXAMPLE_USE}}', request.example_use ? `Example use case: ${request.example_use}` : '')
      .replace('{{OUTPUT_FORMAT}}', request.output_format ?? 'json')
      .replace('{{CATEGORY}}', request.category ?? 'general')

    // Spawn claude -p (Sonnet for code generation quality)
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

      if (exitCode !== 0) {
        return { ok: false, error: `Generation subprocess exited ${exitCode}` }
      }

      try {
        const parsed = JSON.parse(stdout)
        stdout = (parsed.result ?? '') as string
        costCents = Math.round(((parsed.cost_usd ?? 0) as number) * 100)
      } catch {
        // Raw text fallback
      }
    } catch (err) {
      return { ok: false, error: `Subprocess error: ${err instanceof Error ? err.message : String(err)}` }
    }

    // Parse the structured output
    const manifestMatch = stdout.match(/===MANIFEST===([\s\S]*?)===SCRIPT===/)
    const scriptMatch = stdout.match(/===SCRIPT===([\s\S]*?)===END===/)

    if (!manifestMatch || !scriptMatch) {
      return {
        ok: false,
        error: `Could not parse generated skill. Got: ${stdout.slice(0, 300)}`,
        cost_cents: costCents,
      }
    }

    let manifest: SkillManifest
    try {
      manifest = JSON.parse(manifestMatch[1]!.trim()) as SkillManifest
    } catch (err) {
      return {
        ok: false,
        error: `Manifest JSON invalid: ${err instanceof Error ? err.message : String(err)}`,
        cost_cents: costCents,
      }
    }

    if (!manifest.name || !manifest.description) {
      return { ok: false, error: 'Manifest missing name or description', cost_cents: costCents }
    }

    // Sanitize name
    const safeName = manifest.name.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 30)
    if (safeName !== manifest.name) {
      log(`Renaming skill ${manifest.name} → ${safeName} (sanitized)`)
      manifest.name = safeName
    }

    // Mark as generated
    manifest.generated = true
    manifest.generated_at = Date.now()

    const script = scriptMatch[1]!.trim()
    if (!script.startsWith('#!')) {
      return { ok: false, error: 'Script missing shebang', cost_cents: costCents }
    }

    // Stage the skill
    const stagingDir = join(this.config.sandboxDir, 'skills', 'staging', manifest.name)
    if (existsSync(stagingDir)) {
      rmSync(stagingDir, { recursive: true, force: true })
    }
    mkdirSync(stagingDir, { recursive: true })

    const manifestPath = join(stagingDir, 'manifest.json')
    const scriptPath = join(stagingDir, manifest.command.replace(/^\.\//, ''))

    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
    writeFileSync(scriptPath, script)
    chmodSync(scriptPath, 0o755)

    log(`Skill staged: ${stagingDir}`)

    // Validate the staged skill
    const validationResult = await this.validateStagedSkill(scriptPath, manifest)
    if (!validationResult.ok) {
      // Leave staged for inspection but don't promote
      return {
        ok: false,
        skill_name: manifest.name,
        staged_path: stagingDir,
        error: `Validation failed: ${validationResult.error}`,
        test_output: validationResult.output,
        cost_cents: costCents,
      }
    }

    // Promote to active
    const activeDir = join(this.config.sandboxDir, 'skills', 'active', manifest.name)
    if (existsSync(activeDir)) {
      rmSync(activeDir, { recursive: true, force: true })
    }
    renameSync(stagingDir, activeDir)

    // Reload the registry so the new skill is available immediately
    this.skillRegistry.loadSkills()

    log(`Skill promoted to active: ${manifest.name}`)

    return {
      ok: true,
      skill_name: manifest.name,
      active_path: activeDir,
      test_output: validationResult.output,
      cost_cents: costCents,
    }
  }

  /**
   * Validate a staged skill by running it once and checking the output.
   */
  private async validateStagedSkill(
    scriptPath: string,
    manifest: SkillManifest,
  ): Promise<{ ok: boolean; output?: string; error?: string }> {
    try {
      const proc = Bun.spawn([scriptPath], {
        cwd: join(scriptPath, '..'),
        stdout: 'pipe',
        stderr: 'pipe',
      })

      const timeout = setTimeout(() => proc.kill('SIGTERM'), manifest.timeout_ms ?? 10_000)
      const stdout = await new Response(proc.stdout).text()
      const stderr = await new Response(proc.stderr).text()
      const exitCode = await proc.exited
      clearTimeout(timeout)

      if (exitCode !== 0) {
        return { ok: false, output: stdout, error: `Exit ${exitCode}: ${stderr.slice(0, 200)}` }
      }

      if (!stdout.trim()) {
        return { ok: false, output: '', error: 'Script produced no output' }
      }

      if (manifest.output_format === 'json') {
        try {
          JSON.parse(stdout)
        } catch (err) {
          return {
            ok: false,
            output: stdout,
            error: `Manifest claims JSON output but produced invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
          }
        }
      }

      return { ok: true, output: stdout.slice(0, 500) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * List skills currently in staging (failed validation, awaiting review).
   */
  listStagedSkills(): string[] {
    const stagingDir = join(this.config.sandboxDir, 'skills', 'staging')
    if (!existsSync(stagingDir)) return []
    try {
      const { readdirSync, statSync } = require('fs')
      return readdirSync(stagingDir).filter((entry: string) => {
        return statSync(join(stagingDir, entry)).isDirectory()
      })
    } catch {
      return []
    }
  }

  /**
   * Discard a staged skill (didn't pass validation, user wants to reject).
   */
  discardStaged(name: string): boolean {
    const stagingDir = join(this.config.sandboxDir, 'skills', 'staging', name)
    if (!existsSync(stagingDir)) return false
    rmSync(stagingDir, { recursive: true, force: true })
    return true
  }
}
