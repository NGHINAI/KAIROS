// src/daemon/agency/actionExecutor.ts
// Stub for Task 3 — full implementation in Task 5.

import type { Database } from 'bun:sqlite'

export type ActionContext = {
  db: Database
  notifier: { notify(args: { title: string; body: string; urgency?: 'low' | 'normal' | 'high' }): Promise<void> }
  embedder: { embed(text: string): Promise<number[]> }
  semantic: { reinforceOrWrite(input: any): number }
}
