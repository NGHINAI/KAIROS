// scripts/verify-context-routing.ts — confirms the router uses conversation
// context so short confirmations ("Yes") route to the tier the action needs.
import { classifyIntent } from "../src/daemon/agents/intentClassifier"
import { OpenRouterAdapter } from "../src/daemon/wrapApi/adapters/openRouterAdapter"

const model = process.env.KAIROS_FAST_MODEL ?? "openai/gpt-4o-mini"
const adapter = new OpenRouterAdapter({ defaultModel: model })
const llm = { complete: (b: any) => adapter.complete(b) }

const ctx = "KAIROS: The delete failed — want me to retry deleting that Security alert email?\nuser: Yes."
const withCtx = await classifyIntent("Yes.", { llm, recentContext: ctx })
const noCtx = await classifyIntent("Yes.", { llm })
console.log(`model: ${model}`)
console.log(`"Yes" WITH action context → ${withCtx.tier}  (${withCtx.reason})`)
console.log(`"Yes" NO context         → ${noCtx.tier}  (${noCtx.reason})`)
const ok = withCtx.tier === "smart"
console.log(ok ? "✓ context-aware routing works: a confirmation of an action → smart" : "✗ still misrouted to " + withCtx.tier)
process.exit(ok ? 0 : 1)
