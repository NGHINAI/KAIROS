#!/usr/bin/env bun
//
// KAIROS MCP shim. Runs as a stdio child of Claude Code.
// Spawns the daemon if not running, then forwards every tool call via HTTP.
//
// Claude Code starts this process via its mcpServers config.
// It communicates with Claude Code over stdin/stdout using MCP protocol.
// It communicates with the KAIROS daemon over HTTP on localhost.

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { ensureDaemonRunning, registerSession, unregisterSession } from './lifecycle'
import { TOOL_DEFINITIONS } from './tools'

const SHIM_VERSION = '0.1.0'

// CRITICAL: Prevent recursive MCP loading.
// When KAIROS spawns `claude -p` subprocesses, those subprocesses also load
// ~/.claude.json, which includes the KAIROS MCP server, which would spawn
// ANOTHER shim → another session → another tick → infinite recursion.
// This env var breaks the cycle.
if (process.env.KAIROS_SUBPROCESS === '1') {
  // We're inside a KAIROS-spawned subprocess. Don't start the MCP server.
  // Just exit silently — claude -p will proceed without KAIROS tools.
  process.exit(0)
}

async function main(): Promise<void> {
  const sandboxDir = process.env.KAIROS_SANDBOX_DIR ?? process.cwd()

  // 1. Ensure daemon is running (spawn if needed)
  let port: number
  try {
    port = await ensureDaemonRunning(sandboxDir)
  } catch (err) {
    process.stderr.write(`KAIROS shim: failed to start daemon: ${err}\n`)
    process.exit(1)
  }

  // 2. Register this session with the daemon
  let sessionId: string
  try {
    sessionId = await registerSession(port, {
      pid: process.pid,
      cwd: process.cwd(),
    })
  } catch (err) {
    process.stderr.write(`KAIROS shim: failed to register: ${err}\n`)
    process.exit(1)
  }

  process.stderr.write(
    `KAIROS shim: connected to daemon on port ${port}, session ${sessionId.slice(0, 8)}...\n`,
  )

  // 3. Create the MCP server
  const server = new Server(
    { name: 'kairos', version: SHIM_VERSION },
    { capabilities: { tools: {} } },
  )

  // 4. Register tool listing
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }))

  // 5. Handle tool calls — forward everything to daemon
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params

    try {
      const response = await fetch(`http://127.0.0.1:${port}/tool/${name}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(args ?? {}),
          session_id: sessionId,
          session_cwd: process.cwd(),
        }),
        signal: AbortSignal.timeout(30_000),
      })

      if (!response.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `KAIROS error: daemon returned HTTP ${response.status}`,
            },
          ],
          isError: true,
        }
      }

      const data = await response.json()
      const text = formatEnvelopeForClaude(data as Record<string, unknown>)

      return {
        content: [{ type: 'text' as const, text }],
      }
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `KAIROS error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      }
    }
  })

  // 6. Connect to Claude Code via stdio
  const transport = new StdioServerTransport()
  await server.connect(transport)

  // 7. Clean shutdown — unregister from daemon
  const cleanup = async () => {
    try {
      await unregisterSession(port, sessionId)
    } catch { /* best effort */ }
    process.exit(0)
  }

  process.on('SIGTERM', cleanup)
  process.on('SIGINT', cleanup)
  process.on('SIGHUP', cleanup)

  // If stdin closes (Claude Code exits), also clean up
  process.stdin.on('end', cleanup)
}

/**
 * Format the daemon's envelope response into human-readable text for Claude.
 * Includes piggy-backed state + pending messages + the tool result.
 */
function formatEnvelopeForClaude(data: Record<string, unknown>): string {
  const parts: string[] = []

  // Current state header
  const state = data._kairos_state as Record<string, unknown> | undefined
  if (state) {
    parts.push(
      `[KAIROS: ${state.queue_depth ?? 0} queued, ${state.running_count ?? 0} running, ${state.tick_count ?? 0} ticks, ${state.connected_clients ?? 0} clients]`,
    )
  }

  // Pending proactive messages
  const pending = data._kairos_pending as Array<Record<string, unknown>> | undefined
  if (pending && pending.length > 0) {
    parts.push('')
    parts.push('## Messages from KAIROS')
    parts.push('')
    for (const msg of pending) {
      const ts = msg.created_at
        ? new Date(msg.created_at as number).toLocaleTimeString()
        : '?'
      parts.push(`**${ts}** [${msg.kind}]: ${msg.body}`)
    }
    parts.push('')
    parts.push('---')
  }

  // The actual tool result
  parts.push('')
  parts.push(JSON.stringify(data.result, null, 2))

  return parts.join('\n')
}

main().catch((err) => {
  process.stderr.write(`KAIROS shim: fatal error: ${err}\n`)
  process.exit(1)
})
