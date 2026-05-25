// src/daemon/agency/intents/log.ts
import type { Intent } from '../types'
import type { ActionContext } from '../actionExecutor'

export const logIntent: Intent = {
  id: 'log',
  description: 'Record-only action (trajectory log captures the trigger match)',
  tier: 'GREEN',
  argSchema: { message: 'string' },
}

export async function logHandler(
  args: { message: string },
  _ctx: ActionContext,
): Promise<{ status: 'success'; details: string }> {
  return { status: 'success', details: args.message }
}
