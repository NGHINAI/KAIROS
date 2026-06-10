// src/daemon/agents/schemaCompact.test.ts
import { test, expect } from "bun:test"
import { compactSchemaLine, compactType } from "./schemaCompact"

test("required params come first and carry a star", () => {
  const line = compactSchemaLine({
    type: "object",
    properties: {
      cc: { type: "array", items: { type: "string" } },
      to: { type: "string", format: "email" },
      subject: { type: "string" },
    },
    required: ["to", "subject"],
  })
  expect(line).toBe("to*:string(email), subject*:string, cc:string[]")
})

test("enums are inlined with a cap", () => {
  expect(compactType({ type: "string", enum: ["high", "medium", "low"] })).toBe("high|medium|low")
  expect(compactType({ enum: [1, 2, 3, 4, 5, 6] })).toBe("1|2|3|4|…")
})

test("nested objects show one level of keys, deeper collapses to 'object'", () => {
  expect(compactType({ type: "object", properties: { start: {}, end: {}, tz: {} } })).toBe("{start,end,tz}")
  expect(compactType({ type: "object", properties: { a: { type: "object", properties: { b: {} } } } })).toBe("{a}")
  expect(compactType({ type: "object", properties: { a: { type: "object", properties: { b: {} } } } }, 1)).toBe("object")
})

test("anyOf/oneOf render as a type union", () => {
  expect(compactType({ anyOf: [{ type: "string" }, { type: "null" }] })).toBe("string|null")
})

test("defaults are shown when short and scalar", () => {
  const line = compactSchemaLine({
    type: "object",
    properties: { limit: { type: "number", default: 10 }, verbose: { type: "boolean", default: false } },
  })
  expect(line).toBe("limit:number=10, verbose:boolean=false")
})

test("optional overflow collapses to '+N more optional' but required are never dropped", () => {
  const props: Record<string, any> = { must: { type: "string" } }
  for (let i = 0; i < 12; i++) props[`opt${i}`] = { type: "string" }
  const line = compactSchemaLine({ type: "object", properties: props, required: ["must"] })
  expect(line.startsWith("must*:string")).toBe(true)
  expect(line).toContain("+4 more optional")
})

test("empty or absent schema reads as no args", () => {
  expect(compactSchemaLine(undefined)).toBe("(no args)")
  expect(compactSchemaLine({ type: "object", properties: {} })).toBe("(no args)")
})

test("a pathologically wide schema stays under the line cap", () => {
  const props: Record<string, any> = {}
  for (let i = 0; i < 40; i++) props[`a_rather_long_required_field_name_${i}`] = { type: "string" }
  const line = compactSchemaLine({ type: "object", properties: props, required: Object.keys(props) })
  expect(line.length).toBeLessThanOrEqual(320)
  expect(line.endsWith("…")).toBe(true)
})
