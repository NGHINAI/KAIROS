// src/daemon/agents/selfHealConnect.ts
import { spawn } from "bun"

interface ComposioConnect {
  initiateConnection(args: { toolkit: string }): Promise<{ connection_id: string; redirect_url: string }>
  getConnection(id: string): Promise<{ status: string }>
}

export interface SelfHealConnectOpts {
  composio: ComposioConnect
  openBrowser?: (url: string) => Promise<void>
  pollIntervalMs?: number
  maxWaitMs?: number
}

export type ConnectResult<T> =
  | { status: "connected"; toolResult: T }
  | { status: "timeout" }
  | { status: "failed"; error: string }

export class SelfHealConnect {
  constructor(private opts: SelfHealConnectOpts) {}

  async connectAndRetry<T>(toolkit: string, retryFn: () => Promise<T>): Promise<ConnectResult<T>> {
    const { connection_id, redirect_url } = await this.opts.composio.initiateConnection({ toolkit })

    const opener = this.opts.openBrowser ?? defaultOpenBrowser
    await opener(redirect_url)

    const interval = this.opts.pollIntervalMs ?? 2000
    const maxWait = this.opts.maxWaitMs ?? 120_000
    const start = Date.now()

    while (Date.now() - start < maxWait) {
      const conn = await this.opts.composio.getConnection(connection_id)
      if (conn.status === "ACTIVE") {
        try {
          const toolResult = await retryFn()
          return { status: "connected", toolResult }
        } catch (e) {
          return { status: "failed", error: (e as Error).message }
        }
      }
      if (conn.status === "FAILED" || conn.status === "EXPIRED") {
        return { status: "failed", error: `connection ${conn.status}` }
      }
      await new Promise((r) => setTimeout(r, interval))
    }
    return { status: "timeout" }
  }
}

async function defaultOpenBrowser(url: string): Promise<void> {
  const proc = spawn({ cmd: ["open", url], stdout: "ignore", stderr: "ignore" })
  await proc.exited
}
