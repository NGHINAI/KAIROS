// scripts/test-mcp.ts
// Quick interactive test harness for C.2's MCP host runtime.
//
// Loads ~/.kairos/mcp-servers.json, starts enabled servers, lists all
// registered tools, and lets you invoke any tool by qualified id.
// No daemon, no notifications, no risk.
//
// Usage:
//   bun run scripts/test-mcp.ts                        # list connected servers + tools
//   bun run scripts/test-mcp.ts list                   # alias for the default
//   bun run scripts/test-mcp.ts call <qualified_id>    # call tool with empty args
//   bun run scripts/test-mcp.ts call <qualified_id> '<json args>'
//
// Examples:
//   bun run scripts/test-mcp.ts call echo-test::echo '{"msg":"hi"}'
//   bun run scripts/test-mcp.ts call macos-reminders::list_reminders
//   bun run scripts/test-mcp.ts call macos-reminders::add_reminder '{"title":"Test from KAIROS","due_iso":"2026-05-26T12:00:00Z"}'

import { homedir } from 'os'
import { join } from 'path'
import { McpHost } from '../src/daemon/mcp/mcpHost'
import { Keychain } from '../src/daemon/mcp/keychain'

const configPath = join(homedir(), '.kairos', 'mcp-servers.json')
const command = process.argv[2] ?? 'list'

const host = new McpHost({ configPath, keychain: new Keychain() })

console.log(`Loading config from: ${configPath}`)
console.log(`Starting enabled MCP servers...\n`)
await host.startAll()

const servers = host.listServers()
const tools = host.listAllTools()

if (servers.length === 0) {
  console.log('No MCP servers connected.')
  console.log(`\nEdit ${configPath} and set "enabled": true on at least one server, then re-run.`)
  console.log('See README in connectors/macos-reminders/ for an example, OR run a community server like @modelcontextprotocol/server-filesystem.')
  process.exit(0)
}

console.log(`✓ ${servers.length} server(s) connected: ${servers.map(s => s.id).join(', ')}`)
console.log(`✓ ${tools.length} tool(s) registered as agency intents`)

if (command === 'list') {
  console.log('\nAvailable tools (id → tier):')
  for (const t of tools) {
    console.log(`  ${t.qualified_id.padEnd(40)} → ${t.tier}`)
    if (t.description) console.log(`    ${t.description.slice(0, 100)}`)
  }
  console.log(`\nTo call a tool: bun run scripts/test-mcp.ts call <qualified_id> '<json args>'`)
  await host.stopAll()
  process.exit(0)
}

if (command === 'call') {
  const qualifiedId = process.argv[3]
  if (!qualifiedId) {
    console.error('Usage: bun run scripts/test-mcp.ts call <qualified_id> [\'<json args>\']')
    await host.stopAll()
    process.exit(1)
  }
  const tool = tools.find(t => t.qualified_id === qualifiedId)
  if (!tool) {
    console.error(`Unknown tool: ${qualifiedId}`)
    console.error(`Available: ${tools.map(t => t.qualified_id).join(', ')}`)
    await host.stopAll()
    process.exit(1)
  }

  let args: Record<string, unknown> = {}
  if (process.argv[4]) {
    try {
      args = JSON.parse(process.argv[4])
    } catch (err) {
      console.error(`Invalid JSON args: ${err}`)
      await host.stopAll()
      process.exit(1)
    }
  }

  console.log(`\nInvoking ${qualifiedId} (tier ${tool.tier}) with args:`)
  console.log(JSON.stringify(args, null, 2))
  console.log('\n--- Result ---')

  const result = await host.invokeTool(qualifiedId, args)
  if (result.ok) {
    console.log(`✓ Success`)
    if (result.output_text) {
      console.log(`\nOutput:\n${result.output_text}`)
    }
  } else {
    console.log(`✗ Failed: ${result.error}`)
  }

  await host.stopAll()
  process.exit(result.ok ? 0 : 1)
}

console.error(`Unknown command: ${command}. Use 'list' or 'call <qualified_id> [json-args]'.`)
await host.stopAll()
process.exit(1)
