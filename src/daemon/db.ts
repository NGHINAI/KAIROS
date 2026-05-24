// SQLite state database for the KAIROS daemon.
// Uses bun:sqlite (synchronous, WAL mode, zero dependencies).
// Source of truth for all KAIROS state across restarts.

import { Database } from 'bun:sqlite'
import type {
  ApprovalRow,
  DreamRow,
  MemoryCandidateRow,
  MessageRow,
  SessionRow,
  TaskRow,
  TickRow,
} from './types'

export type DB = Database

const SCHEMA_VERSION = 2

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY
  );

  CREATE TABLE IF NOT EXISTS sessions (
    session_id      TEXT PRIMARY KEY,
    pid             INTEGER NOT NULL,
    cwd             TEXT NOT NULL,
    started_at      INTEGER NOT NULL,
    last_heartbeat  INTEGER NOT NULL,
    disconnected_at INTEGER,
    client_version  TEXT,
    metadata        TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_active
    ON sessions(disconnected_at) WHERE disconnected_at IS NULL;

  CREATE TABLE IF NOT EXISTS tasks (
    task_id           TEXT PRIMARY KEY,
    description       TEXT NOT NULL,
    session_id        TEXT,
    priority          TEXT NOT NULL DEFAULT 'normal',
    permission_mode   TEXT NOT NULL DEFAULT 'auto',
    working_dir       TEXT NOT NULL,
    watch             INTEGER NOT NULL DEFAULT 0,
    tick_interval     INTEGER,
    status            TEXT NOT NULL DEFAULT 'queued',
    created_at        INTEGER NOT NULL,
    started_at        INTEGER,
    completed_at      INTEGER,
    result_summary    TEXT,
    result_artifact   TEXT,
    subprocess_pid    INTEGER,
    tick_count        INTEGER NOT NULL DEFAULT 0,
    cost_cents        INTEGER NOT NULL DEFAULT 0,
    block_reason      TEXT,
    block_approval_id TEXT,
    FOREIGN KEY (session_id) REFERENCES sessions(session_id)
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at DESC);

  CREATE TABLE IF NOT EXISTS ticks (
    tick_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    fired_at      INTEGER NOT NULL,
    decision      TEXT NOT NULL,
    reasoning     TEXT,
    task_id       TEXT,
    duration_ms   INTEGER,
    cost_cents    INTEGER,
    model         TEXT,
    sleep_seconds INTEGER,
    FOREIGN KEY (task_id) REFERENCES tasks(task_id)
  );
  CREATE INDEX IF NOT EXISTS idx_ticks_time ON ticks(fired_at DESC);

  CREATE TABLE IF NOT EXISTS tool_calls (
    tool_call_id  INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id       TEXT NOT NULL,
    subprocess_seq INTEGER NOT NULL,
    tool_name     TEXT NOT NULL,
    tool_input    TEXT NOT NULL,
    tool_output   TEXT,
    started_at    INTEGER NOT NULL,
    completed_at  INTEGER,
    status        TEXT NOT NULL,
    block_reason  TEXT,
    FOREIGN KEY (task_id) REFERENCES tasks(task_id)
  );
  CREATE INDEX IF NOT EXISTS idx_tool_calls_task ON tool_calls(task_id);

  CREATE TABLE IF NOT EXISTS messages (
    message_id    TEXT PRIMARY KEY,
    session_id    TEXT,
    task_id       TEXT,
    kind          TEXT NOT NULL,
    priority      TEXT NOT NULL DEFAULT 'normal',
    body          TEXT NOT NULL,
    template_used TEXT,
    created_at    INTEGER NOT NULL,
    delivered_at  INTEGER,
    read_at       INTEGER,
    attachments   TEXT,
    FOREIGN KEY (session_id) REFERENCES sessions(session_id),
    FOREIGN KEY (task_id) REFERENCES tasks(task_id)
  );
  CREATE INDEX IF NOT EXISTS idx_messages_session
    ON messages(session_id, read_at);
  CREATE INDEX IF NOT EXISTS idx_messages_task ON messages(task_id);

  CREATE TABLE IF NOT EXISTS approvals (
    approval_id     TEXT PRIMARY KEY,
    task_id         TEXT NOT NULL,
    command         TEXT NOT NULL,
    matched_pattern TEXT NOT NULL,
    command_hash    TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    decided_at      INTEGER,
    decision        TEXT,
    decided_by      TEXT,
    reason          TEXT,
    FOREIGN KEY (task_id) REFERENCES tasks(task_id),
    FOREIGN KEY (decided_by) REFERENCES sessions(session_id)
  );
  CREATE INDEX IF NOT EXISTS idx_approvals_pending
    ON approvals(decided_at) WHERE decided_at IS NULL;

  CREATE TABLE IF NOT EXISTS memory_candidates (
    candidate_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    category           TEXT NOT NULL,
    content            TEXT NOT NULL,
    confidence         REAL NOT NULL DEFAULT 0.5,
    source_task_id     TEXT,
    source_tick_id     INTEGER,
    created_at         INTEGER NOT NULL,
    promoted_to_memory INTEGER NOT NULL DEFAULT 0,
    promoted_at        INTEGER,
    FOREIGN KEY (source_task_id) REFERENCES tasks(task_id),
    FOREIGN KEY (source_tick_id) REFERENCES ticks(tick_id)
  );
  CREATE INDEX IF NOT EXISTS idx_candidates_unpromoted
    ON memory_candidates(promoted_to_memory) WHERE promoted_to_memory = 0;

  CREATE TABLE IF NOT EXISTS dreams (
    dream_id        INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at      INTEGER NOT NULL,
    completed_at    INTEGER,
    status          TEXT NOT NULL DEFAULT 'running',
    candidates_read INTEGER,
    entries_added   INTEGER,
    entries_removed INTEGER,
    cost_cents      INTEGER,
    model           TEXT,
    notes           TEXT
  );

  -- ─── V2: Schedules, Observations, Feedback ──────────────────────

  CREATE TABLE IF NOT EXISTS schedules (
    schedule_id         TEXT PRIMARY KEY,
    description         TEXT NOT NULL,
    cron_human          TEXT NOT NULL,
    cron_parsed         TEXT,
    task_template       TEXT NOT NULL,
    working_dir         TEXT NOT NULL,
    priority            TEXT NOT NULL DEFAULT 'normal',
    permission_mode     TEXT NOT NULL DEFAULT 'auto',
    one_shot            INTEGER NOT NULL DEFAULT 0,
    next_fire_at        INTEGER,
    last_fired_at       INTEGER,
    fire_count          INTEGER NOT NULL DEFAULT 0,
    active              INTEGER NOT NULL DEFAULT 1,
    created_by_session  TEXT,
    created_at          INTEGER NOT NULL,
    FOREIGN KEY (created_by_session) REFERENCES sessions(session_id)
  );
  CREATE INDEX IF NOT EXISTS idx_schedules_next
    ON schedules(next_fire_at) WHERE active = 1;

  CREATE TABLE IF NOT EXISTS observations (
    observation_id      TEXT PRIMARY KEY,
    category            TEXT NOT NULL,
    subject             TEXT NOT NULL,
    description         TEXT NOT NULL,
    confidence          REAL NOT NULL DEFAULT 0.5,
    source              TEXT NOT NULL,
    severity            TEXT NOT NULL DEFAULT 'info',
    suggested_action    TEXT,
    state_hash          TEXT,
    first_observed_at   INTEGER NOT NULL,
    last_observed_at    INTEGER NOT NULL,
    last_suggested_at   INTEGER,
    suggestion_count    INTEGER NOT NULL DEFAULT 0,
    dismissed_at        INTEGER,
    resolved_at         INTEGER,
    acted_on_at         INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_observations_active
    ON observations(resolved_at, dismissed_at)
    WHERE resolved_at IS NULL AND dismissed_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_observations_category
    ON observations(category);

  CREATE TABLE IF NOT EXISTS feedback (
    feedback_id         INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id          TEXT,
    task_id             TEXT,
    observation_id      TEXT,
    schedule_id         TEXT,
    feedback_kind       TEXT NOT NULL,
    signal_strength     REAL NOT NULL,
    source              TEXT NOT NULL,
    context_json        TEXT,
    created_at          INTEGER NOT NULL,
    FOREIGN KEY (message_id) REFERENCES messages(message_id),
    FOREIGN KEY (task_id) REFERENCES tasks(task_id),
    FOREIGN KEY (observation_id) REFERENCES observations(observation_id),
    FOREIGN KEY (schedule_id) REFERENCES schedules(schedule_id)
  );
  CREATE INDEX IF NOT EXISTS idx_feedback_time ON feedback(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_feedback_observation ON feedback(observation_id);
  CREATE INDEX IF NOT EXISTS idx_feedback_kind ON feedback(feedback_kind);
`

export function initDatabase(dbPath: string): DB {
  const db = new Database(dbPath, { create: true })

  // Performance & safety pragmas
  db.run('PRAGMA journal_mode = WAL')
  db.run('PRAGMA synchronous = NORMAL')
  db.run('PRAGMA foreign_keys = ON')
  db.run('PRAGMA busy_timeout = 5000')

  // Apply schema (idempotent via IF NOT EXISTS)
  db.exec(SCHEMA_SQL)

  // Version tracking
  const row = db.query('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | null
  if (!row) {
    db.run('INSERT INTO schema_version VALUES (?)', [SCHEMA_VERSION])
  }

  return db
}

// ─── Session queries ────────────────────────────────────────────────

export function createSession(db: DB, params: {
  sessionId: string
  pid: number
  cwd: string
  clientVersion?: string
}): void {
  db.run(
    `INSERT INTO sessions (session_id, pid, cwd, started_at, last_heartbeat, client_version)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       pid = excluded.pid,
       cwd = excluded.cwd,
       last_heartbeat = excluded.last_heartbeat,
       disconnected_at = NULL`,
    [params.sessionId, params.pid, params.cwd, Date.now(), Date.now(), params.clientVersion ?? null],
  )
}

export function disconnectSession(db: DB, sessionId: string): void {
  db.run('UPDATE sessions SET disconnected_at = ? WHERE session_id = ?', [Date.now(), sessionId])
}

export function getActiveSessions(db: DB): SessionRow[] {
  return db.query('SELECT * FROM sessions WHERE disconnected_at IS NULL').all() as SessionRow[]
}

export function getActiveSessionCount(db: DB): number {
  const row = db.query('SELECT COUNT(*) as n FROM sessions WHERE disconnected_at IS NULL').get() as { n: number }
  return row.n
}

// ─── Task queries ───────────────────────────────────────────────────

export function createTask(db: DB, params: {
  description: string
  sessionId: string | null
  priority?: string
  permissionMode?: string
  workingDir: string
  watch?: boolean
  tickInterval?: number
}): string {
  const taskId = 't_' + crypto.randomUUID().slice(0, 8)
  db.run(
    `INSERT INTO tasks (task_id, description, session_id, priority, permission_mode,
     working_dir, watch, tick_interval, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
    [
      taskId, params.description, params.sessionId,
      params.priority ?? 'normal', params.permissionMode ?? 'auto',
      params.workingDir, params.watch ? 1 : 0,
      params.tickInterval ?? null, Date.now(),
    ],
  )
  return taskId
}

export function getTask(db: DB, taskId: string): TaskRow | null {
  return db.query('SELECT * FROM tasks WHERE task_id = ?').get(taskId) as TaskRow | null
}

export function getQueuedTasks(db: DB): TaskRow[] {
  // For watching tasks that were re-queued after a check:
  // only return them if enough time has passed since their last run
  // (started_at + tick_interval). This prevents the scheduler from
  // immediately re-running a watch that just completed.
  return db.query(`
    SELECT * FROM tasks WHERE status = 'queued'
    AND (
      watch = 0
      OR started_at IS NULL
      OR (started_at + COALESCE(tick_interval, 300) * 1000) <= ?
    )
    ORDER BY
      CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
                    WHEN 'normal' THEN 2 WHEN 'low' THEN 3 END,
      created_at ASC
  `).all(Date.now()) as TaskRow[]
}

export function getRunningTasks(db: DB): TaskRow[] {
  return db.query("SELECT * FROM tasks WHERE status = 'running'").all() as TaskRow[]
}

export function getAllTasks(db: DB, limit: number = 20): TaskRow[] {
  return db.query('SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?').all(limit) as TaskRow[]
}

export function updateTaskStatus(db: DB, taskId: string, status: string, extra?: Record<string, unknown>): void {
  const sets = ['status = ?']
  const vals: unknown[] = [status]

  if (extra) {
    for (const [key, val] of Object.entries(extra)) {
      // Convert camelCase to snake_case for DB columns
      const col = key.replace(/[A-Z]/g, c => '_' + c.toLowerCase())
      sets.push(`${col} = ?`)
      vals.push(val)
    }
  }

  vals.push(taskId)
  db.run(`UPDATE tasks SET ${sets.join(', ')} WHERE task_id = ?`, vals)
}

// ─── Tick queries ───────────────────────────────────────────────────

export function logTickRow(db: DB, tick: {
  decision: string
  reasoning: string
  taskId?: string | null
  durationMs: number
  costCents: number
  model: string
  sleepSeconds?: number | null
}): void {
  db.run(
    `INSERT INTO ticks (fired_at, decision, reasoning, task_id, duration_ms, cost_cents, model, sleep_seconds)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [Date.now(), tick.decision, tick.reasoning, tick.taskId ?? null,
     tick.durationMs, tick.costCents, tick.model, tick.sleepSeconds ?? null],
  )
}

export function getRecentTicks(db: DB, limit: number = 5): TickRow[] {
  return db.query('SELECT * FROM ticks ORDER BY fired_at DESC LIMIT ?').all(limit) as TickRow[]
}

export function getTickCount(db: DB): number {
  const row = db.query('SELECT COUNT(*) as n FROM ticks').get() as { n: number }
  return row.n
}

// ─── Message queries ────────────────────────────────────────────────

export function createMessage(db: DB, params: {
  sessionId: string | null
  taskId?: string | null
  kind: string
  priority?: string
  body: string
  templateUsed?: string | null
}): string {
  const msgId = 'm_' + crypto.randomUUID().slice(0, 8)
  db.run(
    `INSERT INTO messages (message_id, session_id, task_id, kind, priority, body, template_used, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [msgId, params.sessionId, params.taskId ?? null, params.kind,
     params.priority ?? 'normal', params.body, params.templateUsed ?? null, Date.now()],
  )
  return msgId
}

export function getUnreadMessages(db: DB, sessionId: string, limit: number = 10): MessageRow[] {
  return db.query(
    `SELECT * FROM messages
     WHERE (session_id = ? OR session_id IS NULL) AND read_at IS NULL
     ORDER BY created_at ASC LIMIT ?`,
  ).all(sessionId, limit) as MessageRow[]
}

export function markMessagesRead(db: DB, messageIds: string[]): void {
  if (messageIds.length === 0) return
  const placeholders = messageIds.map(() => '?').join(',')
  db.run(
    `UPDATE messages SET read_at = ? WHERE message_id IN (${placeholders})`,
    [Date.now(), ...messageIds],
  )
}

// ─── Approval queries ───────────────────────────────────────────────

export function getPendingApprovalCount(db: DB): number {
  const row = db.query('SELECT COUNT(*) as n FROM approvals WHERE decided_at IS NULL').get() as { n: number }
  return row.n
}

// ─── Summary queries (used by /status and envelope) ─────────────────

export function getDaemonSummary(db: DB): {
  tickCount: number
  queueDepth: number
  runningCount: number
  pendingApprovals: number
  connectedClients: number
} {
  return {
    tickCount: getTickCount(db),
    queueDepth: (db.query("SELECT COUNT(*) as n FROM tasks WHERE status='queued'").get() as { n: number }).n,
    runningCount: (db.query("SELECT COUNT(*) as n FROM tasks WHERE status='running'").get() as { n: number }).n,
    pendingApprovals: getPendingApprovalCount(db),
    connectedClients: getActiveSessionCount(db),
  }
}

// ─── Schedule queries ───────────────────────────────────────────────

export function createSchedule(db: DB, params: {
  description: string
  cronHuman: string
  cronParsed: string | null
  taskTemplate: string
  workingDir: string
  priority?: string
  permissionMode?: string
  oneShot?: boolean
  nextFireAt?: number | null
  createdBySession?: string | null
}): string {
  const id = 's_' + crypto.randomUUID().slice(0, 8)
  db.run(
    `INSERT INTO schedules (schedule_id, description, cron_human, cron_parsed,
     task_template, working_dir, priority, permission_mode, one_shot,
     next_fire_at, created_by_session, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, params.description, params.cronHuman, params.cronParsed,
     params.taskTemplate, params.workingDir,
     params.priority ?? 'normal', params.permissionMode ?? 'auto',
     params.oneShot ? 1 : 0, params.nextFireAt ?? null,
     params.createdBySession ?? null, Date.now()],
  )
  return id
}

export function getDueSchedules(db: DB): import('./types').ScheduleRow[] {
  return db.query(
    'SELECT * FROM schedules WHERE active = 1 AND next_fire_at IS NOT NULL AND next_fire_at <= ?',
  ).all(Date.now()) as import('./types').ScheduleRow[]
}

export function getActiveSchedules(db: DB): import('./types').ScheduleRow[] {
  return db.query('SELECT * FROM schedules WHERE active = 1 ORDER BY next_fire_at ASC').all() as import('./types').ScheduleRow[]
}

export function getSchedule(db: DB, scheduleId: string): import('./types').ScheduleRow | null {
  return db.query('SELECT * FROM schedules WHERE schedule_id = ?').get(scheduleId) as import('./types').ScheduleRow | null
}

export function updateScheduleAfterFire(db: DB, scheduleId: string, nextFireAt: number | null): void {
  db.run(
    'UPDATE schedules SET last_fired_at = ?, fire_count = fire_count + 1, next_fire_at = ? WHERE schedule_id = ?',
    [Date.now(), nextFireAt, scheduleId],
  )
}

export function deactivateSchedule(db: DB, scheduleId: string): void {
  db.run('UPDATE schedules SET active = 0 WHERE schedule_id = ?', [scheduleId])
}

export function deleteSchedule(db: DB, scheduleId: string): void {
  db.run('DELETE FROM schedules WHERE schedule_id = ?', [scheduleId])
}

// ─── Observation queries ────────────────────────────────────────────

export function createObservation(db: DB, params: {
  category: string
  subject: string
  description: string
  confidence?: number
  source: string
  severity?: string
  suggestedAction?: string | null
  stateHash?: string | null
}): string {
  const id = 'obs_' + crypto.randomUUID().slice(0, 8)
  const now = Date.now()
  db.run(
    `INSERT INTO observations (observation_id, category, subject, description,
     confidence, source, severity, suggested_action, state_hash,
     first_observed_at, last_observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, params.category, params.subject, params.description,
     params.confidence ?? 0.5, params.source, params.severity ?? 'info',
     params.suggestedAction ?? null, params.stateHash ?? null, now, now],
  )
  return id
}

export function getActiveObservations(db: DB, limit: number = 20): import('./types').ObservationRow[] {
  return db.query(
    'SELECT * FROM observations WHERE resolved_at IS NULL AND dismissed_at IS NULL ORDER BY last_observed_at DESC LIMIT ?',
  ).all(limit) as import('./types').ObservationRow[]
}

export function getObservationByHash(db: DB, stateHash: string): import('./types').ObservationRow | null {
  return db.query(
    'SELECT * FROM observations WHERE state_hash = ? AND resolved_at IS NULL AND dismissed_at IS NULL',
  ).get(stateHash) as import('./types').ObservationRow | null
}

export function updateObservationSeen(db: DB, observationId: string): void {
  db.run('UPDATE observations SET last_observed_at = ? WHERE observation_id = ?', [Date.now(), observationId])
}

export function markObservationSuggested(db: DB, observationId: string): void {
  db.run(
    'UPDATE observations SET last_suggested_at = ?, suggestion_count = suggestion_count + 1 WHERE observation_id = ?',
    [Date.now(), observationId],
  )
}

export function dismissObservation(db: DB, observationId: string): void {
  db.run('UPDATE observations SET dismissed_at = ? WHERE observation_id = ?', [Date.now(), observationId])
}

export function actOnObservation(db: DB, observationId: string): void {
  db.run('UPDATE observations SET acted_on_at = ? WHERE observation_id = ?', [Date.now(), observationId])
}

export function resolveObservation(db: DB, observationId: string): void {
  db.run('UPDATE observations SET resolved_at = ? WHERE observation_id = ?', [Date.now(), observationId])
}

export function getSuggestionCountLastHour(db: DB): number {
  const oneHourAgo = Date.now() - 3_600_000
  const row = db.query(
    'SELECT COUNT(*) as n FROM observations WHERE last_suggested_at > ?',
  ).get(oneHourAgo) as { n: number }
  return row.n
}

// ─── Feedback queries ───────────────────────────────────────────────

export function createFeedback(db: DB, params: {
  messageId?: string | null
  taskId?: string | null
  observationId?: string | null
  scheduleId?: string | null
  feedbackKind: string
  signalStrength: number
  source: string
  contextJson?: string | null
}): void {
  db.run(
    `INSERT INTO feedback (message_id, task_id, observation_id, schedule_id,
     feedback_kind, signal_strength, source, context_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [params.messageId ?? null, params.taskId ?? null,
     params.observationId ?? null, params.scheduleId ?? null,
     params.feedbackKind, params.signalStrength,
     params.source, params.contextJson ?? null, Date.now()],
  )
}

export function getFeedbackSince(db: DB, sinceMs: number): import('./types').FeedbackRow[] {
  return db.query(
    'SELECT * FROM feedback WHERE created_at > ? ORDER BY created_at DESC',
  ).all(sinceMs) as import('./types').FeedbackRow[]
}

export function getFeedbackForObservation(db: DB, observationId: string): import('./types').FeedbackRow[] {
  return db.query(
    'SELECT * FROM feedback WHERE observation_id = ? ORDER BY created_at DESC',
  ).all(observationId) as import('./types').FeedbackRow[]
}

export function hasExistingFeedback(db: DB, messageId: string): boolean {
  const row = db.query(
    'SELECT COUNT(*) as n FROM feedback WHERE message_id = ?',
  ).get(messageId) as { n: number }
  return row.n > 0
}

export function getUnprocessedReadMessages(db: DB, lastScanAt: number): MessageRow[] {
  return db.query(
    `SELECT * FROM messages
     WHERE read_at IS NOT NULL AND read_at > ?
     AND message_id NOT IN (SELECT message_id FROM feedback WHERE message_id IS NOT NULL)`,
  ).all(lastScanAt) as MessageRow[]
}

export function getIgnoredMessages(db: DB, olderThanMs: number): MessageRow[] {
  const cutoff = Date.now() - olderThanMs
  return db.query(
    `SELECT * FROM messages
     WHERE read_at IS NULL AND created_at < ?
     AND message_id NOT IN (SELECT message_id FROM feedback WHERE message_id IS NOT NULL)`,
  ).all(cutoff) as MessageRow[]
}
