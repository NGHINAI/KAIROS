import type { Database } from 'bun:sqlite'
import type { FlowState } from './types'

export const FLOW_STATE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS onboarding_setup_flows (
    flow_id TEXT PRIMARY KEY,
    service_name TEXT NOT NULL,
    current_step_index INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    collected_data TEXT NOT NULL DEFAULT '{}',
    error TEXT,
    completed_at INTEGER
  );
`

export class FlowStateStore {
  constructor(private db: Database) {
    this.db.exec(FLOW_STATE_SCHEMA)
  }

  create(flow: FlowState): void {
    this.db.run(
      `INSERT INTO onboarding_setup_flows
         (flow_id, service_name, current_step_index, started_at, status, collected_data, error, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        flow.flow_id,
        flow.service_name,
        flow.current_step_index,
        flow.started_at,
        flow.status,
        JSON.stringify(flow.collected_data),
        flow.error ?? null,
        flow.completed_at ?? null,
      ],
    )
  }

  get(flow_id: string): FlowState | null {
    const row = this.db.query(
      `SELECT * FROM onboarding_setup_flows WHERE flow_id = ?`,
    ).get(flow_id) as {
      flow_id: string
      service_name: string
      current_step_index: number
      started_at: number
      status: string
      collected_data: string
      error: string | null
      completed_at: number | null
    } | undefined

    if (!row) return null

    return {
      flow_id: row.flow_id,
      service_name: row.service_name,
      current_step_index: row.current_step_index,
      started_at: row.started_at,
      status: row.status as FlowState['status'],
      collected_data: JSON.parse(row.collected_data),
      error: row.error ?? undefined,
      completed_at: row.completed_at ?? undefined,
    }
  }

  updateStepIndex(flow_id: string, index: number): void {
    this.db.run(
      `UPDATE onboarding_setup_flows SET current_step_index = ? WHERE flow_id = ?`,
      [index, flow_id],
    )
  }

  markCompleted(flow_id: string): void {
    this.db.run(
      `UPDATE onboarding_setup_flows SET status = ?, completed_at = ? WHERE flow_id = ?`,
      ['completed', Date.now(), flow_id],
    )
  }

  markFailed(flow_id: string, error: string): void {
    this.db.run(
      `UPDATE onboarding_setup_flows SET status = ?, error = ?, completed_at = ? WHERE flow_id = ?`,
      ['failed', error, Date.now(), flow_id],
    )
  }

  markCancelled(flow_id: string): void {
    this.db.run(
      `UPDATE onboarding_setup_flows SET status = ?, completed_at = ? WHERE flow_id = ?`,
      ['cancelled', Date.now(), flow_id],
    )
  }

  setCollectedData(flow_id: string, data: Record<string, unknown>): void {
    const current = this.get(flow_id)
    if (!current) return

    const merged = Object.assign({}, current.collected_data, data)
    this.db.run(
      `UPDATE onboarding_setup_flows SET collected_data = ? WHERE flow_id = ?`,
      [JSON.stringify(merged), flow_id],
    )
  }

  listActive(): FlowState[] {
    const rows = this.db.query(
      `SELECT * FROM onboarding_setup_flows WHERE status IN ('awaiting_user', 'executing')`,
    ).all() as Array<{
      flow_id: string
      service_name: string
      current_step_index: number
      started_at: number
      status: string
      collected_data: string
      error: string | null
      completed_at: number | null
    }>

    return rows.map(row => ({
      flow_id: row.flow_id,
      service_name: row.service_name,
      current_step_index: row.current_step_index,
      started_at: row.started_at,
      status: row.status as FlowState['status'],
      collected_data: JSON.parse(row.collected_data),
      error: row.error ?? undefined,
      completed_at: row.completed_at ?? undefined,
    }))
  }
}
