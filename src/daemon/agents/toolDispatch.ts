// src/daemon/agents/toolDispatch.ts
// The two core "meta-tools" that let a small static toolset reach any of the
// user's connected tools — the dispatcher pattern (Composio Tool Router /
// Anthropic Tool Search). The planner always has these two:
//   search_tools(query)            → retrieve the most relevant connected tools
//   execute_tool(tool_name, args)  → actually run one (generic dispatch)
// This sidesteps the @openai/agents static-toolset freeze: both are stable tools,
// so the model can search then execute within a single run, at any scale.

import type { ToolDef } from "./types"
import type { ToolDoc } from "./toolRetriever"

export interface ToolDispatchDeps {
  retriever: { retrieve: (query: string, k?: number) => Promise<ToolDoc[]> }
  /** Run a tool by name (routes to Composio executeTool / intent dispatch). */
  execute: (toolName: string, args: any) => Promise<any>
  maxK?: number
}

export function buildToolDispatchTools(deps: ToolDispatchDeps): { searchTool: ToolDef; executeTool: ToolDef } {
  const searchTool: ToolDef = {
    name: "search_tools",
    concurrencySafe: true, // read-only retrieval → safe to run alongside other reads
    description:
      "Find the tools you need from the user's connected apps (Gmail, Linear, Slack, etc.). " +
      "Call this with a short description of what you want to do, then call execute_tool with one of the returned tool names. " +
      "If it returns nothing, the relevant app probably isn't connected — offer to connect it with connect_service.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What you want to do, in plain words (e.g. 'list my open Linear issues')" },
        limit: { type: "number", description: "Max tools to return (default 8)" },
      },
      required: ["query"],
    },
    execute: async (args: { query: string; limit?: number }) => {
      const hits = await deps.retriever.retrieve(String(args?.query ?? ""), args?.limit ?? deps.maxK)
      const tools = hits.map((t) => ({ name: t.name, toolkit: t.toolkit, description: t.description, parameters: t.parameters }))
      return tools.length > 0
        ? { tools }
        : { tools: [], note: "No matching tool in the user's connected apps. The app may not be connected — offer to connect it with connect_service." }
    },
  }

  const executeTool: ToolDef = {
    name: "execute_tool",
    description:
      "Run a specific tool by its exact name (from search_tools). Pass the tool's arguments in 'args' " +
      "matching the parameters search_tools returned for it.",
    parameters: {
      type: "object",
      properties: {
        tool_name: { type: "string", description: "Exact tool name returned by search_tools (e.g. 'LINEAR_LIST_ISSUES')" },
        args: { type: "object", description: "Arguments for the tool" },
      },
      required: ["tool_name"],
    },
    execute: async (a: { tool_name: string; args?: any }) => deps.execute(a.tool_name, a?.args ?? {}),
  }

  return { searchTool, executeTool }
}
