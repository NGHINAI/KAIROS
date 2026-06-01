// Configuration loader for the KAIROS daemon.
// Loads defaults → sandbox overrides → config.json user overrides.

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { Config } from './types'

/** Parse an env var as an integer, falling back to `def` when unset/invalid. */
function envInt(name: string, def: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return def
  const n = parseInt(raw, 10)
  return Number.isFinite(n) ? n : def
}

const DEFAULTS: Config = {
  sandboxDir: process.cwd(),
  isSandbox: false,
  verbose: false,
  // Legacy daemon HTTP server port. Was 9876 historically but that's now reserved
  // for the wrap-API on KAIROS_DAEMON_PORT (Electron WS hardcodes 9876). When
  // KAIROS_WITH_VOICE=true the wrap-api binds 9876, so the legacy server has to
  // live elsewhere; 8765 picked as a free, memorable default.
  port: 8765,
  tick: {
    // Autonomous scheduler tick — how often the daemon wakes to evaluate whether
    // to act proactively. Env: KAIROS_TICK_INTERVAL_MS (default 60s).
    defaultIntervalMs: envInt('KAIROS_TICK_INTERVAL_MS', 60_000),
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
    // The autonomous "co-worker" brain (tick decisions + narrator + observers).
    // Set KAIROS_PROACTIVE_ENABLED=false to run a pure on-demand agent with NO
    // background LLM calls (voice still works). Narrator cadence via env.
    enabled: process.env.KAIROS_PROACTIVE_ENABLED !== 'false',
    // NOTE: the standalone narrator timer is dormant — the perception pipeline
    // drives narrator.tick() instead, so narrator cadence == KAIROS_PERCEPTION_POLL_MS.
    // This default is kept only as the Narrator's fallback if ever run standalone.
    narratorIntervalMs: 5 * 60_000,
    providerConfigPath: join(process.env.HOME ?? '', '.kairos', 'providers.json'),
  },
  memory: { enabled: true, dreamIntervalMs: envInt('KAIROS_DREAM_INTERVAL_MS', 30 * 60_000) },
  perception: {
    // Observes world-state events (git, files, etc.) and classifies them via LLM.
    // Disable or slow the poll to cut background calls. Env-driven.
    enabled: process.env.KAIROS_PERCEPTION_ENABLED !== 'false',
    pipelinePollMs: envInt('KAIROS_PERCEPTION_POLL_MS', 30_000),
  },
  orders: { enabled: true, filePath: join(process.env.HOME ?? '', '.kairos', 'STANDING_ORDERS.md') },
  agency: {
    enabled: true,
    inboxPath: join(process.env.HOME ?? '', '.kairos', 'inbox.md'),
    daemonHttpPort: 9877,
  },
  mcp: {
    enabled: true,
    configPath: join(process.env.HOME ?? '', '.kairos', 'mcp-servers.json'),
    skillsRoot: join(process.env.HOME ?? '', '.kairos', 'skills'),
  },
  restraint: {
    enabled: true,
    configPath: join(process.env.HOME ?? '', '.kairos', 'restraint-config.json'),
  },
  withVoice: false,
  // Background autonomous tick loop (proactive decisions every KAIROS_TICK_INTERVAL_MS).
  // The main source of idle LLM spend. Set false for a pure on-demand agent —
  // voice, memory, and persona all keep working; only the periodic ticking stops.
  autonomousEnabled: process.env.KAIROS_AUTONOMOUS_ENABLED !== 'false',
  mode: (process.env.KAIROS_MODE as 'byo' | 'hosted' | 'local' | undefined) ?? 'byo',
  embedding: {
    enabled: process.env.KAIROS_EMBED_ENABLED === 'false' ? false : true,
    cache_dir: process.env.KAIROS_EMBED_CACHE_DIR ?? join(process.env.HOME ?? '', '.kairos', 'cache', 'huggingface'),
  },
  composio: {
    enabled: process.env.KAIROS_COMPOSIO_ENABLED !== 'false',
    api_key: process.env.COMPOSIO_API_KEY,
    poll_interval_ms: process.env.KAIROS_COMPOSIO_POLL_MS ? parseInt(process.env.KAIROS_COMPOSIO_POLL_MS) : undefined,
  },
  persona: {
    enabled: process.env.KAIROS_PERSONA_ENABLED !== 'false',
    paths: {
      soul: process.env.KAIROS_SOUL_PATH ?? join(process.env.HOME ?? '', '.kairos', 'soul.md'),
      persona: process.env.KAIROS_PERSONA_PATH ?? join(process.env.HOME ?? '', '.kairos', 'persona.md'),
      traj: process.env.KAIROS_TRAJ_DIR ?? join(process.env.HOME ?? '', '.kairos', 'traj'),
    },
    token_cap: process.env.KAIROS_PERSONA_TOKEN_CAP ? parseInt(process.env.KAIROS_PERSONA_TOKEN_CAP) : undefined,
    dreaming: {
      light_interval_ms: process.env.KAIROS_DREAM_LIGHT_MS ? parseInt(process.env.KAIROS_DREAM_LIGHT_MS) : undefined,
      rem_interval_ms: process.env.KAIROS_DREAM_REM_MS ? parseInt(process.env.KAIROS_DREAM_REM_MS) : undefined,
      deep_interval_ms: process.env.KAIROS_DREAM_DEEP_MS ? parseInt(process.env.KAIROS_DREAM_DEEP_MS) : undefined,
    },
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

export function loadConfig(
  sandboxDir: string = process.cwd(),
  isSandbox: boolean = false,
  verbose: boolean = false,
): Config {
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

  // Env-flag overrides
  const withVoice = (process.env.KAIROS_WITH_VOICE ?? 'false').toLowerCase() === 'true'
  config.withVoice = withVoice

  return config
}
