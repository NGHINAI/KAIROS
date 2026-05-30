// src/daemon/agents/introspectionTools.ts
// All kairos_* tools — voice introspection + self-management.

import type { ToolDef } from "./types"

export interface IntrospectionDeps {
  soulLoader:      { load: () => Promise<string> }
  skillRegistry:   { listActive: () => Promise<Array<{ id: string; description?: string }>> }
  ordersStore:     { list: () => Promise<Array<{ id: string; slug?: string; yaml?: string }>>; add?: (yaml: string) => Promise<any>; remove?: (id: string) => Promise<any> }
  semanticMemory:  { add: (entry: { subject: string; body: string; importance?: number }) => Promise<any>; search: (q: string, n: number) => Promise<any[]> }
  episodicMemory:  { recent: (n: number) => Promise<any[]>; search: (q: string, n: number) => Promise<any[]> }
  memoryStore:     { read: () => Promise<string> }
  dreamLog:        { last: () => Promise<any | null>; search: (q: string, n: number) => Promise<any[]> }
  connectionStore: { list: () => Promise<Array<{ toolkit: string; status: string }>> }
}

export function buildIntrospectionTools(deps: IntrospectionDeps): ToolDef[] {
  return [
    {
      name: "kairos_soul_read",
      description: "Read KAIROS's persona / soul file (~/.kairos/soul.md).",
      parameters: { type: "object", properties: {}, required: [] },
      execute: async () => ({ content: await deps.soulLoader.load() }),
    },
    {
      name: "kairos_skills_list",
      description: "List all crystallized KAIROS skills the agent can invoke.",
      parameters: { type: "object", properties: {}, required: [] },
      execute: async () => {
        const skills = await deps.skillRegistry.listActive()
        return { skills: skills.map((s) => s.id), count: skills.length }
      },
    },
    {
      name: "kairos_skills_describe",
      description: "Get description of a specific KAIROS skill by id.",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "Skill ID, e.g. 'gmail'" } },
        required: ["id"],
      },
      execute: async (args: { id: string }) => {
        const skills = await deps.skillRegistry.listActive()
        const found = skills.find((s) => s.id === args.id)
        return found ?? { error: `skill ${args.id} not found` }
      },
    },
    {
      name: "kairos_orders_list",
      description: "List active KAIROS standing orders (proactive rules).",
      parameters: { type: "object", properties: {}, required: [] },
      execute: async () => ({ orders: await deps.ordersStore.list() }),
    },
    {
      name: "kairos_memory_overview",
      description: "Read top-level MEMORY.md (KAIROS's distilled long-term memory).",
      parameters: { type: "object", properties: {}, required: [] },
      execute: async () => ({ content: await deps.memoryStore.read() }),
    },
    {
      name: "kairos_memory_search",
      description: "Search KAIROS's semantic (L3) memory for facts matching a query.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number", default: 8 },
        },
        required: ["query"],
      },
      execute: async (args: { query: string; limit?: number }) => {
        const hits = await deps.semanticMemory.search(args.query, args.limit ?? 8)
        return { hits }
      },
    },
    {
      name: "kairos_remember",
      description: "Save a fact to KAIROS's long-term semantic (L3) memory. ONLY use when user explicitly says 'remember that...' or for env/preference facts. Skip session-specific or easily re-discovered info.",
      parameters: {
        type: "object",
        properties: {
          subject: { type: "string", description: "Short subject, e.g. 'manager'" },
          body:    { type: "string", description: "The fact to remember, e.g. 'Sarah is the user's manager'" },
          kind:    { type: "string", enum: ["correction", "preference", "env_fact", "other"], default: "other" },
        },
        required: ["subject", "body"],
      },
      execute: async (args: { subject: string; body: string; kind?: string }) => {
        const importance = args.kind === "correction" ? 0.8 : args.kind === "env_fact" ? 0.6 : 0.4
        const saved = await deps.semanticMemory.add({ subject: args.subject, body: args.body, importance })
        return { saved: true, id: saved.id, importance }
      },
    },
    {
      name: "kairos_traj_recent",
      description: "Get KAIROS's recent activity log (last N episodes).",
      parameters: {
        type: "object",
        properties: { n: { type: "number", default: 10 } },
        required: [],
      },
      execute: async (args: { n?: number }) => ({ episodes: await deps.episodicMemory.recent(args.n ?? 10) }),
    },
    {
      name: "kairos_traj_search",
      description: "Search KAIROS's activity log (L2 episodes) for past events.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" }, limit: { type: "number", default: 5 } },
        required: ["query"],
      },
      execute: async (args: { query: string; limit?: number }) => ({ hits: await deps.episodicMemory.search(args.query, args.limit ?? 5) }),
    },
    {
      name: "kairos_dreams_last",
      description: "Read KAIROS's last consolidation dream (nightly reflection output).",
      parameters: { type: "object", properties: {}, required: [] },
      execute: async () => ({ dream: await deps.dreamLog.last() }),
    },
    {
      name: "kairos_composio_status",
      description: "List which Composio toolkits are currently connected (e.g. gmail, linear, calendar).",
      parameters: { type: "object", properties: {}, required: [] },
      execute: async () => ({ connections: await deps.connectionStore.list() }),
    },
    {
      name: "kairos_help",
      description: "Describe KAIROS's current capabilities — what tools, skills, and toolkits are available.",
      parameters: { type: "object", properties: {}, required: [] },
      execute: async () => {
        const [skills, conns] = await Promise.all([
          deps.skillRegistry.listActive(),
          deps.connectionStore.list(),
        ])
        return {
          skills: skills.map((s) => s.id),
          connected_toolkits: conns.filter((c) => c.status === "ACTIVE").map((c) => c.toolkit),
          capabilities: [
            "Answer questions about your data via Composio (Gmail, Calendar, Linear, etc.)",
            "Take actions: add tickets, block calendar, send messages",
            "Remember facts you tell me (via kairos_remember)",
            "Manage your standing orders (proactive rules)",
            "Run KAIROS skills (crystallized workflows)",
          ],
        }
      },
    },
  ]
}
