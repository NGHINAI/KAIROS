import { describe, it, expect } from 'bun:test'
import { OAuthCallbackHandler } from './oauthCallbackHandler'

describe('OAuthCallbackHandler', () => {
  it('captures a callback with query params', async () => {
    const handler = new OAuthCallbackHandler()
    const { port, callbackUrl, capturePromise } = await handler.listen({ path: '/oauth-cb', timeout_sec: 5 })

    setTimeout(async () => {
      await fetch(`${callbackUrl}?code=abc123&state=xyz`)
    }, 50)

    const capture = await capturePromise
    expect(capture.query_params.code).toBe('abc123')
    expect(capture.query_params.state).toBe('xyz')
    expect(capture.callback_path).toBe('/oauth-cb')
  })

  it('rejects on timeout', async () => {
    const handler = new OAuthCallbackHandler()
    const { capturePromise } = await handler.listen({ path: '/oauth-cb', timeout_sec: 0.1 })
    await expect(capturePromise).rejects.toThrow(/timeout/i)
  })

  it('returns a unique port per call', async () => {
    const h1 = new OAuthCallbackHandler()
    const h2 = new OAuthCallbackHandler()
    const r1 = await h1.listen({ path: '/cb1', timeout_sec: 1 })
    const r2 = await h2.listen({ path: '/cb2', timeout_sec: 1 })
    expect(r1.port).not.toBe(r2.port)
    await Promise.allSettled([r1.capturePromise, r2.capturePromise])
  })
})
