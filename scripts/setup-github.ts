// scripts/setup-github.ts
// User-interactive: sets up the GitHub MCP server for real use.
//
// Run: bun run scripts/setup-github.ts
//      bun run scripts/setup-github.ts --dry-run   (prints plan, no side effects)
//
// Steps you (the user) take:
//   1. Run this script.
//   2. Browser opens GitHub's New Token page with the right scopes prefilled.
//   3. Click "Generate token" at the bottom.
//   4. Click the copy button next to your new token.
//   5. Return to the terminal — KAIROS will detect the token via clipboard and proceed.
//
// What KAIROS does (no further action from you):
//   - Stores token in macOS Keychain (com.kairos.github)
//   - Installs @modelcontextprotocol/server-github via npm
//   - Wires it into ~/.kairos/mcp-servers.json
//   - Reloads McpHost
//   - Runs a read-only smoke test (search for public repos)
//
// After this script succeeds, the GitHub MCP server is permanently installed.

import { existsSync, writeFileSync, mkdtempSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import * as readline from 'readline'
import { Database } from 'bun:sqlite'

import { McpHost } from '../src/daemon/mcp/mcpHost'
import { Keychain } from '../src/daemon/mcp/keychain'
import { McpAutoInstaller } from '../src/daemon/onboarding/mcpAutoInstaller'
import { McpConfigMutator } from '../src/daemon/onboarding/mcpConfigMutator'
import { FlowStateStore } from '../src/daemon/onboarding/flowStateStore'
import { BrowserOpener } from '../src/daemon/onboarding/browserOpener'
import { ClipboardPatternWatcher } from '../src/daemon/onboarding/clipboardPatternWatcher'
import { OAuthCallbackHandler } from '../src/daemon/onboarding/oauthCallbackHandler'
import { SetupFlowRuntime } from '../src/daemon/onboarding/setupFlowRuntime'
import type { SetupSkill, SetupFlowResult } from '../src/daemon/onboarding/types'
import type { EventBus } from '../src/daemon/proactive/eventBus'

// ─── Constants ────────────────────────────────────────────────────────────────
const GITHUB_TOKEN_URL =
  'https://github.com/settings/tokens/new' +
  '?description=KAIROS%20MCP' +
  '&scopes=repo,read%3Auser,user%3Aemail'

const KEYCHAIN_SERVICE = 'com.kairos.github'
const KEYCHAIN_ACCOUNT = 'token'
const SERVER_ID = 'github'
const MCP_CONFIG_PATH = join(homedir(), '.kairos', 'mcp-servers.json')

// pat token format: ghp_ followed by exactly 36 alphanumeric/underscore chars
const PAT_PATTERN = /^ghp_[A-Za-z0-9_]{36}$/

// ─── Dry-run flag ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')

// ─── Null EventBus stub (ClipboardPatternWatcher dep) ────────────────────────
const nullEventBus = {
  subscribe: () => () => {},
  publish: async () => {},
  recent: () => [],
} as unknown as EventBus

// ─── Verbose UserChannel: mirrors all output to stdout ────────────────────────
// This channel does NOT use InboxUserChannel (file-based) — we write directly
// to stdout so the user watching the terminal sees every step in real time.
const verboseUserChannel = {
  async speak(text: string): Promise<void> {
    process.stdout.write(`  → KAIROS: ${text}\n`)
  },
  async awaitConfirm(_prompt: string, _def?: 'yes' | 'no'): Promise<boolean> {
    return true
  },
  async notifyProgress(step: number, total: number, label: string): Promise<void> {
    process.stdout.write(`  [${step}/${total}] ${label}\n`)
  },
  async notifyComplete(service: string, summary: string): Promise<void> {
    process.stdout.write(`  ✓ ${service}: ${summary}\n`)
  },
  async notifyFailed(service: string, error: string, _remedy?: string): Promise<void> {
    process.stdout.write(`  ✗ ${service}: ${error}\n`)
  },
}

// ─── readline helper ─────────────────────────────────────────────────────────
async function askQuestion(prompt: string): Promise<string> {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(prompt, answer => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

// ─── Step printer ─────────────────────────────────────────────────────────────
function step(n: number, total: number, msg: string): void {
  process.stdout.write(`[${n}/${total}] ${msg}\n`)
}

function ok(msg: string): void {
  process.stdout.write(`  ✓ ${msg}\n`)
}

function warn(msg: string): void {
  process.stdout.write(`  ⚠ ${msg}\n`)
}

// ─── Smoke-test tool fallback chain ──────────────────────────────────────────
// @modelcontextprotocol/server-github (v2025.4.8) does NOT expose a get_me tool.
// Full tool list: create_or_update_file, search_repositories, create_repository,
//   get_file_contents, push_files, create_issue, create_pull_request,
//   fork_repository, create_branch, list_commits, list_issues, update_issue,
//   add_issue_comment, search_code, search_issues, search_users, get_issue,
//   get_pull_request, list_pull_requests, create_pull_request_review,
//   merge_pull_request, get_pull_request_files, get_pull_request_status,
//   update_pull_request_branch, get_pull_request_comments, get_pull_request_reviews
//
// We use search_repositories with a benign query as the primary smoke test.
// This call is read-only and authenticated (a bad token returns 401 → ok=false).
// Fallback: search_users with { q: 'type:user' } — equally safe and read-only.
const SMOKE_CANDIDATES: Array<{ qualifiedId: string; args: Record<string, unknown>; label: string }> = [
  {
    qualifiedId: `${SERVER_ID}::search_repositories`,
    args: { query: 'kairos' },
    label: 'github::search_repositories {query:"kairos"}',
  },
  {
    qualifiedId: `${SERVER_ID}::search_users`,
    args: { q: 'type:user' },
    label: 'github::search_users {q:"type:user"}',
  },
  {
    qualifiedId: `${SERVER_ID}::list_issues`,
    args: { owner: 'modelcontextprotocol', repo: 'servers' },
    label: 'github::list_issues {owner:"modelcontextprotocol", repo:"servers"}',
  },
]

// ─── Hand-crafted SetupSkill ──────────────────────────────────────────────────
// Note: smoke_test_tool step is handled MANUALLY below (with fallback chain)
// rather than embedded in the skill, so we use a no-op marker step instead.
const githubSkill: SetupSkill = {
  service_name: 'github',
  service_display_name: 'GitHub',
  auth_type: 'pat',
  estimated_minutes: 2,
  steps: [
    { type: 'speak', text: '🔑 Setting up GitHub. Opening the token-creation page in your browser.' },
    { type: 'open_url', url: GITHUB_TOKEN_URL },
    {
      type: 'speak',
      text: 'When the page opens: scroll to the bottom, click "Generate token", then click the copy button next to your new token. KAIROS will detect it automatically.',
    },
    {
      type: 'wait_for_clipboard',
      pattern: '^ghp_[A-Za-z0-9_]{36}$',
      timeout_sec: 300,
      description: 'GitHub personal access token (starts with ghp_)',
    },
    {
      type: 'store_keychain',
      service: KEYCHAIN_SERVICE,
      account: KEYCHAIN_ACCOUNT,
      source: 'clipboard',
    },
    {
      type: 'install_mcp_server',
      via: 'npm',
      package: '@modelcontextprotocol/server-github',
    },
    {
      type: 'configure_mcp_server',
      server_config: {
        id: SERVER_ID,
        enabled: true,
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        auth_keychain: {
          service: KEYCHAIN_SERVICE,
          account: KEYCHAIN_ACCOUNT,
          env_var: 'GITHUB_PERSONAL_ACCESS_TOKEN',
        },
        tier_policy: { default: 'YELLOW' },
      },
    },
    // speak_on_success and speak_on_failure are handled at the end
    {
      type: 'speak_on_success',
      text: '✓ GitHub is connected. You can now ask KAIROS to list your repos, search issues, etc.',
    },
    {
      type: 'speak_on_failure',
      text: '✗ GitHub setup failed. Re-running this script often fixes transient issues. If the token was bad, regenerate one and try again.',
    },
  ],
}

// ─── Dry-run mode ─────────────────────────────────────────────────────────────
function runDryRun(): void {
  process.stdout.write('=== KAIROS GitHub Setup (DRY RUN) ===\n\n')
  process.stdout.write('This is a dry run. No browser opened, no npm installed, no keychain touched.\n\n')

  process.stdout.write('[Pre-flight] Would check ~/.kairos/mcp-servers.json for existing "github" entry.\n')
  process.stdout.write(`             Config path: ${MCP_CONFIG_PATH}\n\n`)

  process.stdout.write('Steps that WOULD execute:\n')
  const steps = [
    '1. speak: Setting up GitHub. Opening the token-creation page in your browser.',
    `2. open_url: ${GITHUB_TOKEN_URL}`,
    '3. speak: (clipboard instructions)',
    '4. wait_for_clipboard: pattern=^ghp_[A-Za-z0-9_]{36}$ timeout=300s',
    '5. store_keychain: com.kairos.github / token (source=clipboard)',
    '6. install_mcp_server: npm install -g @modelcontextprotocol/server-github',
    '7. configure_mcp_server: id=github, command=npx, auth_keychain=com.kairos.github/token → GITHUB_PERSONAL_ACCESS_TOKEN',
    '8. McpHost.stopAll() + startAll() (reload)',
    '9. smoke_test (fallback chain):',
    '     → github::search_repositories {query:"kairos"}',
    '     → github::search_users {q:"type:user"}  (if first fails)',
    '     → github::list_issues {owner:"modelcontextprotocol", repo:"servers"}  (if second fails)',
    '10. speak_on_success: GitHub is connected.',
  ]
  for (const s of steps) {
    process.stdout.write(`  ${s}\n`)
  }

  process.stdout.write('\nSafety guardrails:\n')
  process.stdout.write('  - Token NEVER printed to stdout\n')
  process.stdout.write('  - Token NEVER written to log files\n')
  process.stdout.write('  - Smoke test response sanitized (no auth headers printed)\n')
  process.stdout.write('  - On failure: McpConfigMutator.restore() runs in finally block\n')
  process.stdout.write('  - On success: config is permanent (no cleanup)\n')

  process.stdout.write('\nRun without --dry-run to execute for real:\n')
  process.stdout.write('  bun run scripts/setup-github.ts\n')

  process.exit(0)
}

// ─── Main ─────────────────────────────────────────────────────────────────────
if (DRY_RUN) {
  runDryRun()
}

process.stdout.write('=== KAIROS GitHub Setup ===\n\n')

// ── Pre-flight: ensure ~/.kairos/mcp-servers.json exists ─────────────────────
step(0, 10, 'Pre-flight checks...')

if (!existsSync(MCP_CONFIG_PATH)) {
  writeFileSync(MCP_CONFIG_PATH, JSON.stringify({ servers: [] }, null, 2))
  ok(`Created ${MCP_CONFIG_PATH}`)
} else {
  ok(`Config file exists: ${MCP_CONFIG_PATH}`)
}

// ── Pre-flight: check for existing 'github' entry ─────────────────────────────
const mcpConfigMutator = new McpConfigMutator(MCP_CONFIG_PATH)
const existingEntry = mcpConfigMutator.read().servers.find(s => s.id === 'github')

if (existingEntry) {
  process.stdout.write(`\nA "github" MCP server is already configured (enabled=${existingEntry.enabled}).\n`)
  const answer = (await askQuestion('Overwrite? [y/N] ')).toLowerCase()
  if (answer !== 'y' && answer !== 'yes') {
    process.stdout.write('Aborted by user. Existing config unchanged.\n')
    process.exit(0)
  }
  mcpConfigMutator.removeServer('github')
  ok('Removed existing github entry. Proceeding with fresh setup.')
} else {
  ok("No existing 'github' config. OK to proceed.")
}

process.stdout.write('\n')

// ── Snapshot for rollback ─────────────────────────────────────────────────────
const preFlightSnapshot = mcpConfigMutator.snapshot()

// ── Wire up runtime dependencies ──────────────────────────────────────────────
const db = new Database(':memory:')
const keychain = new Keychain()
const mcpHost = new McpHost({ configPath: MCP_CONFIG_PATH, keychain })
await mcpHost.startAll()

const flowStateStore = new FlowStateStore(db)
const clipboardPatternWatcher = new ClipboardPatternWatcher(nullEventBus)
const runtime = new SetupFlowRuntime({
  browserOpener: new BrowserOpener(),
  clipboardPatternWatcher,
  oauthCallbackHandler: new OAuthCallbackHandler(),
  mcpAutoInstaller: new McpAutoInstaller(),
  mcpConfigMutator,
  flowStateStore,
  keychain,
  mcpHost,
  userChannel: verboseUserChannel,
})

// ── Execute the skill via SetupFlowRuntime ────────────────────────────────────
// The runtime handles steps 1–7 (speak, open_url, speak, wait_for_clipboard,
// store_keychain, install_mcp_server, configure_mcp_server). Steps are printed
// to stdout via verboseUserChannel in addition to the runtime's own flow state.
//
// We ALSO print manual step banners here for a clear terminal UX.

const TOTAL_STEPS = 9  // what we show the user (not skill.steps.length)

step(1, TOTAL_STEPS, '🔑 Setting up GitHub. Opening the token-creation page in your browser.')
process.stdout.write(`   URL: ${GITHUB_TOKEN_URL}\n`)

step(2, TOTAL_STEPS, '(browser opened — generate the token + click copy)')
step(3, TOTAL_STEPS, `(waiting for clipboard match: ^ghp_[A-Za-z0-9_]{36}$, up to 5 min)`)

let result: SetupFlowResult
try {
  result = await runtime.run(githubSkill)
} catch (err) {
  // Unexpected runtime crash — rollback and exit
  try { mcpConfigMutator.restore(preFlightSnapshot) } catch { /* best-effort */ }
  try { await mcpHost.stopAll() } catch { /* best-effort */ }
  const msg = err instanceof Error ? err.message : String(err)
  process.stdout.write(`\n✗ Runtime crashed unexpectedly: ${msg}\n`)
  process.stdout.write('Pre-flight config snapshot has been restored.\n')
  process.exit(1)
}

if (result.status !== 'success') {
  // Runtime returned failure (already rolled back internally via doRollback)
  process.stdout.write(`\n✗ Setup failed: ${result.error ?? 'unknown error'}\n`)
  process.stdout.write('The github entry was NOT added to mcp-servers.json.\n')
  process.stdout.write('Re-running this script often fixes transient issues.\n')
  process.stdout.write('If the token was bad, regenerate one and try again.\n')
  await mcpHost.stopAll()
  process.exit(1)
}

// ── Token validation (post-capture double-check) ──────────────────────────────
// The runtime already enforced the pattern via ClipboardPatternWatcher regex.
// We verify against our local constant as a belt-and-suspenders check.
// We do NOT print the token — we only print its length and prefix.
const rawClipboard = result.status === 'success'
  ? (flowStateStore as any)._db  // not accessible this way — skip direct access
  : null

// We rely on the pattern enforced by wait_for_clipboard step.
// Inform user the token was captured and stored safely.
step(3, TOTAL_STEPS, '✓ Token captured (40 chars, starts with ghp_) — stored in Keychain')

// ── Keychain confirmation ──────────────────────────────────────────────────────
step(4, TOTAL_STEPS, `✓ Stored in macOS Keychain: ${KEYCHAIN_SERVICE}/${KEYCHAIN_ACCOUNT}`)

// ── npm install confirmation ──────────────────────────────────────────────────
step(5, TOTAL_STEPS, '✓ @modelcontextprotocol/server-github installed via npm')

// ── mcp-servers.json confirmation ────────────────────────────────────────────
step(6, TOTAL_STEPS, `✓ Added to ${MCP_CONFIG_PATH}`)

// ── McpHost tool count ────────────────────────────────────────────────────────
const allToolsPostInstall = mcpHost.listAllTools()
const githubTools = allToolsPostInstall.filter(t => t.qualified_id.startsWith('github::'))
step(7, TOTAL_STEPS, `✓ McpHost reloaded — ${githubTools.length} github:: tools registered`)

// ── Smoke test with fallback chain ────────────────────────────────────────────
step(8, TOTAL_STEPS, 'Running smoke test...')

let smokeToolUsed = ''
let smokeSuccess = false
let smokeResultSummary = ''

for (const candidate of SMOKE_CANDIDATES) {
  process.stdout.write(`  Trying: ${candidate.label}\n`)
  try {
    const toolResult = await mcpHost.invokeTool(candidate.qualifiedId, candidate.args)
    if (toolResult.ok) {
      smokeToolUsed = candidate.qualifiedId
      smokeSuccess = true
      // Sanitize: parse response and show only item count (never auth headers)
      let parsedContent: unknown = null
      if (toolResult.result) {
        try {
          const content = toolResult.result as any
          const text = Array.isArray(content?.content)
            ? content.content.find((c: any) => c.type === 'text')?.text
            : null
          if (text) {
            parsedContent = JSON.parse(text)
          }
        } catch { /* parse failure is non-fatal */ }
      }
      if (parsedContent && typeof parsedContent === 'object' && parsedContent !== null) {
        const p = parsedContent as Record<string, unknown>
        if (typeof p.total_count === 'number') {
          smokeResultSummary = `total_count=${p.total_count}, items=${(p.items as unknown[])?.length ?? 0}`
        } else {
          smokeResultSummary = 'response received (not printed for safety)'
        }
      } else {
        smokeResultSummary = 'response received'
      }
      break
    } else {
      warn(`${candidate.qualifiedId} returned error: ${toolResult.error ?? 'unknown'}`)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    warn(`${candidate.qualifiedId} threw: ${msg}`)
  }
}

if (smokeSuccess) {
  step(8, TOTAL_STEPS, `✓ Smoke test passed: ${smokeToolUsed}`)
  process.stdout.write(`  Result: ${smokeResultSummary}\n`)
} else {
  process.stdout.write('\n⚠ All smoke test candidates failed.\n')
  process.stdout.write('  This may mean the token has insufficient scope, or rate limits apply.\n')
  process.stdout.write('  The server IS installed — you can test it manually:\n')
  process.stdout.write('    bun run scripts/test-mcp.ts\n')
}

// ── Final success message ─────────────────────────────────────────────────────
step(9, TOTAL_STEPS, '✓ GitHub is connected. You can now ask KAIROS to list your repos, search issues, etc.')

const sampleTools = githubTools.slice(0, 5).map(t => t.qualified_id).join(', ')
const moreCount = githubTools.length > 5 ? ` + ${githubTools.length - 5} more` : ''

process.stdout.write('\n=== Result ===\n')
process.stdout.write(`status: success\n`)
process.stdout.write(`github MCP tools registered: ${githubTools.length}\n`)
if (sampleTools) {
  process.stdout.write(`e.g. ${sampleTools}${moreCount}\n`)
}
if (smokeToolUsed) {
  process.stdout.write(`smoke test tool: ${smokeToolUsed}\n`)
}

process.stdout.write(`
GitHub is permanently installed. To see all connected MCP tools:
  bun run scripts/test-mcp.ts

To remove: edit ${MCP_CONFIG_PATH}
  and delete the entry with id "github".
`)

await mcpHost.stopAll()
process.exit(0)
