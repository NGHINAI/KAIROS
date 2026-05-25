// src/daemon/agency/intentRegistry.ts
// Map-backed registry of available intents. Each entry pairs a static
// Intent description (visible to LLMs and the inbox renderer) with an
// async handler (called by the ActionExecutor).

import type { Intent, AutonomyTier } from './types'
import type { ActionContext } from './actionExecutor'

import { notifyIntent, notifyHandler } from './intents/notify'
import { addToMemoryIntent, addToMemoryHandler } from './intents/addToMemory'
import { logIntent, logHandler } from './intents/log'
import { remindInIntent, remindInHandler } from './intents/remindIn'
import { suspendIntent, suspendHandler } from './intents/suspend'

export type IntentHandler = (
  args: Record<string, unknown>,
  ctx: ActionContext,
) => Promise<{ status: 'success' | 'failure' | 'awaiting'; details: string }>

export type RegistryEntry = {
  intent: Intent
  handler: IntentHandler
  id: string
  tier: AutonomyTier
}

export class IntentRegistry {
  private map: Map<string, RegistryEntry> = new Map()

  register(intent: Intent, handler: IntentHandler): void {
    if (this.map.has(intent.id)) {
      throw new Error(`IntentRegistry: intent '${intent.id}' already registered`)
    }
    this.map.set(intent.id, { intent, handler, id: intent.id, tier: intent.tier })
  }

  get(id: string): RegistryEntry | null {
    return this.map.get(id) ?? null
  }

  list(): RegistryEntry[] {
    return Array.from(this.map.values())
  }
}

export function registerBuiltIns(reg: IntentRegistry): void {
  reg.register(notifyIntent, notifyHandler as IntentHandler)
  reg.register(addToMemoryIntent, addToMemoryHandler as IntentHandler)
  reg.register(logIntent, logHandler as IntentHandler)
  reg.register(remindInIntent, remindInHandler as IntentHandler)
  reg.register(suspendIntent, suspendHandler as IntentHandler)
}
