// Watches STANDING_ORDERS.md for changes (poll every 5s by default),
// recompiles via OrdersCompiler when content hash changes.
// Exposes text() for Tier 2 to inject into perception prompts.

import { log, logError } from '../logger'
import type { OrdersParser } from './parser'
import type { OrdersCompiler } from './compiler'

export type OrdersRuntimeOptions = {
  pollMs?: number
}

export class OrdersRuntime {
  private timer: ReturnType<typeof setInterval> | null = null
  private pollMs: number
  private lastHash: string = ''

  constructor(
    private parser: OrdersParser,
    private compiler: OrdersCompiler,
    opts?: OrdersRuntimeOptions,
  ) {
    this.pollMs = opts?.pollMs ?? 5000
  }

  async start(): Promise<void> {
    await this.recompileIfChanged()
    this.timer = setInterval(() => { void this.recompileIfChanged() }, this.pollMs)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  text(): string {
    return this.parser.read()
  }

  private async recompileIfChanged(): Promise<void> {
    try {
      const hash = this.parser.hash()
      if (hash === this.lastHash) return
      const rules = this.parser.bullets()
      const result = await this.compiler.compile(rules, hash)
      this.lastHash = hash
      if (!result.skipped) {
        log(`OrdersRuntime: recompiled (${rules.length} rules → ${result.triggers.length} triggers)`)
      }
    } catch (err) {
      logError('OrdersRuntime: recompile error', err)
    }
  }
}
