// Configuration loader for the KAIROS daemon.
// Loads defaults → sandbox overrides → config.json user overrides.

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { Config } from './types'

const DEFAULTS: Config = {
  sandboxDir: process.cwd(),
  isSandbox: false,
  verbose: false,
  port: 9876,
  tick: {
    defaultIntervalMs: 60_000,
    minSleepMs: 30_000,
    maxSleepMs: 1_800_000,
  },
  budget: {
    maxSubprocessPerHour: 60,
    maxProactiveMsgsPerHour: 10,
    maxCostCentsPerHour: 100,
  },
  task: {
    maxConcurrent: 3,
    timeoutMs: 30 * 60 * 1000,
  },
  models: {
    tick: 'claude-haiku-4-5',
    work: 'claude-sonnet-4-6',
    dream: 'claude-sonnet-4-6',
  },
  dream: {
    minIntervalMinutes: 15,
    minCandidates: 5,
  },
  schedule: {
    maxActiveSchedules: 20,
    checkIntervalTicks: 1,
  },
  observation: {
    scanIntervalTicks: 3,
    maxSuggestionsPerHour: 5,
    enabledCategories: [
      'git_uncommitted', 'git_behind_remote', 'branch_stale',
      'test_failing', 'lint_errors', 'large_diff',
      'dependency_outdated', 'todo_items', 'merge_conflicts', 'build_broken',
    ],
    commandTimeoutMs: 5_000,
  },
  feedback: {
    collectionIntervalTicks: 5,
    metricsWindowHours: 168,
  },
  proactive: {
    enabled: true,
    narratorIntervalMs: 5 * 60_000,
    providerConfigPath: join(process.env.HOME ?? '', '.kairos', 'providers.json'),
  },
  memory: { enabled: true, dreamIntervalMs: 30 * 60_000 },
  perception: { enabled: true, pipelinePollMs: 30_000 },
  orders: { enabled: true, filePath: join(process.env.HOME ?? '', '.kairos', 'STANDING_ORDERS.md') },
  agency: {
    enabled: true,
    inboxPath: join(process.env.HOME ?? '', '.kairos', 'inbox.md'),
    daemonHttpPort: 9877,
  },
}

const SANDBOX_OVERRIDES: Partial<Config> = {
  isSandbox: true,
  verbose: true,
  port: 'random' as const,
  tick: {
    defaultIntervalMs: 120_000,
    minSleepMs: 60_000,
    maxSleepMs: 600_000,
  },
  budget: {
    maxSubprocessPerHour: 10,
    maxProactiveMsgsPerHour: 5,
    maxCostCentsPerHour: 100,
  },
  task: {
    maxConcurrent: 1,
    timeoutMs: 10 * 60 * 1000,
  },
  dream: {
    minIntervalMinutes: 5,
    minCandidates: 3,
  },
  schedule: {
    maxActiveSchedules: 10,
    checkIntervalTicks: 1,
  },
  observation: {
    scanIntervalTicks: 3,
    maxSuggestionsPerHour: 3,
    enabledCategories: [
      'git_uncommitted', 'git_behind_remote', 'branch_stale',
      'test_failing', 'large_diff', 'merge_conflicts',
    ],
    commandTimeoutMs: 5_000,
  },
  feedback: {
    collectionIntervalTicks: 5,
    metricsWindowHours: 168,
  },
}

function deepMerge<T extends Record<string, unknown>>(base: T, overrides: Partial<T>): T {
  const result = { ...base }
  for (const key of Object.keys(overrides) as (keyof T)[]) {
    const val = overrides[key]
    if (val !== undefined && val !== null && typeof val === 'object' && !Array.isArray(val)) {
      result[key] = deepMerge(
        (base[key] ?? {}) as Record<string, unknown>,
        val as Record<string, unknown>,
      ) as T[keyof T]
    } else if (val !== undefined) {
      result[key] = val as T[keyof T]
    }
  }
  return result
}

export function loadConfig(sandboxDir: string, isSandbox: boolean, verbose: boolean): Config {
  let config: Config = { ...DEFAULTS, sandboxDir, verbose }

  if (isSandbox) {
    config = deepMerge(config, SANDBOX_OVERRIDES)
  }

  // User overrides from config.json
  const configPath = join(sandboxDir, 'config.json')
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, 'utf8')
      const userConfig = JSON.parse(raw) as Partial<Config>
      config = deepMerge(config, userConfig)
    } catch {
      // Bad config file — use defaults silently
    }
  }

  // CLI flags override everything
  config.sandboxDir = sandboxDir
  config.isSandbox = isSandbox
  config.verbose = verbose || isSandbox

  return config
}
