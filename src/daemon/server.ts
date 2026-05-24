// HTTP server for the KAIROS daemon.
// Routes for the MCP shim to call + admin endpoints.
// Localhost only — never exposed to the network.

import type { Database } from 'bun:sqlite'
import * as queries from './db'
import { log, logError } from './logger'
import type { Config, ResponseEnvelope } from './types'

export type ServerDeps = {
  port: number
  db: Database
  config: Config
  // Phase 3+: scheduler will be injected here
  triggerTick?: (event: { source: string; reason: string }) => void
}

export function startHttpServer(deps: ServerDeps): ReturnType<typeof Bun.serve> {
  const { port, db, config, triggerTick } = deps

  const server = Bun.serve({
    port,
    hostname: '127.0.0.1',

    async fetch(req): Promise<Response> {
      const url = new URL(req.url)
      const path = url.pathname
      const method = req.method

      try {
        // ─── Health check ─────────────────────────────────────────
        if (path === '/health' && method === 'GET') {
          return new Response('ok')
        }

        // ─── Status line (for hooks/status-line.sh) ───────────────
        if (path === '/status-line' && method === 'GET') {
          const s = queries.getDaemonSummary(db)
          const line = `⚡ KAIROS: ${s.runningCount > 0 ? 'working' : 'idle'} · ${s.queueDepth} queued · ${s.tickCount} ticks`
          return new Response(line)
        }

        // ─── Register session ─────────────────────────────────────
        if (path === '/register' && method === 'POST') {
          const body = await req.json() as { pid?: number; cwd?: string; session_id?: string; client_version?: string }
          const sessionId = body.session_id || crypto.randomUUID()
          queries.createSession(db, {
            sessionId,
            pid: body.pid ?? 0,
            cwd: body.cwd ?? process.cwd(),
            clientVersion: body.client_version,
          })
          log(`Session ${sessionId.slice(0, 8)}... registered (cwd: ${body.cwd ?? 'unknown'})`)
          triggerTick?.({ source: 'session_connected', reason: `New session ${sessionId.slice(0, 8)}` })
          return json({ session_id: sessionId, status: 'registered' })
        }

        // ─── Unregister session ───────────────────────────────────
        if (path === '/unregister' && method === 'POST') {
          const body = await req.json() as { session_id: string }
          queries.disconnectSession(db, body.session_id)
          log(`Session ${body.session_id.slice(0, 8)}... disconnected`)

          const remaining = queries.getActiveSessionCount(db)
          if (remaining === 0) {
            log('Last session disconnected. Shutting down in 5s...')
            setTimeout(() => process.kill(process.pid, 'SIGTERM'), 5000)
          }

          return json({ ok: true, remaining_sessions: remaining })
        }

        // ─── Status ───────────────────────────────────────────────
        if (path === '/status' && method === 'GET') {
          const summary = queries.getDaemonSummary(db)
          return json({
            daemon_status: 'running',
            port,
            pid: process.pid,
            uptime_sec: Math.floor((Date.now() - daemonStartTime) / 1000),
            is_sandbox: config.isSandbox,
            ...summary,
          })
        }

        // ─── Inbox (for inject-inbox.sh hook — GET) ───────────────
        if (path.startsWith('/inbox/') && method === 'GET') {
          const sessionId = path.split('/')[2]!
          const peek = url.searchParams.get('peek') === 'true'

          let messages
          if (sessionId === 'all') {
            // Return ALL unread messages regardless of session (used by inject-inbox.sh)
            messages = db.query(
              'SELECT * FROM messages WHERE read_at IS NULL ORDER BY created_at ASC LIMIT 20',
            ).all() as import('./types').MessageRow[]
          } else {
            messages = queries.getUnreadMessages(db, sessionId)
          }

          if (!peek && messages.length > 0) {
            queries.markMessagesRead(db, messages.map(m => m.message_id))
          }
          return json(messages)
        }

        // ─── Tool routes (MCP shim calls these) ───────────────────
        if (path.startsWith('/tool/') && method === 'POST') {
          const toolName = path.replace('/tool/', '')
          const body = await req.json() as Record<string, unknown>
          const sessionId = (body.session_id as string) ?? 'unknown'
          const sessionCwd = (body.session_cwd as string) ?? process.cwd()

          const result = await handleTool(toolName, body, sessionId, sessionCwd, db, config, triggerTick)
          return json(wrapEnvelope(result, sessionId, db))
        }

        // ─── Admin: force dream (Phase 7+) ────────────────────────
        if (path === '/admin/force-dream' && method === 'POST') {
          triggerTick?.({ source: 'force_dream', reason: 'Manual dream trigger via /admin/force-dream' })
          return json({ ok: true, message: 'Dream tick queued' })
        }

        return new Response('Not found', { status: 404 })
      } catch (err) {
        logError('HTTP handler error', err)
        return json({ error: String(err) }, 500)
      }
    },
  })

  log(`HTTP server listening on http://127.0.0.1:${port}`)
  return server
}

// ─── Tool handler dispatcher ──────────────────────────────────────

async function handleTool(
  name: string,
  body: Record<string, unknown>,
  sessionId: string,
  sessionCwd: string,
  db: Database,
  config: Config,
  triggerTick?: (event: { source: string; reason: string }) => void,
): Promise<unknown> {
  switch (name) {
    case 'kairos_assign': {
      const taskId = queries.createTask(db, {
        description: body.description as string,
        sessionId,
        priority: (body.priority as string) ?? 'normal',
        permissionMode: (body.permission_mode as string) ?? 'auto',
        workingDir: (body.working_dir as string) ?? sessionCwd,
        watch: body.watch as boolean,
        tickInterval: body.tick_interval_sec as number,
      })
      triggerTick?.({ source: 'new_task', reason: `Task ${taskId} queued` })
      return { task_id: taskId, status: 'queued', message: 'Task queued. Will begin on next tick.' }
    }

    case 'kairos_tell': {
      // Direct message → create a high-priority task
      const taskId = queries.createTask(db, {
        description: `User said: ${body.message as string}. Respond briefly in your voice.`,
        sessionId,
        priority: 'high',
        workingDir: sessionCwd,
      })
      triggerTick?.({ source: 'new_task', reason: `Direct message → task ${taskId}` })
      return { task_id: taskId, status: 'queued', message: 'Got it. Will respond on next tick.' }
    }

    case 'kairos_status': {
      const summary = queries.getDaemonSummary(db)
      const running = queries.getRunningTasks(db)
      return {
        daemon_status: 'running',
        ...summary,
        currently_executing: running.length > 0 ? {
          task_id: running[0]!.task_id,
          description: running[0]!.description,
          started_at: running[0]!.started_at,
        } : null,
      }
    }

    case 'kairos_inbox': {
      const peek = body.peek as boolean ?? false
      const messages = queries.getUnreadMessages(db, sessionId)
      if (!peek && messages.length > 0) {
        queries.markMessagesRead(db, messages.map(m => m.message_id))
      }
      return { messages, unread_count: messages.length }
    }

    case 'kairos_approve': {
      // Phase 6 will implement the full approval flow
      return { ok: false, message: 'Approval flow not yet implemented (Phase 6).' }
    }

    case 'kairos_tasks': {
      const taskId = body.task_id as string | undefined
      if (taskId) {
        const task = queries.getTask(db, taskId)
        return task ?? { error: `Task ${taskId} not found` }
      }
      const status = body.status as string
      if (status && status !== 'all') {
        return { tasks: db.query('SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, (body.limit as number) ?? 20) }
      }
      return { tasks: queries.getAllTasks(db, (body.limit as number) ?? 20) }
    }

    case 'kairos_history': {
      const limit = (body.limit as number) ?? 20
      const ticks = queries.getRecentTicks(db, limit)
      return { events: ticks }
    }

    case 'kairos_cancel': {
      const taskId = body.task_id as string
      if (!taskId) return { ok: false, error: 'task_id required' }
      const task = queries.getTask(db, taskId)
      if (!task) return { ok: false, error: `Task ${taskId} not found` }
      queries.updateTaskStatus(db, taskId, 'cancelled')
      return { ok: true, was_running: task.status === 'running' }
    }

    case 'kairos_control': {
      const action = body.action as string
      switch (action) {
        case 'shutdown':
          log('Shutdown requested via kairos_control')
          setTimeout(() => process.kill(process.pid, 'SIGTERM'), 1000)
          return { ok: true, message: 'Shutting down in 1s.' }
        case 'pause':
        case 'resume':
          // Phase 3+ will implement pause/resume
          return { ok: true, message: `${action} will be implemented in Phase 3.` }
        case 'cancel_task': {
          const tid = body.task_id as string
          if (!tid) return { ok: false, error: 'task_id required for cancel_task' }
          queries.updateTaskStatus(db, tid, 'cancelled')
          return { ok: true }
        }
        default:
          return { ok: false, error: `Unknown action: ${action}` }
      }
    }

    case 'kairos_schedule': {
      const action = (body.action as string) ?? 'list'
      // Lazy import to avoid circular deps at startup
      const { ScheduleManager } = await import('./scheduleManager')
      const mgr = new ScheduleManager(db, config)

      switch (action) {
        case 'list':
          return { schedules: queries.getActiveSchedules(db) }
        case 'create': {
          const result = await mgr.create({
            description: body.description as string,
            schedule: body.schedule as string,
            workingDir: (body.working_dir as string) ?? sessionCwd,
            priority: body.priority as string,
            sessionId,
          })
          if (result.error) return { ok: false, error: result.error }

          // If the schedule fires within 2 minutes, set a timer to wake the
          // tick loop at the exact fire time. Without this, a "in 10 seconds"
          // schedule would wait for the next tick (up to 5 min).
          if (result.nextFireAt && result.nextFireAt - Date.now() < 120_000) {
            const delay = Math.max(1000, result.nextFireAt - Date.now())
            setTimeout(() => {
              triggerTick?.({ source: 'schedule_due', reason: `Schedule ${result.scheduleId} due` })
            }, delay)
          }

          return {
            ok: true,
            schedule_id: result.scheduleId,
            next_fire: result.nextFireAt ? new Date(result.nextFireAt).toLocaleString() : null,
          }
        }
        case 'delete': {
          const sid = body.schedule_id as string
          if (!sid) return { ok: false, error: 'schedule_id required' }
          queries.deleteSchedule(db, sid)
          return { ok: true }
        }
        case 'pause': {
          const sid = body.schedule_id as string
          if (!sid) return { ok: false, error: 'schedule_id required' }
          queries.deactivateSchedule(db, sid)
          return { ok: true, message: 'Schedule paused.' }
        }
        case 'resume': {
          const sid = body.schedule_id as string
          if (!sid) return { ok: false, error: 'schedule_id required' }
          db.run('UPDATE schedules SET active = 1 WHERE schedule_id = ?', [sid])
          return { ok: true, message: 'Schedule resumed.' }
        }
        default:
          return { ok: false, error: `Unknown schedule action: ${action}` }
      }
    }

    case 'kairos_observe': {
      const action = (body.action as string) ?? 'list'
      switch (action) {
        case 'list': {
          const cat = body.category as string | undefined
          let obs = queries.getActiveObservations(db)
          if (cat) obs = obs.filter(o => o.category === cat)
          return { observations: obs }
        }
        case 'dismiss': {
          const oid = body.observation_id as string
          if (!oid) return { ok: false, error: 'observation_id required' }
          queries.dismissObservation(db, oid)
          return { ok: true, message: 'Observation dismissed. KAIROS will learn from this.' }
        }
        case 'act': {
          const oid = body.observation_id as string
          if (!oid) return { ok: false, error: 'observation_id required' }
          const obs = db.query('SELECT * FROM observations WHERE observation_id = ?').get(oid) as any
          if (!obs) return { ok: false, error: 'Observation not found' }
          queries.actOnObservation(db, oid)
          // Create a task from the suggested action
          const taskId = queries.createTask(db, {
            description: obs.suggested_action ?? obs.description,
            sessionId,
            workingDir: sessionCwd,
          })
          triggerTick?.({ source: 'new_task', reason: `User acted on observation ${oid}` })
          return { ok: true, task_id: taskId, message: 'Task created from observation. KAIROS will learn from this.' }
        }
        case 'scan_now': {
          triggerTick?.({ source: 'observation_scan', reason: 'Manual scan requested' })
          return { ok: true, message: 'Environment scan queued. Results on next tick.' }
        }
        default:
          return { ok: false, error: `Unknown observe action: ${action}` }
      }
    }

    case 'kairos_feedback': {
      const { FeedbackCollector } = await import('./feedbackCollector')
      const collector = new FeedbackCollector(db, config)
      collector.recordExplicit({
        messageId: body.message_id as string | undefined,
        observationId: body.observation_id as string | undefined,
        rating: (body.rating as 'good' | 'bad' | 'useless' | 'perfect') ?? 'good',
        comment: body.comment as string | undefined,
      })
      return { ok: true, message: 'Feedback recorded. KAIROS will evolve based on this.' }
    }

    case 'kairos_skills': {
      const action = (body.action as string) ?? 'list'
      const registry = (globalThis as { __kairosSkillRegistry?: import('./skillRegistry').SkillRegistry }).__kairosSkillRegistry
      if (!registry) return { ok: false, error: 'Skill registry not initialized' }

      switch (action) {
        case 'list':
          return {
            count: registry.listSkills().length,
            skills: registry.listSkills().map(s => ({
              name: s.name,
              description: s.description,
              when_to_use: s.when_to_use,
              category: s.category ?? 'general',
              generated: s.generated ?? false,
            })),
          }

        case 'describe': {
          const name = body.name as string
          const skill = registry.getSkill(name)
          if (!skill) return { ok: false, error: `Skill not found: ${name}` }
          return { ok: true, skill }
        }

        case 'invoke': {
          const name = body.name as string
          const args = (body.args as string[]) ?? []
          if (!name) return { ok: false, error: 'name required for invoke' }
          const result = await registry.invokeSkill(name, args)
          return { ok: result.ok, ...result }
        }

        case 'reload': {
          const count = registry.loadSkills()
          return { ok: true, count, message: `Reloaded ${count} skill(s)` }
        }

        case 'generate': {
          // L2: Self-generated skills. KAIROS writes a new skill from a
          // natural-language description.
          const generator = (globalThis as { __kairosSkillGenerator?: import('./skillGenerator').SkillGenerator }).__kairosSkillGenerator
          if (!generator) return { ok: false, error: 'Skill generator not initialized' }
          const description = body.description as string
          if (!description) return { ok: false, error: 'description required for generate' }
          const result = await generator.generateSkill({
            description,
            example_use: body.example_use as string | undefined,
            output_format: (body.output_format as 'json' | 'text') ?? 'json',
            category: (body.category as string) ?? 'general',
          })
          return result
        }

        case 'staged': {
          const generator = (globalThis as { __kairosSkillGenerator?: import('./skillGenerator').SkillGenerator }).__kairosSkillGenerator
          if (!generator) return { ok: false, error: 'Skill generator not initialized' }
          return { ok: true, staged: generator.listStagedSkills() }
        }

        case 'discard': {
          const generator = (globalThis as { __kairosSkillGenerator?: import('./skillGenerator').SkillGenerator }).__kairosSkillGenerator
          if (!generator) return { ok: false, error: 'Skill generator not initialized' }
          const name = body.name as string
          if (!name) return { ok: false, error: 'name required for discard' }
          return { ok: generator.discardStaged(name), message: `Discarded staged skill: ${name}` }
        }

        default:
          return { ok: false, error: `Unknown skills action: ${action}. Use list/describe/invoke/reload/generate/staged/discard.` }
      }
    }

    case 'kairos_debug': {
      // Self-debugger: inspect recurring errors & manually trigger scans
      const dbg = (globalThis as { __kairosSelfDebugger?: import('./selfDebugger').SelfDebugger }).__kairosSelfDebugger
      if (!dbg) return { ok: false, error: 'Self-debugger not initialized' }
      const action = (body.action as string) ?? 'list'

      switch (action) {
        case 'list':
          return { patterns: dbg.listPatterns(false) }
        case 'all':
          return { patterns: dbg.listPatterns(true) }
        case 'scan': {
          const count = await dbg.scan()
          return { ok: true, new_errors_found: count }
        }
        case 'unsilence': {
          const fp = body.fingerprint as string
          if (!fp) return { ok: false, error: 'fingerprint required' }
          dbg.unsilence(fp)
          return { ok: true, message: `Unsilenced pattern ${fp}` }
        }
        default:
          return { ok: false, error: `Unknown debug action: ${action}` }
      }
    }

    case 'kairos_self_modify': {
      // L5: Self-modifying source code. KAIROS proposes patches to its own
      // TypeScript source. All patches require explicit user approval.
      const evo = (globalThis as { __kairosSourceEvolution?: import('./sourceEvolution').SourceEvolution }).__kairosSourceEvolution
      if (!evo) return { ok: false, error: 'Source evolution not initialized' }
      const action = (body.action as string) ?? 'list'

      switch (action) {
        case 'propose': {
          const targetFile = body.target_file as string
          const reason = body.reason as string
          if (!targetFile || !reason) return { ok: false, error: 'target_file and reason required' }
          const result = await evo.proposePatch({ targetFile, reason })
          return result
        }

        case 'list':
        case 'pending':
          return { patches: evo.listPending() }

        case 'all':
          return { patches: evo.listAll((body.limit as number) ?? 20) }

        case 'show': {
          const patchId = body.patch_id as string
          if (!patchId) return { ok: false, error: 'patch_id required' }
          const patch = evo.getPatch(patchId)
          if (!patch) return { ok: false, error: 'Patch not found' }
          return { patch }
        }

        case 'approve':
        case 'apply': {
          const patchId = body.patch_id as string
          if (!patchId) return { ok: false, error: 'patch_id required' }
          const result = await evo.approveAndApply(patchId)
          return result
        }

        case 'reject': {
          const patchId = body.patch_id as string
          const reason = body.reason as string | undefined
          if (!patchId) return { ok: false, error: 'patch_id required' }
          const ok = evo.reject(patchId, reason)
          return { ok, message: ok ? 'Patch rejected' : 'Could not reject (already applied or not found)' }
        }

        case 'revert': {
          const patchId = body.patch_id as string
          if (!patchId) return { ok: false, error: 'patch_id required' }
          return await evo.revert(patchId)
        }

        default:
          return { ok: false, error: `Unknown self_modify action: ${action}. Use propose/list/show/approve/reject/revert.` }
      }
    }

    case 'kairos_prompts': {
      // L4: Self-evolving prompts. Inspect versions, create experiments,
      // promote winners, view metrics.
      const evo = (globalThis as { __kairosPromptEvolution?: import('./promptEvolution').PromptEvolution }).__kairosPromptEvolution
      if (!evo) return { ok: false, error: 'Prompt evolution not initialized' }
      const action = (body.action as string) ?? 'list'

      switch (action) {
        case 'list': {
          const promptName = body.prompt_name as string | undefined
          return { versions: evo.listVersions(promptName) }
        }

        case 'metrics': {
          const promptName = body.prompt_name as string
          if (!promptName) return { ok: false, error: 'prompt_name required' }
          return { metrics: evo.computeMetrics(promptName) }
        }

        case 'experiment': {
          const promptName = body.prompt_name as string
          const newContent = body.content as string
          const notes = body.notes as string | undefined
          if (!promptName || !newContent) return { ok: false, error: 'prompt_name and content required' }
          const version = evo.createExperiment(promptName, newContent, notes)
          return { ok: true, version, message: `Experiment created: ${promptName}/${version}` }
        }

        case 'promote': {
          const promptName = body.prompt_name as string
          const version = body.version as string
          if (!promptName || !version) return { ok: false, error: 'prompt_name and version required' }
          try {
            evo.promote(promptName, version)
            return { ok: true, message: `Promoted ${promptName}/${version} to active` }
          } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) }
          }
        }

        case 'auto-promote': {
          const promptName = body.prompt_name as string
          if (!promptName) return { ok: false, error: 'prompt_name required' }
          const promoted = evo.autoPromote(promptName, {
            minSamples: (body.min_samples as number) ?? 50,
            minImprovement: (body.min_improvement as number) ?? 0.15,
          })
          return { ok: true, promoted, message: promoted ? 'Experiment promoted' : 'No experiment qualified for auto-promotion' }
        }

        case 'discard': {
          const promptName = body.prompt_name as string
          const version = body.version as string
          if (!promptName || !version) return { ok: false, error: 'prompt_name and version required' }
          evo.discardExperiment(promptName, version)
          return { ok: true, message: `Discarded ${promptName}/${version}` }
        }

        default:
          return { ok: false, error: `Unknown prompts action: ${action}. Use list/metrics/experiment/promote/auto-promote/discard.` }
      }
    }

    case 'kairos_gaps': {
      // L3: Skill gap detection and management
      const detector = (globalThis as { __kairosSkillGapDetector?: import('./skillGapDetector').SkillGapDetector }).__kairosSkillGapDetector
      if (!detector) return { ok: false, error: 'Gap detector not initialized' }
      const action = (body.action as string) ?? 'list'

      switch (action) {
        case 'list':
          return { gaps: detector.listAll(false) }

        case 'all':
          return { gaps: detector.listAll(true) }

        case 'scan': {
          const count = detector.scanFailures()
          return { ok: true, gaps_recorded: count, message: `Scanned recent failures, recorded ${count} gap signals` }
        }

        case 'candidates': {
          const minOcc = (body.min_occurrences as number) ?? 2
          return { candidates: detector.getProposalCandidates(minOcc) }
        }

        case 'fill': {
          // User accepts a gap proposal — KAIROS generates a skill for it
          const gapId = body.gap_id as string
          if (!gapId) return { ok: false, error: 'gap_id required for fill' }
          const gap = (db.query('SELECT * FROM skill_gaps WHERE gap_id = ?').get(gapId)) as import('./skillGapDetector').SkillGap | null
          if (!gap) return { ok: false, error: `Gap not found: ${gapId}` }

          const generator = (globalThis as { __kairosSkillGenerator?: import('./skillGenerator').SkillGenerator }).__kairosSkillGenerator
          if (!generator) return { ok: false, error: 'Skill generator not available' }

          const skillDesc = gap.proposed_skill_desc ?? `Address the ${gap.category} gap: ${gap.description}`
          const result = await generator.generateSkill({
            description: skillDesc,
            category: gap.category,
            output_format: 'json',
          })
          if (result.ok) {
            detector.markActed(gapId)
          }
          return { ...result, gap_filled: gapId }
        }

        case 'dismiss': {
          const gapId = body.gap_id as string
          if (!gapId) return { ok: false, error: 'gap_id required for dismiss' }
          detector.dismiss(gapId)
          return { ok: true, message: `Dismissed gap ${gapId}` }
        }

        default:
          return { ok: false, error: `Unknown gaps action: ${action}. Use list/all/scan/candidates/fill/dismiss.` }
      }
    }

    default:
      return { error: `Unknown tool: ${name}` }
  }
}

// ─── Response helpers ─────────────────────────────────────────────

const daemonStartTime = Date.now()

function json(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function wrapEnvelope(result: unknown, sessionId: string, db: Database): ResponseEnvelope {
  const summary = queries.getDaemonSummary(db)
  const pending = queries.getUnreadMessages(db, sessionId)
  return {
    result,
    _kairos_state: {
      tick_count: summary.tickCount,
      queue_depth: summary.queueDepth,
      running_count: summary.runningCount,
      pending_approvals: summary.pendingApprovals,
      connected_clients: summary.connectedClients,
    },
    _kairos_pending: pending,
  }
}
