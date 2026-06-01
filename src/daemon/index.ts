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
import { startWrapApi, type WrapApiServer } from './wrapApi/server'
import { LLMAdapter } from './wrapApi/adapters/llmAdapter'
import { VoiceAdapter } from './wrapApi/adapters/voiceAdapter'
import { OpenRouterAdapter } from './wrapApi/adapters/openRouterAdapter'
import { TIER_MODELS, type Tier } from './agents/types'
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
import { SoulLoader } from './persona/soulLoader'
import { TrajWriter } from './persona/trajWriter'
import { PersonaUpdater } from './persona/personaUpdater'
import { DreamingExtension } from './persona/dreamingExtension'
import { PersonaAwareness } from './persona/personaAwareness'
import { readFileSync } from 'fs'
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
import { ComposioToolCache, buildComposioSearchTool } from './agents/composioToolProvider'
import { SelfHealConnect } from './agents/selfHealConnect'
import type { SystemBlock } from './llm/types'

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
  return buildLlmCompleterForModel(TIER_MODELS[tier]())
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
  return buildLlmCompleterForModel(memoryModel())
}

/** Shared OpenRouter completer for an exact model id ({messages}→{text}). */
function buildLlmCompleterForModel(model: string): { complete: (body: any) => Promise<{ text: string }> } {
  const adapter = new OpenRouterAdapter({ defaultModel: model })
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
  log(`Database initialized at ${dbPath}`)

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
  const decisionEngine = new DecisionEngine(db, config)
  const taskRunner = new TaskRunner(db, config)
  const memoryStore = new MemoryStore(db, config)
  ;(globalThis as { __kairosMemoryStore?: MemoryStore }).__kairosMemoryStore = memoryStore
  const voice = new Voice(config.sandboxDir)

  // 6b. New self-evolving modules
  const { ScheduleManager } = await import('./scheduleManager')
  const { EnvironmentScanner } = await import('./environmentScanner')
  const { FeedbackCollector } = await import('./feedbackCollector')
  const { SkillRegistry } = await import('./skillRegistry')
  const scheduleManager = new ScheduleManager(db, config)
  const environmentScanner = new EnvironmentScanner(db, config)
  const feedbackCollector = new FeedbackCollector(db, config)
  const skillRegistry = new SkillRegistry(config.sandboxDir)

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
  environmentScanner.setTriggerTick((event) => scheduler.triggerImmediateTick(event))

  // 7c. Start Discord bot polling (bidirectional Discord chat)
  const { DiscordBot, loadBotConfig } = await import('./discordBot')
  const botConfig = loadBotConfig(config.sandboxDir)
  let discordBot: InstanceType<typeof DiscordBot> | null = null
  if (botConfig) {
    discordBot = new DiscordBot(
      botConfig,
      db,
      (event) => scheduler.triggerImmediateTick(event),
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
    triggerTick: (event) => scheduler.triggerImmediateTick(event),
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
      const working = new WorkingMemory(bus, { windowMs: 10 * 60_000, maxEvents: 500 })
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
                log(`[composio] session ready (${sessionManager.getSessionId()}, ${initialToolkits.length} toolkits)`)

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

                registerConnectServiceIntent(intentRegistry, { connectionFlow, sessionManager, userId: composioUserId })
                registerDisconnectServiceIntent(intentRegistry, { composio: composioClient, connectionStore, sessionManager, userId: composioUserId })

                const expiryPoller = new TokenExpiryPoller({
                  composio: composioClient,
                  connectionStore,
                  onConnectionExpired: (c) => {
                    log(`[composio] connection expired: ${c.toolkit_slug} — needs reconnect`, 'warn')
                  },
                  userId: composioUserId,
                  intervalMs: config.composio?.poll_interval_ms ?? 5 * 60 * 1000,
                })
                expiryPoller.start()

                // Stash for Phase D trigger subsystem and orders-v2
                ;(globalThis as any).__kairosComposioClient = composioClient
                ;(globalThis as any).__kairosConnectionStore = connectionStore
                ;(globalThis as any).__kairosConnectionFlow = connectionFlow

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
                onConnectionComplete: (toolkit: string) => log(`[triggers] connection complete: ${toolkit}`),
                userId: 'local',
              })

              triggerListener = new TriggerListener({
                apiKey: composioApiKey,
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

  // 10e. Wire voice conductor bus → wrap-API WebSocket broadcast.
  // bootstrapVoice() installs a no-op bus stub; swap it for one that pushes
  // events out to every connected /v1/voice/events WS client (Electron, etc.).
  if (voiceBundle) {
    voiceBundle.conductor.replaceBus({
      publish: (kind: string, payload: any) => {
        wrapApi.broadcast({ event: voiceEventName(kind), ...payload })
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
          const ms = (globalThis as any).__kairosMemoryStore
          if (!ms || typeof ms.read !== 'function') return ''
          try {
            const raw = ms.read()
            return raw.length > 3200 ? raw.slice(0, 3200) + '\n...(truncated)' : raw
          } catch { return '' }
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
            // Behavioral directives derived from hints — phrased as instructions the
            // agent should FOLLOW, not just facts (closes the "doesn't apply prefs" gap).
            const directives: string[] = []
            if (h.prefer_terse) directives.push("Keep replies short and direct — no preamble or filler.")
            if (h.prefer_voice_over_text) directives.push("Favor a natural spoken cadence.")
            if (h.in_focus_now) directives.push("The user is focused/in flow right now — be minimal and non-disruptive.")
            if (directives.length) {
              lines.push("- How to respond right now: " + directives.join(" "))
            }
            return lines.join("\n")
          } catch { return '' }
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
    })

    // E.2.4 — Wire a StreamingSpeaker on top of the existing sayBackend so the
    // Narrator's ack/transition/filler output gets piped through the same
    // sentence-by-sentence speaking pipeline the streaming LLM uses. Each
    // Narrator.speak* call awaits feed + end so phrases serialize cleanly.
    // When canonical streaming TTS is active, the StreamingTtsBackend owns its
    // own provider voice config (KAIROS_TTS_VOICE) — do NOT pass the Apple
    // `say` voice name here or it leaks into the provider as a bogus model id
    // (e.g. Deepgram rejected 'Zoe (Premium)' as an invalid model value).
    const streamingSpeaker = new StreamingSpeaker({
      backend: voiceBundle.sayBackend,
      voice: voiceBundle.streamingTts ? undefined : (process.env.KAIROS_VOICE_NAME ?? 'Zoe (Premium)'),
      rate: voiceBundle.streamingTts ? undefined : Number(process.env.KAIROS_VOICE_RATE ?? 180),
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
            // ComposioClient exposes the SDK directly; use its native tool search.
            // Prefer searchTools/listTools on the SDK if present; otherwise enumerate
            // via getRawComposioTools and filter client-side by description match.
            const sdk = composioClient.sdk
            if (sdk?.tools?.search && typeof sdk.tools.search === 'function') {
              const r = await sdk.tools.search({ query: q, limit })
              const items: any[] = Array.isArray(r) ? r : (r?.items ?? [])
              return items.slice(0, limit).map((t: any) => ({
                slug: t.slug ?? t.name,
                description: t.description ?? '',
                parameters: t.inputParameters ?? t.input_parameters ?? t.inputSchema,
                toolkit: t.toolkit?.slug ?? t.toolkit_slug,
              }))
            }
            if (sdk?.tools?.getRawComposioTools && typeof sdk.tools.getRawComposioTools === 'function') {
              const r: any = await sdk.tools.getRawComposioTools({ limit: 500 })
              const items: any[] = Array.isArray(r) ? r : (r?.items ?? [])
              const ql = q.toLowerCase()
              return items
                .filter((t: any) => {
                  const slug = String(t.slug ?? t.name ?? '').toLowerCase()
                  const desc = String(t.description ?? '').toLowerCase()
                  const tk = String(t.toolkit?.slug ?? t.toolkit_slug ?? '').toLowerCase()
                  return slug.includes(ql) || desc.includes(ql) || tk.includes(ql)
                })
                .slice(0, limit)
                .map((t: any) => ({
                  slug: t.slug ?? t.name,
                  description: t.description ?? '',
                  parameters: t.inputParameters ?? t.input_parameters ?? t.inputSchema,
                  toolkit: t.toolkit?.slug ?? t.toolkit_slug,
                }))
            }
            return []
          } catch { return [] }
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

    const agentConductor = new Conductor({
      classifyLlm: buildAgentLlmCompleter('fast'),
      fastLlm:     buildAgentLlmCompleter('fast'),
      smartLlm:    buildAgentLlmCompleter('smart'),
      tools: [...introspectionTools, composioSearchTool, ...composioCache.asTools()],
      contextBuilder,
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
      personaTone: process.env.KAIROS_PERSONA_TONE,
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

    const handleUtterance = async (utterance: string, conversationId: string): Promise<void> => {
      log(`[voice] handleUtterance ENTER: "${utterance.slice(0, 120)}" (cid=${conversationId})`)
      // Supersede any in-flight turn: abort its controller AND stop the shared
      // speaker so its drain loop exits before the new turn's begin() resets state.
      // Without the stop(), the old (aborted) turn keeps draining the StreamingSpeaker
      // and races the new turn over one shared backend → stuck/silent after a barge-in.
      activeConductorController?.abort()
      try { streamingSpeaker.cancel() } catch {}
      const controller = new AbortController()
      activeConductorController = controller

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

        // 1. Resolve any outstanding confirm-before-delete asks.
        if (pendingResolver) {
          try {
            const r = await pendingResolver.resolve(utterance, conversationId)
            if (r && r.resolved > 0) { try { contextBuilder.invalidatePrefix() } catch {} }
          } catch { /* */ }
        }
        // 2. Detect a NEW forget request (immediate soft-delete, or raise a pending ask).
        if (forgetDetector) {
          try {
            const f = await forgetDetector.detect(utterance, ctx, conversationId)
            if (f) { try { contextBuilder.invalidatePrefix() } catch {} }
          } catch { /* */ }
        }
        // 3. Extract durable facts (write/update). Corrections resolve via ctx.
        if (realtimeFactExtractor) { try { await realtimeFactExtractor.extract(utterance, ctx) } catch { /* */ } }
      })()

      // Detect + persist standing preferences ("from now on…") to persona.md.
      if (preferenceNudgeDetector) {
        void preferenceNudgeDetector.detect(utterance).then((pref) => {
          if (pref) { try { contextBuilder.invalidatePrefix() } catch {} }
        })
      }

      lastAgentReply = ''
      try {
        await agentConductor.handle({ utterance, conversationId, signal: controller.signal })
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
        try {
          const epStore = (globalThis as any).__kairosEpisodicStore
          if (epStore?.record) {
            const text = lastAgentReply.trim()
              ? `User said: "${utterance}". KAIROS replied: "${lastAgentReply}".`
              : `User said: "${utterance}".`
            await epStore.record({ source: 'voice', text })
          }
        } catch (e) { log(`[voice] episodic record failed: ${(e as Error).message}`) }
        // Only clear if we're still the active turn (a newer turn may have replaced us).
        if (activeConductorController === controller) activeConductorController = undefined
      }
    }

    voiceBundle.conductor.setUserUtteranceHandler(handleUtterance)

    // Allow WS clients (or scripts/agent-ping.ts) to inject a synthetic
    // utterance — runs the FULL agent loop and emits events the same way as
    // a real STT result would. This is the primary defense against silent
    // classifier failures (the issue that hit Phase E.2 v0.7.0): you can
    // smoke-test the agent without touching the mic.
    wrapApi.onCommand((cmd: any) => {
      // Trace EVERY command from the renderer so we can tell "renderer never sent"
      // from "daemon dropped it". For audio, log size not the base64 blob.
      try {
        const kind = cmd?.cmd ?? '(no cmd field)'
        const extra = cmd?.wavBase64 ? ` wavB64=${String(cmd.wavBase64).length}B` : ''
        log(`[voice] WS cmd: ${kind}${extra}`)
      } catch {}

      if (cmd?.cmd === 'test_inject_utterance' && typeof cmd.text === 'string') {
        const cid = String(cmd.conversationId ?? 'test-' + Date.now())
        void handleUtterance(cmd.text, cid)
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
            if (!clean) { wrapApi.broadcast({ event: 'stt_final', text: '' }); return }
            wrapApi.broadcast({ event: 'stt_final', text: clean })
            await handleUtterance(clean, cid)
          } catch (e) {
            log(`[voice] STT(renderer) error: ${(e as Error).message}`)
            wrapApi.broadcast({ event: 'agent_error', message: `STT: ${(e as Error).message}` })
          }
        })()
        return
      }

      // Voice barge-in from the renderer's Silero VAD: user started speaking while
      // KAIROS was talking. Abort the in-flight turn + stop TTS. The renderer also
      // stops its own Web Audio playback locally for instant cutoff.
      if (cmd?.cmd === 'barge_in') {
        if (activeConductorController) {
          log('[barge-in] (renderer VAD) aborting active conductor turn')
          activeConductorController.abort()
        }
        // Stop BOTH layers: the StreamingSpeaker (phrase queue + drain loop) and
        // the underlying TTS backend (in-flight provider fetch). Stopping only the
        // backend leaves the speaker draining into a dead sink.
        try { streamingSpeaker.cancel() } catch {}
        try { voiceBundle!.sayBackend.stop() } catch {}
        wrapApi.broadcast({ event: 'agent_interrupted' })
        return
      }
    })

    // Listen for barge_in events from sidecar → abort active conductor turn + stop TTS.
    voiceBundle.sidecar.onEvent((e: any) => {
      if (e.event === 'barge_in_detected' || e.event === 'barge_in' || e.event === 'vad_speech_during_tts') {
        if (activeConductorController) {
          log('[barge-in] aborting active conductor turn')
          activeConductorController.abort()
        }
        try { streamingSpeaker.cancel() } catch {}
        try { voiceBundle!.sayBackend.stop() } catch {}
        wrapApi.broadcast({ event: 'agent_interrupted' })
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
