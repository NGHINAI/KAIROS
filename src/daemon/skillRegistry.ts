// Skill plugin system: scans skills/active/ for manifests and registers them
// as invokable capabilities. Hot-reloads on every scan.
//
// Each skill is a directory with:
//   - manifest.json       (metadata: name, description, when_to_use, command)
//   - <executable>        (the actual script — bash, python, node, anything)
//
// Skills are domain-agnostic. They can monitor anything, query anything,
// fetch anything. The registry just knows how to invoke them.

import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join, resolve } from 'path'
import { log, logError } from './logger'

export type SkillManifest = {
  name: string
  description: string
  when_to_use: string  // Tells KAIROS when to consider this skill
  command: string       // Script filename (relative to skill directory)
  args?: string[]       // Default args
  timeout_ms?: number   // Default 10s
  output_format?: 'json' | 'text'  // What the skill outputs
  category?: string     // Optional categorization (monitoring, query, action, etc.)
  generated?: boolean   // True if KAIROS wrote this skill (Layer 2)
  generated_at?: number
  // Multi-modal support (L6-H):
  input_type?: 'text' | 'image' | 'audio'  // What input the skill accepts
  // For image/audio skills: the file path is passed as the first arg
}

export type LoadedSkill = SkillManifest & {
  skill_dir: string         // Absolute path to skill directory
  command_path: string      // Absolute path to executable
  loaded_at: number
}

export type SkillInvocationResult = {
  ok: boolean
  output: string             // Raw stdout
  parsed?: unknown           // JSON parsed if output_format='json'
  exit_code: number
  duration_ms: number
  error?: string
}

export class SkillRegistry {
  private skills: Map<string, LoadedSkill> = new Map()
  private skillsDir: string
  private lastScanAt = 0

  constructor(sandboxDir: string) {
    this.skillsDir = join(sandboxDir, 'skills', 'active')
  }

  /**
   * Scan the skills directory and load all valid manifests.
   * Returns count of loaded skills.
   */
  loadSkills(): number {
    if (!existsSync(this.skillsDir)) {
      return 0
    }

    const previousNames = new Set(this.skills.keys())
    const currentNames = new Set<string>()

    try {
      const entries = readdirSync(this.skillsDir)
      for (const entry of entries) {
        const skillDir = join(this.skillsDir, entry)
        if (!statSync(skillDir).isDirectory()) continue

        const manifestPath = join(skillDir, 'manifest.json')
        if (!existsSync(manifestPath)) continue

        try {
          const raw = readFileSync(manifestPath, 'utf8')
          const manifest = JSON.parse(raw) as SkillManifest

          // Validate required fields
          if (!manifest.name || !manifest.description || !manifest.command) {
            log(`Skill ${entry}: invalid manifest (missing name/description/command)`, 'warn')
            continue
          }

          const commandPath = resolve(skillDir, manifest.command)
          if (!existsSync(commandPath)) {
            log(`Skill ${manifest.name}: command not found at ${commandPath}`, 'warn')
            continue
          }

          this.skills.set(manifest.name, {
            ...manifest,
            skill_dir: skillDir,
            command_path: commandPath,
            loaded_at: Date.now(),
          })
          currentNames.add(manifest.name)
        } catch (err) {
          logError(`Failed to load skill ${entry}`, err)
        }
      }
    } catch (err) {
      logError('Failed to scan skills directory', err)
      return this.skills.size
    }

    // Remove skills that no longer exist on disk
    for (const name of previousNames) {
      if (!currentNames.has(name)) {
        this.skills.delete(name)
      }
    }

    const newCount = currentNames.size - (previousNames.size - this.skills.size + currentNames.size - this.skills.size)
    if (this.lastScanAt === 0 && this.skills.size > 0) {
      log(`Loaded ${this.skills.size} skill(s): ${Array.from(this.skills.keys()).join(', ')}`)
    }
    this.lastScanAt = Date.now()

    return this.skills.size
  }

  getSkill(name: string): LoadedSkill | null {
    return this.skills.get(name) ?? null
  }

  listSkills(): LoadedSkill[] {
    return Array.from(this.skills.values())
  }

  /**
   * Build a context summary for KAIROS prompts: list of available skills
   * with descriptions, so the decision engine knows what's possible.
   */
  describeForPrompt(): string {
    if (this.skills.size === 0) return '(No custom skills loaded)'
    const lines = ['Available skills (call via kairos_skill_invoke):']
    for (const skill of this.skills.values()) {
      lines.push(`  - ${skill.name}: ${skill.description}`)
      if (skill.when_to_use) lines.push(`    Use when: ${skill.when_to_use}`)
    }
    return lines.join('\n')
  }

  /**
   * Invoke a skill by name. Runs the command, captures output, parses if JSON.
   */
  async invokeSkill(name: string, extraArgs: string[] = []): Promise<SkillInvocationResult> {
    const skill = this.skills.get(name)
    if (!skill) {
      return {
        ok: false,
        output: '',
        exit_code: -1,
        duration_ms: 0,
        error: `Skill not found: ${name}`,
      }
    }

    const startMs = Date.now()
    const args = [...(skill.args ?? []), ...extraArgs]
    const timeoutMs = skill.timeout_ms ?? 10_000

    try {
      const proc = Bun.spawn([skill.command_path, ...args], {
        cwd: skill.skill_dir,
        stdout: 'pipe',
        stderr: 'pipe',
      })

      const timeout = setTimeout(() => proc.kill('SIGTERM'), timeoutMs)
      const output = await new Response(proc.stdout).text()
      const stderr = await new Response(proc.stderr).text()
      const exitCode = await proc.exited
      clearTimeout(timeout)

      const durationMs = Date.now() - startMs

      let parsed: unknown
      if (skill.output_format === 'json' && output.trim()) {
        try {
          parsed = JSON.parse(output)
        } catch (err) {
          // Skill claimed JSON output but produced invalid JSON
          return {
            ok: false,
            output,
            exit_code: exitCode,
            duration_ms: durationMs,
            error: `Skill claimed JSON output but produced invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
          }
        }
      }

      return {
        ok: exitCode === 0,
        output,
        parsed,
        exit_code: exitCode,
        duration_ms: durationMs,
        error: exitCode !== 0 ? stderr.trim() || `Exit code ${exitCode}` : undefined,
      }
    } catch (err) {
      return {
        ok: false,
        output: '',
        exit_code: -1,
        duration_ms: Date.now() - startMs,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }
}
