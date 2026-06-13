// codexHome.test.ts — A0: the isolated CODEX_HOME + config.toml generator + the
// vendored-binary locator + arch-dispatch shim. Pure logic, no key, no network.
// Guards the architecture decisions that live IN the generated config:
//   wire_api=responses · workspace-write default (NOT danger-full-access) ·
//   HTTP MCP (url+bearer_token_env_var) · pre-trusted project · NO [profiles.*]
//   per-profile effort · TOML-injection-safe escaping (openclicky R8 fix).
import { describe, expect, test } from "bun:test"
import { mkdtempSync, existsSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  archTriple, archDispatchShim, resolveCodexBinary, tomlEscape,
  generateConfigToml, ensureCodexHome,
} from "./codexHome"

describe("archTriple", () => {
  test("maps macOS arches; throws on the unsupported", () => {
    expect(archTriple("arm64")).toBe("aarch64-apple-darwin")
    expect(archTriple("x64")).toBe("x86_64-apple-darwin")
    expect(() => archTriple("ia32")).toThrow()
  })
})

describe("archDispatchShim", () => {
  test("is a POSIX-sh shim that arch-dispatches into the vendored runtime", () => {
    const s = archDispatchShim()
    expect(s.startsWith("#!/bin/sh")).toBe(true)
    expect(s).toContain("aarch64-apple-darwin")
    expect(s).toContain("x86_64-apple-darwin")
    expect(s).toContain('uname -m')
    expect(s).toContain('vendor/')            // execs the per-arch vendored codex
    expect(s).toContain('"$@"')               // forwards args
  })
})

describe("resolveCodexBinary", () => {
  const exists = (set: string[]) => (p: string) => set.includes(p)
  test("env override wins when it exists", () => {
    const r = resolveCodexBinary({ override: "/custom/codex", vendored: "/v/codex", homebrew: "/opt/homebrew/bin/codex", exists: exists(["/custom/codex", "/v/codex", "/opt/homebrew/bin/codex"]) })
    expect(r).toBe("/custom/codex")
  })
  test("vendored (ship) beats homebrew (dev) when present", () => {
    const r = resolveCodexBinary({ vendored: "/v/codex", homebrew: "/opt/homebrew/bin/codex", exists: exists(["/v/codex", "/opt/homebrew/bin/codex"]) })
    expect(r).toBe("/v/codex")
  })
  test("falls back to homebrew in dev when nothing vendored", () => {
    const r = resolveCodexBinary({ vendored: "/v/codex", homebrew: "/opt/homebrew/bin/codex", exists: exists(["/opt/homebrew/bin/codex"]) })
    expect(r).toBe("/opt/homebrew/bin/codex")
  })
  test("throws when no codex can be found", () => {
    expect(() => resolveCodexBinary({ vendored: "/v/codex", homebrew: "/h/codex", exists: exists([]) })).toThrow()
  })
})

describe("tomlEscape (R8 injection fix — escape control chars + quotes + backslash)", () => {
  test("escapes the dangerous set so a value can't break out of its string", () => {
    expect(tomlEscape('plain')).toBe('plain')
    expect(tomlEscape('a"b')).toBe('a\\"b')
    expect(tomlEscape('a\\b')).toBe('a\\\\b')
    expect(tomlEscape('a\nb')).toBe('a\\nb')
    expect(tomlEscape('a\rb')).toBe('a\\rb')
    expect(tomlEscape('a\tb')).toBe('a\\tb')
    // an injection attempt cannot introduce a real newline + new key
    expect(tomlEscape('x"\nmalicious = "y')).not.toContain("\n")
  })
})

describe("generateConfigToml", () => {
  const cfg = generateConfigToml({
    workspaceDir: "/Users/x/state/codex/workspace",
    baseUrl: "http://127.0.0.1:8788/v1",
    brainKeyEnv: "KAIROS_BRAIN_KEY",
    modelAlias: "kairos-smart",
    mcpUrl: "http://127.0.0.1:9876/mcp",
    mcpTokenEnv: "KAIROS_MCP_TOKEN",
  })

  test("declares the hidden provider speaking the Responses API", () => {
    expect(cfg).toContain('model_provider = "kairos"')
    expect(cfg).toContain("[model_providers.kairos]")
    expect(cfg).toContain('base_url = "http://127.0.0.1:8788/v1"')
    expect(cfg).toContain('env_key = "KAIROS_BRAIN_KEY"')
    expect(cfg).toContain('wire_api = "responses"')   // 0.133 rejects "chat"
    expect(cfg).toContain('model = "kairos-smart"')   // alias; proxy maps to MiniMax
  })

  test("registers the in-process MCP server over HTTP with a bearer token", () => {
    expect(cfg).toContain("[mcp_servers.kairos]")
    expect(cfg).toContain('url = "http://127.0.0.1:9876/mcp"')
    expect(cfg).toContain('bearer_token_env_var = "KAIROS_MCP_TOKEN"')
  })

  test("pre-trusts the workspace + suppresses the full-access warning", () => {
    expect(cfg).toContain('[projects."/Users/x/state/codex/workspace"]')
    expect(cfg).toContain('trust_level = "trusted"')
    expect(cfg).toContain("hide_full_access_warning = true")
    expect(cfg).toContain('history.persistence = "save-all"')
  })

  test("DEFAULTS to workspace-write — NEVER danger-full-access (14 §B7)", () => {
    expect(cfg).toContain('sandbox_mode = "workspace-write"')
    expect(cfg).not.toContain("danger-full-access")
  })

  test("does NOT use [profiles.*] for effort — effort is per-turn (14 §A)", () => {
    expect(cfg).not.toContain("[profiles.")
  })

  test("is injection-safe: a hostile workspace path can't inject TOML keys", () => {
    const evil = generateConfigToml({
      workspaceDir: '/tmp/x"]\nmalicious_key = "pwned',
      baseUrl: "http://127.0.0.1:8788/v1", brainKeyEnv: "KAIROS_BRAIN_KEY",
      modelAlias: "kairos-smart", mcpUrl: "http://127.0.0.1:9876/mcp", mcpTokenEnv: "KAIROS_MCP_TOKEN",
    })
    // The string may appear as ESCAPED data inside the quoted path; what must NOT
    // exist is an ACTIVE key — a real newline followed by `malicious_key =`.
    expect(evil).not.toMatch(/\nmalicious_key\s*=/)
    expect(evil).not.toContain('"pwned"\n')   // the closing quote never lands on a real line
  })
})

describe("ensureCodexHome (filesystem, temp dir)", () => {
  test("creates an isolated home + git workspace + locked-down config.toml", async () => {
    const root = mkdtempSync(join(tmpdir(), "kairos-codexhome-"))
    const r = await ensureCodexHome({
      root, baseUrl: "http://127.0.0.1:8788/v1", brainKeyEnv: "KAIROS_BRAIN_KEY",
      modelAlias: "kairos-smart", mcpUrl: "http://127.0.0.1:9876/mcp", mcpTokenEnv: "KAIROS_MCP_TOKEN",
    })
    expect(existsSync(r.configPath)).toBe(true)
    expect(existsSync(join(r.workspace, ".git"))).toBe(true)          // git init'd (codex needs a repo)
    expect(readFileSync(r.configPath, "utf8")).toContain('wire_api = "responses"')
    // config.toml is chmod 600 (bearer/provider config not world-readable)
    expect(statSync(r.configPath).mode & 0o077).toBe(0)
    // home dir is 700
    expect(statSync(r.home).mode & 0o077).toBe(0)
    // NEVER the user's real ~/.codex
    expect(r.home).toContain(root)
    expect(r.home).not.toContain("/.codex")
  })

  test("idempotent across daemon restarts — regenerating doesn't throw or corrupt", async () => {
    const root = mkdtempSync(join(tmpdir(), "kairos-codexhome-re-"))
    const o = { root, baseUrl: "http://127.0.0.1:8788/v1", brainKeyEnv: "KAIROS_BRAIN_KEY", modelAlias: "kairos-smart", mcpUrl: "http://127.0.0.1:9876/mcp", mcpTokenEnv: "KAIROS_MCP_TOKEN" }
    const a = await ensureCodexHome(o)
    const b = await ensureCodexHome(o)            // second boot — must be safe
    expect(b.configPath).toBe(a.configPath)
    expect(existsSync(join(b.workspace, ".git"))).toBe(true)   // git init not re-run destructively
    expect(readFileSync(b.configPath, "utf8")).toContain('wire_api = "responses"')
    expect(statSync(b.configPath).mode & 0o077).toBe(0)        // still locked down
  })
})
