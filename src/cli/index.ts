#!/usr/bin/env bun
//
// KAIROS CLI — quick commands from any terminal.
// Talks to the daemon via HTTP. No MCP, no Claude Code needed.
//
// Usage:
//   kairos inbox              — show pending messages
//   kairos status             — daemon status
//   kairos act <obs_id>       — act on an observation
//   kairos dismiss <obs_id>   — dismiss an observation
//   kairos approve <appr_id>  — approve a blocked command
//   kairos deny <appr_id>     — deny a blocked command
//   kairos schedules          — list active schedules
//   kairos tasks              — list recent tasks
//   kairos feedback <good|bad|useless|perfect> [message_id]

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const SANDBOX_DIR = process.env.KAIROS_SANDBOX_DIR
  ?? join(import.meta.dir, '..', '..')

function getPort(): number | null {
  const portFile = join(SANDBOX_DIR, 'runtime', 'port.txt')
  if (!existsSync(portFile)) return null
  try {
    return parseInt(readFileSync(portFile, 'utf8').trim())
  } catch {
    return null
  }
}

async function api(method: string, path: string, body?: unknown): Promise<unknown> {
  const port = getPort()
  if (!port) {
    console.error('KAIROS daemon is not running. Start Claude Code first.')
    process.exit(1)
  }

  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) {
      console.error(`HTTP ${res.status}: ${await res.text()}`)
      process.exit(1)
    }
    return res.json()
  } catch (err) {
    console.error(`Cannot reach KAIROS daemon on port ${port}. Is it running?`)
    process.exit(1)
  }
}

const [cmd, ...args] = process.argv.slice(2)

switch (cmd) {
  case 'inbox': {
    const data = await api('GET', '/inbox/broadcast?peek=false') as any[]
    if (data.length === 0) {
      console.log('  📭 No pending messages.')
    } else {
      console.log(`  📨 ${data.length} message(s):\n`)
      for (const msg of data) {
        const time = new Date(msg.created_at).toLocaleTimeString()
        console.log(`  [${time}] [${msg.kind}] ${msg.body}`)
        console.log()
      }
    }
    break
  }

  case 'status': {
    const data = await api('GET', '/status') as Record<string, unknown>
    console.log()
    console.log(`  ⚡ KAIROS daemon`)
    console.log(`     Status:     ${data.daemon_status}`)
    console.log(`     Port:       ${data.port}`)
    console.log(`     Uptime:     ${data.uptime_sec}s`)
    console.log(`     Ticks:      ${data.tickCount}`)
    console.log(`     Queue:      ${data.queueDepth}`)
    console.log(`     Running:    ${data.runningCount}`)
    console.log(`     Clients:    ${data.connectedClients}`)
    console.log(`     Approvals:  ${data.pendingApprovals}`)
    console.log()
    break
  }

  case 'act': {
    const obsId = args[0]
    if (!obsId) { console.error('Usage: kairos act <observation_id>'); process.exit(1) }
    const data = await api('POST', '/tool/kairos_observe', {
      action: 'act',
      observation_id: obsId,
      session_id: 'cli',
      session_cwd: process.cwd(),
    }) as any
    const result = data.result ?? data
    if (result.ok) {
      console.log(`  ✓ Task ${result.task_id} created from observation. KAIROS is on it.`)
    } else {
      console.error(`  ✗ ${result.error ?? 'Failed'}`)
    }
    break
  }

  case 'dismiss': {
    const obsId = args[0]
    if (!obsId) { console.error('Usage: kairos dismiss <observation_id>'); process.exit(1) }
    const data = await api('POST', '/tool/kairos_observe', {
      action: 'dismiss',
      observation_id: obsId,
      session_id: 'cli',
      session_cwd: process.cwd(),
    }) as any
    console.log(`  ✓ Observation dismissed. KAIROS will learn from this.`)
    break
  }

  case 'approve': {
    const apprId = args[0]
    if (!apprId) { console.error('Usage: kairos approve <approval_id>'); process.exit(1) }
    const data = await api('POST', '/tool/kairos_approve', {
      approval_id: apprId,
      decision: 'approve',
      session_id: 'cli',
      session_cwd: process.cwd(),
    }) as any
    console.log(`  ✓ Approved. Task will resume.`)
    break
  }

  case 'deny': {
    const apprId = args[0]
    if (!apprId) { console.error('Usage: kairos deny <approval_id>'); process.exit(1) }
    const data = await api('POST', '/tool/kairos_approve', {
      approval_id: apprId,
      decision: 'deny',
      session_id: 'cli',
      session_cwd: process.cwd(),
    }) as any
    console.log(`  ✓ Denied.`)
    break
  }

  case 'schedules': {
    const data = await api('POST', '/tool/kairos_schedule', {
      action: 'list',
      session_id: 'cli',
      session_cwd: process.cwd(),
    }) as any
    const scheds = data.result?.schedules ?? []
    if (scheds.length === 0) {
      console.log('  No active schedules.')
    } else {
      console.log(`  ${scheds.length} schedule(s):\n`)
      for (const s of scheds) {
        const next = s.next_fire_at ? new Date(s.next_fire_at).toLocaleString() : 'N/A'
        console.log(`  [${s.schedule_id}] "${s.description}" — ${s.cron_human} — next: ${next} (fired ${s.fire_count}x)`)
      }
    }
    console.log()
    break
  }

  case 'tasks': {
    const data = await api('POST', '/tool/kairos_tasks', {
      limit: 10,
      session_id: 'cli',
      session_cwd: process.cwd(),
    }) as any
    const tasks = data.result?.tasks ?? []
    if (tasks.length === 0) {
      console.log('  No tasks.')
    } else {
      console.log(`  ${tasks.length} task(s):\n`)
      for (const t of tasks) {
        const icon = t.status === 'done' ? '✓' : t.status === 'running' ? '⏳' : t.status === 'queued' ? '📋' : '✗'
        console.log(`  ${icon} [${t.task_id}] ${t.status} — ${t.description.slice(0, 60)}`)
      }
    }
    console.log()
    break
  }

  case 'observations':
  case 'obs': {
    const data = await api('POST', '/tool/kairos_observe', {
      action: 'list',
      session_id: 'cli',
      session_cwd: process.cwd(),
    }) as any
    const obs = data.result?.observations ?? []
    if (obs.length === 0) {
      console.log('  No active observations.')
    } else {
      console.log(`  ${obs.length} observation(s):\n`)
      for (const o of obs) {
        const icon = o.severity === 'critical' ? '🔴' : o.severity === 'warning' ? '🟡' : '🔵'
        console.log(`  ${icon} [${o.observation_id}] ${o.category}: ${o.description}`)
        if (o.suggested_action) {
          console.log(`     → ${o.suggested_action}`)
        }
      }
    }
    console.log()
    break
  }

  case 'feedback': {
    const rating = args[0] as 'good' | 'bad' | 'useless' | 'perfect'
    if (!rating || !['good', 'bad', 'useless', 'perfect'].includes(rating)) {
      console.error('Usage: kairos feedback <good|bad|useless|perfect> [message_id]')
      process.exit(1)
    }
    await api('POST', '/tool/kairos_feedback', {
      rating,
      message_id: args[1] ?? undefined,
      comment: args.slice(2).join(' ') || undefined,
      session_id: 'cli',
      session_cwd: process.cwd(),
    })
    console.log(`  ✓ Feedback recorded: ${rating}. KAIROS will evolve.`)
    break
  }

  case 'scan': {
    await api('POST', '/tool/kairos_observe', {
      action: 'scan_now',
      session_id: 'cli',
      session_cwd: process.cwd(),
    })
    console.log('  ✓ Environment scan queued. Check back in a few seconds.')
    break
  }

  case undefined:
  case 'help': {
    console.log(`
  ⚡ KAIROS CLI — quick commands from any terminal

  Usage: kairos <command> [args]

  Messages:
    inbox                      Show pending messages from KAIROS
    status                     Daemon status (ticks, queue, clients)

  Observations:
    obs / observations         List active environment observations
    act <observation_id>       Act on a suggestion (creates a task)
    dismiss <observation_id>   Dismiss (KAIROS learns it was unhelpful)
    scan                       Force an immediate environment scan

  Approvals:
    approve <approval_id>      Approve a blocked command (git push, etc.)
    deny <approval_id>         Deny a blocked command

  Schedules:
    schedules                  List active scheduled tasks

  Tasks:
    tasks                      List recent tasks

  Feedback:
    feedback <rating> [id]     Rate KAIROS: good, bad, useless, perfect

  The daemon must be running (started by Claude Code).
`)
    break
  }

  default:
    console.error(`Unknown command: ${cmd}. Run 'kairos help' for usage.`)
    process.exit(1)
}
