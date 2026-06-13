#!/usr/bin/env bun
//
// KAIROS daemon — full system.
//
// The complete always-on autonomous AI assistant daemon.
// Lifecycle: parse args → load config → init DB → start HTTP server →
//            arm tick scheduler → wait for signals.
//
// Run with:   bun run src/daemon/index.ts --sandbox --verbose
// Build:      bash scripts/build.sh
// Binary:     ./bin/kairos-daemon --sandbox --verbose
// Mock mode:  KAIROS_MOCK_DECISIONS=1 bun run src/daemon/index.ts --sandbox

import { parseArgs } from 'util'
import { join } from 'path'
import { loadConfig } from './config'
import * as queries from './db'
import { initDatabase } from './db'
import { initLogger, log, logError } from './logger'
import {
  checkExistingDaemon,
  ensureDirs,
  gracefulShutdown,
  pickPort,
  setupSignalHandlers,
  writePidFile,
  writePortFile,
  writeReadyFlag,
} from './lifecycle'
import { startHttpServer } from './server'
import { Scheduler } from './scheduler'
import { DecisionEngine } from './decisionEngine'
import { TaskRunner } from './taskRunner'
import { MemoryStore } from './memory'
import { Voice } from './voice'
import { bootstrapVoice } from './voice/bootstrap'
import { StreamingSpeaker } from './voice/streamingSpeaker'
import { ConversationMessageStore } from './voice/conversationMessageStore'
import { ActivityStore } from './activity/activityStore'
import { coalesceFragment } from './voice/utteranceCoalesce'
import { startWrapApi, type WrapApiServer } from './wrapApi/server'
import { LLMAdapter } from './wrapApi/adapters/llmAdapter'
import { VoiceAdapter } from './wrapApi/adapters/voiceAdapter'
import { OpenRouterAdapter } from './wrapApi/adapters/openRouterAdapter'
import { TIER_MODELS, type Tier } from './agents/types'
import { buildBackgroundSubsystem } from './agents/loop/backgroundSubsystem'
import { setToolNature } from './agents/loop/verifier'
import { buildBackgroundTools } from './agents/loop/backgroundTools'
import { buildPriorRunsHint, parsePriorRuns } from './agents/loop/priorRuns'
import type { TickEvent } from './types'
import { sendMacNotification, setSandboxDir as setNotifySandboxDir } from './notify'
import { postToDiscord, isDiscordConfigured } from './discord'
import { buildRouter, ModelRouter } from './llm'
import { EventBus } from './proactive/eventBus'
import { StateSnapshot } from './proactive/stateSnapshot'
import { ObserverRegistry } from './proactive/observerRegistry'
import { Narrator } from './proactive/narrator'
import { FocusAppObserver } from './proactive/observers/focusApp'
import { BrowserTabsObserver } from './proactive/observers/browserTabs'
import { ClipboardObserver } from './proactive/observers/clipboard'
import { FileEventsObserver } from './proactive/observers/fileEvents'
import { CalendarLocalObserver } from './proactive/observers/calendarLocal'
import { initMemorySchema } from './memory/schema'
import { Embedder } from './memory/embeddings'
import { WorkingMemory } from './memory/workingMemory'
import { EpisodicMemory } from './memory/episodicMemory'
import { EpisodicStore } from './memory/episodicMemory'
import { voiceTurnObservation } from './memory/voiceObservation'
import { supersedeSpeech } from './voice/drainGrace'
import { SpeakingStateTracker } from './voice/speakingState'
import { SemanticMemory } from './memory/semanticMemory'
import { SemanticStore } from './memory/semanticMemory'
import { LocalEmbedder } from './memory/vector/embedder'
import { VectorIndex } from './memory/vector/vectorIndex'
import { MemoryInjector } from './memory/memoryInjector'
import { homedir } from 'os'
import { Dreamer } from './memory/dreamer'
import { VoiceConsolidator } from './memory/voiceConsolidator'
import { RealtimeFactExtractor } from './memory/realtimeFactExtractor'
import { FactWriter } from './memory/factWriter'
import { PreferenceNudgeDetector } from './persona/preferenceNudgeDetector'
import { ForgetDetector } from './memory/forgetDetector'
import { PendingResolver } from './memory/pendingResolver'
import { DailyNarrativeWriter } from './persona/dailyNarrative'
import { MemoryFileView } from './memory/memoryFileView'
import { IdleDetector } from './memory/idleDetector'
import { Tier1Classifier } from './perception/tier1Classifier'
import { Tier2Summarizer } from './perception/tier2Summarizer'
import { PerceptionPipeline } from './perception/perceptionPipeline'
import { OrdersParser } from './orders/parser'
import { OrdersCompiler } from './orders/compiler'
import { OrdersRuntime } from './orders/runtime'
import { ensureSeedFile } from './orders/seedFile'
import { ActivityWatchObserver } from './proactive/observers/activityWatch'
import { IntentRegistry, registerBuiltIns } from './agency/intentRegistry'
import { TrajectoryLog, TRAJECTORY_SCHEMA } from './agency/trajectoryLog'
import { InboxSurface } from './agency/inboxSurface'
import { NativeNotifier } from './agency/nativeNotifier'
import { ActionExecutor } from './agency/actionExecutor'
import { TriggerEngine } from './agency/triggerEngine'
import { PerceptionToTrigger } from './agency/perceptionToTrigger'
import { BrowserOpener } from './onboarding/browserOpener'
import { ClipboardPatternWatcher } from './onboarding/clipboardPatternWatcher'
import { OAuthCallbackHandler } from './onboarding/oauthCallbackHandler'
import { McpAutoInstaller } from './onboarding/mcpAutoInstaller'
import { McpConfigMutator } from './onboarding/mcpConfigMutator'
import { FlowStateStore } from './onboarding/flowStateStore'
import { InboxUserChannel } from './onboarding/inboxUserChannel'
import { SetupSkillGenerator } from './onboarding/setupSkillGenerator'
import { SetupFlowRuntime } from './onboarding/setupFlowRuntime'
import { ServiceResolver } from './onboarding/serviceResolver'
import { NpmRegistryClient } from './onboarding/npmRegistryClient'
import { McpCatalogClient } from './onboarding/mcpCatalogClient'
import { registerSetupIntent } from './onboarding/setupIntent'
import { ComposioClient } from './connectors/composioClient'
import { ConnectionStore } from './connectors/connectionStore'
import { ConnectionFlow } from './connectors/connectionFlow'
import { ComposioSessionManager } from './connectors/composioSessionManager'
import { TokenExpiryPoller } from './connectors/tokenExpiryPoller'
import { registerConnectServiceIntent } from './connectors/connectServiceIntent'
import { registerDisconnectServiceIntent } from './connectors/disconnectServiceIntent'
import { ToolkitResolver } from './connectors/toolkitResolver'
import { registerFindIntegrationIntent } from './connectors/findIntegrationIntent'
import { SoulLoader } from './persona/soulLoader'
import { TrajWriter } from './persona/trajWriter'
import { PersonaUpdater } from './persona/personaUpdater'
import { DreamingExtension } from './persona/dreamingExtension'
import { PersonaAwareness } from './persona/personaAwareness'
import { readFileSync, appendFileSync, writeFileSync, existsSync, mkdirSync, realpathSync } from 'fs'
import { readFile as fsReadFile, writeFile as fsWriteFile, readdir as fsReaddir, stat as fsStat } from 'node:fs/promises'
import { exec as nodeExec } from 'node:child_process'
import { SkillStore } from './skills/skillStore'
import { SkillRegistry } from './skills/skillRegistry'
import { UsageTracker } from './skills/usageTracker'
import { SkillWriter } from './skills/skillWriter'
import { SkillDispatcher } from './skills/skillDispatcher'
import { TsRunner } from './skills/tsRunner'
import { PythonRunner } from './skills/pythonRunner'
import { AwmWorker } from './skills/awmWorker'
import { Curator } from './skills/curator'
import { SkillCrystallizer } from './skills/crystallizer'
import { PersonaGate } from './skills/personaGate'
import { ReviewQueue } from './skills/reviewQueue'
import { registerInvokeSkillIntent } from './skills/invokeSkillIntent'
import { OrdersStore } from './orders/v2/store'
import { OrdersParser as OrdersParserV2 } from './orders/v2/parser'
import { OrdersAuthor } from './orders/v2/author'
import { ActionDispatcher as OrdersActionDispatcher } from './orders/v2/actionDispatcher'
import { ReactiveEvaluator } from './orders/v2/reactiveEvaluator'
import { RulesEventBus } from './orders/v2/eventBus'
import { ConditionEvaluator } from './orders/v2/conditionEvaluator'
import { DryRunLogger } from './orders/v2/dryRunLogger'
import { ScheduleAdapter } from './orders/v2/scheduleAdapter'
import { watchOrdersFile } from './orders/v2/watcher'
import { buildApprovalPrompt } from './orders/v2/approvalPrompt'
import { ComposioToolResolver } from './orders/v2/composioToolResolver'
import { PendingEditsQueue } from './orders/v2/pendingEdits'
import { PendingEditsProcessor } from './orders/v2/pendingEditsProcessor'
import { TriggerListener } from './connectors/triggers/listener'
import { TriggerEventLog } from './connectors/triggers/eventLog'
import { TriggerNormalizer } from './connectors/triggers/normalizer'
import { TriggerSchemaCache } from './connectors/triggers/schemaCache'
import { TriggerInstanceManager } from './connectors/triggers/instanceManager'
import { TriggerMetrics } from './connectors/triggers/metrics'
import { ConnectGuard } from './connectors/triggers/connectGuard'
import { Conductor } from './agents/conductor'
import { ContextBuilder } from './agents/contextBuilder'
import { SoulDigestLoader } from './agents/loaders/soulDigestLoader'
import { buildIntrospectionTools } from './agents/introspectionTools'
import { skillsAsTools } from './agents/skillToolAdapter'
import { intentsAsTools } from './agents/intentToolBridge'
import { ToolRetriever, type ToolDoc } from './agents/toolRetriever'
import { buildToolDispatchTools } from './agents/toolDispatch'
import { buildRecallTool } from './agents/recallTool'
import { buildWebTools } from './agents/webTools'
import { GuideBridge } from './agents/guideBridge'
import { buildGuideTools } from './agents/guideTools'
import { GuideLessonManager, LESSON_CONTINUE_SENTINEL, LESSON_CONTINUE_TEXT } from './agents/guideLesson'
import { TEACHING_RE } from './agents/loop/verifier'
import { ToolUsageTracker } from './agents/toolUsageTracker'
import { TurnLogger } from './agents/turnLogger'
import { ComposioToolCache, buildComposioSearchTool } from './agents/composioToolProvider'
import { SelfHealConnect } from './agents/selfHealConnect'
import type { SystemBlock } from './llm/types'
import { CostTracker } from './llm/costTracker'
import { buildLlmUsageHook, buildVoiceUsageHook } from './llm/usageMeter'

const VERSION = '0.2.0'

/**
 * Build an LLM completer for the voice agent (Conductor) using OpenRouter
 * directly per tier. Why not ModelRouter? ModelRouter in 'byo' mode tries
 * anthropic_cli → ollama → openai-direct, none of which speak OpenRouter.
 * For the agent path, we want the env-configured KAIROS_*_MODEL on OpenRouter.
 *
 * Each tier maps to its own KAIROS_*_MODEL env var (see TIER_MODELS in
 * agents/types.ts). All share a single OpenRouterAdapter instance under the
 * hood — model selection is per-call via the `model` body field.
 */
function buildAgentLlmCompleter(
  tier: Tier,
): { complete: (body: any) => Promise<{ text: string }> } {
  return buildLlmCompleterForModel(TIER_MODELS[tier](), `voice_${tier}`)
}

/**
 * Single env knob for ALL memory-side LLM work (fact extraction, contradiction
 * judging, preference detection, idle consolidation, persona-diff, daily
 * narrative). Resolution order:
 *   KAIROS_MEMORY_MODEL  →  KAIROS_FAST_MODEL  →  openai/gpt-4o-mini
 * Memory tasks are mostly cheap JSON extraction, so they default to the fast
 * model — set KAIROS_MEMORY_MODEL to upgrade/downgrade memory independently of
 * the conversation tiers.
 */
function memoryModel(): string {
  return process.env.KAIROS_MEMORY_MODEL ?? process.env.KAIROS_FAST_MODEL ?? 'openai/gpt-4o-mini'
}
function buildMemoryLlmCompleter(): { complete: (body: any) => Promise<{ text: string }> } {
  return buildLlmCompleterForModel(memoryModel(), 'memory')
}

/** Shared OpenRouter completer for an exact model id ({messages}→{text}).
 *  usageLabel attributes the spend in the ledger (record-only metering). */
function buildLlmCompleterForModel(model: string, usageLabel = 'agent'): { complete: (body: any) => Promise<{ text: string }> } {
  const adapter = new OpenRouterAdapter({ defaultModel: model, usageLabel })
  return {
    async complete(body: any): Promise<{ text: string }> {
      return adapter.complete({
        messages: Array.isArray(body?.messages) ? body.messages : [],
        max_tokens: typeof body?.max_tokens === 'number' ? body.max_tokens : undefined,
        temperature: typeof body?.temperature === 'number' ? body.temperature : undefined,
      })
    },
  }
}

/** Map perception-bus voice event kinds to the WS event names the Electron UI
 *  expects on /v1/voice/events. Unknown kinds pass through unchanged. */
function voiceEventName(busKind: string): string {
  const map: Record<string, string> = {
    'voice.user.utterance': 'stt_final',
    'voice.agent.utterance': 'agent_done',
    'voice.hotkey.down': 'listening_started',
    'voice.hotkey.up': 'listening_stopped',
    'voice.stt.partial': 'stt_partial',
    'voice.error': 'error',
    'voice.sidecar.error': 'sidecar_error',
    'voice.agent.utterance.interrupted': 'agent_interrupted',
  }
  return map[busKind] ?? busKind
}

function parseDaemonArgs() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      sandbox: { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
      version: { type: 'boolean', default: false },
      'sandbox-dir': { type: 'string' },
    },
    strict: false,
    allowPositionals: true,
  })

  return {
    sandbox: values.sandbox === true,
    verbose: values.verbose === true,
    version: values.version === true,
    sandboxDir: (values['sandbox-dir'] as string) ?? process.cwd(),
  }
}

async function main(): Promise<void> {
  const args = parseDaemonArgs()

  if (args.version) {
    console.log(`kairos-daemon ${VERSION}`)
    return
  }

  const config = loadConfig(args.sandboxDir, args.sandbox, args.verbose)

  // 1. Ensure directory structure
  ensureDirs(config.sandboxDir)

  // 2. Init logger
  initLogger({
    logDir: join(config.sandboxDir, 'state', 'logs'),
    verbose: config.verbose,
  })

  // 2b. Set sandbox dir for the notify module (so it can find Discord webhook)
  setNotifySandboxDir(config.sandboxDir)
  if (isDiscordConfigured(config.sandboxDir)) {
    log('Discord webhook configured — notifications will go to Discord')
  } else {
    log('Discord webhook not configured — notifications will be silent', 'warn')
  }

  // 3. Check for existing daemon
  if (checkExistingDaemon(config.sandboxDir)) {
    logError('Another KAIROS daemon is already running. Refusing to start.')
    process.exit(1)
  }

  // 4. Init database
  const dbPath = join(config.sandboxDir, 'state', 'state.db')
  const db = initDatabase(dbPath)

  // Durable activity log — "what did you do yesterday?". Written by the conductor
  // (foreground actions) + the background appendTraj hook; read by the kairos_activity
  // tool + the HUD recall feed. Constructed early so it's in scope for all three.
  const activityStore = new ActivityStore(db)
  log(`Database initialized at ${dbPath}`)

  // ── Daemon-wide usage metering (record-only) ────────────────────────────────
  // Every OpenRouterAdapter call (conductor tiers, planner, verify gate, compaction,
  // distill, sub-agents) + every STT/TTS call reports into llm_call_log via these
  // hooks — the voice/agent path used to bypass the ledger entirely, leaving spend
  // tracking blind to the daemon's biggest spender. METERED but never budget-BLOCKED:
  // enforcement stays with the proactive ModelRouter only; a spend cap must never
  // mute the assistant mid-sentence. Installed right after the DB so nothing runs
  // unmetered, voice or not.
  const usageLedger = new CostTracker(db, Number(process.env.KAIROS_MONTHLY_BUDGET_USD) || 50)
  ;(globalThis as any).__kairosLlmUsage = buildLlmUsageHook(usageLedger, (m) => log(m, 'warn'))
  ;(globalThis as any).__kairosVoiceUsage = buildVoiceUsageHook(usageLedger, (m) => log(m, 'warn'))

  // 5. Handle tasks from previous runs
  //    - One-shot tasks that were running → mark interrupted (don't auto-resume)
  //    - Watching tasks that were running → re-queue (they should keep running)
  //    - Queued tasks → leave as-is (they'll be picked up by the scheduler)
  const previouslyRunning = db.query(
    "SELECT task_id, watch FROM tasks WHERE status = 'running'",
  ).all() as { task_id: string; watch: number }[]

  let interruptedCount = 0
  let resumedCount = 0
  for (const t of previouslyRunning) {
    if (t.watch === 1) {
      // Watching task → re-queue so the scheduler picks it up again
      db.run("UPDATE tasks SET status = 'queued', subprocess_pid = NULL WHERE task_id = ?", [t.task_id])
      resumedCount++
    } else {
      // One-shot task → mark interrupted
      db.run("UPDATE tasks SET status = 'interrupted', completed_at = ? WHERE task_id = ?", [Date.now(), t.task_id])
      interruptedCount++
    }
  }
  if (interruptedCount > 0) log(`Marked ${interruptedCount} one-shot task(s) as interrupted`)
  if (resumedCount > 0) log(`Re-queued ${resumedCount} watching task(s) for auto-resume`)

  // 6. Init components
  // Tick brain runs on OpenRouter (KAIROS_TICK_MODEL → KAIROS_FAST_MODEL → gpt-4o-mini),
  // NOT the unauthenticated `claude -p` CLI that 401'd on every tick.
  const tickModel = process.env.KAIROS_TICK_MODEL ?? process.env.KAIROS_FAST_MODEL ?? 'openai/gpt-4o-mini'
  const decisionEngine = new DecisionEngine(db, config, buildLlmCompleterForModel(tickModel))
  const taskRunner = new TaskRunner(db, config)
  const memoryStore = new MemoryStore(db, config)
  ;(globalThis as { __kairosMemoryStore?: MemoryStore }).__kairosMemoryStore = memoryStore
  const voice = new Voice(config.sandboxDir)

  // 6b. New self-evolving modules
  const { ScheduleManager } = await import('./scheduleManager')
  const { EnvironmentScanner } = await import('./environmentScanner')
  const { FeedbackCollector } = await import('./feedbackCollector')
  // Legacy manifest-based registry (skills/active/*). Aliased so it does NOT shadow
  // the module-level AWM `SkillRegistry` (./skills/skillRegistry) used later — the
  // two same-named classes have different constructors and shadowing caused the
  // "{skillStore} not assignable to string" / "initialize does not exist" type errors.
  const { SkillRegistry: ManifestSkillRegistry } = await import('./skillRegistry')
  const scheduleManager = new ScheduleManager(db, config)
  const environmentScanner = new EnvironmentScanner(db, config)
  const feedbackCollector = new FeedbackCollector(db, config)
  const skillRegistry = new ManifestSkillRegistry(config.sandboxDir)

  // 6c. Recompute schedule next-fire times after restart
  scheduleManager.recomputeOnStartup()

  // 6d. Load skills from skills/active/
  const skillCount = skillRegistry.loadSkills()
  log(`Loaded ${skillCount} custom skill(s)`)
  // Re-scan every minute to pick up new skills without restart
  setInterval(() => skillRegistry.loadSkills(), 60_000)

  // Make skillRegistry available globally for the server route handlers
  // (server uses dynamic import for self-evolving modules; skillRegistry
  // needs to be passed in explicitly via the deps object)
  ;(globalThis as { __kairosSkillRegistry?: typeof skillRegistry }).__kairosSkillRegistry = skillRegistry

  // 6e. SkillGenerator (L2): KAIROS can write its own skills
  const { SkillGenerator } = await import('./skillGenerator')
  const skillGenerator = new SkillGenerator(config, skillRegistry)
  ;(globalThis as { __kairosSkillGenerator?: typeof skillGenerator }).__kairosSkillGenerator = skillGenerator

  // 6f. SkillGapDetector (L3): KAIROS notices what it can't do
  const { SkillGapDetector } = await import('./skillGapDetector')
  const skillGapDetector = new SkillGapDetector(db, skillRegistry)
  ;(globalThis as { __kairosSkillGapDetector?: typeof skillGapDetector }).__kairosSkillGapDetector = skillGapDetector
  // Run gap scan every 30 minutes
  setInterval(() => skillGapDetector.scanFailures(), 30 * 60_000)
  // Initial scan on startup
  skillGapDetector.scanFailures()

  // 6g. PromptEvolution (L4): KAIROS A/B tests its own prompts
  const { PromptEvolution } = await import('./promptEvolution')
  const promptEvolution = new PromptEvolution(db, config)
  ;(globalThis as { __kairosPromptEvolution?: typeof promptEvolution }).__kairosPromptEvolution = promptEvolution
  // Auto-promote check every hour
  setInterval(() => {
    for (const promptName of ['tick-decision', 'work-prompt', 'dream-prompt', 'system']) {
      try { promptEvolution.autoPromote(promptName) } catch (err) { logError(`auto-promote ${promptName}`, err) }
    }
  }, 60 * 60_000)

  // 6h. SourceEvolution (L5): KAIROS proposes source code patches to itself
  const { SourceEvolution } = await import('./sourceEvolution')
  const sourceEvolution = new SourceEvolution(db, config)
  ;(globalThis as { __kairosSourceEvolution?: typeof sourceEvolution }).__kairosSourceEvolution = sourceEvolution

  // 6i. SelfDebugger (B): autonomously propose fixes for recurring errors
  const { SelfDebugger } = await import('./selfDebugger')
  // Notification: post to Discord if configured (uses correct postToDiscord signature)
  const debuggerNotifyFn = (msg: string) => {
    void import('./discord').then(d => {
      if (!d.isDiscordConfigured(config.sandboxDir)) return
      void d.postToDiscord({
        sandboxDir: config.sandboxDir,
        title: 'Self-debugger — patch ready for review',
        body: msg,
        severity: 'warning',
      })
    })
  }
  const selfDebugger = new SelfDebugger(db, config, sourceEvolution, debuggerNotifyFn)
  ;(globalThis as { __kairosSelfDebugger?: typeof selfDebugger }).__kairosSelfDebugger = selfDebugger
  // Scan log every 3 minutes for recurring errors
  setInterval(() => { void selfDebugger.scan() }, 3 * 60_000)

  // 7. Create the scheduler with handlers
  const scheduler = new Scheduler(
    // Decision handler
    (event) => decisionEngine.decide(event),
    db,
    config,
    // onWork
    (taskId) => {
      void taskRunner.runTask(taskId).then(result => {
        scheduler.triggerImmediateTick({
          source: 'subprocess_done',
          reason: `Task ${taskId} finished: ${result.status}`,
        })
      })
    },
    // onInvestigate
    (topic) => {
      void taskRunner.investigate(topic)
    },
    // onNotify
    (body, sessionId, priority) => {
      queries.createMessage(db, {
        sessionId: sessionId === 'broadcast' ? null : sessionId,
        kind: 'notification',
        priority,
        body: voice.sanitize(body),
      })
      // macOS notification for urgent and proactive messages
      if ((priority === 'urgent' || priority === 'proactive') && process.platform === 'darwin') {
        sendMacNotification('KAIROS', body.slice(0, 200))
      }
    },
    // onDream — enhanced with feedback metrics for self-evolution
    () => {
      void memoryStore.runDream(feedbackCollector.formatMetricsForDream())
    },
    // onSuggest
    (observationId, body, severity) => {
      const sanitized = voice.sanitize(body)
      queries.createMessage(db, {
        sessionId: null, // broadcast
        kind: 'notification',
        priority: severity === 'critical' ? 'urgent' : 'proactive',
        body: sanitized,
      })
      // Suggestions go to Discord (replaces macOS osascript notification)
      void postToDiscord({
        sandboxDir: config.sandboxDir,
        title: severity === 'critical' ? 'KAIROS — needs attention' : 'KAIROS — observation',
        body: sanitized.slice(0, 3500),
        severity: severity === 'critical' ? 'urgent' : 'warning',
        fields: [{ name: 'Observation', value: observationId, inline: true }],
      })
    },
    // Pre-tick hooks (self-evolving features)
    {
      checkSchedules: () => scheduleManager.fireDueSchedules(),
      runScan: () => environmentScanner.scan(),
      collectFeedback: () => feedbackCollector.collect(),
    },
  )

  // 7b. Wire the triggerTick into the scanner so notification replies can create tasks
  environmentScanner.setTriggerTick((event) => scheduler.triggerImmediateTick(event as TickEvent))

  // 7c. Start Discord bot polling (bidirectional Discord chat)
  const { DiscordBot, loadBotConfig } = await import('./discordBot')
  const botConfig = loadBotConfig(config.sandboxDir)
  let discordBot: InstanceType<typeof DiscordBot> | null = null
  if (botConfig) {
    discordBot = new DiscordBot(
      botConfig,
      db,
      (event) => scheduler.triggerImmediateTick(event as TickEvent),
    )
    void discordBot.start()
  } else {
    log('Discord bot not configured (no bot token in secrets.json) — outbound only', 'warn')
  }

  // 8. Pick port and start HTTP server
  const port = pickPort(config)
  const server = startHttpServer({
    port,
    db,
    config,
    triggerTick: (event) => scheduler.triggerImmediateTick(event as TickEvent),
  })

  // 9. Write lifecycle files
  writePidFile(config.sandboxDir)
  writePortFile(config.sandboxDir, port)

  // 10. Start the autonomous tick scheduler — the 60s loop that drives proactive
  // decisions (the main background LLM spender). Gate it on KAIROS_AUTONOMOUS_ENABLED
  // so you can run a pure on-demand agent (voice + memory + persona all still work)
  // with NO background spend. On-demand task execution still fires via
  // triggerImmediateTick regardless. Default: on.
  if (config.autonomousEnabled) {
    scheduler.start()
  } else {
    log('Autonomous tick scheduler DISABLED (KAIROS_AUTONOMOUS_ENABLED=false) — on-demand only, no background ticks')
  }

  // 10b. Proactive subsystem (ModelRouter + EventBus + observers + Narrator)
  let proactiveStop: (() => Promise<void>) | null = null
  if (config.proactive.enabled) {
    const router = buildRouter(db, config.proactive.providerConfigPath, config.mode ?? 'byo')
    const bus = new EventBus(db)
    const snapshot = new StateSnapshot(bus)
    const registry = new ObserverRegistry(bus)

    registry.register(new FocusAppObserver(bus))
    registry.register(new BrowserTabsObserver(bus))
    registry.register(new ClipboardObserver(bus))
    registry.register(new FileEventsObserver(bus))
    registry.register(new CalendarLocalObserver(bus))
    registry.register(new ActivityWatchObserver(bus))

    await registry.startAll()
    const narrator = new Narrator(bus, snapshot, router, {
      intervalMs: Number.MAX_SAFE_INTEGER, // Phase B: pipeline drives narrator.tick() instead
    })
    // DO NOT call await narrator.start() — leave the timer dormant.
    // The PerceptionPipeline (added below) calls narrator.tick() directly.
    log(`Proactive subsystem active: ${registry.list().length} observers + narrator`)

    // ── Phase B: Memory + Perception + Orders subsystems ──────────────
    let memoryStop: (() => Promise<void>) | null = null
    if (config.memory.enabled) {
      initMemorySchema(db)
      const embedder = new Embedder()
      // 30-min ring so the 30-min perception poll sees the FULL window of events (was
      // 10 min — a 30-min poll would have lost two-thirds of the context). maxEvents
      // still bounds the prompt (drops OLDEST first on overflow); both env-tunable so a
      // busy window can opt into truly-all-events per launch.
      const working = new WorkingMemory(bus, {
        // 60 min: must cover the LONGEST adaptive sweep gap (quiet stretches to 60 min)
        // so a sweep never finds part of its window already evicted.
        windowMs: Number(process.env.KAIROS_WORKING_MEMORY_WINDOW_MS) || 60 * 60_000,
        // 2000: a busy window must NEVER be silently truncated — the sweep's whole
        // point is reviewing the FULL period (observers emit on-change; ~hundreds typical).
        maxEvents: Number(process.env.KAIROS_WORKING_MEMORY_MAX_EVENTS) || 2000,
      })
      const episodic = new EpisodicMemory(db)
      const semantic = new SemanticMemory(db)
      const dreamer = new Dreamer(db, episodic, semantic, router, { embedder: (t: string) => embedder.embed(t) })

      // ── C.2.6: LocalEmbedder + VectorIndex + EpisodicStore + SemanticStore + MemoryInjector ──
      let localEmbedder: LocalEmbedder | undefined
      let l2VectorIndex: VectorIndex | undefined
      let l3VectorIndex: VectorIndex | undefined
      let memoryInjector: MemoryInjector | undefined

      if (config.embedding?.enabled !== false) {
        localEmbedder = new LocalEmbedder({
          cacheDir: config.embedding?.cache_dir ?? join(homedir(), '.kairos', 'cache', 'huggingface'),
          model: config.embedding?.model,
        })
        log('[embedder] downloading/loading model (first run takes ~30s)...')
        await localEmbedder.warmup()
        log('[embedder] ready')

        l2VectorIndex = new VectorIndex(db, localEmbedder, { tableName: 'episodic_vec' })
        l3VectorIndex = new VectorIndex(db, localEmbedder, { tableName: 'semantic_vec' })
        await Promise.all([l2VectorIndex.init(), l3VectorIndex.init()])
      }

      // EpisodicStore and SemanticStore are new free-text observation/fact stores
      // with optional vector recall. Constructed alongside existing EpisodicMemory /
      // SemanticMemory (structured stores) — those are NOT removed.
      const episodicStore = new EpisodicStore(db, l2VectorIndex)
      const semanticStore = new SemanticStore(db, l3VectorIndex)

      // ProceduralMemory adapter to satisfy ProceduralStore interface for MemoryInjector
      const proceduralAdapter = {
        activeSkills: async () => {
          try {
            const { ProceduralMemory } = await import('./memory/proceduralMemory')
            const proc = new ProceduralMemory(db)
            return proc.topUsed(20).map(s => ({ id: s.skill_id, text: s.description }))
          } catch { return [] }
        },
      }

      memoryInjector = new MemoryInjector({ l2: episodicStore, l3: semanticStore, l4: proceduralAdapter })
      ;(globalThis as { __kairosMemoryInjector?: MemoryInjector }).__kairosMemoryInjector = memoryInjector
      // Phase E.2.0: stash episodicStore so wrap-api /v1/memory/* can reach it.
      ;(globalThis as { __kairosEpisodicStore?: EpisodicStore }).__kairosEpisodicStore = episodicStore
      // Phase E.2.3 (Task 3.4): stash extra memory subsystems so introspection
      // tools and ContextBuilder loaders can reach them via globalThis.
      ;(globalThis as any).__kairosEpisodicMemory = episodic
      ;(globalThis as any).__kairosSemanticMemory = semantic
      ;(globalThis as any).__kairosSemanticStore = semanticStore
      ;(globalThis as any).__kairosDreamer = dreamer
      log(`C.2.6 memory subsystem active — vector-augmented recall ${localEmbedder ? 'enabled' : 'disabled (keyword-only)'}`)
      const idle = new IdleDetector()

      // Memory-side LLM — driven by KAIROS_MEMORY_MODEL (→ KAIROS_FAST_MODEL →
      // gpt-4o-mini). One knob controls factWriter contradiction-judging +
      // voice consolidation. (Persona-dream + daily-narrative use their own
      // dreaming-tier routing below.)
      const memoryLlm = buildMemoryLlmCompleter()

      // FactWriter: smart-write layer over SemanticStore — dedup / supersede
      // contradictions / raise confirmations. Shared by VoiceConsolidator (idle)
      // and RealtimeFactExtractor (per-turn, reached via __kairosFactWriter).
      const factWriter = new FactWriter({ semanticStore, llm: memoryLlm, log: (m: string) => log(m) })
      ;(globalThis as any).__kairosFactWriter = factWriter

      // VoiceConsolidator: bridges the FREE-TEXT stores the MemoryInjector reads
      // (EpisodicStore→SemanticStore), distilling voice observations into durable
      // L3 facts. The Dreamer above only consolidates the structured stores, which
      // the injector does NOT read — so without this, voice L2 never reaches L3.
      const voiceConsolidator = new VoiceConsolidator({ db, factWriter, llm: memoryLlm })
      ;(globalThis as any).__kairosVoiceConsolidator = voiceConsolidator

      // memU-style file-system VIEW: projects live L3 facts → ~/.kairos/memory/*.md
      // (read-only, regenerated each cycle) so memory is human-browsable.
      const memoryFileView = new MemoryFileView({ semanticStore, log: (m: string) => log(m) })
      ;(globalThis as any).__kairosMemoryFileView = memoryFileView

      // The idle consolidation timer (dreamer + voice→L3 distill + file view) is
      // background LLM spend, so it only runs in autonomous mode. NOTE: per-turn
      // memory (realtime fact extraction while you talk) is UNAFFECTED — it's
      // on-demand and stays fully active even with autonomous off. So recall +
      // "remember what I just said" keep working; only the periodic deep distill pauses.
      const dreamTimer = config.autonomousEnabled
        ? setInterval(async () => {
            try {
              if (await idle.shouldDream()) {
                await dreamer.consolidate({ maxEpisodes: 50 })
                const n = await voiceConsolidator.consolidate({ maxObservations: 30 })
                if (n > 0) log(`[voiceConsolidator] distilled ${n} L3 fact(s) from voice`)
                try { memoryFileView.project() } catch { /* view is best-effort */ }
              }
            } catch (err) { logError('Dreamer tick failed', err) }
          }, config.memory.dreamIntervalMs)
        : null

      // Standing orders subsystem
      let ordersRuntime: OrdersRuntime | null = null
      if (config.orders.enabled) {
        ensureSeedFile(config.orders.filePath)
        const ordersParser = new OrdersParser(config.orders.filePath)
        const ordersCompiler = new OrdersCompiler(db, router)
        ordersRuntime = new OrdersRuntime(ordersParser, ordersCompiler, { pollMs: 5000 })
        await ordersRuntime.start()
      }

      // Perception pipeline
      let pipeline: PerceptionPipeline | null = null
      if (config.perception.enabled) {
        const tier1 = new Tier1Classifier(router)
        const tier2 = new Tier2Summarizer(router)
        pipeline = new PerceptionPipeline(
          db, working, tier1, tier2, narrator, episodic,
          () => ordersRuntime?.text() ?? '',
          { pollMs: config.perception.pipelinePollMs },
        )
        // The perception poll classifies world-state events via LLM on a timer —
        // a background spender. Only start it when autonomous mode is on, so
        // KAIROS_AUTONOMOUS_ENABLED=false truly silences ALL background LLM calls.
        if (config.autonomousEnabled) {
          pipeline.start()
        } else {
          log('Perception poll DISABLED (autonomous off) — no background world-state classification')
        }
        log('Perception pipeline active: Tier1 → Tier2 → Narrator')
      }

      // ─── Agency subsystem (Phase C.1) ─────────────────────
      let agencyStop: (() => void) | null = null
      let mcpStop: (() => Promise<void>) | null = null
      if (config.agency.enabled) {
        db.exec(TRAJECTORY_SCHEMA)
        // Pre-create tables referenced by remindIn and suspend intent handlers
        db.exec(`
          CREATE TABLE IF NOT EXISTS agency_scheduled_reminders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT, body TEXT, fire_at INTEGER, fired INTEGER NOT NULL DEFAULT 0
          );
          CREATE TABLE IF NOT EXISTS agency_suspend_state (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scope TEXT, until_ms INTEGER, reason TEXT
          );
        `)

        const intentRegistry = new IntentRegistry()
        registerBuiltIns(intentRegistry)

        // ─── MCP host (Phase C.2) ─────────────────────────
        if (config.mcp.enabled) {
          const { McpHost } = await import('./mcp/mcpHost')
          const { Keychain } = await import('./mcp/keychain')
          const { registerMcpToolsAsIntents } = await import('./mcp/toolToIntent')
          const { SkillLoader } = await import('./mcp/skillLoader')

          const keychain = new Keychain()
          const mcpHost = new McpHost({ configPath: config.mcp.configPath, keychain })
          await mcpHost.startAll()
          registerMcpToolsAsIntents(intentRegistry, mcpHost)

          const skillLoader = new SkillLoader(config.mcp.skillsRoot)
          const skillCount = skillLoader.listSummaries().length
          if (skillCount > 0) log(`SkillLoader: ${skillCount} agentskills.io skill(s) available at ${config.mcp.skillsRoot}`)

          log(`MCP host active: ${mcpHost.listServers().length} server(s), ${mcpHost.listAllTools().length} tool(s) registered as intents`)

          mcpStop = async () => { await mcpHost.stopAll() }

          // ─── Onboarding subsystem (Phase C.2.5) ───────────────────────
          const onboardingChatPath = join(config.sandboxDir, 'state', 'onboarding-chat.md')
          const flowStateStore = new FlowStateStore(db)
          const setupRuntime = new SetupFlowRuntime({
            browserOpener: new BrowserOpener(),
            clipboardPatternWatcher: new ClipboardPatternWatcher(bus),
            oauthCallbackHandler: new OAuthCallbackHandler(),
            mcpAutoInstaller: new McpAutoInstaller(),
            mcpConfigMutator: new McpConfigMutator(config.mcp.configPath),
            flowStateStore,
            keychain,
            mcpHost,
            userChannel: new InboxUserChannel({ path: onboardingChatPath }),
          })
          const setupNpm = new NpmRegistryClient()
          const setupCatalog = new McpCatalogClient()
          const setupResolver = new ServiceResolver({ npm: setupNpm, catalog: setupCatalog })
          registerSetupIntent(intentRegistry, {
            generator: new SetupSkillGenerator(router, setupResolver),
            runtime: setupRuntime,
          })
          log('Onboarding subsystem active — setup_service intent registered')

          // ─── Composio subsystem (Phase C.2.7) ─────────────────────────────
          if (config.composio?.enabled !== false) {
            const composioApiKey = process.env.COMPOSIO_API_KEY ?? config.composio?.api_key
            if (!composioApiKey) {
              log('[composio] no COMPOSIO_API_KEY set, skipping Composio subsystem. Set COMPOSIO_API_KEY env var to enable connectors.', 'warn')
            } else {
              try {
                const composioClient = new ComposioClient({ apiKey: composioApiKey })
                const connectionStore = new ConnectionStore(db)
                const composioUserId = 'local'

                const activeConnections = connectionStore.listActive(composioUserId)
                const initialToolkits = activeConnections.map(c => c.toolkit_slug)

                const sessionManager = new ComposioSessionManager({
                  sdk: composioClient.sdk,
                  userId: composioUserId,
                  toolkits: initialToolkits,
                  cachedSessionId: config.composio?.session_id,
                  manageConnections: true,
                })
                await sessionManager.init()
                // Self-heal: toolkits Composio rejected at create (half-connected, no auth config)
                // were dropped so the session could boot — mark them expired so they stop being
                // requested on every boot. The user can re-connect them properly any time.
                for (const slug of sessionManager.droppedToolkits) {
                  try { connectionStore.markStatus(composioUserId, slug, 'expired') } catch { /* */ }
                  log(`[composio] dropped half-connected toolkit "${slug}" (marked expired) — other connectors unaffected`, 'warn')
                }
                log(`[composio] session ready (${sessionManager.getSessionId()}, ${sessionManager.getToolkits().length} toolkits)`)
                // Live connected-toolkits getter for the context builder ("Connected apps: …" in
                // every turn's prompt). Reads the SESSION's current set, so a mid-session
                // connect_service (addToolkit) is reflected on the very next turn.
                ;(globalThis as any).__kairosConnectedToolkits = () => { try { return sessionManager.getToolkits() } catch { return [] } }

                await mcpHost.addServer({
                  id: 'composio',
                  enabled: true,
                  transport: 'http',
                  url: sessionManager.getMcpUrl(),
                  headers: sessionManager.getMcpHeaders(),
                  tier_policy: { default: 'YELLOW' },
                })

                const connectionFlow = new ConnectionFlow({
                  composio: composioClient,
                  browserOpener: new BrowserOpener(),
                  oauthCallbackHandler: new OAuthCallbackHandler(),
                  connectionStore,
                  announcer: { announce: async (text: string, _opts: any) => log(`[composio:announce] ${text}`) },
                })

                // GENERAL toolkit discovery — resolves ANY fuzzy phrase ("calendar",
                // "the thing I use for tickets") to the exact live Composio slug.
                // Replaces the old hardcoded SLUG_ALIASES map. `composioClient.sdk` IS
                // the Composio instance (tools.getRawComposioTools + client.toolkits.list).
                const toolkitResolver = new ToolkitResolver({ composio: composioClient.sdk })
                toolkitResolver.initialize().catch((err: unknown) => log(`[composio] toolkit resolver init failed: ${err}`, 'warn'))
                ;(globalThis as any).__kairosToolkitResolver = toolkitResolver

                registerConnectServiceIntent(intentRegistry, { connectionFlow, sessionManager, toolkitResolver, userId: composioUserId, log: (m) => log(m) })
                registerFindIntegrationIntent(intentRegistry, { toolkitResolver })
                registerDisconnectServiceIntent(intentRegistry, { composio: composioClient, connectionStore, sessionManager, userId: composioUserId })

                const expiryPoller = new TokenExpiryPoller({
                  composio: composioClient,
                  connectionStore,
                  onConnectionExpired: (c) => {
                    log(`[composio] connection expired: ${c.toolkit_slug} — needs reconnect`, 'warn')
                    // Re-index so the expired toolkit's tools drop out of search_tools —
                    // otherwise the planner keeps surfacing tools that now fail with auth errors.
                    ;(globalThis as any).__kairosInvalidatePrefix?.()
                    void (globalThis as any).__kairosReindexTools?.()
                  },
                  userId: composioUserId,
                  intervalMs: config.composio?.poll_interval_ms ?? 5 * 60 * 1000,
                })
                expiryPoller.start()

                // Stash for Phase D trigger subsystem and orders-v2
                ;(globalThis as any).__kairosComposioClient = composioClient
                ;(globalThis as any).__kairosConnectionStore = connectionStore
                ;(globalThis as any).__kairosConnectionFlow = connectionFlow

                // ── Dynamic tool retrieval (Phase 1) ──────────────────────────
                // Index connected toolkits' tools so the planner retrieves only the
                // few relevant ones per turn (search_tools) instead of being handed
                // hundreds. Scales to any number of connected toolkits.
                if (localEmbedder) {
                  const toolRetriever = new ToolRetriever({ embedder: localEmbedder })
                  const reindexTools = async () => {
                    try {
                      const slugs = [...new Set(connectionStore.listActive(composioUserId).map((c: any) => String(c.toolkit_slug)).filter(Boolean))]
                      const docs: ToolDoc[] = []
                      for (const slug of slugs) {
                        const r: any = await composioClient.sdk?.tools?.getRawComposioTools?.({ toolkits: [slug], limit: 100 })
                        for (const t of (Array.isArray(r) ? r : (r?.items ?? []))) {
                          const name = t.slug ?? t.name
                          if (!name) continue
                          const p = t.inputParameters ?? t.input_parameters ?? t.inputSchema
                          docs.push({
                            name, toolkit: slug,
                            description: t.description ?? '',
                            parameters: (p && typeof p === 'object' && p.type) ? p : undefined,
                            hints: [String(name).toLowerCase().replace(/_/g, ' ')],
                          })
                        }
                      }
                      await toolRetriever.index(docs)
                      log(`[tools] retrieval index: ${docs.length} tool(s) across ${slugs.length} connected toolkit(s)`)
                    } catch (e) { log(`[tools] reindex failed: ${String(e)}`, 'warn') }
                  }
                  void reindexTools()
                  ;(globalThis as any).__kairosToolRetriever = toolRetriever
                  ;(globalThis as any).__kairosReindexTools = reindexTools
                  // Tool-usage tracker → powers the "hot set" (most-used tools loaded
                  // directly into the planner, skipping the search hop on common actions).
                  const usagePath = join(config.sandboxDir, 'state', 'tool-usage.json')
                  const toolUsage = new ToolUsageTracker({
                    load: () => { try { return existsSync(usagePath) ? JSON.parse(readFileSync(usagePath, 'utf8')) : {} } catch { return {} } },
                    save: (c) => { try { writeFileSync(usagePath, JSON.stringify(c)) } catch {} },
                  })
                  ;(globalThis as any).__kairosToolUsage = toolUsage
                  ;(globalThis as any).__kairosComposioExecute = (name: string, args: any) => {
                    toolUsage.record(name)   // count real executions → ranks the hot set
                    return composioClient.executeTool({ toolName: name, userId: composioUserId, arguments: args ?? {} })
                  }
                }

                log('[composio] subsystem ready')
              } catch (err) {
                log('[composio] subsystem failed to start, continuing without connectors: ' + String(err), 'warn')
              }
            }
          }
        }

        const trajectory = new TrajectoryLog(db)
        const notifier = new NativeNotifier()
        const inbox = new InboxSurface(db, config.agency.inboxPath)
        // Stashed so the background-agent approval gate (constructed later, outside
        // this nested scope) can park unanswered destructive approvals here.
        ;(globalThis as any).__kairosInbox = inbox

        const actionCtx = {
          db,
          notifier,
          embedder: { embed: (text: string) => embedder.embed(text) },
          semantic,
        }
        // ─── Restraint subsystem (Phase C.1.5) — The Earned Interrupt architecture ──
        let restraintPipeline: any = null
        if (config.restraint.enabled) {
          const { loadRestraintConfig } = await import('./restraint/configLoader')
          const restraintCfg = loadRestraintConfig(config.restraint.configPath)
          const { FocusDetector } = await import('./restraint/focusDetector')
          const { KarmaStore } = await import('./restraint/karma')
          const { CooldownTracker } = await import('./restraint/cooldownTracker')
          const { RateLimiter } = await import('./restraint/rateLimiter')
          const { ActionScorer } = await import('./restraint/actionScorer')
          const { DeliveryRouter } = await import('./restraint/deliveryRouter')
          const { DigestComposer } = await import('./restraint/digestComposer')
          const { DryRunMode } = await import('./restraint/dryRunMode')
          const { UrgencyFloor } = await import('./restraint/urgencyFloor')
          const { RestraintPipeline } = await import('./restraint/restraintPipeline')

          const focus = new FocusDetector(restraintCfg)
          const karma = new KarmaStore(db, restraintCfg)
          const cooldown = new CooldownTracker(restraintCfg.default_trigger_cooldown_sec * 1000)
          const rateLimiter = new RateLimiter(db, restraintCfg)
          const scorer = new ActionScorer(restraintCfg)
          const router = new DeliveryRouter(restraintCfg)
          const digest = new DigestComposer(db)
          const dryRun = new DryRunMode(db, restraintCfg)
          const urgencyFloor = new UrgencyFloor({ user_handles: ['nirmal', 'nghinai'] })

          restraintPipeline = new RestraintPipeline({
            config: restraintCfg, urgencyFloor, focus, karma, cooldown, rateLimiter,
            scorer, router, digest, dryRun,
          })
          log('Restraint subsystem active — Earned Interrupt enabled')
        }

        // ─── Persona subsystem (Phase C.3.1) ──────────────────────────────────
        let personaDreamingTimers: ReturnType<typeof setInterval>[] = []
        if (config.persona?.enabled !== false) {
          // SoulLoader — loads soul.md as long-cached SystemBlock
          const soulLoader = new SoulLoader({ path: config.persona?.paths?.soul })
          soulLoader.load()
          soulLoader.startWatching()

          // TrajWriter — agency dispatcher calls .record() after each intent completion
          const trajWriter = new TrajWriter({ dir: config.persona?.paths?.traj })

          // PersonaUpdater — Dreaming + nudges write through here
          const personaUpdater = new PersonaUpdater({
            path: config.persona?.paths?.persona,
            tokenCap: config.persona?.token_cap,
          })

          // PersonaAwareness — derives hints from persona + live focus state
          const personaAwareness = new PersonaAwareness({
            personaUpdater,
            getLiveState: () => ({
              // FocusAppObserver is event-driven (no getter); read last known value from StateSnapshot
              current_focus_app: snapshot.read().focus_app?.app ?? undefined,
              is_in_meeting: false,    // wired in Phase E (meeting detection)
              current_hour_local: new Date().getHours(),
              current_day_of_week: new Date().getDay(),
            }),
          })

          // DreamingExtension — 3-phase Hermes dreaming cycles. Pass the real
          // ModelRouter so persona diffs are LLM-COMPOSED (learns communication
          // style / preferences), not just heuristic recent_themes tallies.
          const dreaming = new DreamingExtension({
            trajWriter,
            personaUpdater,
            router,
          })

          const lightInterval = config.persona?.dreaming?.light_interval_ms ?? 4 * 60 * 60 * 1000
          const remInterval = config.persona?.dreaming?.rem_interval_ms ?? 24 * 60 * 60 * 1000
          const deepInterval = config.persona?.dreaming?.deep_interval_ms ?? 7 * 24 * 60 * 60 * 1000

          // Daily narrative writer (memU/OpenClaw-style diary). Generated on the
          // deep cycle by summarizing the day's voice_turns. Shares the persona
          // router via a {messages}→CompletionRequest adapter.
          const narrativeLlm = {
            complete: async (body: any) => {
              const sys = body.messages?.find((m: any) => m.role === 'system')?.content ?? ''
              const usr = body.messages?.filter((m: any) => m.role === 'user').map((m: any) => m.content).join('\n') ?? ''
              const r = await router.complete({
                task_type: 'dream',
                system_blocks: sys ? [{ text: sys, cache_hint: 'long' }] : [],
                prompt: usr,
                max_output_tokens: body.max_tokens ?? 250,
              } as any)
              return { text: (r as any).text ?? (r as any).output ?? '' }
            },
          }
          const dailyNarrative = new DailyNarrativeWriter({ db, llm: narrativeLlm, log: (m: string) => log(m) })
          ;(globalThis as any).__kairosDailyNarrative = dailyNarrative

          // Persona-dreaming cycles (LLM persona diffs + daily narrative) are
          // background spend → only armed in autonomous mode. The nudge tool +
          // preference detector still update persona on-demand regardless.
          personaDreamingTimers = config.autonomousEnabled ? [
            setInterval(() => { dreaming.runCycle('light').catch(err => log(`[dreaming] light cycle failed: ${err}`, 'warn')) }, lightInterval),
            setInterval(() => { dreaming.runCycle('rem').catch(err => log(`[dreaming] REM cycle failed: ${err}`, 'warn')) }, remInterval),
            setInterval(() => {
              dreaming.runCycle('deep').catch(err => log(`[dreaming] deep cycle failed: ${err}`, 'warn'))
              dailyNarrative.writeForDay().catch(err => log(`[dailyNarrative] failed: ${err}`, 'warn'))
            }, deepInterval),
          ] : []

          // Expose soulLoader on globalThis — callers can inject buildSystemBlock() into system_blocks
          ;(globalThis as { __kairosSoulLoader?: SoulLoader }).__kairosSoulLoader = soulLoader
          // Expose persona for the agent ContextBuilder's "## About the user" block.
          // PersonaUpdater holds the LEARNED profile (communication style, prefs, work
          // patterns); PersonaAwareness derives live hints. Both were previously only
          // reachable by the RestraintPipeline — wiring them to the agent makes replies
          // actually personalized (Tier 1 personalization).
          ;(globalThis as any).__kairosPersonaUpdater = personaUpdater
          ;(globalThis as any).__kairosPersonaAwareness = personaAwareness

          // Wire TrajWriter into executor (after executor is constructed below, via setter)
          // Wire PersonaAwareness into RestraintPipeline via setter
          if (restraintPipeline) {
            restraintPipeline.setPersonaAwareness(personaAwareness)
          }

          // Store refs for executor wiring below and for shutdown
          ;(globalThis as { __kairosTrajWriter?: TrajWriter }).__kairosTrajWriter = trajWriter

          log('[persona] subsystem ready — SoulLoader, TrajWriter, PersonaUpdater, Dreaming, PersonaAwareness active')
        }
        // ──────────────────────────────────────────────────────────────────────

        // ──────────────────────────────────────────────────────────────────────────
        // C.3.3 AWM (Agent Workflow Memory) subsystem — skill registry + worker + curator
        // ──────────────────────────────────────────────────────────────────────────
        let awmWorker: AwmWorker | null = null
        let curatorInst: Curator | null = null
        let curatorTimer: ReturnType<typeof setInterval> | null = null
        let lastCuratorRunAt = 0

        if (config.skills?.enabled !== false) {
          try {
            const skillsRoot = config.skills?.dir
            const skillStore = new SkillStore(db, skillsRoot ? { root_dir: skillsRoot } : {})
            skillStore.rebuildFromDisk()

            const usageTracker = new UsageTracker(skillsRoot ? { root_dir: skillsRoot } : {})
            const skillWriter = new SkillWriter(skillsRoot ? { root_dir: skillsRoot } : {})
            const reviewQueue = new ReviewQueue(db)

            const tsRunner = new TsRunner()
            // PythonRunner depends on a Composio SDK; pull it from globalThis if Composio came up.
            // If not, Python skills will fail at dispatch — that's acceptable for the first boot.
            const composioForPython = (globalThis as any).__kairosComposioClient ?? null
            const pythonRunner = composioForPython
              ? new PythonRunner({ composio: composioForPython, userId: 'local' })
              : null

            const skillRegistryInst = new SkillRegistry({ skillStore, usageTracker, rootDir: skillsRoot })
            skillRegistryInst.initialize()

            const dispatcher = new SkillDispatcher({
              skillRegistry: skillRegistryInst,
              usageTracker,
              tsRunner,
              pythonRunner: pythonRunner as PythonRunner,
            })
            // Stash the dispatcher on globalThis so the agent ContextBuilder
            // can wire skillsAsTools() against it. The OrdersActionDispatcher
            // also reads this key.
            ;(globalThis as any).__kairosSkillDispatcher = dispatcher

            // AwmWorker — induction pipeline. Requires router + persona TrajWriter.
            const _trajWriterForAwm = (globalThis as { __kairosTrajWriter?: TrajWriter }).__kairosTrajWriter
            if (_trajWriterForAwm && router) {
              const crystallizer = new SkillCrystallizer({ router })
              const personaGate = new PersonaGate({
                skillStore,
                skillWriter,
                reviewQueue,
                // Embedder: lazy-load from global if memory subsystem is up; else stub returns dummy
                embedder: (globalThis as any).__kairosLocalEmbedder ?? {
                  async warmup() {},
                  async embed(_t: string) { return new Float32Array(384) },
                },
                loadExistingSkillContent: (dir: string) => {
                  try { return readFileSync(join(dir, 'SKILL.md'), 'utf8') } catch { return null }
                },
              })

              awmWorker = new AwmWorker(
                { trajWriter: _trajWriterForAwm, crystallizer, personaGate },
                {
                  min_tool_calls: config.skills?.awm?.min_tool_calls,
                  min_occurrences: config.skills?.awm?.min_occurrences,
                },
              )
              // Expose the worker so the test-genesis WS hook can force a run on
              // demand (with threshold overrides) instead of waiting for the 4h timer.
              ;(globalThis as any).__kairosAwmWorker = awmWorker
              if (config.skills?.awm?.enabled !== false) {
                awmWorker.start(config.skills?.awm?.interval_ms ?? 4 * 60 * 60 * 1000)
              }
            } else {
              log('[skills] AwmWorker skipped — TrajWriter or ModelRouter not available', 'warn')
            }

            // Curator — weekly idle-gated lifecycle
            curatorInst = new Curator(
              { skillStore, usageTracker, skillWriter, router: router ?? undefined },
              {
                cycle_interval_days: config.skills?.curator?.cycle_interval_days,
                idle_gate_ms: config.skills?.curator?.idle_gate_ms,
                root_dir: skillsRoot,
              },
            )
            if (config.skills?.curator?.enabled !== false) {
              // Check every hour; only actually runs if shouldRun() gate passes
              curatorTimer = setInterval(() => {
                const now = Date.now()
                const lastAgencyIntentAt = (globalThis as any).__kairosLastAgencyIntentAt ?? Date.now()
                const idleMs = now - lastAgencyIntentAt
                if (!curatorInst!.shouldRun(now, lastCuratorRunAt, idleMs)) return
                curatorInst!.runOnce(now)
                  .then(r => {
                    lastCuratorRunAt = r.ran_at
                    log(`[skills] curator ran: stale=${r.phase1.marked_stale.length} archived=${r.phase1.archived.length} reviewed=${r.phase2.processed}`)
                  })
                  .catch(err => log(`[skills] curator failed: ${err}`, 'warn'))
              }, 60 * 60 * 1000)
            }

            // Register the invoke_skill intent
            registerInvokeSkillIntent(intentRegistry, { dispatcher })

            // Stash AWM (agentskills.io) registry on globalThis for system_blocks injection by agency layer.
            // NB: different key from the legacy manifest-based __kairosSkillRegistry (consumed by discordBot/server).
            ;(globalThis as { __kairosAwmSkillRegistry?: SkillRegistry }).__kairosAwmSkillRegistry = skillRegistryInst
            ;(globalThis as { __kairosSkillStore?: SkillStore }).__kairosSkillStore = skillStore

            log(`[skills] subsystem ready — ${skillStore.listAll().length} skills indexed, dispatcher + registry active${awmWorker ? ', AwmWorker started' : ''}${curatorTimer ? ', Curator scheduled' : ''}`)
          } catch (err) {
            log(`[skills] subsystem failed to start, continuing without skill subsystem: ${err}`, 'warn')
          }
        }
        // ──────────────────────────────────────────────────────────────────────────

        // ──────────────────────────────────────────────────────────────────────────
        // Phase D — Composio Triggers subsystem
        // ──────────────────────────────────────────────────────────────────────────
        let triggerListener: TriggerListener | null = null
        let triggerSchemaCache: TriggerSchemaCache | null = null
        let triggerInstanceManager: TriggerInstanceManager | null = null
        let triggerConnectGuard: ConnectGuard | null = null

        {
          const _composioClientForTriggers = (globalThis as any).__kairosComposioClient ?? null
          if (_composioClientForTriggers && config.composio?.triggers_enabled !== false) {
            try {
              const _connectionStoreForTriggers = (globalThis as any).__kairosConnectionStore
              const triggerEventLog = new TriggerEventLog(db)
              const triggerNormalizer = new TriggerNormalizer()
              const triggerMetrics = new TriggerMetrics(db)

              triggerSchemaCache = new TriggerSchemaCache({ composio: _composioClientForTriggers as any })
              await triggerSchemaCache.initialize().catch((err: any) => log(`[triggers] schema init: ${err}`, 'warn'))

              // Authoritative toolkit resolution via Composio's getType() (cached).
              // Falls back to slug-split heuristic on cache miss.
              triggerNormalizer.setToolkitLookup((slug: string) => {
                const t = triggerSchemaCache?.getType(slug)
                return t?.toolkit ?? null
              })

              triggerInstanceManager = new TriggerInstanceManager({
                db,
                composio: (_composioClientForTriggers as any).sdk ?? _composioClientForTriggers,
                userId: 'local',
              })
              await triggerInstanceManager.reconcile().catch((err: any) => log(`[triggers] reconcile: ${err}`, 'warn'))

              triggerConnectGuard = new ConnectGuard({
                connectionStore: _connectionStoreForTriggers as any,
                // Adapter — ConnectionFlow exposes connect(), not link(); wrap to { url? }
                connectionFlow: {
                  link: async (toolkit: string) => {
                    try {
                      const _cf = (globalThis as any).__kairosConnectionFlow
                      const r = await (_cf as any).connect({ userId: 'local', toolkitSlug: toolkit })
                      // connect() returns ConnectFlowResult — extract redirect_url if present
                      return { url: (r as any)?.redirect_url ?? undefined }
                    } catch (err) {
                      throw err
                    }
                  },
                },
                inbox: inbox as any,
                nativeNotifier: notifier as any,
                onConnectionComplete: (toolkit: string) => {
                  log(`[triggers] connection complete: ${toolkit}`)
                  // Refresh the planner's toolset + retrieval index so the
                  // just-connected toolkit's tools become available next turn.
                  ;(globalThis as any).__kairosInvalidatePrefix?.()
                  void (globalThis as any).__kairosReindexTools?.()
                },
                userId: 'local',
              })

              triggerListener = new TriggerListener({
                // Non-null: this block only runs when Composio is configured (key present).
                apiKey: (process.env.COMPOSIO_API_KEY ?? config.composio?.api_key) as string,
                eventLog: triggerEventLog,
                normalizer: triggerNormalizer,
                perceptionBus: bus as any,
                metrics: triggerMetrics,
                onHealthChange: (h: any) => log(`[triggers] health: ${h}`),
              })
              await triggerListener.start()

              // Wire schemaCache + instanceManager + connectGuard into OrdersAuthor (if it exists)
              const _author = (globalThis as any).__kairosOrdersAuthor
              if (_author) {
                _author.deps = _author.deps ?? {}
                ;(_author as any).deps.schemaCache = triggerSchemaCache
                ;(_author as any).deps.instanceManager = triggerInstanceManager
                ;(_author as any).deps.connectGuard = triggerConnectGuard
              }

              // Boot replay of unprocessed events
              const unprocessed = triggerEventLog.listUnprocessed(100)
              for (const env of unprocessed) (bus as any).publish('incoming_event', env)
              if (unprocessed.length > 0) log(`[triggers] replayed ${unprocessed.length} events at boot`)

              ;(globalThis as any).__kairosTriggerListener = triggerListener
              ;(globalThis as any).__kairosTriggerEventLog = triggerEventLog
              log(`[triggers] subsystem ready`)
            } catch (err) {
              log(`[triggers] subsystem failed to start: ${err}`, 'warn')
            }
          }
        }
        // ──────────────────────────────────────────────────────────────────────────

        // ──────────────────────────────────────────────────────────────────────────
        // C.4.1 STANDING_ORDERS v2 — structured DSL + time-triggered rules
        // ──────────────────────────────────────────────────────────────────────────
        let v2Watcher: (() => void) | null = null
        let v2ScheduleAdapter: ScheduleAdapter | null = null
        let composioResolver: ComposioToolResolver | null = null
        let pendingProcessor: PendingEditsProcessor | null = null

        if (config.orders?.v2_enabled !== false) {
          try {
            const ordersV2Store = new OrdersStore(db)
            const ordersV2Parser = new OrdersParserV2()
            const rulesBus = new RulesEventBus()
            const dryRunLogger = new DryRunLogger(ordersV2Store)
            const conditionEval = new ConditionEvaluator()

            const personaAwareness = (globalThis as any).__kairosPersonaAwareness
            const getPersonaState = () => {
              if (!personaAwareness) return {}
              try { return personaAwareness.getLiveState?.() ?? {} } catch { return {} }
            }

            const skillDispatcher = (globalThis as any).__kairosSkillDispatcher ?? null
            const composioClient = (globalThis as any).__kairosComposioClient ?? null

            // ComposioToolResolver — populated only if Composio is configured
            if (composioClient) {
              composioResolver = new ComposioToolResolver({
                composio: composioClient,
                userId: 'local',
                // Catalog only CONNECTED toolkits — the SDK rejects an unfiltered fetch.
                toolkits: () => {
                  const cs = (globalThis as any).__kairosConnectionStore
                  try { return cs ? [...new Set(cs.listActive('local').map((c: any) => String(c.toolkit_slug)).filter(Boolean))] as string[] : [] }
                  catch { return [] }
                },
                // Agentic read/write classification: the model labels each tool from its
                // description ONCE (cached), then the map drives latency tiering + approval
                // gating via setToolNature — no hardcoded verb list, works for any toolkit.
                classifyLlm: buildMemoryLlmCompleter(),
                onNature: (m) => { try { setToolNature(m) } catch { /* */ } },
                log: (m) => log(m),
              })
              composioResolver.initialize().catch((err: unknown) => log(`[orders-v2] resolver init failed: ${err}`, 'warn'))
            }

            const actionDispatcher = new OrdersActionDispatcher({
              intentRegistry,
              skillDispatcher: skillDispatcher ?? { invoke: async () => ({ ok: false, error: 'skill subsystem not initialized', duration_ms: 0, sandbox: 'declarative' }) },
              composio: (composioClient && composioResolver) ? {
                resolver: composioResolver,
                executeTool: async (args) => composioClient.executeTool(args),
                userId: 'local',
              } : null,
              eventBus: rulesBus,
            })

            const reactiveEvaluator = new ReactiveEvaluator({
              store: ordersV2Store,
              dispatcher: actionDispatcher,
              conditionEvaluator: conditionEval,
              dryRunLogger,
              getPersonaState,
            })

            // For each event-triggered rule, subscribe a listener on RulesEventBus that
            // forwards into the reactive evaluator as a named-event firing.
            const subscribeEventRules = () => {
              const events = new Set<string>()
              for (const r of ordersV2Store.listAll()) {
                if ('event' in r.when) events.add(r.when.event)
              }
              for (const ev of events) {
                rulesBus.on(ev, payload => {
                  reactiveEvaluator.handleEvent('event', { name: ev, payload }).catch((e: any) => log(`[orders-v2] event handler failed: ${e}`, 'warn'))
                })
              }
            }

            v2ScheduleAdapter = new ScheduleAdapter({
              store: ordersV2Store,
              onFire: async (rule, ctx) => {
                await actionDispatcher.dispatch(rule.do, ctx)
                ordersV2Store.recordFire(rule.slug, Date.now())
              },
            })

            const v2FilePath = config.orders?.filePath ?? join(homedir(), '.kairos', 'STANDING_ORDERS.md')
            const refreshAllFromFile = () => {
              try {
                if (!require('fs').existsSync(v2FilePath)) return
                const { rules, errors } = ordersV2Parser.parseFile(v2FilePath)
                ordersV2Store.replaceAll(rules)
                v2ScheduleAdapter!.refreshAll()
                subscribeEventRules()
                if (errors.length > 0) log(`[orders-v2] ${errors.length} rules skipped due to parse errors`, 'warn')
              } catch (err) {
                log(`[orders-v2] reload failed: ${err}`, 'warn')
              }
            }

            refreshAllFromFile()
            if (require('fs').existsSync(v2FilePath)) {
              v2Watcher = watchOrdersFile(v2FilePath, refreshAllFromFile, 200)
            }

            // Hourly check for dry-run windows that expired → surface as a log/inbox prompt
            const v2ApprovalTimer: ReturnType<typeof setInterval> = setInterval(() => {
              try {
                const expired = dryRunLogger.listReadyForApproval(Date.now())
                for (const rule of expired) {
                  const prompt = buildApprovalPrompt(rule, dryRunLogger, Date.now())
                  log(`[orders-v2] approval ready: ${prompt.title} — ${prompt.body.replace(/\n/g, ' | ')}`)
                }
              } catch (err) { log(`[orders-v2] approval scan failed: ${err}`, 'warn') }
            }, 60 * 60 * 1000)
            ;(globalThis as any).__kairosOrdersV2ApprovalTimer = v2ApprovalTimer

            const pendingQueue = new PendingEditsQueue(db)

            if (router) {
              // Compute "connected toolkits" lazily so the LLM prompt reflects current
              // OAuth state at authoring time (not at daemon-boot time).
              const _connStore = (globalThis as any).__kairosConnectionStore
              const getConnectedToolkits = (): string[] => {
                try {
                  const conns = _connStore?.listActive?.() ?? _connStore?.list?.() ?? []
                  const set = new Set<string>()
                  for (const c of conns) {
                    const slug = String((c as any).toolkit_slug ?? (c as any).toolkit ?? '').toLowerCase()
                    if (slug) set.add(slug)
                  }
                  return [...set]
                } catch { return [] }
              }
              const ordersAuthor = new OrdersAuthor({
                router,
                store: ordersV2Store,
                parser: ordersV2Parser,
                filePath: v2FilePath,
                pendingQueue,
                // Phase D — wire in trigger deps if subsystem started
                schemaCache: triggerSchemaCache ?? undefined,
                instanceManager: triggerInstanceManager ?? undefined,
                connectGuard: triggerConnectGuard ?? undefined,
                // Phase D fixup — ground action-tool authoring in real Composio schemas
                toolResolver: composioResolver ?? undefined,
                getConnectedToolkits,
              })
              ;(globalThis as any).__kairosOrdersAuthor = ordersAuthor
            }

            const _authorForProcessor = (globalThis as any).__kairosOrdersAuthor
            if (_authorForProcessor) {
              pendingProcessor = new PendingEditsProcessor({
                queue: pendingQueue,
                author: _authorForProcessor,
                onFailed: (speech: string, err: string) => log(`[orders-v2] pending edit hit max retries: "${speech.slice(0, 50)}" — ${err}`, 'warn'),
              })
              pendingProcessor.start(5 * 60 * 1000)
            }
            ;(globalThis as any).__kairosOrdersV2PendingQueue = pendingQueue
            ;(globalThis as any).__kairosOrdersV2PendingProcessor = pendingProcessor

            // Wire perception bus: subscribe to all events via wildcard '*'.
            // The proactive EventBus dispatches both targeted (source-keyed) and wildcard subscribers.
            // Each WorldEvent carries { kind, payload, source, ts, id } — we forward kind + payload
            // into ReactiveEvaluator so state-selector rules can react to perception signals.
            bus.subscribe('*', (e) => {
              reactiveEvaluator.handleEvent(e.kind, e.payload).catch((err: any) => log(`[orders-v2] reactive failed: ${err}`, 'warn'))
            })

            ;(globalThis as any).__kairosOrdersV2Store = ordersV2Store
            ;(globalThis as any).__kairosOrdersV2DryRunLogger = dryRunLogger
            ;(globalThis as any).__kairosOrdersV2RulesBus = rulesBus

            log(`[orders-v2] subsystem ready — ${ordersV2Store.listAll().length} rules loaded`)
          } catch (err) {
            log(`[orders-v2] subsystem failed to start: ${err}`, 'warn')
          }
        }
        // ──────────────────────────────────────────────────────────────────────────

        const executor = new ActionExecutor(db, intentRegistry, trajectory, inbox, actionCtx, restraintPipeline)

        // Bridge the agency intent plane into the voice conductor. Without this
        // the conductor's LLM has tools to TALK but none to ACT — "connect me to
        // Linear" / "remind me at 5" reached a tool-less path and did nothing.
        // The dispatch goes THROUGH the executor so the restraint/approval
        // pipeline (tier gating, confirm-before-destructive) still applies.
        ;(globalThis as any).__kairosIntentRegistry = intentRegistry
        ;(globalThis as any).__kairosIntentDispatch = async (id: string, args: any) => {
          const res = await executor.dispatch({
            request_id: crypto.randomUUID(),
            intent_id: id,
            args: (args ?? {}) as Record<string, unknown>,
            reasoning: 'voice conductor tool call',
            requested_at: Date.now(),
            source: 'user',   // foreground — the user asked. Bypass restraint debounce (not tier/approval).
          })
          // Connecting/disconnecting a service changes the available toolset —
          // refresh the planner's cached prefix so the new toolkit's tools (or
          // their removal) take effect on the next turn.
          if (id === 'connect_service' || id === 'disconnect_service' || id === 'setup_for') {
            ;(globalThis as any).__kairosInvalidatePrefix?.()
            // Re-index the retrieval corpus so the newly-connected toolkit's tools
            // are retrievable on the next turn (and removed ones disappear).
            void (globalThis as any).__kairosReindexTools?.()
          }
          return { status: res.status, details: res.details ?? '' }
        }

        // Wire TrajWriter into executor if persona subsystem is active
        const _trajWriter = (globalThis as { __kairosTrajWriter?: TrajWriter }).__kairosTrajWriter
        if (_trajWriter) executor.setTrajWriter(_trajWriter)
        const triggerEngine = new TriggerEngine(db, bus, async (req) => {
          const result = await executor.dispatch(req)
          ;(globalThis as any).__kairosLastAgencyIntentAt = Date.now()
          return result
        })
        const bridge = new PerceptionToTrigger(bus, episodic)

        // Seed bridge high-water from latest existing episode so we don't re-fire on restart
        const latestEp = episodic.recent(1)[0]
        if (latestEp) bridge.setHighWaterMark(latestEp.id)

        triggerEngine.start()
        const bridgeTimer = setInterval(() => { void bridge.republishLatest() }, config.perception.pipelinePollMs)

        // HTTP endpoints for CLI approve/dismiss
        const agencyHttpServer = Bun.serve({
          port: config.agency.daemonHttpPort,
          fetch: async (req) => {
            const url = new URL(req.url)
            if (url.pathname === '/agency/approve' && req.method === 'POST') {
              const { item_id } = await req.json() as { item_id: string }
              const result = await executor.approveItem(item_id)
              return Response.json(result)
            }
            if (url.pathname === '/agency/dismiss' && req.method === 'POST') {
              const { item_id, reason } = await req.json() as { item_id: string; reason: string }
              const result = await executor.dismissItem(item_id, reason)
              return Response.json(result)
            }
            return new Response('not found', { status: 404 })
          },
        })

        log(`Agency subsystem active. Inbox: ${config.agency.inboxPath} | CLI port: ${config.agency.daemonHttpPort}`)

        agencyStop = () => {
          triggerEngine.stop()
          clearInterval(bridgeTimer)
          agencyHttpServer.stop()
          for (const t of personaDreamingTimers) clearInterval(t)
          if (awmWorker) awmWorker.stop()
          if (curatorTimer) clearInterval(curatorTimer)
          if (v2Watcher) v2Watcher()
          if ((globalThis as any).__kairosOrdersV2ApprovalTimer) clearInterval((globalThis as any).__kairosOrdersV2ApprovalTimer)
          if (v2ScheduleAdapter) v2ScheduleAdapter.stopAll()
          if (composioResolver) composioResolver.stop()
          if (pendingProcessor) pendingProcessor.stop()
          if (triggerListener) void triggerListener.stop()
        }
      }

      memoryStop = async () => {
        if (mcpStop) await mcpStop()
        if (agencyStop) agencyStop()
        if (dreamTimer) clearInterval(dreamTimer)
        if (pipeline) pipeline.stop()
        if (ordersRuntime) ordersRuntime.stop()
      }
    }

    proactiveStop = async () => {
      await narrator.stop()
      await registry.stopAll()
      if (memoryStop) await memoryStop()
    }
  }

  // 10c. Voice subsystem (Phase E.2 — wired under KAIROS_WITH_VOICE flag)
  let voiceBundle: Awaited<ReturnType<typeof bootstrapVoice>> | undefined
  // Deferred broadcast: wrapApi is created AFTER bootstrapVoice, so canonical
  // TTS streams through this late-bound ref (filled once wrapApi exists).
  let deferredBroadcast: ((event: Record<string, unknown>) => void) | undefined
  const ttsBroadcast = (event: Record<string, unknown>) => deferredBroadcast?.(event)
  if (config.withVoice) {
    log('[voice] bootstrapping voice subsystem (KAIROS_WITH_VOICE=true)')

    // Pre-flight: the agent layer talks to OpenRouter directly. If the key is
    // missing, every classify/plan/narrate call will fail. Fail-fast with a
    // clear message instead of silent classification failures at runtime.
    if (!process.env.OPENROUTER_API_KEY) {
      log('✗ [voice] OPENROUTER_API_KEY is not set. Voice agent will not function.')
      log('  Set it in .env (gitignored). The agent uses OpenRouter for all LLM calls.')
      log('  Without it: classifier, planner, and narrator all fail silently.')
      throw new Error('OPENROUTER_API_KEY required when KAIROS_WITH_VOICE=true')
    }
    log(`[voice] models — fast=${TIER_MODELS.fast()} smart=${TIER_MODELS.smart()} deep=${TIER_MODELS.deep()}`)

    const helperBinary = process.env.KAIROS_VOICE_HELPER
      ?? join(import.meta.dir, '..', '..', 'apps', 'macos', 'KairosVoiceHelper', '.build', 'release', 'KairosVoiceHelper')
    // ModelRouter for voice — independent of the proactive subsystem so it
    // works even when proactive is disabled. The bootstrap currently accepts
    // an llm hook but doesn't invoke it; wiring is forward-looking.
    const voiceRouter = buildRouter(db, config.proactive.providerConfigPath, config.mode ?? 'byo')
    voiceBundle = await bootstrapVoice({
      db,
      helperBinary,
      llm: { complete: (body) => voiceRouter.complete(body) },
      broadcast: ttsBroadcast,
    })
    log(`[voice] sidecar connected, conductor running (tts=${voiceBundle.streamingTts ? 'canonical-stream' : 'apple'})`)
  }

  // 10d. Wrap-API server (Phase E.2.0 — Cloud-shaped local /v1/* HTTP surface)
  // ---------------------------------------------------------------------------
  // Bound on KAIROS_DAEMON_PORT (default 9876). The legacy server above now
  // defaults to 8765 so it can coexist with the wrap-api on 9876. Phase E.2
  // will eventually retire the legacy server; for now we treat the wrap-api
  // as additive.
  //
  // Adapters are wired to real subsystems where they exist. Subsystems that
  // are scoped inside the proactive/memory blocks are reached via the
  // `globalThis.__kairos*` stashes already set during their construction.
  // When a subsystem isn't active (e.g. Composio not configured), the adapter
  // returns a graceful "not enabled" stub.
  const wrapApiPort = Number(process.env.KAIROS_DAEMON_PORT) || 9876
  const llmApiKey = process.env.KAIROS_ANTHROPIC_KEY ?? process.env.ANTHROPIC_API_KEY ?? ''
  const llmAdapter = new LLMAdapter({ apiKey: llmApiKey, defaultModel: 'claude-haiku-4-5' })
  const voiceAdapter = voiceBundle
    ? new VoiceAdapter({ llm: { complete: (b) => llmAdapter.complete(b) }, store: voiceBundle.conversationStore })
    : null

  const wrapApi: WrapApiServer = await startWrapApi({
    port: wrapApiPort,
    hostname: '127.0.0.1',
    adapters: {
      // /v1/llm/complete — direct Anthropic SDK (matches LLMAdapter.complete shape:
      // { messages, system, model, max_tokens, temperature, signal }). The
      // proactive subsystem's ModelRouter uses a different request shape
      // (task_type + prompt), so we don't bridge to it here.
      llm: { complete: (body) => llmAdapter.complete(body) },

      // /v1/voice/chat — chat completion routed through VoiceAdapter, which
      // handles ConversationStore history + persona system prompt. When voice
      // is disabled, return a clear "not enabled" payload.
      voice: voiceAdapter
        ? { chat: (b) => voiceAdapter.chat(b), cancel: async () => voiceAdapter.cancel() }
        : { chat: async () => ({ text: 'voice not enabled', speakId: 'spk_disabled' }), cancel: async () => {} },

      // /v1/memory/* — backed by EpisodicStore.record / .recall (hybrid FTS +
      // vector). Available only when the memory subsystem is enabled.
      memory: {
        append: async (b: { source?: string; text?: string }) => {
          const store = (globalThis as { __kairosEpisodicStore?: EpisodicStore }).__kairosEpisodicStore
          if (!store) return { error: 'memory subsystem not enabled' }
          const id = await store.record({ source: b.source ?? 'wrap-api', text: b.text ?? '' })
          return { id }
        },
        get: async (b: { query?: string; limit?: number }) => {
          const store = (globalThis as { __kairosEpisodicStore?: EpisodicStore }).__kairosEpisodicStore
          if (!store) return { error: 'memory subsystem not enabled', hits: [] }
          const hits = await store.recall(b.query ?? '', b.limit ?? 8)
          return { hits }
        },
      },

      // /v1/orders/* — backed by OrdersStore v2. The plan's "add/list/disable"
      // verbs map to upsert/listAll/remove on the actual store.
      orders: {
        add: async (b: any) => {
          const store = (globalThis as any).__kairosOrdersV2Store
          if (!store) return { error: 'orders subsystem not enabled' }
          // Body is expected to be a Rule (or { rule: Rule }); accept either.
          const rule = b?.rule ?? b
          if (!rule || !rule.slug) return { error: 'rule.slug required' }
          store.upsert(rule)
          return { slug: rule.slug }
        },
        list: async () => {
          const store = (globalThis as any).__kairosOrdersV2Store
          if (!store) return []
          return store.listAll()
        },
        disable: async (slug: string) => {
          const store = (globalThis as any).__kairosOrdersV2Store
          if (!store) return { error: 'orders subsystem not enabled' }
          store.remove(slug)
          return { slug, disabled: true }
        },
      },

      // /v1/composio/* — backed by ConnectionStore (state) and ConnectionFlow
      // (OAuth initiation). Plan's verbs adapted:
      //   listConnections → connectionStore.listByUser('local')
      //   connect         → connectionFlow.connect({ userId: 'local', toolkitSlug })
      //   disconnect      → connectionStore.markStatus + remove (no disconnect on flow)
      composio: {
        listConnections: async () => {
          const store = (globalThis as any).__kairosConnectionStore
          if (!store) return []
          return store.listByUser('local')
        },
        connect: async (b: { toolkit?: string; toolkitSlug?: string }) => {
          const flow = (globalThis as any).__kairosConnectionFlow
          if (!flow) return { error: 'composio subsystem not enabled' }
          const toolkitSlug = b.toolkitSlug ?? b.toolkit
          if (!toolkitSlug) return { error: 'toolkit/toolkitSlug required' }
          return flow.connect({ userId: 'local', toolkitSlug })
        },
        disconnect: async (b: { toolkit?: string; toolkitSlug?: string }) => {
          const store = (globalThis as any).__kairosConnectionStore
          if (!store) return { error: 'composio subsystem not enabled' }
          const toolkitSlug = b.toolkitSlug ?? b.toolkit
          if (!toolkitSlug) return { error: 'toolkit/toolkitSlug required' }
          store.markStatus('local', toolkitSlug, 'revoked')
          store.remove('local', toolkitSlug)
          return { toolkit: toolkitSlug, disconnected: true }
        },
      },

      // /v1/settings/* — read-only snapshot of the daemon config. Update is a
      // no-op stub (Phase E.2 doesn't yet need live settings mutation).
      settings: {
        get: async () => ({ ...config }),
        update: async (_b: any) => ({ updated: [] }),
      },
    },
  })
  log(`[wrap-api] ${wrapApi.baseUrl} — /v1/* surface ready`)

  // Bind the deferred broadcast now that wrapApi exists — canonical TTS audio
  // (tts_begin/chunk/end/abort frames) flows to WS clients from here on.
  deferredBroadcast = (event) => wrapApi.broadcast(event as any)

  // When did OUR TTS last stop? The VAD can self-trigger a "barge_in" on KAIROS's
  // own tail audio / echo right after it stops speaking (diagnosis #4-truncation:
  // a barge_in fired +89ms after a reply finished, with NO transcribed user speech,
  // clipping the tail). We debounce barge-in for a short window after TTS ends so a
  // self-trigger can't cut the reply; a REAL interruption lands DURING TTS (large
  // elapsed-since-end) and is unaffected.
  let lastTtsEndAt = 0
  const BARGE_DEBOUNCE_MS = Number(process.env.KAIROS_BARGE_DEBOUNCE_MS) || 350

  // 10e. Wire voice conductor bus → wrap-API WebSocket broadcast.
  // bootstrapVoice() installs a no-op bus stub; swap it for one that pushes
  // events out to every connected /v1/voice/events WS client (Electron, etc.).
  if (voiceBundle) {
    voiceBundle.conductor.replaceBus({
      publish: (kind: string, payload: any) => {
        const event = voiceEventName(kind)
        if (event === 'tts_end' || event === 'tts_abort') lastTtsEndAt = Date.now()
        wrapApi.broadcast({ event, ...payload })
      },
    })
    log('[voice] conductor bus wired to wrap-API WebSocket broadcast')

    // 10f. E.2.1 — Construct the agent Conductor and wire it to VoiceConductor.
    // The agent Conductor takes over utterance handling: classify → fast/smart
    // route → emit agent_* events. Phase E.2.3 / Task 3.4 swapped the stub
    // ContextBuilder for the real layered-context builder + introspection tools.
    //
    // The agent LLM completer talks to OpenRouter directly (per-tier model
    // from KAIROS_*_MODEL env vars). ModelRouter is not used here because it
    // doesn't have an OpenRouter provider — its BYO mode tries claude CLI →
    // ollama → openai-direct, none of which respect our agent model choices.

    // SoulDigestLoader: reads ~/.kairos/soul.md (or KAIROS_SOUL_PATH override).
    const soulLoader = new SoulDigestLoader({
      soulPath: process.env.KAIROS_SOUL_PATH ?? join(homedir(), '.kairos', 'soul.md'),
      maxTokens: 200,
    })

    // Introspection tools — kairos_* tools the LLM can call to reflect on
    // its own state (persona, skills, orders, memory, dreams, connections).
    // Each dep tolerates missing globalThis stashes and returns empty/null.
    const introspectionTools = buildIntrospectionTools({
      soulLoader,
      skillRegistry: {
        listActive: async () => {
          const reg = (globalThis as any).__kairosSkillRegistry
          if (!reg) return []
          const skills =
            typeof reg.activeSkills === 'function' ? await reg.activeSkills()
            : typeof reg.listActive === 'function' ? await reg.listActive()
            : typeof reg.listSkills === 'function' ? reg.listSkills()
            : []
          return skills.map((s: any) => ({ id: s.id ?? s.slug ?? s.name, description: s.description }))
        },
      },
      ordersStore: {
        list: async () => {
          const store = (globalThis as any).__kairosOrdersV2Store
          if (!store) return []
          const rules = typeof store.listAll === 'function' ? await store.listAll() : []
          return rules.map((r: any) => ({ id: r.id ?? r.slug, slug: r.slug, yaml: r.yaml ?? r.rule ?? '' }))
        },
      },
      semanticMemory: {
        add: async (entry: { subject: string; body: string; importance?: number }) => {
          const mem = (globalThis as any).__kairosSemanticMemory
          if (!mem || typeof mem.add !== 'function') return { id: 0 }
          return mem.add(entry)
        },
        search: async (q: string, n: number) => {
          const recall = (globalThis as any).__kairosRecall
          if (!recall) return []
          try { return await recall.hybrid(q, n) } catch { return [] }
        },
      },
      episodicMemory: {
        recent: async (n: number) => {
          const ep = (globalThis as any).__kairosEpisodicMemory ?? (globalThis as any).__kairosEpisodicStore
          if (!ep) return []
          try {
            if (typeof ep.recent === 'function') return ep.recent(n)
            return []
          } catch { return [] }
        },
        search: async (q: string, n: number) => {
          const ep = (globalThis as any).__kairosEpisodicStore ?? (globalThis as any).__kairosEpisodicMemory
          if (!ep) return []
          try {
            if (typeof ep.recall === 'function') return ep.recall(q, n)
            if (typeof ep.search === 'function') return ep.search(q, n)
            return []
          } catch { return [] }
        },
      },
      memoryStore: {
        read: async () => {
          const ms = (globalThis as any).__kairosMemoryStore
          if (!ms || typeof ms.read !== 'function') return '(empty)'
          try { return ms.read() } catch { return '(empty)' }
        },
      },
      dreamLog: {
        last: async () => {
          const dl = (globalThis as any).__kairosDreamLog ?? (globalThis as any).__kairosDreamer
          if (!dl) return null
          try {
            if (typeof dl.last === 'function') return dl.last()
            if (typeof dl.lastDream === 'function') return dl.lastDream()
            return null
          } catch { return null }
        },
        search: async () => [],
      },
      connectionStore: {
        list: async () => {
          const cs = (globalThis as any).__kairosConnectionStore
          if (!cs) return []
          try {
            const conns =
              typeof cs.listByUser === 'function' ? await cs.listByUser('local')
              : typeof cs.list === 'function' ? await cs.list()
              : []
            return conns.map((c: any) => ({
              toolkit: c.toolkit ?? c.toolkit_slug ?? c.toolkitSlug,
              status: c.status,
            }))
          } catch { return [] }
        },
      },
      // Persona profile writer — backs the kairos_remember_preference tool so the
      // agent can persist user preferences mid-conversation (→ ## About the user).
      personaUpdater: {
        recordNudge: (nudge: string) => {
          const pu = (globalThis as any).__kairosPersonaUpdater
          if (!pu?.recordNudge) throw new Error('personaUpdater not available')
          return pu.recordNudge(nudge)
        },
      },
      // Daily diary reader — backs kairos_daily_log.
      dailyNarrative: {
        recent: (n: number) => {
          const dn = (globalThis as any).__kairosDailyNarrative
          return dn?.recent ? dn.recent(n) : []
        },
      },
      // "what did you do yesterday" — the durable activity log (voice answer only).
      activityStore: {
        query: (range, opts) => activityStore.query(range, opts),
        digest: (items) => activityStore.digest(items as any),
      },
    })

    // Real layered ContextBuilder — session-prefix cache (persona / orders /
    // memory overview / tools) plus per-turn delta (recent conversation +
    // injected memory hits).
    const contextBuilder = new ContextBuilder({
      loaders: {
        soulDigest: () => soulLoader.load(),
        standingOrdersSummary: async () => {
          const store = (globalThis as any).__kairosOrdersV2Store
          if (!store) return ''
          try {
            const orders = typeof store.listAll === 'function' ? await store.listAll() : []
            if (orders.length === 0) return ''
            return orders.map((o: any) =>
              `- ${o.slug ?? o.id}: ${(o.yaml ?? o.rule ?? '').toString().slice(0, 80)}`,
            ).join('\n')
          } catch { return '' }
        },
        memoryOverview: async () => {
          const parts: string[] = []
          // The human-distilled MEMORY.md overview, if present.
          const ms = (globalThis as any).__kairosMemoryStore
          if (ms && typeof ms.read === 'function') {
            try { const raw = ms.read(); parts.push(raw.length > 3000 ? raw.slice(0, 3000) + '\n...(truncated)' : raw) } catch {}
          }
          // LIVE top facts from the semantic store — the always-on "what I know
          // about you" set, so KAIROS has the user's key facts EVERY turn (not just
          // utterance-relevant ones). Makes replies feel personalized, not gated.
          const ss = (globalThis as any).__kairosSemanticStore
          if (ss && typeof ss.topFacts === 'function') {
            try {
              const facts = ss.topFacts(8)
              if (facts.length) parts.push('What I know about the user:\n' + facts.map((f: any) => `- ${f.text}`).join('\n'))
            } catch {}
          }
          return parts.filter(Boolean).join('\n\n')
        },
        // "## About the user" — the learned persona profile + live preference hints.
        // This is the Tier-1 personalization fix: persona.md data (communication
        // style, preferences, work patterns) + derived hints (prefer_terse, etc.)
        // now reach the agent's system prompt, so replies actually adapt to the user.
        aboutUser: async () => {
          try {
            const pu = (globalThis as any).__kairosPersonaUpdater
            const pa = (globalThis as any).__kairosPersonaAwareness
            const p = pu?.get?.() ?? {}
            const h = pa?.getHints?.() ?? {}
            const lines: string[] = []
            if (p.communication_style) lines.push(`- Communication style: ${p.communication_style}`)
            if (p.preferences)         lines.push(`- Preferences: ${p.preferences}`)
            if (p.working_patterns)    lines.push(`- Working patterns: ${p.working_patterns}`)
            if (p.recent_themes)       lines.push(`- Recent themes: ${p.recent_themes}`)
            if (p.notes)               lines.push(`- Notes: ${p.notes}`)
            // NOTE: volatile hint-derived directives moved to the per-turn
            // `liveContext` loader below so they refresh every turn (this block is
            // cached in the session prefix and would otherwise go stale).
            void h
            return lines.join("\n")
          } catch { return '' }
        },
        // VOLATILE per-turn behavioral directives from live persona hints — fetched
        // FRESH every turn (not cached), so KAIROS adapts within a session (e.g. the
        // user enters focus mid-conversation → it gets quieter on the very next turn).
        liveContext: async () => {
          try {
            const pa = (globalThis as any).__kairosPersonaAwareness
            const h = pa?.getHints?.() ?? {}
            const directives: string[] = []
            if (h.prefer_terse) directives.push("Keep replies short and direct — no preamble or filler.")
            if (h.prefer_voice_over_text) directives.push("Favor a natural spoken cadence.")
            if (h.in_focus_now) directives.push("The user is focused/in flow right now — be minimal and non-disruptive.")
            return directives.length ? "- How to respond right now: " + directives.join(" ") : ""
          } catch { return '' }
        },
        // LIVE connected-toolkit list → "Connected apps: Gmail (gmail), Notion (notion)…" in
        // every turn. The model instantly knows what's connected, what to call each app in
        // search_tools queries, and that anything else needs connecting first.
        connectedApps: async () => {
          try { return ((globalThis as any).__kairosConnectedToolkits?.() ?? []) as string[] } catch { return [] }
        },
        kairosSkills: async () => {
          // Prefer AWM (agentskills.io) registry — that's what the SkillDispatcher
          // resolves against. Fall back to the legacy manifest-based registry.
          const reg = (globalThis as any).__kairosAwmSkillRegistry
            ?? (globalThis as any).__kairosSkillRegistry
          const disp = (globalThis as any).__kairosSkillDispatcher
          if (!reg || !disp) return []
          try {
            // The two registries expose different list methods; normalize.
            let rawList: any[] = []
            if (typeof reg.activeSkills === 'function') {
              const out = reg.activeSkills()
              rawList = Array.isArray(out) ? out : await out
            } else if (typeof reg.listActiveMetadata === 'function') {
              rawList = reg.listActiveMetadata()
            } else if (typeof reg.listSkills === 'function') {
              rawList = reg.listSkills()
            }
            // Normalize entries to { id, name, description, parameters }
            const skills = rawList.map((s: any) => ({
              id: s.id ?? s.slug ?? s.name,
              name: s.name,
              description: s.description,
              parameters: s.parameters,
            }))
            // SkillDispatcher exposes .invoke(); the adapter expects .dispatch().
            const dispatcherShim = {
              dispatch: async (id: string, args: any) => {
                if (typeof disp.dispatch === 'function') return disp.dispatch(id, args)
                if (typeof disp.invoke === 'function') return disp.invoke(id, args ?? {})
                throw new Error('skill dispatcher has no dispatch/invoke method')
              },
            }
            return skillsAsTools({ activeSkills: () => skills } as any, dispatcherShim as any)
          } catch { return [] }
        },
        introspectionTools: async () => introspectionTools,
        // The planner's ACTION toolset — kept SMALL and static (the dispatcher
        // pattern: Composio Tool Router / Anthropic Tool Search):
        //  1. Agency intents (connect_service, disconnect_service, setup_for,
        //     remind_in, MCP tools). Hidden: add_to_memory (automatic), log/
        //     suspend/notify (internal).
        //  2. search_tools + execute_tool — the planner finds the right connected
        //     tool per turn via hybrid retrieval (ToolRetriever), then runs it.
        //     This replaces pre-loading all toolkit tools, so it scales to 50+
        //     connected toolkits without context bloat.
        actionTools: async () => {
          const out: any[] = []
          const reg = (globalThis as any).__kairosIntentRegistry
          const dispatch = (globalThis as any).__kairosIntentDispatch
          if (reg && dispatch) {
            const HIDDEN = new Set(['add_to_memory', 'log', 'suspend', 'notify'])
            try { out.push(...intentsAsTools({ registry: reg, dispatch, filter: (e: any) => !HIDDEN.has(e.id) })) }
            catch (e) { log('[actionTools] intent bridge failed: ' + String(e), 'warn') }
          }
          const retriever = (globalThis as any).__kairosToolRetriever
          const execFn = (globalThis as any).__kairosComposioExecute
          if (retriever && execFn) {
            try {
              const { searchTool, executeTool } = buildToolDispatchTools({ retriever, execute: execFn })
              out.push(searchTool, executeTool)
              // HOT SET: the user's most-used tools, loaded DIRECTLY so common
              // actions ("send email", "create event") skip the search→execute hop
              // (faster + fewer multi-step fumbles). Read-only ones run concurrently.
              const usage = (globalThis as any).__kairosToolUsage
              if (usage && typeof retriever.getByNames === 'function') {
                const hotN = Number(process.env.KAIROS_HOT_TOOLS) || 5
                for (const d of retriever.getByNames(usage.topNames(hotN)) as any[]) {
                  out.push({
                    name: d.name,
                    description: d.description,
                    parameters: (d.parameters && typeof d.parameters === 'object' && d.parameters.type) ? d.parameters : { type: 'object', properties: {}, required: [] },
                    execute: async (args: any) => execFn(d.name, args ?? {}),
                    concurrencySafe: /(_LIST|_GET|_SEARCH|_FETCH|_READ|LIST_|GET_|SEARCH_|FIND_)/i.test(d.name),
                  })
                }
              }
            } catch (e) { log('[actionTools] tool dispatch bridge failed: ' + String(e), 'warn') }
          } else {
            // Loud signal: without these the planner has NO Composio actions at all.
            log('[actionTools] search_tools/execute_tool NOT available (Composio subsystem not started?) — planner has no external-app tools', 'warn')
          }
          // Background agent lane (Batch 2): the foreground voice agent gets
          // spawn_background_task (offload heavy/long work to an autonomous sub-agent
          // so the conversation isn't blocked) + background_tasks (check on running
          // sub-agents → answer "how's my task going?" in human language). Read from
          // the stash since the manager is constructed AFTER the ContextBuilder.
          const bgManager = (globalThis as any).__kairosBackgroundManager
          if (bgManager) {
            try { out.push(...buildBackgroundTools({ manager: bgManager })) }
            catch (e) { log('[actionTools] background tools failed: ' + String(e), 'warn') }
          }
          // JIT memory recall: the per-turn delta injects memory keyed on the UTTERANCE;
          // recall_memory lets the planner pull memory MID-TASK with its own query
          // (stored preferences, past decisions, harvested learnings).
          const memInj = (globalThis as any).__kairosMemoryInjector
          if (memInj) {
            try { out.push(buildRecallTool({ injector: memInj })) }
            catch (e) { log('[actionTools] recall_memory failed: ' + String(e), 'warn') }
          }
          // Web access (free, keyless): web_search + read_webpage. Always available —
          // the 2026-06-10 "research flights" session had NO research capability and
          // the planner hallucinated instead. KAIROS_WEB_SEARCH=0 disables.
          if (process.env.KAIROS_WEB_SEARCH !== '0') {
            try { out.push(...buildWebTools()) }
            catch (e) { log('[actionTools] web tools failed: ' + String(e), 'warn') }
          }
          // Guide Mode: guide_user points at on-screen elements via the HUD overlay
          // (the orb morphs into a guide); open_app launches the app first when needed
          // (argv-only `open -a` — no shell, no injection surface).
          const guideB = (globalThis as any).__kairosGuideBridge
          if (guideB) {
            const guideL = (globalThis as any).__kairosGuideLesson
            try {
              out.push(...buildGuideTools({
                bridge: guideB,
                // Durable guide session: points feed the lesson/highlight state that
                // survives turns; end_lesson appears in the toolset when wired.
                lesson: guideL ? {
                  notePoint: (p: any, note?: string) => guideL.notePointFromTool(p, note),
                  noteStepDone: () => guideL.noteStepDone(),
                  // endRequestFromModel REFUSES (returns false) when no step is done
                  // yet — the model declaring victory at the first point killed the
                  // highlight 8s into a live lesson.
                  endLesson: (reason: string) => guideL.endRequestFromModel(reason),
                } : undefined,
                openApp: async (name: string) => {
                  try {
                    const proc = Bun.spawn(['open', '-a', name], { stdout: 'ignore', stderr: 'pipe' })
                    const code = await proc.exited
                    if (code === 0) return { ok: true }
                    const err = await new Response(proc.stderr).text().catch(() => '')
                    return { ok: false, error: err.trim().slice(0, 120) || `exit ${code}` }
                  } catch (e) { return { ok: false, error: (e as Error).message } }
                },
              }))
            }
            catch (e) { log('[actionTools] guide tools failed: ' + String(e), 'warn') }
          }
          const seen = new Set<string>()
          return out.filter((t: any) => t?.name && !seen.has(t.name) && (seen.add(t.name), true))
        },
      },
      memoryInjector: {
        inject: async (q: string, opts?: any) => {
          const inj = (globalThis as any).__kairosMemoryInjector
          if (!inj) return []
          try { return await inj.inject(q, opts) } catch { return [] }
        },
      },
      conversationStore: {
        recentTurns: async (id: string, n: number) => {
          try { return await voiceBundle!.conversationStore.recentTurns(id, n) }
          catch { return [] }
        },
      },
      // Phase 5: optional one-line tone override layered onto the baseline character
      // (warm/witty/concise). soul.md's vibe still takes precedence over both.
      personaTone: process.env.KAIROS_PERSONA_TONE,
    })

    // Expose prefix invalidation so connection-complete events can refresh the
    // planner's toolset — a newly-connected toolkit's tools won't appear until
    // the cached session prefix is rebuilt.
    ;(globalThis as any).__kairosInvalidatePrefix = () => { try { contextBuilder.invalidatePrefix() } catch {} }

    // E.2.4 — Wire a StreamingSpeaker on top of the existing sayBackend so the
    // Narrator's ack/transition/filler output gets piped through the same
    // sentence-by-sentence speaking pipeline the streaming LLM uses. Each
    // Narrator.speak* call awaits feed + end so phrases serialize cleanly.
    // When canonical streaming TTS is active, the StreamingTtsBackend owns its
    // own provider voice config (KAIROS_TTS_VOICE) — do NOT pass the Apple
    // `say` voice name here or it leaks into the provider as a bogus model id
    // (e.g. Deepgram rejected 'Zoe (Premium)' as an invalid model value).
    // ONE authoritative "KAIROS is audibly speaking" signal for the HUD orb:
    // renderer playback acks (ground truth) overlaid on the speaker's synthesis
    // envelope (fallback). Broadcasts `agent_speaking {speaking}` on change only —
    // the per-phrase tts_begin/tts_end events made the orb strobe every sentence.
    const speakingState = new SpeakingStateTracker({
      broadcast: (e) => { try { wrapApi.broadcast(e as any) } catch { /* */ } },
    })

    // GUIDE MODE bridge: guide_user tool ⇄ HUD overlay (orb morphs into an on-screen
    // pointer). Requests go out as guide_request events; the HUD answers with a
    // guide_result command; turn end retracts the guide (guide_end).
    const guideBridge = new GuideBridge({
      broadcast: (e) => {
        try {
          wrapApi.broadcast(e as any)
          // One line per guide round-trip: which request went out and to how many
          // clients. "→ 1 client(s)" with the HUD visibly running = the one-way
          // zombie (HUD evicted/dropped from the broadcast set) — a class of bug
          // that burned hours while every other log looked healthy.
          log(`[guide] broadcast ${String((e as any).event)} → ${wrapApi.clientCount()} client(s)`)
        } catch { /* */ }
      },
    })
    ;(globalThis as any).__kairosGuideBridge = guideBridge

    // GUIDE SESSION MANAGER: owns the guide lifecycle ACROSS turns. Lessons persist
    // (highlight stays up between steps; a between-turns screen watcher injects an
    // auto-continue turn when the user clicks); standalone highlights persist until
    // the user speaks or acts. continueLesson is late-bound — handleUtterance is
    // defined further down; the ref is assigned right after it.
    let lessonContinueFn: ((cid: string) => void) | undefined
    const guideLesson = new GuideLessonManager({
      watchChange: async (app, timeoutMs) => {
        const r = await guideBridge.requestWatchChange({ app, timeoutMs })
        return !!r?.found
      },
      continueLesson: (cid) => { try { lessonContinueFn?.(cid) } catch { /* */ } },
      retractGuide: () => guideBridge.endIfActive(),
      log: (m) => log(`[voice] ${m}`),
    })
    ;(globalThis as any).__kairosGuideLesson = guideLesson

    const streamingSpeaker = new StreamingSpeaker({
      backend: voiceBundle.sayBackend,
      voice: voiceBundle.streamingTts ? undefined : (process.env.KAIROS_VOICE_NAME ?? 'Zoe (Premium)'),
      rate: voiceBundle.streamingTts ? undefined : Number(process.env.KAIROS_VOICE_RATE ?? 180),
      onSpeaking: (s) => speakingState.reportSynthesis(s),
    })

    // E.2.5 — Dynamic Composio + self-healing connect
    // composioSearchTool is a meta-tool the LLM calls when it needs a toolkit
    // not already in its tool list. SelfHealConnect handles the OAuth flow
    // when a tool call fails with NOT_CONNECTED.
    const composioCache = new ComposioToolCache()

    const composioClient = (globalThis as any).__kairosComposioClient
    const actionDispatcher = (globalThis as any).__kairosActionDispatcher
    const connectionFlow = (globalThis as any).__kairosConnectionFlow
    const connectionStore = (globalThis as any).__kairosConnectionStore

    const composioSearchTool = buildComposioSearchTool({
      composio: {
        searchTools: async (q: string, limit: number) => {
          if (!composioClient) return []
          try {
            // @composio/core@0.10.0 has NO sdk.tools.search; the real public-API
            // search is getRawComposioTools({ search }). It REQUIRES a filter — an
            // unfiltered { limit } throws ValidationError (the old code's silent []).
            // Pass `search` so the catalog is actually queried server-side.
            const sdk = composioClient.sdk
            if (sdk?.tools?.getRawComposioTools && typeof sdk.tools.getRawComposioTools === 'function') {
              const r: any = await sdk.tools.getRawComposioTools({ search: q, limit })
              const items: any[] = Array.isArray(r) ? r : (r?.items ?? [])
              return items
                .slice(0, limit)
                .map((t: any) => ({
                  slug: t.slug ?? t.name,
                  description: t.description ?? '',
                  parameters: t.inputParameters ?? t.input_parameters ?? t.inputSchema,
                  toolkit: t.toolkit?.slug ?? t.toolkit_slug,
                }))
            }
            return []
          } catch (e) {
            log(`[composio] search_tools failed for '${q}': ${String(e)}`, 'warn')
            return []
          }
        },
        executeTool: async (slug: string, args: any) => {
          if (!composioClient) return { error: 'no composio client' }
          try {
            // ComposioClient.executeTool takes { toolName, userId, arguments }
            if (typeof composioClient.executeTool === 'function') {
              return composioClient.executeTool({ toolName: slug, userId: 'local', arguments: args ?? {} })
            }
            if (actionDispatcher && typeof actionDispatcher.dispatch === 'function') {
              return actionDispatcher.dispatch(slug, args)
            }
            return { error: 'no executor' }
          } catch (e) { return { error: (e as Error).message } }
        },
      } as any,
      cache: composioCache,
    })

    const selfHeal = new SelfHealConnect({
      composio: {
        initiateConnection: async ({ toolkit }) => {
          if (!connectionFlow) throw new Error('connectionFlow not available')
          if (typeof connectionFlow.connect === 'function') {
            const r = await connectionFlow.connect({ userId: 'local', toolkitSlug: toolkit })
            return {
              connection_id: (r as any).connection_id ?? (r as any).id,
              redirect_url: (r as any).redirect_url ?? (r as any).redirectUrl ?? '',
            }
          }
          throw new Error('no connect method on connectionFlow')
        },
        getConnection: async (id) => {
          if (!connectionStore) return { status: 'FAILED' }
          try {
            if (typeof connectionStore.get === 'function') return connectionStore.get(id)
            if (typeof connectionStore.findById === 'function') return connectionStore.findById(id)
            const all = typeof connectionStore.listByUser === 'function' ? connectionStore.listByUser('local') : []
            return all.find((c: any) => c.id === id || c.connection_id === id) ?? { status: 'PENDING' }
          } catch { return { status: 'FAILED' } }
        },
      },
      pollIntervalMs: 2000,
      maxWaitMs: 120_000,
    })

    // Stash for future inline-on-error wiring at the action-dispatch layer
    ;(globalThis as any).__kairosSelfHealConnect = selfHeal
    ;(globalThis as any).__kairosComposioToolCache = composioCache
    // Stash the search meta-tool so the ContextBuilder's actionTools loader can
    // expose it to the planner (discovery of not-yet-connected toolkits).
    ;(globalThis as any).__kairosComposioSearchTool = composioSearchTool

    // Captures the agent's final reply text each turn (from agent_done) so
    // handleUtterance can persist it to the ConversationStore for memory.
    let lastAgentReply = ''

    // Real-time fact extractor — pulls durable user facts into L3 immediately
    // (not just on the ~5min idle cycle), so KAIROS remembers things you said
    // seconds ago within the same conversation. Fire-and-forget per turn.
    const realtimeFactExtractor = (() => {
      const fw = (globalThis as any).__kairosFactWriter
      if (!fw?.write) return undefined
      return new RealtimeFactExtractor({
        llm: buildMemoryLlmCompleter(),  // KAIROS_MEMORY_MODEL (→ fast → gpt-4o-mini)
        factWriter: fw,
        log: (m: string) => log(m),
      })
    })()

    // Preference-nudge detector — reliably captures "from now on…/keep replies
    // short" into persona.md regardless of tier (the fast tier has no tools, so a
    // kairos_remember_preference tool call can't fire there). Fire-and-forget.
    const preferenceNudgeDetector = (() => {
      const pu = (globalThis as any).__kairosPersonaUpdater
      if (!pu?.recordNudge) return undefined
      return new PreferenceNudgeDetector({
        llm: buildMemoryLlmCompleter(),  // KAIROS_MEMORY_MODEL
        personaUpdater: pu,
        log: (m: string) => log(m),
      })
    })()

    // ForgetDetector — the DELETE half of the automatic memory lifecycle. Per-turn,
    // soft-deletes memories the user asks to forget (confirm-first for important/vague).
    const forgetDetector = (() => {
      const ss = (globalThis as any).__kairosSemanticStore
      if (!ss?.forget) return undefined
      return new ForgetDetector({
        llm: buildMemoryLlmCompleter(),
        semanticStore: ss,
        episodicStore: (globalThis as any).__kairosEpisodicStore,
        personaUpdater: (globalThis as any).__kairosPersonaUpdater,
        log: (m: string) => log(m),
      })
    })()

    // PendingResolver — closes the confirm loop: when the user answers a pending
    // "confirm before deleting?" ask, this executes (or cancels) the deferred op.
    // Runs BEFORE the forget/extract detectors each turn.
    const pendingResolver = (() => {
      const ss = (globalThis as any).__kairosSemanticStore
      if (!ss?.livePending) return undefined
      return new PendingResolver({
        llm: buildMemoryLlmCompleter(),
        semanticStore: ss,
        episodicStore: (globalThis as any).__kairosEpisodicStore,
        log: (m: string) => log(m),
      })
    })()
    ;(globalThis as any).__kairosForgetDetector = forgetDetector
    ;(globalThis as any).__kairosPendingResolver = pendingResolver

    // Observability: every turn (utterance, tier, tools actually called + results,
    // reply) → a human-readable conversation.log + machine-readable turns.jsonl.
    // Lets you verify what KAIROS really did and auto-flags tool-call leaks.
    const convLogPath = join(config.sandboxDir, 'state', 'logs', 'conversation.log')
    const turnsJsonlPath = join(config.sandboxDir, 'state', 'logs', 'turns.jsonl')
    const turnLogger = new TurnLogger({
      appendLine: (l: string) => { try { appendFileSync(convLogPath, l + '\n') } catch {} },
      appendJsonl: (o: any) => { try { appendFileSync(turnsJsonlPath, JSON.stringify(o) + '\n') } catch {} },
    })

    // ─── Background agent lane (Batch 2) ──────────────────────────────────────
    // KAIROS can spawn autonomous sub-agents for heavy/long work so the foreground
    // voice stays free. Each sub-agent reuses the SAME context the foreground gets
    // (memory + persona + skills + Composio tools via contextBuilder.build), and
    // ADDS file/shell tools (private workdir), nested-spawn, and approval-gating on
    // every destructive call. It runs OUR agent loop on the DEEP model and reports
    // back by speaking a summary + emitting task_* events for the UI/HUD. The
    // foreground gets spawn_background_task + background_tasks so it can launch them
    // and answer "how's my task going?" in human language.
    const backgroundSub = buildBackgroundSubsystem({
      buildContext: (goal: string, o?: { conversationId?: string }) => contextBuilder.build({ utterance: goal, tier: 'smart', conversationId: o?.conversationId }),
      makeLlm: (model: string) => new OpenRouterAdapter({ defaultModel: model, usageLabel: 'subagent' }) as any,
      deepModel: () => TIER_MODELS.deep(),
      fastModel: () => process.env.KAIROS_MEMORY_MODEL ?? TIER_MODELS.fast(),
      agentsDir: join(config.sandboxDir, 'state', 'agents'),
      exec: (command: string, o: { cwd: string; timeoutMs: number }) =>
        new Promise((resolveExec) => {
          nodeExec(command, { cwd: o.cwd, timeout: o.timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
            const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0
            resolveExec({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code })
          })
        }),
      fs: {
        readFile: (p: string) => fsReadFile(p, 'utf8'),
        writeFile: (p: string, c: string) => fsWriteFile(p, c, 'utf8').then(() => {}),
        readdir: (p: string) => fsReaddir(p) as Promise<string[]>,
        realpath: (p: string) => realpathSync(p), // enables symlink-escape guard in safePath
        stat: async (p: string) => { const s = await fsStat(p); return { isDirectory: s.isDirectory(), isFile: s.isFile(), size: s.size, mtimeMs: s.mtimeMs } }, // powers grep/glob walk
      },
      speak: async (t: string) => {
        // The StreamingSpeaker is SHARED with the foreground. begin() wipes its queue,
        // so a background ask/report mid-foreground-turn would splice the user's reply.
        // Wait for the foreground turn to go idle (capped so a wedged turn can't mute
        // reports forever), then speak. The WS event already fired, so the HUD shows it
        // immediately regardless of this spoken delay.
        const idle = () => !activeConductorController || activeConductorController.signal.aborted
        for (let i = 0; i < 200 && !idle(); i++) await new Promise((r) => setTimeout(r, 50)) // up to ~10s
        streamingSpeaker.begin(); streamingSpeaker.feed(t); await streamingSpeaker.end()
      },
      broadcast: (e: any) => { try { wrapApi.broadcast(e) } catch { /* */ } },
      // Learnings harvest: the sub-agent's final "Learning: …" line lands in the L2
      // episodic store (source 'learning') → recalled by the context delta and the
      // recall_memory tool next time a similar task runs.
      learnings: {
        record: async (input: { source: string; text: string }) => {
          const store = (globalThis as any).__kairosEpisodicStore
          if (store?.record) return store.record(input)
        },
      },
      inbox: (req) => {
        const ib = (globalThis as any).__kairosInbox
        try {
          // intent_id carries the gate req.id so a non-voice approve can resolve the
          // exact parked action. Voice ("yes"/name it) already resolves it; the inbox
          // UI/HUD approve path resolves via __kairosResolveBgApproval(reqId, approved).
          ib?.add?.({
            tier: 'ORANGE',
            intent_id: `bg_approval:${req.id}`,
            description: `Background task wants to ${req.summary}`,
            args_preview: JSON.stringify({ toolName: req.toolName, args: req.args ?? {} }).slice(0, 400),
          })
        } catch { /* */ }
      },
      appendTraj: (runId: string, entry: any) => {
        // (1) Raw JSONL for inspection/debugging.
        try {
          const dir = join(config.sandboxDir, 'traj')
          mkdirSync(dir, { recursive: true })
          appendFileSync(join(dir, 'subagents.jsonl'), JSON.stringify({ runId, ...entry, at: Date.now() }) + '\n')
        } catch { /* */ }
        // (2) Feed the SAME persona TrajWriter the foreground uses, so the AWM
        // self-evolving-skills worker mines recurring sub-agent workflows too
        // (clusters on intent_id + tool sequence; needs >5 tools, >30s, success).
        try {
          const tw = (globalThis as any).__kairosTrajWriter
          if (tw && typeof tw.record === 'function') {
            tw.record({
              ts: Date.now(),
              task_goal: String(entry.goal ?? ''),
              intent_id: 'subagent',
              args_summary: String(entry.goal ?? '').slice(0, 200),
              steps: (entry.toolCalls ?? []).map((c: any) => ({
                action: String(c.name ?? 'tool'),
                result_summary: c.error ? `error: ${String(c.error)}`.slice(0, 200) : 'ok',
              })),
              // `stopped` is a TERMINATION cause, not a success signal: a long,
              // tool-heavy run that exhausts max_turns but produced a real answer
              // is a SUCCESS (and is exactly the >5-tool/>30s profile AWM mines).
              // Only genuine non-successes (user abort, stream error) are excluded.
              outcome: (entry.stopped === 'final' || entry.stopped === 'max_turns') && String(entry.finalText ?? '').trim()
                ? 'success'
                : entry.stopped === 'aborted' ? 'cancelled'
                : entry.stopped === 'error' ? 'failed'
                : 'partial',
              duration_ms: Number(entry.durationMs) || 0,
            })
          }
        } catch { /* traj write must never break the lane */ }
        // (3) Durable ACTIVITY event so "what did you do yesterday" can name this
        // background run (the in-memory BgTask is evicted at 24 + lost on restart).
        try {
          const ok = (entry.stopped === 'final' || entry.stopped === 'max_turns') && String(entry.finalText ?? '').trim()
          activityStore.record({
            at: Date.now(),
            kind: 'subagent',
            lane: 'background',
            runId,
            tool: 'spawn_background_task',
            title: `Background: ${String(entry.goal ?? 'task').slice(0, 120)}`,
            detail: String(entry.finalText ?? '').slice(0, 600),
            status: entry.stopped === 'aborted' ? 'cancelled' : entry.stopped === 'error' ? 'failed' : ok ? 'done' : 'failed',
            importance: 0.8,
          })
        } catch { /* activity log is best-effort */ }
      },
      // R8: before a sub-agent runs, surface similar PAST successful runs (from the
      // raw subagents.jsonl, last ~150) so it reuses what worked. Bounded + best-effort.
      priorRunsHint: (goal: string) => {
        try {
          const p = join(config.sandboxDir, 'traj', 'subagents.jsonl')
          if (!existsSync(p)) return ''
          const tail = readFileSync(p, 'utf8').split('\n').slice(-150).join('\n')
          return buildPriorRunsHint(goal, parsePriorRuns(tail))
        } catch { return '' }
      },
      caps: {
        maxConcurrent: Number(process.env.KAIROS_BG_MAX_CONCURRENT) || 3,
        maxDepth: Number(process.env.KAIROS_BG_MAX_DEPTH) || 2,
        voiceWindowMs: Number(process.env.KAIROS_APPROVAL_WINDOW_MS) || 20_000,
      },
      mkdir: (dir: string) => { try { mkdirSync(dir, { recursive: true }) } catch { /* */ } },
      log: (m: string) => log(m),
    })
    ;(globalThis as any).__kairosBackgroundManager = backgroundSub.manager
    ;(globalThis as any).__kairosApprovalGate = backgroundSub.approvalGate
    // Non-voice (inbox/HUD/CLI) approval resolution. Inbox items carry intent_id
    // `bg_approval:<reqId>`; strip the prefix and call this to resolve the exact
    // parked action. Returns true if it matched a pending approval.
    ;(globalThis as any).__kairosResolveBgApproval = (reqId: string, approved: boolean): boolean => {
      try { return backgroundSub.approvalGate.resolve(String(reqId).replace(/^bg_approval:/, ''), approved) } catch { return false }
    }
    log(`[voice] background agent lane ready — deep=${TIER_MODELS.deep()} maxConcurrent=${Number(process.env.KAIROS_BG_MAX_CONCURRENT) || 3}`)

    // Durable full-message transcript (incl. tool results) — the "remember everything"
    // backbone for cross-turn replay. Shares the daemon's SQLite DB (state.db).
    const conversationMessageStore = new ConversationMessageStore(db)

    const agentConductor = new Conductor({
      classifyLlm: buildAgentLlmCompleter('fast'),
      fastLlm:     buildAgentLlmCompleter('fast'),
      smartLlm:    buildAgentLlmCompleter('smart'),
      thinkLlm:    buildAgentLlmCompleter('deep'),   // [[think]] fallback — blocking, time-capped
      // STREAMING think (the default path): deep answers stream sentence-by-sentence
      // to the speaker — the cap becomes a first-token deadline, so hard questions get
      // answered LIVE instead of converting to background. Reasoning stays internal
      // (the adapter excludes it from content), so deltas ARE the answer.
      thinkStream: (() => {
        const deepAdapter = new OpenRouterAdapter({ defaultModel: TIER_MODELS.deep(), usageLabel: 'voice_deep' })
        return (body: any) => deepAdapter.stream(body)
      })(),
      tools: [...introspectionTools, composioSearchTool, ...composioCache.asTools()],
      contextBuilder,
      turnLogger,
      // Router context — lets the classifier resolve "yes"/"do it"/follow-ups.
      conversationStore: {
        recentTurns: async (id: string, n: number) => {
          try { return await voiceBundle!.conversationStore.recentTurns(id, n) } catch { return [] }
        },
      },
      // Durable replay: seed the smart planner with prior real messages (tool results
      // incl. ids/threadIds) and persist each turn. Fixes "reply to that same email".
      conversationMessages: {
        loadForReplay: (id, o) => conversationMessageStore.loadForReplay(id, o),
        appendTurn: (id, turnId, msgs) => conversationMessageStore.appendTurn(id, turnId, msgs),
        updateRollingSummary: (id, summarize, o) => conversationMessageStore.updateRollingSummary(id, summarize, o),
      },
      // Records WHAT KAIROS DID per foreground turn (for "what did you do yesterday").
      activity: { record: (ev) => activityStore.record(ev) },
      onEvent: (e: any) => {
        if (e?.kind === 'agent_done' && typeof e.text === 'string') lastAgentReply = e.text
        wrapApi.broadcast({ event: e.kind, ...e })
      },
      speakBackend: {
        speak: async (t: string) => {
          // begin() clears any cancelled latch from a prior barge-in — without it
          // one interrupt would permanently mute all future replies.
          streamingSpeaker.begin()
          streamingSpeaker.feed(t)
          await streamingSpeaker.end()
        },
      },
      // Live token-by-token streaming on the smart tier (Phase 3 — kill dead air):
      // the StreamSpeechController drives this StreamingSpeaker directly with
      // assistant deltas + inline tool acks AS the loop runs.
      streamSink: streamingSpeaker,
      // Phase 5: acks/transitions/fillers inherit KAIROS's baseline character so the
      // whole voice surface (not just main replies) sounds warm, witty, and concise.
      personaTone: process.env.KAIROS_PERSONA_TONE ?? 'warm, witty, and concise',
      trajWriter: {
        append: async (entry) => {
          const tw = (globalThis as any).__kairosTrajWriter
          if (!tw) return
          try {
            // Translate the agent-turn entry into the TrajEntry shape used
            // by the persona TrajWriter. record() is sync but kept inside
            // try/catch — the Conductor swallows its own write errors.
            if (typeof tw.append === 'function') {
              await tw.append(entry)
              return
            }
            if (typeof tw.record === 'function') {
              tw.record({
                ts: entry.at ?? Date.now(),
                task_goal: entry.user_input ?? '',
                intent_id: `agent_turn:${entry.intent_tier ?? 'unknown'}`,
                args_summary: entry.intent_reason ?? '',
                steps: [{
                  action: `tier=${entry.intent_tier ?? 'unknown'}`,
                  result_summary: (entry.agent_output ?? '').slice(0, 500),
                }],
                outcome: entry.agent_output ? 'success' : 'partial',
                duration_ms: entry.latency_ms ?? 0,
              })
            }
          } catch { /* never break the turn on traj write failure */ }
        },
      },
    })

    let activeConductorController: AbortController | undefined
    let lastUtterance: { text: string; at: number } | undefined
    const COALESCE_MS = Number(process.env.KAIROS_UTTERANCE_COALESCE_MS) || 800

    const handleUtterance = async (utterance: string, conversationId: string): Promise<void> => {
      // GUIDE LESSON AUTO-CONTINUE: a daemon-injected turn fired by the between-turns
      // screen watcher (the user clicked the highlighted step). The user's voice always
      // outranks it — if a real turn is live, the continuation yields silently. The
      // visible text deliberately matches WALKTHROUGH_ECHO_RE so it never enters recall.
      const isLessonContinue = utterance === LESSON_CONTINUE_SENTINEL
      if (isLessonContinue) {
        if (activeConductorController && !activeConductorController.signal.aborted) {
          log('[voice] lesson auto-continue yielded — a real turn is in flight')
          return
        }
        utterance = LESSON_CONTINUE_TEXT
      }

      // Coalesce STT fragments of ONE breath (diagnosis #4-truncation d): if the previous
      // turn is STILL in flight and this utterance arrived within ~a breath, the
      // end-of-utterance detector almost certainly split one utterance ("Okay." +
      // "Can you?" 751ms apart). Fold the prior text in and answer ONCE — otherwise the
      // second fragment supersedes + truncates the first's reply. A turn that already
      // FINISHED clears activeConductorController, so a genuinely new utterance never
      // coalesces. Tunable / disable with KAIROS_UTTERANCE_COALESCE_MS=0.
      // Synthetic lesson turns skip this entirely — they must neither absorb a prior
      // fragment nor become coalesce-bait for the user's NEXT real words.
      const now = Date.now()
      if (!isLessonContinue) {
        const priorLive = !!activeConductorController && !activeConductorController.signal.aborted
        const coalesced = coalesceFragment(lastUtterance, utterance, now, { coalesceMs: COALESCE_MS, priorLive })
        if (coalesced !== utterance) log(`[voice] coalesced STT fragment (${now - (lastUtterance?.at ?? now)}ms gap) → "${coalesced.slice(0, 100)}"`)
        utterance = coalesced
        lastUtterance = { text: utterance, at: now }
      }

      log(`[voice] handleUtterance ENTER: "${utterance.slice(0, 120)}" (cid=${conversationId})${isLessonContinue ? ' [lesson auto-continue]' : ''}`)

      // GUIDE SESSION lifecycle, BEFORE the turn runs: a real utterance applies the
      // dismissal rules (a lesson ends on "stop / that's all…"; a standalone highlight
      // is dismissed by ANY speech — the user's spec: "until I say okay or something
      // else, anything, or I click it"). Then stamp this turn's context so successful
      // guide_user points know whether they belong to a lesson.
      try {
        if (!isLessonContinue) guideLesson.onUserUtterance(conversationId, utterance)
        guideLesson.setTurnContext(conversationId, utterance, TEACHING_RE.test(utterance))
      } catch { /* guide session is best-effort */ }
      // Sub-agents spawned during this turn inherit the conversation for context parity.
      try { backgroundSub.manager.setActiveConversation(conversationId) } catch { /* */ }
      // Supersede any in-flight turn: abort its controller, then settle the shared
      // speaker BEFORE the new turn's begin() resets state (an old drain loop racing
      // the new turn over one backend → stuck/silent after a barge-in).
      // DRAIN-GRACE (#4-b): a short, nearly-finished reply tail gets to FINISH its
      // sentence (capped) instead of being cut mid-word; a long in-flight reply is a
      // real interrupt and is cancelled immediately, as before.
      activeConductorController?.abort()
      const settled = await supersedeSpeech(streamingSpeaker)
      if (settled === 'drained') log('[voice] supersede: let the prior reply tail finish (drain-grace)')
      const controller = new AbortController()
      activeConductorController = controller

      // ── Background-agent approval by voice ────────────────────────────────────
      // A bare "yes"/"no" resolves a PARKED destructive action — the sub-agent is
      // paused at zero token cost awaiting this answer. Only short-circuits when
      // something is actually pending; otherwise "yes" flows to the conductor as a
      // normal follow-up. (The user can also approve later from the inbox.)
      const pendingApprovals = backgroundSub.approvalGate.listPending()
      if (pendingApprovals.length > 0) {
        const u = utterance.trim().toLowerCase()
        const yes = /^(yes|yep|yeah|yup|sure|ok|okay|go ahead|do it|approve|approved|confirm(ed)?|send it|go for it|please do)\b/.test(u)
        const no = /^(no|nope|nah|don'?t|do not|stop|cancel|skip|deny|denied|never ?mind)\b/.test(u)
        if (yes || no) {
          const speak = async (line: string) => { try { streamingSpeaker.begin(); streamingSpeaker.feed(line); await streamingSpeaker.end() } catch { /* */ } }
          // Try to TARGET a specific pending action by matching distinctive words from
          // the utterance against each pending summary — so "yes, send the email" hits
          // the email one even if another action was parked more recently.
          const STOP = new Set(['yes','yep','yeah','yup','sure','ok','okay','go','ahead','do','it','approve','approved','confirm','confirmed','send','it','for','please','no','nope','nah','dont','not','stop','cancel','skip','deny','denied','never','mind','the','a','that','this','one','please'])
          const words = u.replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w))
          const matched = words.length
            ? pendingApprovals.find((p) => { const s = p.summary.toLowerCase(); return words.some((w) => s.includes(w)) })
            : undefined

          if (matched) {
            backgroundSub.approvalGate.resolve(matched.id, yes)
            await speak(`Okay, ${yes ? 'going ahead with' : 'skipping'}: ${matched.summary}.`)
            log(`[voice] background approval ${yes ? 'APPROVED' : 'DENIED'} (targeted) "${matched.summary}"`)
            return
          }
          if (pendingApprovals.length === 1) {
            // Unambiguous — resolve it and NAME it so a mis-hear is audible.
            backgroundSub.approvalGate.resolve(pendingApprovals[0]!.id, yes)
            await speak(`Okay, ${yes ? 'going ahead with' : 'skipping'}: ${pendingApprovals[0]!.summary}.`)
            log(`[voice] background approval ${yes ? 'APPROVED' : 'DENIED'} "${pendingApprovals[0]!.summary}"`)
            return
          }
          // Ambiguous: several actions waiting and a bare yes/no — do NOT guess which
          // irreversible action to run. Ask the user to name it.
          const list = pendingApprovals.map((p) => p.summary).join('; or ')
          await speak(`I have ${pendingApprovals.length} waiting: ${list}. Which one do you mean?`)
          log(`[voice] background approval AMBIGUOUS (${pendingApprovals.length} pending) — asked to disambiguate`)
          return
        }
      }

      // ── Memory-confirmation short-circuit ─────────────────────────────────────
      // A bare "yes"/"no" answering a pending "forget X?" is a MEMORY op (resolved in
      // the BACKGROUND by pendingResolver — no tool, the chat LLM is never involved).
      // The intent classifier can't tell it apart from a real tool delete, so it
      // escalates the "yes" to the SMART model, which then reasons aloud about an
      // ambiguous one-word reply. We have the missing signal HERE (a live pending
      // marker), so resolve it deterministically and skip the conductor entirely.
      // resolve() is a cheap DB read (no LLM) when nothing is pending, so gating on a
      // yes/no regex keeps normal "yes" follow-ups flowing to the conductor untouched.
      let memoryResolveHandled = false
      {
        const u = utterance.trim().toLowerCase()
        const denied = /^(no|nope|nah|don'?t|do not|cancel|skip|keep it|keep that|leave it|never ?mind)\b/.test(u)
        const confirmed = /^(yes|yep|yeah|yup|sure|ok|okay|go ahead|do it|confirm(ed)?|please do|delete it|remove it)\b/.test(u)
        if (pendingResolver && (denied || confirmed)) {
          memoryResolveHandled = true  // we own resolve() this turn — don't double-run it in the fire-and-forget below
          let resolved = 0
          try { const r = await pendingResolver.resolve(utterance, conversationId); resolved = r?.resolved ?? 0 } catch { /* */ }
          if (resolved > 0) {
            try { contextBuilder.invalidatePrefix() } catch { /* */ }
            const ack = denied ? "Okay, I'll leave it as is." : "Okay, done."
            try { await voiceBundle!.conversationStore.appendTurn(conversationId, { role: 'user', text: utterance, at: Date.now() }) } catch { /* */ }
            try { streamingSpeaker.begin(); streamingSpeaker.feed(ack); await streamingSpeaker.end() } catch { /* */ }
            try { await voiceBundle!.conversationStore.appendTurn(conversationId, { role: 'agent', text: ack, at: Date.now() }) } catch { /* */ }
            try { wrapApi.broadcast({ event: 'agent_done', text: ack }) } catch { /* */ }
            log(`[voice] memory-confirm short-circuit: resolved=${resolved} → conductor (smart) skipped`)
            return
          }
        }
      }

      // Persist the USER turn first so it's available to recentTurns() on the
      // NEXT utterance (and the agent reply is appended once we have it). Without
      // this the agent has no memory of the conversation (recentTurns → []).
      try {
        await voiceBundle!.conversationStore.appendTurn(conversationId, {
          role: 'user', text: utterance, at: Date.now(),
        })
      } catch (e) { log(`[voice] appendTurn(user) failed: ${(e as Error).message}`) }

      // Fire-and-forget automatic memory lifecycle (does NOT block the reply).
      // ORDER MATTERS: resolve pending confirmations FIRST (so a "yes" finishes
      // last turn's "confirm before deleting?" ask), THEN detect a new forget,
      // THEN write/extract facts + preferences. All best-effort, never throw.
      void (async () => {
        let ctx = ''
        try {
          const recent = await voiceBundle!.conversationStore.recentTurns(conversationId, 4)
          ctx = recent.map((t: any) => `${t.role}: ${t.text}`).join('\n')
        } catch { /* context best-effort */ }

        // Per-turn memory instrumentation — one structured line so we can SEE the
        // lifecycle working (or not) on every turn instead of guessing.
        const mem: { resolved: number; forgot: string[]; pending?: string; extracted: boolean } = { resolved: 0, forgot: [], extracted: false }
        // 1. Resolve any outstanding confirm-before-delete asks. Skipped when the
        //    yes/no short-circuit above already owned resolution this turn (so we
        //    never run the resolver LLM twice for the same utterance).
        if (pendingResolver && !memoryResolveHandled) {
          try {
            const r = await pendingResolver.resolve(utterance, conversationId)
            if (r && r.resolved > 0) { mem.resolved = r.resolved; try { contextBuilder.invalidatePrefix() } catch {} }
          } catch { /* */ }
        }
        // 2. Detect a NEW forget request (immediate soft-delete, or raise a pending ask).
        if (forgetDetector) {
          try {
            const f = await forgetDetector.detect(utterance, ctx, conversationId)
            if (f) { mem.forgot = (f as any).forgot ?? []; mem.pending = (f as any).pending; try { contextBuilder.invalidatePrefix() } catch {} }
          } catch { /* */ }
        }
        // 3. Extract durable facts (write/update). Corrections resolve via ctx.
        if (realtimeFactExtractor) {
          try {
            const stored = await realtimeFactExtractor.extract(utterance, ctx)
            mem.extracted = true
            // A durable fact changed topFacts, which is baked into the cached session
            // prefix — invalidate so the NEXT build (incl. a background sub-agent's)
            // reflects it instead of a stale snapshot.
            if (Array.isArray(stored) ? stored.length > 0 : !!stored) { try { contextBuilder.invalidatePrefix() } catch { /* */ } }
          } catch { /* */ }
        }
        if (mem.resolved || mem.forgot.length || mem.pending || mem.extracted) {
          log(`[memory] turn cid=${conversationId}: resolved=${mem.resolved} forgot=${JSON.stringify(mem.forgot)}${mem.pending ? ` pending="${mem.pending}"` : ''} extracted=${mem.extracted}`)
        }
      })()

      // Detect + persist standing preferences ("from now on…") to persona.md.
      if (preferenceNudgeDetector) {
        void preferenceNudgeDetector.detect(utterance).then((pref) => {
          if (pref) { try { contextBuilder.invalidatePrefix() } catch {} }
        })
      }

      lastAgentReply = ''
      // Stable runId for THIS turn — root of the activity tree. Sub-agents spawned
      // during the turn link to it (parentRunId) so the UI nests them under the turn.
      const turnRunId = `turn_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
      try { backgroundSub.manager.setActiveRunId(turnRunId) } catch { /* */ }
      try {
        // Lesson/highlight context rides on the conductor opts: an active walkthrough
        // skips the fast front entirely (it answered lessons from memory — the
        // 2026-06-10 fabrication bug) and the planner gets the resume block.
        const lessonContext = (() => {
          try { return guideLesson.contextBlockFor(conversationId) || undefined } catch { return undefined }
        })()
        await agentConductor.handle({
          utterance, conversationId, signal: controller.signal, runId: turnRunId,
          lessonContext, synthetic: isLessonContinue || undefined,
        })
        log(`[voice] handleUtterance OK`)
        // Persist the AGENT turn (captured from agent_done via onEvent).
        if (lastAgentReply.trim()) {
          try {
            await voiceBundle!.conversationStore.appendTurn(conversationId, {
              role: 'agent', text: lastAgentReply, at: Date.now(),
            })
          } catch (e) { log(`[voice] appendTurn(agent) failed: ${(e as Error).message}`) }
        }
      } catch (e) {
        log(`[voice] handleUtterance ERROR: ${(e as Error).message}\n${(e as Error).stack ?? ''}`)
      } finally {
        // Record into L2 episodic memory EVEN IF the reply failed — what the user
        // SAID is worth remembering regardless of whether KAIROS could answer (e.g.
        // an LLM outage shouldn't lose the user's statement). Runs once per turn.
        // voiceTurnObservation drops a failure-narrative REPLY at write time (the
        // recorder-side half of the self-poisoning guard).
        try {
          const epStore = (globalThis as any).__kairosEpisodicStore
          if (epStore?.record) {
            await epStore.record({ source: 'voice', text: voiceTurnObservation(utterance, lastAgentReply) })
          }
        } catch (e) { log(`[voice] episodic record failed: ${(e as Error).message}`) }
        // Guide Mode turn-end handoff: retraction is NO LONGER automatic (highlights
        // vanished before KAIROS finished speaking — 2026-06-10). The session manager
        // decides: lesson alive → arm the between-turns screen watcher (auto-continue
        // on the user's click); standalone highlight up → arm the act-dismissal watch.
        // OWNERSHIP GUARD: only the turn that is STILL current may hand off. A superseded
        // (zombie) turn finishing late used to yank the NEW turn's guide off the screen.
        if (activeConductorController === controller) {
          try { guideLesson.afterTurn(conversationId) } catch { /* */ }
        }
        // Only clear if we're still the active turn (a newer turn may have replaced us).
        if (activeConductorController === controller) activeConductorController = undefined
      }
    }

    voiceBundle.conductor.setUserUtteranceHandler(handleUtterance)
    // Late-bind the lesson auto-continue injector now that handleUtterance exists:
    // the between-turns watcher fires this when the user clicks the highlighted step.
    lessonContinueFn = (cid) => { void handleUtterance(LESSON_CONTINUE_SENTINEL, cid) }

    // Allow WS clients (or scripts/agent-ping.ts) to inject a synthetic
    // utterance — runs the FULL agent loop and emits events the same way as
    // a real STT result would. This is the primary defense against silent
    // classifier failures (the issue that hit Phase E.2 v0.7.0): you can
    // smoke-test the agent without touching the mic.
    wrapApi.onCommand((cmd: any) => {
      // Telemetry commands: high-frequency (tts_level ~15Hz while speaking) — never
      // trace-log these, they drowned the diagnostics (15 lines/sec of noise).
      if (cmd?.cmd === 'hud_keepalive') return
      const QUIET_CMDS = new Set(['tts_level', 'tts_playback'])
      const quiet = QUIET_CMDS.has(cmd?.cmd)
      // Trace EVERY command from the renderer so we can tell "renderer never sent"
      // from "daemon dropped it". For audio, log size not the base64 blob.
      try {
        if (!quiet) {
          const kind = cmd?.cmd ?? '(no cmd field)'
          const extra = cmd?.wavBase64 ? ` wavB64=${String(cmd.wavBase64).length}B` : ''
          log(`[voice] WS cmd: ${kind}${extra}`)
        }
      } catch {}

      if (cmd?.cmd === 'test_inject_utterance' && typeof cmd.text === 'string') {
        const cid = String(cmd.conversationId ?? 'test-' + Date.now())
        void handleUtterance(cmd.text, cid)
        return
      }

      // Renderer playback truth: the Electron renderer reports when Web Audio is
      // ACTUALLY playing (on change + keepalive). Drives the orb's speaking state
      // and re-anchors the barge-in debounce to real audio end (tts_end only means
      // "chunks finished downloading" — playback lags it by the buffer depth).
      if (cmd?.cmd === 'tts_playback' && typeof cmd.playing === 'boolean') {
        speakingState.reportPlayback(cmd.playing)
        if (!cmd.playing) lastTtsEndAt = Date.now()
        return
      }

      // Guide Mode: the HUD answers a guide_request (found the element + pointing,
      // or not found + why) or a screen_request (the AX element inventory) —
      // resolves the agent's awaiting guide_user / read_screen call.
      if ((cmd?.cmd === 'guide_result' || cmd?.cmd === 'screen_result') && typeof cmd.id === 'string') {
        guideBridge.resolve(cmd.id, { found: !!cmd.found, label: cmd.label, reason: cmd.reason, summary: cmd.summary })
        return
      }

      // Live voice level from the renderer's playback analyser (~15Hz while audible) —
      // rebroadcast for the HUD orb's lobes. Chunk-arrival RMS was wrong: chunks
      // download seconds ahead of playback, leaving the orb static mid-speech.
      if (cmd?.cmd === 'tts_level' && typeof cmd.level === 'number') {
        try { wrapApi.broadcast({ event: 'tts_level', level: Math.max(0, Math.min(1, cmd.level)) }) } catch { /* */ }
        return
      }

      // Test-genesis hook: force the AWM induction pipeline to run NOW (instead of
      // waiting for its 4h timer), optionally with relaxed thresholds, so a test
      // harness can prove KAIROS crystallizes a skill from recent trajectories.
      // Read-only w.r.t. user data; only writes to ~/.kairos/skills. See the
      // kairos-skill-genesis skill.
      if (cmd?.cmd === 'test_run_awm') {
        // Test/dev hook only — it can force the induction pipeline with arbitrary
        // thresholds. Disabled in production so a stray localhost client can't drive
        // skill crystallization. (NODE_ENV unset = dev/test → enabled.)
        if (process.env.NODE_ENV === 'production') {
          wrapApi.broadcast({ event: 'awm_report', error: 'test_run_awm is disabled in production' })
          return
        }
        const worker = (globalThis as any).__kairosAwmWorker
        if (!worker) {
          wrapApi.broadcast({ event: 'awm_report', error: 'AwmWorker not available (skills subsystem disabled or persona TrajWriter/router missing)' })
          return
        }
        const overrides = (cmd.overrides && typeof cmd.overrides === 'object') ? cmd.overrides : undefined
        void worker.runOnce(overrides)
          .then((report: any) => { wrapApi.broadcast({ event: 'awm_report', report }) })
          .catch((err: any) => { wrapApi.broadcast({ event: 'awm_report', error: String(err?.message ?? err) }) })
        return
      }

      // Renderer-mic mode: Electron captured an utterance (WAV, base64) and ships
      // it here. Transcribe via the same cloud Whisper used by the sidecar bridge,
      // then run the full agent loop. Mirrors VoiceConductor's audio_blob path.
      if (cmd?.cmd === 'utterance_audio' && typeof cmd.wavBase64 === 'string') {
        const cid = String(cmd.conversationId ?? 'conv_default')
        const whisper = voiceBundle?.whisper
        if (!whisper) {
          log('[voice] utterance_audio received but no whisper transcriber (KAIROS_STT must be groq/openrouter)')
          wrapApi.broadcast({ event: 'agent_error', message: 'cloud STT not configured' })
          return
        }
        void (async () => {
          const t0 = Date.now()
          try {
            const wavBytes = Uint8Array.from(atob(cmd.wavBase64), (c) => c.charCodeAt(0))
            const { text } = await whisper.transcribe(wavBytes)
            const clean = (text ?? '').trim()
            log(`[voice] STT(renderer) [${Date.now() - t0}ms]: "${clean}"`)
            // Always surface what was heard in the TERMINAL (log() only prints in
            // verbose mode → file-only otherwise, which is why transcripts looked
            // intermittent). console.log is unconditional.
            if (!clean) {
              console.log(`  🎤 heard nothing (STT empty, ${Date.now() - t0}ms) — say it again`)
              wrapApi.broadcast({ event: 'stt_final', text: '' })
              return
            }
            console.log(`  🎤 heard: "${clean}" (${Date.now() - t0}ms)`)
            wrapApi.broadcast({ event: 'stt_final', text: clean })
            await handleUtterance(clean, cid)
          } catch (e) {
            log(`[voice] STT(renderer) error: ${(e as Error).message}`)
            console.log(`  🎤 STT FAILED: ${(e as Error).message}`)
            wrapApi.broadcast({ event: 'agent_error', message: `STT: ${(e as Error).message}` })
          }
        })()
        return
      }

      // Voice barge-in from the renderer's Silero VAD: user started speaking while
      // KAIROS was talking. Abort the in-flight turn + stop TTS. The renderer also
      // stops its own Web Audio playback locally for instant cutoff.
      if (cmd?.cmd === 'barge_in') {
        // Ignore a barge-in that lands within the debounce window after OUR TTS
        // stopped — that's the VAD self-triggering on our own tail audio, not the user.
        const sinceTts = Date.now() - lastTtsEndAt
        if (lastTtsEndAt > 0 && sinceTts < BARGE_DEBOUNCE_MS) {
          log(`[barge-in] (renderer VAD) IGNORED — ${sinceTts}ms after our TTS ended (self-trigger guard)`)
          return
        }
        // BARGE-IN IS AUDIO-ONLY. It used to ABORT the whole conductor turn — and the
        // renderer's VAD hears KAIROS'S OWN VOICE through open speakers (AEC residual),
        // so every answer killed itself the moment it started playing (the 2026-06-10
        // silent-turn cascade: "yes" → dead, "Hello?" → dead). Now: stop the SOUND
        // immediately; the turn lives on. A REAL interruption is followed by an actual
        // utterance, and THAT supersedes/aborts the turn through handleUtterance.
        log('[barge-in] (renderer VAD) stopping audio — turn continues (utterance, if any, will supersede)')
        try { streamingSpeaker.cancel() } catch {}
        try { voiceBundle!.sayBackend.stop() } catch {}
        wrapApi.broadcast({ event: 'tts_stopped' })
        return
      }

      // Hook #10 (UI half): resolve a PARKED background-agent destructive approval
      // from the HUD / inbox card — the non-voice path. item_id is the gate req.id
      // (from an `approval_request` event) OR the inbox intent_id (`bg_approval:<id>`);
      // both are accepted (the prefix is stripped). The parked sub-agent (zero token
      // cost) resumes on approve, or skips the action on deny. Replies with
      // `approval_resolved{item_id, decision, matched}` so the UI can clear the card.
      if ((cmd?.cmd === 'approve' || cmd?.cmd === 'deny') && cmd.item_id != null) {
        const approved = cmd.cmd === 'approve'
        const reqId = String(cmd.item_id).replace(/^bg_approval:/, '')
        let matched = false
        try { matched = backgroundSub.approvalGate.resolve(reqId, approved) } catch { /* */ }
        log(`[voice] WS ${cmd.cmd} item=${reqId} → ${matched ? 'resolved' : 'no pending match'}`)
        wrapApi.broadcast({ event: 'approval_resolved', item_id: cmd.item_id, decision: approved ? 'approved' : 'denied', matched })
        return
      }
    })

    // Sidecar barge-in — AUDIO-ONLY, same as the renderer path: stop the sound, let
    // the turn live; a real interruption's utterance supersedes it (VAD hears our own
    // speaker output through AEC residual — aborting on VAD alone killed answers).
    voiceBundle.sidecar.onEvent((e: any) => {
      if (e.event === 'barge_in_detected' || e.event === 'barge_in' || e.event === 'vad_speech_during_tts') {
        const sinceTts = Date.now() - lastTtsEndAt
        if (lastTtsEndAt > 0 && sinceTts < BARGE_DEBOUNCE_MS) {
          log(`[barge-in] (sidecar VAD) IGNORED — ${sinceTts}ms after our TTS ended (self-trigger guard)`)
          return
        }
        log('[barge-in] (sidecar VAD) stopping audio — turn continues')
        try { streamingSpeaker.cancel() } catch {}
        try { voiceBundle!.sayBackend.stop() } catch {}
        wrapApi.broadcast({ event: 'tts_stopped' })
      }
    })

    log('[voice] agent conductor wired into VoiceConductor utterance handler')
  }

  // 11. Write ready flag (shim watches for this)
  writeReadyFlag(config.sandboxDir)

  // 12. Graceful shutdown
  setupSignalHandlers(() => {
    discordBot?.stop()
    scheduler.stop()
    if (proactiveStop) void proactiveStop()
    if (voiceBundle) {
      // VoiceConductor.stop() only halts the speak backend; the sidecar
      // subprocess is owned by SidecarClient and must be stopped explicitly
      // or it leaks past SIGINT/SIGTERM.
      void (async () => {
        try { await voiceBundle!.conductor.stop() } catch (e) { log(`[voice] conductor stop error: ${e}`) }
        try { await voiceBundle!.sidecar.stop() } catch (e) { log(`[voice] sidecar stop error: ${e}`) }
      })()
    }
    void wrapApi.stop().catch((e) => log(`[wrap-api] stop error: ${e}`))
    gracefulShutdown({ sandboxDir: config.sandboxDir, db, server })
  })

  // 13. Startup banner
  const mockMode = process.env.KAIROS_MOCK_DECISIONS === '1'
  const banner = [
    '',
    '  ⚡ KAIROS daemon',
    `     version:      ${VERSION}`,
    `     bun:          ${Bun.version}`,
    `     pid:          ${process.pid}`,
    `     port:         ${port}`,
    `     sandbox:      ${config.isSandbox ? 'yes' : 'no'}`,
    `     verbose:      ${config.verbose ? 'yes' : 'no'}`,
    `     mock mode:    ${mockMode ? 'YES (no LLM calls)' : 'no'}`,
    `     tick model:   ${config.models.tick}`,
    `     work model:   ${config.models.work}`,
    `     tick interval: ${config.tick.defaultIntervalMs / 1000}s`,
    `     budget/hour:  ${config.budget.maxSubprocessPerHour} calls, $${(config.budget.maxCostCentsPerHour / 100).toFixed(2)}`,
    `     sandbox dir:  ${config.sandboxDir}`,
    '',
    '  Daemon is running. Tick loop armed.',
    mockMode ? '  ⚠ MOCK MODE: decisions are hardcoded, no Claude calls.' : '',
    '  Press Ctrl+C to stop.',
    '',
  ].filter(Boolean)

  for (const line of banner) console.log(line)
  log('KAIROS daemon started')
}

main().catch((err: unknown) => {
  console.error('KAIROS daemon failed to start:')
  console.error(err)
  process.exit(1)
})
