import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SoulWizard } from './soulWizard'

function fakeRouter(soul: any) {
  return {
    complete: async () => ({
      text: JSON.stringify(soul),
      parsed: soul,
      provider: 'openai', model: 'gpt-5-nano',
      cost_cents: 0.01, latency_ms: 200,
      fallback_count: 0, input_tokens: 500, output_tokens: 200,
    }),
  }
}

const ANSWERS = {
  ideal_coworker: 'blunt and efficient',
  communication_priorities: 'never sugarcoat',
  never_do: 'never interrupt during meetings',
  focus_behavior: 'silent unless urgent',
  other_guidance: 'I prefer voice over text',
}

describe('SoulWizard', () => {
  it('composes a SoulFile from 5 answers and writes soul.md', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'kairos-wiz-'))
    const path = join(tmp, 'soul.md')
    const fakeSoul = {
      version: 1,
      core_truths: ['I tell you what is actually happening'],
      boundaries: ['never interrupt during meetings'],
      vibe: 'a blunt, efficient coworker',
      free_body: '',
    }
    const wizard = new SoulWizard({ path, router: fakeRouter(fakeSoul) as any })
    const soul = await wizard.compose(ANSWERS)
    expect(existsSync(path)).toBe(true)
    expect(soul.vibe).toBe('a blunt, efficient coworker')
    rmSync(tmp, { recursive: true })
  })

  it('uses task_type "persona_compose" (cheap tier)', async () => {
    let captured = ''
    const router = {
      complete: async (req: any) => {
        captured = req.task_type
        return { text: '{}', parsed: { version: 1, core_truths: [], boundaries: [], vibe: 'x', free_body: '' },
          provider: 'a', model: 'b', cost_cents: 0, latency_ms: 0, fallback_count: 0, input_tokens: 0, output_tokens: 0 } as any
      },
    }
    const tmp = mkdtempSync(join(tmpdir(), 'kairos-wiz-'))
    const wizard = new SoulWizard({ path: join(tmp, 'soul.md'), router: router as any })
    await wizard.compose(ANSWERS)
    expect(captured).toBe('persona_compose')
    rmSync(tmp, { recursive: true })
  })

  it('the system prompt mentions BASELINE boundaries (LLM told NOT to redundantly include)', async () => {
    let capturedSystem = ''
    const router = {
      complete: async (req: any) => {
        capturedSystem = req.system_blocks?.[0]?.text ?? ''
        return { text: '{}', parsed: { version: 1, core_truths: [], boundaries: [], vibe: 'x', free_body: '' },
          provider: 'a', model: 'b', cost_cents: 0, latency_ms: 0, fallback_count: 0, input_tokens: 0, output_tokens: 0 } as any
      },
    }
    const tmp = mkdtempSync(join(tmpdir(), 'kairos-wiz-'))
    const wizard = new SoulWizard({ path: join(tmp, 'soul.md'), router: router as any })
    await wizard.compose(ANSWERS)
    expect(capturedSystem).toMatch(/BASELINE/i)
    expect(capturedSystem).toMatch(/never delete/i)
    rmSync(tmp, { recursive: true })
  })

  it('writes valid YAML frontmatter that SoulLoader can parse', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'kairos-wiz-'))
    const path = join(tmp, 'soul.md')
    const fakeSoul = {
      version: 1,
      core_truths: ['truth one', 'truth two'],
      boundaries: ['user bound'],
      vibe: 'composed vibe',
      free_body: 'extra notes',
    }
    const wizard = new SoulWizard({ path, router: fakeRouter(fakeSoul) as any })
    await wizard.compose(ANSWERS)
    const { SoulLoader } = require('./soulLoader')
    const loader = new SoulLoader({ path })
    loader.load()
    const soul = loader.getSoul()!
    expect(soul.vibe).toBe('composed vibe')
    expect(soul.core_truths.length).toBe(2)
    rmSync(tmp, { recursive: true })
  })

  it('throws clear error when LLM returns malformed JSON', async () => {
    const router = {
      complete: async () => ({ text: 'not-json', parsed: undefined,
        provider: 'a', model: 'b', cost_cents: 0, latency_ms: 0, fallback_count: 0, input_tokens: 0, output_tokens: 0 } as any),
    }
    const tmp = mkdtempSync(join(tmpdir(), 'kairos-wiz-'))
    const wizard = new SoulWizard({ path: join(tmp, 'soul.md'), router: router as any })
    await expect(wizard.compose(ANSWERS)).rejects.toThrow(/parseable JSON/)
    rmSync(tmp, { recursive: true })
  })
})
