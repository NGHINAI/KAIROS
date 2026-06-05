// scripts/probe-composio-tools.ts — diagnose why connected-toolkit tools didn't load.
import { Database } from "bun:sqlite"
import { ComposioClient } from "../src/daemon/connectors/composioClient"
import { ConnectionStore } from "../src/daemon/connectors/connectionStore"

const db = new Database("state/state.db")
const connStore = new ConnectionStore(db)
console.log("listActive('local'):", JSON.stringify(connStore.listActive("local")))

const client = new ComposioClient({ apiKey: process.env.COMPOSIO_API_KEY! })
const sdk = client.sdk
console.log("sdk.tools.search:", typeof sdk?.tools?.search)
console.log("sdk.tools.getRawComposioTools:", typeof sdk?.tools?.getRawComposioTools)
console.log("sdk.tools.get:", typeof sdk?.tools?.get)
console.log("sdk.tools.list:", typeof sdk?.tools?.list)

try {
  const acc = await client.listConnectedAccounts({ userId: "local" })
  console.log("listConnectedAccounts:", JSON.stringify(acc))
} catch (e: any) { console.log("listConnectedAccounts ERR:", e.message) }

// Try several enumeration methods to find which returns Linear tools.
async function tryFetch(name: string, fn: () => Promise<any>) {
  try {
    const r: any = await fn()
    const items = Array.isArray(r) ? r : (r?.items ?? [])
    const linear = items.filter((t: any) => String(t.toolkit?.slug ?? t.toolkit_slug ?? t.toolkit ?? "").toLowerCase() === "linear")
    console.log(`${name}: total=${items.length} linear=${linear.length} sample=`,
      JSON.stringify(items.slice(0, 1).map((t: any) => ({ slug: t.slug ?? t.name, toolkit: t.toolkit?.slug ?? t.toolkit_slug ?? t.toolkit }))))
  } catch (e: any) { console.log(`${name} ERR:`, e.message) }
}

await tryFetch("getRawComposioTools({limit:50})", () => sdk.tools.getRawComposioTools?.({ limit: 50 }))
await tryFetch("getRawComposioTools({toolkits:['linear']})", () => sdk.tools.getRawComposioTools?.({ toolkits: ["linear"], limit: 50 }))
await tryFetch("tools.get({toolkits:['linear']})", () => sdk.tools.get?.({ toolkits: ["linear"], limit: 50 }))
await tryFetch("tools.get('local',{toolkits:['linear']})", () => sdk.tools.get?.("local", { toolkits: ["linear"], limit: 50 }))
process.exit(0)
