import { existsSync, readFileSync } from 'fs'
import { createHash } from 'crypto'

export class OrdersParser {
  constructor(private path: string) {}

  read(): string {
    if (!existsSync(this.path)) return ''
    return readFileSync(this.path, 'utf8')
  }

  hash(): string {
    const content = this.read()
    return createHash('sha256').update(content).digest('hex').slice(0, 16)
  }

  bullets(): string[] {
    const content = this.read()
    const rules: string[] = []
    for (const line of content.split('\n')) {
      const m = line.match(/^\s*-\s+(.+)$/)
      if (m && !m[1]!.startsWith('#')) rules.push(m[1]!.trim())
    }
    return rules
  }
}
