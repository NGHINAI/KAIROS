// src/daemon/restraint/cooldownTracker.ts
// Per-trigger debounce. In-memory; resets on daemon restart (intentional —
// fresh start should fire fresh).

export class CooldownTracker {
  private lastFiredAt: Map<string, number> = new Map()

  constructor(
    private defaultCooldownMs: number,
    private overrides: Record<string, number> = {},
  ) {}

  canFire(triggerId: string): boolean {
    const lastMs = this.lastFiredAt.get(triggerId)
    if (lastMs === undefined) return true
    const cooldown = this.overrides[triggerId] ?? this.defaultCooldownMs
    return Date.now() - lastMs >= cooldown
  }

  recordFire(triggerId: string): void {
    this.lastFiredAt.set(triggerId, Date.now())
  }

  reset(): void {
    this.lastFiredAt.clear()
  }
}
