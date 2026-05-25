// src/daemon/onboarding/mcpConfigMutator.ts
// Atomic JSON edits to ~/.kairos/mcp-servers.json.

import { readFileSync, writeFileSync, existsSync, renameSync } from 'fs'
import type { McpServerConfig } from '../mcp/types'

type ConfigShape = { servers: McpServerConfig[] }

export class McpConfigMutator {
  constructor(private path: string) {}

  read(): ConfigShape {
    if (!existsSync(this.path)) return { servers: [] }
    try { return JSON.parse(readFileSync(this.path, 'utf8')) } catch { return { servers: [] } }
  }

  write(cfg: ConfigShape): void {
    const tmpPath = `${this.path}.tmp.${process.pid}`
    writeFileSync(tmpPath, JSON.stringify(cfg, null, 2))
    renameSync(tmpPath, this.path)
  }

  addServer(server: McpServerConfig): void {
    const cfg = this.read()
    if (cfg.servers.some(s => s.id === server.id)) {
      throw new Error(`McpConfigMutator: server id '${server.id}' already exists`)
    }
    cfg.servers.push(server)
    this.write(cfg)
  }

  updateServer(id: string, fn: (s: McpServerConfig) => McpServerConfig): void {
    const cfg = this.read()
    const idx = cfg.servers.findIndex(s => s.id === id)
    if (idx === -1) throw new Error(`McpConfigMutator: server '${id}' not found`)
    cfg.servers[idx] = fn(cfg.servers[idx]!)
    this.write(cfg)
  }

  removeServer(id: string): void {
    const cfg = this.read()
    cfg.servers = cfg.servers.filter(s => s.id !== id)
    this.write(cfg)
  }

  snapshot(): ConfigShape {
    return JSON.parse(JSON.stringify(this.read()))
  }

  restore(snap: ConfigShape): void {
    this.write(snap)
  }
}
