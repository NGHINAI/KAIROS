// Bespoke MCP server for macOS Reminders. Standalone — runs as a
// stdio child process spawned by KAIROS's McpHost.
//
// Run directly: bun run connectors/macos-reminders/server/index.ts

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { listReminders, addReminder, completeReminder } from './reminders'

const server = new Server(
  { name: 'macos-reminders', version: '0.1.0' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'list_reminders',
      description: 'List incomplete reminders from the default Reminders list',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'add_reminder',
      description: 'Add a new reminder to the default list',
      inputSchema: {
        type: 'object',
        required: ['title'],
        properties: {
          title: { type: 'string' },
          due_iso: { type: 'string', description: 'Optional ISO 8601 due date' },
        },
      },
    },
    {
      name: 'complete_reminder',
      description: 'Mark a reminder as completed by title (first match)',
      inputSchema: {
        type: 'object',
        required: ['title'],
        properties: { title: { type: 'string' } },
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params?.name
  const args = (req.params?.arguments ?? {}) as Record<string, any>
  try {
    if (name === 'list_reminders') {
      const items = await listReminders()
      return { content: [{ type: 'text' as const, text: JSON.stringify(items, null, 2) }] }
    }
    if (name === 'add_reminder') {
      await addReminder(args.title, args.due_iso ?? null)
      return { content: [{ type: 'text' as const, text: `Added: ${args.title}` }] }
    }
    if (name === 'complete_reminder') {
      await completeReminder(args.title)
      return { content: [{ type: 'text' as const, text: `Completed: ${args.title}` }] }
    }
    return { content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }], isError: true }
  } catch (err) {
    return { content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }], isError: true }
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)
