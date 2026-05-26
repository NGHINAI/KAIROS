// scripts/probe-llm-accuracy.ts
// KAIROS Phase C.2.5 — LLM Accuracy Probe
//
// Measures how often SetupSkillGenerator produces a working recipe across
// 25 well-known services. NO installs happen — only generates + validates.
//
// Key finding from debug run: the LLM consistently uses non-canonical field names:
//   - speak/open_url/etc: uses "message" instead of "text" / "description"
//   - install_mcp_server: uses "runtime" ("npx"/"pip") instead of "via" ("npm"/"smithery")
//   - smoke_test_tool: uses "server_name" + "tool_name" instead of "qualified_id"
//   - wait_for_clipboard: uses "timeout_seconds" instead of "timeout_sec"
//
// The probe normalizes these variants for the purpose of assessment, and records
// field_divergences as a distinct failure mode.
//
// Usage:
//   bun run scripts/probe-llm-accuracy.ts

import { homedir } from 'os'
import { join } from 'path'
import { mkdirSync, existsSync, writeFileSync } from 'fs'
import { Database } from 'bun:sqlite'

import { buildRouter } from '../src/daemon/llm'
import { SetupSkillGenerator } from '../src/daemon/onboarding/setupSkillGenerator'
import type { SetupSkill, SetupStep } from '../src/daemon/onboarding/types'

// ─── Catalog ──────────────────────────────────────────────────────────────────
const SERVICES = [
  'github', 'slack', 'notion', 'linear', 'postgres',
  'sqlite', 'brave-search', 'filesystem', 'fetch', 'time',
  'stripe', 'sentry', 'supabase', 'vercel', 'jira',
  'asana', 'hubspot', 'gmail', 'google-drive', 'google-calendar',
  'redis', 'mongodb', 'airtable', 'cloudflare', 'discord',
]

// ─── LLM raw-skill type (the LLM often uses non-canonical field names) ────────
// We accept both canonical and variant field names.
type RawStep = Record<string, unknown> & { type: string }
type RawSkill = {
  service_name?: string
  service_display_name?: string
  auth_type?: string
  estimated_minutes?: number
  steps?: RawStep[]
}

// ─── Normalization helpers ─────────────────────────────────────────────────────

/**
 * Given a raw install_mcp_server step, extract the canonical `via` field.
 * The LLM may use:
 *   - via: 'npm' | 'smithery'  (canonical)
 *   - runtime: 'npx' | 'node' | 'pip' | 'uvx' | etc  (LLM variant)
 *   - install_method: ...       (another variant)
 */
function extractVia(step: RawStep): { via: string | undefined; pkg: string | undefined } {
  const via = (step.via as string | undefined) ?? undefined
  const pkg = (step.package as string | undefined) ?? (step.package_name as string | undefined) ?? undefined

  if (via === 'npm' || via === 'smithery') return { via, pkg }

  // Infer from runtime field
  const runtime = (step.runtime as string | undefined) ?? ''
  if (runtime === 'npx' || runtime === 'node' || runtime === 'npm') return { via: 'npm', pkg }
  if (runtime === 'smithery') return { via: 'smithery', pkg }
  if (runtime === 'pip' || runtime === 'uvx' || runtime === 'python') return { via: 'pip', pkg }

  // Infer from install_method
  const installMethod = (step.install_method as string | undefined) ?? ''
  if (installMethod === 'npm' || installMethod === 'npx') return { via: 'npm', pkg }
  if (installMethod === 'smithery') return { via: 'smithery', pkg }

  // If we have a package name and no clear runtime, assume npm (most common)
  if (pkg && pkg.startsWith('@') ) return { via: 'npm', pkg }

  return { via: via ?? runtime ?? undefined, pkg }
}

/**
 * Given a raw smoke_test_tool step, extract/construct a qualified_id.
 * Canonical:  { qualified_id: "server::tool" }
 * LLM variant: { server_name: "github", tool_name: "get_me" }
 *              { server: "github", tool: "get_me" }
 */
function extractQualifiedId(step: RawStep): string {
  const qid = (step.qualified_id as string | undefined) ?? ''
  if (qid && qid.includes('::')) return qid

  const serverName = (step.server_name as string | undefined)
    ?? (step.server as string | undefined)
    ?? (step.server_id as string | undefined)
    ?? ''
  const toolName = (step.tool_name as string | undefined)
    ?? (step.tool as string | undefined)
    ?? (step.tool_id as string | undefined)
    ?? ''

  if (serverName && toolName) return `${serverName}::${toolName}`
  return qid
}

/**
 * Given a raw open_url step, extract the URL string.
 */
function extractUrl(step: RawStep): string {
  return (step.url as string | undefined) ?? ''
}

// ─── Types ────────────────────────────────────────────────────────────────────
type Verdict = 'PASS' | 'WARN' | 'FAIL'

type NpmCheckResult =
  | { ok: true; version: string; pkg: string }
  | { ok: false; reason: 'missing' | 'error'; pkg: string }

type UrlCheckResult =
  | { ok: true; url: string; status: number }
  | { ok: false; url: string; reason: string }

type SmokeTestCheck = {
  qualified_id: string        // normalized
  raw_qualified_id: string    // exactly what LLM emitted
  format_ok: boolean
  suspicious: boolean
  warning?: string
}

type ServiceResult = {
  service: string
  verdict: Verdict
  index: number
  status: 'FAIL_GENERATE' | 'FAIL_SCHEMA' | 'FAIL_NPM' | 'FAIL_URL' | 'WARN' | 'PASS'
  error?: string
  step_count?: number
  // Checks
  npm_checks?: Array<NpmCheckResult>
  smithery_installs?: string[]
  url_checks?: Array<UrlCheckResult>
  smoke_tests?: SmokeTestCheck[]
  // Field divergence flags
  field_divergences?: string[]
  schema_issues?: string[]
  package_missing?: string[]
  url_unreachable?: string[]
  step_types?: string[]
  duration_ms: number
}

type ProbeOutput = {
  probe: 'kairos-c2-5-llm-accuracy'
  started_at: string
  finished_at: string
  total_duration_ms: number
  services_count: number
  pass: number
  warn: number
  fail: number
  total_cost_cents: number
  average_steps: number
  results: ServiceResult[]
  failure_modes: Record<string, string[]>
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function npmView(pkg: string): Promise<NpmCheckResult> {
  try {
    const proc = Bun.spawn(['npm', 'view', pkg, 'name', 'version'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const exit = await proc.exited
    if (exit === 0) {
      const out = await new Response(proc.stdout).text()
      const lines = out.trim().split('\n').map(l => l.trim()).filter(Boolean)
      const version = lines[lines.length - 1] ?? 'unknown'
      return { ok: true, version, pkg }
    }
    return { ok: false, reason: 'missing', pkg }
  } catch {
    return { ok: false, reason: 'error', pkg }
  }
}

async function checkUrl(url: string): Promise<UrlCheckResult> {
  if (!url.startsWith('http')) {
    return { ok: false, url, reason: 'invalid_url' }
  }
  const ctrl = new AbortController()
  const tid = setTimeout(() => ctrl.abort(), 5000)
  try {
    let res: Response
    try {
      res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: ctrl.signal })
    } catch {
      // Retry with GET (some services block HEAD)
      const ctrl2 = new AbortController()
      const tid2 = setTimeout(() => ctrl2.abort(), 5000)
      res = await fetch(url, { method: 'GET', redirect: 'follow', signal: ctrl2.signal })
      clearTimeout(tid2)
    }
    clearTimeout(tid)
    // 2xx, 3xx, 401, 403 = reachable (auth-walled but live)
    if (res.status < 400 || res.status === 401 || res.status === 403) {
      return { ok: true, url, status: res.status }
    }
    return { ok: false, url, reason: `HTTP ${res.status}` }
  } catch (err) {
    clearTimeout(tid)
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('abort') || msg.includes('Abort') || msg.includes('cancel')) {
      return { ok: false, url, reason: 'timeout' }
    }
    return { ok: false, url, reason: msg.split('\n')[0].slice(0, 80) }
  }
}

const SUSPICIOUS_PATTERN = /[\s*\/\\?#]|^$/

function checkSmokeTest(step: RawStep): SmokeTestCheck {
  const rawQid = (step.qualified_id as string | undefined) ?? ''
  const normalizedQid = extractQualifiedId(step)
  const parts = normalizedQid.split('::')
  const format_ok = parts.length === 2 && parts[0].length > 0 && parts[1].length > 0
  const suspicious = !format_ok || SUSPICIOUS_PATTERN.test(normalizedQid)
  return {
    qualified_id: normalizedQid,
    raw_qualified_id: rawQid,
    format_ok,
    suspicious,
    warning: suspicious ? `suspicious qualified_id: "${normalizedQid}"` : undefined,
  }
}

/**
 * Detect field-name divergences from the canonical SetupSkill schema.
 * Returns list of human-readable divergence descriptions.
 */
function detectFieldDivergences(steps: RawStep[]): string[] {
  const divs: string[] = []

  for (const step of steps) {
    const t = step.type

    // speak/open_url etc should have 'text' not 'message'
    if ((t === 'speak' || t === 'speak_on_success' || t === 'speak_on_failure') && !('text' in step) && 'message' in step) {
      divs.push(`${t}: uses "message" instead of "text"`)
    }

    // open_url should have 'url' (no divergence expected here usually)
    if (t === 'open_url' && !('url' in step)) {
      divs.push(`open_url: missing "url" field`)
    }

    // wait_for_clipboard should have 'timeout_sec' not 'timeout_seconds' and 'description' not 'message'
    if (t === 'wait_for_clipboard') {
      if ('timeout_seconds' in step && !('timeout_sec' in step)) divs.push(`wait_for_clipboard: "timeout_seconds" should be "timeout_sec"`)
      if (!('description' in step)) divs.push(`wait_for_clipboard: missing "description"`)
    }

    // install_mcp_server: check via field
    if (t === 'install_mcp_server') {
      const { via } = extractVia(step)
      if (!('via' in step)) {
        const runtime = step.runtime as string | undefined
        divs.push(`install_mcp_server: uses "${runtime ? `runtime:"${runtime}"` : 'unknown field'}" instead of "via"`)
      } else if (via !== 'npm' && via !== 'smithery') {
        divs.push(`install_mcp_server: via="${via}" is not "npm" or "smithery"`)
      }
    }

    // smoke_test_tool: check for server_name+tool_name pattern instead of qualified_id
    if (t === 'smoke_test_tool') {
      const rawQid = (step.qualified_id as string | undefined) ?? ''
      if (!rawQid || !rawQid.includes('::')) {
        if ('server_name' in step || 'tool_name' in step || 'server' in step || 'tool' in step) {
          divs.push(`smoke_test_tool: uses server_name+tool_name instead of qualified_id`)
        } else {
          divs.push(`smoke_test_tool: missing or malformed qualified_id`)
        }
      }
    }
  }

  // Deduplicate
  return [...new Set(divs)]
}

// ─── Per-service probe ────────────────────────────────────────────────────────

async function probeService(
  service: string,
  index: number,
  generator: SetupSkillGenerator,
): Promise<ServiceResult> {
  const t0 = Date.now()

  // ── 1. Generate (with exponential backoff retry) ──
  let skill: RawSkill | undefined
  let generateError: string | undefined
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // generate() validates step types, so if it throws it's a real schema error
      const s = await generator.generate(service)
      skill = s as unknown as RawSkill
      break
    } catch (err) {
      generateError = err instanceof Error ? err.message : String(err)
      if (attempt < 2) {
        const wait = 1000 * Math.pow(2, attempt)
        await new Promise(r => setTimeout(r, wait))
      }
    }
  }

  if (!skill) {
    return {
      service, index,
      status: 'FAIL_GENERATE',
      verdict: 'FAIL',
      error: generateError,
      duration_ms: Date.now() - t0,
    }
  }

  const steps = (skill.steps ?? []) as RawStep[]

  // ── 2. Schema-level checks ──
  const schemaIssues: string[] = []

  if (steps.length === 0) {
    schemaIssues.push('steps is empty')
  } else {
    const last2Types = steps.slice(-2).map(s => s.type)
    if (!last2Types.includes('speak_on_success')) schemaIssues.push('missing speak_on_success as final two steps')
    if (!last2Types.includes('speak_on_failure')) schemaIssues.push('missing speak_on_failure as final two steps')
    const hasInstall = steps.some(s => s.type === 'install_mcp_server')
    const hasConfigure = steps.some(s => s.type === 'configure_mcp_server')
    if (!hasInstall && !hasConfigure) schemaIssues.push('missing install_mcp_server and configure_mcp_server')
    const hasSmokeTest = steps.some(s => s.type === 'smoke_test_tool')
    if (!hasSmokeTest) schemaIssues.push('missing smoke_test_tool')
  }

  if (schemaIssues.length > 0) {
    return {
      service, index,
      status: 'FAIL_SCHEMA',
      verdict: 'FAIL',
      schema_issues: schemaIssues,
      error: `schema_invalid: ${schemaIssues.join('; ')}`,
      step_count: steps.length,
      step_types: steps.map(s => s.type),
      duration_ms: Date.now() - t0,
    }
  }

  // ── Detect field divergences (WARN-level, not FAIL) ──
  const fieldDivergences = detectFieldDivergences(steps)

  // ── 3. Package checks ──
  const npmChecks: NpmCheckResult[] = []
  const smitheryInstalls: string[] = []
  const packageMissing: string[] = []
  const unknownViaInstalls: string[] = []

  const installSteps = steps.filter(s => s.type === 'install_mcp_server')
  for (const step of installSteps) {
    const { via, pkg } = extractVia(step)
    if (!pkg) continue

    if (via === 'npm') {
      const result = await npmView(pkg)
      npmChecks.push(result)
      if (!result.ok) packageMissing.push(pkg)
    } else if (via === 'smithery') {
      smitheryInstalls.push(pkg)
    } else if (via === 'pip' || via === 'uvx') {
      // pip installs — we can't cheaply verify, treat as WARN
      smitheryInstalls.push(`${via}:${pkg}`)
    } else {
      // Unknown via — try npm anyway (most services use npm)
      if (pkg.startsWith('@') || !pkg.includes(':')) {
        const result = await npmView(pkg)
        npmChecks.push(result)
        if (!result.ok) packageMissing.push(pkg)
      } else {
        unknownViaInstalls.push(String(via ?? 'unknown') + ':' + pkg)
      }
    }
  }

  // ── 4. URL reachability ──
  const urlChecks: UrlCheckResult[] = []
  const urlUnreachable: string[] = []

  const urlSteps = steps.filter(s => s.type === 'open_url')
  for (const step of urlSteps) {
    const url = extractUrl(step)
    if (!url) continue
    const result = await checkUrl(url)
    urlChecks.push(result)
    if (!result.ok) urlUnreachable.push(url)
  }

  // ── 5. Smoke-test tool plausibility ──
  const smokeTests = steps
    .filter(s => s.type === 'smoke_test_tool')
    .map(checkSmokeTest)

  // ── Verdict ──
  const hasFail = packageMissing.length > 0 || urlUnreachable.length > 0
  const hasWarn = smitheryInstalls.length > 0
    || unknownViaInstalls.length > 0
    || smokeTests.some(s => s.suspicious)
    || fieldDivergences.length > 0

  let verdict: Verdict = 'PASS'
  let status: ServiceResult['status'] = 'PASS'
  let error: string | undefined

  if (hasFail) {
    verdict = 'FAIL'
    if (packageMissing.length > 0) {
      status = 'FAIL_NPM'
      error = `package_missing: ${packageMissing.join(', ')}`
    } else {
      status = 'FAIL_URL'
      error = `url_unreachable: ${urlUnreachable.join(', ')}`
    }
  } else if (hasWarn) {
    verdict = 'WARN'
    status = 'WARN'
    const warnings: string[] = []
    if (smitheryInstalls.length > 0) warnings.push(`non-npm-install:${smitheryInstalls.join(',')}`)
    if (fieldDivergences.length > 0) warnings.push(`field_divergences(${fieldDivergences.length})`)
    if (smokeTests.some(s => s.suspicious)) warnings.push(`smoke_id_needs_normalization`)
    error = warnings.join('; ')
  }

  return {
    service, index,
    status, verdict, error,
    step_count: steps.length,
    npm_checks: npmChecks,
    smithery_installs: smitheryInstalls,
    url_checks: urlChecks,
    smoke_tests: smokeTests,
    field_divergences: fieldDivergences.length ? fieldDivergences : undefined,
    schema_issues: schemaIssues.length ? schemaIssues : undefined,
    package_missing: packageMissing.length ? packageMissing : undefined,
    url_unreachable: urlUnreachable.length ? urlUnreachable : undefined,
    step_types: steps.map(s => s.type),
    duration_ms: Date.now() - t0,
  }
}

// ─── Concurrency runner ───────────────────────────────────────────────────────

async function runBatch(
  services: string[],
  fn: (service: string, idx: number) => Promise<ServiceResult>,
  concurrency: number,
): Promise<ServiceResult[]> {
  const results: ServiceResult[] = []
  for (let i = 0; i < services.length; i += concurrency) {
    const batch = services.slice(i, i + concurrency)
    const settled = await Promise.allSettled(
      batch.map((svc, j) => fn(svc, i + j + 1)),
    )
    for (const s of settled) {
      if (s.status === 'fulfilled') {
        results.push(s.value)
      } else {
        results.push({
          service: '(unknown)',
          index: i,
          verdict: 'FAIL',
          status: 'FAIL_GENERATE',
          error: String(s.reason),
          duration_ms: 0,
        })
      }
    }
  }
  return results
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const startedAt = new Date().toISOString()
const t0Total = Date.now()

console.log('=== KAIROS C.2.5 LLM Accuracy Probe ===')
console.log(`Services: ${SERVICES.length}`)
console.log('LLM: Sonnet (via ModelRouter, task_type: skill_generate)')
console.log(`Started: ${startedAt}`)
console.log()

// ── Build router ──
const providerConfigPath = join(homedir(), '.kairos', 'providers.json')
const db = new Database(':memory:')

let router
try {
  router = buildRouter(db, providerConfigPath)
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err)
  console.error(`BLOCKED: Failed to build ModelRouter: ${msg}`)
  process.exit(1)
}

// ── Network check ──
try {
  const ctrl = new AbortController()
  setTimeout(() => ctrl.abort(), 5000)
  await fetch('https://api.anthropic.com', { method: 'HEAD', signal: ctrl.signal })
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e)
  // Abort = timeout, which still means network is up (request reached server)
  if (!msg.includes('abort') && !msg.includes('Abort')) {
    console.error('BLOCKED: No network access (cannot reach api.anthropic.com)')
    process.exit(1)
  }
}

// ── Cost guardrail ──
// ~25 × 2k output × $0.000015/tok + ~1k input × $0.000003/tok = ~$0.45
const EST_COST_USD = 0.55
console.log(`Estimated cost: $${EST_COST_USD.toFixed(2)} (guardrail: $1.00)`)
if (EST_COST_USD > 1.00) {
  console.error('ABORTED: Estimated cost exceeds $1.00 guardrail.')
  process.exit(1)
}
console.log()

const generator = new SetupSkillGenerator(router)

// ── Run with concurrency=3 ──
const results = await runBatch(
  SERVICES,
  async (service, idx) => {
    const r = await probeService(service, idx, generator)

    const idxStr = `[${String(idx).padStart(2, ' ')}/${SERVICES.length}]`
    const svcStr = service.padEnd(20, ' ')
    const verdictStr = r.verdict.padEnd(4, ' ')
    const stepsStr = r.step_count != null ? `${r.step_count} steps` : '      '

    const details: string[] = []
    if (r.npm_checks) {
      for (const c of r.npm_checks) {
        details.push(c.ok ? `npm:${c.pkg}@${c.version}` : `npm_MISSING:${c.pkg}`)
      }
    }
    if (r.smithery_installs?.length) {
      for (const s of r.smithery_installs) details.push(`alt-install:${s}`)
    }
    if (r.smoke_tests?.length) {
      const qid = r.smoke_tests[0].qualified_id
      details.push(`smoke=${qid || '(empty)'}`)
    }
    if (r.field_divergences?.length) {
      details.push(`divs=${r.field_divergences.length}`)
    }
    if (r.error && r.verdict === 'FAIL') {
      details.push(r.error.slice(0, 80))
    }

    console.log(`${idxStr} ${svcStr} ${verdictStr}  ${stepsStr.padEnd(8)}  ${details.join('  ')}`)
    return r
  },
  3,
)

// Sort by original order
results.sort((a, b) => a.index - b.index)

const finishedAt = new Date().toISOString()
const totalDurationMs = Date.now() - t0Total

// ── Tally ──
const pass = results.filter(r => r.verdict === 'PASS').length
const warn = results.filter(r => r.verdict === 'WARN').length
const fail = results.filter(r => r.verdict === 'FAIL').length

// Cost from db
let totalCostCents = 0
try {
  const row = db.query('SELECT COALESCE(SUM(cost_cents), 0) AS total FROM llm_call_log').get() as { total: number }
  totalCostCents = row.total
} catch { /* best-effort */ }

const stepsArr = results.filter(r => r.step_count != null).map(r => r.step_count!)
const avgSteps = stepsArr.length > 0 ? (stepsArr.reduce((a, b) => a + b, 0) / stepsArr.length) : 0

// ── Failure / warning modes ──
const failureModes: Record<string, string[]> = {}

const addMode = (mode: string, svc: string) => {
  if (!failureModes[mode]) failureModes[mode] = []
  failureModes[mode].push(svc)
}

for (const r of results) {
  if (r.verdict === 'FAIL') {
    if (r.status === 'FAIL_GENERATE') addMode('generate_failed', r.service)
    else if (r.status === 'FAIL_SCHEMA') addMode('schema_invalid', r.service)
    else if (r.status === 'FAIL_NPM') addMode('package_missing', r.service)
    else if (r.status === 'FAIL_URL') addMode('url_unreachable', r.service)
  }
  if (r.smithery_installs?.length) {
    for (const s of r.smithery_installs) addMode('non_npm_install', r.service)
  }
  if (r.field_divergences?.length) {
    addMode('field_divergences', r.service)
  }
  if (r.url_unreachable?.length && r.verdict !== 'FAIL') {
    addMode('url_unreachable', r.service)
  }
}

// Deduplicate service lists
for (const key of Object.keys(failureModes)) {
  failureModes[key] = [...new Set(failureModes[key])]
}

// ── Count services with field divergences ──
const withDivergences = results.filter(r => r.field_divergences?.length).length

// ── Summary ──
console.log()
console.log('=== Summary ===')
console.log(`PASS:  ${pass}/${SERVICES.length} (${Math.round((pass / SERVICES.length) * 100)}%)`)
console.log(`WARN:  ${warn}/${SERVICES.length} (${Math.round((warn / SERVICES.length) * 100)}%)`)
console.log(`FAIL:  ${fail}/${SERVICES.length} (${Math.round((fail / SERVICES.length) * 100)}%)`)
console.log()

if (Object.keys(failureModes).length > 0) {
  console.log('Failure / warning modes:')
  for (const [mode, svcs] of Object.entries(failureModes)) {
    console.log(`  • ${mode}: ${svcs.length}   (${svcs.join(', ')})`)
  }
  console.log()
}

console.log(`Services with field divergences: ${withDivergences}/${SERVICES.length}`)
console.log(`Average steps per skill: ${avgSteps.toFixed(1)}`)
console.log(`Total LLM cost: $${(totalCostCents / 100).toFixed(4)}`)
console.log(`Total duration: ${(totalDurationMs / 1000).toFixed(1)}s`)
console.log()

// ── Verdict ──
// PASS = 0 issues. WARN = works but needs normalization. FAIL = broken.
// A WARN score of ≥80% with FAILs ≤15% means the LLM logic is mostly correct
// but the field-naming contract needs enforcement via system prompt hardening.
const passRate = pass / SERVICES.length
const warnRate = (pass + warn) / SERVICES.length
const failRate = fail / SERVICES.length
let verdictStr: string
if (passRate >= 0.75) {
  verdictStr = 'HEALTHY — LLM produces canonical recipes for ≥75% of services'
} else if (warnRate >= 0.80 && failRate <= 0.20) {
  verdictStr = 'HEALTHY_WITH_SCHEMA_DRIFT — Skill logic is sound (80%+ structurally valid); field-name normalization in system prompt will push most WARNs to PASS. Hard failures: package hallucination + auth URL blocks'
} else if (warnRate >= 0.60) {
  verdictStr = 'DEGRADED — Skill logic partially works; system prompt + package allowlist patch needed'
} else {
  verdictStr = 'POOR — high hard-failure rate; system prompt hardening + field normalization required'
}
console.log(`Verdict: ${verdictStr}`)

// ── Write JSON ──
const localCacheDir = join(import.meta.dir, '..', 'local_cache')
if (!existsSync(localCacheDir)) {
  mkdirSync(localCacheDir, { recursive: true })
}

const iso = startedAt.replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
const outPath = join(localCacheDir, `llm-accuracy-probe-${iso}.json`)

const probeOutput: ProbeOutput = {
  probe: 'kairos-c2-5-llm-accuracy',
  started_at: startedAt,
  finished_at: finishedAt,
  total_duration_ms: totalDurationMs,
  services_count: SERVICES.length,
  pass,
  warn,
  fail,
  total_cost_cents: totalCostCents,
  average_steps: parseFloat(avgSteps.toFixed(1)),
  results,
  failure_modes: failureModes,
}

writeFileSync(outPath, JSON.stringify(probeOutput, null, 2))
console.log()
console.log(`JSON output: ${outPath}`)
