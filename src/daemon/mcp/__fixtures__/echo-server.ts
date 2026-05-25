// src/daemon/mcp/__fixtures__/echo-server.ts
// Tiny MCP server fixture used by mcpClient tests. Exposes one tool 'echo'
// that returns whatever was passed in as text.
// Run via: bun run src/daemon/mcp/__fixtures__/echo-server.ts

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const server = new Server(
  { name: 'echo-test', version: '0.0.1' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: 'Echo back the input arguments',
      inputSchema: {
        type: 'object' as const,
        properties: { msg: { type: 'string' } },
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const toolName = req.params.name
  if (toolName !== 'echo') {
    return {
      content: [{ type: 'text' as const, text: `Unknown tool: ${toolName}` }],
      isError: true,
    }
  }
  const args = req.params?.arguments ?? {}
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(args) }],
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)
