// src/daemon/agents/schemaCompact.ts
// Render a JSON Schema (a tool's input parameters) as ONE compact signature line the
// model can read at a glance: required-first, `*` marks required, types abbreviated,
// enums inlined. This is what makes first tool calls land: a raw JSON Schema blob is
// either huge (blows the observation budget) or gets stripped as a non-scalar by the
// result shaper — a signature string survives both and reads better for a small model.
//
//   { properties: { to: {type:"string",format:"email"}, cc: {type:"array",items:{type:"string"}} },
//     required: ["to"] }
//   → "to*:string(email), cc:string[]"

const MAX_LINE = 320          // hard cap per tool's signature line
const MAX_OPTIONAL = 8        // optional params shown before "+N more optional"
const MAX_ENUM = 4            // enum values inlined before "|…"

function isScalarValue(v: any): boolean {
  return v == null || typeof v === "string" || typeof v === "number" || typeof v === "boolean"
}

/** Abbreviated type for one property schema: "string(email)", "string[]", "a|b|c", "{k1,k2}". */
export function compactType(p: any, depth = 0): string {
  if (!p || typeof p !== "object") return "any"
  if (Array.isArray(p.enum) && p.enum.length > 0) {
    const vals = p.enum.slice(0, MAX_ENUM).map((v: any) => String(v))
    return vals.join("|") + (p.enum.length > MAX_ENUM ? "|…" : "")
  }
  const alts = Array.isArray(p.anyOf) ? p.anyOf : Array.isArray(p.oneOf) ? p.oneOf : null
  if (alts) {
    const list = [...new Set(alts.map((x: any) => compactType(x, depth + 1)))]
    return list.slice(0, 3).join("|") || "any"
  }
  const t = p.type
  if (Array.isArray(t)) return t.join("|")
  if (t === "array") {
    const it = compactType(p.items, depth + 1)
    return `${it === "any" ? "" : it}[]`
  }
  if (t === "object") {
    const keys = p.properties && typeof p.properties === "object" ? Object.keys(p.properties) : []
    if (keys.length === 0 || depth >= 1) return "object"      // one level of nesting only
    return `{${keys.slice(0, 4).join(",")}${keys.length > 4 ? ",…" : ""}}`
  }
  if (typeof t === "string") {
    const fmt = typeof p.format === "string" && p.format ? `(${p.format})` : ""
    return t + fmt
  }
  return "any"
}

/** One-line signature for a whole input schema. Required params always all shown (they
 *  ARE the call); optionals capped. Returns "(no args)" for an empty/absent schema. */
export function compactSchemaLine(schema: any): string {
  const props = schema?.properties
  if (!props || typeof props !== "object" || Object.keys(props).length === 0) return "(no args)"
  const required = new Set<string>(Array.isArray(schema.required) ? schema.required : [])
  const keys = Object.keys(props)
  const ordered = [...keys.filter((k) => required.has(k)), ...keys.filter((k) => !required.has(k))]

  const parts: string[] = []
  let optionalShown = 0
  let skipped = 0
  for (const k of ordered) {
    const isReq = required.has(k)
    if (!isReq && optionalShown >= MAX_OPTIONAL) { skipped++; continue }
    const p = props[k]
    let piece = `${k}${isReq ? "*" : ""}:${compactType(p)}`
    if (p && p.default !== undefined && isScalarValue(p.default) && String(p.default).length <= 12) {
      piece += `=${p.default}`
    }
    parts.push(piece)
    if (!isReq) optionalShown++
  }
  let line = parts.join(", ")
  if (skipped > 0) line += `, +${skipped} more optional`
  if (line.length > MAX_LINE) line = line.slice(0, MAX_LINE - 1) + "…"
  return line
}
