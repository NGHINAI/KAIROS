// Shared TypeScript types for the KAIROS daemon.

// ─── Configuration ──────────────────────────────────────────────────

export type Config = {
  sandboxDir: string
  isSandbox: boolean
  verbose: boolean
  port: number | 'random'
  tick: {
    defaultIntervalMs: number
    minSleepMs: number
    maxSleepMs: number
  }
  budget: {
    maxSubprocessPerHour: number
    maxProactiveMsgsPerHour: number
    maxCostCentsPerHour: number
  }
  task: {
    maxConcurrent: number
    timeoutMs: number
  }
  models: {
    tick: string
    work: string
    dream: string
  }
  dream: {
    minIntervalMinutes: number
    minCandidates: number
  }
  schedule: {
    maxActiveSchedules: number
    checkIntervalTicks: number
  }
  observation: {
    scanIntervalTicks: number
    maxSuggestionsPerHour: number
    enabledCategories: string[]
    commandTimeoutMs: number
  }
  feedback: {
    collectionIntervalTicks: number
    metricsWindowHours: number
  }
  proactive: {
    enabled: boolean
    narratorIntervalMs: number
    providerConfigPath: string
  }
  memory: {
    enabled: boolean
    dreamIntervalMs: number
  }
  perception: {
    enabled: boolean
    pipelinePollMs: number
  }
  orders: {
    enabled: boolean
    filePath: string
    v2_enabled?: boolean
  }
  agency: {
    enabled: boolean
    inboxPath: string
    daemonHttpPort: number
  }
  mcp: {
    enabled: boolean
    configPath: string
    skillsRoot: string
  }
  restraint: {
    enabled: boolean
    configPath: string   // ~/.kairos/restraint-config.json
  }
  mode?: 'byo' | 'hosted' | 'local'
  embedding?: {
    enabled?: boolean
    cache_dir?: string
    model?: string
  }
  composio?: {
    enabled?: boolean
    api_key?: string
    session_id?: string
    poll_interval_ms?: number
  }
  persona?: {
    enabled?: boolean
    paths?: {
      soul?: string         // defaults to ~/.kairos/soul.md
      persona?: string      // defaults to ~/.kairos/persona.md
      traj?: string         // defaults to ~/.kairos/traj/
      dreams?: string       // defaults to ~/.kairos/DREAMS.md (handled by extension)
    }
    token_cap?: number      // default 400 (PersonaUpdater)
    dreaming?: {
      light_interval_ms?: number   // default 4h
      rem_interval_ms?: number     // default 24h
      deep_interval_ms?: number    // default 7d
    }
  }
  skills?: {
    enabled?: boolean              // default true
    dir?: string                   // default ~/.kairos/skills/
    awm?: {
      enabled?: boolean            // default true
      interval_ms?: number         // default 4h
      min_tool_calls?: number      // default 5
      min_occurrences?: number     // default 3
    }
    curator?: {
      enabled?: boolean            // default true
      cycle_interval_days?: number // default 7
      idle_gate_ms?: number        // default 2h
    }
  }
}

// ─── Database row types ─────────────────────────────────────────────

export type SessionRow = {
  session_id: string
  pid: number
  cwd: string
  started_at: number
  last_heartbeat: number
  disconnected_at: number | null
  client_version: string | null
  metadata: string | null
}

export type TaskRow = {
  task_id: string
  description: string
  session_id: string | null
  priority: 'low' | 'normal' | 'high' | 'urgent'
  permission_mode: 'auto' | 'bypass' | 'trusted'
  working_dir: string
  watch: number
  tick_interval: number | null
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'blocked' | 'interrupted'
  created_at: number
  started_at: number | null
  completed_at: number | null
  result_summary: string | null
  result_artifact: string | null
  subprocess_pid: number | null
  tick_count: number
  cost_cents: number
  block_reason: string | null
  block_approval_id: string | null
}

export type TickRow = {
  tick_id: number
  fired_at: number
  decision: string
  reasoning: string | null
  task_id: string | null
  duration_ms: number | null
  cost_cents: number | null
  model: string | null
  sleep_seconds: number | null
}

export type MessageRow = {
  message_id: string
  session_id: string | null
  task_id: string | null
  kind: string
  priority: string
  body: string
  template_used: string | null
  created_at: number
  delivered_at: number | null
  read_at: number | null
  attachments: string | null
}

export type ApprovalRow = {
  approval_id: string
  task_id: string
  command: string
  matched_pattern: string
  command_hash: string
  created_at: number
  decided_at: number | null
  decision: string | null
  decided_by: string | null
  reason: string | null
}

export type MemoryCandidateRow = {
  candidate_id: number
  category: string
  content: string
  confidence: number
  source_task_id: string | null
  source_tick_id: number | null
  created_at: number
  promoted_to_memory: number
  promoted_at: number | null
}

export type DreamRow = {
  dream_id: number
  started_at: number
  completed_at: number | null
  status: string
  candidates_read: number | null
  entries_added: number | null
  entries_removed: number | null
  cost_cents: number | null
  model: string | null
  notes: string | null
}

// ─── Daemon runtime state ───────────────────────────────────────────

export type DaemonState = {
  status: 'starting' | 'running' | 'shutting_down'
  port: number
  pid: number
  startedAt: number
  isSandbox: boolean
}

// ─── Schedule types ─────────────────────────────────────────────────

export type ScheduleRow = {
  schedule_id: string
  description: string
  cron_human: string
  cron_parsed: string | null
  task_template: string
  working_dir: string
  priority: 'low' | 'normal' | 'high' | 'urgent'
  permission_mode: 'auto' | 'bypass' | 'trusted'
  one_shot: number
  next_fire_at: number | null
  last_fired_at: number | null
  fire_count: number
  active: number
  created_by_session: string | null
  created_at: number
}

// ─── Observation types ──────────────────────────────────────────────

export type ObservationCategory =
  | 'git_uncommitted'
  | 'git_behind_remote'
  | 'branch_stale'
  | 'test_failing'
  | 'lint_errors'
  | 'large_diff'
  | 'dependency_outdated'
  | 'file_pattern'
  | 'env_mismatch'
  | 'todo_items'
  | 'build_broken'
  | 'merge_conflicts'

export type ObservationSeverity = 'info' | 'warning' | 'critical'

export type ObservationRow = {
  observation_id: string
  category: ObservationCategory
  subject: string
  description: string
  confidence: number
  source: string
  severity: ObservationSeverity
  suggested_action: string | null
  state_hash: string | null
  first_observed_at: number
  last_observed_at: number
  last_suggested_at: number | null
  suggestion_count: number
  dismissed_at: number | null
  resolved_at: number | null
  acted_on_at: number | null
}

// ─── Feedback types ─────────────────────────────────────────────────

export type FeedbackKind =
  | 'read_fast'
  | 'read_slow'
  | 'ignored'
  | 'dismissed'
  | 'acted_on'
  | 'cancelled'
  | 'completed'
  | 'explicit_positive'
  | 'explicit_negative'

export type FeedbackRow = {
  feedback_id: number
  message_id: string | null
  task_id: string | null
  observation_id: string | null
  schedule_id: string | null
  feedback_kind: FeedbackKind
  signal_strength: number
  source: string
  context_json: string | null
  created_at: number
}

// ─── Effectiveness metrics (computed from feedback) ─────────────────

export type EffectivenessMetrics = {
  byCategory: Record<string, { totalSignals: number; avgStrength: number; actionRate: number }>
  byDecisionType: Record<string, { totalSignals: number; avgStrength: number }>
  byTimeOfDay: Record<string, { totalSignals: number; avgStrength: number }>
  suppressedCategories: string[]
  boostedCategories: string[]
}

// ─── Decision types ─────────────────────────────────────────────────

export type Decision =
  | { kind: 'SLEEP'; seconds: number; reasoning: string; costCents: number; model: string }
  | { kind: 'WORK'; taskId: string; reasoning: string; costCents: number; model: string }
  | { kind: 'INVESTIGATE'; topic: string; reasoning: string; costCents: number; model: string }
  | { kind: 'NOTIFY'; body: string; sessionId: string; priority: 'normal' | 'proactive' | 'urgent'; reasoning: string; costCents: number; model: string }
  | { kind: 'CONSOLIDATE'; reasoning: string; costCents: number; model: string }
  | { kind: 'SUGGEST'; observationId: string; body: string; severity: ObservationSeverity; reasoning: string; costCents: number; model: string }

// ─── Tick event types ───────────────────────────────────────────────

export type TickSource =
  | 'time'
  | 'new_task'
  | 'approval_decided'
  | 'session_connected'
  | 'subprocess_done'
  | 'file_watch'
  | 'force_dream'
  | 'schedule_due'
  | 'observation_scan'

export type TickEvent = {
  source: TickSource
  reason: string
}

// ─── Envelope (every MCP tool response wraps in this) ───────────────

export type ResponseEnvelope<T = unknown> = {
  result: T
  _kairos_state: {
    tick_count: number
    queue_depth: number
    running_count: number
    pending_approvals: number
    connected_clients: number
  }
  _kairos_pending: MessageRow[]
}
