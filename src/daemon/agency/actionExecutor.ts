// src/daemon/agency/actionExecutor.ts
// The heart of C.1. Receives ActionRequest records, looks up the intent,
// gates on tier (GREEN/YELLOW execute, ORANGE/RED queue to inbox),
// writes UFO2 trajectory steps for every attempt.
//
// Idempotency: 5-min dedup window for intents that declare a key.
// Tier enforcement: STRUCTURAL (from intent manifest) — not LLM prompt.

import type { Database } from 'bun:sqlite'
import { log, logError } from '../logger'
import { tierEmoji, requiresApproval } from './autonomyTier'
import type { IntentRegistry } from './intentRegistry'
import type { TrajectoryLog } from './trajectoryLog'
import type { InboxSurface } from './inboxSurface'
import type { NativeNotifier } from './nativeNotifier'
import type { ActionRequest, ActionStatus, TrajectoryStep } from './types'

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
  constructor(
    private db: Database,
    private registry: IntentRegistry,
    private trajectory: TrajectoryLog,
    private inbox: InboxSurface,
    private ctx: ActionContext,
  ) {
    db.exec(EXECUTOR_SCHEMA)
  }

  async dispatch(request: ActionRequest): Promise<DispatchResult> {
    const entry = this.registry.get(request.intent_id)
    if (!entry) {
      const trajectoryId = this.trajectory.start(`Unknown intent: ${request.intent_id}`)
      this.trajectory.finalize(trajectoryId, 'failure', `unknown intent ${request.intent_id}`)
      return { status: 'failed', details: `unknown intent ${request.intent_id}`, trajectory_id: trajectoryId }
    }

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

    return await this.executeAndLog(request, trajectoryId)
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
      return { status: 'completed', details: result.details, trajectory_id: trajectoryId }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      step.result = msg
      step.result_status = 'failure'
      step.duration_ms = Date.now() - startMs
      this.trajectory.appendStep(trajectoryId, step)
      this.trajectory.finalize(trajectoryId, 'failure', msg)
      logError(`ActionExecutor: ${entry.intent.id} failed`, err)
      return { status: 'failed', details: msg, trajectory_id: trajectoryId }
    }
  }
}
