// src/daemon/agents/toolDispatch.ts
// The two core "meta-tools" that let a small static toolset reach any of the
// user's connected tools — the dispatcher pattern (Composio Tool Router /
// Anthropic Tool Search). The planner always has these two:
//   search_tools(query)            → retrieve the most relevant connected tools
//   execute_tool(tool_name, args)  → actually run one (generic dispatch)
// This sidesteps the @openai/agents static-toolset freeze: both are stable tools,
// so the model can search then execute within a single run, at any scale.
//
// SCHEMA PREFETCH: search_tools renders each hit's input schema as a compact
// one-line signature ("to*:string(email), subject*:string, …") directly in its
// TEXT result. Returning the raw JSON Schema object never reached the model — the
// result shaper drops non-scalar fields — which is why first calls guessed args
// and failed. A string result passes through the shaper losslessly. The same
// signature is appended to execute_tool FAILURES (schema-on-failure teaching), so
// a wrong call self-corrects in one retry instead of flailing.

import type { ToolDef } from "./types"
import type { ToolDoc } from "./toolRetriever"
import { compactSchemaLine } from "./schemaCompact"
import { envelopeFailureText } from "./loop/toolExecutor"

export interface ToolDispatchDeps {
  retriever: {
    retrieve: (query: string, k?: number) => Promise<ToolDoc[]>
    /** Direct lookup by exact tool name (the retrieval index) — powers schema-on-failure. */
    getByNames?: (names: string[]) => ToolDoc[]
  }
  /** Run a tool by name (routes to Composio executeTool / intent dispatch). */
  execute: (toolName: string, args: any) => Promise<any>
  maxK?: number
}

const DESC_MAX = 140

function oneLine(s: unknown): string {
  return String(s ?? "").replace(/\s+/g, " ").trim()
}

/** Render retrieved tools as the model-facing TEXT observation: name, toolkit, what it
 *  does, and the compact args signature. This string IS the search_tools result. */
export function renderToolHits(hits: ToolDoc[]): string {
  const lines = hits.map((t) => {
    const desc = oneLine(t.description).slice(0, DESC_MAX)
    const argsLine = t.parameters ? compactSchemaLine(t.parameters) : "(schema unknown — infer from the description)"
    return `- ${t.name}${t.toolkit ? ` (${t.toolkit})` : ""}: ${desc}\n  args: ${argsLine}`
  })
  return (
    `Found ${hits.length} tool${hits.length === 1 ? "" : "s"} (* = required arg). ` +
    `Call execute_tool with the EXACT tool_name and args matching its signature.\n` +
    lines.join("\n")
  )
}

export function buildToolDispatchTools(deps: ToolDispatchDeps): { searchTool: ToolDef; executeTool: ToolDef } {
  const schemaLineFor = (name: string): string | undefined => {
    try {
      const doc = deps.retriever.getByNames?.([name])?.[0]
      return doc?.parameters ? compactSchemaLine(doc.parameters) : undefined
    } catch { return undefined }
  }

  const searchTool: ToolDef = {
    name: "search_tools",
    concurrencySafe: true, // read-only retrieval → safe to run alongside other reads
    description:
      "Find the tools you need from the user's connected apps (Gmail, Linear, Slack, etc.). " +
      "Call this with a short description of what you want to do. Results include each tool's exact name and its args signature " +
      "(* = required) — then call execute_tool with that exact name and matching args. " +
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
      if (hits.length === 0) {
        return "No matching tool in the user's connected apps. The app may not be connected — offer to connect it with connect_service."
      }
      return renderToolHits(hits)
    },
  }

  const executeTool: ToolDef = {
    name: "execute_tool",
    description:
      "Run a specific tool by its exact name (from search_tools). Pass the tool's arguments in 'args' " +
      "matching the args signature search_tools returned for it (* = required).",
    parameters: {
      type: "object",
      properties: {
        tool_name: { type: "string", description: "Exact tool name returned by search_tools (e.g. 'LINEAR_LIST_ISSUES')" },
        args: { type: "object", description: "Arguments for the tool, matching its signature" },
      },
      required: ["tool_name"],
    },
    execute: async (a: { tool_name: string; args?: any }) => {
      const name = String(a?.tool_name ?? "")
      let result: any
      try {
        result = await deps.execute(name, a?.args ?? {})
      } catch (e) {
        // Thrown failures (SDK validation, transport): teach the schema in the error itself.
        const sig = schemaLineFor(name)
        if (sig) throw new Error(`${(e as Error).message} — expected args for ${name} (* = required): ${sig}`)
        throw e
      }
      // Envelope failures (successful:false / error): append the expected signature to the
      // guidance so the model's NEXT call is schema-correct, not another guess. Copy — never
      // mutate the raw provider result.
      if (result && typeof result === "object" && !Array.isArray(result)) {
        const failure = envelopeFailureText(result as Record<string, any>)
        if (failure != null) {
          const sig = schemaLineFor(name)
          if (sig) {
            return { ...result, successful: false, error: `${failure}\nExpected args for ${name} (* = required): ${sig}` }
          }
        }
      }
      return result
    },
  }

  return { searchTool, executeTool }
}
