// src/daemon/wrapApi/adapters/claudeCodeAdapter.test.ts
import { describe, it, expect } from 'bun:test'
import { ClaudeCodeAdapter } from './claudeCodeAdapter'

describe('ClaudeCodeAdapter', () => {
  it('builds prompt with system + history + new turn', async () => {
    // We can't easily intercept Bun.spawn, so we test buildPrompt indirectly
    // via a subclass that captures the spawn args.
    let capturedArgs: any
    class StubAdapter extends ClaudeCodeAdapter {
      async complete(body: any): Promise<any> {
        const buildPrompt = (this as any).buildPrompt.bind(this)
        const prompt = buildPrompt(body)
        capturedArgs = { prompt, body }
        return { text: 'stub' }
      }
    }
    const adapter = new StubAdapter({ defaultModel: 'haiku' })
    await adapter.complete({
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
        { role: 'user', content: 'what time is it' },
      ],
      system: 'You are KAIROS.',
    })
    expect(capturedArgs.prompt).toContain('You are KAIROS.')
    expect(capturedArgs.prompt).toContain('User: hello')
    expect(capturedArgs.prompt).toContain('You: hi there')
    expect(capturedArgs.prompt).toContain('User just said: "what time is it"')
    expect(capturedArgs.prompt).toContain('Respond directly and conversationally')
  })

  it('normalizes model names', async () => {
    class S extends ClaudeCodeAdapter {
      normalize(m: string) { return (this as any).normalizeModel(m) }
    }
    const a = new S()
    expect(a.normalize('claude-haiku-4-5')).toBe('haiku')
    expect(a.normalize('claude-sonnet-4-6')).toBe('sonnet')
    expect(a.normalize('opus-4-7')).toBe('opus')
    expect(a.normalize('custom-model')).toBe('custom-model')
  })
})
