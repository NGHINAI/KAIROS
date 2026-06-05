// src/daemon/agency/actionExecutor.ts
// The heart of C.1. Receives ActionRequest records, looks up the intent,
// gates on tier (GREEN/YELLOW execute, ORANGE/RED queue to inbox),
// writes UFO2 trajectory steps for every attempt.
//
// Idempotency: 5-min dedup window for intents that declare a key.
// Tier enforcement: STRUCTURAL (from intent manifest) — not LLM prompt.
//
// Phase C.1.5 (Earned Interrupt): optional RestraintPipeline consulted before
// dispatch. When present, the pipeline can suppress, dry-run, digest, or log-only
// the action before it ever reaches the tier gate. Interrupt/surface modes
// fall through to the normal execution path.

import type { Database } from 'bun:sqlite'
import { log, logError } from '../logger'
import { tierEmoji, requiresApproval } from './autonomyTier'
import type { IntentRegistry } from './intentRegistry'
import type { TrajectoryLog } from './trajectoryLog'
import type { InboxSurface } from './inboxSurface'
import type { NativeNotifier } from './nativeNotifier'
import type { ActionRequest, ActionStatus, TrajectoryStep } from './types'
import type { RestraintPipeline, EvaluateInputs } from '../restraint/restraintPipeline'
import type { TrajWriter } from '../persona/trajWriter'
import type { TrajEntry } from '../persona/types'

export const EXECUTOR_SCHEMA = `
  CREATE TABLE IF NOT EXISTS agency_pending_actions (
    request_id    TEXT PRIMARY KEY,
    intent_id     TEXT NOT NULL,
    args_json     TEXT NOT NULL,
    reasoning     TEXT NOT NULL,
    inbox_item_id TEXT,
    trajectory_id TEXT NOT NULL,
    status        TEXT NOT NULL,
    requested_at  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS agency_idempotency (
    key        TEXT PRIMARY KEY,
    last_seen  INTEGER NOT NULL
  );
`

const IDEM_WINDOW_MS = 5 * 60_000

/** Cross-module dependencies a handler may need at execution time. */
export type ActionContext = {
  db: Database
  notifier: NativeNotifier
  embedder: { embed(text: string): Promise<number[]> }
  semantic: { reinforceOrWrite(input: any): number }
}

export type DispatchResult = {
  status: ActionStatus
  details?: string
  inbox_item_id?: string
  trajectory_id: string
}

export class ActionExecutor {
  private trajWriter?: TrajWriter

  constructor(
    private db: Database,
    private registry: IntentRegistry,
    private trajectory: TrajectoryLog,
    private inbox: InboxSurface,
    private ctx: ActionContext,
    // Optional — omit to skip restraint (existing callers and tests unaffected)
    private restraintPipeline?: RestraintPipeline | null,
  ) {
    db.exec(EXECUTOR_SCHEMA)
  }

  /** Wire in a TrajWriter after construction (C.3.1 persona subsystem). */
  setTrajWriter(writer: TrajWriter): void {
    this.trajWriter = writer
  }

  async dispatch(request: ActionRequest): Promise<DispatchResult> {
    const entry = this.registry.get(request.intent_id)
    if (!entry) {
      const trajectoryId = this.trajectory.start(`Unknown intent: ${request.intent_id}`)
      this.trajectory.finalize(trajectoryId, 'failure', `unknown intent ${request.intent_id}`)
      return { status: 'failed', details: `unknown intent ${request.intent_id}`, trajectory_id: trajectoryId }
    }

    // ─── Phase C.1.5: Restraint gate ─────────────────────────────────────────
    // Consult the RestraintPipeline BEFORE idempotency / tier checks.
    // Default EvaluateInputs are conservative; C.3 will wire intent metadata
    // and LLM persona checks to refine these per-request.
    if (this.restraintPipeline) {
      const inputs: EvaluateInputs = {
        urgency: 0.5,              // default; trigger metadata overrides in C.3
        rule_match_strength: 1.0,  // trigger evaluator already confirmed match
        personal_relevance: 0.5,   // static for C.1.5; LLM persona check in C.3
        novelty: 1.0,              // default; karma data will lower in future
        urgent: false,             // explicit flag from caller, default false
      }
      const decision = await this.restraintPipeline.evaluate(request, inputs)

      // Modes that bypass execution entirely
      if (
        decision.mode === 'suppressed' ||
        decision.mode === 'log_only' ||
        decision.mode === 'dry_run' ||
        decision.mode === 'digest'
      ) {
        const trajectoryId = this.trajectory.start(
          `[${decision.mode}] ${entry.intent.id}: ${request.reasoning.slice(0, 80)}`,
        )
        // Record trajectory but do NOT run handler
        const outcomeMap = {
          suppressed: 'failure',
          log_only: 'success',
          dry_run: 'success',
          digest: 'partial',
        } as const
        this.trajectory.finalize(
          trajectoryId,
          outcomeMap[decision.mode as keyof typeof outcomeMap],
          `restraint: ${decision.reason}`,
        )
        log(`ActionExecutor: restraint(${decision.mode}) ${entry.intent.id} — ${decision.reason}`)
        return {
          status: decision.mode as ActionStatus,
          details: decision.reason,
          trajectory_id: trajectoryId,
        }
      }

      // 'interrupt' or 'surface' — fall through to normal execution, then record delivery
      // (recordDelivered called after executeAndLog below)
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Idempotency check
    if (entry.intent.idempotencyKey) {
      const key = entry.intent.idempotencyKey(request.args)
      const last = this.db.query('SELECT last_seen FROM agency_idempotency WHERE key = ?').get(key) as { last_seen: number } | null
      if (last && Date.now() - last.last_seen < IDEM_WINDOW_MS) {
        const trajectoryId = this.trajectory.start(`Dedup: ${request.intent_id}`)
        this.trajectory.finalize(trajectoryId, 'success', `dedup hit on key ${key}`)
        return { status: 'completed', details: `dedup within ${IDEM_WINDOW_MS / 1000}s`, trajectory_id: trajectoryId }
      }
      this.db.run('INSERT OR REPLACE INTO agency_idempotency (key, last_seen) VALUES (?, ?)', [key, Date.now()])
    }

    const trajectoryId = this.trajectory.start(`${entry.intent.id}: ${request.reasoning.slice(0, 80)}`)

    if (requiresApproval(entry.tier)) {
      const inboxItemId = this.inbox.add({
        tier: entry.tier,
        intent_id: entry.intent.id,
        description: `${entry.intent.description} — ${request.reasoning.slice(0, 80)}`,
        args_preview: JSON.stringify(request.args).slice(0, 200),
      })
      this.db.run(
        `INSERT INTO agency_pending_actions
           (request_id, intent_id, args_json, reasoning, inbox_item_id, trajectory_id, status, requested_at)
         VALUES (?, ?, ?, ?, ?, ?, 'awaiting_approval', ?)`,
        [
          request.request_id, request.intent_id, JSON.stringify(request.args),
          request.reasoning, inboxItemId, trajectoryId, request.requested_at,
        ],
      )
      log(`ActionExecutor: ${tierEmoji(entry.tier)} ${entry.intent.id} queued (item=${inboxItemId})`)
      return { status: 'awaiting_approval', inbox_item_id: inboxItemId, trajectory_id: trajectoryId }
    }

    const result = await this.executeAndLog(request, trajectoryId)

    // Notify the restraint pipeline that an interrupt/surface was actually delivered.
    // Skip for user-initiated actions: a foreground request carries no source_trigger_id,
    // so recording a fire here would write the cooldown on the BARE intent_id and poison
    // the *proactive* debounce for that same intent (the root cause of the repeat-block).
    if (this.restraintPipeline && result.status === 'completed' && request.source !== 'user') {
      const triggerId = request.source_trigger_id ?? request.intent_id
      // We only reach here when restraint returned 'interrupt' or 'surface'
      // (or when no restraint was applied). The pipeline handles the mode internally.
      this.restraintPipeline.recordDelivered(triggerId, 'interrupt')
    }

    return result
  }

  async approveItem(inboxItemId: string): Promise<DispatchResult> {
    const row = this.db.query(
      'SELECT * FROM agency_pending_actions WHERE inbox_item_id = ?',
    ).get(inboxItemId) as { request_id: string; intent_id: string; args_json: string; reasoning: string; trajectory_id: string } | null
    if (!row) {
      return { status: 'failed', details: 'no pending action', trajectory_id: '' }
    }
    this.inbox.resolve(inboxItemId, 'approved')
    const request: ActionRequest = {
      request_id: row.request_id,
      intent_id: row.intent_id,
      args: JSON.parse(row.args_json),
      reasoning: row.reasoning,
      requested_at: Date.now(),
    }
    return await this.executeAndLog(request, row.trajectory_id)
  }

  async dismissItem(inboxItemId: string, reason: string): Promise<DispatchResult> {
    const row = this.db.query(
      'SELECT trajectory_id FROM agency_pending_actions WHERE inbox_item_id = ?',
    ).get(inboxItemId) as { trajectory_id: string } | null
    this.inbox.resolve(inboxItemId, 'dismissed')
    if (row) {
      this.trajectory.finalize(row.trajectory_id, 'user_override', reason)
      this.db.run('UPDATE agency_pending_actions SET status = ? WHERE inbox_item_id = ?', ['cancelled', inboxItemId])
    }
    return { status: 'cancelled', details: reason, trajectory_id: row?.trajectory_id ?? '' }
  }

  private async executeAndLog(request: ActionRequest, trajectoryId: string): Promise<DispatchResult> {
    const entry = this.registry.get(request.intent_id)!
    const startMs = Date.now()
    const step: TrajectoryStep = {
      observation: request.reasoning,
      reasoning: `dispatch ${entry.intent.id}`,
      action: { intent_id: entry.intent.id, args: request.args },
      result: '',
      result_status: 'success',
      duration_ms: 0,
    }
    try {
      const result = await entry.handler(request.args, this.ctx)
      step.result = result.details
      step.result_status = result.status as TrajectoryStep['result_status']
      step.duration_ms = Date.now() - startMs
      this.trajectory.appendStep(trajectoryId, step)
      this.trajectory.finalize(trajectoryId, result.status === 'success' ? 'success' : 'failure')
      this.db.run('UPDATE agency_pending_actions SET status = ? WHERE request_id = ?', ['completed', request.request_id])

      // C.3.1: Write to traj.md if TrajWriter is wired in
      if (this.trajWriter) {
        const trajEntry: TrajEntry = {
          ts: request.requested_at,
          task_goal: entry.intent.description,
          intent_id: entry.intent.id,
          args_summary: JSON.stringify(request.args).slice(0, 300),
          steps: [{
            action: entry.intent.id,
            result_summary: result.details.slice(0, 200),
            reasoning: request.reasoning.slice(0, 200),
          }],
          outcome: result.status === 'success' ? 'success' : 'failed',
          duration_ms: step.duration_ms,
        }
        try { this.trajWriter.record(trajEntry) } catch { /* non-critical */ }
      }

      return { status: 'completed', details: result.details, trajectory_id: trajectoryId }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      step.result = msg
      step.result_status = 'failure'
      step.duration_ms = Date.now() - startMs
      this.trajectory.appendStep(trajectoryId, step)
      this.trajectory.finalize(trajectoryId, 'failure', msg)
      logError(`ActionExecutor: ${entry.intent.id} failed`, err)

      // C.3.1: Record failed trajectory too
      if (this.trajWriter) {
        const trajEntry: TrajEntry = {
          ts: request.requested_at,
          task_goal: entry.intent.description,
          intent_id: entry.intent.id,
          args_summary: JSON.stringify(request.args).slice(0, 300),
          steps: [{
            action: entry.intent.id,
            result_summary: msg.slice(0, 200),
            reasoning: request.reasoning.slice(0, 200),
          }],
          outcome: 'failed',
          duration_ms: step.duration_ms,
        }
        try { this.trajWriter.record(trajEntry) } catch { /* non-critical */ }
      }

      return { status: 'failed', details: msg, trajectory_id: trajectoryId }
    }
  }
}
