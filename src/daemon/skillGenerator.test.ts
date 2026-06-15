// skillGenerator.test.ts — skill code-gen runs on the injected OpenRouter completer,
// NOT `claude -p`. We stop at the shebang guard (before any file staging) to prove
// the completer is called and its ===MANIFEST===/===SCRIPT=== output is parsed.
import { describe, expect, test } from "bun:test"
import { SkillGenerator } from "./skillGenerator"
import type { Config } from "./types"

const cfg = { sandboxDir: process.cwd(), models: { tick: "a", work: "minimax/minimax-m3", dream: "c" } } as unknown as Config
const registryStub = { loadSkills() {} } as any

describe("SkillGenerator code-gen via injected completer (no claude)", () => {
  test("calls the completer and parses the manifest/script markers", async () => {
    let asked = ""
    const llm = {
      complete: async (b: any) => {
        asked = b.messages?.[0]?.content ?? ""
        // Valid manifest, but a script without a shebang → early return BEFORE staging.
        return { text: '===MANIFEST===\n{"name":"demo","description":"d","command":"./demo.sh"}\n===SCRIPT===\necho no shebang\n===END===' }
      },
    }
    const gen = new SkillGenerator(cfg, registryStub, llm)

    const res = await gen.generateSkill({ description: "make a demo skill" })

    expect(asked).toContain("make a demo skill")
    expect(res.ok).toBe(false)
    expect(res.error).toContain("shebang") // got past manifest parse to the script check
  })
})
