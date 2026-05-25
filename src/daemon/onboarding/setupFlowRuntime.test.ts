// src/daemon/onboarding/setupFlowRuntime.test.ts
import { describe, it, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { SetupFlowRuntime } from './setupFlowRuntime'
import { FlowStateStore } from './flowStateStore'
import type { SetupSkill } from './types'

// ---------------------------------------------------------------------------
// Fake builder
// ---------------------------------------------------------------------------

function makeDeps(overrides: Record<string, unknown> = {}) {
  const calls = {
    speak: [] as string[],
    notifyProgress: [] as { s: number; t: number; l: string }[],
    confirm: [] as { p: string; d?: string }[],
    snapshot: 0,
    restore: 0,
    addServer: [] as unknown[],
    stopAll: 0,
    startAll: 0,
    invokeTool: [] as { q: string; args: unknown }[],
    browserOpens: [] as string[],
    keychainStores: [] as { svc: string; acc: string; val: string }[],
    npmInstalls: [] as string[],
    smitheryInstalls: [] as string[],
  }

  const db = new Database(':memory:')
  const flowStateStore = new FlowStateStore(db)

  const deps = {
    browserOpener: {
      open: async (url: string) => { calls.browserOpens.push(url) },
    },
    clipboardPatternWatcher: {
      waitFor: async (_p: RegExp, _t: number) => 'fake-token-ghp_abc',
    },
    oauthCallbackHandler: {
      listen: async (opts: { path: string; timeout_sec: number }) => ({
        port: 0,
        callbackUrl: 'http://localhost:0/cb',
        capturePromise: Promise.resolve({
          callback_path: opts.path,
          query_params: { code: 'oauth-code-123' },
          raw_url: '',
          captured_at: 0,
        }),
      }),
    },
    mcpAutoInstaller: {
      installViaNpm: async (pkg: string) => { calls.npmInstalls.push(pkg); return { ok: true } },
      installViaSmithery: async (q: string) => { calls.smitheryInstalls.push(q); return { ok: true } },
    },
    mcpConfigMutator: {
      snapshot: () => { calls.snapshot++; return { servers: [] } },
      restore: (_snap: unknown) => { calls.restore++ },
      addServer: (s: unknown) => { calls.addServer.push(s) },
      read: () => ({ servers: [] }),
      write: () => {},
      updateServer: () => {},
      removeServer: () => {},
    },
    flowStateStore,
    keychain: {
      // Real API: set(service, account, value) / get(service, account)
      set: async (svc: string, acc: string, val: string) => { calls.keychainStores.push({ svc, acc, val }) },
      get: async () => null,
    },
    mcpHost: {
      stopAll: async () => { calls.stopAll++ },
      startAll: async () => { calls.startAll++ },
      invokeTool: async (q: string, args: unknown) => { calls.invokeTool.push({ q, args }); return { ok: true, output_text: 'ok' } },
      listAllTools: () => [{ qualified_id: 'fakeserver::list', tier: 'GREEN' }],
      listServers: () => [],
    },
    userChannel: {
      speak: async (t: string) => { calls.speak.push(t) },
      notifyProgress: async (s: number, t: number, l: string) => { calls.notifyProgress.push({ s, t, l }) },
      awaitConfirm: async (p: string, d?: string) => { calls.confirm.push({ p, d }); return true },
      notifyComplete: async () => {},
      notifyFailed: async () => {},
    },
    ...overrides,
  }

  return { deps, calls, flowStateStore }
}

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------

const minimalSkill: SetupSkill = {
  service_name: 'fakeservice',
  service_display_name: 'FakeService',
  auth_type: 'none',
  estimated_minutes: 1,
  steps: [
    { type: 'speak', text: 'starting' },
    { type: 'speak_on_success', text: 'done!' },
    { type: 'speak_on_failure', text: 'failed!' },
  ],
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SetupFlowRuntime', () => {
  it('executes a minimal skill and marks completed', async () => {
    const { deps, calls } = makeDeps()
    const rt = new SetupFlowRuntime(deps as any)
    const result = await rt.run(minimalSkill)
    expect(result.status).toBe('success')
    expect(calls.speak).toContain('starting')
    expect(calls.speak).toContain('done!')
  })

  it('executes open_url + wait_for_clipboard + store_keychain', async () => {
    const skill: SetupSkill = {
      service_name: 'gh',
      service_display_name: 'GH',
      auth_type: 'pat',
      estimated_minutes: 1,
      steps: [
        { type: 'open_url', url: 'https://github.com/settings/tokens/new' },
        { type: 'wait_for_clipboard', pattern: '^ghp_', description: 'token', timeout_sec: 5 },
        { type: 'store_keychain', service: 'com.kairos.gh', account: 'token', source: 'clipboard' },
        { type: 'speak_on_success', text: 'ok' },
        { type: 'speak_on_failure', text: 'err' },
      ],
    }
    const { deps, calls } = makeDeps()
    const rt = new SetupFlowRuntime(deps as any)
    const result = await rt.run(skill)
    expect(result.status).toBe('success')
    expect(calls.browserOpens[0]).toBe('https://github.com/settings/tokens/new')
    expect(calls.keychainStores[0]).toEqual({ svc: 'com.kairos.gh', acc: 'token', val: 'fake-token-ghp_abc' })
  })

  it('install_mcp_server failure triggers rollback', async () => {
    const { deps, calls } = makeDeps({
      mcpAutoInstaller: {
        installViaNpm: async () => ({ ok: false, error: 'EACCES' }),
        installViaSmithery: async () => ({ ok: false, error: 'unreachable' }),
      },
    })
    const skill: SetupSkill = {
      service_name: 's',
      service_display_name: 'S',
      auth_type: 'none',
      estimated_minutes: 1,
      steps: [
        { type: 'install_mcp_server', via: 'npm', package: 'bogus' },
        { type: 'speak_on_success', text: 'ok' },
        { type: 'speak_on_failure', text: 'err' },
      ],
    }
    const rt = new SetupFlowRuntime(deps as any)
    const result = await rt.run(skill)
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/EACCES|install failed/)
    expect(calls.restore).toBeGreaterThanOrEqual(1)
  })

  it('configure_mcp_server reloads McpHost', async () => {
    const { deps, calls } = makeDeps()
    const skill: SetupSkill = {
      service_name: 's',
      service_display_name: 'S',
      auth_type: 'none',
      estimated_minutes: 1,
      steps: [
        {
          type: 'configure_mcp_server',
          server_config: { id: 'fakeserver', enabled: true, transport: 'stdio', tier_policy: { default: 'GREEN' } },
        },
        { type: 'speak_on_success', text: 'ok' },
        { type: 'speak_on_failure', text: 'err' },
      ],
    }
    const rt = new SetupFlowRuntime(deps as any)
    await rt.run(skill)
    expect(calls.addServer.length).toBe(1)
    expect(calls.stopAll).toBeGreaterThanOrEqual(1)
    expect(calls.startAll).toBeGreaterThanOrEqual(1)
  })

  it('smoke_test_tool failure aborts the flow', async () => {
    const { deps } = makeDeps({
      mcpHost: {
        stopAll: async () => {},
        startAll: async () => {},
        invokeTool: async () => ({ ok: false, error: 'tool not found' }),
        listAllTools: () => [],
        listServers: () => [],
      },
    })
    const skill: SetupSkill = {
      service_name: 's',
      service_display_name: 'S',
      auth_type: 'none',
      estimated_minutes: 1,
      steps: [
        { type: 'smoke_test_tool', qualified_id: 'fakeserver::list' },
        { type: 'speak_on_success', text: 'ok' },
        { type: 'speak_on_failure', text: 'err' },
      ],
    }
    const rt = new SetupFlowRuntime(deps as any)
    const result = await rt.run(skill)
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/smoke test failed|tool not found/i)
  })

  it('await_user_confirm=false marks cancelled and rolls back', async () => {
    const { deps, calls } = makeDeps({
      userChannel: {
        speak: async () => {},
        notifyProgress: async () => {},
        awaitConfirm: async () => false,
        notifyComplete: async () => {},
        notifyFailed: async () => {},
      },
    })
    const skill: SetupSkill = {
      service_name: 's',
      service_display_name: 'S',
      auth_type: 'none',
      estimated_minutes: 1,
      steps: [
        { type: 'await_user_confirm', prompt: 'ok?' },
        { type: 'speak_on_success', text: 'ok' },
        { type: 'speak_on_failure', text: 'err' },
      ],
    }
    const rt = new SetupFlowRuntime(deps as any)
    const result = await rt.run(skill)
    expect(result.status).toBe('cancelled')
    expect(calls.restore).toBeGreaterThanOrEqual(1)
  })

  it('persists step progress in FlowStateStore', async () => {
    const { deps, flowStateStore } = makeDeps()
    const rt = new SetupFlowRuntime(deps as any)
    const result = await rt.run(minimalSkill, 'my-flow-1')
    const stored = flowStateStore.get('my-flow-1')
    expect(stored?.status).toBe('completed')
    expect(stored?.current_step_index).toBe(3)
    expect(result.flow_id).toBe('my-flow-1')
  })
})
