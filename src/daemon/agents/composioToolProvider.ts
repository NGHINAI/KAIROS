// src/daemon/agents/composioToolProvider.ts
import type { ToolDef } from "./types"

interface ComposioLike {
  searchTools(query: string, limit: number): Promise<Array<{ slug: string; description: string; parameters?: any; toolkit?: string }>>
  executeTool?(slug: string, args: any): Promise<any>
}

export class ComposioToolCache {
  private lru = new Map<string, ToolDef>()
  private maxSize = 20

  get(slug: string): ToolDef | undefined {
    const t = this.lru.get(slug)
    if (t) {
      this.lru.delete(slug)
      this.lru.set(slug, t)
    }
    return t
  }

  set(slug: string, tool: ToolDef): void {
    if (this.lru.size >= this.maxSize) {
      const first = this.lru.keys().next().value as string
      this.lru.delete(first)
    }
    this.lru.set(slug, tool)
  }

  asTools(): ToolDef[] {
    return Array.from(this.lru.values())
  }
}

export function buildComposioSearchTool(deps: { composio: ComposioLike; cache: ComposioToolCache }): ToolDef {
  return {
    name: "composio_search_tools",
    description: "Search for Composio toolkit tools matching a query. Returns top N tool definitions you can then call. Use this when you need a tool from a toolkit (Gmail, Calendar, Linear, etc.) that isn't already in your tool list.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural language search (e.g. 'send email', 'list calendar events')" },
        limit: { type: "number", default: 10 },
      },
      required: ["query"],
    },
    execute: async (args: { query: string; limit?: number }) => {
      const limit = args.limit ?? 10
      const tools = await deps.composio.searchTools(args.query, limit)
      for (const t of tools) {
        deps.cache.set(t.slug, {
          name: t.slug,
          description: t.description,
          parameters: t.parameters ?? { type: "object", properties: {}, required: [] },
          execute: async (a: any) => deps.composio.executeTool?.(t.slug, a) ?? { error: "no executor" },
        })
      }
      return { tools }
    },
  }
}
