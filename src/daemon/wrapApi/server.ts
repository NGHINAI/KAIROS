// src/daemon/wrapApi/server.ts
// In-process Bun HTTP server hosting /v1/* — the "Cloud-shaped local API."
// Migration to api.kairos.ai later = config flip on the daemon's base URL.
//
// Now also exposes a WebSocket at /v1/voice/events for Electron (or any UI
// client) to subscribe to live voice events and send commands.

import type { ServerWebSocket } from 'bun'

export type WrapApiAdapters = {
  llm:      { complete: (body: any) => Promise<any> }
  voice:    { chat: (body: any) => Promise<any>; cancel?: () => Promise<void> }
  memory:   { append: (body: any) => Promise<any>; get: (body: any) => Promise<any> }
  orders:   { add: (body: any) => Promise<any>; list: () => Promise<any>; disable?: (slug: string) => Promise<any> }
  composio: { listConnections: () => Promise<any>; connect: (body: any) => Promise<any>; disconnect: (body: any) => Promise<any> }
  settings: { get: () => Promise<any>; update: (body: any) => Promise<any> }
}

export type WrapApiOpts = {
  port?: number
  hostname?: string
  adapters: WrapApiAdapters
  /** Optional handler for the Codex-facing MCP endpoint (/mcp). Wired to the
   *  in-process KAIROS MCP server (codex/mcpServer.ts). It does its OWN bearer
   *  auth, so it's safe to mount on the same loopback server as the (currently
   *  tokenless) /v1 + WS paths without breaking the HUD/Electron clients. */
  mcpHandler?: (req: Request) => Promise<Response>
}

export type WrapApiServer = {
  port: number
  baseUrl: string
  /** Push a JSON event to every connected /v1/voice/events client. */
  broadcast: (event: Record<string, any>) => void
  /** Register a handler invoked for each command (JSON message) from any client. */
  onCommand: (cb: (cmd: any) => void) => void
  /** Number of currently connected WebSocket clients. */
  clientCount: () => number
  stop(): Promise<void>
}

export async function startWrapApi(opts: WrapApiOpts): Promise<WrapApiServer> {
  const hostname = opts.hostname ?? '127.0.0.1'
  const a = opts.adapters

  const wsClients = new Set<ServerWebSocket<unknown>>()
  const commandHandlers: ((cmd: any) => void)[] = []

  const wrap = (handler: (req: Request) => Promise<Response>) => async (req: Request) => {
    try {
      return await handler(req)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return Response.json({ error: msg }, { status: 500 })
    }
  }

  const post = (handler: (body: any) => Promise<any>) =>
    wrap(async (req: Request) => {
      if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
      const ct = req.headers.get('content-type') ?? ''
      if (!ct.includes('application/json')) return new Response('Unsupported Media Type', { status: 415 })
      const body = await req.json()
      return Response.json(await handler(body))
    })

  const get = (handler: () => Promise<any>) =>
    wrap(async (req: Request) => {
      if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })
      return Response.json(await handler())
    })

  const server = Bun.serve({
    hostname, port: opts.port ?? 0,
    routes: {
      '/v1/health':               () => new Response('ok'),
      '/v1/llm/complete':         post(a.llm.complete.bind(a.llm)),
      '/v1/voice/chat':           post(a.voice.chat.bind(a.voice)),
      '/v1/voice/cancel':         post(async () => { await a.voice.cancel?.(); return { cancelled: true } }),
      '/v1/memory/append':        post(a.memory.append.bind(a.memory)),
      '/v1/memory/get':           post(a.memory.get.bind(a.memory)),
      '/v1/orders/add':           post(a.orders.add.bind(a.orders)),
      '/v1/orders/list':          get(a.orders.list.bind(a.orders)),
      '/v1/orders/disable':       post(async (b: { slug: string }) => (await a.orders.disable?.(b.slug)) ?? {}),
      '/v1/composio/connections': get(a.composio.listConnections.bind(a.composio)),
      '/v1/composio/connect':     post(a.composio.connect.bind(a.composio)),
      '/v1/composio/disconnect':  post(a.composio.disconnect.bind(a.composio)),
      '/v1/settings/get':         get(a.settings.get.bind(a.settings)),
      '/v1/settings/update':      post(a.settings.update.bind(a.settings)),
    },
    fetch(req, srv) {
      // Voice events WebSocket — Bun upgrades on this path.
      const url = new URL(req.url)
      if (url.pathname === '/v1/voice/events') {
        if (srv.upgrade(req)) return
        return new Response('Upgrade failed', { status: 426 })
      }
      // Codex-facing MCP endpoint — the in-process KAIROS tool server. All methods
      // (POST initialize/list/call, GET SSE, DELETE close) flow through; bearer
      // auth is enforced inside the handler.
      if (url.pathname === '/mcp') {
        if (opts.mcpHandler) return opts.mcpHandler(req)
        return new Response('MCP not enabled', { status: 503 })
      }
      return new Response('Not Found', { status: 404 })
    },
    websocket: {
      // Bun closes clients that SEND nothing for idleTimeout seconds (default 120!).
      // The HUD is almost receive-only — it kept getting silently dropped (half-open:
      // URLSessionWebSocketTask never notices without traffic), so guide_requests
      // vanished into the void. Max out the window; the HUD also keepalives now.
      idleTimeout: 960,
      open(ws) {
        wsClients.add(ws)
        ws.send(JSON.stringify({ event: 'subscribed', clients: wsClients.size }))
      },
      close(ws) {
        wsClients.delete(ws)
      },
      message(ws, raw) {
        const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw)
        try {
          const cmd = JSON.parse(text)
          // Per-socket keepalive ACK: gives receive-only clients (the HUD) a
          // guaranteed inbound message every ~20s — their staleness watchdog can
          // then detect zombie handshakes/half-open sockets and reconnect.
          if (cmd?.cmd === 'hud_keepalive') {
            try { ws.send('{"event":"keepalive_ack"}') } catch { /* */ }
            return
          }
          for (const h of commandHandlers) h(cmd)
        } catch {
          // ignore malformed
        }
      },
    },
  })

  const port = server.port ?? 0
  return {
    port,
    baseUrl: `http://${hostname}:${port}`,
    broadcast(event) {
      const line = JSON.stringify(event)
      for (const ws of wsClients) {
        try {
          // Bun returns -1 on backpressure-drop and 0 on a closed socket — a silent
          // SKIP, not an exception. Guide requests vanished this way (the HUD stayed
          // TCP-connected, its inbound keepalives kept arriving, but it never got
          // another broadcast). Log every non-positive send so a one-way zombie is
          // visible in minutes, not nights.
          const r = ws.send(line)
          if (typeof r === "number" && r <= 0) {
            console.log(`[wrapApi] broadcast ${String((event as any).event ?? "?")} send=${r} (dropped for one client)`)
          }
        } catch {
          console.log(`[wrapApi] broadcast ${String((event as any).event ?? "?")} threw — evicting client`)
          wsClients.delete(ws)
        }
      }
    },
    onCommand(cb) { commandHandlers.push(cb) },
    clientCount() { return wsClients.size },
    stop: async () => { server.stop() },
  }
}
