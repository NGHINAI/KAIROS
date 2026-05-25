// src/daemon/agency/intents/addToMemory.ts
import type { Intent } from '../types'
import type { ActionContext } from '../actionExecutor'

export const addToMemoryIntent: Intent = {
  id: 'add_to_memory',
  description: 'Write a typed fact to L3 semantic memory',
  tier: 'GREEN',
  argSchema: { kind: 'string', subject: 'string', body: 'string', importance: 'number' },
}

export async function addToMemoryHandler(
  args: { kind: string; subject: string; body: string; importance?: number },
  ctx: ActionContext,
): Promise<{ status: 'success'; details: string }> {
  const emb = await ctx.embedder.embed(`${args.subject}: ${args.body}`)
  const id = ctx.semantic.reinforceOrWrite({
    kind: (args.kind as any) ?? 'fact',
    subject: args.subject,
    body: args.body,
    embedding: emb,
    importance: args.importance ?? 0.5,
  })
  return { status: 'success', details: `wrote L3 fact id=${id}` }
}
