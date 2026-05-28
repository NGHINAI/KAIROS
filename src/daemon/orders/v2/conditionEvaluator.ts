// src/daemon/orders/v2/conditionEvaluator.ts
// Safe expression evaluator. Tokenizer + recursive-descent parser.
// Restricted grammar:
//   - identifier paths (persona.X, payload.X.Y)
//   - comparisons: == != > < >= <=
//   - boolean ops: && || !
//   - allowlist function calls: time.between("HH:MM","HH:MM")
// NO eval().

export type EvalContext = {
  persona?: Record<string, unknown>
  payload?: Record<string, unknown>
  trigger?: Record<string, unknown>
  now?: number   // ms epoch for time.* functions; defaults to Date.now()
}

type Token = { type: string; value: string }

const ALLOWED_FUNCTIONS = new Set(['time.between'])

function tokenize(src: string): Token[] {
  const out: Token[] = []
  let i = 0
  const len = src.length
  while (i < len) {
    const c = src[i]!
    if (/\s/.test(c)) { i++; continue }
    if (c === '"' || c === "'") {
      const quote = c
      let j = i + 1
      while (j < len && src[j] !== quote) j++
      out.push({ type: 'string', value: src.slice(i + 1, j) })
      i = j + 1
      continue
    }
    if (/[0-9]/.test(c)) {
      let j = i
      while (j < len && /[0-9.]/.test(src[j]!)) j++
      out.push({ type: 'number', value: src.slice(i, j) })
      i = j
      continue
    }
    if (/[a-zA-Z_]/.test(c)) {
      let j = i
      while (j < len && /[a-zA-Z0-9_.]/.test(src[j]!)) j++
      out.push({ type: 'ident', value: src.slice(i, j) })
      i = j
      continue
    }
    if (src.slice(i, i + 2) === '==' || src.slice(i, i + 2) === '!=' ||
        src.slice(i, i + 2) === '>=' || src.slice(i, i + 2) === '<=' ||
        src.slice(i, i + 2) === '&&' || src.slice(i, i + 2) === '||') {
      out.push({ type: 'op', value: src.slice(i, i + 2) })
      i += 2
      continue
    }
    if ('()!,><'.includes(c)) {
      out.push({ type: c === '(' || c === ')' || c === ',' ? c : 'op', value: c })
      i++
      continue
    }
    throw new Error(`unexpected character: ${c}`)
  }
  return out
}

function getPath(ctx: EvalContext, path: string): unknown {
  const [scope, ...rest] = path.split('.')
  const root = (ctx as Record<string, unknown>)[scope!]
  if (root == null) return undefined
  let cur: unknown = root
  for (const k of rest) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[k]
  }
  return cur
}

function timeBetween(hhmmStart: string, hhmmEnd: string, now: number): boolean {
  const d = new Date(now)
  const cur = d.getHours() * 60 + d.getMinutes()
  const [sh, sm] = hhmmStart.split(':').map(Number) as [number, number]
  const [eh, em] = hhmmEnd.split(':').map(Number) as [number, number]
  const s = sh * 60 + sm
  const e = eh * 60 + em
  if (s <= e) return cur >= s && cur <= e
  return cur >= s || cur <= e
}

export class ConditionEvaluator {
  evaluate(expr: string, ctx: EvalContext): boolean {
    const tokens = tokenize(expr)
    if (tokens.length === 0) return false
    const result = this.parseExpr(tokens, 0, ctx)
    if (result.next !== tokens.length) throw new Error(`unexpected tokens after expression`)
    return !!result.value
  }

  any(conditions: string[] | undefined, ctx: EvalContext): boolean {
    return (conditions ?? []).some(c => this.evaluate(c, ctx))
  }

  all(conditions: string[] | undefined, ctx: EvalContext): boolean {
    return (conditions ?? []).every(c => this.evaluate(c, ctx))
  }

  private parseExpr(tokens: Token[], pos: number, ctx: EvalContext): { value: unknown; next: number } {
    return this.parseOr(tokens, pos, ctx)
  }

  private parseOr(tokens: Token[], pos: number, ctx: EvalContext): { value: unknown; next: number } {
    let { value, next } = this.parseAnd(tokens, pos, ctx)
    while (tokens[next]?.type === 'op' && tokens[next]!.value === '||') {
      const right = this.parseAnd(tokens, next + 1, ctx)
      value = !!value || !!right.value
      next = right.next
    }
    return { value, next }
  }

  private parseAnd(tokens: Token[], pos: number, ctx: EvalContext): { value: unknown; next: number } {
    let { value, next } = this.parseCompare(tokens, pos, ctx)
    while (tokens[next]?.type === 'op' && tokens[next]!.value === '&&') {
      const right = this.parseCompare(tokens, next + 1, ctx)
      value = !!value && !!right.value
      next = right.next
    }
    return { value, next }
  }

  private parseCompare(tokens: Token[], pos: number, ctx: EvalContext): { value: unknown; next: number } {
    const left = this.parseUnary(tokens, pos, ctx)
    const op = tokens[left.next]
    if (op && op.type === 'op' && ['==', '!=', '>', '<', '>=', '<='].includes(op.value)) {
      const right = this.parseUnary(tokens, left.next + 1, ctx)
      let v: boolean
      switch (op.value) {
        case '==': v = left.value == right.value; break
        case '!=': v = left.value != right.value; break
        case '>':  v = (left.value as number) > (right.value as number); break
        case '<':  v = (left.value as number) < (right.value as number); break
        case '>=': v = (left.value as number) >= (right.value as number); break
        case '<=': v = (left.value as number) <= (right.value as number); break
        default:   v = false
      }
      return { value: v, next: right.next }
    }
    return left
  }

  private parseUnary(tokens: Token[], pos: number, ctx: EvalContext): { value: unknown; next: number } {
    const t = tokens[pos]
    if (t?.type === 'op' && t.value === '!') {
      const inner = this.parseUnary(tokens, pos + 1, ctx)
      return { value: !inner.value, next: inner.next }
    }
    return this.parsePrimary(tokens, pos, ctx)
  }

  private parsePrimary(tokens: Token[], pos: number, ctx: EvalContext): { value: unknown; next: number } {
    const t = tokens[pos]
    if (!t) throw new Error('unexpected end of expression')
    if (t.type === '(') {
      const inner = this.parseExpr(tokens, pos + 1, ctx)
      if (tokens[inner.next]?.type !== ')') throw new Error('missing )')
      return { value: inner.value, next: inner.next + 1 }
    }
    if (t.type === 'number') return { value: parseFloat(t.value), next: pos + 1 }
    if (t.type === 'string') return { value: t.value, next: pos + 1 }
    if (t.type === 'ident') {
      if (tokens[pos + 1]?.type === '(') {
        if (!ALLOWED_FUNCTIONS.has(t.value)) throw new Error(`function not allowed: ${t.value}`)
        const args: unknown[] = []
        let p = pos + 2
        while (tokens[p] && tokens[p]!.type !== ')') {
          const arg = this.parsePrimary(tokens, p, ctx)
          args.push(arg.value)
          p = arg.next
          if (tokens[p]?.type === ',') p++
        }
        if (tokens[p]?.type !== ')') throw new Error('missing ) in function call')
        let value: unknown
        if (t.value === 'time.between') {
          value = timeBetween(args[0] as string, args[1] as string, ctx.now ?? Date.now())
        } else {
          throw new Error(`function not implemented: ${t.value}`)
        }
        return { value, next: p + 1 }
      }
      return { value: getPath(ctx, t.value), next: pos + 1 }
    }
    throw new Error(`unexpected token: ${t.type} ${t.value}`)
  }
}
