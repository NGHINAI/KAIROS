// scripts/validate-phase-c2-5.ts
// Phase C.2.5 validation — end-to-end Setup Flow against
// @modelcontextprotocol/server-filesystem (no-auth target).
//
// Mode 1: scripted SetupSkill → SetupFlowRuntime (deterministic, must pass)
//   Asserts:
//     1. SetupFlowRuntime.run() returns { status: 'success' }
//     2. result.steps_completed === skill.steps.length
//     3. mcp-servers.json contains entry with id 'fs-validation' after configure step
//     4. mcpHost.listAllTools() includes ≥1 tool with qualified_id starting 'fs-validation::'
//     5. smoke_test_tool invocation returned { ok: true }
//     6. After cleanup (removeServer + reload), mcp-servers.json has no 'fs-validation'
//     7. Total Mode 1 duration < 120 seconds
//
// Mode 2: setupIntent.handler({ service_name: 'filesystem' }) → LLM → SetupFlowRuntime
//   Best-effort. If LLM hallucinates, prints divergence and continues.
//   Skippable with --skip-llm.
//
// PASS criteria (Mode 1): all 7 assertions above.
// Exit 0 if Mode 1 passes; 1 otherwise.
//
// Usage:
//   bun run scripts/validate-phase-c2-5.ts
//   bun run scripts/validate-phase-c2-5.ts --skip-llm

import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'

import { McpHost } from '../src/daemon/mcp/mcpHost'
import { Keychain } from '../src/daemon/mcp/keychain'
import { McpAutoInstaller } from '../src/daemon/onboarding/mcpAutoInstaller'
import { McpConfigMutator } from '../src/daemon/onboarding/mcpConfigMutator'
import { FlowStateStore } from '../src/daemon/onboarding/flowStateStore'
import { BrowserOpener } from '../src/daemon/onboarding/browserOpener'
import { ClipboardPatternWatcher } from '../src/daemon/onboarding/clipboardPatternWatcher'
import { OAuthCallbackHandler } from '../src/daemon/onboarding/oauthCallbackHandler'
import { InboxUserChannel } from '../src/daemon/onboarding/inboxUserChannel'
import { SetupFlowRuntime } from '../src/daemon/onboarding/setupFlowRuntime'
import { SetupSkillGenerator } from '../src/daemon/onboarding/setupSkillGenerator'
import { createSetupIntent } from '../src/daemon/onboarding/setupIntent'
import { buildRouter } from '../src/daemon/llm'
import type { SetupSkill, SetupFlowResult } from '../src/daemon/onboarding/types'
import type { EventBus } from '../src/daemon/proactive/eventBus'

// ─── Null UserChannel: swallows all output silently ──────────────────────────
const nullUserChannel = {
  async speak(_text: string): Promise<void> {},
  async awaitConfirm(_prompt: string, _def?: 'yes' | 'no'): Promise<boolean> { return true },
  async notifyProgress(_step: number, _total: number, _label: string): Promise<void> {},
  async notifyComplete(_service: string, _summary: string): Promise<void> {},
  async notifyFailed(_service: string, _error: string, _remedy?: string): Promise<void> {},
}

// ─── Null EventBus stub (ClipboardPatternWatcher dep — not used in Mode 1) ──
const nullEventBus = {
  subscribe: () => () => {},
  publish: async () => {},
  recent: () => [],
} as unknown as EventBus

// ─── Known-good skill (Mode 1) ───────────────────────────────────────────────
// list_directory is confirmed to exist: verified by running the server and
// calling McpHost.listAllTools() in a probe script.
const knownGoodSkill: SetupSkill = {
  service_name: 'filesystem-validation',
  service_display_name: 'Filesystem (validation target)',
  auth_type: 'none',
  estimated_minutes: 1,
  steps: [
    { type: 'speak', text: 'Installing filesystem MCP server.' },
    {
      type: 'install_mcp_server',
      via: 'npm',
      package: '@modelcontextprotocol/server-filesystem',
    },
    {
      type: 'configure_mcp_server',
      server_config: {
        id: 'fs-validation',
        enabled: true,
        transport: 'stdio',
        command: 'npx',
        // Use /private/tmp (macOS canonical path for /tmp) to avoid
        // "path outside allowed directories" rejections from the server.
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/private/tmp'],
        tier_policy: { default: 'GREEN' },
      },
    },
    {
      type: 'smoke_test_tool',
      qualified_id: 'fs-validation::list_directory',
      // macOS symlinks /tmp → /private/tmp; the filesystem server uses the
      // canonical resolved path as its allowed-directory root, so we must use
      // /private/tmp (or the server rejects the call as outside allowed dirs).
      args: { path: '/private/tmp' },
    },
    { type: 'speak_on_success', text: 'Filesystem connector ready.' },
    { type: 'speak_on_failure', text: 'Filesystem validation failed.' },
  ],
}

// ─── Assertion helpers ───────────────────────────────────────────────────────
type AssertionResult = { label: string; passed: boolean; actual?: string }

function assert(label: string, condition: boolean, actual?: string): AssertionResult {
  return { label, passed: condition, actual }
}

function printAssertions(assertions: AssertionResult[]): void {
  for (const a of assertions) {
    const icon = a.passed ? '✓' : '✗'
    const suffix = a.actual ? `  (${a.actual})` : ''
    console.log(`    ${icon} ${a.label}${suffix}`)
  }
}

// ─── Mode 1: scripted SetupSkill ─────────────────────────────────────────────
async function runMode1(): Promise<{ passed: boolean; assertions: AssertionResult[]; durationMs: number; result?: SetupFlowResult }> {
  const t0 = Date.now()

  // 1. Create isolated temp directory with its own mcp-servers.json
  const tmpDir = mkdtempSync(join(tmpdir(), 'kairos-c2-5-val-'))
  const configPath = join(tmpDir, 'mcp-servers.json')
  const chatPath = join(tmpDir, 'onboarding-chat.md')

  // Start with an empty config (no servers)
  writeFileSync(configPath, JSON.stringify({ servers: [] }, null, 2))

  // 2. Build all deps (in-memory DB, all onboarding modules)
  const db = new Database(':memory:')
  const keychain = new Keychain()
  const mcpHost = new McpHost({ configPath, keychain })
  await mcpHost.startAll() // starts nothing — empty config

  const mcpConfigMutator = new McpConfigMutator(configPath)
  const flowStateStore = new FlowStateStore(db)
  const userChannel = new InboxUserChannel({ path: chatPath })

  const runtime = new SetupFlowRuntime({
    browserOpener: new BrowserOpener(),
    clipboardPatternWatcher: new ClipboardPatternWatcher(nullEventBus),
    oauthCallbackHandler: new OAuthCallbackHandler(),
    mcpAutoInstaller: new McpAutoInstaller(),
    mcpConfigMutator,
    flowStateStore,
    keychain,
    mcpHost,
    userChannel: nullUserChannel,
  })

  let result: SetupFlowResult | undefined
  const assertions: AssertionResult[] = []

  try {
    // 3. Run the known-good skill
    result = await runtime.run(knownGoodSkill)

    const durationMs = Date.now() - t0

    // Assertion 1: status === 'success'
    assertions.push(assert(
      "result.status === 'success'",
      result.status === 'success',
      `got '${result.status}'${result.status !== 'success' ? ` — ${result.error}` : ''}`,
    ))

    // Assertion 2: steps_completed === skill.steps.length
    assertions.push(assert(
      `steps_completed === ${knownGoodSkill.steps.length}`,
      result.steps_completed === knownGoodSkill.steps.length,
      `got ${result.steps_completed}`,
    ))

    // Assertion 3: mcp-servers.json contains 'fs-validation' entry
    const cfgAfter = mcpConfigMutator.read()
    const serverInConfig = cfgAfter.servers.some(s => s.id === 'fs-validation')
    assertions.push(assert(
      "mcp-servers.json has entry with id 'fs-validation'",
      serverInConfig,
      serverInConfig ? 'found' : 'not found',
    ))

    // Assertion 4: listAllTools includes at least one fs-validation:: tool
    const allTools = mcpHost.listAllTools()
    const fsTools = allTools.filter(t => t.qualified_id.startsWith('fs-validation::'))
    assertions.push(assert(
      'mcpHost.listAllTools() has ≥1 fs-validation:: tool',
      fsTools.length > 0,
      `found ${fsTools.length}: ${fsTools.map(t => t.qualified_id).join(', ')}`,
    ))

    // Assertion 5: smoke_test_tool returned ok: true
    // Infer from status: if status is 'success', the smoke test passed
    // (SetupFlowRuntime throws if smoke test fails, so success implies ok)
    assertions.push(assert(
      "smoke_test_tool (list_directory /tmp) returned { ok: true }",
      result.status === 'success',
      result.status === 'success' ? 'ok (inferred from success path)' : 'smoke test failed → runtime returned failed',
    ))

    // Assertion 6: cleanup — remove 'fs-validation', reload, verify gone
    mcpConfigMutator.removeServer('fs-validation')
    await mcpHost.stopAll()
    await mcpHost.startAll()
    const cfgClean = mcpConfigMutator.read()
    const cleanedUp = !cfgClean.servers.some(s => s.id === 'fs-validation')
    assertions.push(assert(
      "after cleanup: 'fs-validation' absent from mcp-servers.json",
      cleanedUp,
      cleanedUp ? 'removed' : 'still present!',
    ))

    // Assertion 7: duration < 120s
    assertions.push(assert(
      'total Mode 1 duration < 120s',
      durationMs < 120_000,
      `${(durationMs / 1000).toFixed(1)}s`,
    ))

    const allPassed = assertions.every(a => a.passed)
    return { passed: allPassed, assertions, durationMs, result }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const durationMs = Date.now() - t0
    assertions.push(assert('runtime.run() did not throw', false, msg))
    return { passed: false, assertions, durationMs, result }
  } finally {
    // Always cleanup: stop host + remove temp dir
    try { await mcpHost.stopAll() } catch { /* best-effort */ }
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
  }
}

// ─── Mode 2: LLM-generated skill ─────────────────────────────────────────────
async function runMode2(): Promise<{ passed: boolean; error?: string; durationMs: number; result?: SetupFlowResult }> {
  const t0 = Date.now()

  // Need a real ModelRouter for LLM calls; use the production provider config if available
  const providerConfigPath = join(homedir(), '.kairos', 'providers.json')
  const db = new Database(':memory:')

  let router
  try {
    router = buildRouter(db, providerConfigPath)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { passed: false, error: `Failed to build ModelRouter: ${msg}`, durationMs: Date.now() - t0 }
  }

  const tmpDir = mkdtempSync(join(tmpdir(), 'kairos-c2-5-mode2-'))
  const configPath = join(tmpDir, 'mcp-servers.json')

  // Seed with existing production servers so the mode2 host loads correctly;
  // but start clean so the LLM-generated config is isolated
  writeFileSync(configPath, JSON.stringify({ servers: [] }, null, 2))

  const keychain = new Keychain()
  const mcpHost = new McpHost({ configPath, keychain })
  await mcpHost.startAll()

  const mcpConfigMutator = new McpConfigMutator(configPath)
  const db2 = new Database(':memory:')
  const flowStateStore = new FlowStateStore(db2)

  const runtime = new SetupFlowRuntime({
    browserOpener: new BrowserOpener(),
    clipboardPatternWatcher: new ClipboardPatternWatcher(nullEventBus),
    oauthCallbackHandler: new OAuthCallbackHandler(),
    mcpAutoInstaller: new McpAutoInstaller(),
    mcpConfigMutator,
    flowStateStore,
    keychain,
    mcpHost,
    userChannel: nullUserChannel,
  })

  const generator = new SetupSkillGenerator(router)
  const intent = createSetupIntent({ generator, runtime })

  try {
    const result = await intent.handler({ service_name: 'filesystem' })
    const durationMs = Date.now() - t0

    // Cleanup: remove any server the LLM added
    try {
      const cfg = mcpConfigMutator.read()
      for (const s of cfg.servers) {
        mcpConfigMutator.removeServer(s.id)
      }
    } catch { /* best-effort */ }

    if (result.status === 'success') {
      return { passed: true, durationMs, result }
    } else {
      return {
        passed: false,
        error: `LLM-generated skill returned status '${result.status}': ${result.error ?? 'no error detail'}`,
        durationMs,
        result,
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { passed: false, error: msg, durationMs: Date.now() - t0 }
  } finally {
    try { await mcpHost.stopAll() } catch { /* best-effort */ }
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
const scriptArgs = process.argv.slice(2)
const skipLLM = scriptArgs.includes('--skip-llm')

console.log('=== Phase C.2.5 Validation ===')
console.log('Target: @modelcontextprotocol/server-filesystem')
console.log(`LLM mode: ${skipLLM ? 'SKIPPED (--skip-llm)' : 'enabled'}\n`)

// ── Mode 1 ──
console.log('── Mode 1: scripted SetupSkill (deterministic) ──')
const mode1 = await runMode1()
console.log(`Status: ${mode1.passed ? '✓ PASS' : '✗ FAIL'}  (${(mode1.durationMs / 1000).toFixed(1)}s)\n`)
console.log('Assertions:')
printAssertions(mode1.assertions)

if (mode1.result) {
  console.log('\nResult detail:')
  console.log(`  flow_id:         ${mode1.result.flow_id}`)
  console.log(`  steps_completed: ${mode1.result.steps_completed}/${mode1.result.steps_total}`)
  if (mode1.result.registered_tools?.length) {
    console.log(`  registered_tools: ${mode1.result.registered_tools.join(', ')}`)
  }
  if (mode1.result.error) {
    console.log(`  error: ${mode1.result.error}`)
  }
}

// ── Mode 2 ──
let mode2: { passed: boolean; error?: string; durationMs: number; result?: SetupFlowResult } | null = null
if (!skipLLM) {
  console.log('\n── Mode 2: LLM-generated skill (best-effort) ──')
  mode2 = await runMode2()
  const icon = mode2.passed ? '✓ PASS' : '⚠ DIVERGED'
  console.log(`Status: ${icon}  (${(mode2.durationMs / 1000).toFixed(1)}s)`)
  if (!mode2.passed && mode2.error) {
    console.log(`Divergence: ${mode2.error}`)
  }
  if (mode2.result) {
    console.log(`Result: status=${mode2.result.status}, steps=${mode2.result.steps_completed}/${mode2.result.steps_total}`)
  }
}

// ── Summary table ──
console.log('\n╔══════════════════════════════════════════════════════════╗')
console.log('║              Phase C.2.5 Validation Summary             ║')
console.log('╠══════════════════════════════════════════════════════════╣')
console.log(`║  Mode 1 (scripted skill)   ${mode1.passed ? 'PASS ✓' : 'FAIL ✗'}  (${(mode1.durationMs / 1000).toFixed(1)}s)${' '.repeat(Math.max(0, 20 - (mode1.durationMs / 1000).toFixed(1).length))}║`)
if (mode2 !== null) {
  console.log(`║  Mode 2 (LLM-generated)    ${mode2.passed ? 'PASS ✓' : 'DIVG ⚠'}  (${(mode2.durationMs / 1000).toFixed(1)}s)${' '.repeat(Math.max(0, 20 - (mode2.durationMs / 1000).toFixed(1).length))}║`)
} else {
  console.log('║  Mode 2 (LLM-generated)    SKIP  (--skip-llm)           ║')
}
console.log('╠══════════════════════════════════════════════════════════╣')
console.log(`║  Gate verdict:  ${mode1.passed ? 'PASS ✓  (Mode 1 passed)          ' : 'FAIL ✗  (Mode 1 failed)          '}║`)
console.log('╚══════════════════════════════════════════════════════════╝')

process.exit(mode1.passed ? 0 : 1)
