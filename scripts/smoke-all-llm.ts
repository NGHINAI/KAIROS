// scripts/smoke-all-llm.ts
//
// Exercises every LLM call site in KAIROS. Run after any LLM-routing change.
//
// Usage: bun scripts/smoke-all-llm.ts
//
// Tests (each runs in isolation with a 30s timeout):
//   1. ModelRouter.complete with task_type='classify'           (perception Tier1)
//   2. ModelRouter.complete with task_type='trigger_eval'       (perception Tier2)
//   3. ModelRouter.complete with task_type='dream'              (memory consolidation)
//   4. ModelRouter.complete with task_type='skill_crystallize'  (AWM)
//   5. OpenRouterAdapter.complete with KAIROS_FAST_MODEL        (agent fast tier)
//   6. OpenRouterAdapter.complete with KAIROS_SMART_MODEL       (agent smart tier)
//   7. agent-ping end-to-end (skip if daemon won't boot — flagged, not failed)
//
// Exits 0 only if ALL 6 router tests pass. Test 7 is informational.

import { Database } from 'bun:sqlite'
import { spawn } from 'bun'
import { homedir } from 'os'
import { join } from 'path'

import { buildRouter } from '../src/daemon/llm'
import type { TaskType } from '../src/daemon/llm/types'
import { OpenRouterAdapter } from '../src/daemon/wrapApi/adapters/openRouterAdapter'

const SMOKE_TIMEOUT_MS = 30_000
const SHORT_PROMPT = 'Reply OK in two words.'

interface RouterTestSpec {
  label: string
  taskType: TaskType
}

const ROUTER_TESTS: RouterTestSpec[] = [
  { label: 'task=classify',           taskType: 'classify' },
  { label: 'task=trigger_eval',       taskType: 'trigger_eval' },
  { label: 'task=dream',              taskType: 'dream' },
  { label: 'task=skill_crystallize',  taskType: 'skill_crystallize' },
]

interface AdapterTestSpec {
  label: string
  modelEnv: 'KAIROS_FAST_MODEL' | 'KAIROS_SMART_MODEL'
  defaultModel: string
}

const ADAPTER_TESTS: AdapterTestSpec[] = [
  { label: 'agent fast',  modelEnv: 'KAIROS_FAST_MODEL',  defaultModel: 'openai/gpt-4o-mini' },
  { label: 'agent smart', modelEnv: 'KAIROS_SMART_MODEL', defaultModel: 'moonshotai/kimi-k2' },
]

type Outcome =
  | { ok: true;  provider: string; model: string; costCents: number; latencyMs: number }
  | { ok: false; error: string }

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms)
    p.then(
      (v) => { clearTimeout(t); resolve(v) },
      (e) => { clearTimeout(t); reject(e) },
    )
  })
}

async function runRouterTest(spec: RouterTestSpec): Promise<Outcome> {
  try {
    const db = new Database(':memory:')
    const router = buildRouter(db, join(homedir(), '.kairos', 'providers.json'))
    const result = await withTimeout(
      router.complete({
        task_type: spec.taskType,
        system_blocks: [
          { text: 'You are a smoke test. Be terse.', cache_hint: 'long' },
        ],
        prompt: SHORT_PROMPT,
        max_output_tokens: 16,
        latency_target: 'realtime',
      }),
      SMOKE_TIMEOUT_MS,
      spec.label,
    )
    return {
      ok: true,
      provider: result.provider,
      model: result.model,
      costCents: result.cost_cents,
      latencyMs: result.latency_ms,
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

async function runAdapterTest(spec: AdapterTestSpec): Promise<Outcome> {
  try {
    const model = process.env[spec.modelEnv] ?? spec.defaultModel
    const adapter = new OpenRouterAdapter({ defaultModel: model })
    const t0 = Date.now()
    const result = await withTimeout(
      adapter.complete({
        model,
        messages: [{ role: 'user', content: SHORT_PROMPT }],
        max_tokens: 16,
      }),
      SMOKE_TIMEOUT_MS,
      spec.label,
    )
    const tokensIn = result.tokensIn ?? 0
    const tokensOut = result.tokensOut ?? 0
    // Best-effort cost estimate using same fallback prices as the provider
    // (real provider would consult PRICING map; this is just informational).
    const costCents = Math.ceil(((tokensIn / 1_000_000) * 1 + (tokensOut / 1_000_000) * 5) * 100)
    return {
      ok: true,
      provider: 'openrouter',
      model,
      costCents,
      latencyMs: Date.now() - t0,
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

interface AgentPingOutcome {
  status: 'pass' | 'fail' | 'skipped'
  note: string
}

async function runAgentPing(): Promise<AgentPingOutcome> {
  // Best-effort: spawn `bun scripts/agent-ping.ts`, capture exit code + tail.
  // If the daemon refuses to boot (sidecar missing on non-Mac, etc.) we mark
  // as 'skipped' (informational) so smoke-all-llm can still pass on CI.
  try {
    const proc = spawn({
      cmd: ['bun', 'scripts/agent-ping.ts', 'Reply OK.'],
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, KAIROS_DAEMON_PORT: process.env.KAIROS_DAEMON_PORT ?? '9882' },
    })
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    const code = await proc.exited
    if (code === 0) {
      const tail = stdout.trim().split('\n').slice(-1)[0] ?? ''
      return { status: 'pass', note: tail.replace(/^\[agent-ping\]\s*/, '') }
    }
    // Look for a boot-failed signal to differentiate 'skipped' from 'fail'.
    const tail = (stdout + '\n' + stderr).trim().split('\n').slice(-3).join(' | ')
    if (/did not become healthy|OPENROUTER_API_KEY required|sidecar/i.test(tail)) {
      return { status: 'skipped', note: `daemon failed to boot: ${tail.slice(0, 160)}` }
    }
    return { status: 'fail', note: tail.slice(0, 160) }
  } catch (err) {
    return { status: 'skipped', note: `spawn failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

function fmt(outcome: Outcome): string {
  if (outcome.ok) {
    const cost = `$${(outcome.costCents / 100).toFixed(4)}`
    return `provider=${outcome.provider} model=${outcome.model} cost=${cost} latency=${outcome.latencyMs}ms ✓`
  }
  return `FAILED: ${outcome.error.slice(0, 240)} ✗`
}

async function main(): Promise<void> {
  if (!process.env.OPENROUTER_API_KEY) {
    console.log('[smoke] OPENROUTER_API_KEY not set — smoke test requires it to exercise')
    console.log('         every LLM call site. Either set it or accept that the gate cannot run.')
    process.exit(1)
  }

  const total = ROUTER_TESTS.length + ADAPTER_TESTS.length
  let passCount = 0
  let totalCostCents = 0
  let idx = 0

  for (const spec of ROUTER_TESTS) {
    idx++
    const outcome = await runRouterTest(spec)
    console.log(`[smoke ${idx}/${total}] ${spec.label} → ${fmt(outcome)}`)
    if (outcome.ok) { passCount++; totalCostCents += outcome.costCents }
  }

  for (const spec of ADAPTER_TESTS) {
    idx++
    const outcome = await runAdapterTest(spec)
    console.log(`[smoke ${idx}/${total}] ${spec.label} → ${fmt(outcome)}`)
    if (outcome.ok) { passCount++; totalCostCents += outcome.costCents }
  }

  console.log('')
  console.log('[smoke 7/7] agent-ping end-to-end (informational, slow)...')
  const ping = await runAgentPing()
  if (ping.status === 'pass')        console.log(`            agent-ping ✓ ${ping.note}`)
  else if (ping.status === 'skipped') console.log(`            agent-ping ⊘ skipped: ${ping.note}`)
  else                                 console.log(`            agent-ping ✗ ${ping.note}`)

  console.log('')
  console.log('=== Summary ===')
  console.log(`${passCount}/${total} router tests passed`)
  if (ping.status === 'pass')        console.log('agent-ping: ✓')
  else if (ping.status === 'skipped') console.log(`agent-ping: skipped: ${ping.note.slice(0, 80)}`)
  else                                 console.log(`agent-ping: ✗ ${ping.note.slice(0, 80)}`)
  console.log(`Total cost: $${(totalCostCents / 100).toFixed(4)}`)

  // Exit 0 only if ALL router/adapter tests pass. Agent-ping is informational.
  process.exit(passCount === total ? 0 : 1)
}

await main()
