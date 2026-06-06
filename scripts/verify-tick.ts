// scripts/verify-tick.ts — confirms the autonomous tick now runs on OpenRouter
// (not the 401'ing `claude -p` subprocess). Makes ONE real tick decision.
import { initDatabase } from "../src/daemon/db"
import { DecisionEngine } from "../src/daemon/decisionEngine"
import { OpenRouterAdapter } from "../src/daemon/wrapApi/adapters/openRouterAdapter"

const model = process.env.KAIROS_TICK_MODEL ?? process.env.KAIROS_FAST_MODEL ?? "openai/gpt-4o-mini"
const db = initDatabase(":memory:")
const cfg = {
  sandboxDir: process.cwd(),
  budget: { maxSubprocessPerHour: 60, maxProactiveMsgsPerHour: 10, maxCostCentsPerHour: 500 },
  models: { tick: model },
} as any
const adapter = new OpenRouterAdapter({ defaultModel: model })
const engine = new DecisionEngine(db, cfg, { complete: (b: any) => adapter.complete(b) })
const t0 = Date.now()
const d = await engine.decide({ source: "timer", reason: "verification tick" } as any)
console.log(`tick model: ${model}  (${Date.now() - t0}ms)`)
console.log("decision:", JSON.stringify(d))
const ok = d && d.kind && d.model !== "fallback"
console.log(ok ? "✓ tick produced a real decision (no claude subprocess, no 401)" : "✗ tick fell back")
process.exit(ok ? 0 : 1)
