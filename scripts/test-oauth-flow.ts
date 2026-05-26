// scripts/test-oauth-flow.ts
// KAIROS C.2.5 — OAuth End-to-End Test
//
// Proves that OAuthCallbackHandler → SetupFlowRuntime step orchestration →
// Keychain storage all wire together correctly with a fully-automated
// fake OAuth provider (no browser required).
//
// TIMING APPROACH:
//   SetupFlowRuntime.run() calls oauthCallbackHandler.listen() then
//   immediately awaits capturePromise. The port is only known AFTER listen()
//   returns. We solve this by subclassing OAuthCallbackHandler with
//   InstrumentedOAuthCallbackHandler, which fires a Promise-based side-channel
//   (portReady) once listen() is called, exposing the chosen port. The test
//   orchestrator:
//     1. Starts runtime.run() in a background Promise
//     2. Awaits portReady to learn the callback port
//     3. GETs fake provider /authorize → auto-approves → 302 to KAIROS callback
//     4. The 302 target is the OAuthCallbackHandler URL; fetch(redirect:'follow')
//        delivers the hit automatically
//   No fixed sleeps. Fully deterministic.

import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
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
import type { ListenOptions, ListenResult } from '../src/daemon/onboarding/oauthCallbackHandler'
import { SetupFlowRuntime } from '../src/daemon/onboarding/setupFlowRuntime'
import type { SetupSkill, SetupFlowResult } from '../src/daemon/onboarding/types'
import type { EventBus } from '../src/daemon/proactive/eventBus'

// ─── Side-channel instrumented OAuthCallbackHandler ─────────────────────────
// Subclass that fires portReady once listen() is called, exposing the port
// BEFORE capturePromise resolves. This lets the test orchestrator know where
// to deliver the fake callback without any fixed sleeps.

class InstrumentedOAuthCallbackHandler extends OAuthCallbackHandler {
  private _portReadyResolve!: (port: number) => void
  readonly portReady: Promise<number> = new Promise(resolve => {
    this._portReadyResolve = resolve
  })

  override async listen(opts: ListenOptions): Promise<ListenResult> {
    const result = await super.listen(opts)
    this._portReadyResolve(result.port)
    return result
  }
}

// ─── Null stubs ──────────────────────────────────────────────────────────────
const nullEventBus = {
  subscribe: () => () => {},
  publish: async () => {},
  recent: () => [],
} as unknown as EventBus

// ─── OAuth skill under test ───────────────────────────────────────────────────
// Uses filesystem MCP server as the post-OAuth installed target — it doesn't
// verify the token, which is intentional: we test the OAuth STEP types, not
// a real OAuth service.
const oauthSkill: SetupSkill = {
  service_name: 'fakeoauth-validation',
  service_display_name: 'Fake OAuth Provider (validation)',
  auth_type: 'oauth',
  estimated_minutes: 1,
  steps: [
    { type: 'speak', text: 'Starting OAuth flow with fake provider.' },
    { type: 'wait_for_oauth_callback', callback_path: '/oauth-cb', expected_param: 'code', timeout_sec: 10 },
    { type: 'store_keychain', service: 'com.kairos.fakeoauth-validation', account: 'oauth-token', source: 'oauth' },
    { type: 'install_mcp_server', via: 'npm', package: '@modelcontextprotocol/server-filesystem' },
    {
      type: 'configure_mcp_server',
      server_config: {
        id: 'fakeoauth-validation',
        enabled: true,
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/private/tmp'],
        tier_policy: { default: 'GREEN' },
      },
    },
    { type: 'smoke_test_tool', qualified_id: 'fakeoauth-validation::list_allowed_directories' },
    { type: 'speak_on_success', text: 'OAuth flow validated end-to-end.' },
    { type: 'speak_on_failure', text: 'OAuth flow failed.' },
  ],
}

// ─── Assertion helpers ────────────────────────────────────────────────────────
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

// ─── Main ─────────────────────────────────────────────────────────────────────
const OAUTH_STATE = 'xyz'
const FAKE_CODE = 'fake-auth-code-abc123'
const KEYCHAIN_SERVICE = 'com.kairos.fakeoauth-validation'
const KEYCHAIN_ACCOUNT = 'oauth-token'

console.log('=== KAIROS C.2.5 OAuth End-to-End Test ===')
console.log(`Started: ${new Date().toISOString()}\n`)

const totalT0 = Date.now()

// ── [1/3] Spin up fake OAuth provider ────────────────────────────────────────
process.stdout.write('[1/3] Spinning up fake OAuth provider...           ')

const fakeProviderServer = Bun.serve({
  port: 0 as any,
  fetch: async (req) => {
    const url = new URL(req.url)

    if (url.pathname === '/authorize') {
      // Auto-approve: redirect to redirect_uri with code + state
      const redirectUri = url.searchParams.get('redirect_uri') ?? ''
      const state = url.searchParams.get('state') ?? ''
      const target = `${redirectUri}?code=${FAKE_CODE}&state=${encodeURIComponent(state)}`
      return new Response(null, {
        status: 302,
        headers: { Location: target },
      })
    }

    return new Response('Not found', { status: 404 })
  },
})

const fakeProviderPort = (fakeProviderServer as any).port
console.log(`✓ port=${fakeProviderPort}`)

// ── [2/3] Run SetupFlowRuntime with OAuth skill ───────────────────────────────
console.log('[2/3] Running SetupFlowRuntime with OAuth skill...')

const tmpDir = mkdtempSync(join(tmpdir(), 'kairos-oauth-e2e-'))
const configPath = join(tmpDir, 'mcp-servers.json')
const chatPath = join(tmpDir, 'onboarding-chat.md')

writeFileSync(configPath, JSON.stringify({ servers: [] }, null, 2))

const db = new Database(':memory:')
const keychain = new Keychain()
const mcpHost = new McpHost({ configPath, keychain })
await mcpHost.startAll()

const mcpConfigMutator = new McpConfigMutator(configPath)
const flowStateStore = new FlowStateStore(db)
const instrumentedOAuth = new InstrumentedOAuthCallbackHandler()

const runtime = new SetupFlowRuntime({
  browserOpener: new BrowserOpener(),
  clipboardPatternWatcher: new ClipboardPatternWatcher(nullEventBus),
  oauthCallbackHandler: instrumentedOAuth,
  mcpAutoInstaller: new McpAutoInstaller(),
  mcpConfigMutator,
  flowStateStore,
  keychain,
  mcpHost,
  userChannel: {
    async speak(_text: string): Promise<void> {},
    async awaitConfirm(_prompt: string, _def?: 'yes' | 'no'): Promise<boolean> { return true },
    async notifyProgress(_step: number, _total: number, _label: string): Promise<void> {},
    async notifyComplete(_service: string, _summary: string): Promise<void> {},
    async notifyFailed(_service: string, _error: string, _remedy?: string): Promise<void> {},
  },
})

console.log('  → speak: Starting OAuth flow with fake provider.')
console.log('  → wait_for_oauth_callback (path=/oauth-cb)')

// Start runtime in background — it will block at wait_for_oauth_callback
const runtimePromise = runtime.run(oauthSkill)

// Wait for OAuthCallbackHandler to bind and expose its port via side-channel
const callbackPort = await instrumentedOAuth.portReady
const callbackUrl = `http://localhost:${callbackPort}/oauth-cb`
const authorizeUrl =
  `http://localhost:${fakeProviderPort}/authorize` +
  `?client_id=kairos-test` +
  `&redirect_uri=${encodeURIComponent(callbackUrl)}` +
  `&state=${OAUTH_STATE}`

console.log('  → triggering fake provider redirect → KAIROS callback')

// GET /authorize with redirect:follow — Bun follows the 302 to the KAIROS callback port
// This delivers code=fake-auth-code-abc123&state=xyz to OAuthCallbackHandler
await fetch(authorizeUrl, { redirect: 'follow' })

console.log(`  → received code=${FAKE_CODE} state=${OAUTH_STATE}`)
console.log(`  → keychain.set ${KEYCHAIN_SERVICE}/${KEYCHAIN_ACCOUNT}`)
console.log('  → install_mcp_server: @modelcontextprotocol/server-filesystem (npm)')
console.log('  → configure_mcp_server: fakeoauth-validation')

// Await full runtime completion
const result: SetupFlowResult = await runtimePromise

// Capture data BEFORE cleanup
const allTools = mcpHost.listAllTools()
const oauthTools = allTools.filter(t => t.qualified_id.startsWith('fakeoauth-validation::'))

console.log(`  → McpHost reload, ${allTools.length} tools registered`)
console.log(`  → smoke_test_tool fakeoauth-validation::list_allowed_directories  ${result.status === 'success' ? 'ok' : 'FAILED'}`)

// Read keychain value BEFORE cleanup to assert its shape
const keychainRaw = await keychain.get(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)

// ── [3/3] Cleanup ─────────────────────────────────────────────────────────────
process.stdout.write('[3/3] Cleanup...                                    ')

fakeProviderServer.stop()

try { mcpConfigMutator.removeServer('fakeoauth-validation') } catch { /* best-effort */ }
try { await mcpHost.stopAll() } catch { /* best-effort */ }
// Best-effort keychain removal — overwrite with empty string since Keychain has no delete API
try { await keychain.set(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, '') } catch { /* best-effort */ }
try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }

console.log('✓\n')

// ── Assertions ────────────────────────────────────────────────────────────────
const totalDurationMs = Date.now() - totalT0

const assertions: AssertionResult[] = []

// Assertion 1: result.status === 'success'
assertions.push(assert(
  "result.status === 'success'",
  result.status === 'success',
  result.status === 'success' ? 'success' : `got '${result.status}' — ${result.error}`,
))

// Assertion 2: steps_completed === 8
assertions.push(assert(
  'steps_completed === 8',
  result.steps_completed === 8,
  `got ${result.steps_completed}`,
))

// Assertion 3: Keychain has entry with correct JSON shape
let keychainParsed: Record<string, string> | null = null
try {
  keychainParsed = keychainRaw ? JSON.parse(keychainRaw) : null
} catch { /* parse failed */ }

const keychainShape =
  keychainParsed !== null &&
  keychainParsed.code === FAKE_CODE &&
  keychainParsed.state === OAUTH_STATE

assertions.push(assert(
  `keychain ${KEYCHAIN_SERVICE}/${KEYCHAIN_ACCOUNT} contains JSON {code, state}`,
  keychainShape,
  keychainRaw
    ? (keychainShape ? `stored (length: ${keychainRaw.length} bytes)` : `wrong shape: ${keychainRaw.slice(0, 80)}`)
    : 'null (not found)',
))

// Assertion 4: mcp-servers.json had 'fakeoauth-validation' entry
assertions.push(assert(
  "installed_server_id === 'fakeoauth-validation'",
  result.installed_server_id === 'fakeoauth-validation',
  result.installed_server_id ? `got ${result.installed_server_id}` : 'undefined',
))

// Assertion 5: McpHost had at least one fakeoauth-validation:: tool
assertions.push(assert(
  'mcpHost.listAllTools() has ≥1 fakeoauth-validation:: tool',
  oauthTools.length > 0,
  `found ${oauthTools.length}: ${oauthTools.map(t => t.qualified_id).slice(0, 3).join(', ')}`,
))

// Assertion 6: smoke test returned ok (inferred from status === 'success')
assertions.push(assert(
  'smoke_test_tool fakeoauth-validation::list_allowed_directories returned ok',
  result.status === 'success',
  result.status === 'success' ? 'ok (implied by success path)' : `failed — ${result.error}`,
))

const allPassed = assertions.every(a => a.passed)
const passCount = assertions.filter(a => a.passed).length

// ── Result output ──────────────────────────────────────────────────────────────
console.log('=== Result ===')
console.log(`status: ${result.status}`)
console.log(`steps_completed: ${result.steps_completed}`)
console.log(`duration: ${(totalDurationMs / 1000).toFixed(1)}s`)
console.log(`keychain_entry: ${keychainShape ? `stored (length: ${keychainRaw!.length} bytes)` : 'NOT stored correctly'}`)
console.log(`mcp_tools_after_install: ${allTools.length}`)
if (result.error) {
  console.log(`error: ${result.error}`)
}

console.log(`\nAssertions: ${passCount}/${assertions.length} ${allPassed ? 'PASS' : 'FAIL'}`)
printAssertions(assertions)

console.log(`\nOAuth E2E: ${allPassed ? '✓ PASS' : '✗ FAIL'}`)

process.exit(allPassed ? 0 : 1)
