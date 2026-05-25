// src/daemon/onboarding/setupFlowRuntime.ts
// Orchestrates a SetupSkill end-to-end: persists progress to FlowStateStore,
// rolls back mcp-servers.json config if any step fails midway.

import type { BrowserOpener } from './browserOpener'
import type { ClipboardPatternWatcher } from './clipboardPatternWatcher'
import type { OAuthCallbackHandler } from './oauthCallbackHandler'
import type { McpAutoInstaller } from './mcpAutoInstaller'
import type { McpConfigMutator } from './mcpConfigMutator'
import type { FlowStateStore } from './flowStateStore'
import type { Keychain } from '../mcp/keychain'
import type { McpHost } from '../mcp/mcpHost'
import type { SetupSkill, SetupFlowResult, UserChannel } from './types'
import type { McpServerConfig } from '../mcp/types'

export type SetupFlowRuntimeDeps = {
  browserOpener: BrowserOpener
  clipboardPatternWatcher: ClipboardPatternWatcher
  oauthCallbackHandler: OAuthCallbackHandler
  mcpAutoInstaller: McpAutoInstaller
  mcpConfigMutator: McpConfigMutator
  flowStateStore: FlowStateStore
  keychain: Keychain
  mcpHost: McpHost
  userChannel: UserChannel
}

export class SetupFlowRuntime {
  constructor(private deps: SetupFlowRuntimeDeps) {}

  async run(skill: SetupSkill, flowId?: string): Promise<SetupFlowResult> {
    const {
      browserOpener,
      clipboardPatternWatcher,
      oauthCallbackHandler,
      mcpAutoInstaller,
      mcpConfigMutator,
      flowStateStore,
      keychain,
      mcpHost,
      userChannel,
    } = this.deps

    const flow_id = flowId ?? crypto.randomUUID()
    const startedAt = Date.now()

    // Create initial flow state
    flowStateStore.create({
      flow_id,
      service_name: skill.service_name,
      current_step_index: 0,
      started_at: startedAt,
      status: 'executing',
      collected_data: {},
    })

    // Snapshot config before any mutations (used for rollback)
    const snapshot = mcpConfigMutator.snapshot()

    const collectedData: Record<string, unknown> = {}
    let steps_completed = 0
    let installed_server_id: string | undefined

    const findStepText = (type: 'speak_on_success' | 'speak_on_failure'): string | undefined => {
      const step = skill.steps.find(s => s.type === type)
      return step && 'text' in step ? step.text : undefined
    }

    const doRollback = async () => {
      try {
        mcpConfigMutator.restore(snapshot)
      } catch {
        // best-effort
      }
      try {
        await mcpHost.stopAll()
        await mcpHost.startAll()
      } catch {
        // best-effort
      }
    }

    try {
      for (let i = 0; i < skill.steps.length; i++) {
        const step = skill.steps[i]!
        const stepLabel = step.type === 'speak' ? step.text.slice(0, 40) : step.type

        switch (step.type) {
          case 'speak':
            await userChannel.speak(step.text)
            break

          case 'open_url':
            await browserOpener.open(step.url)
            break

          case 'wait_for_clipboard': {
            const pat = new RegExp(step.pattern)
            const matched = await clipboardPatternWatcher.waitFor(pat, (step.timeout_sec ?? 300) * 1000)
            collectedData.last_clipboard = matched
            flowStateStore.setCollectedData(flow_id, { last_clipboard: matched })
            break
          }

          case 'wait_for_oauth_callback': {
            const { capturePromise } = await oauthCallbackHandler.listen({
              path: step.callback_path,
              timeout_sec: step.timeout_sec ?? 300,
            })
            const capture = await capturePromise
            if (!capture.query_params[step.expected_param]) {
              throw new Error(`expected param '${step.expected_param}' not in callback`)
            }
            collectedData.last_oauth = capture.query_params
            flowStateStore.setCollectedData(flow_id, { last_oauth: capture.query_params })
            break
          }

          case 'store_keychain': {
            let value: string
            if (step.source === 'clipboard') {
              value = collectedData.last_clipboard as string
            } else if (step.source === 'oauth') {
              // Store JSON string of the entire query_params collected from last oauth step
              value = JSON.stringify(collectedData.last_oauth ?? {})
            } else {
              // literal
              value = step.literal_value ?? ''
            }
            await keychain.set(step.service, step.account, value)
            break
          }

          case 'install_mcp_server': {
            let result
            if (step.via === 'npm') {
              result = await mcpAutoInstaller.installViaNpm(step.package)
            } else {
              result = await mcpAutoInstaller.installViaSmithery(step.package)
            }
            if (!result.ok) {
              throw new Error(`install failed: ${result.error}`)
            }
            break
          }

          case 'configure_mcp_server': {
            const cfg = step.server_config as McpServerConfig
            mcpConfigMutator.addServer(cfg)
            await mcpHost.stopAll()
            await mcpHost.startAll()
            installed_server_id = cfg.id
            break
          }

          case 'smoke_test_tool': {
            const result = await mcpHost.invokeTool(step.qualified_id, step.args ?? {})
            if (step.expect_ok !== false && !result.ok) {
              throw new Error(`smoke test failed: ${result.error}`)
            }
            break
          }

          case 'await_user_confirm': {
            const ok = await userChannel.awaitConfirm(step.prompt, step.default_choice)
            if (!ok) {
              flowStateStore.markCancelled(flow_id)
              await doRollback()
              return {
                flow_id,
                service_name: skill.service_name,
                status: 'cancelled',
                duration_ms: Date.now() - startedAt,
                steps_completed,
                steps_total: skill.steps.length,
              }
            }
            break
          }

          case 'speak_on_success':
          case 'speak_on_failure':
            // No-op during iteration; spoken at the end based on outcome
            break
        }

        steps_completed++
        flowStateStore.updateStepIndex(flow_id, i + 1)
        await userChannel.notifyProgress(i + 1, skill.steps.length, stepLabel)
      }

      // Success path
      flowStateStore.markCompleted(flow_id)

      const successText = findStepText('speak_on_success')
      if (successText) {
        await userChannel.speak(successText)
      }

      // Collect registered tools for the installed server
      const allTools = mcpHost.listAllTools()
      const registered_tools = installed_server_id
        ? allTools
            .filter(t => t.qualified_id.startsWith(`${installed_server_id}::`))
            .map(t => t.qualified_id)
        : allTools.map(t => t.qualified_id)

      await userChannel.notifyComplete(
        skill.service_display_name,
        `Setup complete. ${registered_tools.length} tool(s) registered.`,
      )

      return {
        flow_id,
        service_name: skill.service_name,
        status: 'success',
        duration_ms: Date.now() - startedAt,
        steps_completed,
        steps_total: skill.steps.length,
        installed_server_id,
        registered_tools,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)

      // Rollback config (best-effort, nested try/catch)
      await doRollback()

      flowStateStore.markFailed(flow_id, message)

      const failureText = findStepText('speak_on_failure')
      if (failureText) {
        try { await userChannel.speak(failureText) } catch { /* best-effort */ }
      }

      await userChannel.notifyFailed(skill.service_display_name, message)

      return {
        flow_id,
        service_name: skill.service_name,
        status: 'failed',
        duration_ms: Date.now() - startedAt,
        steps_completed,
        steps_total: skill.steps.length,
        error: message,
      }
    }
  }
}
