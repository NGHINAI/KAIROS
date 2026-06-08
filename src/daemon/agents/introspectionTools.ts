// src/daemon/agents/introspectionTools.ts
// All kairos_* tools — voice introspection + self-management.

import type { ToolDef } from "./types"
import { resolveWhen } from "../util/timeRange"

type ActivityItemLite = { at: number; kind: string; lane: string; title: string; detail?: string; status: string }

export interface IntrospectionDeps {
  soulLoader:      { load: () => Promise<string> }
  skillRegistry:   { listActive: () => Promise<Array<{ id: string; description?: string }>> }
  ordersStore:     { list: () => Promise<Array<{ id: string; slug?: string; yaml?: string }>>; add?: (yaml: string) => Promise<any>; remove?: (id: string) => Promise<any> }
  semanticMemory:  { add: (entry: { subject: string; body: string; importance?: number }) => Promise<any>; search: (q: string, n: number) => Promise<any[]> }
  episodicMemory:  { recent: (n: number) => Promise<any[]>; search: (q: string, n: number) => Promise<any[]> }
  memoryStore:     { read: () => Promise<string> }
  dreamLog:        { last: () => Promise<any | null>; search: (q: string, n: number) => Promise<any[]> }
  connectionStore: { list: () => Promise<Array<{ toolkit: string; status: string }>> }
  /** Optional — persona profile writer for the "remember my preference" tool. */
  personaUpdater?: { recordNudge: (nudge: string) => any }
  /** Optional — daily narrative diary reader for kairos_daily_log. */
  dailyNarrative?: { recent: (n: number) => Array<{ day: string; text: string }> }
  /** Optional — the durable activity log for kairos_activity ("what did you do…"). */
  activityStore?: {
    query: (
      range: { fromDay: string; toDay: string; from: number; to: number; label: string },
      opts?: { minImportance?: number; limit?: number },
    ) => ActivityItemLite[]
    digest: (items: ActivityItemLite[]) => string
  }
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
      name: "kairos_remember_preference",
      description: "Record a lasting USER preference or instruction about how KAIROS should behave (e.g. 'keep replies short', 'don't interrupt during meetings', 'I prefer voice'). Use when the user says 'remember to…', 'from now on…', or states a standing preference. This updates the user profile that shapes future replies. NOT for one-off facts — use kairos_remember for those.",
      parameters: {
        type: "object",
        properties: { preference: { type: "string", description: "The preference/instruction to remember, phrased concisely." } },
        required: ["preference"],
      },
      execute: async (args: { preference: string }) => {
        if (!deps.personaUpdater) return { error: "persona profile not available" }
        const pref = String(args?.preference ?? "").trim()
        if (!pref) return { error: "empty preference" }
        try { deps.personaUpdater.recordNudge(pref); return { saved: true, preference: pref } }
        catch (e) { return { error: (e as Error).message } }
      },
    },
    {
      name: "kairos_activity",
      description: "Recall what KAIROS actually DID over a time period: actions it took (emails sent, issues created, things looked up), background tasks it ran and what they found, and proactive things it did (reminders fired, messages sent). THIS is the tool for 'what did you do yesterday / today / this week', 'what have you been up to', 'did you do X recently'. Returns a digest + a timeline of items.",
      parameters: {
        type: "object",
        properties: { when: { type: "string", description: "Time range: 'today', 'yesterday', 'this week', 'last 7 days', or an explicit date 'YYYY-MM-DD'. Defaults to today." } },
        required: [],
      },
      execute: async (args: { when?: string }) => {
        if (!deps.activityStore) return { items: [], note: "activity log not available" }
        const range = resolveWhen(args?.when ?? "today")
        const items = deps.activityStore.query(range, { minImportance: 0.5, limit: 50 })
        const tz = process.env.KAIROS_TZ?.trim()
        const fmtTime = (at: number) => { try { return new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", ...(tz ? { timeZone: tz } : {}) }) } catch { return "" } }
        const shaped = items.map((i) => ({ time: fmtTime(i.at), what: i.title, detail: i.detail, lane: i.lane, status: i.status }))
        const digest = deps.activityStore.digest(items)
        return { period: range.label, digest, count: items.length, items: shaped }
      },
    },
    {
      name: "kairos_daily_log",
      description: "Read KAIROS's daily diary NARRATIVE (a reflective prose summary of prior days; may be sparse). For a precise list of what KAIROS DID/actions taken, prefer kairos_activity.",
      parameters: {
        type: "object",
        properties: { days: { type: "number", description: "How many recent days to read (default 3)." } },
        required: [],
      },
      execute: async (args: { days?: number }) => {
        if (!deps.dailyNarrative) return { entries: [], note: "daily narrative not available" }
        const entries = deps.dailyNarrative.recent(Math.max(1, Math.min(14, args?.days ?? 3)))
        return { entries, count: entries.length }
      },
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
      description: "Get recent low-level PERCEPTION episodes (sensor-level things KAIROS noticed in the environment — often routine). This is NOT the action log; for 'what did you do', use kairos_activity instead.",
      parameters: {
        type: "object",
        properties: { n: { type: "number", default: 10 } },
        required: [],
      },
      execute: async (args: { n?: number }) => ({ episodes: await deps.episodicMemory.recent(args.n ?? 10) }),
    },
    {
      name: "kairos_traj_search",
      description: "Search low-level PERCEPTION/observation episodes (L2) by keyword. NOT the action log; for what KAIROS DID, use kairos_activity.",
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
