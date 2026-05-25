// CLI entry for inbox approve/dismiss. Posts to the running daemon's
// /agency/approve or /agency/dismiss HTTP endpoints.
//
// Usage:
//   kairos approve <item_id>
//   kairos dismiss <item_id> [reason]
//
// Directly runnable: bun run src/cli/agency.ts <command> ...

export type CliResult = {
  exitCode: number
  stdout: string
}

export type CliOptions = {
  daemonUrl?: string
}

const DEFAULT_DAEMON_URL = 'http://localhost:9876'

export async function runAgencyCommand(argv: string[], opts: CliOptions = {}): Promise<CliResult> {
  const url = opts.daemonUrl ?? DEFAULT_DAEMON_URL
  const cmd = argv[0]

  if (cmd === 'approve') {
    const itemId = argv[1]
    if (!itemId) return { exitCode: 2, stdout: 'usage: kairos approve <item_id>' }
    try {
      const resp = await fetch(`${url}/agency/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item_id: itemId }),
      })
      if (!resp.ok) return { exitCode: 3, stdout: `daemon returned ${resp.status}` }
      const data = await resp.json() as { status?: string }
      return { exitCode: 0, stdout: `approved: ${data.status ?? 'unknown'}` }
    } catch (err) {
      return { exitCode: 4, stdout: `daemon unreachable: ${err instanceof Error ? err.message : err}` }
    }
  }

  if (cmd === 'dismiss') {
    const itemId = argv[1]
    if (!itemId) return { exitCode: 2, stdout: 'usage: kairos dismiss <item_id> [reason]' }
    const reason = argv.slice(2).join(' ') || 'user dismissed'
    try {
      const resp = await fetch(`${url}/agency/dismiss`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item_id: itemId, reason }),
      })
      if (!resp.ok) return { exitCode: 3, stdout: `daemon returned ${resp.status}` }
      return { exitCode: 0, stdout: 'dismissed' }
    } catch (err) {
      return { exitCode: 4, stdout: `daemon unreachable: ${err instanceof Error ? err.message : err}` }
    }
  }

  return { exitCode: 2, stdout: `unknown command: ${cmd}. Use 'approve' or 'dismiss'.` }
}

// Direct CLI entry — only runs when invoked as a script
if (import.meta.main) {
  const args = process.argv.slice(2)
  const result = await runAgencyCommand(args)
  console.log(result.stdout)
  process.exit(result.exitCode)
}
