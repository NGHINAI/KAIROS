// src/daemon/onboarding/oauthCallbackHandler.ts
// Spawns a temporary Bun.serve to capture an OAuth redirect.
// Returns the listening URL + a promise that resolves with the query params.

import type { OAuthCapture } from './types'

export type ListenOptions = {
  path: string
  timeout_sec: number
}

export type ListenResult = {
  port: number
  callbackUrl: string
  capturePromise: Promise<OAuthCapture>
}

export class OAuthCallbackHandler {
  async listen(opts: ListenOptions): Promise<ListenResult> {
    let server!: ReturnType<typeof Bun.serve>
    const capturePromise: Promise<OAuthCapture> = new Promise((resolve, reject) => {
      const timeoutMs = (opts.timeout_sec ?? 300) * 1000
      const timer = setTimeout(() => {
        try { server?.stop() } catch { /* ignore */ }
        reject(new Error(`OAuthCallbackHandler: timeout after ${opts.timeout_sec}s waiting for callback at ${opts.path}`))
      }, timeoutMs)

      server = Bun.serve({
        port: 0 as any,
        fetch: async (req) => {
          const url = new URL(req.url)
          if (url.pathname !== opts.path) {
            return new Response('Not found', { status: 404 })
          }
          const params: Record<string, string> = {}
          for (const [k, v] of url.searchParams) params[k] = v
          clearTimeout(timer)
          setTimeout(() => {
            try { server.stop() } catch { /* ignore */ }
            resolve({
              callback_path: opts.path,
              query_params: params,
              raw_url: req.url,
              captured_at: Date.now(),
            })
          }, 0)
          return new Response(
            '<html><body style="font-family:system-ui;padding:40px;text-align:center"><h2>Authorized ✓</h2><p>You can close this tab and return to KAIROS.</p></body></html>',
            { status: 200, headers: { 'Content-Type': 'text/html' } },
          )
        },
      })
    })

    const port = (server as any).port
    return {
      port,
      callbackUrl: `http://localhost:${port}${opts.path}`,
      capturePromise,
    }
  }
}
