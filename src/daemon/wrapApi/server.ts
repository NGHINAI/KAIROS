// src/daemon/wrapApi/server.ts
// In-process Bun HTTP server hosting /v1/* — the "Cloud-shaped local API."
// Migration to api.kairos.ai later = config flip on the daemon's base URL.

import type { Server } from 'bun'

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
}

export type WrapApiServer = { port: number; baseUrl: string; stop(): Promise<void> }

export async function startWrapApi(opts: WrapApiOpts): Promise<WrapApiServer> {
  const hostname = opts.hostname ?? '127.0.0.1'
  const a = opts.adapters

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

  const server: Server = Bun.serve({
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
    fetch() { return new Response('Not Found', { status: 404 }) },
  })

  return {
    port: server.port,
    baseUrl: `http://${hostname}:${server.port}`,
    stop: async () => { server.stop() },
  }
}
