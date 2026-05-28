// src/daemon/skills/skillDispatcher.ts
// Routes skill invocations to the right executor (TS / Python / declarative)
// and records telemetry to UsageTracker.

import { existsSync } from 'fs'
import { join } from 'path'
import type { SkillExecutionResult, SkillFile } from './types'
import type { SkillRegistry } from './skillRegistry'
import type { UsageTracker } from './usageTracker'
import type { TsRunner } from './tsRunner'
import type { PythonRunner } from './pythonRunner'

export type SkillDispatcherDeps = {
  skillRegistry: SkillRegistry
  usageTracker: UsageTracker
  tsRunner: TsRunner
  pythonRunner: PythonRunner
}

export type DispatchResult = SkillExecutionResult & { slug: string }

export class SkillDispatcher {
  constructor(private deps: SkillDispatcherDeps) {}

  /** Execute a skill by slug. Records usage. On failure, sets the Curator review flag. */
  async invoke(slug: string, args: Record<string, unknown>): Promise<DispatchResult> {
    const startedAt = Date.now()
    const skill = this.deps.skillRegistry.loadFullSkill(slug)
    if (!skill) {
      const result = {
        slug,
        ok: false,
        error: `skill not found or not active: ${slug}`,
        duration_ms: 0,
        sandbox: 'declarative' as const,
      }
      return result
    }

    const route = this.routeFor(skill)
    let result: SkillExecutionResult

    if (route === 'ts') {
      result = await this.deps.tsRunner.execute(
        join(skill.dir_path, 'scripts', 'main.ts'),
        args,
      )
    } else if (route === 'python') {
      result = await this.deps.pythonRunner.execute(
        join(skill.dir_path, 'scripts', 'main.py'),
        args,
      )
    } else {
      // declarative: no execution; return body for the agency layer to interpret
      result = {
        ok: true,
        output: skill.body,
        duration_ms: Date.now() - startedAt,
        sandbox: 'declarative',
      }
    }

    // Record telemetry
    this.deps.usageTracker.recordUse(slug, result.duration_ms, result.ok, result.error)
    if (!result.ok) {
      this.deps.usageTracker.markCuratorFlag(slug)
    }

    return { ...result, slug }
  }

  /** Compute the route for a skill based on which scripts exist. */
  routeFor(skill: SkillFile): 'ts' | 'python' | 'declarative' {
    const scriptsDir = join(skill.dir_path, 'scripts')
    if (existsSync(join(scriptsDir, 'main.ts'))) return 'ts'
    if (existsSync(join(scriptsDir, 'main.py'))) return 'python'
    return 'declarative'
  }
}
