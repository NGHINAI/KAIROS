// src/daemon/orders/v2/interp.ts
// Variable interpolation for action args. Resolves ${trigger.X}, ${payload.X},
// ${skill_output.X}, ${persona.X} from a context bundle. Missing keys → empty
// string + warning. NOT a general-purpose expression evaluator.

export type InterpContext = {
  trigger?: Record<string, unknown>
  payload?: Record<string, unknown>
  skill_output?: Record<string, unknown>
  persona?: Record<string, unknown>
}

export type InterpOptions = {
  onWarn?: (msg: string) => void
}

const VAR_REGEX = /\$\{([a-z_]+)\.([^}]+)\}/g

function getPath(obj: unknown, path: string): unknown {
  if (obj == null || typeof obj !== 'object') return undefined
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc == null || typeof acc !== 'object') return undefined
    return (acc as Record<string, unknown>)[key]
  }, obj)
}

export function interpolate(template: string, ctx: InterpContext, opts: InterpOptions = {}): string {
  return template.replace(VAR_REGEX, (_, scope: string, path: string) => {
    const source = (ctx as Record<string, unknown>)[scope]
    if (source === undefined) {
      opts.onWarn?.(`interpolation: unknown scope '${scope}' in '${path}'`)
      return ''
    }
    const value = getPath(source, path)
    if (value === undefined) {
      opts.onWarn?.(`interpolation: missing key '${scope}.${path}'`)
      return ''
    }
    return String(value)
  })
}

export function interpolateObject(obj: unknown, ctx: InterpContext, opts: InterpOptions = {}): unknown {
  if (typeof obj === 'string') return interpolate(obj, ctx, opts)
  if (Array.isArray(obj)) return obj.map(v => interpolateObject(v, ctx, opts))
  if (obj && typeof obj === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) out[k] = interpolateObject(v, ctx, opts)
    return out
  }
  return obj
}
