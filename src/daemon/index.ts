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
import { sendMacNotification, setSandboxDir as setNotifySandboxDir } from './notify'
import { postToDiscord, isDiscordConfigured } from './discord'
import { buildRouter } from './llm'
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
import { SemanticMemory } from './memory/semanticMemory'
import { Dreamer } from './memory/dreamer'
import { IdleDetector } from './memory/idleDetector'
import { Tier1Classifier } from './perception/tier1Classifier'
import { Tier2Summarizer } from './perception/tier2Summarizer'
import { PerceptionPipeline } from './perception/perceptionPipeline'
import { OrdersParser } from './orders/parser'
import { OrdersCompiler } from './orders/compiler'
import { OrdersRuntime } from './orders/runtime'
import { ensureSeedFile } from './orders/seedFile'
import { ActivityWatchObserver } from './proactive/observers/activityWatch'

const VERSION = '0.2.0'

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

  // 10. Start the tick scheduler
  scheduler.start()

  // 10b. Proactive subsystem (ModelRouter + EventBus + observers + Narrator)
  let proactiveStop: (() => Promise<void>) | null = null
  if (config.proactive.enabled) {
    const router = buildRouter(db, config.proactive.providerConfigPath)
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
      const idle = new IdleDetector()

      const dreamTimer = setInterval(async () => {
        try {
          if (await idle.shouldDream()) {
            await dreamer.consolidate({ maxEpisodes: 50 })
          }
        } catch (err) { logError('Dreamer tick failed', err) }
      }, config.memory.dreamIntervalMs)

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
        pipeline.start()
        log('Perception pipeline active: Tier1 → Tier2 → Narrator')
      }

      memoryStop = async () => {
        clearInterval(dreamTimer)
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

  // 11. Write ready flag (shim watches for this)
  writeReadyFlag(config.sandboxDir)

  // 12. Graceful shutdown
  setupSignalHandlers(() => {
    discordBot?.stop()
    scheduler.stop()
    if (proactiveStop) void proactiveStop()
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
